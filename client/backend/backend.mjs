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
//   in : { panelPubKey, hybrid?, prewarm?, tune?, zapPrefetch?, swarm?, uploadPolicy?,
//           appVersion?, platform? }
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
//                                        announce, ~zero viewer-to-viewer upload),
//                                        plus appVersion/platform — short labels the
//                                        engine attaches to problem reports (S50c)
//                                        and to nothing else
//        { username, password }       -> OPRF login -> { streams } (display metadata)
//        { streamId }                 -> play an entitled stream -> { port, url, source,
//                                        recordType, durationSec }
//                                        (redirect channels, S23: url is the remote
//                                        https URL, source 'cdn', port undefined —
//                                        the player plays it directly, no localhost)
//        { feedKey, encryptionKey }   -> dev direct-play (no login)
//        { type:'prefs-get' }         -> { type:'prefs', creds, favorites, smoothZapping,
//                                        service, vodList, vodHistory, language }
//        { type:'creds-save', username, password } | { type:'creds-clear' }
//        { type:'service-save', service: { panelPubKey, name? } } | { type:'service-clear' }
//                                        (S36 runtime descriptor: the public keyless app
//                                        persists the operator service entered on its
//                                        Connect screen; baked builds never send these)
//        { type:'pair-resolve', code, tag? }  -> resolve a 12-character SERVICE PAIRING
//                                        CODE to the operator's panel key over the DHT
//                                        (core/pairing.js). Answers 'pair-result'.
//                                        Persists nothing: the Connect screen still has
//                                        to prove the key with a login.
//        { type:'favorites-set', favorites: [streamId] }   (each replies with 'prefs')
//        { type:'vod-list-set', entries }          device-local "My List" (S54a, D9):
//                                        [{kind:'movie'|'series', id}], newest first.
//        { type:'vod-history-set', entries }       device-local watch history (D9):
//                                        [{kind:'movie'|'episode', id, seriesId?, title,
//                                        positionSec, durationSec, at}], newest first.
//                                        Both are WHOLE-ARRAY replacements the worklet
//                                        re-validates and caps (500 / 200) before it
//                                        writes — the RN layer's array is a request, not
//                                        a promise. NOTHING here reaches the panel or
//                                        the provider: this is the device's own record.
//        { type:'reconnect' }         -> tear down the active feed's swarm connections
//                                        and dial fresh (wedged-transport escalation
//                                        from <AliranVideo>'s stall ladder)
//        { type:'zap-prefetch-set', zapPrefetch }  -> runtime "Smooth zapping" toggle:
//                                        boolean or config object, applied mid-play
//        { type:'language-set', language }         -> the viewer's UI-language choice
//                                        (S56e): one of the 14 supported codes, or null
//                                        to clear the override and follow the DEVICE
//                                        language again. Anything else is stored as
//                                        null — an unknown code must never outlive the
//                                        build that wrote it.
//        { type:'net-info', expensive }            -> host network profile (NetInfo):
//                                        expensive=true suspends zap prefetch
//        { type:'update-check', appId, platform, versionCode, tag? }
//                                     -> OTA app-update check against the panel's
//                                        updates drive (meta/updatesKey; lazy,
//                                        client-only join). Answers 'update-status'.
//        { type:'update-download' }   -> download + sha256-verify the update the last
//                                        'available' check found; progress/outcome
//                                        arrive as 'update-progress' / 'update-ready'
//                                        / 'update-error'
//        { type:'report', category, text? }        -> viewer problem report (S50c):
//                                        one of the seven sdk/report.js categories +
//                                        optional free text. The engine attaches the
//                                        active channel, peers, appVersion/platform
//                                        and its recent event breadcrumbs, and proves
//                                        entitlement with the SESSION TOKEN — never a
//                                        username. Always answered, never throws.
//
//   Phone -> TV sign-in handover (sdk/signin-pair.js). SEVEN messages, and every one of
//   them that carries a value carries a LIVE SECRET for the next three minutes: the
//   12-character code, the four compared digits and the four typed digits. Nothing on
//   this path may be logged — the RN binding excludes the whole `signin-` family from
//   its debug logger for exactly that reason.
//        { type:'signin-start', ttlMs?, tag?, …engine opts }
//                                     -> TV role: mint a code, announce its rendezvous
//                                        and wait for a phone. Answers 'signin-started'.
//                                        Carries the SAME engine option fields as the
//                                        {panelPubKey} boot message, because a virgin
//                                        device can start this BEFORE it has a panel —
//                                        the handover is what teaches it one — and the
//                                        engine that comes out of it must still be the
//                                        one this build configured.
//        { type:'signin-submit-pin', pin, tag? }   -> TV role: the four digits the
//                                        viewer typed on the remote. ONE attempt: a
//                                        well-formed submission is final, right or
//                                        wrong. Answers 'signin-ack'.
//        { type:'signin-confirm-service', ok, tag? }  -> TV role: the viewer's answer to
//                                        the 'confirm-service' question (sign in as this
//                                        account, and adopt this operator key).
//                                        Answers 'signin-ack'.
//        { type:'signin-cancel' }     -> TV role: abandon the code on screen. It is
//                                        spent either way — a new one is the only way on.
//        { type:'signin-send', code, tag? }        -> PHONE role: sign a TV in with the
//                                        code it shows. Needs a live session AND a build
//                                        that opted into remote.sendToTv. Answers
//                                        'signin-sending'.
//        { type:'signin-confirm-match', ok, tag? } -> PHONE role: the viewer's answer to
//                                        "does the TV show these same four digits?".
//                                        false ABORTS — it is the only check in the flow
//                                        that sees a relay. Answers 'signin-ack'.
//        { type:'signin-send-cancel' } -> PHONE role: abandon an in-flight send.
//   out: { type:'ready' } | { type:'streams', streams, vod? }   (on login, and pushed
//                                        again live whenever the panel edits the catalog
//                                        — same shape; the Home screen re-renders on it.
//                                        vod (S53) = the panel's external VOD provider
//                                        config { enabled, apiBase, service, sources,
//                                        params }, PRESENT ONLY when the operator
//                                        enabled one. Absent = no VOD section; the
//                                        client calls that provider directly with the
//                                        viewer's own account — the panel never proxies
//                                        it and stores no credential for it. Read at
//                                        login, so an operator change lands on the next
//                                        login/app start)
//        { type:'port', port, url, source, streamId, recordType, durationSec, headers? }
//                                        (url = ACTIVE source under hybrid; streamId
//                                        echoes the play() request so the client can
//                                        tell WHICH channel the shared localhost URL
//                                        now serves — no streamId on the dev
//                                        direct-play reply. recordType/durationSec,
//                                        S8a: the engine's ResolveResult type —
//                                        'vod' = finished library title, show
//                                        seek/pause UI and expect no live self-heal.
//                                        headers: request headers the VIDEO PLAYER must
//                                        send with url — redirect channels whose
//                                        provider hotlink-checks Referer/Origin/
//                                        User-Agent. Absent for every other reply, and
//                                        the later fallback/source-changed URLs are
//                                        never the provider's, so the client clears it
//                                        on those)
//        { type:'status', state|peers } | { type:'login-error'|'error', message }
//        { type:'fallback', streamId, url, reason } | { type:'source-changed', streamId, source, url }
//        { type:'feed-changed', streamId, feedKey, url }   (active stream's feedKey rotated)
//        { type:'zap-prefetch', enabled }          (echo of a runtime toggle) |
//        { type:'zap-prefetch', state:'suspended'|'resumed', reason? }   (adaptive gate)
//        { type:'prefs', creds: {username,password}|null, favorites: [streamId],
//          smoothZapping: true|false|null,   (null = user never set the toggle)
//          service: {panelPubKey,name?}|null,   (runtime-entered operator service)
//          vodList: […], vodHistory: […],   (device-local VOD prefs, S54a — always
//          arrays, empty on a build that never wrote one)
//          language: 'es'|…|null }   (S56e UI language; null = no override, the app
//          follows the device language)
//        { type:'report-result', ok, error?, retryAfter?, id? }   (answer to 'report';
//          error 'unsupported' = the panel predates reports / has them disabled)
//        { type:'update-status', status, entry?, mandatory?, error?, tag? }   (answer
//          to 'update-check'; status 'available' | 'current' | 'none' | 'unknown' —
//          'unknown' = cannot say right now, try again later)
//        { type:'update-progress', received, total }   (throttled download progress)
//        { type:'update-ready', path, entry }   (artifact downloaded + sha256-verified;
//          path is inside the app sandbox — hand it to the installer promptly, the
//          store dir is a disposable cache)
//        { type:'update-error', message }       (download/verify failure)
//        { type:'pair-result', ok, panelPubKey?, name?, code?, error?, message?, tag? }
//          (answer to 'pair-resolve'; error 'malformed' | 'timeout' | 'unverified' —
//          'unverified' means a peer answered and could NOT prove it owns the code)
//        { type:'signin-pair', role, state, … }   (the handover's whole progress stream,
//          relayed 1:1 from the engine — see sdk/player.js for the states and which of
//          them are QUESTIONS the host must answer. Carries `code`, `sas` and `pin`:
//          screen material and live secrets, never log material)
//        { type:'signin-started', ok, code?, expiresAt?, error?, message?, tag? }
//          (answer to 'signin-start'; the code also arrives as {state:'code'})
//        { type:'signin-sending', ok, error?, message?, tag? }   (answer to 'signin-send';
//          ok only means the rendezvous was JOINED — the outcome rides 'signin-pair')
//        { type:'signin-ack', ok, tag? }   (answer to the three one-word answers:
//          submit-pin / confirm-service / confirm-match. ok=false means the engine had
//          nothing waiting for that answer, or the value was malformed)
//
// Prefs (S18): device-local "remember me" credentials (D1 — plaintext at rest inside
// the app-private files dir, the stated tradeoff; sign-out clears them) + favorites
// (D4). Stored BESIDE the corestore, not in it — the store is a disposable cache that
// corruption recovery purges wholesale, and prefs must survive that. Since S50c prefs
// also hold `deviceId`: 8 random bytes minted on first read and never rotated, so the
// panel's device list and per-device revocation address THIS install (before it, every
// install of an account collapsed onto one derived fallback id — see sdk/login.js).

