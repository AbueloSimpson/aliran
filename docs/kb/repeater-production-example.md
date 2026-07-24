# Repeater in production: a worked example

A real [repeater](../repeater.md) deployment, end to end, with every number measured —
the box, the contained install next to unrelated services, the socket-buffer clamp
captured live (before *and* after the fix), the proof that a real viewer pulled its
stream off the repeater with zero client changes, and the bounded-footprint numbers.
Use it as the reference shape for your own edge box, and as ground truth for what the
logs should look like at each step.

Everything below was captured in July 2026 against a production panel carrying an
80+ channel lineup, with the repeater mirroring **three** of those channels. Channel
ids are anonymized (`sports-a`, `national-a`, `national-b`) and key prefixes redacted;
the log lines are otherwise verbatim.

## The box (and why "contained" is easy)

A rented VM that was **already running unrelated production services** — Apache on
:80, MySQL, memcached — chosen deliberately to show co-tenancy:

- 16 vCPU / 31 GB RAM, ordinary datacenter uplink, US-East.
- Ubuntu 18.04 on kernel 4.15 — a 3+-year-uptime legacy host. Old userland glibc
  can't run modern Node bare-metal, which makes the Docker path not just tidy but
  necessary on hosts like this.
- The repeater container adds **no listening sockets at all**: P2P is outbound UDP
  with hole-punching, and the stock appliance runs no HTTP server (the opt-in
  `STATUS_PORT` health/metrics endpoint did not exist yet at the time of this
  capture — and it defaults to off precisely to preserve this property).
  `network_mode: host` avoids double-NAT but cannot port-clash with anything —
  the co-tenant services were untouched throughout.
- The only host-level change the deploy makes is the optional (here: required — see
  below) sysctl drop-in, and that only raises two per-socket buffer *ceilings*.
  Ceilings are not allocations; co-tenant services are unaffected.

