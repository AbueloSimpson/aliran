// @aliran/player-sdk — headless Aliran player engine, runtime-agnostic (Node + Bare).
//
// Extracted from the app's Bare worklet backend (client/backend/backend.mjs), which is
// now a thin IPC shell over this class — one engine for the app and for integrators.
// The engine: connect to a panel (replicate the signed DB + login RPC over the DHT),
// OPRF-login, then serve entitled encrypted feeds and catalog art on a localhost Range
// HTTP server that any HLS-capable player can consume.
//
// Runtime modules are INJECTED: pass { http, fs } — node:http/node:fs in Node (see
// index.js for the convenience entry), bare-http1/bare-fs in the Bare worklet. This
// file must stay free of runtime-specific imports so one graph bundles for both.
//
// The on-disk store is a DISPOSABLE replica cache. If a previous process died
// mid-write, opening a core can fail permanently (OPLOG_CORRUPT et al) — recovery
// purges the whole store and retries once (see recover.js); everything re-replicates
// from peers and the in-memory session (entitled stream keys) survives.
//
// Events (no throw on unhandled 'error'):
//   'ready'              connected to the panel topic (login may still need to dial)
//   'streams' (list)     display catalog (no keys inside): after a successful login,
//                        and re-emitted live whenever the panel edits the catalog
//                        (title/isLive/art/... — no polling, no re-login)
//   'status'  ({state})  breadcrumbs: 'feed:open' | 'feed:ready' | 'feed:retune';
//                        'net:tuned' also carries {message} — the swarm socket-buffer
//                        tuning outcome, same text the server components log ([net])
//   'peers'   (count)    feed-health ticker while a stream is being served
//   'recovered' (err)    a corrupt store was purged and the operation retried
//   'error'   (err)      background failures that have no caller to throw to
//   'fallback' ({streamId,url,reason})        hybrid: P2P unhealthy -> switched to CDN
//   'source-changed' ({streamId,source,url})  hybrid: active source switched (e.g. back to P2P)
//   'feed-changed' ({streamId,feedKey,url})   the ACTIVE stream's catalog feedKey rotated
//                        underneath the viewer (broadcaster source change / RAM restart):
//                        the SDK re-resolved and swapped the served feed WITHOUT a new
//                        resolve() call. url is the unchanged localhost URL — the host
//                        just reloads the player to flush the stale playlist/segments.
//   'zap-prefetch' ({enabled} | {state,reason})  smooth-zapping lifecycle: {enabled}
//                        echoes setZapPrefetch(); {state:'suspended',reason} /
//                        {state:'resumed'} when the adaptive gate pauses/resumes the
//                        neighbor warm loop (reason 'metered'|'stall'|'thin').
//   'signin-pair' ({role,state,...})  phone->TV sign-in handover (sdk/signin-pair.js).
//                        role 'tv' walks code -> announced -> linked -> match -> pin-entry
//                        -> received -> confirm-service -> signed-in; role 'phone' walks
//                        searching -> linked -> match -> pin -> sent. Either ends at
//                        {state:'failed',reason}. THREE of those states are questions,
//                        not notifications, and the exchange stops dead until the host
//                        answers: 'match' on the phone (confirmSignInMatch), 'pin-entry'
//                        on the TV (submitSignInPin), 'confirm-service' on the TV
//                        (confirmSignInService). Deliberately NOT in the problem-report
//                        breadcrumb ring (see _recordEmit): a code, a SAS or a PIN must
//                        never ride along on a report — and for the same reason none of
//                        the three may reach a log on the host side either.
//   'signin-keys' ({username,panelPubKey,priv,authPriv})  fires ONCE, at the end of a
//                        RECEIVED handover, and only on a build constructed with
//                        { remote: { keepSignIn: true } }. THIS EVENT IS THE ACCOUNT: the
//                        two private keys, in the clear, so a host can persist them and
//                        sign itself back in with signInWithKeys() after a restart. Take
//                        it only if you have somewhere safe to put it, put it there
//                        immediately, and log nothing about it — not the object, not its
//                        keys, not its length. Excluded from the breadcrumb ring for the
//                        same reason 'signin-pair' is (_recordEmit is a whitelist).
//   'remotes' (list)     the account's OWN other devices on the remote rendezvous
//                        (sdk/remote-control.js), re-emitted whenever the list changes.
//                        Only ever fires while startRemote() is running, which needs a
//                        build with { remote: { control: true } }.
//   'remote'  ({role,state,...})  "play on my TV". role 'tv': {state:'play',streamId,
//                        restricted,from} is a COMMAND — the host tunes it, and MUST put a
//                        `restricted` channel through the same parental-PIN gate a local
//                        zap goes through (the engine deliberately does not tune it for
//                        you, which is what keeps that gate in front of it); {state:'stop'}
//                        and {state:'refused',reason} are the other two. role 'controller':
//                        {state:'status',from,status:{streamId,state,position}} — what that
//                        television is showing, pushed when it changes. Like 'signin-pair',
//                        deliberately NOT in the problem-report breadcrumb ring (_recordEmit):
//                        these carry another household device's LABEL, and a report is
//                        pseudonymous on purpose.
//   'update-progress' ({received,total})  OTA app-update download progress (throttled)
//   'update-ready' ({path,entry})   OTA artifact downloaded, sha256-verified, on disk
//   'update-error' ({message})      OTA download/verify failure (downloadUpdate() also
//                        rejects with the same error — hosts pick one surface)
//
// Tune self-heal (p2p-only): pass `tune` { timeoutMs, relookupMinMs, relookupMaxMs } to
// bound a tune. While the active feed's playlist is not ADVANCING-and-SERVABLE
// (metadata seq moves AND the playlist content is fetchable — see _playlistServable),
// the engine forces DHT re-lookups on a backoff, retunes once at timeoutMs (evict +
// fresh open), tears down wedged peer connections at 2× (destroy + fresh dial,
// 'feed:reconnect'), then emits a friendly 'error' by ≤3×. See normalizeTune() and
// _startTuneWatchdog().
//
// Zap latency: serving is handled by the shared progressive core (serve.js) —
// availability wait + block-progressive bodies + live-edge read-ahead. `prewarm`
// (below) makes first zaps warm; `zapPrefetch` (OFF by default — standing
// bandwidth) additionally keeps the adjacent channels' newest segment replicated
// while watching, see normalizeZapPrefetch(). It is runtime-switchable
// (setZapPrefetch — the app's "Smooth zapping" toggle) and ADAPTIVE: an internal
// gate suspends the warm loop on a metered network (setNetworkProfile), while the
// ACTIVE stream stalls, or when a neighbor download shows the pipe has no headroom
// — prefetch must never compete with playback. `uploadPolicy: 'client-only'` joins
// feed/assets topics without announcing (server:false), for constrained viewers
// that should not re-seed to others.
//
// Hybrid CDN<->P2P (S10b): pass `hybrid` config to choose the active source per play.
// The SDK never decodes video — it exposes the CURRENT source URL + health signals and
// keeps replicating the P2P feed in the background while on CDN so it can auto-return.
// Health is playlist-based: the feed is "ready" when /index.m3u8 exists in the replica,
// and "healthy" when its signature advances between probes (live edge moving) AND the
// advanced playlist's content is fetchable (_playlistServable — same metadata-vs-blobs
// split as the tune watchdog). Playback stalls the host player would see show up here
// as a non-advancing or unservable playlist.
//
// Redirect channels (S23): a catalog entry may instead carry {redirect:true, url} — an
// operator-set https URL that viewers play DIRECTLY (resolve() returns it with
// source:'cdn' and no port). No feed, no swarm join, no self-heal machinery: there is
// no replica to heal, so remote-URL playback and its errors belong to the host player.
//
// VOD titles (S8a): a catalog record with type:'vod' (+ durationSec) is a library
// title — a STATIC encrypted drive holding a finished HLS VOD rendition. resolve()
// serves it on the same localhost server (full Range support = full seek) and returns
// {type:'vod', durationSec}, but arms NONE of the live machinery: the tune watchdog,
// the zap-prefetch gate and the hybrid stall/recovery probes all define health as the
// playlist ADVANCING, and a finished playlist never advances — each would false-fire
// on a perfectly healthy title. vod plays P2P even under hybrid config, is never
// segment-warmed as a zap neighbor, and does not hot-follow a catalog feedKey change
// (a re-ingest applies on the NEXT resolve, not mid-film). See the vod branch in
// resolve() and the a.vod guards it leans on.
//
// Viewer problem reports (S50c): report({category, text}) sends a pseudonymous
// problem report to the panel over the SAME RPC socket login uses — no new port, no
// HTTP. It attaches what the engine already knows (active channel, peer count, app
// version/platform from the constructor opts, and a rolling 50-entry ring of the
// engine's own error/status/fallback/source-changed/recovered events), and the
// session TOKEN as proof of entitlement. The panel reduces that token to an HMAC
// pseudonym on arrival; no username or deviceId is ever stored (see
// panel/src/reports.js). report() NEVER throws and never rejects — a UI awaits it and
// switches on the result — and it is rate-limited locally per channel+category so a
// frustrated viewer mashing the button during a real outage costs the panel nothing.
// A pre-S50 panel has no such responder: that lands as {error:'unsupported'}, which
// hosts should surface as "this service doesn't accept reports", not as a failure.

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Rache from 'rache'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import hcrypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { panelClient, login as oprfLogin, loginWithKeys } from './login.js'
import { receiveSignIn, sendSignIn as sendSignInHandover, SigninPairError, SIGNIN_PAIR_ERRORS } from './signin-pair.js'
import {
  startRemoteControl, RemoteControlError, REMOTE_CONTROL_ERRORS, REMOTE_CONTROL_ROLES, REMOTE_STATUS_STATES
} from './remote-control.js'
// The operator's 12-character alias, derived from the panel key alone (core/pairing.js).
// It is what makes "which service is this device about to join?" answerable on a screen:
// 64 hex characters are not something a viewer checks against an operator's card.
import { pairingCode } from '@aliran/core'
import { isCorruptionError, withRecovery } from './recover.js'
import { createDriveHandler, playlistUris, THUMB_PATH } from './serve.js'
import { REPORT_CATEGORIES, REPORT_TEXT_MAX, REPORT_EVENT_LIMIT, REPORT_EVENT_DETAIL_MAX, REPORT_COOLDOWN_MS } from './report.js'
// The runtime-agnostic half of core/net-tune.js — no fs import (a node:fs edge in this
// graph would become a `builtin:` ref the Bare worklet cannot load); the /proc ceiling
// read gets the engine's INJECTED fs instead. See _tuneSwarmSockets.
import { tuneSwarm, tuningMessages, DEFAULT_BUFFER_BYTES } from '@aliran/core/net-tune-core.js'

// Minimal emitter: unlike node:events it exists in both runtimes and never throws on
// an unhandled 'error' event (SDK errors surface to callers as rejections instead).
class Emitter {
  constructor () { this._events = {} }
  on (name, fn) { (this._events[name] = this._events[name] || new Set()).add(fn); return this }
  off (name, fn) { const s = this._events[name]; if (s) s.delete(fn); return this }
  once (name, fn) { const g = (...a) => { this.off(name, g); fn(...a) }; return this.on(name, g) }
  emit (name, ...args) {
    const s = this._events[name]
    if (!s || !s.size) return false
    for (const fn of [...s]) { try { fn(...args) } catch {} }
    return true
  }
}

// Hybrid art: catalog art fields may be absolute http(s) URLs instead of assets-drive
// paths — those pass through the URL transforms untouched. (The panel only ACCEPTS
// https:// — Android blocks cleartext off-loopback — but the guard covers http too so
// a hand-edited record degrades to a fetch error, not a mangled localhost URL.)
const ABSOLUTE_URL_RE = /^https?:\/\//i

// Live channel thumbnail (THUMB_PATH, imported from serve.js): the rolling JPEG the
// broadcaster refreshes into the CHANNEL'S OWN feed drive every ~30 s
// (broadcaster/src/channel.js). It rides the feed — not the assets drive (append-only: a
// 30 s refresh would archive ~2.5 GB/day fleet-wide) and not the guide drive (epoch
// rotation absorbs daily churn, not per-minute churn) — because the feed is the one store
// whose growth law is already "constantly replaced, bounded window". One fixed path per
// feed; see _thumbTarget. The literal itself lives in serve.js because the reclaim sweep
// there has to protect the very entry this route serves.

// Hybrid defaults: p2p-only keeps the pre-hybrid behavior exactly (the app worklet
// runs with this). cdnUrl may be a function (streamId => url) or a template string
// containing '{streamId}'.
function normalizeHybrid (h) {
  const cfg = {
    mode: 'p2p-only',
    start: 'preferP2P',
    cdnUrl: null,
    readyTimeoutMs: 8000,
    rebufferMsToFallback: 10000,
    probeIntervalMs: 5000,
    ...h
  }
  if (!['p2p-only', 'hybrid', 'cdn-only'].includes(cfg.mode)) throw new Error('hybrid.mode must be p2p-only | hybrid | cdn-only')
  if (!['preferP2P', 'preferCDN'].includes(cfg.start)) throw new Error('hybrid.start must be preferP2P | preferCDN')
  if (cfg.mode !== 'p2p-only') {
    if (typeof cfg.cdnUrl === 'string') { const tpl = cfg.cdnUrl; cfg.cdnUrl = (id) => tpl.replace('{streamId}', id) }
    if (typeof cfg.cdnUrl !== 'function') throw new Error('hybrid.cdnUrl (function or template string) is required for mode ' + cfg.mode)
  }
  return cfg
}

// Tune self-heal (p2p-only mode; the S22 2026-07-16 stuck-at-90% incidents): a tune
// can spin forever for three reasons. (1) Cold feed, stale DHT record: the broadcaster
// restarted since the last lookup (its feed-seeding swarms are ephemeral identities,
// and hyperswarm re-queries a client topic only every ~10 min), no peer is found, the
// playlist never lands. (2) WEDGED connection: a network flap leaves the hyperswarm/
// UDX connection alive at transport level while hypercore replication over it moves
// zero bytes — peers look connected, the stale playlist is already in the replica,
// nothing ever advances. (3) METADATA-ONLY replication (the 2026-07-17 acceptance
// wedge): the playlist's bee seq keeps advancing while the blob bytes behind it never
// become fetchable — the metadata and blobs cores are separate channels with separate
// failure modes, so "the playlist advances" alone does NOT mean a single media byte is
// servable. timeoutMs bounds one tune attempt: on the first expiry the
// cached open is EVICTED and re-opened fresh; on the second, connections serving the
// feed are DESTROYED so the swarm dials fresh (the retune alone can't help — hyperswarm
// shares one connection per peer, so a fresh open reuses the wedged pipe); only then a
// friendly 'error' surfaces to the host (≤3× timeoutMs total). relookup(Min|Max)Ms
// pace forced discovery.refresh() calls while a tune is incomplete — the same
// self-heal as the broadcaster's PanelLink (broadcaster/src/panel-link.js).
// rescanMs (the re-source defect, 2026-07-31): AFTER a successful tune, nothing
// watched the peer set — a viewer that tuned off relay/repeater peers while its dials
// to the origin failed is left with hyperswarm knowing NOTHING about the origin
// (failed peers are parked after 3 retries and then garbage-collected), so when the
// relays later die the viewer sits source-less until hyperswarm's own ~10-12 min
// topic re-lookup. rescanMs is how long the ACTIVE live p2p feed may hold ZERO peers
// before the engine forces a fresh DHT lookup and re-arms the tune watchdog. 0
// disables (the pre-fix behavior).
function normalizeTune (t) {
  const cfg = { timeoutMs: 30000, relookupMinMs: 5000, relookupMaxMs: 60000, rescanMs: 10000, ...t }
  for (const k of ['timeoutMs', 'relookupMinMs', 'relookupMaxMs']) {
    if (!(Number(cfg[k]) > 0)) throw new Error('tune.' + k + ' must be a positive number of milliseconds')
  }
  if (!(Number(cfg.rescanMs) >= 0)) throw new Error('tune.rescanMs must be a non-negative number of milliseconds (0 disables the zero-peer rescan)')
  return cfg
}

// prewarm: after login, open+join entitled feeds in the background so the FIRST zap to
// a channel is warm (the cold DHT discovery + handshake are paid upfront, off the play
// path). false (default) = off; true = all entitled feeds; a positive integer = cap to
// that many (lowest curated order first — the channels a viewer is likeliest to reach).
function normalizePrewarm (v) {
  if (v === true) return Infinity
  if (v === false || v == null) return 0
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error('prewarm must be a boolean or a non-negative integer')
  return n
}

// zapPrefetch: while a stream plays, keep the NEWEST segment of the adjacent
// channels (next/previous in curated zap order) replicated locally, so a CH+/CH-
// zap starts from warm bytes instead of a cold demand-paged fetch. OFF by default —
// unlike prewarm (connections only, ~free), this costs STANDING BANDWIDTH roughly
// equal to each warmed neighbor's bitrate for as long as a stream is playing.
// true = defaults below; an object overrides them:
//   neighbors    1      how many channels each side of the active one to warm
//   intervalMs   3000   warm-loop tick
//   directional  true   once the viewer's zap DIRECTION is known (an adjacent-channel
//                       move), warm only that side — halves the cost for the common
//                       channel-surfing pattern; a menu jump resets to both sides
//   stallMs      12000  gate: active playlist silent this long = playback is starving
//                       -> suspend (3 live segment periods; never compete with playback)
//   resumeMs     60000  gate: how long the active playlist must advance cleanly before
//                       a stall/thin suspension lifts
//   minHeadroom  3      gate: a neighbor segment must download at >= minHeadroom x
//                       realtime, else the pipe is too thin to share -> suspend
function normalizeZapPrefetch (v) {
  if (v === false || v == null) return null
  const cfg = { neighbors: 1, intervalMs: 3000, directional: true, stallMs: 12000, resumeMs: 60000, minHeadroom: 3, ...(v === true ? {} : v) }
  if (!Number.isInteger(cfg.neighbors) || cfg.neighbors < 1) throw new Error('zapPrefetch.neighbors must be a positive integer')
  if (!(Number(cfg.intervalMs) > 0)) throw new Error('zapPrefetch.intervalMs must be a positive number of milliseconds')
  cfg.directional = cfg.directional !== false
  if (!(Number(cfg.stallMs) > 0)) throw new Error('zapPrefetch.stallMs must be a positive number of milliseconds')
  if (!(Number(cfg.resumeMs) >= 0)) throw new Error('zapPrefetch.resumeMs must be a non-negative number of milliseconds')
  if (!(Number(cfg.minHeadroom) > 0)) throw new Error('zapPrefetch.minHeadroom must be a positive number')
  return cfg
}

// uploadPolicy: whether this viewer re-seeds what it replicates. 'reseed' (default)
// joins feed/assets topics server:true — replicated blocks are served back to other
// viewers on request (opportunistic, demand-driven upload). 'client-only' joins
// server:false: the peer never announces on those topics, so other viewers cannot
// discover it — practically zero viewer-to-viewer upload, at the swarm-wide cost of
// one fewer re-seeder. Boot-time only (join mode is fixed when a topic is joined).
function normalizeUploadPolicy (v) {
  if (v == null) return 'reseed'
  if (v !== 'reseed' && v !== 'client-only') throw new Error("uploadPolicy must be 'reseed' or 'client-only'")
  return v
}

// remote: which of the cross-device features (core/remote.js) this BUILD may use. Both
// are OFF by default and both are construction-time only, because both of them make a
// login RETAIN something it would otherwise drop on the floor:
//
//   sendToTv  the phone half of "send to TV". Turning it on makes every login keep the
//             account's two PRIVATE KEYS in memory for the whole session (sdk/login.js
//             `handover`), because sendSignIn() cannot recover them later without the
//             password. Off, they are locals inside login() and are gone when it returns
//             — which is where they were before this feature existed, and where they
//             should stay on any build that will never hand an account to a TV.
//   control   the account rendezvous secret (remoteSecret). NOT a key: it cannot sign a
//             session or open a stream, and it is one-way from the private key. But it
//             authenticates this device to the account's other devices, and it is stable
//             until the operator's "log out all devices" — so it is both an authenticator
//             and a permanent correlator for the account, and a build with no use for it
//             should not be holding one. WP3 turns this on.
//   keepSignIn  the RECEIVING side of "send to TV", and the only one of the three that is
//             about DISK rather than memory. On, a completed handover emits the material
//             it was given ONCE, as 'signin-keys', so a host can put it somewhere the
//             device can read after a restart — the difference between a television that
//             is signed in and one that is signed in until Android reclaims the process.
//             Off (the default) the material is a local inside _applySignIn and is gone
//             the moment that method returns, which is where it was before this flag.
//
//             IT IS NOT `sendToTv`, AND THE TWO MUST NOT BE READ AS ONE SWITCH. sendToTv
//             is the SENDING role and is deliberately off on televisions, so that a set
//             in a living room never holds an account it could hand onward. keepSignIn is
//             the RECEIVING role and is the flag a television wants. A build that turns it
//             on undertakes to protect what it is handed (docs/security-model.md, "Account
//             keys at rest"); a build with nowhere safe to put it leaves this off and asks
//             for a new handover after every restart.
//
// A RUNTIME switch would be worse than useless here: by the time a host could flip one
// the login has already happened, so the material is either retained or unrecoverable.
// Hence the constructor, which is also the only place a packager can see it.
//
//   remote: true                       the two MEMORY features on; keepSignIn still off
//   remote: { keepSignIn: true }       the disk one, and it can only be asked for by name
//   omitted / false                    everything off
//
// `remote: true` DOES NOT INCLUDE keepSignIn, and the asymmetry is deliberate. The other
// two decide what a login keeps in memory for the length of a session; this one is an
// undertaking to write the account to a disk and protect it there, which is a property of
// the BUILD (does it have a key store, does it erase on sign-out) and not something a
// shorthand can be sure of. It used to be included, which meant a host that wrote
// `remote: true` to get sendSignIn() on a phone was handed account keys at rest as well —
// on a device that has a keyboard and a password and needs none of it. Ask for it by name.
function normalizeRemote (v) {
  const out = { sendToTv: false, control: false, keepSignIn: false }
  if (v == null || v === false) return out
  if (v === true) return { sendToTv: true, control: true, keepSignIn: false }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('remote must be a boolean or an object of feature flags')
  for (const k of Object.keys(v)) {
    // Unknown keys throw rather than being ignored: a typo'd `sendtoTV: true` that
    // silently left the feature off would present as "sendSignIn says this build cannot",
    // which is a long way from its cause.
    if (!Object.prototype.hasOwnProperty.call(out, k)) throw new Error('unknown remote feature: ' + k + " (expected 'sendToTv', 'control' or 'keepSignIn')")
    if (typeof v[k] !== 'boolean') throw new Error('remote.' + k + ' must be a boolean')
    out[k] = v[k]
  }
  return out
}

