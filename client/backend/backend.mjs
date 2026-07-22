// Aliran client backend — runs inside the Android app via react-native-bare-kit.
//
// Since S10a this is a THIN IPC SHELL over @aliran/player-sdk (sdk/player.js): it
// injects the Bare runtime modules (bare-http1/bare-fs), forwards IPC messages to
// AliranPlayer methods, and relays engine events as the existing IPC message types.
// The engine logic (panel connect, OPRF login, feed serving, store recovery) lives in
// the SDK — one core for the app and for integrators.
//
// Bundle with:  npm run bundle-backend   (from client/)
//   -> bare-pack --preset android --builtins backend/bare-builtins.cjs --imports backend/imports.json --encoding base64 --out backend/app.bundle.js backend/backend.mjs
// (app.bundle.js is a build artifact, gitignored; regenerate it as part of the app build.)
//
// IPC (line-delimited JSON) with React Native:
//   in : { panelPubKey, hybrid?, prewarm?, tune?, zapPrefetch?, swarm?, uploadPolicy? }
//                                     -> connect to panel; optional hybrid CDN<->P2P
//                                        config (cdnUrl as a '{streamId}' template
//                                        string — JSON-safe), feed prewarm count,
//                                        tune self-heal knobs, adjacent-channel
//                                        zap prefetch (OFF by default — standing
//                                        bandwidth; see sdk/player.js), swarm
//                                        tuning ({ maxPeers } — seed nodes only,
//                                        viewers omit it — and { rcvbufMb, sndbufMb }
//                                        UDP socket buffers, default recv 2 MiB /
//                                        send untouched), and uploadPolicy
//                                        ('reseed' default | 'client-only' = never
//                                        announce, ~zero viewer-to-viewer upload)
//        { username, password }       -> OPRF login -> { streams } (display metadata)
//        { streamId }                 -> play an entitled stream -> { port, url, source,
//                                        recordType, durationSec }
//                                        (redirect channels, S23: url is the remote
//                                        https URL, source 'cdn', port undefined —
//                                        the player plays it directly, no localhost)
//        { feedKey, encryptionKey }   -> dev direct-play (no login)
//        { type:'prefs-get' }         -> { type:'prefs', creds, favorites, smoothZapping,
//                                        service }
//        { type:'creds-save', username, password } | { type:'creds-clear' }
//        { type:'service-save', service: { panelPubKey, name? } } | { type:'service-clear' }
//                                        (S36 runtime descriptor: the public keyless app
//                                        persists the operator service entered on its
//                                        Connect screen; baked builds never send these)
//        { type:'favorites-set', favorites: [streamId] }   (each replies with 'prefs')
//        { type:'reconnect' }         -> tear down the active feed's swarm connections
//                                        and dial fresh (wedged-transport escalation
//                                        from <AliranVideo>'s stall ladder)
//        { type:'zap-prefetch-set', zapPrefetch }  -> runtime "Smooth zapping" toggle:
//                                        boolean or config object, applied mid-play
//        { type:'net-info', expensive }            -> host network profile (NetInfo):
//                                        expensive=true suspends zap prefetch
//   out: { type:'ready' } | { type:'streams', streams }   (on login, and pushed again
//                                        live whenever the panel edits the catalog —
//                                        same shape; the Home screen re-renders on it)
//        { type:'port', port, url, source, streamId, recordType, durationSec }
//                                        (url = ACTIVE source under hybrid; streamId
//                                        echoes the play() request so the client can
//                                        tell WHICH channel the shared localhost URL
//                                        now serves — no streamId on the dev
//                                        direct-play reply. recordType/durationSec,
//                                        S8a: the engine's ResolveResult type —
//                                        'vod' = finished library title, show
//                                        seek/pause UI and expect no live self-heal)
//        { type:'status', state|peers } | { type:'login-error'|'error', message }
//        { type:'fallback', streamId, url, reason } | { type:'source-changed', streamId, source, url }
//        { type:'feed-changed', streamId, feedKey, url }   (active stream's feedKey rotated)
//        { type:'zap-prefetch', enabled }          (echo of a runtime toggle) |
//        { type:'zap-prefetch', state:'suspended'|'resumed', reason? }   (adaptive gate)
//        { type:'prefs', creds: {username,password}|null, favorites: [streamId],
//          smoothZapping: true|false|null,   (null = user never set the toggle)
//          service: {panelPubKey,name?}|null }   (runtime-entered operator service)
//
// Prefs (S18): device-local "remember me" credentials (D1 — plaintext at rest inside
// the app-private files dir, the stated tradeoff; sign-out clears them) + favorites
// (D4). Stored BESIDE the corestore, not in it — the store is a disposable cache that
// corruption recovery purges wholesale, and prefs must survive that.

/* global BareKit, Bare */
import './globals.mjs' // FIRST: polyfills TextEncoder/TextDecoder/crypto for the Bare worklet
import http from 'bare-http1'
import fs from 'bare-fs'
import b4a from 'b4a'
import { AliranPlayer } from '@aliran/player-sdk/player.js'

