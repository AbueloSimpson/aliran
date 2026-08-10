// Redirect-channel header injection (S23 + live-events M3U, Part C) — the desktop
// answer to "the player must send Referer/Origin/User-Agent this url's provider
// hotlink-checks, but hls.js cannot."
//
// WHY THIS LIVES IN THE MAIN PROCESS (the vod-provider.js precedent: main does the
// network work the renderer structurally can't). Referer, Origin and User-Agent are
// FORBIDDEN request headers — the browser owns them, and any attempt to set them from
// renderer JS (fetch, XHR, hls.js's loader) is silently dropped. A redirect channel
// imported from a provider M3U carries exactly these three on its catalog record; the
// only place on desktop that can put them on the wire is Electron's session.webRequest,
// which runs here in main. So the renderer just loads the url (HlsVideo.tsx) and this
// module rewrites the outgoing headers underneath it.
//
// ONE LISTENER PER EVENT PER SESSION. Electron allows a single onBeforeSendHeaders and
// a single onHeadersReceived handler per session; a second registration REPLACES the
// first. So we register ONCE, at app-ready, with the broad ['http://*/*','https://*/*']
// filter and gate inside the callback against the active rule, rather than a narrow
// per-origin one we'd have to re-register on every tune. NOTE the filter breadth is not
// the same as injection breadth: injection is gated to the redirect url's OWN origin
// (active.origins, one origin per rule), so a provider that serves its HLS segments from
// a DIFFERENT host than the playlist — or 302s to one — gets no headers on those
// cross-host requests and they 403. react-native-video applies source.headers to every
// request regardless of host, so such a provider works on phone but not desktop. This is
// the deferred multi-origin risk (mitigation: grow active.origins from onBeforeRedirect);
// verify a real playlist's segment hosts before relying on desktop for it.
//
// THE 127.0.0.1 HARD EXCLUSION. The SDK serves P2P playback and channel art from its
// own localhost HLS/art server on 127.0.0.1. That server must NEVER receive a provider's
// Referer/Origin/User-Agent — they are meaningless to it and leaking a provider identity
// onto loopback requests is exactly the kind of cross-context bleed to avoid. So the
// request path early-outs on any http://127.0.0.1 url before it even looks at the active
// rule. (Note: the panel's normRedirectUrl carve-out also permits localhost/[::1]
// redirect urls for LOCAL VERIFICATION, but the injection exclusion here is specifically
// the loopback ORIGIN the SDK serves on, 127.0.0.1 — a verification stub must therefore
// live on some other host, or its headers will be withheld by design.)
//
// THE ACAO PATCH AND THE null-ORIGIN RENDERER. The renderer is loaded via loadFile
// (index.js), so its document origin is "null". hls.js fetches the manifest and segments
// with non-credentialed cross-origin XHR; the provider's response needs an
// Access-Control-Allow-Origin the null origin accepts, and "*" is the only value that
// does (a specific echoed origin would have to be "null", which providers never send).
// So on a matched response we delete any ACAO the CDN did send (some send a mismatching
// one) and set Access-Control-Allow-Origin: * ourselves. Non-matching responses are left
// completely untouched. We do NOT set webSecurity:false (that would kill CORS globally —
// a real regression) and we do NOT build a main-process HLS proxy (the fallback plan for
// providers that need Range preflight synthesis — deliberately out of scope).
//
// The state is a single active rule or null: { origins: Set<string>, headers } where
// headers is already in canonical HTTP casing. update() is called from index.js on a
// 'port' reply that carries provider headers; clear() on any other tune (a P2P tune
// hands out no headers, which clears the rule before hls.js issues its first GET).

const LOOPBACK_PREFIX = 'http://127.0.0.1'

// Parse a url's origin (scheme://host:port); null on anything unparseable so a garbage
// url can never accidentally match a rule.
function originOf (url) {
  try { return new URL(url).origin } catch { return null }
}

// Case-insensitive read of one header off a plain object. The SDK stores/returns the
// three keys lowercased (panel normRedirectHeaders), but reading case-insensitively
// keeps this robust against a hand-edited record or a future casing change.
function pick (headers, name) {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k]
  return undefined
}

// Canonicalize the (at most) three allowed keys into real HTTP header casing, dropping
// anything absent. Returns null when nothing usable survives — the caller then clears
// the rule rather than arming an empty one.
function canonicalize (headers) {
  if (!headers || typeof headers !== 'object') return null
  const out = {}
  const ref = pick(headers, 'referer')
  const org = pick(headers, 'origin')
  const ua = pick(headers, 'user-agent')
  if (ref != null && String(ref)) out.Referer = String(ref)
  if (org != null && String(org)) out.Origin = String(org)
  if (ua != null && String(ua)) out['User-Agent'] = String(ua)
  return Object.keys(out).length ? out : null
}

// Delete every case-variant of `name` from a header map (request or response), in place.
function deleteHeader (map, name) {
  const lower = name.toLowerCase()
  for (const k of Object.keys(map)) if (k.toLowerCase() === lower) delete map[k]
}

/**
 * Register the two webRequest handlers ONCE on `session` and return the controls the
 * engine wiring drives. `session` is Electron's session.defaultSession in production;
 * tests pass a fake whose webRequest captures the callbacks.
 *
 * @param {import('electron').Session} session
 * @returns {{ update(url: string, headers: object): void, clear(): void }}
 */
export function installRedirectHeaderRules (session) {
  // active = null (nothing to inject) or { origins: Set<string>, headers: {canonical} }.
  let active = null

  const filter = { urls: ['http://*/*', 'https://*/*'] }

  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const url = details.url || ''
    // Cheap early-outs: no rule, or a request to the SDK's own loopback server (which
    // must never carry provider headers — see the header block).
    if (!active || url.startsWith(LOOPBACK_PREFIX)) { callback({ requestHeaders: details.requestHeaders }); return }
    const origin = originOf(url)
    if (!origin || !active.origins.has(origin)) { callback({ requestHeaders: details.requestHeaders }); return }
    // Matched: overwrite the allowed keys (delete any case-variant Chromium already set,
    // then set our canonical one), pass everything else through untouched.
    const rh = details.requestHeaders || {}
    for (const key of Object.keys(active.headers)) {
      deleteHeader(rh, key)
      rh[key] = active.headers[key]
    }
    callback({ requestHeaders: rh })
  })

  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    const url = details.url || ''
    if (!active || url.startsWith(LOOPBACK_PREFIX)) { callback({ responseHeaders: details.responseHeaders }); return }
    const origin = originOf(url)
    if (!origin || !active.origins.has(origin)) { callback({ responseHeaders: details.responseHeaders }); return }
    // Matched: force a permissive ACAO so the null-origin renderer's XHR is accepted.
    // responseHeaders values are ARRAYS in Electron.
    const rh = details.responseHeaders || {}
    deleteHeader(rh, 'access-control-allow-origin')
    rh['Access-Control-Allow-Origin'] = ['*']
    callback({ responseHeaders: rh })
  })

  return {
    // Arm the rule for one redirect serve. `headers` is the resolve() header set
    // (lowercase keys); it is canonicalized here. An unparseable url or empty header
    // set clears the rule rather than arming a broken one.
    update (url, headers) {
      const origin = originOf(url)
      const canon = canonicalize(headers)
      if (!origin || !canon || origin.startsWith(LOOPBACK_PREFIX)) { active = null; return }
      active = { origins: new Set([origin]), headers: canon }
    },
    // Disarm — no injection until the next update(). Called on any P2P/localhost tune.
    clear () { active = null }
  }
}