/* global BareKit, Bare */
import './globals.mjs' // FIRST: polyfills TextEncoder/TextDecoder/crypto for the Bare worklet
import http from 'bare-http1'
import fs from 'bare-fs'
import b4a from 'b4a'
import hcrypto from 'hypercore-crypto'
import { AliranPlayer } from '@aliran/player-sdk/player.js'
import { resolvePairingCode } from '@aliran/player-sdk/pairing.js'

const IPC = BareKit.IPC
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

// Last resort: an uncaught exception in the worklet otherwise SIGABRTs the WHOLE app
// process (bare-kit). Surface it over IPC instead; the store-recovery and player
// retry paths handle the aftermath.
if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('uncaughtException', (err) => {
    try { send({ type: 'error', message: 'worklet: ' + String((err && err.message) || err) }) } catch {}
  })
  // A rejected promise nobody awaits is just as fatal as a throw — bare aborts the
  // process unless a listener claims it. Same surface-over-IPC treatment; include the
  // stack because the rejection site is otherwise invisible (no Java trace on Android).
  Bare.on('unhandledRejection', (reason) => {
    try {
      const detail = (reason && reason.stack) || String((reason && reason.message) || reason)
      send({ type: 'error', message: 'worklet: unhandled rejection: ' + detail })
    } catch {}
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

// --- device-local prefs (saved credentials + favorites + the VOD arrays) ---
// Lives next to the store dir (files-dir root on Android, cwd on desktop) so the
// corruption-recovery purge of the store never wipes login or favorites.
function prefsPath () {
  return storeDir().replace(/aliran-store$/, 'aliran-prefs.json')
}

// "My List" and watch history (S54a, design D9) are DEVICE-LOCAL: they never reach the
// panel or the provider. The worklet owns the disk, so it — not the RN layer — decides
// what a valid entry is and how many fit: a setter carries a whole array, and this is
// where that array is re-validated, de-duplicated and capped. Treat every field as
// hostile input; a bad entry is dropped, never written.
const VOD_LIST_MAX = 500
const VOD_HISTORY_MAX = 200
const VOD_ID_MAX = 64
const VOD_TITLE_MAX = 200

function vodStr (v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : '' }
function vodNum (v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0 }

function gateVodList (v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const kind = e.kind === 'movie' || e.kind === 'series' ? e.kind : ''
    const id = vodStr(e.id, VOD_ID_MAX)
    if (!kind || !id || seen.has(kind + '/' + id)) continue
    seen.add(kind + '/' + id)
    out.push({ kind, id })
    if (out.length >= VOD_LIST_MAX) break
  }
  return out
}

function gateVodHistory (v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const kind = e.kind === 'movie' || e.kind === 'episode' ? e.kind : ''
    const id = vodStr(e.id, VOD_ID_MAX)
    if (!kind || !id || seen.has(kind + '/' + id)) continue
    seen.add(kind + '/' + id)
    const seriesId = vodStr(e.seriesId, VOD_ID_MAX)
    out.push({
      kind,
      id,
      ...(seriesId ? { seriesId } : {}),
      title: vodStr(e.title, VOD_TITLE_MAX),
      positionSec: vodNum(e.positionSec),
      durationSec: vodNum(e.durationSec),
      at: vodNum(e.at)
    })
    if (out.length >= VOD_HISTORY_MAX) break
  }
  return out
}

