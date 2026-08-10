// Desktop redirect-channel header injection (Part C) — pure unit tests, no Electron,
// no network. The module (desktop/main/redirect-headers.js) is plain ESM and takes a
// `session` object, so a fake session that captures the two webRequest callbacks lets
// us drive the real injection logic directly. The twin verification — that the headers
// actually reach a 403-gated provider — is the orchestrator's live desktop pass; this
// lane pins the logic that must not regress under it:
//
//   1. an armed rule injects canonical Referer/Origin/User-Agent on a matching origin;
//   2. the 127.0.0.1 loopback exclusion withholds them from the SDK's own server, even
//      while a rule is active;
//   3. a non-matching origin (a cross-host segment CDN we did not arm) is passed through
//      untouched;
//   4. onHeadersReceived forces Access-Control-Allow-Origin: * on a match, replacing any
//      the provider sent, and leaves non-matching responses alone;
//   5. clear() disarms — no injection until the next update();
//   6. update() with an unparseable url, an empty header set, or a loopback origin does
//      not arm a broken rule;
//   7. lowercase resolve() keys are canonicalized; a case-variant Chromium already set
//      is overwritten, not duplicated.
//
// Run: node tools/desktop-redirect-headers-test.mjs
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { console.error('  FAIL', msg); failures++ } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)

const { installRedirectHeaderRules } = await import(
  pathToFileURL(path.join(repoRoot, 'desktop/main/redirect-headers.js')).href
)

// A fake Electron session: capture whatever installRedirectHeaderRules registers, then
// let the test invoke those callbacks with synthetic request/response details.
function fakeSession () {
  const cbs = {}
  return {
    session: {
      webRequest: {
        onBeforeSendHeaders: (_filter, cb) => { cbs.send = cb },
        onHeadersReceived: (_filter, cb) => { cbs.recv = cb }
      }
    },
    // Drive the request path; returns the { requestHeaders } the module produced.
    send (url, requestHeaders = {}) {
      let out
      cbs.send({ url, requestHeaders: { ...requestHeaders } }, (r) => { out = r })
      return out.requestHeaders
    },
    // Drive the response path; returns the { responseHeaders } the module produced.
    recv (url, responseHeaders = {}) {
      let out
      cbs.recv({ url, responseHeaders: { ...responseHeaders } }, (r) => { out = r })
      return out.responseHeaders
    }
  }
}

const PROVIDER = 'https://cdn.example.com'
const HDRS = { referer: 'https://ref.example/', origin: 'https://ref.example', 'user-agent': 'AliranTest/1.0' }

// --- 1. armed rule injects on a matching origin, canonical casing ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/live/event.m3u8?token=abc`, HDRS)
  const rh = f.send(`${PROVIDER}/live/event.m3u8?token=abc`, { 'User-Agent': 'Chrome/original' })
  eq(rh.Referer, 'https://ref.example/', 'match: Referer injected')
  eq(rh.Origin, 'https://ref.example', 'match: Origin injected')
  eq(rh['User-Agent'], 'AliranTest/1.0', 'match: User-Agent overwrites Chromium default')
  // a cross-host segment on the SAME armed origin still matches
  const seg = f.send(`${PROVIDER}/seg/00001.ts`)
  eq(seg.Referer, 'https://ref.example/', 'match: same-origin segment url also injected')
}

// --- 2. 127.0.0.1 loopback exclusion (SDK's own server) ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, HDRS) // rule ACTIVE
  const rh = f.send('http://127.0.0.1:9000/index.m3u8', { 'User-Agent': 'Chrome/original' })
  ok(rh.Referer === undefined && rh.Origin === undefined, 'loopback: no provider Referer/Origin')
  eq(rh['User-Agent'], 'Chrome/original', 'loopback: User-Agent left as-is')
}

// --- 3. non-matching origin passes through untouched (cross-host CDN we did not arm) ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, HDRS)
  const rh = f.send('https://other-cdn.net/seg/1.ts', { 'User-Agent': 'Chrome/original' })
  ok(rh.Referer === undefined, 'non-match: no Referer injected')
  eq(rh['User-Agent'], 'Chrome/original', 'non-match: request untouched')
}

// --- 4. onHeadersReceived ACAO replace on match, untouched off match ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, HDRS)
  // provider sent a mismatching ACAO with odd casing — must be replaced by '*'
  const rr = f.recv(`${PROVIDER}/x.m3u8`, { 'access-control-allow-origin': ['https://provider.only'], 'Content-Type': ['application/vnd.apple.mpegurl'] })
  eq(rr['Access-Control-Allow-Origin'], ['*'], 'match: ACAO forced to *')
  ok(rr['access-control-allow-origin'] === undefined, 'match: mismatching ACAO deleted (case-insensitive)')
  eq(rr['Content-Type'], ['application/vnd.apple.mpegurl'], 'match: other response headers preserved')
  // a non-matching response is left completely alone
  const other = f.recv('https://other-cdn.net/x', { 'X-Thing': ['1'] })
  eq(other, { 'X-Thing': ['1'] }, 'non-match: response untouched (no ACAO added)')
  // loopback response also untouched
  const loop = f.recv('http://127.0.0.1:9000/index.m3u8', { 'X-Thing': ['1'] })
  eq(loop, { 'X-Thing': ['1'] }, 'loopback: response untouched')
}