Install was the stock four lines from the [repeater page](../repeater.md#running-one):
Docker CE + compose plugin, `git clone … /opt/aliran`, `repeater/.env` with the
panel's public key and `CHANNELS=sports-a,national-a,national-b`, then
`docker compose -f deploy/docker-compose.repeater.yml up -d --build`. Total time from
bare box to mirroring: about ten minutes, most of it the image build.

## The clamp, captured live (why the sysctl is part of the production recipe)

The container was started **before** the host tuning on purpose, to capture what an
untuned box actually does. Stock `net.core.rmem_max`/`wmem_max` were the shipped
`212992`, and startup logged exactly what
[network tuning](network-tuning.md) predicts:

```
[net] WARNING: swarm recv buffer clamped to 0.2 MiB — asked for 4 MiB. Under fan-out an
undersized socket buffer drops packets inside the kernel, which looks like stalls and
throughput collapse rather than an error (watch netstat -su). Fix: sysctl -w
net.core.rmem_max=4194304 — persist it in /etc/sysctl.d/99-aliran.conf (see
deploy/sysctl/99-aliran.conf).
[net] WARNING: swarm send buffer clamped to 0.2 MiB — asked for 4 MiB. …
```

Note what happened next: **the box mirrored perfectly anyway.** Catalog replicated,
tails armed, blocks flowed. That is the trap — the clamp costs nothing at idle and
only starts dropping packets (silently, in the kernel) once real fan-out arrives.
An untuned repeater is a repeater that fails only on the day it matters.

The fix, as documented — run the helper, restart so the sockets are re-requested:

```sh
sudo sh deploy/sysctl/install.sh
docker compose -f deploy/docker-compose.repeater.yml restart
```

```
ok: net.core.rmem_max = 8388608
ok: net.core.wmem_max = 8388608
[net] swarm sockets tuned: recv 4 MiB, send 4 MiB (kernel ceilings rmem_max 8 MiB / wmem_max 8 MiB)
```

The kernel's cumulative UDP receive-error counter (`netstat -su`) was recorded before
the test and **did not increment once** through everything below — zero silent drops.
The drop-in persists in `/etc/sysctl.d/`, so a reboot keeps it.

## What healthy mirroring looks like

Startup to armed, about fifteen seconds against a live panel over the public DHT:

```
[repeater] joined panel topic; waiting for the public catalog to replicate…
[repeater] panel catalog replicated (length 19059)
[repeater] [sports-a] mirror started (feed ……)
[repeater] [national-a] mirror started (feed ……)
[repeater] [national-b] mirror started (feed ……)
[repeater] [national-b] blobs tail armed at block 1328038 (key ……)
[repeater] [national-b] db tail armed at block 399511 (key ……)
…
```

Two details worth recognizing in your own logs:

- **Tails arm at the live edge** (block 1328038, not block 0) — a mirror never
  downloads history, it follows appends. A restart re-arms at the then-current edge
  in seconds and costs one warm-up window, exactly as the
  [operational notes](../repeater.md#operational-notes) say.
- The periodic status line is the health read. Per channel, `held` is the window it
  can serve, `@N` is the feed length it is tracking, `peers` counts who is connected
  for that core:

```
[repeater] [sports-a]    db: held 118 @321950 peers 1 | blobs: held 80 @1736534 peers 1
[repeater] [national-a]  db: held 475 @403094 peers 1 | blobs: held 1513 @1290346 peers 1
[repeater] [national-b]  db: held 474 @400123 peers 2 | blobs: held 1568 @1330076 peers 2
[repeater] swarm: 5 connection(s), 3 channel(s) mirrored
```

`peers 1` is the origin. The `peers 2` on `national-b` is the interesting part —
that is a viewer, which brings us to:

## The proof: a real viewer pulls half its stream off the repeater

A completely stock SDK viewer (real login, real grant, playing `national-b`, a
~1.8 Mbit/s feed) ran for three minutes from a machine on another continent. It was
given **no repeater configuration of any kind** — it discovered whatever the DHT
offered on the channel topic, which was two holders: the origin broadcaster and this
repeater. Its per-connection byte counters at the end:

| remote            | received      | share |
|-------------------|---------------|-------|
| origin host       | 45,853,728 B  | 54 %  |
| **the repeater**  | **38,797,949 B** | **46 %** |

Hypercore's request hotswapping simply treated the repeater as another fast holder
and split the load roughly in half — from a viewer that does not know repeaters
exist. On the repeater side, `national-b` showed `peers 2` for exactly the duration
of the session and fell back to `peers 1` on disconnect; the two channels nobody was
watching stayed at `peers 1` throughout.

Two things this measurement is *not*:

- It is not "the viewer preferred the nearby box" — viewer, origin and repeater were
  all on different networks here, so hotswap split by measured throughput. On-net
  (the ISP-hosted model) the RTT gap makes the split lopsided in the repeater's
  favor; the mechanism is the same.
- It is not the slots-full scenario (origin capped with `SWARM_MAX_PEERS` so viewers
  *must* use repeaters). That, plus origin-death playback and rotation-purge, are
  proven by the e2e suite (`npm run test:repeater`) on a local testnet — deliberately
  not staged against a production origin.

## Bounded footprint, measured

With `RETENTION_SECONDS=300` (the default), after the warm-up:

- **Storage plateaued flat at ~161 MB total** for the three channels and stayed
  there — `bitrate × retention` summed across the lineup, exactly the
  [sizing formula](../repeater.md#sizing-pure-io-no-ffmpeg-no-transcoding-no-crypto).
  Held-block counts went flat while feed lengths kept climbing (`held 1513 → 1512`
  across sweeps as `@N` grew by hundreds) — the retention sweep clearing at the same
  rate the origin appends.
- **CPU: load average 0.13 on 16 cores** while mirroring three channels and serving
  a viewer. The "budget it like a file server" guidance is, if anything, generous.
- **RAM: tens of MB.** The container's working set was dominated by hypercore
  session state, not media.
- The store is a **disposable ciphertext cache**: `down -v` deletes it, a restart
  rebuilds the window in one warm-up. Nothing on the box can decrypt it — the
  keyless property is the [whole point](../repeater.md#the-security-story-why-an-isp-can-host-this).

## Teardown

The entire deployment reverts with:

```sh
docker compose -f deploy/docker-compose.repeater.yml down -v   # container + store
rm -rf /opt/aliran                                             # the clone
rm /etc/sysctl.d/99-aliran.conf && sysctl --system             # only if you must
```

(Leaving the sysctl in place is harmless and saves the next deploy a restart.)

## Checklist distilled from this run

1. `deploy/sysctl/install.sh` **before** real load — an untuned repeater works in
   testing and drops packets under fan-out. Verify with the startup line: you want
   `swarm sockets tuned`, not `WARNING: … clamped`.
2. Watch `held`/`@N`/`peers` in the status log — armed tails at the live edge plus a
   flat `held` under a climbing `@N` is the healthy signature.
3. Expect ~one HLS window of warm-up after any start, restart or re-target.
4. Confirm serving with peers counts (or kernel-level byte accounting if you need
   hard numbers) — a viewer session shows up as `peers 2` on exactly the channel
   being watched.
5. Keep an eye on disk only in the sense of "is the plateau where the formula says";
   growth past the plateau would be a bug report, not a tuning problem.