// The UI languages a viewer may pin (S56e). This is a RUNTIME-BOUNDARY DUPLICATE of
// SUPPORTED_LOCALES in i18n/src/index.ts — the Bare worklet cannot import the app's
// TypeScript — so tools/i18n-test.mjs asserts the two lists stay identical. Whitelisted
// on READ as well as on write: the prefs file is plain JSON on the device, and a code
// no build understands must resolve to "no override", never to a blank UI.
const LANGUAGES = ['en', 'es', 'pt', 'fr', 'nl', 'de', 'it', 'ru', 'tr', 'hi', 'ja', 'zh-Hans', 'ko', 'th']

function readPrefs () {
  try {
    const p = JSON.parse(b4a.toString(fs.readFileSync(prefsPath())))
    return {
      creds: p && p.creds && typeof p.creds.username === 'string' && typeof p.creds.password === 'string' ? p.creds : null,
      favorites: Array.isArray(p && p.favorites) ? p.favorites.filter((x) => typeof x === 'string') : [],
      // "Smooth zapping" toggle: null = the user never chose (boot uses the app's
      // compiled default), true/false = their persisted choice wins.
      smoothZapping: typeof (p && p.smoothZapping) === 'boolean' ? p.smoothZapping : null,
      // UI language (S56e): null = the user never picked one, so the app follows the
      // DEVICE language. A pinned code survives restarts and beats device detection.
      language: LANGUAGES.includes(p && p.language) ? p.language : null,
      // Runtime service descriptor (S36): the operator panel key the public keyless
      // app connected to. Builds with a baked key ignore it (baked always wins).
      service: p && p.service && /^[0-9a-f]{64}$/.test(p.service.panelPubKey)
        ? { panelPubKey: p.service.panelPubKey, ...(typeof p.service.name === 'string' ? { name: p.service.name } : {}) }
        : null,
      // Per-install device id (S50c). Absent on prefs written by an older build —
      // ensureDeviceId() mints one on the next boot.
      deviceId: typeof (p && p.deviceId) === 'string' && /^[0-9a-f]{16}$/.test(p.deviceId) ? p.deviceId : null,
      // Device-local VOD prefs (S54a). Re-gated on READ as well as on write: the file
      // is plain JSON on the device, so what comes back is no more trustworthy than
      // what went in, and a corrupt entry must not reach a screen.
      vodList: gateVodList(p && p.vodList),
      vodHistory: gateVodHistory(p && p.vodHistory),
      // Parental controls: PIN digest (salted blake2b — kept worklet-side) + the
      // hide-restricted toggle. A DEVICE policy: sign-out (creds-clear) keeps it.
      parental: p && p.parental && typeof p.parental.salt === 'string' && /^[0-9a-f]{32}$/.test(p.parental.salt) &&
        typeof p.parental.hash === 'string' && /^[0-9a-f]{64}$/.test(p.parental.hash)
        ? { salt: p.parental.salt, hash: p.parental.hash, hide: p.parental.hide === true }
        : null
    }
  } catch {
    return { creds: null, favorites: [], smoothZapping: null, language: null, service: null, deviceId: null, vodList: [], vodHistory: [], parental: null }
  }
}

