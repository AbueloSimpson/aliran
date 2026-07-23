# Network tuning (kernel socket buffers)

Why a peer-to-peer stream can stall under load with **nothing in the logs**, and the one
host setting that fixes it. Read this before putting real viewer load on a broadcaster or
a repeater.

> **TL;DR** — Optional, but run it before a box takes real viewer load. One command, one
> time per host (see the [operator guide](../operator-guide.md#host-network-tuning-optional)):
> ```
> sudo deploy/sysctl/install.sh     # idempotent; re-run after a host rebuild
> ```
> Stock Linux caps socket buffers at 212992 bytes. Aliran asks for 2 MiB at startup, the
> kernel silently grants 208 KiB instead, and under fan-out the overflow shows up as
> stalling playback rather than an error. The services log a warning naming the exact
> sysctl — but by then you are already dropping packets.

Both sides of this — the clamp warning on an untuned host and the clean `swarm sockets
tuned` line after the fix — were captured live on a real box in the
[repeater production example](repeater-production-example.md).

## Why this is different from a normal streaming server

An HTTP HLS origin gives every viewer their own TCP connection, and the kernel sizes each
one independently. Aliran's transport is **UDX over UDP**, and UDX multiplexes *every* peer
stream of a swarm over **one socket pair** (`dht.io.serverSocket` / `clientSocket`).

That single pair carries a whole channel's fan-out. So the thing that runs out first is not
connection slots or file descriptors — it is the **socket buffer**, and viewer count
concentrates pressure onto it rather than spreading it out.

When a UDP socket buffer fills, the kernel **discards the datagram before userspace sees
it**. udx's congestion control only observes a gap, assumes congestion, and backs off. There
is no error, no exception, no log line — just throughput that collapses as viewers join.

## Symptom → cause → fix

**Symptom.** Playback is fine with a few viewers and degrades as more join: rebuffering,
long time-to-play, peers that connect but barely transfer. Nothing in the broadcaster or
repeater logs. CPU and RAM look fine.

**Confirm it.** Kernel counters are the ground truth:

```bash
netstat -su | grep -iE 'receive|send'     # RcvbufErrors / SndbufErrors
# or, with rates:
nstat -az | grep -iE 'UdpRcvbufErrors|UdpSndbufErrors'
```

Any non-trivial and *growing* `RcvbufErrors` / `SndbufErrors` is this problem. (A small
static count from long ago is normal.) Also check what your sockets actually got:

```bash
ss -uanm | grep -A1 '0.0.0.0:' | head    # skmem rb=<recv bytes> tb=<send bytes>
```

**Cause.** `net.core.rmem_max` / `net.core.wmem_max` cap what any process may request, and
`setsockopt()` **is clamped silently** — the call succeeds and the socket just stays small.

**Fix.** Install the drop-in above, then restart the service so it re-requests its buffers.

## What Aliran does for you

Every component sizes its swarm sockets at startup (`core/net-tune.js`; the viewer
engine bundles its runtime-agnostic half, `core/net-tune-core.js`):

| Component | Default request | Override |
|---|---|---|
| Broadcaster (one swarm **per channel**) | 2 MiB recv / 2 MiB send | `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` |
| Panel (one swarm, serves the catalog to every client) | 2 MiB / 2 MiB | same |
| Repeater (one swarm, all mirrored channels) | **4 MiB / 4 MiB** | same |
| Viewer engine (SDK / the app — one swarm, panel + every feed) | 2 MiB recv / send **untouched** | SDK option `swarm: { rcvbufMb, sndbufMb }` |

Set either to `0` to leave that direction at the OS default.

**The viewer path** is deliberately asymmetric: a viewer is download-dominant, so the
whole stream funnels into the **receive** side of its one socket pair — and on a phone
the engine shares a single JS thread with decryption, so the kernel buffer is what
absorbs bursts while userspace is busy. Upload (re-seeding) is opportunistic and
saturates a typical uplink long before a bigger send buffer would matter, so send is
left alone. On Android `/proc/sys/net/core` is not readable from an app: the request
itself still applies (`setsockopt` needs no privileges), only clamp *detection*
degrades to a readback comparison. The engine reports the outcome as a
`status`/`net:tuned` event and the app's worklet logs the same `[net] swarm sockets
tuned: …` line the servers print, so `adb logcat` can prove it ran on-device.

Two details worth knowing:

- **udx already raises the receive buffer to 1 MiB, but leaves the send buffer at the OS
  default (~208 KiB).** Sending is exactly what a broadcaster or repeater does under
  fan-out, so the untuned direction was the one that mattered most. Aliran sets both.
- **Reading the value back cannot prove you got what you asked for.** Linux caps the
  request at the ceiling and *then stores double* the capped value, so any request between
  the ceiling and twice the ceiling reads back larger than requested even though it was
  capped. Aliran therefore reads `/proc/sys/net/core/{r,w}mem_max` and treats it as the
  authority — that is the only way to report the truth.

When the ceiling is too low you get a startup warning naming the fix:

```
[net] WARNING: swarm send buffer clamped to 208 KiB — asked for 2 MiB. Under fan-out an
undersized socket buffer drops packets inside the kernel, which looks like stalls and
throughput collapse rather than an error (watch netstat -su). Fix: sysctl -w
net.core.wmem_max=2097152 — persist it in /etc/sysctl.d/99-aliran.conf
```

It is printed **once per process**, not once per channel — a clamp is a property of the
host, so 43 channels do not produce 43 warnings.

## Why this is a host file, not a container setting

The panel and broadcaster run with `network_mode: host`, and Docker **rejects `sysctls:`
for `net.*` under host networking** — the container shares the host's network namespace, so
there is nothing separate to set. These knobs belong to the host however you install
Aliran, including bare-metal and systemd deployments.

## Connection tracking (Docker / ufw / any NAT)

If iptables or nftables is in play — which Docker means by default, even with host
networking — every peer flow occupies a **conntrack** entry, and UDP entries linger for
`nf_conntrack_udp_timeout` (30 s) after the last packet. Viewer fan-out multiplies flows
quickly, and a full table makes the kernel **drop new flows**:

```
nf_conntrack: table full, dropping packet
```

That reads like random connection failures rather than a capacity limit. Check headroom:

```bash
cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max
```

Above ~50% under load, raise `nf_conntrack_max` — the commented block in
`deploy/sysctl/99-aliran.conf` has values to start from.

## File descriptors

Rarely a problem on Docker (which sets a high `LimitNOFILE`), but worth knowing for
bare-metal systemd installs where the default is 1024. Measured at 43 disk-buffer channels:
**~12.6 fds per channel** (~540 total, of which ~130 are sockets), so the ceiling matters
around a hundred channels. Viewers do **not** add fds — UDX multiplexes them onto the
existing socket pair.

## Related

- [Scaling & capacity planning](scaling.md) — channels per box, the IOPS story
- [Viewer bandwidth & battery](viewer-bandwidth.md) — what a viewer actually costs
- [P2P feed buffer & tuning](feed-buffer.md) — feed rotation, disk vs warm-topic
