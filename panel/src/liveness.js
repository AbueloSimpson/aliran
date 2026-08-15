// Redirect-channel liveness probe (S23 follow-up): redirect channels have no
// broadcaster heartbeat — sources.js stamps them isLive:true at creation and nothing
// ever revisits that, so a provider url that died stayed "live" in every viewer's
// list forever (the client dims isLive:false rows already; the PRODUCER of that
// signal for redirects is this module). The probe GETs each redirect url on a sweep
// interval and flips ONLY the record's isLive field:
//
//   - dead needs 3 consecutive failed SWEEPS (~30 min at the default) — one blip
//     must not dim a channel; alive needs ONE success — a live event channel must
//     undim on the sweep after its event starts. Event playlists are the primary
//     population here: between events they legitimately 404, so dimming them while
//     idle is correct, and the flip-back cadence is why the interval defaults to
//     10 min rather than something slower.
//   - the probe sends the record's own playback `headers` (Referer/Origin/UA) so a
//     hotlink-checked provider answers the probe the way it answers a viewer; when
//     the record names no User-Agent it sends a player-shaped one — never the Node
//     default, which providers filter as a bot.
//   - SELF-OUTAGE GUARD: when more than half of a sweep's probes fail at the
//     network layer (fetch threw / timed out — never an HTTP status), the whole
//     sweep is discarded, counters untouched. The panel's own connectivity must
//     never dim the lineup.
//   - fail counters are keyed by STREAM ID and live in memory only: the bee holds
//     the flag itself, so a panel restart costs at most one extra dead-window.
//     Deliberately not keyed by url: event sources re-stamp tokenized urls on
//     every sync, and a counter that reset with each token rotation could never
//     reach failsToFlip. An alive new url clears the counter on its first sweep.
//   - DUAL records (feedKey + redirect url) are never touched: the broadcaster
//     heartbeat rebuilds isLive every 5 min and would ping-pong puts against the
//     prober forever on the append-only bee.
//
// Writes follow the house rules: re-read the record immediately before the put,
// change NOTHING but isLive (`status` is broadcaster/ops vocabulary and stays
// untouched), put only on an actual flip (bee frugality, S29 — the bee is
// append-only and every needless put costs a block forever), and record an
// activity entry per flip (a flip is noteworthy; a quiet sweep is not).

const CATALOG_GT = 'catalog/'
const CATALOG_LT = 'catalog0'

// What a viewer's player would accept for a live url — playlists first (HLS under
// its three interchangeable types), DASH close behind, wildcard last (the body is
// what we judge, not the header; same stance as sources.js M3U_ACCEPT).
const PROBE_ACCEPT = 'application/vnd.apple.mpegurl, audio/mpegurl, application/x-mpegurl, application/dash+xml;q=0.9, text/plain;q=0.9, */*;q=0.8'

// The fallback User-Agent when the record's headers name none: shaped like the
// Android player stack the viewers actually run. Providers commonly filter the
// Node/undici default UA as a bot, which would fail every probe on a channel any
// real viewer can play.
export const PLAYER_UA = 'AliranClient/1.0 (Linux;Android 11) ExoPlayerLib/2.19.1'

// A direct-file redirect (rare but real — see desktop's isHlsUrl note) answers 2xx
// with media bytes, not a playlist; recognize it by extension or content-type
// instead of false-flagging it dead.
const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|ts|mp3|aac|m4a|mov)$/i

/**
 * One probe: is `url` serving something a viewer's player could open?
 * Returns { alive:true } | { alive:false, reason } | { alive:false, net:true, reason }.
 * `net:true` marks a network-layer failure (fetch threw / timed out) — those count
 * toward the sweep's self-outage guard; an HTTP answer of any status never does.
 */