// Salted PIN digest for the parental gate. blake2b via hypercore-crypto (already in
// the bundle graph). A casual-snooping barrier on the viewer's own device, not a
// security boundary — the 4-8 digit space is trivially brute-forceable by design.
function pinDigest (saltHex, pin) {
  return b4a.toString(hcrypto.hash(b4a.from(saltHex + '|aliran-parental|' + pin)), 'hex')
}

function writePrefs (prefs) {
  try { fs.writeFileSync(prefsPath(), b4a.from(JSON.stringify(prefs))) } catch (err) {
    send({ type: 'error', message: 'prefs write failed: ' + String((err && err.message) || err) })
  }
}

// The deviceId is deliberately NOT in the 'prefs' reply: nothing in the UI needs it,
// and an identifier that never crosses into the RN layer cannot be logged there.
// The parental PIN digest stays worklet-side the same way — the UI only learns
// that a PIN exists and the hide toggle; verification is a message round-trip.
function sendPrefs () {
  const { deviceId, parental, ...rest } = readPrefs()
  send({ type: 'prefs', ...rest, parental: parental ? { hide: parental.hide } : null })
}

// Per-install device id (S50c): 8 random bytes, minted once and persisted. Read on
// every boot rather than cached, so a `pm clear` (which wipes prefs) yields a fresh
// install identity — exactly what a fresh install should look like to the panel.
function ensureDeviceId () {
  const prefs = readPrefs()
  if (prefs.deviceId) return prefs.deviceId
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  const id = b4a.toString(b4a.from(bytes), 'hex')
  writePrefs({ ...prefs, deviceId: id })
  return id
}

