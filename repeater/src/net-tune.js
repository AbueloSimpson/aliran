// Swarm UDP socket tuning.
//
// VERBATIM COPY of core/net-tune.js — keep the two in sync. The repeater deliberately
// depends on NOTHING from @aliran/core (no crypto, no hyperdrive, no sodium): the whole
// security story is that this box provably cannot decrypt what it serves, and pulling in
// the crypto package to reach one networking helper would dilute that. A ~150-line copy is
// the cheaper trade.
//
// This matters MORE here than anywhere else in the system: a repeater exists purely to
// absorb fan-out, so it is the box most likely to hit a socket-buffer wall.
//
// WHY THIS EXISTS
//
// Hyperswarm's transport is UDX, and UDX multiplexes EVERY peer stream for a swarm over a
// single pair of UDP sockets (`dht.io.serverSocket` / `clientSocket`). A broadcaster feed
// swarm or a repeater therefore concentrates a whole channel's fan-out onto one socket, so
// what gives out first under load is the kernel socket buffer, not the connection count.
//
// When a UDP socket buffer fills, the kernel drops the datagram before userspace ever sees
// it. udx's congestion control only observes a gap, so the symptom is stalling and
// throughput collapse with nothing logged anywhere — the "it degrades once a lot of viewers
// join" class of bug. `netstat -su` is where it shows up, as RcvbufErrors/SndbufErrors.
//
// Two things make this worth doing in code rather than leaving to defaults:
//
//   1. udx sets the RECEIVE buffer to 1 MiB itself but leaves the SEND buffer at the OS
//      default (212992 on Linux — measured). Sending is precisely what a broadcaster or a
//      repeater does under fan-out, so the untuned direction is the one that matters to us.
//
//   2. setsockopt(SO_RCVBUF/SO_SNDBUF) is SILENTLY CLAMPED to net.core.{r,w}mem_max. It
//      does not fail — the call returns cleanly and the socket simply stays small. A host
//      still on the 212992 default clamps a 2 MiB request down to 208 KiB and reports
//      nothing at all. Worse, Linux stores DOUBLE what you ask for, so reading the value
//      back cannot distinguish "granted" from "capped, then doubled" for any request
//      between the ceiling and twice the ceiling. That is why the ceiling is read from
//      /proc and treated as the authority: it is the only way to tell an operator the truth
//      about what they actually got.
//
// Tuning is BEST EFFORT throughout. A platform that refuses a setsockopt, or a container
// without /proc, must never take the service down — we report and carry on.

import fs from 'fs'

// 2 MiB in each direction. Modest on purpose: this is a per-socket ceiling the kernel
// allocates against on demand, not a reservation, but it is still charged to kernel memory
// on a busy box (one socket pair per swarm, and the broadcaster runs one swarm per
// channel). Operators raise it with SWARM_RCVBUF_MB / SWARM_SNDBUF_MB.
export const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024

const CEILING_PATHS = { recv: '/proc/sys/net/core/rmem_max', send: '/proc/sys/net/core/wmem_max' }
export const SYSCTL_KEYS = { recv: 'net.core.rmem_max', send: 'net.core.wmem_max' }

// Read the kernel's per-socket buffer ceilings. Linux only; anything else (Windows, macOS,
// a container without /proc) yields null, which pushes evaluateBuffer onto its readback
// fallback. Never throws.
export function readKernelCeilings (readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const out = { recv: null, send: null }
  for (const dir of ['recv', 'send']) {
    try {
      const n = parseInt(String(readFile(CEILING_PATHS[dir])).trim(), 10)
      if (Number.isFinite(n) && n > 0) out[dir] = n
    } catch {
      // not Linux, or /proc not mounted — leave null
    }
  }
  return out
}

// Pure: decide whether a request was actually honoured.
//
// With a known ceiling that is the whole answer (requested <= ceiling). Without one we fall
// back to comparing the readback, which catches a hard clamp (achieved < requested) but not
// the doubling window described above — correct on Windows/macOS, where there is no
// doubling and no low ceiling to trip over.
export function evaluateBuffer ({ requested, achieved, ceiling }) {
  if (!(requested > 0)) return { requested: 0, achieved, ceiling: ceiling ?? null, ok: true, clamped: false, skipped: true }
  if (ceiling !== null && ceiling !== undefined) {
    const ok = requested <= ceiling
    return { requested, achieved, ceiling, ok, clamped: !ok, skipped: false }
  }
  const ok = achieved >= requested
  return { requested, achieved, ceiling: null, ok, clamped: !ok, skipped: false }
}