// Duration (ms) of a live playlist's NEWEST segment — the realtime baseline for the
// prefetch headroom probe. EXTINF lines pair 1:1 with URIs, so the last one belongs
// to the segment _warmNeighbor downloads; falls back to the Aliran default 4 s.
function lastSegmentDurationMs (text) {
  let d = null
  const re = /#EXTINF:([\d.]+)/g
  for (let m; (m = re.exec(text));) d = Number(m[1])
  return d > 0 ? d * 1000 : 4000
}

// swarm: tuning for the ONE Hyperswarm the engine runs (panel + every feed share it).
// maxPeers = hyperswarm's total-connection budget (lib default 64). Ordinary viewers
// should omit it; SDK-based seed nodes and the repeater appliance (S20) raise it into
// the hundreds so they can hold big fan-out. bootstrap = custom DHT bootstrap nodes
// (local testnets / private DHTs) — omit for the public DHT.
//
// rcvbufMb / sndbufMb (S33) size the swarm's UDP socket BUFFERS — MiB, mirroring the
// server envs SWARM_RCVBUF_MB/SWARM_SNDBUF_MB; 0 leaves that direction at the OS/udx
// default. Viewer defaults: recv 2 MiB, send 0 — a viewer is download-dominant, so the
// receive buffer is the one that absorbs fan-in while the JS thread is busy; reseed
// upload is opportunistic and never buffer-bound on a phone uplink. Returns the
// Hyperswarm constructor opts (ctor) separately from our buffer knobs, which hyperswarm
// must not see.
function normalizeSwarmOpts (v) {
  const out = { ctor: null, recvBytes: DEFAULT_BUFFER_BYTES, sendBytes: 0 }
  if (v == null) return out
  const ctor = {}
  if (v.maxPeers != null) {
    if (!Number.isInteger(v.maxPeers) || v.maxPeers < 1) throw new Error('swarm.maxPeers must be a positive integer')
    ctor.maxPeers = v.maxPeers
  }
  if (v.bootstrap != null) {
    if (!Array.isArray(v.bootstrap)) throw new Error('swarm.bootstrap must be an array of DHT bootstrap nodes')
    ctor.bootstrap = v.bootstrap
  }
  if (Object.keys(ctor).length) out.ctor = ctor
  for (const [key, dir] of [['rcvbufMb', 'recvBytes'], ['sndbufMb', 'sendBytes']]) {
    if (v[key] == null) continue
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < 0) throw new Error(`swarm.${key} must be a number >= 0 (MiB; 0 disables)`)
    out[dir] = Math.floor(v[key] * 1048576)
  }
  return out
}