let player = null
// The panel key the live player was built for — a later {panelPubKey} message with a
// DIFFERENT key is a service switch (S36) and replaces the engine wholesale.
let connectedKey = null
// The operator/user's CONFIGURED upload policy. The network gate (S25) flips the live
// policy to 'client-only' on cellular/metered and restores THIS on the way back — so a
// deployment that ships uploadPolicy:'client-only' is never silently upgraded to reseed
// by a Wi-Fi event.
let basePolicy = 'reseed'
// The operator key a TV sign-in is in the middle of ADOPTING, held between the
// 'confirm-service' question and 'signed-in'. Without it `connectedKey` would still be
// null after a virgin device adopted a service through the handover, and the next
// {panelPubKey} for that same service would look like a service SWITCH — which replaces
// the engine wholesale and would tear down the session the handover just established.
let adoptingKey = null

function ensurePlayer (hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, appVersion, platform, remote) {
  if (player) return player
  if (uploadPolicy === 'client-only' || uploadPolicy === 'reseed') basePolicy = uploadPolicy
  player = new AliranPlayer({ storeDir: storeDir(), http, fs, hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, remote, deviceId: ensureDeviceId(), appVersion, platform })
  player.on('ready', () => send({ type: 'ready' }))
  // `vod` (S53) rides the streams message only when the panel enabled a provider —
  // the field is absent otherwise, so the UI's "no VOD section" is the default.
  player.on('streams', (streams, vod) => send({ type: 'streams', streams, ...(vod ? { vod } : {}) }))
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
  // OTA app updates: download progress/outcome relay 1:1 (the check reply is sent by
  // its own dispatch case — it needs the request's tag).
  player.on('update-progress', (e) => send({ type: 'update-progress', ...e }))
  player.on('update-ready', (e) => send({ type: 'update-ready', ...e }))
  player.on('update-error', (e) => send({ type: 'update-error', ...e }))
  // Phone -> TV sign-in: the whole progress stream, relayed 1:1. Three of its states are
  // QUESTIONS and the exchange BLOCKS on each until the screens answer, so nothing here
  // may filter, batch or reorder — a dropped 'match' is a viewer waiting for ever.
  // Nothing is logged on this path either: `code`, `sas` and `pin` are live secrets.
  player.on('signin-pair', (e) => {
    if (e && e.state === 'confirm-service' && e.adopting === true && /^[0-9a-f]{64}$/.test(String(e.panelPubKey || ''))) {
      adoptingKey = String(e.panelPubKey)
    }
    if (e && e.state === 'signed-in' && adoptingKey) { connectedKey = adoptingKey; adoptingKey = null }
    if (e && e.state === 'failed') adoptingKey = null
    send({ type: 'signin-pair', ...e })
  })
  // Background engine failures with no caller to throw to — most importantly the tune
  // watchdog's timeout. Dropping these left the app spinning forever on a dead tune.
  player.on('error', (err) => send({ type: 'error', message: String((err && err.message) || err) }))
  return player
}