const IPC = BareKit.IPC
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

// Last resort: an uncaught exception in the worklet otherwise SIGABRTs the WHOLE app
// process (bare-kit). Surface it over IPC instead; the store-recovery and player
// retry paths handle the aftermath.
if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('uncaughtException', (err) => {
    try { send({ type: 'error', message: 'worklet: ' + String((err && err.message) || err) }) } catch {}
  })
}

// The worklet's cwd on Android is '/' (bare-kit sets no cwd/HOME), so a relative
// store path fails with ENOENT. Derive the app sandbox from the process name
// (/proc/self/cmdline == the Android package name) and store under its files dir.
function storeDir () {
  try {
    const name = b4a.toString(fs.readFileSync('/proc/self/cmdline')).split('\0')[0].trim()
    if (/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(name)) {
      // The files dir may not exist yet (fresh install, or right after `pm clear`
      // wipes it) — create it rather than probing, or the worklet falls back to a
      // relative path that ENOENTs from cwd '/'.
      const dir = '/data/data/' + name + '/files'
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      if (fs.existsSync(dir)) return dir + '/aliran-store'
    }
  } catch {}
  return './aliran-store' // desktop / non-Android fallback
}

// --- device-local prefs (saved credentials + favorites) ---
// Lives next to the store dir (files-dir root on Android, cwd on desktop) so the
// corruption-recovery purge of the store never wipes login or favorites.
function prefsPath () {
  return storeDir().replace(/aliran-store$/, 'aliran-prefs.json')
}

function readPrefs () {
  try {
    const p = JSON.parse(b4a.toString(fs.readFileSync(prefsPath())))
    return {
      creds: p && p.creds && typeof p.creds.username === 'string' && typeof p.creds.password === 'string' ? p.creds : null,
      favorites: Array.isArray(p && p.favorites) ? p.favorites.filter((x) => typeof x === 'string') : [],
      // "Smooth zapping" toggle: null = the user never chose (boot uses the app's
      // compiled default), true/false = their persisted choice wins.
      smoothZapping: typeof (p && p.smoothZapping) === 'boolean' ? p.smoothZapping : null,
      // Runtime service descriptor (S36): the operator panel key the public keyless
      // app connected to. Builds with a baked key ignore it (baked always wins).
      service: p && p.service && /^[0-9a-f]{64}$/.test(p.service.panelPubKey)
        ? { panelPubKey: p.service.panelPubKey, ...(typeof p.service.name === 'string' ? { name: p.service.name } : {}) }
        : null
    }
  } catch {
    return { creds: null, favorites: [], smoothZapping: null, service: null }
  }
}

function writePrefs (prefs) {
  try { fs.writeFileSync(prefsPath(), b4a.from(JSON.stringify(prefs))) } catch (err) {
    send({ type: 'error', message: 'prefs write failed: ' + String((err && err.message) || err) })
  }
}

function sendPrefs () { send({ type: 'prefs', ...readPrefs() }) }

let player = null
// The panel key the live player was built for — a later {panelPubKey} message with a
// DIFFERENT key is a service switch (S36) and replaces the engine wholesale.
let connectedKey = null
// The operator/user's CONFIGURED upload policy. The network gate (S25) flips the live
// policy to 'client-only' on cellular/metered and restores THIS on the way back — so a
// deployment that ships uploadPolicy:'client-only' is never silently upgraded to reseed
// by a Wi-Fi event.
let basePolicy = 'reseed'

function ensurePlayer (hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy) {
  if (player) return player
  if (uploadPolicy === 'client-only' || uploadPolicy === 'reseed') basePolicy = uploadPolicy
  player = new AliranPlayer({ storeDir: storeDir(), http, fs, hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy })
  player.on('ready', () => send({ type: 'ready' }))
  player.on('streams', (streams) => send({ type: 'streams', streams }))
  player.on('status', (status) => {
    // Mirror the servers' "[net] ..." console line for the socket-buffer tuning
    // outcome (S33) so plain logcat shows it even without the RN debug relay.
    if (status && status.state === 'net:tuned') { try { console.log('[net]', status.message) } catch {} }
    send({ type: 'status', ...status })
  })
  player.on('peers', (peers) => send({ type: 'status', peers }))
  player.on('recovered', (err) => send({ type: 'status', state: 'store:reset', message: String((err && err.message) || err) }))
  player.on('fallback', (e) => send({ type: 'fallback', ...e }))
  player.on('source-changed', (e) => send({ type: 'source-changed', ...e }))
  player.on('feed-changed', (e) => send({ type: 'feed-changed', ...e }))
  player.on('zap-prefetch', (e) => send({ type: 'zap-prefetch', ...e }))
  // Background engine failures with no caller to throw to — most importantly the tune
  // watchdog's timeout. Dropping these left the app spinning forever on a dead tune.
  player.on('error', (err) => send({ type: 'error', message: String((err && err.message) || err) }))
  return player
}