// OTA app updates: bounded manifest wait — a cold/unreachable updates drive answers
// {status:'unknown'}, never a hang. Download inactivity bound: a download that moves
// no bytes this long surfaces an error instead of a wedged single-flight promise.
const UPDATE_CHECK_TIMEOUT_MS = 15000
const UPDATE_STALL_MS = 60000
// Artifact basenames come from the (panel-signed) manifest, but they become local fs
// paths — allow only plain file names, never separators or dot-walks.
const UPDATE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Short free-form host strings that ride along on a problem report (appVersion,
// platform) and the per-install device id. Anything that is not a non-empty string is
// dropped rather than coerced — a host that passes an object must not turn into
// "[object Object]" in an operator's Reports tab.
function shortLabel (v, max = 64) {
  if (typeof v !== 'string') return null
  const s = v.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

// How long the TV waits for the viewer's answer to 'confirm-service'. The code is already
// spent and the payload is already in memory by this point, so this bounds how long that
// memory is held as much as it bounds the screen.
const SIGNIN_CONFIRM_MS = 120000

// A sign-in failure whose wording was WRITTEN FOR A VIEWER, and is therefore safe to put
// through the 'signin-pair' event to a host that will render it verbatim.
//
// The distinction matters because the other errors reaching that emit are not: the key
// handover path can fail with 'session failed: <panel error code>', 'unknown user' and
// 'key recovery failed', and the store layer can fail with hypercore's OPLOG_CORRUPT. The
// rest of this feature keeps a curated vocabulary (SIGNIN_PAIR_ERRORS); forwarding raw
// internals to a screen would break that at the one moment a viewer is most confused.
// The original error is NOT swallowed — it still rejects `done`, which is where a host
// that wants to log the real cause locally should read it.
function signinFacing (message) {
  const err = new Error(message)
  err.viewerFacing = true
  return err
}

function signinFacingMessage (err) {
  return err && err.viewerFacing
    ? String(err.message)
    : 'the sign-in could not be completed on this device'
}

export class AliranPlayer extends Emitter {
  constructor ({ panelPubKey, storeDir = './aliran-store', http, fs, hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, remote, deviceId, deviceLabel, appVersion, platform } = {}) {
    super()
    if (!http || !fs) throw new Error('AliranPlayer needs injected { http, fs } runtime modules (use index.js in Node)')
    this._remote = normalizeRemote(remote) // see normalizeRemote — default: hold nothing
    this._hybrid = normalizeHybrid(hybrid)
    this._prewarmN = normalizePrewarm(prewarm)
    this._tune = normalizeTune(tune)
    this._zapPrefetch = normalizeZapPrefetch(zapPrefetch)
    const swarmOpts = normalizeSwarmOpts(swarm)
    this._swarmOpts = swarmOpts.ctor
    this._swarmBufs = { recvBytes: swarmOpts.recvBytes, sendBytes: swarmOpts.sendBytes }
    this._uploadPolicy = normalizeUploadPolicy(uploadPolicy)
    this._zapTimer = null // adjacent-channel warm loop (only when zapPrefetch is on)
    this._zapRanges = new Map() // streamId -> { path, range } — newest warmed segment per neighbor
    this._zapGate = null // adaptive-gate state while the warm loop runs (see _zapTick)
    this._zapDir = 0 // last observed zap direction: 1 up, -1 down, 0 unknown -> warm both sides
    this._netExpensive = false // host-reported metered/expensive network (setNetworkProfile)
    this._active = null // current play state: { streamId, feedKey, localUrl, cdnUrl, source, lastSig, lastAdvance }
    this._watchTimer = null // P2P stall watchdog (while source === 'p2p')
    this._probeTimer = null // P2P recovery probe (while source === 'cdn')
    this._tuneTimer = null // tune watchdog (p2p-only, while the active feed's playlist has not landed)
    this._panelKey = panelPubKey || null
    this._storeDir = storeDir
    this._http = http
    this._fs = fs
    this._store = null
    this._swarm = null
    this._panelBee = null
    this._catalogWatcher = null
    this._call = null
    this._panelPeerKey = null // hex public key of the peer that PROVED it is the panel (see _maybeArmRpc)
    this._panelDiscovery = null // the panel topic's PeerDiscovery — report() kicks refresh() when the RPC is down
    this._rpcProbeMs = 8000 // hello-probe bound for candidate RPC sockets (tests shrink it)
    this._server = null
    this._assetsDrive = null
    this._epgDrive = null // sparse replica of the CURRENT guide epoch drive (meta/epgKey)
    this._epgDiscovery = null
    this._epgKeyHex = null // the drive key _epgDrive was opened by — the swap detector
    this._epgWatcher = null
    this._feedDrive = null // the CURRENTLY served feed (one of _feeds' drives)
    this._activeFeedKey = null // its _feeds key — _trimFeeds must never evict this one
    // Cache bound. Big enough that surfing a category and coming back is still instant
    // (zapPrefetch warms neighbours either side), small enough that browsing a 300-channel
    // catalogue cannot leave hundreds of drives + swarm topics open. See _trimFeeds.
    this._feedLimit = 12
    this._feedDiscovery = null
    this._feeds = new Map() // feedKey:encKey -> Promise<{ drive, discovery }> — opened feeds (single-flight), reused across resolve()s
    // streamId -> newest feedKey seen in the replicated catalog (fed by _currentChannel).
    // The feed cache is keyed by the CURRENT feedKey, while _entitled holds the LOGIN
    // SNAPSHOT — which a broadcaster restart rotates out from under us. Callers that can
    // await simply re-read the catalog; the /feedthumb route cannot (it resolves
    // synchronously — see _thumbTarget), so it reads this instead.
    // LIFETIME: exactly _entitled's. Cleared on login (before the snapshot is rebuilt)
    // and on stop(); a corruption _purge deliberately keeps BOTH, because the store dying
    // does not invalidate which feedKey a channel is on. Anything that outlives _entitled
    // here is a poisoned cache key, not a stale nicety.
    this._feedKeyLive = new Map()
    this._statusTimer = null
    this._peersLostAt = null // when the ACTIVE live p2p feed's peer count hit zero (see _checkFeedPeers)
    this._rescanDead = null // active play whose tune ladder already surfaced the friendly error — the rescan leaves it alone
    this._assetsOpen = null
    this._epgOpen = null // single-flight open/swap of the guide replica
    // --- OTA app updates (the panel's updates drive, meta/updatesKey) ---
    this._updatesDrive = null // sparse replica of the updates drive — LAZY, first checkUpdate() only
    this._updatesDiscovery = null
    this._updatesOpen = null // single-flight open (the assets pattern)
    this._updateCheck = null // last 'available' verdict { appId, platform, versionCode, entry } — what downloadUpdate() fetches
    this._updateDownload = null // in-flight download promise (single-flight)
    this._updatesSwept = false // stale-file sweep under <storeDir>/updates ran (once per engine)
    this._purging = null
    this._replicaSweep = null // single-flight stale-namespace sweep, once per engine (see _sweepStaleReplicas)
    this._streams = []
    // External VOD provider (S53): the panel-delivered config from the last login, or
    // null. The engine only CARRIES it — it never calls the provider (the host app does,
    // directly, with the viewer's own account). null covers both "no record" and
    // "disabled", which is exactly what a host should treat as "no VOD section".
    this._vod = null
    this._entitled = new Map() // streamId -> { feedKey, encryptionKey }
    // --- problem reports (S50c) ---
    // Per-install device identity. Passed to the panel at login so device limits and
    // revocation address THIS install (without it every install of a given account
    // collapses onto one derived fallback id — see sdk/login.js), and folded into the
    // report pseudonym panel-side. Hosts persist it; the engine only carries it.
    this._deviceId = shortLabel(deviceId, 64)
    this._deviceLabel = shortLabel(deviceLabel, 64)
    this._appVersion = shortLabel(appVersion)
    this._platform = shortLabel(platform)
    // The live session: kept so report() can prove entitlement without a re-login.
    // { username, token, expiresAt, deviceId, remoteSecret, handover } — a panel-signed
    // bearer credential plus, since the send-to-TV work, the account key material a
    // handover needs. It lives in memory only and dies with stop().
    //
    // `handover` IS THE ACCOUNT — the X25519 and Ed25519 private keys a login recovers
    // (sdk/login.js, opt-in). It is the most sensitive thing this engine holds: never
    // written to disk, never emitted, never handed to a host, and read by exactly one
    // caller, sendSignIn(). Everything else on this object is already scoped that way;
    // this one is called out because a future "let hosts read the session" convenience
    // would quietly publish it. It is ABSENT unless the build opted in — see
    // normalizeRemote(); a TV-only build never materializes it at all.
    this._session = null
    // The running phone->TV sign-in handover on THIS device (TV role), or null. One at a
    // time: two live codes on one screen is not a product, and two would race for the
    // same swarm topic handler.
    this._signin = null
    // …and the in-flight marker for the window BEFORE _signin exists. startSignInPairing
    // awaits a store open and an Argon2id before it has a handle to store, so the guard
    // and the assignment are ~70 ms apart — long enough for a second D-pad press to walk
    // straight through a `if (this._signin)` test. Set synchronously; see the method.
    this._signinStarting = null
    // The phone half, same shape and same reasoning: the running sendSignIn() handle and
    // its in-flight marker. Tracked on the engine (rather than left as a floating promise)
    // so that a Cancel button and stop() can both reach it.
    this._sending = null
    this._sendingStarting = null
    // resolve() of the pending "is this the right service / account?" answer on the TV,
    // while _applySignIn waits for it. See confirmSignInService().
    this._signinConfirm = null
    // --- "play on my TV" (sdk/remote-control.js) ---
    // The running account-rendezvous session, or null. One at a time and one role at a
    // time: two would want the same protomux protocol on the same sockets, and a device is
    // either the television or the thing pointed at it.
    this._remoteCtl = null
    // …and the marker for the window BEFORE the handle exists, for the same reason
    // _signinStarting has one: startRemote() awaits a store open first. Set synchronously.
    this._remoteCtlStarting = null
    // Rolling breadcrumb ring (newest last, REPORT_EVENT_LIMIT entries) fed from
    // emit() — what the engine was complaining about just before the viewer reported.
    // NOT `_events`: that name is the Emitter's listener map (see the class above), and
    // taking it would silently unregister every host listener.
    this._eventRing = []
    this._lastPeers = null // newest 'peers' count, attached to a report
    // Client-side flood control (S50-DESIGN D2 layer 1): channel|category -> epoch ms
    // until which a repeat is refused locally. Bounded — see _armReportCooldown.
    this._reportCooldown = new Map()
  }

  // --- diagnostics ring (problem reports, S50c) ---

  // Every engine event passes through here, so the breadcrumb ring is fed AT the emit
  // sites — all of them, including ones added later — instead of by a dozen hand-placed
  // calls that a future edit would forget. Only the five diagnostic events are recorded:
  // 'peers' and 'streams' fire on a timer / on every catalog edit and would flush the
  // ring of everything that matters, so 'peers' is sampled into _lastPeers instead.
  // Recording can never affect delivery — a bad detail must not swallow an 'error'.
  emit (name, ...args) {
    try { this._recordEmit(name, args[0]) } catch {}
    return super.emit(name, ...args)
  }

  _recordEmit (name, arg) {
    if (name === 'peers') { if (Number.isFinite(arg)) this._lastPeers = arg; return }
    switch (name) {
      case 'error':
      case 'recovered':
        return this._recordEvent(name, String((arg && arg.message) || arg || ''))
      case 'status':
        return this._recordEvent(arg && arg.state ? String(arg.state) : 'status', arg && arg.message ? String(arg.message) : null)
      case 'fallback':
        return this._recordEvent('fallback', `${arg && arg.streamId} (${arg && arg.reason})`)
      case 'source-changed':
        return this._recordEvent('source-changed', `${arg && arg.streamId} -> ${arg && arg.source}`)
    }
  }

  // Append one breadcrumb. Detail is truncated AT RECORD TIME (not at send time) so a
  // pathological error message can never make the ring itself expensive to hold.
  _recordEvent (type, detail) {
    const d = shortLabel(detail, REPORT_EVENT_DETAIL_MAX)
    this._eventRing.push({ t: Date.now(), type: shortLabel(type, 40) || 'event', detail: d })
    if (this._eventRing.length > REPORT_EVENT_LIMIT) this._eventRing.splice(0, this._eventRing.length - REPORT_EVENT_LIMIT)
  }

  // --- public API ---

  // Join the panel's topic and replicate its signed DB. Resolves once the topic is
  // joined (the actual socket dials in the background — login retries cover the gap).
  async connect (panelPubKey) {
    if (panelPubKey) this._panelKey = panelPubKey
    if (!this._panelKey) throw new Error('no panelPubKey configured')
    await this._recover(() => this._openPanel())
    this.emit('ready')
  }

  // OPRF login. Returns (and caches, and emits as 'streams') the DISPLAY list: id,
  // title, description, category, isLive, poster/backdrop/logo as localhost URLs —
  // stream keys stay inside the engine. Throws on failure ('not connected to panel'
  // is the transient one while the swarm dials).
  async login (username, password) {
    return this._publishLogin(await this._recover(() => this._doLogin(username, password)))
  }

  /**
   * The same session, entered with the ACCOUNT KEYS instead of a password — the door a
   * television comes back through after a restart, holding what a 'signin-keys' event
   * gave it. Resolves to the same display list login() does, and emits 'streams' the
   * same way, so a host cannot tell the two apart downstream.
   *
   * THIS IS NOT A SECOND AUTHENTICATION PATH. It runs sdk/login.js loginWithKeys, which
   * does the whole ordinary round — proof-of-work, the panel's throttle, the account
   * status check, the device registration, maxDevices, and a panel-signed token bound to
   * THIS device's id. An operator who disables the account, rotates its password or
   * refuses the device limit stops this exactly as they stop a typed login; what they do
   * NOT stop with it is a device that still holds working keys, which is the same thing
   * that is true of a device holding a saved password (docs/security-model.md).
   *
   * WHAT A CALLER MUST DO WITH A REJECTION. Tell the two apart and act differently:
   *
   *   transient   'not connected to panel', a closed channel, a swarm still dialling —
   *               keep the stored material and try again.
   *   terminal    anything the PANEL said (a failed `session`), 'unknown user', or
   *               'key handover does not match this account' (which is what a password
   *               rotation looks like from here, because the panel mints a NEW keypair) —
   *               ERASE the stored material. Keys that no longer work are no longer a
   *               convenience, only a liability sitting on a disk.
   *
   * @param {string} username
   * @param {object} keys  { priv, authPriv } exactly as 'signin-keys' delivered them
   *                       (hex or buffers: X25519 secret 32 bytes, Ed25519 secret 64).
   */
  async signInWithKeys (username, keys) {
    return this._publishLogin(await this._recover(() => this._doLoginWithKeys(username, keys)))
  }

  // What every way into a session does once the display list exists — the password
  // login above and the key handover a TV completes (_applySignIn). Shared so a second
  // door cannot quietly skip the prewarm or the orphan sweep.
  _publishLogin (streams) {
    this._streams = streams
    // Second argument (S53): the panel-delivered VOD provider config, or undefined.
    // Additive — every existing listener takes one argument and is untouched.
    this.emit('streams', streams, this._vod || undefined)
    if (this._prewarmN) this.prewarm().catch(() => {}) // background warm the lineup — never blocks login
    this._sweepStaleReplicas() // background disk sweep of catalog-orphaned replicas — never blocks or fails login
    return streams
  }

  // Open + join entitled feeds ahead of play so the FIRST zap to a channel is warm: the
  // cold DHT lookup + peer handshake happen now, in the background, instead of on the
  // play path. Best-effort and idempotent (reuses the feed cache) — safe to call again.
  // Sparse replication means this warms the CONNECTION, not a full download: segments
  // still only transfer when a feed is actually served, so the bandwidth cost is small.
  async prewarm () {
    const n = this._prewarmN
    if (!n || this._hybrid.mode === 'cdn-only' || !this._entitled.size) return
    // Warm lowest curated order first (viewers start at ch1 and zap up); fall back to
    // login order for uncurated streams.
    const ids = this._curatedIds().slice(0, n === Infinity ? undefined : n)
    await Promise.all(ids.map(async (id) => {
      try {
        const k = this._entitled.get(id)
        if (!k || !k.encryptionKey) return
        const feedKey = await this._currentFeedKey(id, k.feedKey)
        if (feedKey) await this._openFeed(feedKey, k.encryptionKey)
      } catch { /* prewarm is best-effort; a real play will retry */ }
    }))
  }

  // Entitled stream ids in curated zap order (lowest `order` first, login order as
  // the tie-break) — the order the app's CH+/CH- zap walks.
  _curatedIds () {
    const rank = new Map(this._streams.map((s, i) => [s.id, (s.order ?? 1e9) * 1e6 + i]))
    return [...this._entitled.keys()].sort((a, b) => (rank.get(a) ?? 1e15) - (rank.get(b) ?? 1e15))
  }

  // --- viewer problem reports (S50c) ---

  /**
   * Send a pseudonymous problem report to the panel. NEVER throws and never rejects:
   * a UI awaits it and switches on the result, because there is no sane thing for a
   * "Report a problem" button to do with an exception. Resolves to
   *   { ok:true, id?, count?, collapsed?, shed? }  or  { error, retryAfter? }
   * with these error codes:
   *   'bad-category'   the category is not one of REPORT_CATEGORIES (a host bug)
   *   'not-logged-in'  no session token yet (report before login)
   *   'offline'        no live panel socket, or the call failed in transit
   *   'cooldown'       local per-channel+category limiter (retryAfter seconds)
   *   'locked'         the panel's per-reporter throttle (retryAfter seconds)
   *   'unsupported'    the panel has no `report` responder: a pre-S50 deployment, or
   *                    one with REPORTS_RETENTION_DAYS=0. Say so kindly; do not retry.
   *   'unauthorized' / 'expired'  the session died (device revoked, account disabled) —
   *                    the host should route back to Login
   * `collapsed`/`shed` are honest acknowledgements from a panel under a report storm:
   * the report counted toward the alert but was not stored individually. Show the same
   * "thanks, we know" to the viewer — telling them their report was deduplicated would
   * be noise, and inviting a retry is the opposite of what an outage needs.
   */
  async report ({ category, text } = {}) {
    try {
      if (!REPORT_CATEGORIES.includes(category)) return { error: 'bad-category' }
      if (!this._session || !this._session.token) return { error: 'not-logged-in' }
      if (!this._call) {
        // No discovery = connect() never joined the panel topic — genuinely offline,
        // nothing can re-arm. Otherwise: a report is exactly the call a viewer makes
        // right after trouble, i.e. right when the panel link may have just flapped.
        // The swarm redials the topic on its own; kick the discovery and give the
        // validated re-arm (_maybeArmRpc) a bounded moment before declaring offline.
        // The UI is already showing "Sending…", so a few seconds here is honest.
        if (!this._panelDiscovery) return { error: 'offline' }
        try { this._panelDiscovery.refresh({ client: true, server: false }) } catch {}
        const t0 = Date.now()
        while (!this._call && Date.now() - t0 < 5000) await new Promise((resolve) => setTimeout(resolve, 250))
        if (!this._call) return { error: 'offline' }
      }

      const channel = this._active ? this._active.streamId : null
      const key = (channel || '-') + '|' + category
      const now = Date.now()
      const until = this._reportCooldown.get(key) || 0
      if (now < until) return { error: 'cooldown', retryAfter: Math.ceil((until - now) / 1000) }

      const body = {
        token: this._session.token,
        category,
        // The panel caps and control-strips this too (a client cannot bypass it); the
        // cap here keeps an oversized paste from making the request fail the 16 KiB
        // pre-parse gate and lose the whole report.
        text: typeof text === 'string' && text.trim() ? text.trim().slice(0, REPORT_TEXT_MAX) : undefined,
        channel: channel || undefined,
        appVersion: this._appVersion || undefined,
        platform: this._platform || undefined,
        peers: Number.isFinite(this._lastPeers) ? this._lastPeers : undefined,
        events: this._eventRing.slice(-REPORT_EVENT_LIMIT)
      }

      let res
      try {
        res = await this._call('report', body)
      } catch (err) {
        // A panel without the responder answers protomux-rpc's UNKNOWN_METHOD — the
        // pre-S50 case, and the reports-disabled case, are indistinguishable on the
        // wire and mean the same thing to a viewer.
        const code = err && err.code
        const msg = String((err && err.message) || err)
        if (code === 'UNKNOWN_METHOD' || /unknown method/i.test(msg)) return { error: 'unsupported' }
        return { error: 'offline' }
      }
      if (!res || typeof res !== 'object') return { error: 'offline' }
      if (res.error) {
        const out = { error: String(res.error) }
        if (Number.isFinite(res.retryAfter)) out.retryAfter = res.retryAfter
        // A panel-side throttle lock is also a local cooldown: keep quiet for the
        // window it named instead of letting the UI retry into a closed door.
        if (res.error === 'locked' && Number.isFinite(res.retryAfter)) this._armReportCooldown(key, res.retryAfter * 1000)
        return out
      }
      // Accepted (stored, deduped, collapsed or shed — all of them "we heard you").
      this._armReportCooldown(key, Number.isFinite(res.cooldown) ? res.cooldown * 1000 : REPORT_COOLDOWN_MS)
      const out = { ok: true }
      if (typeof res.id === 'string') out.id = res.id
      if (Number.isFinite(res.count)) out.count = res.count
      if (res.collapsed) out.collapsed = true
      if (res.shed) out.shed = true
      return out
    } catch (err) {
      // Belt and braces: report() is called straight from a UI handler, and an engine
      // in a broken state must degrade to a toast, not an unhandled rejection.
      return { error: 'offline', detail: String((err && err.message) || err) }
    }
  }

  // Arm (and bound) the local cooldown map. The key space is channel×category, so a
  // viewer zapping a 300-channel lineup could otherwise accumulate 2000+ entries in a
  // session; past the cap the oldest-armed keys are dropped (Map preserves insertion
  // order, and an evicted key at worst lets one extra report through).
  _armReportCooldown (key, ms) {
    this._reportCooldown.delete(key)
    this._reportCooldown.set(key, Date.now() + Math.max(0, ms))
    const CAP = 200
    while (this._reportCooldown.size > CAP) {
      const oldest = this._reportCooldown.keys().next().value
      this._reportCooldown.delete(oldest)
    }
  }

  // --- phone -> TV sign-in handover (sdk/signin-pair.js) ---
  //
  // Two halves of one feature, on one engine because the phone app and the TV app are
  // the same codebase. The protocol, the proofs and the one-shot rules all live in
  // signin-pair.js; what is here is the engine plumbing — borrowing the swarm, turning
  // the module's state callbacks into 'signin-pair' events, and turning a received
  // payload into an actual session.
  //
  // THREE OF THE STATES ARE QUESTIONS. This feature moves an entire account between two
  // devices, and it asks the viewer three times before it does: the phone asks whether the
  // two screens show the same four digits (confirmSignInMatch), the TV asks for the four
  // digits the phone drew (submitSignInPin), and the TV asks whether it should join this
  // service as this account (confirmSignInService). Each one BLOCKS. A host that renders
  // the states as progress notifications and never answers gets timeouts, which is the
  // correct failure — none of the three has a default, and none may be answered by the
  // engine on the viewer's behalf.
  //
  // WP2b wires the worklet IPC and the screens on top of these methods. Note before
  // starting: the RN backend's debug logger prints short IPC lines verbatim, and every
  // message this feature sends is short. The code, the compared digits and the typed
  // digits are all live secrets — exclude the channel from that logger.

  /**
   * TV role. Mint a sign-in code, announce its rendezvous and wait for a phone. Resolves
   * as soon as the code exists — the viewer is looking at the screen — with the rest
   * reported through 'signin-pair' events:
   *
   *   {role:'tv', state:'code', code, expiresAt}   put this on the screen
   *   {role:'tv', state:'linked'}                  a phone proved it holds the code
   *   {role:'tv', state:'match', sas}              DISPLAY these four digits beside the
   *                                                code. The viewer confirms them on the
   *                                                phone; this device is not asked and
   *                                                must not offer its own yes/no.
   *   {role:'tv', state:'pin-entry'}               ask for the phone's digits; feed them
   *                                                to submitSignInPin()
   *   {role:'tv', state:'confirm-service',
   *    username, panelPubKey, pairingCode,
   *    adopting}                                   ASK: sign in as `username` (and, when
   *                                                `adopting`, join this service)? The
   *                                                answer goes to confirmSignInService().
   *   {role:'tv', state:'signed-in', username}     done — 'streams' has already fired
   *   {role:'tv', state:'failed', reason}          over; a new code is the only way on
   *
   * The 'match' and 'pin-entry' screens can be one screen: "does your phone show 4821?"
   * above "type the code your phone is showing". They remain two distinct checks and both
   * have to pass (core/remote.js explains which attacker each one catches).
   *
   * `done` is the same outcome as a promise (the display list, or a rejection) for hosts
   * that would rather await than listen. It is pre-caught, so ignoring it is safe.
   *
   * This device does NOT need to be connected to a panel first: the payload carries the
   * operator's key, so a TV straight out of the box can be signed in without also being
   * paired. If it IS already connected, the incoming account must belong to the same
   * service — adopting another operator mid-engine would leave every open replica and
   * the served catalog pointing at the previous one.
   */
  async startSignInPairing (opts = {}) {
    if (this._signin || this._signinStarting) throw new Error('a sign-in code is already showing on this device')
    // SYNCHRONOUS, before the first await. Opening the store and deriving the code cost
    // ~70 ms of Argon2id between the guard above and the assignment below, and a D-pad
    // double-press inside that window used to produce a second handle with its own live
    // announce and TTL timer that nothing — not submitSignInPin, not cancel, not stop —
    // could ever reach again.
    const inflight = { cancelled: false }
    this._signinStarting = inflight
    let handle = null
    try {
      await this._ensureStore() // the swarm, and only the swarm — no panel needed yet
      // A stop() that interleaved with that await has nulled the swarm, and passing null
      // to receiveSignIn() does not fail — it QUIETLY BUILDS ITS OWN on the public DHT,
      // which would announce a live sign-in topic where a caller running on a private
      // testnet (or a private DHT) never asked it to.
      if (!this._swarm) throw new Error('the engine was stopped before the sign-in could start')
      handle = await receiveSignIn({
        swarm: this._swarm,
        ttlMs: opts.ttlMs,
        pinMs: opts.pinMs,
        payloadMs: opts.payloadMs,
        onState: (s) => this.emit('signin-pair', { role: 'tv', ...s })
      })
    } finally {
      if (this._signinStarting === inflight) this._signinStarting = null
    }
    // Cancelled (or stopped) while we were minting it. The handle exists and is already
    // announcing, so it has to be torn down rather than dropped.
    if (inflight.cancelled) {
      try { handle.cancel() } catch {}
      throw new Error('the sign-in was cancelled before the code was ready')
    }
    this._signin = handle
    const done = handle.result
      .then((payload) => this._applySignIn(payload))
      .catch((err) => {
        // A failure that came from the PROTOCOL has already emitted its own 'failed'
        // state with an accurate reason; one from applying the payload has not.
        //
        // `instanceof`, not `err.code`. Half the errors in this codebase carry a `.code`
        // — sdk/recover.js lists EPARTIALREAD, OPLOG_CORRUPT and INVALID_CHECKSUM, and
        // withRecovery re-throws them unchanged on a second failure — so a TV with a
        // truncated replica store used to fail recovery, satisfy a truthy `.code`, emit
        // nothing at all, and leave the host on "signing in…" for ever.
        if (!(err instanceof SigninPairError)) {
          this.emit('signin-pair', { role: 'tv', state: 'failed', reason: SIGNIN_PAIR_ERRORS.refused, message: signinFacingMessage(err) })
        }
        throw err
      })
      .finally(() => {
        if (this._signin === handle) this._signin = null
        this._signinConfirm = null
      })
    done.catch(() => {}) // a host may only be listening to events
    return { code: handle.code, expiresAt: handle.expiresAt, done }
  }

  /**
   * TV role. The digits the viewer typed on the remote. Returns false for anything that
   * is not four digits, or when nothing is waiting for them — so a UI can validate as it
   * goes. A well-formed submission is FINAL: right or wrong, it is the only answer this
   * handover sends, and a wrong one ends the sign-in with the code already spent. That
   * is the whole security of the digits (core/remote.js remotePinProof): one attempt is
   * what makes a blind guess one in ten thousand instead of a warm-up.
   *
   * This is CHECK TWO of two, and it is not the one that catches a peer relaying between
   * this TV and the phone — that is the compared 'match' digits, answered on the phone.
   */
  submitSignInPin (pin) {
    return this._signin ? this._signin.submitPin(pin) : false
  }

  /**
   * TV role. The viewer's answer to the 'confirm-service' question. True adopts; anything
   * else refuses, and the code is spent either way.
   *
   * WHY THIS EXISTS AT ALL. The handover carries `panelPubKey`, so a TV that has never
   * been paired learns its operator from it — that is the feature working as designed. It
   * is also, without this answer, an operator key adopted as the silent consequence of
   * four digits: nothing in the protocol authenticates the SENDER to the receiver beyond
   * knowledge of a code that was read off this device's own screen, and the shape check
   * on the payload only says the key is 32 bytes. A peer that can see the screen could
   * therefore point a virgin TV at a panel of its choosing, which then serves whatever
   * catalog it likes — including redirect channels with arbitrary URLs and headers. So
   * the key is shown to the viewer, as the operator's 12-character pairing code
   * (core/pairing.js — the thing that is printed on a card), and it is not adopted until
   * a human says yes.
   *
   * Returns false when there is nothing to answer.
   */
  confirmSignInService (ok) {
    if (!this._signinConfirm) return false
    const r = this._signinConfirm; this._signinConfirm = null
    r(ok === true)
    return true
  }

  /** TV role. Abandon the code on screen. It is spent either way — mint a new one. */
  cancelSignInPairing () {
    if (this._signinStarting) this._signinStarting.cancelled = true
    if (this._signinConfirm) { const r = this._signinConfirm; this._signinConfirm = null; r(false) }
    if (this._signin) this._signin.cancel()
  }

  /**
   * Phone role. Sign a TV in with the code it is showing.
   *
   * Resolves as soon as the rendezvous is joined, with { done } — the outcome. The
   * exchange itself is reported through 'signin-pair' events:
   *
   *   {role:'phone', state:'searching'}      looking for the TV
   *   {role:'phone', state:'linked'}         a peer proved it holds the code
   *   {role:'phone', state:'match', sas}     SHOW these four digits and ASK whether the
   *                                          TV shows the same. Answer with
   *                                          confirmSignInMatch(). Nothing proceeds until
   *                                          you do, and "no" is the answer that stops a
   *                                          relay — make it as easy to give as "yes".
   *   {role:'phone', state:'pin', pin}       SHOW these four digits; the viewer types them
   *                                          into the TV
   *   {role:'phone', state:'sent'}           the TV took the handover
   *   {role:'phone', state:'failed', reason} over
   *
   * Requires a live session on this device AND a build that opted into `remote.sendToTv`:
   * the payload is the account key material login() recovered, which cannot be
   * reconstructed without the password, and a build that never sends does not keep it.
   */
  async sendSignIn (code, opts = {}) {
    if (!this._remote.sendToTv) throw new Error('this build cannot send a sign-in to a TV — construct the player with { remote: { sendToTv: true } }')
    if (this._sending || this._sendingStarting) throw new Error('a sign-in is already being sent from this device')
    const h = this._session && this._session.handover
    if (!h) throw new Error('sign in on this device before sending a sign-in to a TV')
    if (!h.authPriv) throw new Error('this account has no auth key — it cannot sign a TV in')
    if (!this._panelKey) throw new Error('no panelPubKey configured')
    // The same synchronous marker startSignInPairing() uses, for the same reason: the
    // store open and the code's Argon2id both happen before there is a handle to track.
    const inflight = { cancelled: false }
    this._sendingStarting = inflight
    let handle = null
    try {
      await this._ensureStore()
      if (!this._swarm) throw new Error('the engine was stopped before the sign-in could start') // see startSignInPairing
      handle = await sendSignInHandover(code, {
        username: h.username,
        priv: h.priv,
        authPriv: h.authPriv,
        panelPubKey: this._panelKey
      }, {
        swarm: this._swarm,
        timeoutMs: opts.timeoutMs,
        matchMs: opts.matchMs,
        pinMs: opts.pinMs,
        payloadMs: opts.payloadMs,
        onState: (s) => this.emit('signin-pair', { role: 'phone', ...s })
      })
    } finally {
      if (this._sendingStarting === inflight) this._sendingStarting = null
    }
    if (inflight.cancelled) {
      try { handle.cancel() } catch {}
      throw new Error('the sign-in was cancelled before it started')
    }
    this._sending = handle
    const done = handle.result.finally(() => { if (this._sending === handle) this._sending = null })
    done.catch(() => {}) // a host may only be listening to events
    return { done }
  }

  /**
   * Phone role. The viewer's answer to the 'match' question: do the four digits on this
   * phone appear on the TV? True proceeds to the PIN step; anything else aborts and burns
   * the TV's code. Returns false when there is nothing to answer.
   *
   * This is CHECK ONE of two, and it is the only one in the exchange that sees a peer
   * relaying between the phone and the TV — such a peer holds the code, so it satisfies
   * every MAC here, but it terminates two connections and cannot make two screens agree.
   * Never default this, never infer it from a dismissed dialog, and never let a "skip"
   * answer it.
   */
  confirmSignInMatch (ok) {
    return this._sending ? this._sending.confirmMatch(ok) : false
  }

  /** Phone role. Abandon an in-flight send. The TV's code is spent either way. */
  cancelSendSignIn () {
    if (this._sendingStarting) this._sendingStarting.cancelled = true
    if (this._sending) this._sending.cancel()
  }

  // Turn a received handover into a session. The panel key comes from the PAYLOAD, so
  // this is also where a never-paired TV learns which operator it belongs to — which is
  // exactly why the viewer is asked before any of it is acted on (confirmSignInService).
  async _applySignIn (payload) {
    // Whether this is an ADOPTION (a virgin device taking an operator key it has never
    // seen) or a device that is already committed to this service. Read before anything
    // is changed, because it is what the question on screen is about.
    const configured = this._panelKey ? String(this._panelKey).toLowerCase() : null
    if (configured && configured !== payload.panelPubKey) {
      throw signinFacing('that account belongs to a different service — this device is already connected to another one')
    }
    const adopting = !configured

    // THE GATE. Ask before adopting, and ask before signing in as somebody. Deriving the
    // pairing code costs one Argon2id (~70 ms) and is worth it: 64 hex characters are not
    // something a viewer can check against an operator's card, and 12 Crockford
    // characters are exactly what is printed on one.
    let code = null
    try { code = pairingCode(payload.panelPubKey) } catch {}
    this.emit('signin-pair', {
      role: 'tv',
      state: 'confirm-service',
      username: payload.username,
      panelPubKey: payload.panelPubKey,
      pairingCode: code,
      adopting
    })
    const ok = await new Promise((resolve) => {
      this._signinConfirm = resolve
      // Bounded, because the alternative is a TV that sits on this screen for ever if a
      // host forgets to answer. Long, because the viewer may be reading a card.
      const t = setTimeout(() => {
        if (this._signinConfirm === resolve) { this._signinConfirm = null; resolve(null) }
      }, SIGNIN_CONFIRM_MS)
      if (typeof t.unref === 'function') t.unref()
    })
    if (ok !== true) {
      throw signinFacing(ok === false
        ? 'the sign-in was refused on this device — nothing was changed'
        : 'nobody confirmed the sign-in on this device — show a new code and start again')
    }

    if (adopting) await this.connect(payload.panelPubKey)
    // The swarm has to find the panel and the account record has to replicate before a
    // login can be attempted. Both are ordinary cold-start waits, and both are bounded:
    // a TV that cannot reach the operator must say so, not spin.
    if (!await this._waitUntil(() => this._call, 30000)) throw signinFacing('could not reach the service — check this device\'s connection')
    if (!await this._waitUntil(() => this._panelBee.get('user/' + payload.username).catch(() => null), 30000)) {
      throw signinFacing('the service has no record of that account yet — try again in a moment')
    }
    const streams = await this._recover(() => this._doLoginWithKeys(payload.username, payload))
    this._publishLogin(streams)
    // The ONE moment this device could keep what it was just given. Everything above ran
    // on a payload that is a local variable and stops existing when this method returns —
    // which is the right default, and is where a build that did not ask for `keepSignIn`
    // stays. A build that DID ask gets the material here, once.
    //
    // ONCE, AND NOTHING WAITS FOR IT. emit() is synchronous and returns the moment the
    // listener yields, so a host that is putting the material somewhere safe — the viewer
    // app's Keystore round trip takes seconds — is still doing it while the line below puts
    // "signed in" on the screen, and this method never learns whether it worked. That is
    // deliberate: a set is signed in for this session either way, and a keeping that failed
    // must not become a sign-in that failed. But it makes this one-shot emit the host's
    // whole supply — there is no second delivery to fall back on — so any retrying worth
    // doing belongs on the host's side of the listener.
    //
    // Deliberately NOT on the 'signin-pair' stream. That stream is relayed verbatim to
    // hosts, screens and (on Android) across an IPC channel a debug build prints; a
    // separate event is what keeps the keys out of everything that already handles it.
    if (this._remote.keepSignIn) {
      this.emit('signin-keys', {
        username: payload.username,
        panelPubKey: payload.panelPubKey,
        priv: payload.priv,
        authPriv: payload.authPriv
      })
    }
    this.emit('signin-pair', { role: 'tv', state: 'signed-in', username: payload.username })
    return streams
  }

  // Poll a predicate to a deadline. Deliberately a poll and not an event: the two things
  // it waits for (a validated panel RPC socket, a replicated bee record) are settled in
  // different layers and neither raises a signal this class can subscribe to.
  async _waitUntil (fn, ms, stepMs = 250) {
    const until = Date.now() + ms
    for (;;) {
      try { const v = await fn(); if (v) return v } catch {}
      if (Date.now() >= until) return null
      await new Promise((resolve) => { const t = setTimeout(resolve, stepMs); if (typeof t.unref === 'function') t.unref() })
    }
  }

  // --- "play on my TV" (sdk/remote-control.js) ---
  //
  // The rendezvous, the mutual proof, the epoch roll and the wire all live in
  // remote-control.js; what is here is the engine plumbing — borrowing the swarm, turning
  // the module's callbacks into 'remote'/'remotes' events, and answering an incoming `play`
  // out of THIS device's own entitlements.
  //
  // WHY THE ENGINE DOES NOT TUNE THE CHANNEL ITSELF, which is the thing to read before
  // "improving" this. It would be one line to call resolve() on an accepted `play`, and it
  // would walk straight around the parental gate: `restricted` channels are PIN-gated by the
  // HOST (the flag rides the display list and every player in this repo hides or challenges
  // on it — see _display), and an engine that tuned one because a phone asked would make
  // "send to TV" the way past a parental PIN. So an accepted `play` is a COMMAND to the host
  // and nothing more: entitlement is checked here, the event carries `restricted`, and what
  // happens next is the host's decision — the same decision it makes for a local zap.
  //
  // NOTHING HERE ROTATES WITH A REVOKED DEVICE. remoteSecret() mixes tokenVersion, so "log
  // out all devices", a password reset and disabling an account all move the whole account
  // to a new rendezvous. panel/src/ops.js revokeDevice() deliberately does NOT bump
  // tokenVersion, so a device revoked one at a time keeps deriving this secret and keeps
  // meeting the household's other devices. That is documented in core/remote.js and it must
  // not be written up as anything else.

  /**
   * Join the account's own rendezvous and run the control channel on it.
   *
   * @param {object} [opts]
   * @param {string} [opts.role]        'tv' (default — announce and accept commands) or
   *                                    'controller' (look up, never announce, send them)
   * @param {string} [opts.label]       what the other devices show for this one
   * @param {boolean} [opts.acceptPlay] TV: accept play/stop at all (default true). The
   *                                    opt-out seam — setRemoteAccept() flips it at runtime.
   * @returns {Promise<{role, topics: string[], flushed: () => Promise<boolean>}>}
   */
  async startRemote (opts = {}) {
    if (!this._remote.control) throw new Error('this build cannot use the account rendezvous — construct the player with { remote: { control: true } }')
    if (this._remoteCtl || this._remoteCtlStarting) throw new Error('a remote session is already running on this device')
    const role = opts.role === REMOTE_CONTROL_ROLES.controller ? REMOTE_CONTROL_ROLES.controller : REMOTE_CONTROL_ROLES.tv
    if (!this._session) throw new Error('sign in on this device before joining the account rendezvous')
    // Null rather than a guess when the account record predates tokenVersion (sdk/login.js
    // says why): two devices that substituted different defaults would land on different
    // topics and simply never meet, which is the hardest failure in this area to diagnose.
    if (!this._session.remoteSecret) throw new Error('this account has no remote rendezvous — its panel record predates tokenVersion')
    // The synchronous marker startSignInPairing() uses, for the same reason: _ensureStore()
    // is an await, and a second press inside it used to produce a second live session.
    const inflight = { cancelled: false }
    this._remoteCtlStarting = inflight
    let handle = null
    try {
      await this._ensureStore()
      // A stop() that interleaved with that await has nulled the swarm, and passing null to
      // startRemoteControl() does not fail — it QUIETLY BUILDS ITS OWN on the public DHT,
      // announcing an account rendezvous where a caller on a private testnet never asked.
      if (!this._swarm) throw new Error('the engine was stopped before the remote session could start')
      handle = startRemoteControl({
        secret: this._session.remoteSecret,
        role,
        swarm: this._swarm,
        acceptPlay: opts.acceptPlay,
        identity: {
          // The host's per-install id when it gave one. Falling back to the login result is
          // deliberate but weak: sdk/login.js derives that fallback from the ACCOUNT key, so
          // every install of one account collapses onto it and two devices become
          // indistinguishable in the picker. Hosts should pass `deviceId` at construction.
          deviceId: this._deviceId || (this._session && this._session.deviceId) || null,
          label: opts.label || this._deviceLabel || null,
          platform: this._platform || null,
          appVersion: this._appVersion || null
        },
        onPeers: (list) => this.emit('remotes', list),
        onPlay: async ({ streamId, from }) => {
          // THE ENTITLEMENT CHECK, against this device's OWN login snapshot. The peer sent a
          // name; everything that could turn a name into bytes — the feed key, the sealed
          // stream key — comes from here and never from the wire.
          if (!this._entitled.has(streamId)) {
            throw new RemoteControlError(REMOTE_CONTROL_ERRORS.unentitled, 'this device is not entitled to ' + streamId)
          }
          const s = this._streams.find((x) => x.id === streamId) || null
          // FAIL CLOSED ON A CHANNEL THIS DEVICE CANNOT DESCRIBE. `_entitled` and `_streams`
          // are different objects and they legitimately disagree: _pushCatalog() rebuilds
          // the display list from records that must READ BACK, so an id whose catalog record
          // has not replicated (or that the operator has just removed) drops out of
          // `_streams` while it stays in `_entitled`; and a re-login fills `_entitled` before
          // _publishLogin() assigns `_streams`, an await apart.
          //
          // In those windows this used to emit `restricted: false` — the DEFAULT, from a
          // record it never found — and the host's parental gate, which keys on exactly that
          // flag, did not fire. A remote `play` is the one path that can name a channel that
          // is not in the display list at all; a local zap cannot, which is why the fail-open
          // mattered here and nowhere else.
          //
          // REFUSED, rather than reported as `restricted: true`, for three reasons. A host
          // with no PIN configured HIDES restricted channels rather than challenging for
          // them (see _display), so `restricted: true` hands it a command it has no defined
          // answer for — the gate would be nominal. A refusal is visible on the phone as a
          // named error the viewer can retry, where a silently-gated play looks like the
          // television ignored them. And both windows are transient and self-healing — a
          // catalog tick, or the end of a login — so the whole cost of refusing is that
          // retry. Reporting a `restricted` value read from no record is a fabrication in
          // either direction; the honest answer is that this device cannot say yet.
          if (!s) {
            throw new RemoteControlError(REMOTE_CONTROL_ERRORS.unavailable, 'this device cannot read the catalog record for ' + streamId + ' right now')
          }
          this.emit('remote', {
            role: 'tv',
            state: 'play',
            streamId,
            // The host must gate this exactly as it gates a local zap — see the note above.
            restricted: s.restricted === true,
            title: s.title,
            from
          })
        },
        onStop: async ({ from }) => {
          this.emit('remote', { role: 'tv', state: 'stop', from })
          // Said now rather than when the host confirms, because the command was accepted
          // and the host is expected to honour it; a host that does something else corrects
          // this with updateRemoteStatus().
          if (handle) handle.publishStatus({ state: REMOTE_STATUS_STATES.stopped })
        },
        onRefused: ({ type, streamId, from, reason }) => {
          this.emit('remote', { role: 'tv', state: 'refused', command: type, streamId, from, reason })
        },
        onStatus: (s) => {
          this.emit('remote', { role: 'controller', state: 'status', from: s.from, status: { streamId: s.streamId, state: s.state, position: s.position } })
        },
        onError: (err) => this.emit('error', err)
      })
    } finally {
      if (this._remoteCtlStarting === inflight) this._remoteCtlStarting = null
    }
    // Stopped (or cancelled) while we were starting. The session is already announcing, so
    // it has to be torn down rather than dropped.
    if (inflight.cancelled) {
      try { await handle.destroy() } catch {}
      throw new Error('the remote session was stopped before it started')
    }
    this._remoteCtl = handle
    // A television that is already playing says so from the first peer that arrives.
    if (role === REMOTE_CONTROL_ROLES.tv) this._noteRemoteStatus()
    // `flushed()` is not awaited here — a controller should start looking immediately, and a
    // television's announce lands a moment later. Hosts that want to show "ready" (and tests
    // that want to order two devices) await it themselves.
    return { role, topics: handle.topics(), flushed: () => handle.flushed() }
  }

  /**
   * The account's other devices on the rendezvous, each having PROVED it holds the account
   * secret: { deviceId, label, platform, appVersion, role }. Empty when no session is
   * running. `deviceId` is the peer's own claim — a handle for a picker, not a credential.
   *
   * THIS IS EVERY DEVICE, NOT EVERY TARGET. Controllers verify each other exactly as a
   * phone and a television do, so two phones on one account each appear in the other's
   * list — which is what a television needs to show the phones watching it. A "send to"
   * picker must FILTER ON `role === 'tv'`: remotePlay() to anything else rejects with
   * 'unknown', because a controller runs no play responder to send to.
   */
  listRemotes () {
    return this._remoteCtl ? this._remoteCtl.peers() : []
  }

  /**
   * Controller role. Ask one of those devices to play a channel. Resolves once it has
   * ACCEPTED — it checked the channel against its own entitlements and told its host to tune
   * — which is not the same as playing: what happened arrives as a `status` push. Rejects
   * with a RemoteControlError whose `.code` is one of REMOTE_CONTROL_ERRORS ('refused' =
   * remote control is switched off there, 'unentitled' = that account cannot show it,
   * 'unknown' = it is not on the list, or is on it and is not a television, 'unavailable' =
   * it took the command and could not carry it out — the CATCH-ALL, most often a catalog
   * record it could not read and would not guess a parental flag from, and never a claim
   * that nothing is broadcasting; 'timeout' = it did not answer, and note that 'timeout'
   * never means it declined).
   */
  async remotePlay (deviceId, streamId) {
    if (!this._remoteCtl) throw new Error('start a remote session first (startRemote)')
    return this._remoteCtl.play(deviceId, streamId)
  }

  /** Controller role. Ask that device to stop. Same error vocabulary as remotePlay(). */
  async remoteStop (deviceId) {
    if (!this._remoteCtl) throw new Error('start a remote session first (startRemote)')
    return this._remoteCtl.stop(deviceId)
  }

  /**
   * TV role. The take-over switch a Settings screen turns off ("let my phone change this
   * television"). Off refuses play AND stop — "may not change my channel" cannot mean
   * "…but may switch it off" — and the attempt still surfaces as
   * {state:'refused',reason:'refused'} so a host can say why nothing happened.
   */
  setRemoteAccept (ok) {
    if (this._remoteCtl) this._remoteCtl.setAcceptPlay(ok !== false)
  }

  /**
   * TV role. Refine what the controllers are told. The engine already publishes the CHANNEL
   * and whether it is playing — it learns that from resolve() — so this is for the two
   * things only the host knows: a pause, and a playhead.
   *
   * A `position` on its own never sends anything (see remote-control.js publishStatus): it
   * is stored and rides the next push some real change caused. That is deliberate, and it is
   * why there is no scrubber on the phone.
   */
  updateRemoteStatus ({ state, position } = {}) {
    if (this._remoteCtl) this._remoteCtl.publishStatus({ state, position })
  }

  /** Leave the rendezvous. Idempotent. */
  async stopRemote () {
    if (this._remoteCtlStarting) this._remoteCtlStarting.cancelled = true
    const handle = this._remoteCtl
    this._remoteCtl = null
    if (handle) { try { await handle.destroy() } catch {} }
  }

  // What is on, from the ENGINE's own view of it — so a viewer who changes channel with the
  // television's own remote updates the phone too, and not only a channel the phone asked
  // for. Called after every resolve(); a no-op with no TV-role session running.
  _noteRemoteStatus () {
    if (!this._remoteCtl || this._remoteCtl.role !== REMOTE_CONTROL_ROLES.tv) return
    const a = this._active
    this._remoteCtl.publishStatus(a
      ? { streamId: a.streamId, state: REMOTE_STATUS_STATES.playing }
      : { streamId: null, state: REMOTE_STATUS_STATES.stopped })
  }

  // --- adjacent-channel prefetch (zapPrefetch option; OFF by default) ---

  _clearZapPrefetch () {
    if (this._zapTimer) { clearInterval(this._zapTimer); this._zapTimer = null }
    this._dropZapRanges()
    this._zapGate = null
  }

  // Drop every standing warm range — the bandwidth-spending half of prefetch —
  // without stopping the loop. A gate suspension calls this so neighbor bytes stop
  // flowing immediately while the tick stays alive to observe recovery.
  _dropZapRanges () {
    for (const { range } of this._zapRanges.values()) { if (range) { try { range.destroy() } catch {} } }
    this._zapRanges.clear()
  }

  // Runtime switch for the app's "Smooth zapping" toggle: swap the config and re-arm
  // (or clear) the warm loop mid-play. Safe with no active play — the next resolve()
  // picks the new setting up.
  setZapPrefetch (v) {
    this._zapPrefetch = normalizeZapPrefetch(v)
    if (this._zapPrefetch && this._active) this._startZapPrefetch()
    else this._clearZapPrefetch()
    this.emit('zap-prefetch', { enabled: !!this._zapPrefetch })
  }

  // Host-supplied network profile (RN NetInfo etc.). On a metered/expensive network
  // the gate suspends prefetch immediately; prewarm connections stay (those are
  // ~free) — only the standing segment replication stops. The ACTIVE stream's
  // full-window read-ahead also narrows to the serve-core default (the
  // liveReadAhead closure in _requestHandler reads this flag per playlist serve).
  // Lifts as soon as the host reports the network cheap again (no clean-run
  // wait: it is not a health signal).
  setNetworkProfile ({ expensive } = {}) {
    this._netExpensive = !!expensive
    if (this._netExpensive && this._zapTimer) this._suspendZap('metered')
  }

  // S25: flip re-seeding at RUNTIME, so a viewer who walks off Wi-Fi onto cellular stops
  // uploading mid-session instead of only at the next app start. Before this, uploadPolicy
  // was fixed at construction (the join mode is set when a topic is joined), and the RN
  // client never set it at all — so every viewer re-seeded on every network, and the
  // metered gate only suspended PREFETCH, never upload.
  //
  // `client` stays TRUE on every re-join: we keep pulling, so **playback never blips**.
  // Only the announce flips — the thing that makes other viewers pull FROM us.
  //
  // ⚠ HONEST LIMIT: this stops us ANNOUNCING, so no new peer discovers us to download
  // from. Connections that already exist are NOT force-closed, because this player cannot
  // tell "a peer I am serving" from "a peer serving me" — hypercore replication is
  // bidirectional over one socket, and closing the wrong one would stall playback, which
  // this feature must never do. Existing peers therefore drain as they disconnect rather
  // than being cut off. Upload falls to zero for NEW peers immediately and to zero overall
  // shortly after; it is not an instantaneous hard stop.
  async setUploadPolicy (policy) {
    const next = normalizeUploadPolicy(policy)
    if (next === this._uploadPolicy) return { policy: next, changed: false, rejoined: 0 }
    this._uploadPolicy = next
    const server = next !== 'client-only'
    // ⚠ Use session.refresh(), NOT swarm.join() again. `join()` on an already-joined
    // topic returns discovery.session(opts) — a NEW session — and sessions are ADDITIVE:
    // PeerDiscovery announces while any session wants server, so re-joining with
    // server:false leaves the original server:true session open and changes nothing.
    // refresh() mutates the existing session and adjusts the discovery's _serverSessions
    // count, which is what actually stops the announce.
    let rejoined = 0
    const sessions = []
    const feeds = await Promise.all([...this._feeds.values()].map((p) => Promise.resolve(p).catch(() => null)))
    for (const f of feeds) if (f && f.discovery) sessions.push(f.discovery)
    if (this._assetsDiscovery) sessions.push(this._assetsDiscovery)
    for (const s of sessions) {
      try { await s.refresh({ server, client: true }); rejoined++ } catch {}
    }
    this.emit('upload-policy', { policy: next, rejoined })
    return { policy: next, changed: true, rejoined }
  }

  get uploadPolicy () { return this._uploadPolicy }

  _suspendZap (reason) {
    const g = this._zapGate
    if (!g) return
    g.cleanSince = null
    if (g.suspended) { g.reason = reason; return } // already paused — just track why
    g.suspended = true
    g.reason = reason
    this._dropZapRanges()
    this.emit('zap-prefetch', { state: 'suspended', reason })
  }

  // While a stream plays, keep the NEWEST segment of the curated-order neighbors
  // replicated so a zap to them starts warm. Re-armed on every resolve() (the
  // neighbor set moves with the active channel), cleared on stop(). Best-effort:
  // a failed warm just retries on the next tick.
  //
  // ADAPTIVE: prefetch must never compete with the playing stream or surprise a
  // viewer on a paid connection, so every tick runs the gate first (see _zapTick):
  //   'metered' — host reported an expensive network (setNetworkProfile);
  //   'stall'   — the ACTIVE playlist stopped advancing for stallMs;
  //   'thin'    — neighbor segments download at < minHeadroom × realtime (headroom
  //               probe in _warmNeighbor), so the pipe cannot carry a second stream.
  // stall/thin hold until the active playlist advances cleanly for resumeMs;
  // metered lifts the moment the network is cheap again.
  _startZapPrefetch () {
    this._clearZapPrefetch()
    const cfg = this._zapPrefetch
    if (!cfg || this._hybrid.mode === 'cdn-only') return
    const a = this._active
    if (!a || !a.feedKey) return // redirect channel active (S23): no local playlist for the gate to watch
    // vod active (S8a): the adaptive gate reads the ACTIVE playlist's advance as
    // playback health, and a finished VOD playlist never advances — the loop would
    // suspend on a false 'stall' within stallMs and never resume. Guarded HERE (not
    // only at resolve()) because setZapPrefetch(true) mid-play calls this directly.
    if (a.vod) return
    const now = Date.now()
    this._zapGate = { suspended: false, reason: null, lastSig: null, lastAdvance: now, cleanSince: now, thinStreak: 0 }
    let busy = false
    const timer = setInterval(() => {
      if (busy || this._zapTimer !== timer || this._active !== a) return
      busy = true
      this._zapTick(a).catch(() => {}).then(() => { busy = false })
    }, cfg.intervalMs)
    this._zapTimer = timer
    this._zapTick(a).catch(() => {}) // first tick now, not one interval late
  }

  async _zapTick (a) {
    const cfg = this._zapPrefetch
    const g = this._zapGate
    if (!cfg || !g || this._active !== a) return
    if (this._netExpensive) { this._suspendZap('metered'); return }
    // Active-stream health: a live playlist rewrites every few seconds, so its
    // signature advancing is the SDK-side proof the viewer's own stream is fed.
    const now = Date.now()
    const sig = await this._boundedSig(900)
    if (sig !== null && sig !== g.lastSig) {
      g.lastSig = sig
      g.lastAdvance = now
      if (!g.cleanSince) g.cleanSince = now
    } else if (now - g.lastAdvance > cfg.stallMs) {
      this._suspendZap('stall')
      return
    }
    if (g.suspended) {
      // 'metered' was handled above, so a suspension here is stall/thin: require a
      // clean advance run of resumeMs before spending bandwidth again.
      if (g.reason !== 'metered' && (!g.cleanSince || now - g.cleanSince < cfg.resumeMs)) return
      g.suspended = false
      g.reason = null
      g.thinStreak = 0
      this.emit('zap-prefetch', { state: 'resumed' })
    }
    await this._warmNeighbors(a)
  }

  async _warmNeighbors (a) {
    const cfg = this._zapPrefetch
    const ids = this._curatedIds()
    const i = ids.indexOf(a.streamId)
    if (i < 0 || ids.length < 2) return
    // Directional: once the viewer's surf direction is known, warm only that side
    // (the channel they came FROM is still warm in the feed cache anyway).
    const dir = cfg.directional ? this._zapDir : 0
    const wanted = new Set()
    for (let k = 1; k <= cfg.neighbors; k++) {
      if (dir >= 0) wanted.add(ids[(i + k) % ids.length])
      if (dir <= 0) wanted.add(ids[(i - k + ids.length) % ids.length])
    }
    wanted.delete(a.streamId)
    // vod titles (S8a) are not channel-surf targets — warming one would download a
    // film's newest segment for a zap that never comes. They keep their slot in the
    // curated order (prewarm still warms their CONNECTIONS, which is ~free and makes
    // first play snappy); only the bandwidth-spending segment warm skips them.
    for (const id of [...wanted]) {
      const k = this._entitled.get(id)
      if (k && k.type === 'vod') wanted.delete(id)
    }
    // Drop warm state for channels that are no longer neighbors (we zapped away).
    for (const [id, s] of this._zapRanges) {
      if (!wanted.has(id)) {
        if (s.range) { try { s.range.destroy() } catch {} }
        this._zapRanges.delete(id)
      }
    }
    await Promise.all([...wanted].map((id) => this._warmNeighbor(id).catch(() => {})))
  }

  // Pull one neighbor's playlist and start a parallel download of its newest
  // segment's blob. Every await is bounded or cached; the drive open reuses the
  // single-flight feed cache (a later zap to this channel shares the same drive).
  async _warmNeighbor (id) {
    const keys = this._entitled.get(id)
    if (!keys || !keys.encryptionKey) return
    const feedKey = await this._currentFeedKey(id, keys.feedKey)
    if (!feedKey) return
    const feed = await this._openFeedWithin(feedKey, keys.encryptionKey, this._tune.timeoutMs)
    if (!feed) return
    let timer
    const buf = await Promise.race([
      feed.drive.get('/index.m3u8'),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2500) })
    ]).catch(() => null).finally(() => clearTimeout(timer))
    if (!buf) return
    const text = b4a.toString(buf)
    const uris = playlistUris(text)
    const path = uris[uris.length - 1]
    if (!path) return
    const prev = this._zapRanges.get(id)
    if (prev && prev.path === path) return // newest segment unchanged — already warm(ing)
    if (prev && prev.range) { try { prev.range.destroy() } catch {} }
    this._zapRanges.set(id, { path, range: null })
    const entry = await feed.drive.entry(path)
    const blob = entry && entry.value && entry.value.blob
    if (!blob || !(blob.blockLength > 0)) return
    const blobs = await feed.drive.getBlobs()
    const range = blobs.core.download({ start: blob.blockOffset, end: blob.blockOffset + blob.blockLength })
    const cur = this._zapRanges.get(id)
    if (cur && cur.path === path) cur.range = range
    else { try { range.destroy() } catch {}; return }
    // Headroom probe: time the segment's arrival. One segment plays for durMs, so
    // downloading it slower than durMs/minHeadroom means the pipe cannot carry a
    // second stream comfortably — two thin samples in a row suspend prefetch via
    // the gate. An already-local blob completes instantly and resets the streak;
    // a destroyed range (suspension, zap-away) rejects and is ignored.
    const durMs = lastSegmentDurationMs(text)
    const t0 = Date.now()
    range.done().then(() => {
      const g = this._zapGate
      const cfg = this._zapPrefetch
      if (!g || !cfg || this._zapRanges.get(id) !== cur) return
      if (Date.now() - t0 > durMs / cfg.minHeadroom) {
        if (++g.thinStreak >= 2) this._suspendZap('thin')
      } else {
        g.thinStreak = 0
      }
    }).catch(() => {})
  }

  // Last display list from a successful login.
  listStreams () { return this._streams }

  // Panel-delivered external VOD provider config (S53) from the last login, or null
  // when the operator has none / has it disabled. Rides the 'streams' emit as a second
  // argument too; this accessor is for hosts that mount after login (the desktop
  // shell's state snapshot).
  vodConfig () { return this._vod }

  // --- OTA app updates ---
  //
  // The panel advertises an updates Hyperdrive under meta/updatesKey ({ key, blobsKey }
  // — blobsKey rides along so repeater mirroring stays a config-only follow-up, the EPG
  // pointer precedent). The drive holds /manifest.json keyed by app id, entries
  // { platform, versionCode, versionName, sha256, size, file, minVersionCode?, notes?,
  // releasedAt }, artifacts under /pkg/. LAZY by design: nothing opens at login — the
  // replica + swarm join happen on the first checkUpdate(). The join is ALWAYS
  // { client:true, server:false }, regardless of uploadPolicy: a viewer must never
  // re-serve bulk APK blobs (a phone uplink is the wrong place for a 100 MB fan-out —
  // operators arm repeaters for that instead), so setUploadPolicy() skips this topic.

  /**
   * Check the panel's updates manifest for a newer build of THIS app. Resolves to
   *   { status:'available', entry, mandatory }  a newer versionCode is published;
   *     mandatory = the running build is below the entry's minVersionCode
   *   { status:'current', entry }   the published versionCode is not newer than ours
   *   { status:'none' }             manifest readable, no entry for this appId+platform
   *                                 (the operator never uploaded one)
   *   { status:'unknown' }          cannot say right now: no updates drive advertised,
   *     or the manifest did not land within the bound (cold replica, no reachable
   *     peer). "Try again later", never an error — only bad ARGUMENTS throw here.
   */
  async checkUpdate ({ appId, platform, versionCode } = {}) {
    if (typeof appId !== 'string' || !appId) throw new Error('checkUpdate needs an appId string')
    if (platform !== 'android' && platform !== 'windows') throw new Error("checkUpdate needs platform 'android' | 'windows'")
    if (!Number.isInteger(versionCode) || versionCode < 0) throw new Error('checkUpdate needs an integer versionCode')
    const manifest = await this._readUpdatesManifest(UPDATE_CHECK_TIMEOUT_MS)
    if (manifest === undefined) return { status: 'unknown' }
    this._sweepUpdatesDir(manifest)
    const entry = manifest ? manifest[appId] : null
    if (!entry || typeof entry !== 'object' || entry.platform !== platform) return { status: 'none' }
    // A junk versionCode must not come back as 'current' with the entry attached —
    // a UI printing entry.versionName would show garbage. Broken publisher == "cannot say".
    if (!Number.isInteger(entry.versionCode)) return { status: 'unknown' }
    if (entry.versionCode <= versionCode) return { status: 'current', entry }
    // A malformed entry (unusable path / no verifiable hash) must never be OFFERED —
    // downloadUpdate() could only fail on it.
    if (typeof entry.file !== 'string' || !UPDATE_BASENAME_RE.test(this._updateBasename(entry.file)) ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(entry.sha256)) return { status: 'unknown' }
    const mandatory = Number.isInteger(entry.minVersionCode) && versionCode < entry.minVersionCode
    this._updateCheck = { appId, platform, versionCode, entry }
    return { status: 'available', entry, mandatory }
  }

  /**
   * Download the update the last 'available' checkUpdate() found: stream the drive
   * file to <storeDir>/updates/<basename>.part with an incremental sha256, verify
   * against the manifest on completion, rename to the final path. Emits throttled
   * 'update-progress' {received,total} and, on success, 'update-ready' {path,entry};
   * resolves to { path, entry }. A failure (unreachable blobs, stalled transfer,
   * sha256 mismatch) deletes the partial file, emits 'update-error' {message} AND
   * rejects with the same error. Single-flight: a second call while one runs returns
   * the same promise. The verified file is a CACHE (it lives with the disposable
   * store): install it promptly — a corruption purge may reclaim it.
   */
  downloadUpdate () {
    if (this._updateDownload) return this._updateDownload
    const check = this._updateCheck
    const run = check
      ? this._doDownloadUpdate(check.entry)
      : Promise.reject(new Error('no update to download — call checkUpdate() first'))
    const p = run.then(
      (res) => { if (this._updateDownload === p) this._updateDownload = null; return res },
      (err) => {
        if (this._updateDownload === p) this._updateDownload = null
        this.emit('update-error', { message: String((err && err.message) || err) })
        throw err
      }
    )
    this._updateDownload = p
    return p
  }

  // Start (or reuse) the localhost server for an entitled stream and return where to
  // point the host's video player. `url`/`source` reflect the ACTIVE source under the
  // hybrid policy (p2p-only: always the localhost URL — pre-hybrid shape unchanged).
  // Redirect channels (S23) return their operator-set https URL with source 'cdn'
  // and no localhost involvement at all.
  async resolve (streamId) {
    const out = await this._resolveStream(streamId)
    // "What's on" follows the ENGINE and not the command that caused it, so a viewer
    // zapping with the television's own remote updates a watching phone exactly as a
    // remote `play` does. One line, one place, and it cannot be forgotten by a future
    // return path added inside _resolveStream. See _noteRemoteStatus().
    this._noteRemoteStatus()
    return out
  }

  async _resolveStream (streamId) {
    const keys = this._entitled.get(streamId)
    if (!keys) throw new Error('not entitled to ' + streamId)
    // Live feeds are SESSION cores under the broadcaster's ephemeral buffer: a
    // restart publishes a fresh feedKey to the catalog while the per-user sealed
    // ENCRYPTION key stays the same. Follow the replicated catalog for the current
    // feedKey (falling back to the login-time value) so viewers survive broadcaster
    // restarts without re-login. A re-KEYED stream (new encryption key) still needs
    // a fresh login — that one is a deliberate access-control boundary.
    const chan = await this._currentChannel(streamId, keys)
    // Redirect channels (S23): the record carries an operator-set https URL viewers
    // play INSTEAD of a P2P feed — no feed open, no swarm join, no watchdogs (there
    // is no replica to heal; remote-URL errors belong to the host player). The live
    // catalog read above means an admin URL edit reaches viewers on their next tune,
    // without a re-login.
    // Record class (S8a): a vod title is a STATIC, finished playlist — it gets the
    // plain P2P serving path below and NONE of the live machinery (see the vod branch
    // after serveFeed). The class rides the live catalog read with the login snapshot
    // as fallback, like feedKey/redirect.
    const isVod = chan.type === 'vod'
    if (chan.redirect && chan.url) {
      this._clearHybridTimers()
      this._clearTuneTimer()
      this._clearZapPrefetch() // no neighbor warming while off P2P — the gate needs an active playlist
      this._active = { streamId, feedKey: null, localUrl: null, cdnUrl: chan.url, source: 'cdn', lastSig: null, lastAdvance: 0 }
      // `headers` rides with the url and ONLY here: it is the provider's hotlink check
      // (Referer/Origin/User-Agent), so it means nothing on a localhost or CDN-template
      // URL and the other returns below stay headers-less. undefined, not null, when the
      // record has none — hosts spread it straight into a player source.
      return { url: chan.url, source: 'cdn', localUrl: undefined, port: undefined, feedKey: null, type: isVod ? 'vod' : 'live', durationSec: isVod ? chan.durationSec ?? null : undefined, headers: chan.headers ?? undefined }
    }
    const feedKey = chan.feedKey
    // A catalog entry can exist before any broadcaster feeds it (feedKey null) —
    // surface that honestly instead of leaking a key-length error from hypercore.
    if (this._hybrid.mode !== 'cdn-only' && (!feedKey || !keys.encryptionKey)) {
      throw new Error(isVod ? 'title is not available right now' : 'channel is not broadcasting right now')
    }
    // Which way is the viewer surfing? An adjacent-channel move sets the prefetch
    // direction (directional zapPrefetch warms only that side); a non-adjacent jump
    // (menu pick) resets to both-sided. Tracked before _active moves on.
    const prevId = this._active && this._active.streamId
    if (prevId && prevId !== streamId) {
      const ids = this._curatedIds()
      const from = ids.indexOf(prevId)
      const to = ids.indexOf(streamId)
      const d = from >= 0 && to >= 0 ? (to - from + ids.length) % ids.length : 0
      this._zapDir = d === 1 ? 1 : d === ids.length - 1 ? -1 : 0
    }
    const cfg = this._hybrid
    this._clearHybridTimers()
    this._clearTuneTimer() // zapping away ends the previous channel's tune watchdog

    if (cfg.mode === 'cdn-only') {
      const url = cfg.cdnUrl(streamId)
      this._active = { streamId, feedKey, localUrl: null, cdnUrl: url, source: 'cdn', lastSig: null, lastAdvance: 0 }
      return { url, source: 'cdn', localUrl: undefined, port: undefined, feedKey, type: isVod ? 'vod' : 'live', durationSec: isVod ? chan.durationSec ?? null : undefined }
    }

    const port = await this.serveFeed(feedKey, keys.encryptionKey)
    const localUrl = `http://127.0.0.1:${port}/index.m3u8`
    // VOD (S8a): serve and stop — none of the live self-heal machinery may arm,
    // because ALL of it keys on the playlist ADVANCING, and a finished VOD playlist
    // never advances: the tune watchdog would read a healthy title as a dead tune
    // and walk its ladder to a false 'error'; the zap-prefetch gate would suspend on
    // an instant false 'stall'; hybrid's stall watchdog would fall back to CDN on
    // play and its recovery probe could never flip back — so vod skips hybrid too
    // and always plays P2P here (cdn-only above still returns the host's own URL,
    // honoring "never open P2P"). What carries vod playback instead: the serving
    // layer's availability wait + Range + progressive bodies, the host player's own
    // error handling, and reconnectActiveFeed() for a host-driven redial (which
    // must not re-arm the live watchdog — see its vod guard).
    if (isVod) {
      this._clearZapPrefetch() // a previous live channel's warm loop must not outlive its play (same as the redirect path)
      this._active = { streamId, feedKey, localUrl, cdnUrl: null, source: 'p2p', vod: true, lastSig: null, lastAdvance: Date.now() }
      return { url: localUrl, source: 'p2p', localUrl, port, feedKey, type: 'vod', durationSec: chan.durationSec ?? null }
    }
    if (cfg.mode === 'p2p-only') {
      this._active = { streamId, feedKey, localUrl, cdnUrl: null, source: 'p2p', lastSig: null, lastAdvance: Date.now() }
      this._startTuneWatchdog()
      this._startZapPrefetch()
      return { url: localUrl, source: 'p2p', localUrl, port, feedKey, type: 'live', durationSec: undefined }
    }

    // hybrid: pick the starting source, then keep watching/probing in the background.
    this._active = { streamId, feedKey, localUrl, cdnUrl: cfg.cdnUrl(streamId), source: null, lastSig: null, lastAdvance: Date.now() }
    if (cfg.start === 'preferCDN') {
      this._active.source = 'cdn'
      this._startRecoveryProbe()
    } else if (await this._waitP2PReady(cfg.readyTimeoutMs)) {
      this._active.source = 'p2p'
      this._startStallWatchdog()
    } else {
      this._active.source = 'cdn'
      this.emit('fallback', { streamId, url: this._active.cdnUrl, reason: 'timeout' })
      this._startRecoveryProbe()
    }
    const url = this._active.source === 'p2p' ? localUrl : this._active.cdnUrl
    this._startZapPrefetch() // warms P2P neighbors regardless of the active source
    return { url, source: this._active.source, localUrl, port, feedKey, type: 'live', durationSec: undefined }
  }

  // Current active source for the last resolve(), or null.
  source () {
    const a = this._active
    if (!a) return null
    return { streamId: a.streamId, source: a.source, url: a.source === 'p2p' ? a.localUrl : a.cdnUrl }
  }

  // Low-level: replicate an encrypted feed by its keys and serve it on localhost with
  // Range support. Returns the port. (resolve() is the entitlement-checked path; this
  // one also powers the dev direct-play IPC message.)
  //
  // Opened feeds are cached by key and REUSED across resolve()s. Zapping back to a
  // channel already served this session must NOT open a second Hyperdrive over the same
  // store namespace — that call's ready() deadlocks against the still-open first drive
  // (the old code leaked it and wedged on the flip-back). Reuse makes a re-zap
  // near-instant: the replica is already warm. Cached feeds keep replicating in the
  // background (their swarm topic stays joined) until stop()/a recovery purge closes
  // them, so recently-watched channels stay ready to zap back to.
  async serveFeed (feedKeyHex, encKeyHex) {
    // feed:open marks a COLD open (nothing cached yet). A prewarmed / recently-served
    // feed skips it — the host player sees only feed:ready, i.e. an instant switch.
    if (!this._feeds.has(feedKeyHex + ':' + encKeyHex)) this.emit('status', { state: 'feed:open' })
    // Bounded open: a wedged open (one that never settles) would otherwise hang
    // resolve() forever AND — through the single-flight cache — poison every retry of
    // this channel until the host restarts. On expiry the cached promise is evicted
    // (so the next attempt re-opens fresh) and the open retries ONCE; a second expiry
    // surfaces to the caller.
    let feed = await this._openFeedWithin(feedKeyHex, encKeyHex, this._tune.timeoutMs)
    if (!feed) {
      this.emit('status', { state: 'feed:retune' })
      feed = await this._openFeedWithin(feedKeyHex, encKeyHex, this._tune.timeoutMs)
    }
    if (!feed) throw new Error(`tune timeout: the feed did not open within ${Math.round(this._tune.timeoutMs * 2 / 1000)}s — try again`)
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    this._activeFeedKey = feedKeyHex + ':' + encKeyHex // the one feed _trimFeeds must never evict
    this._trimFeeds()
    this.emit('status', { state: 'feed:ready' })
    const port = await this._ensureServer()
    // Feed-health ticker for player overlays: how many peers serve the CURRENT feed.
    if (!this._statusTimer) {
      this._statusTimer = setInterval(() => {
        if (!this._feedDrive) return
        const n = this._feedDrive.core.peers.length
        this.emit('peers', n)
        this._checkFeedPeers(n)
      }, 3000)
    }
    return port
  }

  // Open (or return the cached) feed drive for a key pair: replicate it and join its
  // swarm topic. No side effects on the ACTIVE feed or status — serveFeed() makes it
  // current, prewarm() just warms it. SINGLE-FLIGHT: the cache stores the open PROMISE,
  // so a prewarm and a concurrent zap for the same feed share ONE Hyperdrive (opening a
  // second over the same store namespace would deadlock — the very bug this cache fixes).
  // Cached in this._feeds and closed by stop()/purge.
  _openFeed (feedKeyHex, encKeyHex) {
    const cacheKey = feedKeyHex + ':' + encKeyHex
    let feed = this._feeds.get(cacheKey)
    if (!feed) {
      feed = (async () => {
        const drive = await this._recover(async () => {
          await this._ensureStore()
          const d = new Hyperdrive(this._store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
          await d.ready()
          return d
        })
        this._trackReplica(feedKeyHex) // hint file for the stale-namespace sweep (see _sweepStaleReplicas)
        // pull always; announce (re-seed to other viewers) only under 'reseed' policy
        const discovery = this._swarm.join(drive.discoveryKey, { server: this._uploadPolicy !== 'client-only', client: true })
        return { drive, discovery }
      })()
      this._feeds.set(cacheKey, feed)
      // The settled value, hung on the promise itself: /feedthumb resolves SYNCHRONOUSLY
      // (createDriveHandler never awaits resolveTarget), so it needs to tell an open drive
      // from an open still in flight without awaiting. Kept here rather than in a parallel
      // map because it then dies with the cache entry — one fewer thing every eviction
      // path must remember to clear.
      feed.then((f) => { feed.settled = f }, () => {})
      feed.catch(() => { if (this._feeds.get(cacheKey) === feed) this._feeds.delete(cacheKey) }) // drop a failed open so a retry re-opens
    }
    return feed
  }

  // _openFeed bounded by a timeout: null on expiry, after evicting the cached promise
  // so the NEXT attempt re-opens fresh instead of awaiting the same wedged open.
  async _openFeedWithin (feedKeyHex, encKeyHex, ms) {
    let timer
    const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
    try {
      const feed = await Promise.race([this._openFeed(feedKeyHex, encKeyHex), expiry])
      if (!feed) this._evictFeed(feedKeyHex + ':' + encKeyHex)
      return feed
    } finally {
      clearTimeout(timer)
    }
  }

  // Drop a cached open — possibly still PENDING — so the next attempt re-opens fresh,
  // and close the orphaned drive whenever the old open settles. Fire-and-forget:
  // awaiting a wedged open here would recreate the very hang being recovered from.
  // (Until the orphan settles and closes, a fresh open of the SAME feed blocks on the
  // shared store namespace — that block is bounded by the caller's own timeout.)
  // Bound the feed cache. Zapping away destroys a neighbour's download RANGE but keeps
  // its drive open on purpose (a re-zap is then instant) — and before this, nothing ever
  // closed them: browsing 50 channels left 50 open drives, 50 corestore sessions and 50
  // joined swarm topics for the whole session. Measured on a live broadcaster: six
  // contiguous channels held one peer link each, unchanged over 25 minutes with no decay.
  // Bandwidth cost is small (the range is gone), but each lingering topic occupies a slot
  // in that channel's SWARM_MAX_PEERS budget (64 by default), so browse traffic can crowd
  // out actual viewers. Evict oldest-first; the Map preserves insertion order.
  _trimFeeds () {
    if (this._feeds.size <= this._feedLimit) return
    for (const key of [...this._feeds.keys()]) {
      if (this._feeds.size <= this._feedLimit) break
      if (key === this._activeFeedKey) continue // never drop the feed we are serving
      this._evictFeed(key)
    }
  }

  _evictFeed (cacheKey) {
    const feed = this._feeds.get(cacheKey)
    if (!feed) return
    this._feeds.delete(cacheKey)
    Promise.resolve(feed).then((f) => {
      if (!f || !f.drive) return
      if (this._feedDrive === f.drive) { this._feedDrive = null; this._feedDiscovery = null }
      // Eviction (cache overflow / rotation-away / wedged open) purges the replica's
      // STORAGE, not just the handles: drive.purge() (hyperdrive 11) closes the
      // drive and deletes both cores (db + blobs) from disk, so an evicted feed
      // costs zero bytes instead of a stranded namespace forever. stop() and
      // _closeFeeds deliberately do NOT purge — a normal app restart must keep its
      // warm caches; only eviction pays the cold-restart cost. Never throws: a
      // refused purge falls back to the old plain close.
      f.drive.purge().catch(() => { try { f.drive.close().catch(() => {}) } catch {} })
    }).catch(() => {})
  }

  // --- viewer disk bound: replica namespace tracking + stale-namespace sweep ---

  // Corestore cannot enumerate namespaces, so remember every feed namespace this
  // store ever created in a hint file beside it. Best-effort ON PURPOSE: it is a
  // HINT — the sweep only ever purges keys listed here AND gone from the catalog,
  // so a lost/corrupt file means less cleanup, never wrong cleanup. Plain
  // read-modify-write (no atomicity needed for a hint), and every fs call is
  // wrapped: the worklet fs is Bare's and must never throw into an open.
  _replicasPath () { return String(this._storeDir).replace(/[\\/]+$/, '') + '/replicas.json' }

  _readReplicas () {
    try {
      const list = JSON.parse(String(this._fs.readFileSync(this._replicasPath())))
      return Array.isArray(list) ? list.filter((k) => typeof k === 'string' && k) : []
    } catch { return [] }
  }

  _writeReplicas (list) {
    try { this._fs.writeFileSync(this._replicasPath(), JSON.stringify(list)) } catch {}
  }

  _trackReplica (feedKeyHex) {
    try {
      const list = this._readReplicas()
      if (list.includes(feedKeyHex)) return
      list.push(feedKeyHex)
      this._writeReplicas(list)
    } catch {}
  }

  // Purge replica namespaces whose feed is GONE from the catalog. The eviction purge
  // (_evictFeed) bounds the CURRENT session's disk, but a channel deleted or re-keyed
  // while the app was closed leaves its namespace stranded forever — nothing would
  // ever open it again, and corestore cannot enumerate namespaces to find it. The
  // replicas.json hint (see _trackReplica) is the ledger of what exists. Runs once
  // per engine instance, fire-and-forget after a successful login (entitlements and
  // the replicated catalog are known then). CONSERVATIVE by construction — a key is
  // purged only when ALL of these hold:
  //   - it is tracked in the hint file,
  //   - it is not the ACTIVE feed and not in the open-feed cache,
  //   - it is absent from the login entitlements (both snapshot and live catalog
  //     read) AND from every replicated catalog record (any entitlement).
  // Any failure keeps the key tracked for the next sweep; a failure building the
  // keep-set aborts the whole sweep (an incomplete keep-set must never purge).
  // LIMIT (documented in docs/kb/viewer-bandwidth.md): a namespace created before
  // this hint file existed is never swept — the manual store delete in
  // docs/client-build.md stays the recovery path.
  _sweepStaleReplicas () {
    if (!this._replicaSweep) this._replicaSweep = this._doSweepStaleReplicas().catch(() => {})
    return this._replicaSweep
  }

  async _doSweepStaleReplicas () {
    const tracked = this._readReplicas()
    if (!tracked.length || !this._store) return
    const keep = new Set()
    try {
      // Every feedKey any replicated catalog record names (entitled or not).
      for await (const node of this._panelBee.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
        if (node && node.value && node.value.feedKey) keep.add(node.value.feedKey)
      }
      // Login-snapshot keys plus the live catalog view of each entitled stream.
      for (const [id, k] of this._entitled) {
        if (k && k.feedKey) keep.add(k.feedKey)
        const cur = await this._currentFeedKey(id, k && k.feedKey)
        if (cur) keep.add(cur)
      }
    } catch { return } // incomplete keep-set — purge nothing
    for (const cacheKey of this._feeds.keys()) keep.add(cacheKey.slice(0, cacheKey.indexOf(':')))
    if (this._active && this._active.feedKey) keep.add(this._active.feedKey)
    const survivors = []
    for (const keyHex of tracked) {
      if (keep.has(keyHex)) { survivors.push(keyHex); continue }
      try {
        if (!this._store) { survivors.push(keyHex); continue } // purge/stop raced the sweep
        // Minimal open over the namespace, then drive.purge() (ready → close →
        // delete both cores' storage). No encryption key needed — purge is a
        // storage operation. Opening a SECOND drive over an already-open namespace
        // would deadlock, but the keep-set above excludes every open feed.
        const d = new Hyperdrive(this._store.namespace('replica:' + keyHex), b4a.from(keyHex, 'hex'))
        await d.ready()
        await d.purge()
      } catch { survivors.push(keyHex) } // keep it tracked; the next sweep retries
    }
    this._writeReplicas(survivors)
  }

  // Current catalog view of a stream, bounded and fallback-safe. feedKey: follow the
  // replicated catalog (a broadcaster restart publishes a fresh key in RAM-buffer
  // mode), falling back to the login-time value — a readable record with feedKey null
  // (off-air) also falls back, never a spurious rotation. redirect/url (S23): the
  // LIVE record is authoritative when readable (an admin set/edit/clear applies on
  // the next tune); only a failed/timed-out read falls back to the login snapshot.
  // Bounded: on a sparse bee the get() can await blocks from the panel peer, and a
  // dead panel socket would otherwise hang resolve() forever.
  async _currentChannel (streamId, fallback = {}) {
    let timer
    try {
      const node = this._panelBee && await Promise.race([
        this._panelBee.get('catalog/' + streamId),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000) })
      ])
      if (node && node.value) {
        const v = node.value
        const feedKey = v.feedKey || fallback.feedKey || null
        if (feedKey) this._feedKeyLive.set(streamId, feedKey) // the synchronous /feedthumb route's only view of a rotation
        return {
          feedKey,
          redirect: !!(v.redirect && v.url),
          url: v.url || null,
          // Headers follow url exactly: the live record wins with NO snapshot fallback,
          // because they belong to the url we just read. That is what carries a source's
          // half-hourly token rotation (fresh url + fresh headers) to a viewer on the
          // next tune, and it also means a cleared header set really clears. Gated on the
          // url here as well as in the panel's validators: "headers require a url" is an
          // engine invariant too, so a record that somehow breaks it (an older panel, a
          // hand-edited bee) degrades to no headers instead of attaching a provider's
          // hotlink set to whatever the P2P path ends up serving.
          headers: v.url ? (v.headers ?? null) : null,
          type: v.type ?? fallback.type ?? null, // S8a: 'vod' | 'live'
          durationSec: v.durationSec ?? fallback.durationSec ?? null
        }
      }
    } catch { /* replicated catalog momentarily unreadable — use the cached values */ } finally {
      clearTimeout(timer)
    }
    return { feedKey: fallback.feedKey || null, redirect: !!(fallback.redirect && fallback.url), url: fallback.url || null, headers: fallback.url ? (fallback.headers ?? null) : null, type: fallback.type ?? null, durationSec: fallback.durationSec ?? null }
  }

  // feedKey-only shim for the callers that never care about the redirect class
  // (prewarm / neighbor warm / active-feed rotation).
  async _currentFeedKey (streamId, fallback) {
    return (await this._currentChannel(streamId, { feedKey: fallback })).feedKey
  }

  // Catalog art fields hold drive paths like 'assets/<id>/poster.png' (turned into
  // URLs on the local server — undefined until login has started it) OR absolute
  // http(s) URLs (hybrid art: pass through untouched for the host to fetch directly).
  assetUrl (p) {
    if (!p) return undefined
    if (ABSOLUTE_URL_RE.test(p)) return String(p)
    if (!this._server) return undefined
    return `http://127.0.0.1:${this._server.address().port}/${String(p).replace(/^\//, '')}`
  }

  // Full teardown (tests / host shutdown). The worklet never calls this — it dies with
  // the app process.
  async stop () {
    this._clearHybridTimers()
    this._clearTuneTimer()
    this._clearZapPrefetch()
    // A sign-in outliving the engine that ran it would leave a topic announced on a swarm
    // that is about to be destroyed, and a code on a screen nobody answers. Both roles,
    // and both of the windows BEFORE a handle exists: startSignInPairing/sendSignIn spend
    // ~70 ms on an Argon2id before they have anything to store here, and a handle minted
    // after this line would otherwise announce onto a destroyed swarm.
    if (this._signinStarting) { this._signinStarting.cancelled = true; this._signinStarting = null }
    if (this._sendingStarting) { this._sendingStarting.cancelled = true; this._sendingStarting = null }
    if (this._signinConfirm) { const r = this._signinConfirm; this._signinConfirm = null; r(false) }
    if (this._signin) { const s = this._signin; this._signin = null; try { s.cancel() } catch {} }
    if (this._sending) { const s = this._sending; this._sending = null; try { s.cancel() } catch {} }
    // Same reasoning for the account rendezvous, and the same two windows: a session left
    // running would keep a topic announced on a swarm that is about to be destroyed, and one
    // started after this line would announce onto a destroyed one. Awaited, unlike the
    // sign-in cancels, because leaving the topic is a network round-trip and this is the
    // only place that waits for teardown.
    await this.stopRemote()
    this._active = null
    this._zapDir = 0
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const server = this._server; this._server = null
    if (server) { try { await new Promise((resolve) => server.close(resolve)) } catch {} }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} }
    this._closeFeeds() // fire-and-forget close of every opened feed (see _closeFeeds)
    const epgWatcher = this._epgWatcher; this._epgWatcher = null
    if (epgWatcher) { try { await epgWatcher.close() } catch {} }
    const closing = [this._assetsDrive, this._epgDrive, this._updatesDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._epgDrive = this._updatesDrive = this._panelBee = this._store = null
    this._feedDiscovery = null
    this._epgDiscovery = null
    this._epgKeyHex = null
    this._assetsOpen = null
    this._epgOpen = null
    this._updatesDiscovery = null
    this._updatesOpen = null
    this._updateCheck = null // the verdict names an entry on the closed drive — a fresh check must precede a download
    this._call = null
    this._panelPeerKey = null
    this._panelDiscovery = null
    // Full teardown is the ONE place the session dies (a purge and a socket drop both
    // keep it — see _applyLoginResult). A service switch replaces the engine wholesale,
    // so this is also what stops a token — and the account key material behind
    // sendSignIn() — following a viewer to another operator's panel.
    this._session = null
    this._eventRing = []
    this._feedKeyLive.clear() // the catalog view dies with the session (see _doLogin)
    this._reportCooldown.clear()
    this._lastPeers = null
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const c of closing) { if (c) { try { await c.close() } catch {} } }
  }

  // Close every opened feed and drop them from the cache. Fire-and-forget: the cache
  // holds OPEN PROMISES that may still be in flight (and whose _recover() could be
  // awaiting the very purge that calls this) — awaiting them here risks a deadlock, so
  // schedule each close when its open settles instead.
  _closeFeeds () {
    const feedProms = [...this._feeds.values()]
    this._feeds.clear()
    for (const p of feedProms) Promise.resolve(p).then((f) => f && f.drive && f.drive.close()).catch(() => {})
  }

  // --- tune watchdog (p2p-only mode) ---

  _clearTuneTimer () {
    if (this._tuneTimer) { clearInterval(this._tuneTimer); this._tuneTimer = null }
  }

  // resolve() returns as soon as the feed is OPEN; the playlist then replicates in the
  // background while the host player polls the localhost URL. Nothing bounded that
  // replication: a cold feed whose DHT records are stale (the broadcaster restarted
  // since the last lookup; hyperswarm re-queries a client topic only every ~10 min)
  // never finds a peer, the playlist never lands, and the single-flight open cache
  // faithfully hands every retry the same dead open — the viewer spins forever
  // (2026-07-16 S22 incident: a zap sat at "90%" for 10+ min against a healthy VPS;
  // an app restart — fresh swarm, fresh lookup — fixed it). Self-heal instead,
  // mirroring the broadcaster's PanelLink hardening:
  //   - while the tune is incomplete, force discovery.refresh() on a relookup backoff;
  //   - at tune.timeoutMs, evict the cached open and re-open fresh ONCE ('feed:retune');
  //   - at the 2nd expiry, DESTROY the connections serving the feed so the swarm dials
  //     fresh ('feed:reconnect') — the wedged-connection class (see _teardownFeedPeers);
  //   - if that also expires (or no peer was connected to tear down), evict and emit a
  //     friendly 'error' for the host UI — worst case ≤ 3× tune.timeoutMs end to end.
  // "Tuned" means the playlist ADVANCES **and its content is SERVABLE**, not merely
  // that it exists: after a network flap the STALE playlist of a warm/prewarmed feed
  // is already in the local replica, so an existence probe stood the watchdog down on
  // its first tick and the wedge above spun for 15+ min with zero relookups, no
  // retune and no error (the second S22 2026-07-16 incident). And advance ALONE is
  // not enough either: the signature is metadata (the playlist entry's bee seq) while
  // media bytes ride the blobs core — a feed whose metadata replicates while its
  // blobs starve advances the signature with zero playable bytes, so the watchdog
  // stood down and its ladder (retune → teardown → friendly error) never ran for
  // exactly the wedge class it was built for (2026-07-17 acceptance). The stand-down
  // check therefore also demand-reads the CURRENT playlist content (bounded; see
  // _playlistServable). A live playlist rewrites every segment, so on a healthy
  // feed the first advance lands within seconds and the watchdog stands down (the
  // host player takes it from there); it also stands down on the next resolve()/
  // stop(), or when the active play moves off P2P. Hybrid mode needs none of this:
  // _waitP2PReady already bounds the tune and falls back to CDN.
  _startTuneWatchdog () {
    this._clearTuneTimer()
    const a = this._active
    // a.vod (S8a): "tuned" is defined as the playlist ADVANCING, which a finished VOD
    // playlist never does — armed on a healthy title, the ladder would spin relookups
    // and surface a false friendly error at ≤3× timeoutMs. Guarded HERE (not only at
    // resolve(), which never arms it for vod) because reconnectActiveFeed() — the
    // host's stall-escalation hook, useful for a starving vod download too — re-arms
    // the watchdog and must not bring the live machinery with it.
    if (!a || a.vod || a.source !== 'p2p' || this._hybrid.mode !== 'p2p-only') return
    const cfg = this._tune
    const t0 = Date.now()
    let started = t0
    let retuned = false
    let reconnected = false
    let initialSig // first probed signature (possibly a stale playlist, possibly null)
    let relookupDelay = cfg.relookupMinMs
    let nextRelookup = started + relookupDelay
    let busy = false
    const timer = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        if (this._tuneTimer !== timer) { clearInterval(timer); return } // superseded by a newer tune
        if (!this._active || this._active !== a || a.source !== 'p2p') { this._stopTuneTimer(timer); return }
        const sig = await this._boundedSig(900)
        if (initialSig === undefined) initialSig = sig
        // Tuned = the playlist ADVANCED **and its content is actually fetchable**. The
        // signature lives on the metadata core, media bytes on the blobs core, and the
        // two can diverge: a feed whose metadata replicates while zero blob bytes are
        // servable kept the old advance-only check standing down on a viewer that
        // could not play a single byte (the 2026-07-17 acceptance wedge). The content
        // probe re-resolves to the NEWEST version on every call, so it is never pinned
        // to a blob the broadcaster already reclaimed — on a healthy feed it hits the
        // replica the serving layer has already pulled and passes instantly.
        else if (sig !== null && sig !== initialSig && (await this._playlistServable(2000))) { this._stopTuneTimer(timer); return }
        if (this._active !== a) return // zapped away during the probe
        const now = Date.now()
        if (now >= nextRelookup) {
          // Fresh DHT query for the feed topic — a broadcaster re-announced under a new
          // swarm identity is found NOW, not at hyperswarm's ~10-min periodic refresh.
          try { const r = this._feedDiscovery && this._feedDiscovery.refresh(); if (r && r.catch) r.catch(() => {}) } catch {}
          relookupDelay = Math.min(relookupDelay * 2, cfg.relookupMaxMs)
          nextRelookup = now + relookupDelay
        }
        if (now - started < cfg.timeoutMs) return
        if (!retuned) {
          retuned = true
          started = now
          relookupDelay = cfg.relookupMinMs
          nextRelookup = now + relookupDelay
          this.emit('status', { state: 'feed:retune' })
          this._retuneActive(a).catch(() => {})
          return
        }
        if (!reconnected) {
          reconnected = true
          // A retune that changed nothing while peers ARE connected is the wedged-
          // connection class: the pipe is alive at transport level but replication
          // over it is dead, and the fresh open reused it (hyperswarm shares one
          // connection per peer). Destroy those connections and let the swarm dial
          // fresh — topics stay joined, corestore re-replicates on the new socket.
          if (this._teardownFeedPeers() > 0) {
            started = now
            relookupDelay = cfg.relookupMinMs
            nextRelookup = now + relookupDelay
            this.emit('status', { state: 'feed:reconnect' })
            return
          }
          // No peer connected to tear down (truly unreachable) — fail now, not at 3×.
        }
        this._stopTuneTimer(timer)
        const keys = this._entitled.get(a.streamId)
        if (keys && keys.encryptionKey) this._evictFeed(a.feedKey + ':' + keys.encryptionKey)
        // The ladder ran out for THIS play: the zero-peer rescan must not re-arm it
        // in a loop (an unreachable channel would surface the friendly error every
        // ~2× timeoutMs forever). A new resolve() or a host redial retries cleanly.
        this._rescanDead = a
        this.emit('error', new Error(`tune timeout: no video from '${a.streamId}' after ${Math.round((now - t0) / 1000)}s — the channel may be unreachable right now, switch to it again to retry`))
      } finally {
        busy = false
      }
    }, Math.min(1000, cfg.timeoutMs))
    this._tuneTimer = timer
  }

  // Destroy every swarm connection currently serving the ACTIVE feed (dedup'd — one
  // socket usually carries all channels of a peer) and return how many were torn down.
  // This is the recovery for the 2026-07-16 wedge class: a mobile network flap can
  // leave the hyperswarm/UDX connection transport-alive but replication-dead, and
  // because hyperswarm keeps ONE connection per peer across all topics, every
  // evict+retune faithfully reuses the same dead pipe — with prewarm, one wedged
  // broadcaster connection starves every channel at once (the broadcaster is usually
  // the only peer). peer.stream is the raw swarm socket protomux rides on; destroying
  // it makes hyperswarm redial (the topic stays joined) and corestore re-replicates
  // everything on the fresh connection automatically.
  _teardownFeedPeers () {
    const drive = this._feedDrive
    if (!drive || !drive.core || !this._swarm) return 0
    const seen = new Set()
    for (const peer of [...drive.core.peers]) {
      const stream = peer && peer.stream
      if (!stream || seen.has(stream)) continue
      seen.add(stream)
      try { stream.destroy() } catch {}
    }
    return seen.size
  }

  // Public escalation hook for hosts (the <AliranVideo> stall ladder): when a remount/
  // resync did not restore playback, tear down the active feed's connections and dial
  // fresh, then re-arm the tune watchdog (unless one is already mid-cycle — its ladder
  // must keep counting toward the friendly error, not restart) so the recovery is
  // tracked to either "playlist advances" or the friendly 'error'. Safe no-op without
  // an active P2P play.
  reconnectActiveFeed () {
    this._rescanDead = null // a host-driven redial is a fresh chance — let the rescan watch this play again
    const n = this._teardownFeedPeers()
    try { const r = this._feedDiscovery && this._feedDiscovery.refresh(); if (r && r.catch) r.catch(() => {}) } catch {}
    if (n > 0) this.emit('status', { state: 'feed:reconnect' })
    if (!this._tuneTimer) this._startTuneWatchdog()
    return n
  }

  // Active-feed peer RESCAN (the re-source defect, field 2026-07-31): a viewer can
  // tune successfully off relay/repeater peers while every dial to the origin
  // broadcaster FAILS (full accept gate, NAT/holepunch failure, transient network).
  // hyperswarm then parks the origin's PeerInfo after 3 failed retries
  // (hyperswarm/lib/retry-timer.js _selectRetryTimer: attempts > 3 selects NO timer
  // for a non-explicit peer) and garbage-collects it on the final close
  // (hyperswarm/index.js _maybeDeletePeer) — so when the relays later die there is
  // no backoff to expire and nothing left to redial: the swarm simply no longer
  // knows the origin announces the topic, and its own periodic re-lookup is ~10-12
  // minutes away (hyperswarm/lib/peer-discovery.js REFRESH_INTERVAL + jitter). The
  // tune watchdog stood down long ago (the relays tuned fine), so post-tune the
  // engine was blind to the peer set collapsing: the viewer plays out its local
  // window, then freezes source-less with no relookup, no retune and no error.
  // Watch the peer set from the 3-second peers ticker instead: when an active LIVE
  // p2p play has had ZERO peers for tune.rescanMs, force a fresh DHT lookup NOW —
  // a lookup re-discovers a parked or forgotten announcer and re-enqueues the dial
  // (hyperswarm/index.js _handlePeer resets a de-prioritized peer) — and re-arm the
  // tune watchdog so recovery is tracked to either "playlist advances + servable"
  // or the friendly 'error', exactly like the tune-time ladder. While a watchdog is
  // already running it owns recovery (its relookup backoff covers refreshes), so
  // this stays quiet. tune.rescanMs = 0 disables (the pre-fix behavior).
  _checkFeedPeers (n) {
    const a = this._active
    if (!this._tune.rescanMs || !a || a.vod || a.source !== 'p2p' || this._hybrid.mode !== 'p2p-only' || this._tuneTimer || this._rescanDead === a) {
      this._peersLostAt = null
      return
    }
    if (n > 0) { this._peersLostAt = null; return }
    const now = Date.now()
    if (this._peersLostAt === null) { this._peersLostAt = now; return }
    if (now - this._peersLostAt < this._tune.rescanMs) return
    this._peersLostAt = null
    this.emit('status', { state: 'feed:rescan' })
    try { const r = this._feedDiscovery && this._feedDiscovery.refresh(); if (r && r.catch) r.catch(() => {}) } catch {}
    this._startTuneWatchdog()
  }

  // Stop THIS watchdog without killing a newer one that may have replaced it while an
  // async tick was in flight.
  _stopTuneTimer (timer) {
    clearInterval(timer)
    if (this._tuneTimer === timer) this._tuneTimer = null
  }

  // Blob-layer half of "tuned"/"healthy" (tune watchdog + hybrid stall/recovery
  // probes): bounded read of the CURRENT playlist's CONTENT.
  // drive.get re-resolves the newest version each call and demand-fetches its blob,
  // so this proves the bytes a player needs are actually arriving — true iff the
  // content lands within the bound AND references at least one media URI (a
  // header-only playlist is not playable yet). On a healthy feed the blob is
  // usually already local (the serving layer pulled it for the host player), so
  // the probe is a cache hit; only a genuinely starved blob channel keeps failing,
  // which is exactly when the watchdog must stay armed so its ladder (retune →
  // connection teardown → friendly error) can run.
  async _playlistServable (ms) {
    let timer
    try {
      const drive = this._feedDrive
      if (!drive) return false
      const buf = await Promise.race([
        drive.get('/index.m3u8'),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
      ])
      return !!buf && playlistUris(b4a.toString(buf)).length > 0
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // _playlistSig bounded: while a peer is flapping, a sparse metadata read CAN block
  // (the bee knows blocks exist that it cannot fetch) — treat a slow probe as "not
  // landed yet" instead of parking the watchdog on the await.
  async _boundedSig (ms) {
    let timer
    try {
      return await Promise.race([
        this._playlistSig(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  // Evict + close the active tune's cached feed, then open it FRESH — a new Hyperdrive
  // plus a fresh swarm lookup. The stale drive must be fully closed before the new
  // ready(): two open drives on one store namespace deadlock (the single-flight cache
  // exists for exactly that). If the old open is itself wedged (never settles), this
  // parks on the await and the watchdog's second expiry surfaces the error instead.
  async _retuneActive (a) {
    const keys = this._entitled.get(a.streamId)
    if (!keys || !keys.encryptionKey) return
    const cacheKey = a.feedKey + ':' + keys.encryptionKey
    const pending = this._feeds.get(cacheKey)
    this._feeds.delete(cacheKey)
    try {
      const f = await pending
      if (f && f.drive) {
        if (this._feedDrive === f.drive) { this._feedDrive = null; this._feedDiscovery = null }
        await f.drive.close()
      }
    } catch {}
    if (this._active !== a) return // zapped away while closing — that resolve owns the serving slot now
    const feed = await this._openFeed(a.feedKey, keys.encryptionKey)
    if (this._active !== a) return
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    a.lastSig = null
    a.lastAdvance = Date.now()
  }

  // --- hybrid internals ---

  _clearHybridTimers () {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null }
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null }
  }

  // Playlist probe against the current feed replica. Returns a signature (null =
  // playlist not available). Metadata-only (drive.entry, no blob download — cannot
  // hang on missing blocks); the bee seq for the playlist key bumps on every rewrite,
  // so a changing signature means the live edge advances.
  async _playlistSig () {
    try {
      const drive = this._feedDrive
      if (!drive) return null
      const entry = await drive.entry('/index.m3u8')
      return entry ? 'seq:' + entry.seq : null
    } catch {
      return null
    }
  }

  // Initial readiness: the playlist exists in the replica within `timeoutMs`.
  async _waitP2PReady (timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this._playlistSig() !== null) return true
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, timeoutMs)))
    }
    return (await this._playlistSig()) !== null
  }

  // While on P2P: fall back to CDN if the playlist stops advancing for too long
  // (covers both peer loss and a stalled live edge — what the host player would
  // experience as rebuffering). "Advancing" alone is not health: the signature is
  // metadata-core state while the bytes a player needs ride the blobs core (the same
  // conflation the tune watchdog had — see _playlistServable), so a feed whose
  // metadata replicates with zero fetchable blob bytes looked healthy here and the
  // fallback never fired while the viewer rebuffered forever. An advance only resets
  // the stall clock when the advanced playlist's CONTENT is servable. busy-guarded:
  // the bounded content read can outlast the tick interval.
  _startStallWatchdog () {
    const cfg = this._hybrid
    const a = this._active
    a.lastAdvance = Date.now()
    let busy = false
    this._watchTimer = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        if (!this._active || this._active !== a || a.source !== 'p2p') return
        const sig = await this._boundedSig(900)
        if (sig !== null && sig !== a.lastSig) {
          a.lastSig = sig
          if (await this._playlistServable(2000)) { a.lastAdvance = Date.now(); return }
        }
        if (this._active !== a || a.source !== 'p2p') return // zapped away during the probes
        if (Date.now() - a.lastAdvance > cfg.rebufferMsToFallback) {
          a.source = 'cdn'
          this._clearHybridTimers()
          this.emit('fallback', { streamId: a.streamId, url: a.cdnUrl, reason: 'stall' })
          this._startRecoveryProbe()
        }
      } finally {
        busy = false
      }
    }, Math.min(cfg.probeIntervalMs, 1000))
  }

  // While on CDN: the feed keeps replicating in the background; once the playlist
  // ADVANCES-and-SERVES across two consecutive probes (healthy for ~probeIntervalMs),
  // switch the active source back to P2P and tell the host. Every streak step must
  // prove servable CONTENT, not just a moving signature: flipping back to a
  // metadata-advancing feed whose blob bytes are unfetchable would strand the viewer
  // on an unplayable P2P source with the fallback already spent (and the stricter
  // verdict only makes flips LESS eager, so the ≥2-streak anti-flap holds).
  // busy-guarded like the stall watchdog.
  _startRecoveryProbe () {
    const cfg = this._hybrid
    const a = this._active
    let healthyStreak = 0
    let busy = false
    this._probeTimer = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        if (!this._active || this._active !== a || a.source !== 'cdn') return
        // Re-run the DHT lookup for the feed topic: a broadcaster that came up AFTER we
        // joined is otherwise only found on hyperswarm's slow periodic refresh.
        try { const r = this._feedDiscovery && this._feedDiscovery.refresh(); if (r && r.catch) r.catch(() => {}) } catch {}
        const sig = await this._boundedSig(900)
        if (sig !== null && sig !== a.lastSig) {
          a.lastSig = sig
          healthyStreak = (await this._playlistServable(2000)) ? healthyStreak + 1 : 0
        } else if (sig === null) {
          healthyStreak = 0
        }
        if (this._active !== a || a.source !== 'cdn') return // zapped away during the probes
        if (healthyStreak >= 2) {
          a.source = 'p2p'
          a.lastAdvance = Date.now()
          this._clearHybridTimers()
          this.emit('source-changed', { streamId: a.streamId, source: 'p2p', url: a.localUrl })
          this._startStallWatchdog()
        }
      } finally {
        busy = false
      }
    }, cfg.probeIntervalMs)
  }

  // --- internals (extracted 1:1 from the worklet backend) ---

  async _ensureStore () {
    if (this._store) return
    // ONE bounded cache budget shared by every bee this store opens (panel catalog +
    // each feed's metadata bee — feeds/assets are namespaced off this store, so the
    // budget flows to all of them). Without it each hyperbee keeps per-instance caches
    // keyed by the ever-growing seq — ~1.5 KB of heap retained per replicated append,
    // forever: a viewer replicates ~2700 appends/h per watched channel, so a long TV
    // session leaks ~4 MB/h (same leak the broadcaster fixed in channel.js). Rache
    // evicts randomly; a re-read of an evicted node is a cheap replica-store hit.
    // Recreated per store (not per player) so a corruption purge drops it with the store.
    this._store = new Corestore(this._storeDir, { globalCache: new Rache({ maxSize: 4096 }) })
    await this._store.ready()
    this._swarm = new Hyperswarm(this._swarmOpts ?? {})
    // S33: size this swarm's UDP socket buffers — the viewer-path completion of S29,
    // which tuned every server-side swarm (see core/net-tune-core.js for the whole
    // story: udx multiplexes ALL peer streams over one UDP socket pair, and kernel
    // buffer overflow is silent stalling, not an error). An earlier note here argued
    // the viewer path wasn't worth tuning because a phone's uplink caps first — true,
    // but that only disqualifies the SEND side. A viewer is RECV-dominant: the whole
    // stream download funnels into the receive buffer, and a worklet thread busy with
    // crypto drains it late. Hence the defaults request recv 2 MiB / send 0 (left at
    // the OS/udx default); swarm.rcvbufMb/sndbufMb override (see normalizeSwarmOpts).
    // Best-effort everywhere: the /proc ceiling read uses the INJECTED fs and on
    // Android simply degrades (the setsockopt still applies — only clamp detection is
    // lost), and no failure in here may ever delay or break boot. The awaited
    // dht.ready() is not added latency: the join right after would trigger the same
    // bind before any packet flows.
    await this._tuneSwarmSockets()
    // Wire the panel RPC on incoming connections — VALIDATED, not first-come (S52).
    // The old heuristic ("the first connection is the panel; we join only its topic
    // first") is only true at boot: mid-session, after a panel restart drops the RPC
    // socket, the next connection to arrive is often a BROADCASTER feed peer
    // (hyperswarm keeps one socket per peer across all topics), and blindly wiring
    // the RPC there wedged every later login/session/report call as 'offline' until
    // that peer happened to drop — while playback kept working, which made it look
    // like a panel outage. See _maybeArmRpc for the probe.
    this._swarm.on('connection', (socket) => {
      // A handshake that was in flight when stop()/a recovery purge nulled the store
      // can still land here (swarm.destroy() resolves later) — drop it, don't crash.
      if (!this._store) { try { socket.destroy() } catch {} return }
      this._store.replicate(socket)
      this._maybeArmRpc(socket)
    })
  }

  // Arm the panel RPC on this socket if we need one and the socket proves it is the
  // panel. Two tiers: a peer whose public key already validated once (the remembered
  // panel identity) re-arms instantly; anyone else must answer a cheap `hello` within
  // _rpcProbeMs first. Probes run concurrently — a slow/dead candidate must never
  // starve the real panel connection arriving a moment later — and the first to
  // validate wins; on failure the slot simply stays open for the next connection.
  // Never throws (a probe failure is normal traffic, not an error).
  _maybeArmRpc (socket) {
    if (this._call || !this._panelBee) return
    const remoteKey = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null
    const { call } = panelClient(socket)
    const arm = () => {
      if (this._call || socket.destroyed) return
      this._call = call
      if (remoteKey) this._panelPeerKey = remoteKey
      socket.on('close', () => { if (this._call === call) this._call = null })
    }
    if (remoteKey && remoteKey === this._panelPeerKey) return arm()
    ;(async () => {
      try {
        const res = await Promise.race([
          call('hello'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('rpc probe timeout')), this._rpcProbeMs).unref?.())
        ])
        if (res && typeof res.challenge === 'string') arm()
      } catch {}
    })()
  }

  // Request the configured UDP socket buffer sizes on the swarm just created (also
  // re-applied when a corruption purge rebuilds the store + swarm). Emits the same
  // operator lines the servers log — 'status' {state:'net:tuned', message} — so a host
  // (and adb logcat, via the app's debug relay) can prove the tuning ran on-device.
  // Never fatal and never throws: an untuned socket is exactly the pre-S33 behavior.
  async _tuneSwarmSockets () {
    const { recvBytes, sendBytes } = this._swarmBufs
    if (!(recvBytes > 0) && !(sendBytes > 0)) return // both directions opted out
    try {
      // No encoding arg: bare-fs and node:fs both return a Buffer, and String() of a
      // Buffer is its utf8 text — the least common denominator the two runtimes share.
      const readFile = (p) => this._fs.readFileSync(p)
      const report = await tuneSwarm(this._swarm, { recvBytes, sendBytes, readFile })
      // Set-dedupe: a clamp yields the SAME warning for both of the pair's sockets
      // (the text names the host property, not the socket) — emit it once.
      for (const message of new Set(tuningMessages(report))) this.emit('status', { state: 'net:tuned', message })
    } catch {
      // Best-effort by contract — a tuning failure must never surface as a boot error.
    }
  }

  // Open (or re-open, after a corruption purge) the panel DB and join its topic.
  async _openPanel () {
    await this._ensureStore()
    this._panelBee = new Hyperbee(this._store.get({ key: b4a.from(this._panelKey, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this._panelBee.ready()
    this._panelDiscovery = this._swarm.join(hcrypto.hash(b4a.from(this._panelKey, 'hex')), { client: true, server: false })
    this._watchCatalog()
    this._watchEpgKey()
  }

  // Live catalog push: watch the replicated bee's catalog/ range and re-emit 'streams'
  // whenever a record changes, so hosts update their UI without polling. Armed with
  // the panel DB (also after a recovery purge re-opens it); emits only once a login
  // has established what the user is entitled to see.
  _watchCatalog () {
    if (!this._panelBee) return
    const watcher = this._panelBee.watch({ gt: 'catalog/', lt: 'catalog0' }) // '0' = next char after '/'
    this._catalogWatcher = watcher
    const run = async () => {
      try {
        for await (const _ of watcher) { // eslint-disable-line no-unused-vars
          if (this._catalogWatcher !== watcher) return // superseded by purge/stop
          await this._recover(() => this._pushCatalog())
          await this._maybeReresolveActiveFeed() // follow a rotated feedKey for the stream being watched
        }
      } catch (err) {
        // The bee closing underneath us (stop/purge) ends the watcher — not an error.
        if (this._catalogWatcher === watcher && !this._purging) this.emit('error', err)
      }
    }
    run()
  }

  // Rebuild the display list for the current session from the latest replicated
  // catalog records and emit it. Display-only: the sealed stream keys in _entitled
  // come from the user record at login and are not touched — a stream whose feed was
  // re-keyed (new feedKey in the catalog) needs a fresh login to unseal anyway, and
  // a newly granted stream only appears after the next login.
  async _pushCatalog () {
    if (!this._entitled.size || !this._panelBee) return
    const port = await this._ensureServer()
    const streams = []
    for (const id of this._entitled.keys()) {
      const node = await this._panelBee.get('catalog/' + id)
      if (node && node.value) streams.push(this._display(port, id, node.value))
    }
    this._streams = streams
    // The VOD config rides along unchanged: it is login-scoped (the record is read at
    // login, not watched), so a catalog push must not silently drop it from the payload.
    this.emit('streams', streams, this._vod || undefined)
  }

  // A stream's feedKey can rotate in the catalog WHILE a viewer is watching it (broadcaster
  // source change / RAM-buffer restart): resolve() only reads the feedKey once, so the
  // active viewer would keep replicating the DEAD feed until they re-zap. Called on every
  // catalog change: if the ACTIVE stream now points at a different feedKey, open it and make
  // it the one served on the (unchanged) localhost port, then emit 'feed-changed' so the host
  // reloads its player. The per-user ENCRYPTION key is unchanged (a re-KEY still needs a fresh
  // login) — only the feedKey moved. Best-effort: never throws (it runs inside the watch loop,
  // whose only failure mode is to stop following the catalog); a failed open simply retries on
  // the next catalog tick since a.feedKey is left untouched.
  async _maybeReresolveActiveFeed () {
    const a = this._active
    if (!a || this._hybrid.mode === 'cdn-only') return // cdn-only never serves the P2P feed
    if (!a.feedKey) return // redirect channel (S23): nothing served locally, nothing to rotate
    // vod (S8a): a catalog feedKey change means a RE-INGEST replaced the title —
    // hot-swapping the served drive would yank the viewer's playhead onto a
    // different rendition mid-film. Finish on the local replica; the NEXT resolve()
    // plays the new generation. (Live rotation-following stays live-only.)
    if (a.vod) return
    const keys = this._entitled.get(a.streamId)
    if (!keys || !keys.encryptionKey) return
    // Fallback = the key we're already serving, so a momentarily unreadable catalog (or a
    // channel that just went off-air, feedKey null) is a no-op, never a spurious rotation.
    const feedKey = await this._currentFeedKey(a.streamId, a.feedKey)
    if (!feedKey || feedKey === a.feedKey) return
    let feed
    let timer
    try {
      // Bounded: a wedged open must not park the catalog watcher forever — leave
      // a.feedKey untouched and let the next catalog tick retry.
      feed = await Promise.race([
        this._openFeed(feedKey, keys.encryptionKey),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), this._tune.timeoutMs) })
      ])
    } catch { return } finally { clearTimeout(timer) }
    if (!feed) return
    // A zap during the open moved _active on; leave _feedDrive to that resolve()'s serveFeed
    // (don't clobber it back to this now-stale channel's feed).
    if (this._active !== a) return
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    a.feedKey = feedKey
    a.lastSig = null
    a.lastAdvance = Date.now()
    this.emit('status', { state: 'feed:ready' })
    // On CDN under hybrid the recovery probe now tracks the NEW feed and will emit
    // 'source-changed' when it flips back; only tell the host to reload when P2P is live.
    if (a.source === 'p2p') this.emit('feed-changed', { streamId: a.streamId, feedKey, url: a.localUrl })
    // The rotated feed may itself be cold/unreachable — same self-heal as a fresh tune
    // (no-op outside p2p-only mode; hybrid's own watchdog/probe already track it).
    this._startTuneWatchdog()
  }

  // Any open of on-disk replica state can fail with a corruption error if a previous
  // process died mid-write. The store is a disposable cache: purge it, rebuild, retry
  // the op once; a second failure surfaces to the caller as usual.
  _recover (op) {
    return withRecovery(op, () => this._purge(), (err) => this.emit('recovered', err))
  }

  // Single-flight purge: tear down everything holding the store, delete it from disk,
  // and re-arm the panel connection. Feed/assets drives re-open on demand; the
  // in-memory session (entitled stream keys) survives, so no re-login is needed.
  _purge () {
    if (!this._purging) this._purging = this._purgeAndRebuild().finally(() => { this._purging = null })
    return this._purging
  }

  async _purgeAndRebuild () {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} } // corrupt bees may refuse; bee close below retries
    this._zapRanges.clear() // warm ranges die with their (closing) cores; the prefetch loop re-warms on the fresh store
    this._closeFeeds() // drop every cached feed on the dead store (fire-and-forget; see _closeFeeds)
    const epgWatcher = this._epgWatcher; this._epgWatcher = null
    if (epgWatcher) { try { await epgWatcher.close() } catch {} }
    const closing = [this._assetsDrive, this._epgDrive, this._updatesDrive, this._panelBee, this._store]
    this._feedDrive = this._assetsDrive = this._epgDrive = this._updatesDrive = this._panelBee = this._store = null
    this._feedDiscovery = null
    this._epgDiscovery = null
    this._epgKeyHex = null
    this._assetsOpen = null
    this._epgOpen = null
    this._updatesDiscovery = null
    this._updatesOpen = null
    this._updateCheck = null // the entry belonged to the purged replica — force a fresh check (lazy re-open)
    this._call = null
    if (this._swarm) { const s = this._swarm; this._swarm = null; try { await s.destroy() } catch {} }
    for (const c of closing) { if (c) { try { await c.close() } catch {} } } // corrupt cores may refuse to close
    try { this._fs.rmSync(this._storeDir, { recursive: true, force: true }) } catch {}
    if (this._panelKey) {
      await this._openPanel()
      this._openAssets().catch(() => {}) // posters re-replicate in the background once the panel reconnects
      this._openEpg().catch(() => {}) // so does the guide
    }
  }

  // What every login asks sdk/login.js to MATERIALIZE beyond the session itself, from the
  // build's construction-time `remote` flags (normalizeRemote). Both fields default off
  // and both are retained for the life of the session when on, so this is deliberately
  // one place rather than two call sites that could drift:
  //
  //   handover      the account's two private keys. Only sendSignIn() reads them.
  //   remoteSecret  the account rendezvous authenticator. Only WP3 reads it.
  //
  // A build with neither flag finishes a login holding exactly what it held before this
  // feature existed: a token, a deviceId and the sealed stream keys.
  _loginOpts () {
    return {
      deviceId: this._deviceId || undefined,
      deviceLabel: this._deviceLabel || undefined,
      handover: this._remote.sendToTv,
      remoteSecret: this._remote.control
    }
  }

  async _doLogin (username, password) {
    if (!this._call) throw new Error('not connected to panel')
    const res = await oprfLogin(this._call, this._panelBee, username, password, this._loginOpts())
    return this._applyLoginResult(username, res)
  }

  // The key-handover door into the same session: no password, the two private keys a
  // phone sent instead. Everything after this point is identical to a typed login,
  // including this device registering its OWN deviceId (sdk/login.js loginWithKeys).
  //
  // The same gate applies here. A TV that was signed in by a phone RETAINS the account
  // keys only if this build is itself allowed to send a sign-in onward; a receive-only
  // build takes its token and lets the material go.
  async _doLoginWithKeys (username, keys) {
    if (!this._call) throw new Error('not connected to panel')
    const res = await loginWithKeys(this._call, this._panelBee, username, keys, this._loginOpts())
    return this._applyLoginResult(username, res)
  }

  async _applyLoginResult (username, res) {
    const { streams, vod } = res
    // S53: present ONLY when the operator configured a provider AND enabled it — the
    // login result carries no `vod` field otherwise, so absent and disabled collapse
    // to the same null here.
    this._vod = vod || null
    // Retain the session (S50c). Before this the token was discarded on the spot, which
    // left the engine with no way to prove entitlement for anything but a fresh login —
    // report() needs exactly that proof. It is an in-memory bearer credential: never
    // written to disk by the engine, never handed to a host, and dropped by stop().
    // It deliberately SURVIVES a corruption purge and a panel-socket drop: neither
    // invalidates the token, the purge path already keeps the equivalent in-memory
    // session (entitled stream keys) alive on purpose, and dropping it there would
    // silently disable reporting exactly when things are going wrong.
    this._session = res.token
      ? {
          username,
          token: res.token,
          expiresAt: res.expiresAt ?? null,
          deviceId: res.deviceId ?? null,
          // One-way from the private key (core/remote.js remoteSecret) and rotated by
          // the panel's "log out all devices" — safe to hold for the session. Null when
          // the account record predates tokenVersion, in which case the account
          // rendezvous simply does not exist rather than being guessed at.
          remoteSecret: res.remoteSecret ?? null,
          handover: res.handover || null
        }
      : null
    await this._openAssets()
    this._openEpg().catch(() => {}) // the guide is never allowed to delay (or fail) a login
    const port = await this._ensureServer() // posters must be loadable before anything plays
    this._entitled.clear()
    // _feedKeyLive AUGMENTS _entitled (same streamId keys, fresher feedKey), so it must
    // die with it. A re-login or a user switch can hand the SAME streamId a different
    // channel — a stale entry here would then out-vote the new snapshot's feedKey and
    // point /feedthumb at the previous session's feed for the rest of the session.
    this._feedKeyLive.clear()
    return streams.map((s) => {
      this._entitled.set(s.id, { feedKey: s.feedKey, encryptionKey: s.encryptionKey, redirect: s.redirect === true, url: s.url ?? null, headers: s.headers ?? null, type: s.type ?? null, durationSec: s.durationSec ?? null })
      return this._display(port, s.id, s)
    })
  }

  // Catalog record -> display shape handed to hosts (login result and live pushes):
  // metadata only — never the feed/encryption keys — with art paths as localhost URLs.
  // order/featured are the panel's curation hints (S16c): rail sort / hero-wallpaper pick.
  _display (port, id, cat) {
    return {
      id,
      title: cat.title,
      description: cat.description,
      category: cat.category,
      isLive: cat.isLive,
      order: cat.order,
      featured: cat.featured,
      // Access control: the host must PIN-gate this channel (parental control) and
      // hide it entirely while no PIN is configured on the device.
      restricted: cat.restricted === true,
      poster: this._artUrl(port, cat.poster),
      backdrop: this._artUrl(port, cat.backdrop),
      logo: this._artUrl(port, cat.logo),
      // EPG pointers (S27): public https feed URL + this channel's id inside it, so
      // the app can fetch the schedule on demand. Safe to expose like the art URLs
      // (unlike url/redirect, which stay engine-internal — see the display test).
      epgUrl: cat.epgUrl ?? undefined,
      epgId: cat.epgId ?? undefined,
      // P2P guide base (the epoch drive served at /epg/* — see _doOpenEpg). Handed
      // out unconditionally like the art URLs: when no guide drive exists the fetch
      // 404s instantly (media:false) and the EpgService falls back to epgUrl/epgId.
      guideBase: `http://127.0.0.1:${port}/epg/v1/${id}`,
      // Live thumbnail base (the rolling /thumb.jpg inside this channel's own feed drive,
      // served through the feed cache — see _thumbTarget). Unconditional like guideBase:
      // a 404 IS the "no thumbnail right now" signal (channel off, THUMB=0, cold feed,
      // metered network), and hosts fall back to poster/logo art on it.
      thumbBase: `http://127.0.0.1:${port}/feedthumb/${id}`,
      // Record class (S8a): 'vod' = a library title (host shows seek UI, no live-edge
      // machinery) | 'live'. durationSec rides only on vod records. status is exposed
      // so a host can gray out an 'unavailable' title (its library deleted it).
      type: cat.type ?? undefined,
      durationSec: cat.durationSec ?? undefined,
      status: cat.status ?? undefined
    }
  }

  // Drive paths map to the localhost server; absolute http(s) URLs pass through
  // unchanged (hybrid art — without the guard an https poster would be mangled into
  // 'http://127.0.0.1:<port>/https://…' and 404).
  _artUrl (port, p) {
    if (!p) return undefined
    if (ABSOLUTE_URL_RE.test(p)) return p
    return `http://127.0.0.1:${port}/${p.replace(/^\//, '')}`
  }

  // Open the panel's assets Hyperdrive (posters/art) so the localhost server can serve
  // /assets/*. Key is advertised in the signed DB under meta/assetsKey. Single-flight:
  // login and post-purge recovery can call this concurrently.
  _openAssets () {
    if (!this._assetsOpen) {
      const p = this._doOpenAssets().then(
        () => { if (this._assetsOpen === p && !this._assetsDrive) this._assetsOpen = null }, // nothing advertised yet — re-check on the next login
        (err) => { if (this._assetsOpen === p) this._assetsOpen = null; throw err }
      )
      this._assetsOpen = p
    }
    return this._assetsOpen
  }

  async _doOpenAssets () {
    if (this._assetsDrive || !this._panelBee) return
    const meta = await this._panelBee.get('meta/assetsKey')
    if (!meta || !meta.value.key) return
    this._assetsDrive = new Hyperdrive(this._store.namespace('assets-replica'), b4a.from(meta.value.key, 'hex'))
    await this._assetsDrive.ready()
    // keep the session — setUploadPolicy() refreshes it to flip announcing at runtime
    this._assetsDiscovery = this._swarm.join(this._assetsDrive.discoveryKey, { client: true, server: this._uploadPolicy !== 'client-only' })
  }

  // Open (or SWAP to) the current guide epoch drive advertised under meta/epgKey.
  // The guide is epoch-rotated by the EPG service (epg/src/guide.js): a fresh drive
  // key appears in the pointer roughly monthly, so unlike the assets drive this open
  // must handle replacement — the assets pattern plus the feed-rotation swap. The
  // replica namespace carries the drive key, so each epoch's cores are their own
  // namespace and the retired one can be purged wholesale (the same reasoning as
  // _doSweepStaleReplicas for rotated feeds). No pointer / an old panel = no guide —
  // callers never depend on this (the EpgService falls back to https).
  _openEpg () {
    if (!this._epgOpen) {
      const p = this._doOpenEpg().then(
        (r) => { if (this._epgOpen === p) this._epgOpen = null; return r },
        (err) => { if (this._epgOpen === p) this._epgOpen = null; throw err }
      )
      this._epgOpen = p
    }
    return this._epgOpen
  }

  async _doOpenEpg () {
    if (!this._panelBee) return
    const meta = await this._panelBee.get('meta/epgKey')
    const keyHex = meta?.value?.key
    if (!keyHex || typeof keyHex !== 'string') return
    if (this._epgKeyHex === keyHex && this._epgDrive) return // current epoch already open
    const drive = new Hyperdrive(this._store.namespace('epg-replica-' + keyHex.slice(0, 16)), b4a.from(keyHex, 'hex'))
    await drive.ready()
    const discovery = this._swarm.join(drive.discoveryKey, { client: true, server: this._uploadPolicy !== 'client-only' })
    const old = this._epgDrive
    const oldDiscovery = this._epgDiscovery
    this._epgDrive = drive
    this._epgDiscovery = discovery
    this._epgKeyHex = keyHex
    // Retire the previous epoch's replica: leave its topic, close it, free its disk.
    // Fire-and-forget — the swap itself must never wait on cleanup.
    if (old) {
      ;(async () => {
        try { if (oldDiscovery) await oldDiscovery.destroy() } catch {}
        try { await old.purge() } catch { try { await old.close() } catch {} }
      })().catch(() => {})
    }
  }

  // Follow meta/epgKey rotations live (the catalog watcher's exact re-arm pattern,
  // bounded to the meta/ prefix — one tiny record, so ticks are rare and cheap).
  _watchEpgKey () {
    if (!this._panelBee) return
    const watcher = this._panelBee.watch({ gt: 'meta/', lt: 'meta0' })
    this._epgWatcher = watcher
    ;(async () => {
      try {
        for await (const _ of watcher) { // eslint-disable-line no-unused-vars
          if (this._epgWatcher !== watcher) return
          this._openEpg().catch(() => {})
        }
      } catch { /* bee closing under us (shutdown/purge) */ }
    })()
  }

  // Open the panel's updates Hyperdrive advertised under meta/updatesKey. The assets
  // single-flight pattern exactly — the pointer is written once and never rotates
  // (the manifest changes INSIDE the drive), so no swap handling — except the join:
  // client-only ALWAYS, never announced, whatever the uploadPolicy (see checkUpdate).
  _openUpdates () {
    if (!this._updatesOpen) {
      const p = this._doOpenUpdates().then(
        () => { if (this._updatesOpen === p && !this._updatesDrive) this._updatesOpen = null }, // nothing advertised yet — re-check on the next call
        (err) => { if (this._updatesOpen === p) this._updatesOpen = null; throw err }
      )
      this._updatesOpen = p
    }
    return this._updatesOpen
  }

  async _doOpenUpdates () {
    if (this._updatesDrive || !this._panelBee) return
    const meta = await this._panelBee.get('meta/updatesKey')
    const keyHex = meta?.value?.key
    if (!keyHex || typeof keyHex !== 'string') return
    this._updatesDrive = new Hyperdrive(this._store.namespace('updates-replica'), b4a.from(keyHex, 'hex'))
    await this._updatesDrive.ready()
    this._updatesDiscovery = this._swarm.join(this._updatesDrive.discoveryKey, { client: true, server: false })
  }

  // Bounded manifest read. Three-way verdict: an object = the manifest; null = the
  // drive answered and has no /manifest.json (nothing ever published — honest 'none');
  // undefined = cannot say (no pointer, cold replica past the bound, unparseable).
  async _readUpdatesManifest (ms) {
    let timer
    try {
      const res = await Promise.race([
        (async () => {
          await this._openUpdates()
          if (!this._updatesDrive) return undefined
          // A cold replica checkout has length 0 and get() answers null WITHOUT
          // waiting for a peer — which reads as a false "nothing published". Learn
          // the real length from a peer first; no peer inside the bound → the race
          // times out → 'unknown', which is the truthful cold answer.
          await this._updatesDrive.core.update({ wait: true })
          const buf = await this._updatesDrive.get('/manifest.json')
          if (!buf) return null
          const parsed = JSON.parse(b4a.toString(buf))
          return parsed && typeof parsed === 'object' ? parsed : undefined
        })(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })
      ])
      return res
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  // Downloaded artifacts live BESIDE the replica cores, inside the disposable store
  // dir (the replicas.json precedent) — a corruption purge reclaims them wholesale,
  // which is correct for a cache: the next check re-downloads.
  _updatesDir () { return String(this._storeDir).replace(/[\\/]+$/, '') + '/updates' }

  _updateBasename (file) { return String(file).slice(String(file).lastIndexOf('/') + 1) }

  // Reclaim downloads the manifest no longer names (superseded versions, aborted
  // .part files from a previous process) — once per engine, on the first successful
  // manifest read. Current entries keep BOTH their final file and their .part (an
  // in-flight download must not be swept out from under itself). Best-effort: every
  // fs call is wrapped, a failure just leaves bytes for the next boot's sweep.
  _sweepUpdatesDir (manifest) {
    if (this._updatesSwept || !manifest) return
    this._updatesSwept = true
    try {
      const keep = new Set()
      for (const e of Object.values(manifest)) {
        if (!e || typeof e.file !== 'string') continue
        const base = this._updateBasename(e.file)
        if (UPDATE_BASENAME_RE.test(base)) { keep.add(base); keep.add(base + '.part') }
      }
      const dir = this._updatesDir()
      for (const name of this._fs.readdirSync(dir)) {
        if (!keep.has(String(name))) { try { this._fs.rmSync(dir + '/' + name, { force: true }) } catch {} }
      }
    } catch { /* no dir yet — nothing downloaded, nothing to sweep */ }
  }

  async _doDownloadUpdate (entry) {
    const drive = this._updatesDrive
    if (!drive) throw new Error('updates drive is not open — call checkUpdate() first')
    const base = this._updateBasename(entry.file)
    if (!UPDATE_BASENAME_RE.test(base)) throw new Error('update entry has an unusable file name: ' + entry.file)
    // Metadata first (bounded): a file the drive never had must fail fast, not sit in
    // the byte loop's stall window with zero progress.
    let entTimer
    const ent = await Promise.race([
      drive.entry(entry.file),
      new Promise((resolve) => { entTimer = setTimeout(() => resolve(null), UPDATE_CHECK_TIMEOUT_MS) })
    ]).finally(() => clearTimeout(entTimer))
    const blob = ent && ent.value && ent.value.blob
    if (!blob || !(blob.byteLength > 0)) throw new Error('update file is not available from the updates drive: ' + entry.file)
    const total = Number.isInteger(entry.size) && entry.size > 0 ? entry.size : blob.byteLength
    const dir = this._updatesDir()
    try { this._fs.mkdirSync(dir, { recursive: true }) } catch {}
    const partPath = dir + '/' + base + '.part'
    const finalPath = dir + '/' + base
    // Incremental sha256 (sodium) WHILE writing — a 100+ MB artifact must never need
    // a second full read (or a full in-memory copy) just to be verified.
    const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
    sodium.crypto_hash_sha256_init(state)
    const fd = this._fs.openSync(partPath, 'w')
    let received = 0
    let closed = false
    let ok = false // only after the verified RENAME — the finally cleanup owns every other exit
    try {
      const rs = drive.createReadStream(entry.file)
      const it = rs[Symbol.asyncIterator]()
      let lastEmit = 0
      let lastPct = 0
      while (true) {
        let timer
        const r = await Promise.race([
          it.next(),
          new Promise((resolve) => { timer = setTimeout(() => resolve('stalled'), UPDATE_STALL_MS) })
        ]).finally(() => clearTimeout(timer))
        if (r === 'stalled') {
          try { rs.destroy() } catch {}
          throw new Error(`update download stalled — no data for ${Math.round(UPDATE_STALL_MS / 1000)}s, try again later`)
        }
        if (r.done) break
        const chunk = b4a.isBuffer(r.value) ? r.value : b4a.from(r.value)
        this._fs.writeSync(fd, chunk, 0, chunk.byteLength)
        sodium.crypto_hash_sha256_update(state, chunk)
        received += chunk.byteLength
        // Throttled progress: every ~500 ms or 5% step, plus the final byte.
        const now = Date.now()
        const pct = total > 0 ? received / total : 0
        if (now - lastEmit >= 500 || pct - lastPct >= 0.05 || received >= total) {
          lastEmit = now
          lastPct = pct
          this.emit('update-progress', { received, total })
        }
      }
      this._fs.closeSync(fd)
      closed = true
      const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
      sodium.crypto_hash_sha256_final(state, digest)
      if (b4a.toString(digest, 'hex') !== entry.sha256.toLowerCase()) {
        throw new Error('update failed verification (sha256 mismatch) — the download was discarded')
      }
      try { this._fs.rmSync(finalPath, { force: true }) } catch {} // a re-download replaces any older copy
      // A renameSync throw (Windows file lock / AV scan) must also land in the
      // cleanup below — the caller gets the reject, never a stranded .part.
      this._fs.renameSync(partPath, finalPath)
      ok = true
      this.emit('update-ready', { path: finalPath, entry })
      return { path: finalPath, entry }
    } finally {
      if (!ok) {
        if (!closed) { try { this._fs.closeSync(fd) } catch {} }
        try { this._fs.rmSync(partPath, { force: true }) } catch {}
      }
    }
  }

  // One persistent localhost server for the whole session: /assets/* from the panel's
  // assets drive (posters/art), /epg/* from the guide epoch drive, /feedthumb/<id> from
  // ANY entitled channel's cached feed, everything else from the currently playing feed.
  // The port never changes, so asset URLs handed out at login stay valid.
  async _ensureServer () {
    if (!this._server) {
      this._server = this._http.createServer(this._requestHandler())
      await new Promise((resolve) => this._server.listen(0, '127.0.0.1', resolve))
    }
    return this._server.address().port
  }

  // Resolve /feedthumb/<streamId> against the feed cache. SYNCHRONOUS by contract —
  // createDriveHandler calls resolveTarget without awaiting it — which is what makes
  // every rule below a "serve it now or 404" decision instead of a wait:
  //
  //   ENTITLEMENT — the id must be in _entitled. Thumbnails live INSIDE the encrypted
  //     feed, so an unentitled channel has nothing to serve and no key to try with; a
  //     redirect channel (no feed of its own) falls out here too.
  //   WARM ONLY — the drive must already be open AND settled (or be the active feed).
  //     _feeds holds open PROMISES, so an open still in flight reads as cold: a
  //     thumbnail must never park a request behind a DHT lookup and a peer handshake.
  //   METERED — never open a new drive on an expensive network (setNetworkProfile), the
  //     same rule that suspends zap-prefetch. Already-warm feeds still serve.
  //   SPARE SLOT — otherwise kick the SAME single-flight BOUNDED open every other
  //     on-demand path uses (_openFeedWithin, not _openFeed: an unbounded open that
  //     wedges stays in the cache forever, occupying an LRU slot and making every later
  //     refresh tick for that channel resolve a promise that will never settle — the
  //     timeout is what evicts it). Only while the LRU has a free slot, and _trimFeeds
  //     after. A 300-channel grid must not open 300 drives, and it must not thrash the
  //     cap either: eviction PURGES the replica's storage, so letting thumbnails push
  //     warm feeds out would trade a picture for exactly the zap latency that cache
  //     exists to remove. This request still 404s (nothing is replicated yet); the row's
  //     next refresh tick finds the drive warm.
  //
  // Every 404 is a normal outcome, not an error: a channel with THUMB=0, a cold feed on
  // a metered network, a channel the broadcaster has not written a thumbnail for yet.
  //
  // idle:true on every target — see the resolveTarget contract in serve.js. /thumb.jpg is
  // a ROLLING blob: the broadcaster clearBlob's the previous one on every refresh, so a
  // request that resolved the superseded entry would otherwise hang forever with headers
  // already sent. It is the one thing an ancillary target here shares with media.
  _thumbTarget (streamId) {
    if (!streamId) return null
    const keys = this._entitled.get(streamId)
    if (!keys || !keys.encryptionKey) return null
    // The playing channel is already served drive-first — no cache lookup, and it works
    // even while a rotation has the cache keyed by a feedKey we have not re-read yet.
    const a = this._active
    if (a && a.streamId === streamId && this._feedDrive) return { drive: this._feedDrive, path: THUMB_PATH, media: false, idle: true }
    const feedKey = this._feedKeyLive.get(streamId) || keys.feedKey
    if (!feedKey) return null // a catalog entry with no broadcaster behind it
    const cacheKey = feedKey + ':' + keys.encryptionKey
    const feed = this._feeds.get(cacheKey)
    if (feed) return feed.settled ? { drive: feed.settled.drive, path: THUMB_PATH, media: false, idle: true } : null
    // Cold. Warming is optional and never on this request's critical path.
    if (this._netExpensive || this._hybrid.mode === 'cdn-only') return null
    if (keys.type === 'vod') return null // a finished title has no rolling thumbnail to wait for
    if (this._feeds.size >= this._feedLimit) return null
    this._openFeedWithin(feedKey, keys.encryptionKey, this._tune.timeoutMs).then(() => this._trimFeeds(), () => {})
    return null
  }

  // Request handler for HLS players (and poster art): the shared progressive
  // serving core (sdk/serve.js) — availability wait, block-progressive bodies with
  // Range support, live-edge read-ahead, abort tolerance (a player aborts requests
  // routinely, and an unhandled stream error SIGABRTs the Bare worklet). Targets
  // resolve PER REQUEST so a retune/rotation swaps the served feed live.
  _requestHandler () {
    return createDriveHandler((p) => {
      // /assets/* is served from the panel's assets drive (posters/art) — a genuine
      // miss must 404 immediately (media: false), not hold the request open.
      if (p.startsWith('/assets/') && this._assetsDrive) {
        return { drive: this._assetsDrive, path: p.slice('/assets'.length), media: false }
      }
      // /epg/* is served from the current guide epoch drive (P2P program guide) —
      // ancillary like art (a miss 404s so the EpgService can fall back to https).
      // The drive version is the cache validator: a poll of an unchanged guide is
      // answered 304 before any block is touched.
      if (p.startsWith('/epg/') && this._epgDrive) {
        return { drive: this._epgDrive, path: p.slice('/epg'.length), media: false, etag: 'epg-' + this._epgKeyHex.slice(0, 8) + '-' + this._epgDrive.version }
      }
      // /feedthumb/<streamId> is the live thumbnail of ANY entitled channel, not only
      // the one playing (the grid/zapping-list case) — resolved through the feed cache
      // without making the channel active. Ancillary like art and the guide: a miss
      // 404s instantly (media:false) and the row falls back to poster/logo.
      if (p.startsWith('/feedthumb/')) return this._thumbTarget(p.slice('/feedthumb/'.length))
      return this._feedDrive ? { drive: this._feedDrive, path: p, media: true } : null
    }, {
      // Churn headroom: replicate the ACTIVE stream's whole live window on-device
      // (not just the newest 3 segments), so an upstream peer's death cannot take
      // away media between the playhead and the live edge — the player's live
      // offset becomes the survival budget. Re-evaluated per playlist serve: on a
      // metered network the burst cost of a zap (one window × bitrate) is real
      // money, so fall back to the serve-core default there.
      liveReadAhead: () => (this._netExpensive ? 3 : Infinity),
      // Disk bound (the flip side of the full-window read-ahead above): clear the
      // blob blocks below the live window as playlists serve, so the viewer's disk
      // holds ~one live window per feed instead of growing ~1× bitrate forever
      // (≈0.9 GB/hour at 2 Mbps). Safe by construction: the cleared blocks are
      // already unfetchable swarm-wide — the broadcaster cleared them at rotation.
      // Feed target only (media: true) and live playlists only; VOD is never
      // reclaimed (see the Reclaim class in serve.js).
      reclaim: true,
      // Corruption can also surface at read time (the blobs core opens lazily): heal
      // in the background; the host player's retry re-opens the feed on the fresh store.
      onError: (err) => { if (isCorruptionError(err)) this._purge().catch(() => {}) }
    })
  }
}