// The engine an IPC message asks for, built from the option fields that message carries.
// TWO messages carry them: the {panelPubKey} boot and 'signin-start' — a TV that has
// never been paired starts a sign-in with no panel at all, and the engine the handover
// leaves behind has to be the one this build configured, not a bare default.
// The persisted "Smooth zapping" choice (if the user ever set one) wins over the app's
// compiled default in both.
function playerFor (msg) {
  const saved = readPrefs().smoothZapping
  const zap = saved == null ? msg.zapPrefetch : saved
  return ensurePlayer(msg.hybrid, msg.prewarm, msg.tune, zap, msg.swarm, msg.uploadPolicy, msg.appVersion, msg.platform, msg.remote)
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
    } else if (msg.type === 'parental-set-pin' && typeof msg.pin === 'string' && /^\d{4,8}$/.test(msg.pin)) {
      // Create/replace the PIN (the UI verifies the old one first when changing).
      const salt = b4a.toString(hcrypto.randomBytes(16), 'hex')
      const prev = readPrefs()
      writePrefs({ ...prev, parental: { salt, hash: pinDigest(salt, msg.pin), hide: prev.parental ? prev.parental.hide : false } })
      sendPrefs()
    } else if (msg.type === 'parental-clear') {
      writePrefs({ ...readPrefs(), parental: null })
      sendPrefs()
    } else if (msg.type === 'parental-hide-set' && typeof msg.hide === 'boolean') {
      const prev = readPrefs()
      if (prev.parental) writePrefs({ ...prev, parental: { ...prev.parental, hide: msg.hide } })
      sendPrefs()
    } else if (msg.type === 'pair-resolve' && typeof msg.code === 'string') {
      // Service pairing code → the operator's panel key. Runs on its OWN swarm and
      // touches neither the player nor the prefs: the Connect screen persists the
      // service only after the key it gets back also logs in. The SDK verifies the
      // answer by re-deriving the code, so a rejected pairing surfaces here as an
      // ordinary failure rather than a key the app would go on to trust.
      resolvePairingCode(msg.code)
        .then((s) => send({ type: 'pair-result', ok: true, panelPubKey: s.panelPubKey, name: s.name, code: s.code, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) }))
        .catch((err) => send({ type: 'pair-result', ok: false, error: err.code || 'failed', message: String((err && err.message) || err), ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) }))
    } else if (msg.type === 'signin-start') {
      // TV role. Answered ALWAYS: the screen is showing a spinner where the code goes,
      // and the two ways this can fail — a second press while the first code is still
      // being minted (~70 ms of Argon2id), and a stopped engine — both have to reach it.
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      let p = null
      try { p = playerFor(msg) } catch (err) {
        send({ type: 'signin-started', ok: false, message: String((err && err.message) || err), ...tag })
      }
      if (p) {
        p.startSignInPairing({ ttlMs: msg.ttlMs })
          .then((s) => send({ type: 'signin-started', ok: true, code: s.code, expiresAt: s.expiresAt, ...tag }))
          .catch((err) => send({ type: 'signin-started', ok: false, ...(err && err.code ? { error: err.code } : {}), message: String((err && err.message) || err), ...tag }))
      }
    } else if (msg.type === 'signin-submit-pin') {
      // TV role. ONE attempt by construction (sdk/signin-pair.js): a well-formed
      // submission is the only answer this handover ever sends, right or wrong. ok=false
      // is the SAFE outcome — malformed, or nothing waiting — and costs the viewer
      // nothing, so the screen may validate as the digits are typed.
      send({ type: 'signin-ack', ok: !!player && typeof msg.pin === 'string' && player.submitSignInPin(msg.pin) === true, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
    } else if (msg.type === 'signin-confirm-service') {
      // TV role. Anything but an explicit true refuses — and refusing changes nothing.
      send({ type: 'signin-ack', ok: !!player && player.confirmSignInService(msg.ok === true) === true, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
    } else if (msg.type === 'signin-cancel') {
      if (player) { try { player.cancelSignInPairing() } catch (err) { fail(err) } }
    } else if (msg.type === 'signin-send') {
      // PHONE role. ok only says the rendezvous was joined; the outcome rides the
      // 'signin-pair' stream. The rejections are all worth showing a viewer by name:
      // a malformed code, no session on this device, or a build that never opted into
      // remote.sendToTv (which cannot be fixed at runtime — the key material a send
      // needs was dropped at login time).
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      if (!player) {
        send({ type: 'signin-sending', ok: false, message: 'sign in on this device first', ...tag })
      } else {
        player.sendSignIn(typeof msg.code === 'string' ? msg.code : '')
          .then(() => send({ type: 'signin-sending', ok: true, ...tag }))
          .catch((err) => send({ type: 'signin-sending', ok: false, ...(err && err.code ? { error: err.code } : {}), message: String((err && err.message) || err), ...tag }))
      }
    } else if (msg.type === 'signin-confirm-match') {
      // PHONE role, and the single most important answer in the feature: false is what
      // stops a relay. It is never defaulted and never inferred here — only an explicit
      // true proceeds.
      send({ type: 'signin-ack', ok: !!player && player.confirmSignInMatch(msg.ok === true) === true, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
    } else if (msg.type === 'signin-send-cancel') {
      if (player) { try { player.cancelSendSignIn() } catch (err) { fail(err) } }
    } else if (msg.type === 'parental-verify' && typeof msg.pin === 'string') {
      const rec = readPrefs().parental
      send({ type: 'parental-verify', ok: !!rec && pinDigest(rec.salt, msg.pin) === rec.hash, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
    } else if (msg.type === 'vod-list-set' && Array.isArray(msg.entries)) {
      // Device-local "My List" (S54a, D9): whole-array replace, gated + capped HERE.
      writePrefs({ ...readPrefs(), vodList: gateVodList(msg.entries) })
      sendPrefs()
    } else if (msg.type === 'vod-history-set' && Array.isArray(msg.entries)) {
      // Device-local watch history (S54a, D9): same contract. The players write this
      // every few seconds, so it stays a plain whole-array replace — no merge logic on
      // the disk side to get wrong.
      writePrefs({ ...readPrefs(), vodHistory: gateVodHistory(msg.entries) })
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
    } else if (msg.type === 'language-set') {
      // The viewer's UI language (S56e). Persist-only: nothing in the engine is
      // localized, so this never touches the player. A null/absent/unknown code clears
      // the override, which is what "Device language" sends.
      writePrefs({ ...readPrefs(), language: LANGUAGES.includes(msg.language) ? msg.language : null })
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
    } else if (msg.type === 'update-check') {
      // OTA update check. A UI awaiting 'update-status' must never hang on a dead
      // engine, and only bad arguments make checkUpdate() throw — map both to the
      // honest "cannot say right now" verdict rather than an error dialog.
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      if (!player) {
        send({ type: 'update-status', status: 'unknown', ...tag })
      } else {
        player.checkUpdate({ appId: msg.appId, platform: msg.platform, versionCode: msg.versionCode })
          .then((res) => send({ type: 'update-status', ...res, ...tag }))
          .catch((err) => send({ type: 'update-status', status: 'unknown', error: String((err && err.message) || err), ...tag }))
      }
    } else if (msg.type === 'update-download') {
      // Progress/outcome ride the event relays; the rejection carries the same error
      // 'update-error' already delivered, so it is swallowed here (never doubled).
      if (!player) send({ type: 'update-error', message: 'engine not started' })
      else { try { player.downloadUpdate().catch(() => {}) } catch (err) { fail(err) } }
    } else if (msg.type === 'report') {
      // Viewer problem report (S50c). player.report() never throws and never rejects,
      // so this branch always answers — a UI waiting on 'report-result' must not be
      // left hanging by a dead engine either, hence the no-player reply.
      if (!player) {
        send({ type: 'report-result', ok: false, error: 'offline' })
      } else {
        player.report({ category: msg.category, text: msg.text }).then((res) => {
          send({ type: 'report-result', ok: res.ok === true, ...(res.error ? { error: res.error } : {}), ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}), ...(res.id ? { id: res.id } : {}) })
        }).catch((err) => send({ type: 'report-result', ok: false, error: String((err && err.message) || err) }))
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
      // `headers` rides through untouched (undefined on everything but a hotlink-checked
      // redirect channel) — the video player, not the engine, is what sends them.
      ensurePlayer().resolve(msg.streamId).then(({ port, url, source, type, durationSec, headers }) => send({ type: 'port', port, url, source, streamId: msg.streamId, recordType: type, durationSec, headers })).catch(fail)
    } else if (msg.panelPubKey) {
      const boot = () => playerFor(msg).connect(msg.panelPubKey).catch(fail)
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