export async function probeUrl (url, headers, { timeoutMs, maxBytes = 262144, fetchImpl = fetch } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    // Record headers ride on top of the defaults so a provider's own UA/Referer
    // wins; keys are normalized lowercase to make the override reliable.
    const h = { accept: PROBE_ACCEPT, 'user-agent': PLAYER_UA }
    for (const [k, v] of Object.entries(headers || {})) if (typeof v === 'string') h[k.toLowerCase()] = v
    let res
    try {
      res = await fetchImpl(url, { headers: h, signal: ac.signal, redirect: 'follow' })
    } catch (err) {
      return { alive: false, net: true, reason: ac.signal.aborted ? `timeout after ${timeoutMs}ms` : (err.cause?.message || err.message || 'fetch failed') }
    }
    if (!res.ok) {
      // Consume/cancel the body even on the failure path — dead urls are the
      // STEADY-STATE here (idle event channels 404 every sweep forever), and an
      // unconsumed undici body pins its socket until GC: hundreds of leaked
      // connections per sweep, re-handshaking the same hosts 10 minutes later.
      try { await res.body?.cancel() } catch {}
      return { alive: false, reason: `HTTP ${res.status}` }
    }
    const type = String(res.headers.get('content-type') || '').toLowerCase()
    const path = url.split(/[?#]/)[0]
    // Direct media file: 2xx is the whole answer. The mpegurl subtypes are excluded
    // even though they match audio/* — those are PLAYLIST types (they're in
    // PROBE_ACCEPT), and a dead provider stamping 200 + audio/x-mpegurl on a garbage
    // body must still be judged by the body, or it never dims.
    if ((/^(video|audio)\//.test(type) && !type.includes('mpegurl')) || MEDIA_EXT.test(path.slice(path.lastIndexOf('/') + 1))) {
      try { await res.body?.cancel() } catch {}
      return { alive: true }
    }
    if (!res.body) return { alive: false, reason: `empty ${res.status} answer` } // 204-class: nothing to play
    // Streamed with a byte cap (the fetchFeed pattern): a lying content-length must
    // not balloon panel memory. EVERYTHING in here is caught: a host that answers
    // headers then stalls or resets the body rejects reader.read() (AbortError via
    // our own timer, or a connection reset) — and an uncaught rejection here used to
    // be able to kill the whole sweep's Promise.all, every sweep, off one bad host.
    let buf = Buffer.alloc(0)
    try {
      const reader = res.body.getReader()
      while (buf.byteLength < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        buf = Buffer.concat([buf, Buffer.from(value)])
        // The markers sit in the first bytes by spec — stop reading the moment the
        // answer is decidable instead of draining the full cap from a live stream.
        if (buf.byteLength >= 512 && decide(buf) != null) break
      }
      try { await reader.cancel() } catch {}
    } catch (err) {
      return { alive: false, net: true, reason: ac.signal.aborted ? `body timeout after ${timeoutMs}ms` : ('body read failed: ' + (err.message || err)) }
    }
    return decide(buf) ?? { alive: false, reason: 'no playlist in a 200 answer' }
  } finally {
    clearTimeout(timer)
  }
}

// Classify a (possibly partial) 2xx body: playlist/manifest markers say alive, a raw
// MPEG-TS stream (0x47 sync byte every 188 — an extension-less TS redirect behind a
// generic content-type) says alive, an HTML page says dead. null = not decidable yet
// (keep reading) / nothing recognized (the caller's fallback says dead).
function decide (buf) {
  const body = buf.toString('utf8')
  if (body.includes('#EXTM3U') || /<MPD[\s>]/.test(body)) return { alive: true }
  if (buf.byteLength >= 377 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) return { alive: true }
  const head = body.trimStart().slice(0, 64).toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return { alive: false, reason: 'HTML page, not a stream' }
  return null
}

/**
 * The sweeping prober. ctx = { config, db, activity } (the panel's own singletons).
 * opts override config for tests: { intervalMs, bootDelayMs, timeoutMs, failsToFlip,
 * concurrency, fetchImpl, log }.
 */
export function makeLivenessProber (ctx, opts = {}) {
  const c = (ctx.config && ctx.config.liveness) || {}
  const intervalMs = opts.intervalMs ?? (c.intervalMinutes ?? 10) * 60000
  const bootDelayMs = opts.bootDelayMs ?? c.bootDelayMs ?? 90000
  const timeoutMs = opts.timeoutMs ?? c.timeoutMs ?? 8000
  const failsToFlip = opts.failsToFlip ?? c.failsToFlip ?? 3
  const concurrency = opts.concurrency ?? 4
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((...a) => console.log(...a))

  // streamId|url -> consecutive failed sweeps. In-memory on purpose (see header).
  const fails = new Map()
  let closed = false
  let running = false

  if (intervalMs <= 0) {
    // Disabled (LIVENESS_INTERVAL_MINUTES=0): a stub with the same surface.
    return { probeNow: async () => ({ probed: 0, disabled: true }), close () {} }
  }

  async function sweep () {
    if (closed || running) return { probed: 0 }
    running = true
    try {
      // Snapshot the targets first; probe from the snapshot so the read stream is
      // not held open across minutes of network waits.
      const targets = []
      for await (const { key, value } of ctx.db.createReadStream({ gt: CATALOG_GT, lt: CATALOG_LT })) {
        if (!value || !value.redirect || !value.url || value.type === 'vod') continue
        // DUAL records (feedKey + redirect url — a broadcaster registered onto a
        // redirect id) are excluded: the broadcaster's 5-min heartbeat rebuilds
        // isLive unconditionally, so a prober flip would just ping-pong puts against
        // it on an append-only bee forever. The heartbeat owns isLive there; the
        // clash record itself is the admin's to resolve (rpc.js's own note).
        if (value.feedKey) continue
        targets.push({ id: key.slice(CATALOG_GT.length), url: value.url, headers: value.headers || null, wasLive: value.isLive !== false })
      }
      if (targets.length === 0) return { probed: 0 }

      // Small worker pool — a few hundred urls at 4-wide with an 8 s timeout ends
      // well inside the 10 min interval even if every host hangs. The belt-catch
      // means ONE probe can never reject the pool: probeUrl classifies everything
      // it can foresee, and anything it couldn't counts as a network-layer failure
      // (feeding the self-outage guard) instead of aborting the sweep.
      const results = new Array(targets.length)
      let next = 0
      const worker = async () => {
        while (!closed) {
          const i = next++
          if (i >= targets.length) return
          try {
            results[i] = await probeUrl(targets[i].url, targets[i].headers, { timeoutMs, fetchImpl })
          } catch (err) {
            results[i] = { alive: false, net: true, reason: 'probe threw: ' + (err && err.message ? err.message : err) }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
      if (closed) return { probed: 0 }

      // Self-outage guard BEFORE any counter or flag moves.
      const probed = results.filter(Boolean).length
      const netFails = results.filter((r) => r && r.net).length
      if (netFails * 2 > probed) {
        log(`[liveness] sweep discarded: ${netFails}/${probed} probes failed at the network layer — that is our connectivity, not ${netFails} dead channels`)
        return { probed, discarded: true }
      }

      // Apply: counters, then the flips the counters earned. Counters key on the
      // STREAM ID alone, deliberately not id|url: event-playlist sources re-stamp
      // tokenized urls on every sync (~hourly on event lineups), and a counter that
      // resets with every token rotation could never reach failsToFlip — the
      // feature's primary population would never dim. A genuinely NEW url that is
      // alive clears the counter on its first sweep anyway (first success wins).
      const seen = new Set()
      let up = 0; let down = 0; let failing = 0
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        const r = results[i]
        if (!r) continue // closed mid-sweep
        seen.add(t.id)
        if (r.alive) {
          fails.delete(t.id)
          if (!t.wasLive && await flip(t.id, true, t.url)) { up++; log(`[liveness] "${t.id}" is answering again — back in the lineup`) }
        } else {
          const n = (fails.get(t.id) || 0) + 1
          fails.set(t.id, n)
          if (n >= failsToFlip) failing++
          if (n >= failsToFlip && t.wasLive && await flip(t.id, false, t.url)) {
            down++; log(`[liveness] "${t.id}" dead ${n} sweeps (${r.reason}) — marked offline`)
          }
        }
      }
      // Counters for vanished channels go with them.
      for (const key of fails.keys()) if (!seen.has(key)) fails.delete(key)

      if (up || down) log(`[liveness] probed ${probed} redirect url(s): ${down} newly offline, ${up} recovered`)
      return { probed, up, down, failing }
    } finally {
      running = false
    }
  }

  // The write path: re-read immediately before the put (the sweep's snapshot is
  // minutes old — a source sync or an admin edit may have replaced the record),
  // flip ONLY isLive, and only when it actually changes the record. A record whose
  // url no longer matches the one that was probed keeps its flag: the verdict
  // belongs to the OLD url ("new url = unknown liveness"); the counter survives, so
  // a still-dead channel flips on the next sweep's own evidence. Dual records
  // (feedKey grew since the snapshot) bail for the sweep-filter's reason.
  async function flip (id, isLive, probedUrl) {
    const node = await ctx.db.get(CATALOG_GT + id)
    const cur = node?.value
    if (!cur || !cur.redirect || !cur.url || cur.feedKey) return false // deleted / no longer a pure redirect — not ours to touch
    if (cur.url !== probedUrl) return false // the record moved since the snapshot — this verdict is stale
    if ((cur.isLive !== false) === isLive) return false // already says so — no block spent
    await ctx.db.put(CATALOG_GT + id, { ...cur, isLive })
    if (ctx.activity) ctx.activity.record('liveness', { streamId: id, isLive })
    return true
  }

  const boot = setTimeout(() => { sweep().catch((err) => log(`[liveness] sweep failed: ${err.message || err}`)) }, bootDelayMs)
  if (boot.unref) boot.unref()
  const timer = setInterval(() => { sweep().catch((err) => log(`[liveness] sweep failed: ${err.message || err}`)) }, intervalMs)
  if (timer.unref) timer.unref()

  return {
    probeNow: sweep, // exposed for tests (and a future admin "probe now" button)
    close () { closed = true; clearTimeout(boot); clearInterval(timer) }
  }
}
