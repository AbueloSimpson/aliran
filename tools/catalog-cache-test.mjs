// Unit test for client/backend/catalog-cache.mjs — the cached-warm-start gate rules,
// URL re-porting and the terminal judgement. Pure functions, so this runs anywhere.
// Exits 0 on PASS.
import assert from 'assert'
import {
  CATALOG_CACHE_VERSION, CATALOG_CACHE_MAX_AGE_MS,
  gateCatalogCache, warmStartAllowed, rewriteOrigins, terminalCatalogError
} from '../client/backend/catalog-cache.mjs'

const PANEL = 'a'.repeat(64)
const NOW = 1765000000000

function entry (over = {}) {
  return {
    id: 'news', title: 'News 24', category: ['news'], isLive: true, order: 1,
    featured: false, restricted: false,
    poster: 'http://127.0.0.1:40123/assets/news/poster.jpg',
    backdrop: 'https://cdn.example.com/news/backdrop.jpg', // hybrid art — absolute
    logo: 'http://127.0.0.1:40123/assets/news/logo.png',
    guideBase: 'http://127.0.0.1:40123/epg/v1/news',
    thumbBase: 'http://127.0.0.1:40123/feedthumb/news',
    type: 'live', status: 'live',
    ...over
  }
}

function cacheJson (over = {}) {
  return { v: CATALOG_CACHE_VERSION, panelPubKey: PANEL, username: 'alice', savedAt: NOW, port: 40123, vod: null, streams: [entry()], ...over }
}

// --- gateCatalogCache ---
assert.ok(gateCatalogCache(cacheJson()), 'a well-formed cache gates')
assert.strictEqual(gateCatalogCache(null), null)
assert.strictEqual(gateCatalogCache('nope'), null)
assert.strictEqual(gateCatalogCache(cacheJson({ v: 2 })), null, 'unknown version refused')
assert.strictEqual(gateCatalogCache(cacheJson({ panelPubKey: 'beef' })), null, 'short key refused')
assert.strictEqual(gateCatalogCache(cacheJson({ username: '' })), null, 'empty username refused')
assert.strictEqual(gateCatalogCache(cacheJson({ port: 0 })), null, 'port 0 refused')
assert.strictEqual(gateCatalogCache(cacheJson({ streams: [] })), null, 'empty lineup refused')
assert.strictEqual(gateCatalogCache(cacheJson({ streams: [{ title: 'no id' }] })), null, 'id-less entries collapse to no cache')

// The whitelist strips fields this module does not name — the no-keys guarantee's
// second line. A leaked key must not survive write OR read.
{
  const leaked = gateCatalogCache(cacheJson({ streams: [entry({ encryptionKey: 'deadbeef', feedKey: 'cafe', url: 'https://x', headers: { Referer: 'x' } })] }))
  assert.ok(leaked, 'entry still gates')
  const e = leaked.streams[0]
  assert.strictEqual(e.encryptionKey, undefined, 'encryptionKey stripped')
  assert.strictEqual(e.feedKey, undefined, 'feedKey stripped')
  assert.strictEqual(e.url, undefined, 'url stripped')
  assert.strictEqual(e.headers, undefined, 'headers stripped')
  assert.strictEqual(e.title, 'News 24', 'named fields survive')
  assert.strictEqual(e.restricted, false, 'restricted normalized')
}

// restricted defaults CLOSED on junk, and category accepts string or string-list.
{
  const g = gateCatalogCache(cacheJson({ streams: [entry({ restricted: 'yes', category: 'news' })] }))
  assert.strictEqual(g.streams[0].restricted, false, 'non-boolean restricted -> false (entry hidden only by real flag)')
  assert.strictEqual(g.streams[0].category, 'news')
  const g2 = gateCatalogCache(cacheJson({ streams: [entry({ restricted: true, category: ['a', 7, 'b'] })] }))
  assert.strictEqual(g2.streams[0].restricted, true)
  assert.deepStrictEqual(g2.streams[0].category, ['a', 'b'], 'non-string categories dropped')
}

// vod: enabled shape survives, everything else collapses to null.
{
  const on = gateCatalogCache(cacheJson({ vod: { enabled: true, apiBase: 'https://vod.example', service: 'svc', sources: {}, params: {} } }))
  assert.ok(on.vod && on.vod.enabled === true, 'enabled vod survives')
  const off = gateCatalogCache(cacheJson({ vod: { enabled: false, apiBase: 'https://vod.example', service: 'svc' } }))
  assert.strictEqual(off.vod, null, 'disabled vod collapses to null')
}

// --- warmStartAllowed ---
const cache = gateCatalogCache(cacheJson())
const creds = { username: 'alice', password: 'x' }
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: PANEL, creds, signinSaved: false, now: NOW + 1000 }), true, 'creds match -> allowed')
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: PANEL, creds: null, signinSaved: true, now: NOW + 1000 }), true, 'kept sign-in -> allowed')
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: PANEL, creds: null, signinSaved: false, now: NOW + 1000 }), false, 'no way back in -> refused')
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: PANEL, creds: { username: 'bob' }, signinSaved: false, now: NOW + 1000 }), false, 'other account creds -> refused')
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: 'b'.repeat(64), creds, signinSaved: true, now: NOW + 1000 }), false, 'service switch -> refused')
assert.strictEqual(warmStartAllowed({ cache: null, panelPubKey: PANEL, creds, signinSaved: true, now: NOW }), false, 'no cache -> refused')
assert.strictEqual(warmStartAllowed({ cache, panelPubKey: PANEL, creds, signinSaved: false, now: NOW + CATALOG_CACHE_MAX_AGE_MS + 1 }), false, 'stale -> refused')

// --- rewriteOrigins ---
{
  const out = rewriteOrigins(cache.streams, 40123, 51555)
  const e = out[0]
  assert.strictEqual(e.poster, 'http://127.0.0.1:51555/assets/news/poster.jpg', 'loopback art re-ported')
  assert.strictEqual(e.guideBase, 'http://127.0.0.1:51555/epg/v1/news', 'guideBase re-ported')
  assert.strictEqual(e.thumbBase, 'http://127.0.0.1:51555/feedthumb/news', 'thumbBase re-ported')
  assert.strictEqual(e.backdrop, 'https://cdn.example.com/news/backdrop.jpg', 'hybrid https art untouched')
  assert.strictEqual(cache.streams[0].poster, 'http://127.0.0.1:40123/assets/news/poster.jpg', 'input not mutated')
}

// --- terminalCatalogError ---
for (const terminal of [
  'invalid credentials', 'key recovery failed',
  'login failed: unknown user', 'login failed: account disabled',
  'session failed: unknown user', 'session failed: account disabled'
]) assert.strictEqual(terminalCatalogError(terminal), true, terminal + ' is terminal')
for (const kept of [
  'not connected to panel', 'unknown user', // dial gap / replication gap
  'login failed: locked (retry 871s)', // a lockout is a verdict on the moment
  'session failed: device-limit', 'session failed: bad request', 'session failed: sessions unavailable',
  'CHANNEL_CLOSED', '', null, undefined
]) assert.strictEqual(terminalCatalogError(kept), false, String(kept) + ' keeps the cache')

console.log('RESULT: PASS ✅  (catalog-cache: gate whitelist + key stripping, warm-start rules, origin re-porting, terminal classification)')