// Apply both directions to one udx socket. 0 (or less) skips that direction.
export function tuneSocket (socket, { recvBytes = 0, sendBytes = 0, ceilings = {} } = {}) {
  const out = { recv: null, send: null, error: null }
  try {
    if (recvBytes > 0) {
      socket.setRecvBufferSize(recvBytes)
      out.recv = evaluateBuffer({ requested: recvBytes, achieved: socket.getRecvBufferSize(), ceiling: ceilings.recv ?? null })
    }
    if (sendBytes > 0) {
      socket.setSendBufferSize(sendBytes)
      out.send = evaluateBuffer({ requested: sendBytes, achieved: socket.getSendBufferSize(), ceiling: ceilings.send ?? null })
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  }
  return out
}

// Tune both of a swarm's UDP sockets. Awaits dht.ready() because the sockets are bound
// lazily — calling this before the bind would find nothing to tune.
export async function tuneSwarm (swarm, { recvBytes = DEFAULT_BUFFER_BYTES, sendBytes = DEFAULT_BUFFER_BYTES, ceilings } = {}) {
  const report = { sockets: [], clamped: false, error: null, ceilings: null, recvBytes, sendBytes }
  if (!(recvBytes > 0) && !(sendBytes > 0)) return report // operator opted out of both
  try {
    report.ceilings = ceilings ?? readKernelCeilings()
    await swarm.dht.ready()
    const io = swarm.dht.io
    for (const name of ['serverSocket', 'clientSocket']) {
      const socket = io && io[name]
      if (!socket) continue
      const r = tuneSocket(socket, { recvBytes, sendBytes, ceilings: report.ceilings })
      report.sockets.push({ name, ...r })
      if ((r.recv && r.recv.clamped) || (r.send && r.send.clamped)) report.clamped = true
    }
  } catch (err) {
    report.error = err && err.message ? err.message : String(err)
  }
  return report
}

const mib = (n) => `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)} MiB`

// Operator-facing lines for a report: the clamp warnings, or one healthy summary. Kept
// separate from logging so callers choose the sink and tests can assert on the text.
export function tuningMessages (report) {
  const out = []
  if (report.error) out.push(`swarm socket tuning failed: ${report.error} (continuing with kernel defaults)`)
  for (const s of report.sockets) {
    if (s.error) out.push(`swarm socket tuning failed on ${s.name}: ${s.error} (continuing with kernel defaults)`)
    for (const dir of ['recv', 'send']) {
      const r = s[dir]
      if (!r || !r.clamped) continue
      const got = r.ceiling !== null ? mib(r.ceiling) : mib(r.achieved)
      out.push(
        `WARNING: swarm ${dir} buffer clamped to ${got} — asked for ${mib(r.requested)}. ` +
        `Under fan-out an undersized socket buffer drops packets inside the kernel, which ` +
        `looks like stalls and throughput collapse rather than an error (watch netstat -su). ` +
        `Fix: sysctl -w ${SYSCTL_KEYS[dir]}=${r.requested} — persist it in ` +
        `/etc/sysctl.d/99-aliran.conf (see deploy/sysctl/99-aliran.conf).`
      )
    }
  }
  if (!out.length && report.sockets.length) {
    const c = report.ceilings || {}
    const ceil = c.recv || c.send ? ` (kernel ceilings rmem_max ${c.recv ? mib(c.recv) : '?'} / wmem_max ${c.send ? mib(c.send) : '?'})` : ''
    out.push(`swarm sockets tuned: recv ${mib(report.recvBytes)}, send ${mib(report.sendBytes)}${ceil}`)
  }
  return out
}

// Process-wide dedupe: the broadcaster tunes one swarm PER CHANNEL, and the clamp warning
// is a property of the host, not of the channel — printing it 43 times would bury it.
const _logged = new Set()

export function logSwarmTuning (report, log) {
  if (typeof log !== 'function') return
  for (const msg of tuningMessages(report)) {
    if (_logged.has(msg)) continue
    _logged.add(msg)
    log(msg)
  }
}

// Tests only — the dedupe set is module state.
export function _resetTuningLog () { _logged.clear() }
