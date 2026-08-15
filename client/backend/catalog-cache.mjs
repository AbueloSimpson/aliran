// Cached warm start — the PURE half: gate rules, URL re-porting and the one terminal
// judgement, with no fs, no IPC and no crypto, so every rule is testable off a
// television (tools/catalog-cache-test.mjs), exactly like signin-vault.mjs before it.
//
// WHAT THE CACHE IS. A snapshot of the last session's DISPLAY list — the engine's
// _display() projection (sdk/player.js): titles, categories, art/guide/thumb URLs,
// restricted flags. It exists so a device that logged in before can paint the menu in
// the first second of a boot while the real login dials behind it. What it is NOT is a
// session: it carries no feed keys, no encryption keys, no token — playback stays
// impossible until the real login lands, by construction.
//
// The per-entry whitelist below is the SECOND line of that guarantee (the first being
// that _display never includes keys): even if a future engine change leaked a field
// into the streams event, the cache strips it on write AND on read — a field this file
// does not name does not survive the disk.

export const CATALOG_CACHE_VERSION = 1

// Staleness bound. Deliberately generous: the wholesale replace on every real login and
// the terminal-failure deletion do the real invalidation work — this only stops a set
// that has been in a closet since last season from painting a lineup of ghosts.
export const CATALOG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const HEX64_RE = /^[0-9a-f]{64}$/

// The exact _display() shape (sdk/player.js), field by field. Anything else is dropped.
const ENTRY_STRINGS = ['title', 'description', 'poster', 'backdrop', 'logo', 'epgUrl', 'epgId', 'guideBase', 'thumbBase', 'type', 'status']
const ENTRY_NUMBERS = ['order', 'durationSec']

function gateEntry (e) {
  if (!e || typeof e !== 'object') return null
  if (typeof e.id !== 'string' || !e.id) return null
  const out = { id: e.id }
  for (const k of ENTRY_STRINGS) { if (typeof e[k] === 'string') out[k] = e[k] }
  for (const k of ENTRY_NUMBERS) { if (typeof e[k] === 'number' && Number.isFinite(e[k])) out[k] = e[k] }
  // category rides verbatim from the catalog record: a single name or a list of them.
  if (typeof e.category === 'string') out.category = e.category
  else if (Array.isArray(e.category)) out.category = e.category.filter((c) => typeof c === 'string')
  if (typeof e.isLive === 'boolean') out.isLive = e.isLive
  if (typeof e.featured === 'boolean') out.featured = e.featured
  out.restricted = e.restricted === true // parental gating fails CLOSED off this flag
  return out
}

// Re-gate a parsed cache file into the record this module vouches for, or null. Run on
// READ as well as write (the readPrefs() rationale applies verbatim: the disk is not a
// trusted input — a truncated or hand-edited file must degrade to "no cache", never to
// a malformed emit).
export function gateCatalogCache (json) {
  if (!json || typeof json !== 'object') return null
  if (json.v !== CATALOG_CACHE_VERSION) return null
  if (typeof json.panelPubKey !== 'string' || !HEX64_RE.test(json.panelPubKey)) return null
  if (typeof json.username !== 'string' || !json.username) return null
  if (typeof json.savedAt !== 'number' || !Number.isFinite(json.savedAt)) return null
  if (!Number.isInteger(json.port) || json.port < 1 || json.port > 65535) return null
  if (!Array.isArray(json.streams) || !json.streams.length) return null
  const streams = []
  for (const e of json.streams) {
    const g = gateEntry(e)
    if (g) streams.push(g)
  }
  if (!streams.length) return null
  // The VOD provider config rides the same lifecycle as the lineup (the Menu's VOD tile
  // keys on it). Enabled-shape only; anything else collapses to "feature off".
  let vod = null
  const v = json.vod
  if (v && typeof v === 'object' && v.enabled === true && typeof v.apiBase === 'string' && typeof v.service === 'string') {
    vod = { enabled: true, apiBase: v.apiBase, service: v.service, sources: (v.sources && typeof v.sources === 'object') ? v.sources : {}, params: (v.params && typeof v.params === 'object') ? v.params : {} }
  }
  return { v: CATALOG_CACHE_VERSION, panelPubKey: json.panelPubKey, username: json.username, savedAt: json.savedAt, port: json.port, vod, streams }
}

// May this boot emit the cache as provisional streams? ALL of:
//   - a gated cache (see above) for exactly the panel being connected — a service
//     switch must land on Connect/Login exactly as today, never on another operator's
//     lineup;
//   - a way back into the SAME account: saved credentials naming the cache's username,
//     or a kept phone->TV sign-in (signinSaved — the vault record is sealed, so its
//     username cannot be compared pre-unseal; a handover for a different account
//     rewrites the cache on its own real login's streams push);
//   - fresh enough (CATALOG_CACHE_MAX_AGE_MS).
export function warmStartAllowed ({ cache, panelPubKey, creds, signinSaved, now = Date.now() } = {}) {
  if (!cache) return false
  if (typeof panelPubKey !== 'string' || cache.panelPubKey !== panelPubKey) return false
  const credsMatch = !!(creds && typeof creds.username === 'string' && creds.username === cache.username)
  if (!credsMatch && signinSaved !== true) return false
  return (now - cache.savedAt) < CATALOG_CACHE_MAX_AGE_MS
}

// The loopback server binds a fresh ephemeral port every boot, so the art/guide/thumb
// URLs a cache carries are minted for a port that no longer answers. Re-port them.
// Absolute https art (hybrid art) never carries the loopback prefix and passes through
// untouched — as does anything else that does not match exactly.
export function rewriteOrigins (streams, fromPort, toPort) {
  const from = `http://127.0.0.1:${fromPort}/`
  const to = `http://127.0.0.1:${toPort}/`
  return streams.map((s) => {
    const out = { ...s }
    for (const k of ['poster', 'backdrop', 'logo', 'guideBase', 'thumbBase']) {
      if (typeof out[k] === 'string' && out[k].startsWith(from)) out[k] = to + out[k].slice(from.length)
    }
    return out
  })
}

// Login failures after which the cache must be DELETED — the ones that say this way
// back in is dead, so the next boot must show the Login screen rather than flash a menu
// and yank it away again. EXACT matches, conservative by construction (the
// signin-vault.mjs lesson: "anything the panel said" is NOT the rule): a lockout
// ('locked (retry Ns)'), a dial gap ('not connected to panel'), a replication gap (bare
// 'unknown user') and every malformed-call/panel-trouble session code keep the cache —
// they are verdicts on the moment, not on the account.
const TERMINAL_MESSAGES = new Set([
  'invalid credentials', // client-side verify against the replicated record — a rotated/wrong password
  'key recovery failed',
  'login failed: unknown user',
  'login failed: account disabled',
  'session failed: unknown user',
  'session failed: account disabled'
])

export function terminalCatalogError (message) {
  return TERMINAL_MESSAGES.has(String(message || '').trim())
}
