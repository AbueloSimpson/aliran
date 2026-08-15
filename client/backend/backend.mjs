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
//        { type:'signin-resume', tag?, …engine opts }
//                                     -> TV role, ON A LATER BOOT: sign back in with the
//                                        handover this device KEPT (see "The sign-in
//                                        vault" at the foot of this block). Carries the
//                                        same engine option fields as the {panelPubKey}
//                                        boot, because the stored record names its own
//                                        operator and a resume may be what builds the
//                                        engine. Answers 'signin-resumed'.
//   "Send to TV", the PLAYBACK half (sdk/player.js startCast + sdk/remote-control.js).
//   Two ways to put this device's channel on a television, and they are not the same
//   thing: a CAST makes this device the origin server for a Chromecast, and a HANDOFF
//   asks another Aliran device on this account to pull the channel itself.
//        { type:'cast-start', streamId, receiverHost?, advertiseHost?, tag? }
//                                     -> stand up the LAN cast server and answer
//                                        'cast-started' with the session (url, host,
//                                        port, token, candidates). receiverHost = the
//                                        receiver's address, or an array of them: the
//                                        session then serves that peer ONLY. The host
//                                        is the only layer that knows it (the engine
//                                        does not speak Cast), so it is passed in here.
//        { type:'cast-stop', tag? }   -> end it. Answers 'cast-stopped'.
//        { type:'remote-start', role, label?, acceptPlay?, tag? }
//                                     -> join the account rendezvous ('tv' announces and
//                                        accepts, 'controller' looks up and sends).
//                                        Answers 'remote-started', then pushes the peer
//                                        list as it stands. acceptPlay OMITTED takes the
//                                        PERSISTED preference, which is the whole point of
//                                        persisting it: the set is announced and taking
//                                        commands from the moment the join lands, so the
//                                        preference has to be IN the join, never a
//                                        'remote-accept' sent after it.
//        { type:'remote-list', tag? } -> the cached peer list, as 'remote-peers'.
//        { type:'remote-cmd', cmd:'play'|'stop', deviceId, streamId?, tag? }
//                                     -> controller role: ask that television to play a
//                                        channel, or to stop. Answers 'remote-ack'.
//        { type:'remote-accept', ok } -> TV role: take commands at all, or refuse them.
//                                        PERSISTED, beside the parental PIN: a switch that
//                                        forgot itself at the next boot would be a
//                                        mitigation that lies about itself. Read back by
//                                        'remote-start' (below) as the acceptPlay default.
//        { type:'remote-status', state?, position? }   -> TV role: the two things only a
//                                        host knows (paused, and the playhead).
//        { type:'remote-leave' }      -> leave the rendezvous.
//        { type:'vault-reply', id, ok, data?, code? }  -> the host's answer to a
//                                        'vault-request' (below). `data` is base64 on ok;
//                                        `code` is the key store's reason on failure, and
//                                        it is load-bearing: only 'locked'/'bad-blob' are
//                                        evidence that a stored sign-in is unreadable and
//                                        may be erased.
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
//        { type:'signin-resumed', ok, error?, message?, retry?, logins, tag? }   (answer
//          to 'signin-resume'. retry=true — 'offline' — is the ONLY value that means the
//          material is still stored; every other error already erased it. `logins` is what
//          the attempt COST: how many `login` RPCs reached the panel, which is the only
//          number a caller can budget a retry loop with — see resumeSignIn)
//        { type:'cast-started', ok, session?, error?, message?, tag? }   (answer to
//          'cast-start'. THE WHOLE `cast-` FAMILY IS EXCLUDED FROM THE RN DEBUG LOGGER
//          BY PREFIX: `session.url` carries the session token, and this app ships
//          debug:true in release builds, so without that exclusion the token would be
//          printed into `adb logcat`. Excluded as a family, not one message at a time,
//          so a message added later is excluded by default)
//        { type:'cast-stopped', ok, tag? }
//        { type:'cast-ended', state:'ended', streamId, reason }   (the session ended ON
//          ITS OWN — the feed was evicted or a retune closed it. stopCast() does NOT
//          produce this: the caller that asked already knows)
//        { type:'remote-peers', peers }   (the account's own other devices on the
//          rendezvous; re-sent on every change. `role` says which are televisions —
//          a 'play' to anything else is refused 'unknown')
//        { type:'remote-started', ok, role?, error?, message?, tag? }
//        { type:'remote-ack', ok, error?, message?, tag? }   (answer to 'remote-cmd';
//          error is a RemoteControlErrorCode — 'timeout' NEVER means the device
//          declined, and 'unavailable' is the catch-all, never "nothing is broadcasting")
//        { type:'remote-info', role, state, … }   (a command this TV was given, or the
//          status of a television a controller is pointed at. {state:'play'} is a
//          COMMAND: the engine checked entitlements and deliberately did NOT tune it,
//          so the host still owes a `restricted` channel its parental-PIN gate)
//        { type:'vault-request', op:'wrap'|'unwrap', id, data }   (NOT an event: the
//          worklet asking the HOST to use the platform key store on its behalf, because
//          a Bare runtime cannot reach a native module. `data` is base64 and is the one
//          secret on this channel — the host must keep it out of its logger. The answer
//          comes back as 'vault-reply')
//
// Prefs (S18): device-local "remember me" credentials (D1 — plaintext at rest inside
// the app-private files dir, the stated tradeoff; sign-out clears them) + favorites
// (D4). Stored BESIDE the corestore, not in it — the store is a disposable cache that
// corruption recovery purges wholesale, and prefs must survive that. Since S50c prefs
// also hold `deviceId`: 8 random bytes minted on first read and never rotated, so the
// panel's device list and per-device revocation address THIS install (before it, every
// install of an account collapsed onto one derived fallback id — see sdk/login.js).
//
// THE SIGN-IN VAULT (phone -> TV sign-in, at rest).
//
// A television signed in by a phone has NO CREDENTIALS to remember: what crossed was key
// material, and sdk/login.js is explicit that it must not be written down. That left a
// handover-signed-in set worse off than a password-signed-in one — Android reclaims
// background app processes as a matter of routine, and the next cold start landed back on
// the sign-in screen with the phone in another room. So the material IS kept now, and the
// shape of the keeping is the whole point:
//
//   1. The engine emits it once, as 'signin-keys', and ONLY on a build that asked for it
//      (remote.keepSignIn — client/src/worklet.ts turns it on for televisions and for
//      nothing else).
//   2. This worklet mints 32 random bytes, seals the record under them (signin-vault.mjs)
//      and writes the sealed box into the prefs file beside everything else.
//   3. The 32 bytes go OUT, as a 'vault-request', to be wrapped by a key held in the
//      Android Keystore — hardware-held on any device with a keymaster, and unreadable by
//      this app or any other. The wrapped result comes back and is stored beside the box.
//
// The account's two private keys therefore stay in THIS runtime's heap, and the only secret
// that crosses the IPC boundary is a file key that is inert without a file the other side
// never sees. Compare the "remember me" password three paragraphs up, which is plaintext
// on the same disk: this is the first thing in the app that is not.
//
// (That is a claim about one wire, not about a sandbox — Bare runs on a thread inside the
// app's own process, sharing its UID and its files. What it buys is that the keys never
// enter the RN message stream, and so never the debug logger, a host listener, a screen's
// state or a problem report. See signin-vault.mjs, which says the same thing at length.)
//
// TWO OUTCOMES, NOT ONE, AND THE DIFFERENCE IS THE WHOLE DESIGN. A failure that PROVES the
// material is dead — a key store that says these bytes will never open again, a box that
// fails its MAC, an operator this device is no longer on, a panel that refuses the account
// — erases and shows the sign-in screen. Everything else (a key store that did not answer,
// a swarm still dialling, a record that has not replicated yet) KEEPS what is held and asks
// again, because erasing is the only irreversible act here and its cost is a viewer walking
// to another room for a phone. There is no half-signed-in state in either direction. See
// docs/security-model.md, "Account keys at rest", for what the Keystore does and does not
// buy on a television.