// --- IPC dispatch ---
let buf = ''
IPC.on('data', (data) => {
  buf += b4a.toString(data)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    const fail = (err) => send({ type: 'error', message: String((err && err.message) || err) })
    // Typed prefs messages first — 'creds-save' also carries username/password, which
    // the legacy shape-based login dispatch below would otherwise swallow.
    if (msg.type === 'prefs-get') {
      sendPrefs()
    } else if (msg.type === 'creds-save' && typeof msg.username === 'string' && typeof msg.password === 'string') {
      writePrefs({ ...readPrefs(), creds: { username: msg.username, password: msg.password } })
      sendPrefs()
    } else if (msg.type === 'creds-clear') {
      writePrefs({ ...readPrefs(), creds: null })
      sendPrefs()
    } else if (msg.type === 'service-save' && msg.service && /^[0-9a-f]{64}$/.test(msg.service.panelPubKey)) {
      writePrefs({ ...readPrefs(), service: { panelPubKey: msg.service.panelPubKey, ...(typeof msg.service.name === 'string' ? { name: msg.service.name } : {}) } })
      sendPrefs()
    } else if (msg.type === 'service-clear') {
      writePrefs({ ...readPrefs(), service: null })
      sendPrefs()
    } else if (msg.type === 'favorites-set' && Array.isArray(msg.favorites)) {
      writePrefs({ ...readPrefs(), favorites: msg.favorites.filter((x) => typeof x === 'string') })
      sendPrefs()
    } else if (msg.type === 'reconnect') {
      // Wedged-transport escalation from the app's stall ladder: destroy the active
      // feed's connections so the swarm dials fresh. 'feed:reconnect' status + the
      // tune watchdog's outcome (playback resumes, or a friendly error) relay via the
      // existing event listeners.
      if (player) { try { player.reconnectActiveFeed() } catch (err) { fail(err) } }
    } else if (msg.type === 'zap-prefetch-set') {
      // Runtime "Smooth zapping" toggle: persist the choice (it survives restarts and
      // overrides the compiled default at the next boot) and apply it mid-play.
      writePrefs({ ...readPrefs(), smoothZapping: !!msg.zapPrefetch })
      if (player) { try { player.setZapPrefetch(msg.zapPrefetch) } catch (err) { fail(err) } }
      sendPrefs()
    } else if (msg.type === 'net-info') {
      if (player) {
        try {
          player.setNetworkProfile({ expensive: !!msg.expensive })
          // S25: on cellular OR a metered link, stop re-seeding — a viewer should never
          // burn mobile upload allowance serving other peers. Restores the configured
          // policy the moment the network is cheap again. `client` stays true throughout,
          // so this never interrupts the viewer's OWN playback; only the announce flips.
          const limited = !!msg.expensive || !!msg.cellular
          const want = limited ? 'client-only' : basePolicy
          player.setUploadPolicy(want).then((r) => {
            if (r.changed) send({ type: 'upload-policy', policy: r.policy, reason: limited ? (msg.cellular ? 'cellular' : 'metered') : 'unmetered' })
          }).catch(() => {})
        } catch (err) { fail(err) }
      }
    } else if (msg.feedKey && msg.encryptionKey) {
      ensurePlayer().serveFeed(msg.feedKey, msg.encryptionKey).then((port) => send({ type: 'port', port })).catch(fail)
    } else if (msg.username) {
      // 'streams' is sent by the event relay on success; failures (including the
      // transient 'not connected to panel' while the swarm dials) surface here.
      ensurePlayer().login(msg.username, msg.password).catch((e) => send({ type: 'login-error', message: String((e && e.message) || e) }))
    } else if (msg.streamId) {
      // `type` from the engine rides as `recordType` (the IPC message's own `type` is
      // the envelope discriminant): 'vod' = finished library title (seek/pause UI, no
      // live self-heal events), with durationSec beside it for the transport display.
      ensurePlayer().resolve(msg.streamId).then(({ port, url, source, type, durationSec }) => send({ type: 'port', port, url, source, streamId: msg.streamId, recordType: type, durationSec })).catch(fail)
    } else if (msg.panelPubKey) {
      // The persisted "Smooth zapping" choice (if the user ever set it) wins over the
      // app's compiled zapPrefetch default; true means the SDK's adaptive defaults.
      const saved = readPrefs().smoothZapping
      const zap = saved == null ? msg.zapPrefetch : saved
      const boot = () => ensurePlayer(msg.hybrid, msg.prewarm, msg.tune, zap, msg.swarm, msg.uploadPolicy).connect(msg.panelPubKey).catch(fail)
      if (player && connectedKey && connectedKey !== msg.panelPubKey) {
        // Service switch (S36: a Connect-screen retry after a wrong key, or "Change
        // service…"): the swarm, panel bee and every cached feed belong to the OLD
        // panel, so replace the engine wholesale — full teardown, then a fresh player
        // on the new key. The RN side waits for the fresh {type:'ready'} before it
        // logs in, so nothing races the store while stop() drains.
        const old = player
        player = null
        old.stop().catch(() => {}).then(boot)
      } else {
        boot()
      }
      connectedKey = msg.panelPubKey
    }
  }
})
