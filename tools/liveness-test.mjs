// Tests for the redirect-channel liveness probe (panel/src/liveness.js): probe
// classification (playlist / DASH / direct file / HTML / HTTP error / timeout),
// header pass-through (record headers + the player-shaped UA fallback), the
// 3-consecutive-sweeps hysteresis with first-success flip-back, put-only-on-flip
// bee frugality, the url-change counter reset, and the network-layer self-outage
// guard that discards a sweep instead of dimming the lineup.
// npm run test:liveness
import assert from 'assert'
import http from 'http'
import { probeUrl, makeLivenessProber, PLAYER_UA } from '../panel/src/liveness.js'

const log = (...a) => console.log(...a)

// ---- local server: per-path behavior, mutable from the test -------------------
const state = {
  dead: false, // /toggle.m3u8 flips on this
  lastHeaders: {} // path -> the request headers the server saw
}
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  state.lastHeaders[path] = req.headers
  if (path === '/ok.m3u8' || (path === '/toggle.m3u8' && !state.dead)) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n')
  } else if (path === '/toggle.m3u8') {
    res.writeHead(404); res.end('not found')
  } else if (path === '/dash') {
    res.writeHead(200, { 'content-type': 'application/dash+xml' })
    res.end('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>')
  } else if (path === '/file.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.alloc(64))
  } else if (path === '/portal') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!DOCTYPE html><html><body>expired</body></html>')
  } else if (path === '/hotlink.m3u8') {
    // A provider hotlink check: right Referer or nothing.
    if (req.headers.referer === 'https://prov.example/') {
      res.writeHead(200); res.end('#EXTM3U\n')
    } else { res.writeHead(403); res.end('forbidden') }
  } else if (path === '/hang') {
    // accept and never answer — the probe's timeout is the only way out
  } else {
    res.writeHead(404); res.end('nope')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`
// A port with no listener: fetch fails at the network layer (the self-outage class).
const REFUSED = 'http://127.0.0.1:9'

// ---- stubs ---------------------------------------------------------------------
function makeDb (records) {
  const m = new Map(Object.entries(records))
  const stats = { puts: 0 }
  return {
    m,
    stats,
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { stats.puts++; m.set(k, v) },
    createReadStream ({ gt, lt }) {
      const entries = [...m.entries()].filter(([k]) => k > gt && k < lt).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      return (async function * () { for (const [key, value] of entries) yield { key, value } })()
    }
  }
}
const redirect = (url, extra = {}) => ({ title: 't', redirect: true, url, headers: null, isLive: true, type: 'live', status: 'live', ...extra })
function makeActivity () {
  const entries = []
  return { entries, record (type, data) { entries.push({ type, ...data }) } }
}
const quiet = () => {}

// ===== A: probeUrl classification =====
{
  const o = { timeoutMs: 2000 }
  assert.deepStrictEqual(await probeUrl(`${BASE}/ok.m3u8`, null, o), { alive: true }, 'HLS playlist is alive')
  assert.deepStrictEqual(await probeUrl(`${BASE}/dash`, null, o), { alive: true }, 'DASH manifest is alive')
  assert.deepStrictEqual(await probeUrl(`${BASE}/file.mp4`, null, o), { alive: true }, 'direct media file is alive')
  assert.strictEqual((await probeUrl(`${BASE}/gone`, null, o)).alive, false, '404 is dead')
  assert.strictEqual((await probeUrl(`${BASE}/gone`, null, o)).net, undefined, 'an HTTP status is NOT a network-layer failure')
  assert.strictEqual((await probeUrl(`${BASE}/portal`, null, o)).reason, 'HTML page, not a stream', 'a 200 HTML answer is dead')
  const timedOut = await probeUrl(`${BASE}/hang`, null, { timeoutMs: 300 })
  assert.strictEqual(timedOut.alive, false)
  assert.strictEqual(timedOut.net, true, 'timeout is a network-layer failure')
  const refused = await probeUrl(REFUSED, null, { timeoutMs: 2000 })
  assert.strictEqual(refused.net, true, 'connection refused is a network-layer failure')
  log('A: probeUrl — playlist/DASH/file alive; 404/HTML dead; timeout+refused are net-layer ✓')
}

// ===== B: header pass-through =====
{
  const o = { timeoutMs: 2000 }
  await probeUrl(`${BASE}/ok.m3u8`, null, o)
  assert.strictEqual(state.lastHeaders['/ok.m3u8']['user-agent'], PLAYER_UA, 'no record UA -> the player-shaped UA, never the node default')
  assert.strictEqual((await probeUrl(`${BASE}/hotlink.m3u8`, null, o)).alive, false, 'hotlink check refuses a bare probe')
  const r = await probeUrl(`${BASE}/hotlink.m3u8`, { Referer: 'https://prov.example/', 'User-Agent': 'VendorPlayer/9' }, o)
  assert.strictEqual(r.alive, true, 'the record headers make the probe look like a viewer')
  assert.strictEqual(state.lastHeaders['/hotlink.m3u8']['user-agent'], 'VendorPlayer/9', 'a record UA overrides the fallback')
  log('B: headers — record Referer/UA ride the probe; fallback UA is the player-shaped one ✓')
}

// ===== C: hysteresis — 3 failed sweeps flip, first success flips back =====
{
  state.dead = true
  const db = makeDb({ 'catalog/ev1': redirect(`${BASE}/toggle.m3u8`), 'catalog/ok1': redirect(`${BASE}/ok.m3u8`) })
  const activity = makeActivity()
  const prober = makeLivenessProber({ config: {}, db, activity }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 2000, log: quiet })

  await prober.probeNow(); await prober.probeNow()
  assert.strictEqual(db.m.get('catalog/ev1').isLive, true, 'two failed sweeps: not flipped yet')
  assert.strictEqual(db.stats.puts, 0, 'no put before the flip')

  const third = await prober.probeNow()
  assert.strictEqual(db.m.get('catalog/ev1').isLive, false, 'third failed sweep flips isLive:false')
  assert.strictEqual(db.m.get('catalog/ev1').status, 'live', 'status is ops-owned — untouched by the probe')
  assert.strictEqual(db.m.get('catalog/ok1').isLive, true, 'the healthy channel is untouched')
  assert.strictEqual(db.stats.puts, 1, 'exactly one put for the flip')
  assert.deepStrictEqual(activity.entries, [{ type: 'liveness', streamId: 'ev1', isLive: false }])
  assert.strictEqual(third.down, 1)

  await prober.probeNow()
  assert.strictEqual(db.stats.puts, 1, 'still dead: put-only-on-flip — no block spent restating it')

  state.dead = false // the event started
  const recovery = await prober.probeNow()
  assert.strictEqual(db.m.get('catalog/ev1').isLive, true, 'FIRST success flips back — no hysteresis on recovery')
  assert.strictEqual(db.stats.puts, 2)
  assert.strictEqual(recovery.up, 1)
  assert.deepStrictEqual(activity.entries[1], { type: 'liveness', streamId: 'ev1', isLive: true })
  prober.close()
  log('C: hysteresis — flip at 3, put-only-on-flip, first-success recovery ✓')
}

// ===== D: a url change resets the fail counter =====
{
  state.dead = true
  const db = makeDb({ 'catalog/ev1': redirect(`${BASE}/toggle.m3u8`) })
  const prober = makeLivenessProber({ config: {}, db, activity: null }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 2000, log: quiet })
  await prober.probeNow(); await prober.probeNow() // 2 fails on the old url
  db.m.set('catalog/ev1', redirect(`${BASE}/gone`)) // admin/sync moved the channel to a (also dead) new url
  await prober.probeNow()
  assert.strictEqual(db.m.get('catalog/ev1').isLive, true, 'new url = fresh counter — 1 fail, not 3')
  await prober.probeNow(); await prober.probeNow()
  assert.strictEqual(db.m.get('catalog/ev1').isLive, false, 'three fails on the NEW url flip it')
  prober.close()
  state.dead = false
  log('D: url change resets the counter ✓')
}

// ===== E: self-outage guard — a mostly-net-dead sweep is discarded =====
{
  const db = makeDb({
    'catalog/a': redirect(`${REFUSED}/a.m3u8`),
    'catalog/b': redirect(`${REFUSED}/b.m3u8`),
    'catalog/c': redirect(`${REFUSED}/c.m3u8`),
    'catalog/d': redirect(`${BASE}/ok.m3u8`)
  })
  const prober = makeLivenessProber({ config: {}, db, activity: null }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 2000, log: quiet })
  for (let i = 0; i < 5; i++) {
    const r = await prober.probeNow()
    assert.strictEqual(r.discarded, true, 'the sweep is discarded, not applied')
  }
  assert.strictEqual(db.stats.puts, 0, 'five all-but-one-net-dead sweeps dimmed NOTHING — that was our connectivity')
  prober.close()
  log('E: self-outage guard — >half net-layer failures discard the sweep ✓')
}

// ===== F: non-targets are never probed or touched =====
{
  const db = makeDb({
    'catalog/p2p': { title: 'p', feedKey: 'f'.repeat(64), isLive: true, type: 'live' }, // no redirect
    'catalog/vodr': redirect(`${BASE}/gone`, { type: 'vod' }) // vod redirect record: not live inventory
  })
  const prober = makeLivenessProber({ config: {}, db, activity: null }, { intervalMs: 3600000, bootDelayMs: 3600000, timeoutMs: 2000, log: quiet })
  const r = await prober.probeNow()
  assert.strictEqual(r.probed, 0, 'p2p and vod records are out of scope')
  assert.strictEqual(db.stats.puts, 0)
  prober.close()
  log('F: only live redirect records are probed ✓')
}

// ===== G: disabled prober is a stub =====
{
  const db = makeDb({ 'catalog/x': redirect(`${BASE}/gone`) })
  const prober = makeLivenessProber({ config: { liveness: { intervalMinutes: 0 } } , db, activity: null }, { log: quiet })
  const r = await prober.probeNow()
  assert.strictEqual(r.disabled, true)
  assert.strictEqual(db.stats.puts, 0)
  prober.close()
  log('G: LIVENESS_INTERVAL_MINUTES=0 disables cleanly ✓')
}

server.close()
log('liveness: all groups passed ✓')