/* global BareKit, Bare */
import './globals.mjs' // FIRST: polyfills TextEncoder/TextDecoder/crypto for the Bare worklet
import http from 'bare-http1'
import fs from 'bare-fs'
// The engine reads os.networkInterfaces() only for startCast() — the LAN address a TV
// receiver must dial. bare-os is an ADDON (prebuilds), unlike the pure-JS shims above, so
// it is declared in backend/package.json rather than left to hoisting luck.
import os from 'bare-os'
import b4a from 'b4a'
import hcrypto from 'hypercore-crypto'
import { AliranPlayer } from '@aliran/player-sdk/player.js'
import { resolvePairingCode } from '@aliran/player-sdk/pairing.js'
// The at-rest half of a phone -> TV sign-in: the record format, its shape gates, and the
// one judgement that decides whether a refusal is worth retrying or means erase. Kept in
// its own file because it is pure — no fs, no IPC — and therefore testable off a
// television (tools/signin-vault-test.mjs).
import {
  SIGNIN_VAULT_VERSION, FILE_KEY_BYTES,
  gateSignInKeys, gateVaultRecord, sealSignIn, openSignIn,
  terminalSignInError, accountNotReplicatedYet
} from './signin-vault.mjs'
// The cached warm start's pure half: gate rules, URL re-porting, terminal judgement.
// This file owns only the disk and the emit (see "cached warm start" below).
import {
  CATALOG_CACHE_VERSION,
  gateCatalogCache, warmStartAllowed, rewriteOrigins, terminalCatalogError
} from './catalog-cache.mjs'

const IPC = BareKit.IPC
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

// Boot trace (diagnosis): one line the moment the worklet's module graph is up, so plain
// logcat (app-stdout tag) can attribute the gap between process start and engine work —
// bundle decode + Bare boot land BEFORE this line, everything the engine does after it.
try { console.log('[boot-trace] worklet-up') } catch {}

// The engine's boot marks (sdk/player.js bootTrace), printed with offsets in ms since
// the first mark. Once on the first successful login per engine (the WeakSet), and on
// any login failure that got PAST the dial gate — 'not connected to panel' repeats every
// 2.5 s while the swarm dials and would bury logcat with identical dumps.
const bootTraceLogged = new WeakSet()
// Engines whose REAL login has emitted streams — after that, a provisional (cached)
// emit must never overwrite the live lineup. WeakSet like the trace latch above, and for
// the same reason: a service switch replaces the engine and the latch must die with it.
const streamsSeen = new WeakSet()
function logBootTrace (p, label) {
  try {
    const marks = p.bootTrace()
    if (!marks.length) return
    const t0 = marks[0].t
    console.log('[boot-trace]', label, JSON.stringify(marks.map((m) => ({ ...m, t: m.t - t0 }))))
  } catch {}
}

// Unref'd throughout: a pending wait must never be the reason a worklet stays alive.
function sleep (ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

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
        : null,
      // "Play on my TV", the per-set take-over switch. A DEVICE policy like the parental
      // PIN beside it: sign-out keeps it, because the set it protects is the same set
      // whoever signs in next will be sitting in front of. null = the viewer never chose,
      // so the join's own default (accept) applies — the smoothZapping shape, and for the
      // same reason: "never chose" and "chose the default" must stay tellable apart.
      remoteAccept: typeof (p && p.remoteAccept) === 'boolean' ? p.remoteAccept : null,
      // The kept phone -> TV sign-in: a sealed box plus the wrapped file key that opens
      // it (see "The sign-in vault" in the header). Gated on read like everything else
      // here — a half-written record must read as "nothing is saved", because the
      // alternative is a television that fails a resume it should never have attempted.
      // NEVER leaves this function's callers: sendPrefs() strips it.
      signin: gateVaultRecord(p && p.signin)
    }
  } catch {
    return { creds: null, favorites: [], smoothZapping: null, language: null, service: null, deviceId: null, vodList: [], vodHistory: [], parental: null, remoteAccept: null, signin: null }
  }
}

// Salted PIN digest for the parental gate. blake2b via hypercore-crypto (already in
// the bundle graph). A casual-snooping barrier on the viewer's own device, not a
// security boundary — the 4-8 digit space is trivially brute-forceable by design.
function pinDigest (saltHex, pin) {
  return b4a.toString(hcrypto.hash(b4a.from(saltHex + '|aliran-parental|' + pin)), 'hex')
}

/**
 * Replace the prefs file, crash-safely: a sibling temp file, then a rename over the target.
 *
 * A plain writeFileSync onto the live path is destructive from its first byte — the file is
 * truncated, THEN refilled — and this one file holds everything a device needs to be
 * itself: the saved password, the device id (which is the panel's handle on this install),
 * favorites, the parental PIN digest, the VOD arrays, and now the sealed sign-in. Anything
 * that stops the process in that window loses all of them together, and a television is a
 * device that gets its power cut rather than shut down.
 *
 * NOT @aliran/core/atomic-write.js, which is exactly this recipe and is where it belongs.
 * That module imports node's `fs`; bare-pack resolves `fs` to `builtin:fs`, and the
 * react-native-bare-kit worklet runtime carries no builtins table, so loading it SIGABRTs
 * the whole app process (see client/backend/bare-builtins.cjs, which says so). What is
 * repeated here is the recipe against bare-fs, and MINUS ONE STEP: that module also fsyncs
 * the DIRECTORY after the rename. Its own header calls that part non-portable, and the
 * temp-file fsync above is what prevents a torn file — so what is given up is the rename's
 * own durability, whose worst case is a box that loses power coming back with the PREVIOUS
 * prefs whole rather than the new ones. A stale file, not a broken one.
 *
 * @returns {boolean} true when the new contents are on disk. The answer is not decoration:
 *   forgetSignIn() is an ERASE, and an erase that silently did not happen is the one
 *   failure in this file a caller must never report as success.
 */
function writePrefs (prefs) {
  return writeJsonFileAtomic(prefsPath(), prefs)
}