// --- 5. clear() disarms ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, HDRS)
  rules.clear()
  const rh = f.send(`${PROVIDER}/x.m3u8`, { 'User-Agent': 'Chrome/original' })
  ok(rh.Referer === undefined, 'clear: no Referer after clear()')
  eq(rh['User-Agent'], 'Chrome/original', 'clear: request untouched')
  const rr = f.recv(`${PROVIDER}/x.m3u8`, { 'X-Thing': ['1'] })
  eq(rr, { 'X-Thing': ['1'] }, 'clear: response untouched (no ACAO)')
}

// --- 6. update() refuses to arm a broken rule ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, HDRS) // arm first
  rules.update('not a url', HDRS) // unparseable url -> disarm
  ok(f.send(`${PROVIDER}/x.m3u8`).Referer === undefined, 'update: unparseable url disarms')

  rules.update(`${PROVIDER}/x.m3u8`, HDRS)
  rules.update(`${PROVIDER}/x.m3u8`, {}) // empty header set -> disarm
  ok(f.send(`${PROVIDER}/x.m3u8`).Referer === undefined, 'update: empty headers disarms')

  rules.update(`${PROVIDER}/x.m3u8`, HDRS)
  rules.update('http://127.0.0.1:8080/x.m3u8', HDRS) // loopback origin -> never arm
  ok(f.send(`${PROVIDER}/x.m3u8`).Referer === undefined, 'update: loopback redirect url does not arm')
  // and the loopback url itself is not injected onto either
  ok(f.send('http://127.0.0.1:8080/x.m3u8').Referer === undefined, 'update: loopback url gets no injection')

  // an unknown/extra key in the header set is ignored, the three allowed ones still work
  rules.update(`${PROVIDER}/x.m3u8`, { ...HDRS, authorization: 'Bearer leak' })
  const rh = f.send(`${PROVIDER}/x.m3u8`)
  eq(rh.Referer, 'https://ref.example/', 'update: extra keys ignored, allowed keys applied')
  ok(rh.Authorization === undefined && rh.authorization === undefined, 'update: Authorization never injected')
}

// --- 7. only-present keys are set (partial header set) ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update(`${PROVIDER}/x.m3u8`, { referer: 'https://ref.only/' }) // referer only
  const rh = f.send(`${PROVIDER}/x.m3u8`, { 'User-Agent': 'Chrome/original' })
  eq(rh.Referer, 'https://ref.only/', 'partial: Referer set')
  ok(rh.Origin === undefined, 'partial: absent Origin not set')
  eq(rh['User-Agent'], 'Chrome/original', 'partial: absent User-Agent leaves Chromium default')
}

// --- 8. POSITIVE localhost-arms: the exclusion is 127.0.0.1-ONLY, not all-loopback ---
// http://localhost and http://[::1] are distinct hosts from the SDK's own 127.0.0.1
// server; they MUST arm and inject (the WP1 verification carve-out relies on it). This
// guards against a future tightening of the exclusion to every loopback name.
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update('http://localhost:9000/live/event.m3u8', HDRS)
  const a = f.send('http://localhost:9000/seg/1.ts', { 'User-Agent': 'Chrome/original' })
  eq(a.Referer, 'https://ref.example/', 'localhost: Referer injected (not excluded)')
  eq(a['User-Agent'], 'AliranTest/1.0', 'localhost: User-Agent injected')

  rules.update('http://[::1]:9000/live/event.m3u8', HDRS)
  const b = f.send('http://[::1]:9000/seg/1.ts')
  eq(b.Referer, 'https://ref.example/', 'ipv6 [::1]: Referer injected (not excluded)')
  eq(b.Origin, 'https://ref.example', 'ipv6 [::1]: Origin injected')
}

// --- 9. origin normalization (default port, credentials-in-url) ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  // default-port equivalence: armed bare-host https matches an explicit :443 request
  rules.update('https://cdn.com/manifest.m3u8', HDRS)
  const p = f.send('https://cdn.com:443/seg.ts')
  eq(p.Referer, 'https://ref.example/', 'norm: :443 request matches bare https origin')
  // credentials in the arm url collapse to the bare origin; a plain request matches it
  rules.update('http://user:pass@cdn.example/x.m3u8', HDRS)
  const c = f.send('http://cdn.example/seg.ts')
  eq(c.Referer, 'https://ref.example/', 'norm: userinfo url arms on the bare origin')
}

// --- 10. stale-rule replacement (single active rule, last update wins) ---
{
  const f = fakeSession()
  const rules = installRedirectHeaderRules(f.session)
  rules.update('https://cdnA.example/x.m3u8', HDRS)
  rules.update('https://cdnB.example/x.m3u8', HDRS)
  ok(f.send('https://cdnA.example/seg.ts').Referer === undefined, 'stale: cdnA no longer injects after re-arm')
  eq(f.send('https://cdnB.example/seg.ts').Referer, 'https://ref.example/', 'stale: cdnB (latest) injects')
  rules.clear()
  ok(f.send('https://cdnB.example/seg.ts').Referer === undefined, 'stale: clear() disarms the latest too')
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall desktop redirect-headers tests passed')