// The recipe documented above, generalized: prefs and the catalog cache share it, so
// there is exactly one place the tmp+fsync+rename dance can rot. The error line names
// the file — the two callers' failures mean different things to a viewer.
function writeJsonFileAtomic (file, obj) {
  const tmp = file + '.tmp'
  let fd = null
  try {
    const data = b4a.from(JSON.stringify(obj))
    // 0600 from creation, and carried onto the live path by the rename: these files hold a
    // plaintext password / a sealed account record, and open()'s mode applies only to a
    // file it CREATES, so a stale temp from an earlier crash must not donate a looser one.
    fd = fs.openSync(tmp, 'w', 0o600)
    for (let len = 0; len < data.byteLength;) len += fs.writeSync(fd, len ? data.subarray(len) : data)
    // Ordering is the rename's job; DURABILITY is this. Without it a box that loses power
    // can come back with the renamed file and unwritten blocks — the zero-filled prefs this
    // whole function exists to prevent. Best-effort: a platform that refuses still leaves
    // the previous file whole.
    try { fs.fsyncSync(fd) } catch {}
    fs.closeSync(fd); fd = null
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {} // a failed write leaves no litter
    send({ type: 'error', message: file.replace(/^.*\//, '') + ' write failed: ' + String((err && err.message) || err) })
    return false
  }
}

// The deviceId is deliberately NOT in the 'prefs' reply: nothing in the UI needs it,
// and an identifier that never crosses into the RN layer cannot be logged there.
// The parental PIN digest stays worklet-side the same way — the UI only learns
// that a PIN exists and the hide toggle; verification is a message round-trip.
//
// The sign-in vault record is the third, and the strictest: the app is told only WHETHER
// there is one, as a boolean. A screen needs nothing else to decide between resuming and
// showing the sign-in screen, and a record that never crosses cannot be logged, cached in
// a component or serialized into a problem report by some later change.
function sendPrefs () {
  const { deviceId, parental, signin, ...rest } = readPrefs()
  send({ type: 'prefs', ...rest, parental: parental ? { hide: parental.hide } : null, signinSaved: !!signin })
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

// --- cached warm start (the catalog cache) ---------------------------------------------
// The last session's display list, snapshotted so the NEXT boot can paint the menu in its
// first second while the real login dials behind it. Display metadata ONLY — the gate in
// catalog-cache.mjs whitelists the fields on write AND read, so no key can ever ride
// along. A SIBLING of the prefs file, deliberately not a prefs field: every prefs setter
// rewrites that whole file (a favorites toggle would become a half-megabyte fsync'd
// rewrite over a 1400-channel lineup), and a torn catalog write must never be able to
// cost the device its password, deviceId or vault record. Outside aliran-store like
// prefs, so a corruption purge keeps it.
function catalogCachePath () {
  return storeDir().replace(/aliran-store$/, 'aliran-catalog.json')
}

function readCatalogCache () {
  try { return gateCatalogCache(JSON.parse(b4a.toString(fs.readFileSync(catalogCachePath())))) } catch { return null }
}

function deleteCatalogCache () {
  try { fs.unlinkSync(catalogCachePath()) } catch {} // ENOENT included — gone is gone
}

// --- the remembered panel peer -----------------------------------------------------------
// The swarm public key of the peer that last PROVED it is the panel — the engine's
// 'panel-peer' event — persisted so the NEXT boot can hand it back as `panelPeer`, the
// engine's rescue dial for a boot whose panel-topic lookup delivers no socket (stale DHT
// records after a panel restart; see sdk/player.js normalizePanelPeer for the whole
// story, including why the dial is delayed rather than racing the lookup).
// A SIBLING of the prefs file like the catalog cache, and for the same two reasons: every
// prefs setter rewrites its whole file, and this must survive a corruption purge — a purge
// rmSyncs aliran-store wholesale and changes nothing about where the panel lives, so
// throwing the address away with it would tax exactly the boot that follows a recovery.
// SCOPED to the panel it validated against: the read side refuses a record stamped with a
// different panelPubKey, so a service switch cannot leak one operator's peer address into
// another operator's boot. Never an identity claim — the engine re-runs the hello probe
// on whatever the dial lands, so the worst a stale, torn or hand-edited value can do is
// one useless dial racing a lookup that proceeds anyway.
function panelPeerPath () {
  return storeDir().replace(/aliran-store$/, 'aliran-panel-peer.json')
}

function readPanelPeer (panelPubKey) {
  if (!panelPubKey) return undefined // keyless boot / dev direct-play — no panel to dial yet
  try {
    const rec = JSON.parse(b4a.toString(fs.readFileSync(panelPeerPath())))
    if (rec && rec.panelPubKey === panelPubKey && /^[0-9a-f]{64}$/.test(String(rec.peerKey))) return rec.peerKey
  } catch { /* absent or torn — this boot pays the topic lookup, nothing more */ }
  return undefined
}

function writePanelPeer (panelPubKey, peerKey) {
  writeJsonFileAtomic(panelPeerPath(), { v: 1, panelPubKey, peerKey })
}

function deletePanelPeer () {
  try { fs.unlinkSync(panelPeerPath()) } catch {} // ENOENT included — gone is gone
}

// --- the cached DHT nodes ---------------------------------------------------------------
// The engine's last routing-table snapshot (its 'dht-nodes' event) — {host, port} records
// of DHT nodes that answered recently — persisted so the NEXT boot can hand them back as
// swarm.nodes and bootstrap from them instead of resolving and round-tripping the public
// bootstrap servers (the measured 4-5 s 'swarm-ready' wall; see normalizeSwarmOpts in
// sdk/player.js for the whole story, including why a stale or all-dead list only costs a
// fallback to the normal bootstrap). A SIBLING of the prefs file like the panel peer, and
// for the same two reasons: every prefs setter rewrites its whole file, and this must
// survive a corruption purge — a purge rmSyncs aliran-store wholesale and changes nothing
// about which DHT nodes are alive. SCOPED to the DHT it was learned on: the record stamps
// the session's custom bootstrap config (null = the public DHT), and the read side
// refuses a record from a different one, so a testnet's nodes cannot leak into a
// production boot or vice versa. UNLIKE the panel peer it survives sign-out and service
// switches — these are public DHT infrastructure addresses, not a record of where this
// device belonged. Never trusted: DHT nodes are address hints, and everything learned
// through them is verified end-to-end (panel-signed records), so the worst a torn or
// hand-edited file can do is slow one boot's bootstrap down.
function dhtNodesPath () {
  return storeDir().replace(/aliran-store$/, 'aliran-dht-nodes.json')
}

// One JSON shape both sides compare — undefined and null both mean "the public DHT".
function dhtBootstrapStamp (bootstrap) {
  return JSON.stringify(bootstrap ?? null)
}

function readDhtNodes (bootstrap) {
  try {
    const rec = JSON.parse(b4a.toString(fs.readFileSync(dhtNodesPath())))
    if (!rec || rec.v !== 1 || !Array.isArray(rec.nodes)) return undefined
    if (dhtBootstrapStamp(rec.bootstrap) !== dhtBootstrapStamp(bootstrap)) return undefined
    const nodes = []
    for (const n of rec.nodes.slice(0, 32)) {
      // One malformed entry poisons the whole record (return, not skip): the file has
      // exactly one writer, so a bad entry means a torn/foreign file, not a bad node.
      if (!n || typeof n.host !== 'string' || !n.host || !Number.isInteger(n.port) || n.port < 1 || n.port > 65535) return undefined
      nodes.push({ host: n.host, port: n.port })
    }
    if (nodes.length) return nodes
  } catch { /* absent or torn — this boot pays the public bootstrap, nothing more */ }
  return undefined
}

function writeDhtNodes (bootstrap, nodes) {
  writeJsonFileAtomic(dhtNodesPath(), { v: 1, bootstrap: bootstrap ?? null, nodes })
}

// The account name the CURRENT session belongs to — what the cache write stamps, and
// what the read-side gate compares against the saved credentials. Set where the worklet
// learns it (the password dispatch, a resume's opened record, a received handover),
// cleared where the account goes (sign-out, service change). Set at ATTEMPT time, not on
// success, because the engine's 'streams' emit is synchronous with the login resolving —
// a success-time setter would run after the relay already snapshotted.
let lastLoginUsername = null

// Debounced + deferred write, LATEST WINS. Deferred well past the engine's own post-login
// stagger so this write joins the idle tail of a boot, not the pile that used to park IPC
// for 40 measured seconds; debounced because live catalog pushes re-emit the whole list
// on every change. The unref keeps a pending write from holding a worklet open; losing
// one (app killed inside the window) costs a boot's warm start, nothing more.
const CATALOG_CACHE_WRITE_DELAY_MS = 15000
let catalogWriteTimer = null
let catalogWritePending = null

function scheduleCatalogCacheWrite (streams, vod) {
  if (!lastLoginUsername || !connectedKey) return // dev direct-play / keyless boot — nothing to stamp
  if (!Array.isArray(streams) || !streams.length) return
  catalogWritePending = { streams, vod: vod ?? null, username: lastLoginUsername, panelPubKey: connectedKey }
  if (catalogWriteTimer) return // a timer is already running — it will write the snapshot above
  catalogWriteTimer = setTimeout(() => {
    catalogWriteTimer = null
    const p = catalogWritePending
    catalogWritePending = null
    if (!p) return
    // The loopback port the entry URLs were minted for, recovered from guideBase —
    // _display() sets it unconditionally. No match = a shape this file does not
    // understand; write nothing rather than a cache that re-ports wrongly next boot.
    const first = p.streams[0]
    const m = first && typeof first.guideBase === 'string' && first.guideBase.match(/^http:\/\/127\.0\.0\.1:(\d+)\//)
    if (!m) return
    const gated = gateCatalogCache({ v: CATALOG_CACHE_VERSION, panelPubKey: p.panelPubKey, username: p.username, savedAt: Date.now(), port: Number(m[1]), vod: p.vod, streams: p.streams })
    if (gated) writeJsonFileAtomic(catalogCachePath(), gated)
  }, CATALOG_CACHE_WRITE_DELAY_MS)
  if (typeof catalogWriteTimer.unref === 'function') catalogWriteTimer.unref()
}

// --- the sign-in vault (see "The sign-in vault" in the header) -------------------------

// A Bare worklet has no bridge to a native module, so the Android Keystore is reachable
// only through the HOST. These lines are that round trip: a request goes out, a reply comes
// back against its id, and a reply that never comes settles on its own rather than leaving
// a television blocked on a screen for ever.
//
// AN ANSWER IS ALWAYS { ok, data?, code? }, never a bare null. The read side's response to
// "this cannot be unwrapped" is to erase the account this device is holding, and only two
// of the key store's codes are evidence that erasing is right — so "the host said no" and
// "the host did not answer" must be different values here, or a busy RN thread at boot
// destroys a credential (see RETRYABLE below).
const vaultPending = new Map()
let vaultSeq = 0
// Generous for a key-store call (they are milliseconds) because the cost of being wrong
// is asymmetric: too short strands a device that would have succeeded, too long delays a
// splash screen that is already spinning.
const VAULT_REPLY_MS = 10000
// The host did not answer inside VAULT_REPLY_MS. Not a key-store verdict — the RN thread
// is at its busiest at exactly the moment a resume runs — so it can never erase.
const VAULT_NO_ANSWER = 'no-answer'
// Key-store failures that say nothing about whether the sealed bytes are still good:
// no module here, a store that would not open, an unrecognised code, and the silence
// above. Everything else ('locked', 'bad-blob') is proof the box will never open again.
const VAULT_RETRYABLE = new Set([VAULT_NO_ANSWER, 'absent', 'unavailable', 'unknown'])

function vaultCall (op, data) {
  return new Promise((resolve) => {
    const id = 'v' + (++vaultSeq)
    const timer = setTimeout(() => {
      if (vaultPending.delete(id)) resolve({ ok: false, code: VAULT_NO_ANSWER })
    }, VAULT_REPLY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    vaultPending.set(id, (v) => { clearTimeout(timer); resolve(v) })
    send({ type: 'vault-request', op, id, data })
  })
}

// Erase the kept sign-in. Called on sign-out, on leaving the operator it belongs to, and on
// every failure that PROVES the record is dead — a written record that cannot produce a
// session is not a convenience any more, only key material sitting on a disk.
//
// Answers whether the erase actually landed. It used to answer nothing, over a writePrefs
// that swallowed its own failure, so every caller — including the one that runs after an
// operator revokes an account — reported success while the record was possibly still there.
// A failed erase is the loudest thing in this file: it is the difference between a device
// that has forgotten an account and one that only says it has.
function forgetSignIn (why) {
  const prev = readPrefs()
  if (!prev.signin) return true
  // An erase is one of the three things vaultEpoch exists to invalidate, and it was the one
  // that did not bump it — the comment below said "every sign-out, service change, or
  // erase" while only the first two did. persistSignIn's write is a whole-object replace
  // that can land up to ten seconds after it started, so an erase that does not bump can be
  // undone by a keep it did not know about. Nothing else about this function changes: it
  // still answers whether the write landed, and still sends the same two statuses.
  vaultEpoch++
  const ok = writePrefs({ ...prev, signin: null })
  // The cache and the vault record share every terminal reason (operator refused, wrong
  // service, unopenable) — a lineup for an account this device can no longer enter must
  // not paint on the next boot. Saved credentials, when they exist, rebuild it on their
  // own next successful login.
  deleteCatalogCache()
  sendPrefs()
  send(ok
    ? { type: 'status', state: 'signin:erased', message: why || 'the kept sign-in was erased' }
    : { type: 'status', state: 'signin:erase-failed', message: 'the kept sign-in could NOT be erased — it may still be on this device' })
  return ok
}

// Every sign-out, service change, or erase bumps this. persistSignIn() reads it before it
// waits on the key store and again before it writes, because that wait is up to ten seconds
// long and a viewer can sign out inside it — and the write is a whole-object replace, so it
// would put the account back on a television that had just been signed out of it.
let vaultEpoch = 0

// Keep what a handover just delivered. Best-effort BY DESIGN: the device is already
// signed in for this session either way, so nothing here may throw into the engine's
// event emitter, and a failure costs the viewer a repeat handover after the next restart
// rather than a broken sign-in now. It is reported as a status so it is visible in a
// logcat without anybody having to guess.
//
// The engine emits 'signin-keys' ONCE (sdk/player.js _applySignIn) and nothing waits for
// this function, so a wrap that is merely slow used to end the story: nothing kept, no
// retry, and a set that looks signed in and silently is not. The material is still in this
// scope, so the retry costs nothing and is the whole fix.
const PERSIST_WRAP_TRIES = 3
const PERSIST_WRAP_STEP_MS = 1500

async function persistSignIn (keys) {
  const rec = gateSignInKeys(keys)
  if (!rec) return send({ type: 'status', state: 'signin:not-kept', message: 'the sign-in this device received was not storable' })
  lastLoginUsername = rec.username // the catalog cache stamps the account it belongs to
  const epoch = vaultEpoch
  try {
    const fileKey = hcrypto.randomBytes(FILE_KEY_BYTES)
    const box = sealSignIn(fileKey, rec)
    // The ONLY thing that crosses to the host: 32 random bytes that open nothing without
    // the box above, which the host never sees.
    const b64 = b4a.toString(fileKey, 'base64')
    let res = null
    for (let i = 1; i <= PERSIST_WRAP_TRIES; i++) {
      if (vaultEpoch !== epoch) return send({ type: 'status', state: 'signin:not-kept', message: 'signed out while this sign-in was being kept' })
      res = await vaultCall('wrap', b64)
      if (res.ok || !VAULT_RETRYABLE.has(res.code)) break
      if (i < PERSIST_WRAP_TRIES) await sleep(PERSIST_WRAP_STEP_MS)
    }
    if (!res.ok) {
      return send({
        type: 'status',
        state: 'signin:not-kept',
        message: 'the key store did not seal this sign-in (' + res.code + ') — it ends with the app'
      })
    }
    // THE RE-CHECK, and the reason it is here rather than at the top. Everything above can
    // take ten seconds per attempt; 'creds-clear' and 'service-clear' are one IPC line and
    // land in the middle of it. Writing anyway produced a signed-out television holding a
    // resumable credential, which is the exact state a sign-out exists to prevent.
    if (vaultEpoch !== epoch) return send({ type: 'status', state: 'signin:not-kept', message: 'signed out while this sign-in was being kept' })
    const ok = writePrefs({ ...readPrefs(), signin: { v: SIGNIN_VAULT_VERSION, box, key: res.data, at: Date.now() } })
    sendPrefs()
    send(ok
      ? { type: 'status', state: 'signin:kept' }
      : { type: 'status', state: 'signin:not-kept', message: 'the prefs file refused the write — this sign-in ends with the app' })
  } catch (err) {
    send({ type: 'status', state: 'signin:not-kept', message: String((err && err.message) || err) })
  }
}

// One resume at a time. Two in flight would each run a full login round against the
// panel's per-account throttle, and the second could only ever duplicate the first.
let resuming = false
// How many times the engine has thrown a corrupt replica away and rebuilt it. Read by the
// resume loop for one narrow purpose: a purge means the engine RE-RAN the call underneath
// it, so 'not connected to panel' from the second run is no longer proof that the first
// run sent nothing. See the refund below.
let storePurges = 0
// How long a resume waits for the swarm to find the panel before it gives up and says so.
// Bounded like every other cold-start wait in the handover path: a television that cannot
// reach its operator must say it cannot, not spin.
const RESUME_CONNECT_MS = 25000
const RESUME_STEP_MS = 1000
// The one FREE transient. It is thrown before any RPC leaves the device (sdk/player.js
// checks for a panel socket first), so retrying it costs the panel nothing and cannot walk
// the account into a login lockout.
const NOT_CONNECTED = /not connected to panel/i
// …and the one that is NOT free. A bare 'unknown user' means the account record has not
// replicated into this device's local replica yet (see accountNotReplicatedYet), and the
// only way to ask again is to run the login again — which reaches the panel and counts
// against its throttle: panel/src/rpc.js locks a username+peer out for LOCKOUT_SECONDS
// (900 s by default) after LOCKOUT_THRESHOLD (10) attempts inside the window, whether they
// failed or not. So the retries are few and spaced: at most three logins per resume.
//
// AND PER RESUME IS AS FAR AS THIS FILE CAN COUNT, which is why the answer carries the
// count out. This comment used to finish "…and the screen above allows two resumes per
// boot, which leaves the ceiling at six". The screen allowed no such thing: its budget was
// 45 s of WALL CLOCK, and two resumes is only what that buys when each one dials for 25 s
// first. Take the failure mode this retry was written for — the record has not replicated,
// so a resume spends its three logins over two RESUME_RECORD_STEP_MS sleeps and answers in
// ≥6 s — and the screen's 2.5 s spacing makes the cycle ≥8.5 s, so a successor is
// scheduled while n×8500 + 6000 < 45000, i.e. five more: six resumes, EIGHTEEN logins,
// against a panel that stops answering at ten. A live panel produced exactly that number.
// The screen now budgets by the cost this file reports instead.
const RESUME_RECORD_TRIES = 3
const RESUME_RECORD_STEP_MS = 3000

async function resumeSignIn (msg) {
  const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
  // Re-entry is refused BEFORE the latch is taken, so this early return can never clear a
  // latch it did not set. It costs nothing: no RPC is reached on this path at all.
  if (resuming) return send({ type: 'signin-resumed', ok: false, error: 'offline', retry: true, logins: 0, message: 'a sign-in is already being resumed', ...tag })
  resuming = true
  let answered = false
  // WHAT THIS ATTEMPT COST THE PANEL, carried on every answer including the ones composed
  // in the catch below. `retry: true` says the material survives; it says NOTHING about
  // price, and a caller that budgets retries by wall clock cannot tell a free failure (no
  // socket, a key store that did not answer) from one that spent a login the panel's
  // throttle counted. Held in an object rather than a plain counter so the answer() closure
  // reads the value at the moment it sends, not the value at the moment it was built.
  const cost = { logins: 0 }
  const answer = (o) => {
    if (answered) return
    answered = true
    // `logins` LAST, deliberately. The screen's whole budget is "did this attempt reach
    // the panel", and this is the one line that tells it. Spread the caller's object
    // first and a future answer({ …, logins: n }) silently overrides the measured cost
    // with a guessed one — the single edit that would put the retry storm back, in the
    // single place nothing would look for it.
    send({ type: 'signin-resumed', ...o, ...tag, logins: cost.logins })
  }
  try {
    await runResume(msg, answer, cost)
  } catch (err) {
    // Nothing below is expected to throw, and a screen is blocked on the reply — so the
    // catch is here rather than at the dispatch site, where it could only send a SECOND
    // 'signin-resumed' after one had already gone out. answer() is idempotent; this is not.
    answer({ ok: false, error: 'offline', retry: true, message: String((err && err.message) || err) })
  } finally {
    // THE LATCH IS RELEASED HERE AND NOWHERE ELSE. It used to be cleared by answer(), so a
    // throw on any path that had not answered yet left it set for the life of the process
    // — and every later resume then answered 'a sign-in is already being resumed', which
    // the splash screen spends its whole retry budget on before showing a sign-in screen.
    resuming = false
  }
}

async function runResume (msg, answer, cost) {
  const stored = readPrefs().signin
  if (!stored) return answer({ ok: false, error: 'none' })

  // 1. The key store opens the file key, or it does not — AND WHY IT DID NOT DECIDES
  //    WHETHER AN ACCOUNT IS DESTROYED. 'locked' and 'bad-blob' are the key store saying
  //    these bytes will never open again (a reinstall, a keystore reset, a wiped alias):
  //    the box beside them is noise and erasing is the honest thing to do. Everything else
  //    — no module, a store that would not open, silence from a busy RN thread at boot —
  //    is a condition of the moment, and this branch used to treat all of them alike.
  const un = await vaultCall('unwrap', stored.key)
  if (!un.ok) {
    if (VAULT_RETRYABLE.has(un.code)) {
      return answer({ ok: false, error: 'offline', retry: true, message: 'the key store did not answer (' + un.code + ')' })
    }
    forgetSignIn('the key store can no longer open this record (' + un.code + ')')
    return answer({ ok: false, error: 'locked' })
  }

  // 2. The file key opens the box, or it does not. Authenticated encryption, so this one
  //    really is proof: a box that fails its MAC was not written by this device.
  const rec = openSignIn(b4a.from(un.data, 'base64'), stored.box)
  if (!rec) { forgetSignIn('the stored sign-in did not open'); return answer({ ok: false, error: 'corrupt' }) }

  // 3. The record names its operator, and this device may have been pointed at another
  //    one since ("Change service…"). Signing an account back in to the wrong panel is
  //    not a thing to attempt and find out about.
  if (connectedKey && connectedKey !== rec.panelPubKey) {
    forgetSignIn('this device is on a different operator now')
    return answer({ ok: false, error: 'service' })
  }

  let p = null
  try {
    p = playerFor(msg)
  } catch (err) {
    // A build whose engine options do not validate. Nothing is wrong with the record, so
    // it stays: the fix is a new app build, not a new handover.
    return answer({ ok: false, error: 'offline', retry: true, message: String((err && err.message) || err) })
  }
  // A device that has a kept sign-in but no service yet (the keyless flavor, if the
  // Connect screen never got to persist one) learns its operator from the record — the
  // same key a viewer already confirmed on screen when the handover happened.
  if (!connectedKey) {
    connectedKey = rec.panelPubKey
    p.connect(rec.panelPubKey).catch(() => {})
  }
  lastLoginUsername = rec.username // the catalog cache stamps the account it belongs to

  const deadline = Date.now() + RESUME_CONNECT_MS
  let recordTries = 0
  for (;;) {
    // CHARGED BEFORE THE CALL, not after it. sdk/login.js loginWithKeys sends its `login`
    // as its second act, and everything that can go wrong afterwards — an unreplicated
    // record, a key that does not match, a refused session — goes wrong with that login
    // already counted by the panel. An attempt that never returns at all (the caller's own
    // timeout fires while this is still inside signInWithKeys) has spent it too.
    cost.logins++
    const purges = storePurges
    try {
      await p.signInWithKeys(rec.username, { priv: rec.priv, authPriv: rec.authPriv })
      return answer({ ok: true })
    } catch (err) {
      const message = String((err && err.message) || err)
      // …and refunded on the ONE error that proves no RPC left the device: sdk/player.js
      // throws it from _doLoginWithKeys before loginWithKeys is entered. This is what keeps
      // an offline set's dialling loop free, and it is the whole reason the two kinds of
      // retry can share one function.
      //
      // UNLESS THE STORE WAS PURGED UNDER IT, and that exception is not theoretical. That
      // one call is wrapped in _recover(), which on a corrupt replica throws the cache away
      // and runs the whole thing AGAIN — and the read that trips the corruption
      // (db.get('user/…')) happens AFTER the login RPC. So the second run can answer 'not
      // connected to panel' out of a freshly rebuilt swarm while the first run's login is
      // already on the panel's counter. Refunding that would report a boot as free when it
      // was not, which is the one direction this number must never be wrong in.
      if (NOT_CONNECTED.test(message) && purges === storePurges) cost.logins--
      // The operator said no — disabled account, a password rotation that replaced the
      // account's keypair. Erase: these keys will never work again.
      if (terminalSignInError(err)) {
        forgetSignIn('the operator refused this device: ' + message)
        return answer({ ok: false, error: 'rejected', message })
      }
      // The signed record has not replicated into this device's copy yet. The handover
      // path waits up to 30 s for exactly this before it logs in (sdk/player.js
      // _applySignIn); the resume path did not wait at all, and classified the result as
      // "the account is gone" — so a cold start over a cold DHT could erase a working
      // account on its first attempt. Ask again, a few times, slowly.
      if (accountNotReplicatedYet(err) && ++recordTries < RESUME_RECORD_TRIES && Date.now() < deadline) {
        await sleep(RESUME_RECORD_STEP_MS)
        continue
      }
      if (!NOT_CONNECTED.test(message) || Date.now() >= deadline) {
        return answer({ ok: false, error: 'offline', retry: true, message })
      }
      await sleep(RESUME_STEP_MS)
    }
  }
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
// 'confirm-service' question and 'signed-in', and then written to `connectedKey` — which
// is the whole point: it is how the engine RECORDS which service it is on when it was
// put there by a handover rather than by a {panelPubKey} message.
//
// Without it, `connectedKey` stays null for the rest of that session: the screen a
// handover finishes on persists the adopted service and goes straight to the menu, so
// no {panelPubKey} ever follows to set it. The teardown guard below reads
// `player && connectedKey && connectedKey !== msg.panelPubKey`, and null makes it FALSE
// — so the failure is not a spurious switch, it is a MISSED one: the next genuine
// change of operator ("Change service…", or a Connect retry against a different panel)
// skips the teardown and calls connect() on an engine that still holds the first panel's
// swarm, bee and every feed it cached.
let adoptingKey = null

// VIEWER DISK ON A SMALL BOX. The shipped SDK defaults — 512 MiB per feed, a store cap of
// 4x that (2 GiB), 12 warm feeds — were sized for hardware where a cached replica settles at
// ~one live window because the filesystem can hole-punch. The TV boxes this app targets are
// frequently the opposite case: a 32-bit ABI (so the app ships without fs-native-extensions
// and hypercore's clear() frees ZERO bytes — see the VIEWER DISK BUDGET note in
// sdk/player.js) attached to 4 GiB of flash TOTAL. A 2 GiB viewer cache is then most of the
// device, which is not a budget so much as a promise to fill it.
//
// TWO ADJUSTMENTS, deliberately gated differently:
//
//   reclaimBudgetBytes is set UNCONDITIONALLY. It needs no platform test because one
//   already runs underneath it: sdk/serve.js probeHolePunch punches a scratch file and
//   latches the budget OFF where the punch works, so on arm64 and desktop this value is
//   unreachable rather than merely unused. And it is a FLOOR, not the budget — a replica is
//   judged against max(this, 3x the OBSERVED live window) — so a channel with a genuinely
//   large window still cannot be rotated in a loop by a number chosen here. Lowering the
//   floor binds only where it should: an ordinary window (16-24 s) is a few MiB, nowhere
//   near 128 MiB, so the floor is what a leaking 32-bit replica trips on. 128 MiB is ~8.5
//   min of a 2 Mbps feed and derives a 512 MiB store cap.
//
//   prewarm and feedLimit are gated on the ABI, because nothing else gates them and both
//   are pure regressions on capable hardware — fewer channels pre-connected, and warm
//   replicas evicted (which PURGES, forcing a full re-dial on zap-back) where they would
//   have cost almost nothing. Unknown arch is treated as capable: that keeps the shipped
//   behaviour on anything we cannot positively identify as narrow, and the budget above
//   still applies there.
const NARROW_ABI = (() => {
  try { const a = os && typeof os.arch === 'function' && os.arch(); return a === 'arm' || a === 'ia32' } catch { return false }
})()
const NARROW_FEED_LIMIT = 3
const NARROW_PREWARM = 3
const VIEWER_FEED_BUDGET_BYTES = 128 * 1024 * 1024

// CAPPED, not replaced: a build that already asks for fewer keeps its own number, and one
// that asks for `true` (every entitled feed) is the case this exists to stop.
function narrowPrewarm (prewarm) {
  if (!NARROW_ABI) return prewarm
  if (prewarm === true) return NARROW_PREWARM
  if (typeof prewarm === 'number') return Math.min(prewarm, NARROW_PREWARM)
  return prewarm // false / undefined — already off
}

function ensurePlayer (hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, appVersion, platform, remote, panelPubKey) {
  if (player) return player
  if (uploadPolicy === 'client-only' || uploadPolicy === 'reseed') basePolicy = uploadPolicy
  // panelPeer: last session's validated panel peer, if this device has one FOR THIS
  // panel (readPanelPeer gates on the key) — the engine's delayed rescue dial for a
  // boot whose topic lookup delivers nothing. readPanelPeer only ever returns a
  // 64-hex value or undefined, so this cannot be what makes the constructor throw.
  // swarm.nodes: last session's DHT routing-table snapshot, if this device has one FOR
  // THIS DHT (readDhtNodes gates on the bootstrap config) — the engine's warm bootstrap.
  // readDhtNodes only ever returns already-validated {host, port} records or undefined,
  // so this cannot be what makes the constructor throw either.
  const cachedDhtNodes = readDhtNodes(swarm && swarm.bootstrap)
  const swarmOpts = cachedDhtNodes ? { ...(swarm || {}), nodes: cachedDhtNodes } : swarm
  player = new AliranPlayer({ storeDir: storeDir(), http, fs, os, hybrid, prewarm: narrowPrewarm(prewarm), tune, zapPrefetch, swarm: swarmOpts, uploadPolicy, reclaimBudgetBytes: VIEWER_FEED_BUDGET_BYTES, feedLimit: NARROW_ABI ? NARROW_FEED_LIMIT : undefined, remote, deviceId: ensureDeviceId(), appVersion, platform, panelPeer: readPanelPeer(panelPubKey) })
  player.on('ready', () => send({ type: 'ready' }))
  // `vod` (S53) rides the streams message only when the panel enabled a provider —
  // the field is absent otherwise, so the UI's "no VOD section" is the default.
  const p = player // the relay's engine — `player` moves on a service switch
  player.on('streams', (streams, vod) => {
    if (!bootTraceLogged.has(p)) { bootTraceLogged.add(p); logBootTrace(p, 'login-ok') }
    // A REAL session's lineup: latch it (a provisional emit racing in later must stand
    // down — see maybeWarmStart) and snapshot it for the next boot's warm start.
    streamsSeen.add(p)
    scheduleCatalogCacheWrite(streams, vod)
    send({ type: 'streams', streams, ...(vod ? { vod } : {}) })
  })
  player.on('status', (status) => {
    // Mirror the servers' "[net] ..." console line for the socket-buffer tuning
    // outcome (S33) so plain logcat shows it even without the RN debug relay.
    if (status && status.state === 'net:tuned') { try { console.log('[net]', status.message) } catch {} }
    send({ type: 'status', ...status })
  })
  player.on('peers', (peers) => send({ type: 'status', peers }))
  // A peer answered the hello probe — remember its address so the NEXT boot can dial it
  // directly (see readPanelPeer). Stamped with connectedKey, the panel THIS worklet is
  // on, which is also the guard: a dev direct-play or a not-yet-adopted handover has no
  // connectedKey and writes nothing (the adopted service's first ordinary boot writes it
  // instead). The engine emits only when the key CHANGES, so the compare below makes a
  // steady-state boot write-free rather than one-fsync-per-boot.
  player.on('panel-peer', (peerKey) => {
    try {
      if (connectedKey && readPanelPeer(connectedKey) !== peerKey) writePanelPeer(connectedKey, peerKey)
    } catch { /* best-effort — a lost write costs the next boot a topic lookup */ }
  })
  // The engine's routing-table snapshot — remember it so the NEXT boot bootstraps from
  // these nodes instead of the public bootstrap servers (see readDhtNodes). Stamped with
  // the bootstrap config THIS engine was built on, which is also the read-side gate. The
  // engine already emits only when the set changes, so no compare is needed here.
  player.on('dht-nodes', (nodes) => {
    try { writeDhtNodes(swarm && swarm.bootstrap, nodes) } catch { /* best-effort — a lost write costs the next boot the public bootstrap */ }
  })
  player.on('recovered', (err) => {
    storePurges++ // a resume in flight has just had its call re-run — see runResume's refund
    send({ type: 'status', state: 'store:reset', message: String((err && err.message) || err) })
  })
  player.on('fallback', (e) => send({ type: 'fallback', ...e }))
  player.on('source-changed', (e) => send({ type: 'source-changed', ...e }))
  player.on('feed-changed', (e) => send({ type: 'feed-changed', ...e }))
  player.on('zap-prefetch', (e) => send({ type: 'zap-prefetch', ...e }))
  // "Send to TV", the CAST half. Relayed under the `cast-` prefix like the two other
  // families with something to hide: a cast reply carries the session URL, and the
  // session URL carries the token. This event carries neither — it says a session
  // stopped — but it wears the prefix anyway, because the RN binding excludes the
  // FAMILY and a message that opted out one at a time is a message someone forgets.
  player.on('cast', (e) => send({ type: 'cast-ended', ...e }))
  // …and the HANDOFF half. `remotes` is the picker's device list; `remote` is a command
  // or a status push. Neither is a secret — a deviceId is a picker handle, not a
  // credential (sdk/remote-control.js) — so both log like every other relay.
  player.on('remotes', (peers) => send({ type: 'remote-peers', peers }))
  player.on('remote', (e) => send({ type: 'remote-info', ...e }))
  // The account material a RECEIVED handover delivered. Fires once, and only on a build
  // that asked for it (remote.keepSignIn — televisions). It NEVER reaches send(): it is
  // consumed here, sealed, and only the sealed box touches the disk. That asymmetry is
  // the point of the whole vault — every other engine event on this list is relayed
  // straight out over the IPC channel, and this is the one that must not be.
  //
  // Nothing awaits persistSignIn(), and nothing can: emit() is synchronous and the engine
  // has already put "signed in" on the screen by the time the key store answers. So the
  // retry that makes a slow wrap survivable lives inside persistSignIn, not out here.
  player.on('signin-keys', (keys) => { persistSignIn(keys).catch(() => {}) })
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
  return ensurePlayer(msg.hybrid, msg.prewarm, msg.tune, zap, msg.swarm, msg.uploadPolicy, msg.appVersion, msg.platform, msg.remote, msg.panelPubKey)
}

// The cached warm start's EMIT half: paint last session's lineup while the login dials.
// Fire-and-forget from the {panelPubKey} dispatch; every refusal is silent because the
// fallback IS today's behavior (splash spinner until the real login). Emits only when
// catalog-cache.mjs allows it — a gated cache for exactly this panel, a way back into
// the same account (saved creds naming the cache's username, or a kept sign-in), fresh
// enough — and only while no REAL lineup has landed this boot. `provisional: true` is
// the whole contract with the RN side: the menu may paint, playback may not (the engine
// has no entitlement keys yet), and the real login's push replaces it wholesale.
let warmStarted = false // once per worklet boot — a service switch must not re-fire it

async function maybeWarmStart (p, panelPubKey) {
  try {
    if (warmStarted) return
    const cache = readCatalogCache()
    const prefs = readPrefs() // prefs.signin is already gated by readPrefs (gateVaultRecord)
    if (!warmStartAllowed({ cache, panelPubKey, creds: prefs.creds, signinSaved: !!prefs.signin })) return
    warmStarted = true
    const port = await p.warmStart()
    // Re-check AFTER the await: the real login can land inside it (streamsSeen), and a
    // service switch can retire this engine (player moved on).
    if (streamsSeen.has(p) || player !== p) return
    const streams = rewriteOrigins(cache.streams, cache.port, port)
    send({ type: 'streams', streams, ...(cache.vod ? { vod: cache.vod } : {}), provisional: true })
    try { console.log('[boot-trace] provisional-streams', streams.length + ' streams') } catch {}
  } catch { /* a warm start is a bonus, never a boot failure */ }
}

// The three one-word answers of a sign-in, which are all the same shape: run an engine
// call that returns a boolean and answer with it, ALWAYS. A screen is blocked on each of
// them, so the reply is not optional — and the call is guarded because an uncaught throw
// in this IPC handler takes the whole app process down (see the Bare hooks at the top).
// Anything other than a clean `true` answers false, which is the safe outcome for all
// three: a refused PIN costs the viewer nothing, and a refused confirmation changes
// nothing.
function signinAck (msg, run) {
  let ok = false
  try { ok = !!player && run() === true } catch { ok = false }
  send({ type: 'signin-ack', ok, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
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
      // SIGN OUT, and it has to mean BOTH ways back in. A device may hold a saved password
      // or a kept phone -> TV sign-in — a television usually holds only the second — and a
      // sign-out that cleared one of them would put a set straight back into the account
      // on its next start. One write clears both; the host destroys the Keystore key that
      // sealed the second one at the same time (sdk/react-native clearCredentials).
      //
      // The epoch bump comes FIRST: a persist that is mid-flight in the key store must see
      // it before it writes, or the sign-out is undone a few seconds after it happened.
      vaultEpoch++
      writePrefs({ ...readPrefs(), creds: null, signin: null })
      // Sign-out also forgets the LINEUP: the cache is only ever shown to a device that
      // can get back into the account, and this device just declared it will not.
      deleteCatalogCache()
      // …and the remembered panel peer. Not because it is account data (it is a server
      // address), but because a signed-out device keeps no record of where it used to
      // belong — the next login re-learns it in one probe.
      deletePanelPeer()
      lastLoginUsername = null
      sendPrefs()
    } else if (msg.type === 'service-save' && msg.service && /^[0-9a-f]{64}$/.test(msg.service.panelPubKey)) {
      writePrefs({ ...readPrefs(), service: { panelPubKey: msg.service.panelPubKey, ...(typeof msg.service.name === 'string' ? { name: msg.service.name } : {}) } })
      sendPrefs()
    } else if (msg.type === 'service-clear') {
      // Leaving the operator ALSO abandons the sign-in that operator granted: a kept record
      // names its panel, and a device that has walked away from that panel can never use it
      // again. It used to be left on the disk until some later boot happened to attempt a
      // resume and notice — key material outliving the only relationship it meant anything
      // in. The Keystore key goes with it (sdk/react-native clearService).
      vaultEpoch++
      writePrefs({ ...readPrefs(), service: null, signin: null })
      // Leaving the operator abandons their lineup with them — same reasoning as the
      // sign-in erase beside this write — and their panel's peer address, which meant
      // nothing outside that relationship.
      deleteCatalogCache()
      deletePanelPeer()
      lastLoginUsername = null
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
      // is the SAFE outcome — malformed, nothing waiting, or an engine that threw — and
      // it costs the viewer nothing, so the screen may validate as the digits are typed.
      signinAck(msg, () => typeof msg.pin === 'string' && player.submitSignInPin(msg.pin) === true)
    } else if (msg.type === 'signin-confirm-service') {
      // TV role. Anything but an explicit true refuses — and refusing changes nothing.
      signinAck(msg, () => player.confirmSignInService(msg.ok === true) === true)
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
      signinAck(msg, () => player.confirmSignInMatch(msg.ok === true) === true)
    } else if (msg.type === 'signin-send-cancel') {
      if (player) { try { player.cancelSendSignIn() } catch (err) { fail(err) } }
    } else if (msg.type === 'signin-resume') {
      // TV role, on a later boot. ALWAYS answers — a splash screen is blocked on it —
      // and never throws: resumeSignIn() catches its own way to every outcome, and this
      // guard covers the one thing outside it (a rejected promise from an unexpected
      // shape), because an uncaught throw here takes the whole app process down.
      //
      // Deliberately WITHOUT `logins`: this is the one answer composed outside the resume,
      // so the cost is not knowable here, and an absent cost is read by the caller as "it
      // may have paid" — the safe direction (sdk/react-native/src/backend.ts).
      resumeSignIn(msg).catch((err) => send({
        type: 'signin-resumed',
        ok: false,
        error: 'offline',
        retry: true,
        message: String((err && err.message) || err),
        ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {})
      }))
    } else if (msg.type === 'vault-reply' && typeof msg.id === 'string') {
      // The host's answer to a 'vault-request'. A failure carries the key store's own code
      // (sdk/react-native/src/secure-key.ts), and it is carried BECAUSE the unwrap side
      // erases an account on the strength of it — an ok:false with no reason is treated as
      // 'unknown', which is retryable, because an answer that says nothing is not evidence.
      const settle = vaultPending.get(msg.id)
      if (settle) {
        vaultPending.delete(msg.id)
        settle(msg.ok === true && typeof msg.data === 'string' && msg.data.length > 0
          ? { ok: true, data: msg.data }
          : { ok: false, code: typeof msg.code === 'string' && msg.code ? msg.code : 'unknown' })
      }
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
    } else if (msg.type === 'cast-start') {
      // Stand up the LAN server a Chromecast fetches from. ALWAYS answers: a sheet is
      // showing a spinner on the device row that was tapped, and every way this can fail
      // — no engine, no private address, a channel this account cannot show — has to
      // reach it. The engine's own rejections carry the sentence worth showing.
      //
      // receiverHost is passed through UNVALIDATED on purpose: the SDK validates it (and
      // throws on an empty array rather than silently serving everyone), and a second
      // opinion here would only be a second thing to keep in step.
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      if (!player) {
        send({ type: 'cast-started', ok: false, error: 'offline', message: 'sign in on this device first', ...tag })
      } else {
        const opts = {}
        if (msg.receiverHost != null) opts.receiverHost = msg.receiverHost
        if (typeof msg.advertiseHost === 'string') opts.advertiseHost = msg.advertiseHost
        try {
          player.startCast(String(msg.streamId || ''), opts)
            .then((s) => send({ type: 'cast-started', ok: true, session: s, ...tag }))
            .catch((err) => send({ type: 'cast-started', ok: false, message: String((err && err.message) || err), ...tag }))
        } catch (err) {
          send({ type: 'cast-started', ok: false, message: String((err && err.message) || err), ...tag })
        }
      }
    } else if (msg.type === 'cast-stop') {
      // Idempotent, and answered either way — the sheet's Stop button is disabled until
      // this lands, so a swallowed reply is a button that never comes back.
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      if (!player) {
        send({ type: 'cast-stopped', ok: false, ...tag })
      } else {
        try {
          player.stopCast()
            .then((ok) => send({ type: 'cast-stopped', ok: ok === true, ...tag }))
            .catch(() => send({ type: 'cast-stopped', ok: false, ...tag }))
        } catch { send({ type: 'cast-stopped', ok: false, ...tag }) }
      }
    } else if (msg.type === 'remote-start') {
      // Join the account rendezvous — 'tv' announces and takes commands, 'controller'
      // looks up and sends them. Needs a live session AND a build that opted into
      // remote.control, and BOTH refusals are worth naming: the second cannot be fixed
      // at runtime. Answered always (the picker waits on it before it lists anything).
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      if (!player) {
        send({ type: 'remote-started', ok: false, error: 'offline', message: 'sign in on this device first', ...tag })
      } else {
        try {
          // acceptPlay: an explicit choice from the caller wins, then the PERSISTED
          // preference, then the engine's own default (accept). Resolved HERE rather than
          // in the app because this layer owns the prefs file — the RN mirror of it is a
          // copy that arrives in a message, and a join that ran before it landed would
          // announce an accepting set on a television whose viewer had switched that off.
          const persisted = readPrefs().remoteAccept
          const accept = typeof msg.acceptPlay === 'boolean' ? msg.acceptPlay : persisted
          player.startRemote({ role: msg.role, label: msg.label, ...(typeof accept === 'boolean' ? { acceptPlay: accept } : {}) })
            .then((r) => {
              send({ type: 'remote-started', ok: true, role: r.role, ...tag })
              // The peer list as it stands the moment the rendezvous is live. Without it
              // a picker opened before the first `remotes` event shows an empty list and
              // no reason for it.
              try { send({ type: 'remote-peers', peers: player.listRemotes() }) } catch { /* engine gone */ }
            })
            .catch((err) => send({ type: 'remote-started', ok: false, ...(err && err.code ? { error: err.code } : {}), message: String((err && err.message) || err), ...tag }))
        } catch (err) {
          send({ type: 'remote-started', ok: false, message: String((err && err.message) || err), ...tag })
        }
      }
    } else if (msg.type === 'remote-list') {
      // The cached list, on demand — a sheet that mounts between two `remotes` events
      // has nothing to draw otherwise.
      let peers = []
      try { peers = player ? player.listRemotes() : [] } catch { peers = [] }
      send({ type: 'remote-peers', peers, ...(typeof msg.tag === 'string' ? { tag: msg.tag } : {}) })
    } else if (msg.type === 'remote-cmd') {
      // Controller role: ask a television to play or stop. ONE message for both because
      // they share an answer — accepted, or a RemoteControlError code the sheet turns
      // into a sentence. `error` is load-bearing: 'timeout' NEVER means the device
      // declined, and the copy has to be able to tell those apart.
      const tag = typeof msg.tag === 'string' ? { tag: msg.tag } : {}
      const done = (p) => p
        .then(() => send({ type: 'remote-ack', ok: true, ...tag }))
        .catch((err) => send({ type: 'remote-ack', ok: false, ...(err && err.code ? { error: err.code } : {}), message: String((err && err.message) || err), ...tag }))
      if (!player) {
        send({ type: 'remote-ack', ok: false, error: 'offline', ...tag })
      } else {
        try {
          if (msg.cmd === 'play') done(player.remotePlay(String(msg.deviceId || ''), String(msg.streamId || '')))
          else if (msg.cmd === 'stop') done(player.remoteStop(String(msg.deviceId || '')))
          else send({ type: 'remote-ack', ok: false, error: 'malformed', ...tag })
        } catch (err) {
          send({ type: 'remote-ack', ok: false, ...(err && err.code ? { error: err.code } : {}), message: String((err && err.message) || err), ...tag })
        }
      }
    } else if (msg.type === 'remote-accept') {
      // TV role, the take-over switch. Anything but an explicit false leaves it on.
      //
      // PERSIST FIRST, THEN APPLY. The write is what makes this a preference rather than a
      // session mood: a viewer who switches the television off after turning this off has
      // to find it still off. If the write fails the engine is left ALONE — a set that says
      // "off" until the next boot and then quietly takes commands again is worse than one
      // that never claimed to be off, and writePrefs() has already told the UI it failed.
      const ok = msg.ok !== false
      if (writePrefs({ ...readPrefs(), remoteAccept: ok })) {
        sendPrefs()
        if (player) { try { player.setRemoteAccept(ok) } catch (err) { fail(err) } }
      }
    } else if (msg.type === 'remote-status') {
      // TV role. The two things only a HOST knows — paused, and where the playhead is.
      // Fire-and-forget: nothing is waiting on it, and a status push that failed is not
      // worth an error banner over a picture that is playing fine.
      if (player) {
        try {
          player.updateRemoteStatus({
            ...(typeof msg.state === 'string' ? { state: msg.state } : {}),
            ...(typeof msg.position === 'number' ? { position: msg.position } : {})
          })
        } catch { /* no rendezvous, or the engine is gone */ }
      }
    } else if (msg.type === 'remote-leave') {
      if (player) { try { player.stopRemote().catch(() => {}) } catch { /* already gone */ } }
    } else if (msg.feedKey && msg.encryptionKey) {
      ensurePlayer().serveFeed(msg.feedKey, msg.encryptionKey).then((port) => send({ type: 'port', port })).catch(fail)
    } else if (msg.username) {
      // 'streams' is sent by the event relay on success; failures (including the
      // transient 'not connected to panel' while the swarm dials) surface here.
      // The username is stamped at ATTEMPT time — the engine's 'streams' emit is
      // synchronous with the login resolving, so a success-time stamp would run after
      // the catalog-cache relay already snapshotted (see lastLoginUsername).
      lastLoginUsername = String(msg.username)
      ensurePlayer().login(msg.username, msg.password).catch((e) => {
        const message = String((e && e.message) || e)
        // Boot trace on the failures that reached the panel (or its replica) — the ones
        // with phase timings worth reading. The dial-gate throw has none and repeats.
        if (player && !/not connected to panel/.test(message)) logBootTrace(player, 'login-failed: ' + message)
        // A verdict on the ACCOUNT (rotated password, disabled, gone) kills the warm
        // start too: without this, every boot flashes a cached menu and yanks it away.
        if (terminalCatalogError(message)) deleteCatalogCache()
        send({ type: 'login-error', message })
      })
    } else if (msg.streamId) {
      // `type` from the engine rides as `recordType` (the IPC message's own `type` is
      // the envelope discriminant): 'vod' = finished library title (seek/pause UI, no
      // live self-heal events), with durationSec beside it for the transport display.
      // `headers` rides through untouched (undefined on everything but a hotlink-checked
      // redirect channel) — the video player, not the engine, is what sends them.
      ensurePlayer().resolve(msg.streamId).then(({ port, url, source, type, durationSec, headers }) => send({ type: 'port', port, url, source, streamId: msg.streamId, recordType: type, durationSec, headers })).catch(fail)
    } else if (msg.panelPubKey) {
      // GUARDED for the same reason 'signin-start' is: playerFor() constructs the engine,
      // and the constructor VALIDATES its option fields — a host that passes
      // remote:{sendtoTV:true} (a typo the SDK refuses rather than ignores) throws right
      // here. Unguarded that is a dead app process at boot, and on the switch path below
      // it is an unhandled rejection instead. Answering with {type:'error'} leaves the
      // engine unbuilt, which is what the screens are already able to show.
      const boot = () => {
        try {
          const p = playerFor(msg)
          p.connect(msg.panelPubKey).catch(fail)
          maybeWarmStart(p, msg.panelPubKey) // fire-and-forget — see the function
        } catch (err) { fail(err) }
      }
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
