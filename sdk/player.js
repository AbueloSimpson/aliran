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
//                        tuning outcome, same text the server components log ([net]).
//                        'feed:rotate' is the viewer-disk rotation (see the VIEWER DISK
//                        BUDGET note below) and carries {streamId, bytes, durationMs}:
//                        what the purged replica was holding, and how long the served
//                        drive was actually swapped for. durationMs is the field that
//                        decides whether this stayed invisible in the field, which is
//                        why it rides the event rather than a log line. A rotation that
//                        was REFUSED instead carries {skipped:<reason>} and neither
//                        number; one that FAILED carries {failed:true}.
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
//   'cast' ({state,streamId,reason})  the cast session ENDED ON ITS OWN — state 'ended'.
//                        reason 'feed-evicted' (the pinned replica was PURGED out from
//                        under the session — the tune ladder ran out, or a rotation
//                        published a session onto the very drive it was unlinking)
//                        | 'retune-abandoned' (a zap landed mid-retune
//                        and the pinned feed was closed without a replacement). Both used
//                        to leave a zombie: drive nulled, everything 404ing forever, the
//                        socket still bound and castSession() still handing out a url and
//                        token that no longer work. The host stops showing "Casting" and
//                        may restart the session. stopCast() does NOT emit — the caller
//                        that asked for the stop already knows.
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
// measureDriveBytes / reclaimIdleFeed are the disk half of the serving core (see the
// VIEWER DISK BUDGET note below): measureDriveBytes answers "what is this replica
// actually costing on disk" and returns null where the platform cannot say, and
// reclaimIdleFeed runs one below-window reclaim pass on a drive nobody is serving.
import { createDriveHandler, playlistUris, reclaimBelowWindow, measureDriveBytes, reclaimIdleFeed, THUMB_PATH } from './serve.js'
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

// feedLimit: how many feeds may stay open at once (default 12 — see the cache bound in the
// constructor). Worth lowering only where a warm replica is NOT nearly free, i.e. where the
// platform cannot hole-punch and every cached byte survives until eviction unlinks it.
//
// REFUSED BELOW 2, not clamped, in the same spirit as normalizeReclaimBudget. _trimFeeds
// protects exactly two slots — the ACTIVE feed and a cast-pinned one — so a limit of 1
// cannot hold both, and a limit of 0 leaves a tune's in-flight open resting entirely on the
// cache-slot claim to not be purged out from under it. Eviction PURGES, and a purged replica
// does not re-attach to an established protomux (it needs a full hang-up and re-dial), so
// getting this wrong is not a slower zap, it is a dead one. 2 is the floor that keeps the
// invariant; 3 is the smallest value with any room to spare.
function normalizeFeedLimit (v) {
  if (v == null) return 12
  const n = Number(v)
  if (!Number.isInteger(n) || n < 2) throw new Error('feedLimit must be an integer >= 2 (the active feed and a cast-pinned feed both need a slot)')
  return n
}

// reclaimBudgetBytes: the ceiling on ONE feed's replica on disk, past which the engine
// ROTATES it (purge + fresh open — see _rotateActiveFeed and the VIEWER DISK BUDGET note).
// Undefined takes the default; 0 switches rotation off entirely, which is a real choice on
// a 64-bit device with room to spare (the budget is never reached there anyway) and a bad
// one on a 32-bit Android build, where it is the only bound there is.
//
// TYPE-CHECKED AND FLOORED, not coerced — and the comment that used to stand here claimed
// the opposite of what the code did. It said a budget of `"512"` was "rejected rather than
// coerced" because it "would rotate the feed on every playlist serve, which looks exactly
// like a broken stream". But the check was `Number(v)`, and `Number("512")` is 512: the
// string was ACCEPTED as a 512-BYTE budget and produced precisely the rotation storm the
// comment believed it had prevented. `Number(true)` is 1 — a one-byte budget. Only
// `"512MB"` was ever caught, by NaN. So: reject anything that is not a number, and floor
// what is (see FEED_ROTATE_BUDGET_MIN_BYTES) with a message that names the floor.
function normalizeReclaimBudget (v) {
  if (v == null) return FEED_ROTATE_BUDGET_BYTES
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error('reclaimBudgetBytes must be a non-negative NUMBER of bytes (0 disables the per-feed rotation) — strings and booleans are not coerced')
  }
  if (v === 0) return 0 // the documented "do not rotate" switch, not a tiny budget
  if (v < FEED_ROTATE_BUDGET_MIN_BYTES) {
    throw new Error(`reclaimBudgetBytes must be at least ${FEED_ROTATE_BUDGET_MIN_BYTES} bytes (${Math.round(FEED_ROTATE_BUDGET_MIN_BYTES / 1048576)} MiB), or exactly 0 to disable the per-feed rotation — a smaller budget rotates the served feed on almost every playlist serve, which looks like a broken stream rather than a disk bound`)
  }
  return v
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

// --- cast to a TV (startCast) -----------------------------------------------------
//
// Route prefix and token size. 32 bytes of hypercore-crypto randomness, hex, fresh per
// session, in the PATH because a Cast receiver cannot be made to send an auth header.
//
// ⚠ WHAT THE TOKEN IS AND IS NOT. It is not the access boundary, and nothing here may say
// it is. MEASURED on a TCL Google TV (CrKey/1.56.500000) running the stock Default Media
// Receiver: a separate process that had never seen the cast URL and presented NO credential
// connected to the device on port 8009, called getSessions, joined the running session and
// read its media status — which returns contentId, i.e. the FULL media URL, token and all:
//
//     playerState : PLAYING
//     contentId   : http://192.168.1.104:8498/index.m3u8
//
// So on a shared network the effective boundary is "anyone who can reach the TV", not
// "anyone who holds the token". The token is still the right mechanism — a receiver cannot
// authenticate, the token scopes a session to ONE channel, it dies with the session, and it
// makes blind scanning of the LAN server useless — but it is a session scope, not a secret
// the LAN keeps.
//
// Three things narrow the surface underneath it, and they are what the design actually
// leans on: the server exists only while a session does, it is bound to ONE private address
// (see _startCastServer), and it can be pinned to the receiver's own address
// (startCast({ receiverHost })), which turns "read contentId and fetch it" into "read
// contentId AND hold an L2 position that lets you spoof the TV's address".
const CAST_PREFIX = '/cast/'
const CAST_TOKEN_BYTES = 32

// STALLED-READ ABORT window for the cast handler (sdk/serve.js readIdleMs), 2× the
// loopback default.
//
// The 6 s default is not a general-purpose number: it is calibrated to ExoPlayer's 8 s
// read timeout so OUR clean abort lands FIRST and drives the retry. A cast receiver is a
// different client with a different (and, on every stack we can name, longer) timeout —
// the Cast receiver's media stack sits on shaka-player, whose default streaming retry
// timeout is 30 s — so the budget that must fit underneath is bigger, and 6 s is no
// longer a bound, it is just an aggressive abort.
//
// It matters which way we err, because the two failures are NOT symmetric. The abort
// exists for reads committed to a blob the broadcaster already reclaimed swarm-wide;
// those are PERMANENT, so waiting longer costs one retry cycle of latency and nothing
// else. Aborting too early, by contrast, kills a read that would have succeeded — and
// pump() arms the idle clock BEFORE the first byte, so a cold segment whose first block
// is still crossing the swarm counts as "stalled". The cast path makes that far more
// likely than loopback: the bytes travel swarm → phone disk → phone Wi-Fi → TV, and the
// phone is not also playing the feed locally to keep it warm.
//
// 12 s: comfortably inside a 30 s receiver timeout, and double the room for a cold first
// block. WP0 could not measure the receiver's real read timeout (that firmware never
// issued a Range request and a synthetic stream never stalls), so this is a reasoned
// choice, not a measured one — hence startCast({ readIdleMs }) to override it, and 0 to
// switch the abort off entirely.
const CAST_READ_IDLE_MS = 12000

// stopCast()'s bound on closing the LAN listener (see _closeCastServer for why the bound
// is load-bearing on Bare and not on Node), and on the one playlist read the release-time
// reclaim pass needs.
const CAST_CLOSE_MS = 2000
const CAST_RECLAIM_READ_MS = 3000

// CAST RECLAIM POLICY — EXPIRED-BLOCK RECLAIM is OFF for the cast handler (opt in with
// startCast({ reclaim: true })).
//
// On loopback, reclaim is nearly free: it frees blob blocks BELOW the served playlist's
// window, and those blocks are already unfetchable swarm-wide (the broadcaster cleared
// them at rotation), so nothing that could have been served is lost. That last step is
// exactly what stops being true with a receiver in the picture. Because those blocks
// exist NOWHERE else, the viewer's own replica is the only thing that can still serve a
// consumer who has fallen below the live window — and a TV on Wi-Fi falls below it far
// more readily than the phone whose buffer the 6 s/window numbers were tuned against.
// Reclaiming would convert a recoverable lag into a permanent stall, silently, on a
// device we cannot instrument.
//
// The cost of leaving it off is one feed's blocks (~1× bitrate, ≈0.9 GB/hour at 2 Mbps)
// retained for the length of ONE cast session. Bounding that is stopCast()'s job and it
// has to do it ACTIVELY — an earlier version of this note claimed "the loopback handler's
// very next playlist serve reclaims everything below the window in a single pass", which
// is not a bound at all: unpinning only removes the opt-OUT, and the handler's reclaim
// runs exclusively on a live playlist serve for that drive, i.e. only if the viewer
// happens to tune that channel again. So stopCast() runs ONE reclaim pass itself
// (reclaimBelowWindow in serve.js) before it hands the feed back.
//
// What that still does not cover: an app killed mid-cast (task kill, crash, OOM) never
// reaches stopCast(), and strands ~1× bitrate for the session — ≈2.7 GB for a 3 h cast at
// 2 Mbps — until the viewer re-tunes that channel or LRU eviction purges the replica
// outright. Reclaim exists to bound accumulated watch HISTORY; a cast session is one
// channel with an explicit end, and the crash case falls back to eviction.

// VIEWER DISK BUDGET — what actually bounds a viewer's disk, and where this file's old
// answer was wrong.
//
// The serving core frees a live replica's blob blocks below the served window on every
// playlist serve (EXPIRED-BLOCK RECLAIM, serve.js), and _requestHandler used to claim
// that this made the viewer's disk "hold ~one live window per feed instead of growing
// ~1× bitrate forever", "safe by construction". That is true on exactly the platforms
// where a hypercore can HOLE-PUNCH its own storage file.
//
// ⚠ 32-BIT ANDROID ABIs CANNOT. The Android build EXCLUDES the `fs-native-extensions`
// addon on armeabi-v7a and x86 — it crashes the engine at startup there, and dropping it
// is the supported path because random-access-file guards every use of it (the reasoning
// is written out in full in client/android/app/build.gradle). Without it `_del` is a
// silent no-op: it answers its callback with success and frees ZERO bytes. So
// `blobs.core.clear()` there updates the bitfield, leaves every byte on disk, and the
// ACTIVE feed keeps growing at ~1× bitrate — ≈0.9 GB/hour at 2 Mbps — for the whole watch
// session, on boxes that often have 2-4 GB of free flash. 64-bit ABIs (arm64-v8a, x86_64)
// and desktop punch holes properly and do settle at ~one live window, as the old comment
// said. Measured behaviour and the viewer-facing version: docs/kb/viewer-bandwidth.md.
//
// UNLINK IS THE ONLY MECHANISM THAT FREES BYTES ON EVERY PLATFORM. Verified against the
// shipped hyper stack, so the alternatives are recorded here rather than re-litigated:
// there is no compaction / rewrite / relocation API anywhere in hypercore's storage
// layer; `core.truncate()` is a WRITER operation and throws on a replica; and
// `block-store.clear(offset, -1)` truncates from the offset to EOF — it drops the NEWEST
// blocks, which is exactly backwards for a live window. That leaves `drive.purge()`
// (close + delete both cores' storage), which is what the rotation below is built out of.
//
// Hence three bounds, all INDEPENDENT of the count bound (_feedLimit, 12 feeds by default —
// a host on hardware that cannot hole-punch may lower it, see normalizeFeedLimit):
//
//   ROTATION (_rotateActiveFeed) — when the ACTIVE feed's replica crosses the per-feed
//   budget (`reclaimBudgetBytes`, default FEED_ROTATE_BUDGET_BYTES), purge it and re-open
//   it empty IN PLACE, behind a request park so the host player sees a short pause instead
//   of a 404 storm. On a 32-bit build this is the only thing that bounds a long watch.
//
//   STORE CAP (_trimFeedBytes) — bound the warm feed cache by BYTES as well as by count:
//   purge inactive feeds oldest-first until the store is under _storeBudgetBytes. A count
//   bound says nothing about disk — 12 cached feeds that each ran an hour on a 32-bit
//   build is ~11 GB, and the SDK had no byte budget anywhere before this.
//
//   IDLE SWEEP (_sweepIdleFeeds) — the cheap 64-bit win, and the one nobody was getting:
//   reclaim has only ever run for the feed being SERVED (it triggers off a live playlist
//   serve of a `media: true` target, and only _feedDrive is ever marked media:true), so
//   the other ~11 cached feeds — prewarmed, zapped through, opened by a /feedthumb — had
//   never been reclaimed once in the life of a session.

// The per-feed budget's default, and the host-facing option that overrides it
// (`reclaimBudgetBytes`, passed straight to the serving core, which is what measures).
// 512 MiB ≈ 35 minutes of a 2 Mbps feed.
const FEED_ROTATE_BUDGET_BYTES = 512 * 1024 * 1024
// …and the FLOOR under a host-supplied one (see normalizeReclaimBudget). A rotation purges
// and re-opens the drive the player is reading, behind a request park, so it has to be rare
// relative to the live window to stay invisible: at 2 Mbps a 64 MiB budget is already one
// rotation every ~4 minutes, and anything under it is a stream that swaps its own drive out
// from under the player continuously. That is not a smaller disk bound, it is a broken
// channel — hence a hard refusal rather than a clamp, so the misconfiguration surfaces at
// construction instead of as unexplained rebuffering in the field.
const FEED_ROTATE_BUDGET_MIN_BYTES = 64 * 1024 * 1024
// The store-wide cap, in units of the per-feed budget IN FORCE: the rotating active feed
// plus ~3 more feeds' worth of history. Expressed as a multiple rather than as a second
// option because the two numbers have to move together — an operator who halves what one
// feed may hold has halved what a browsing session may hold, and a store cap that stayed
// put would just start evicting the warm cache for no stated reason.
const FEED_STORE_BUDGET_FEEDS = 4

// How long a media request may PARK while the active feed rotates (see _rotateActiveFeed
// and _armFeedSwap). The alternative is what the code did before: hand the serving core a
// null target, which it answers with an INSTANT 404 — no availability wait, no peer
// lookup — and ExoPlayer turns that into 3 retries, an onError and a remount 2.5 s later,
// ≈5.5 s of black screen for a swap that takes a few hundred ms.
//
// Parking is safe on this stack because there is NO client-side read timeout to trip:
// react-native-video builds its OkHttp client with readTimeout(0). The bound exists for
// the PLAYER's benefit, not the socket's.
//
// ⚠ WHAT AN EXPIRED PARK ACTUALLY COSTS. The comment that used to stand here made two
// claims and both were false in a load-bearing way, so they are recorded and corrected
// rather than quietly replaced:
//
//   It claimed "4 s of park plus the serving core's own 6 s availability wait is ≈10 s
//   worst case". That sum never happens. The 6 s availability wait is what the serving
//   core does with a target it HAS; a park expires into a NULL target — there is no drive,
//   which is the entire reason for the park — and a null target is the instant 404 above.
//   The two numbers are alternatives, never terms of one worst case.
//
//   It claimed "the park expiring falls back to null, i.e. today's behavior, so this is
//   never worse". Also false, and the arithmetic is the whole point: unparked, the 404
//   lands at t≈0 and the player is remounted ≈5.5 s later; parked, the SAME 404 lands at
//   t=PARK and the remount at PARK+5.5 s. An expired park is strictly WORSE than not
//   parking, by the length of the park.
//
// Parking is therefore a BET, and what follows is built to keep the bet honest instead of
// restating the false claim. The gate is armed only across the window where _feedDrive is
// genuinely null (the purge and the reopen — the drain and the measure now run in FRONT of
// it, where they used to bill against this budget and leave ≤2.5 s for the only phase that
// needs it); the reopen is bounded by what is LEFT of this budget, so the rotation's own
// failure path ends the park rather than a blind timer; and a failed rotation re-opens
// immediately instead of leaving the feed null until something else notices. What remains
// is the residual — a rotation that cannot re-open costs the viewer this much black screen
// before the player's own recovery starts — and 2500 ms (it was 4000) is that residual:
// under half of one ExoPlayer failure cycle, and well inside the live-offset buffer
// (targetOffsetMs: 10000) against which the viewer is rebuffering either way.
const FEED_SWAP_PARK_MS = 2500
// Floor on the reopen's share of that budget. A slow purge must not hand the reopen zero
// milliseconds: it would fail every rotation whose unlink ran long and then re-open on the
// recovery path anyway — churn that frees nothing and costs the viewer a park.
//
// ⚠ AND THE FLOOR IS ALLOWED TO RUN PAST PARK EXPIRY, which is the one rotation failure
// nothing reports. Once the purge has taken more than FEED_SWAP_PARK_MS - this (1500 ms),
// what is left of the park is under the floor, so the reopen gets the floor instead: the
// park timer fires while the reopen is still running, the parked requests wake to a null
// _feedDrive, 404 and cost the viewer a full remount — and then the reopen SUCCEEDS, so
// nothing throws, no recovery arms, and the feed:rotate event that follows says the rotation
// went fine. It did, for the disk; the viewer still ate the remount. On the device class this
// whole budget exists for (32-bit Android on low-end flash, where an unlink of a
// several-hundred-MiB replica is genuinely slow) that is uncommon but routine over a
// multi-hour session, not a corner case. The floor stays anyway: the alternative — failing
// the rotation the moment the purge runs long — costs the same remount AND re-opens on the
// recovery path, i.e. it is the worse half of the same trade.
const FEED_REOPEN_FLOOR_MS = 1000
// The bound on the RECOVERY re-open after a rotation failed. Deliberately NOT the park's
// budget: nobody is parked on it any more (the gate was released when the rotation gave
// up), so this one may take the time an open of a cold replica actually needs. It is what
// makes a failed rotation recover in seconds rather than at the tune watchdog's first rung
// 30 s later — and that watchdog was never a recovery arm to rely on anyway, since
// _startTuneWatchdog() returns immediately unless the play is p2p-only, p2p and non-VOD.
const FEED_REOPEN_MS = 5000
// Bound on ONE measureDriveBytes call (see _measureFeed). measuring reaches
// drive.getBlobs(), which on a replica whose blobs header never replicated — an off-air but
// entitled channel opened by a /feedthumb grid request, any peerless prewarmed feed — never
// settles at all. Unbounded, that single await wedges whichever caller it is under: the
// maintenance tick (both disk bounds, for the rest of the session) or step 2 of a rotation
// (which then holds the mutex and the park). sdk/serve.js bounds its own probe; this is the
// caller-side belt to that braces, because the cost of being wrong here is a silent
// permanent stall and the cost of the bound is one skipped measurement.
const FEED_MEASURE_MS = 5000
// How long the rotation waits for in-flight reads of the OLD drive to finish before it
// purges anyway. drive.purge() closes the drive, so a read still running when it lands
// errors and its response is destroyed — which the player already handles routinely (it
// aborts in-flight requests itself). It runs BEFORE the park is armed (nothing has been
// taken away yet, so a request served during the drain gets the real drive), which is why
// it is no longer a slice of the park budget.
//
// ⚠ IT MUST COVER sdk/serve.js's waitMs (6000), AND IT USED TO BE 1500. The serving core
// takes its in-flight slot at TARGET BIND — before waitEntry, not before the pump — for the
// express purpose of letting this drain SEE a request parked waiting for a segment to
// replicate. A bound shorter than waitMs threw that away again: a request that entered more
// than 1500 ms earlier was still counted, the drain gave up on it, the purge unlinked its
// drive, and it then polled a dead drive for the remaining 4.5 s before 404ing — the exact
// "strictly worse than an instant 404" outcome the slot accounting was moved to fix.
//
// Raising the drain is the fix rather than teaching that request to fail fast, for two
// reasons: failing fast is the serving core's half of the contract (this file cannot reach
// inside waitEntry), and the wait is nearly free HERE — it happens before the park is armed,
// so nothing has been taken away from anyone while it runs; the only cost is the replica
// staying over budget for a few more seconds. On a healthy stream the drain settles in a few
// hundred ms and this bound is never reached at all.
//
// Residual, stated rather than implied: a request already piping a large body can still
// outlast this, and its response is destroyed exactly as an abort would destroy it. That is
// the case the original comment describes and it is unchanged.
const FEED_DRAIN_MS = 6000
// The backstop on drive.purge(), the rotation's one deliberately unbounded await.
//
// It stays "unbounded" in the sense that matters — nothing carries on WITHOUT it, because
// re-opening a namespace whose delete is still in flight is the overlap the single-flight
// feed cache exists to prevent. What this bounds is the rotation's own liveness, and the
// reason it has to exist is that a purge that never settles used to be permanently
// unrecoverable rather than merely degraded: the mutex was never cleared (so NO channel could
// rotate again for the life of the process — on a 32-bit ABI that is the only disk bound
// there is), and the cache kept a placeholder that never resolved and that _evictFeed
// correctly refuses to touch, so every later tune of that channel failed with 'tune timeout'
// forever. Past this bound the rotation gives up: it drops the mutex and the cache slot,
// says so on the status stream and hands recovery to the tune ladder.
//
// A MINUTE, not seconds, because the cost of being wrong in each direction is asymmetric. Too
// long merely delays a recovery on a device that is already broken; too short declares a
// legitimately slow unlink dead and lets something re-open over a delete that is still
// running — the very overlap the unbounded await was protecting. An unlink of a
// several-hundred-MiB replica on low-end flash is seconds, not a minute, so this is far past
// any honest purge and still bounded.
//
// Residual, stated rather than implied: once this fires, the pending purge is still pending,
// and the next open of that feed can therefore build a drive over a namespace whose delete
// eventually lands. That is a real hazard and it is the lesser one — the alternative is the
// channel, and the whole rotation mechanism, staying dead until the app restarts.
const FEED_PURGE_MS = 60000
// Hard cap on a cache-slot claim held over an open still IN FLIGHT — see _claimSlot. A claim
// normally lifts when the open settles; an open that NEVER settles would otherwise hold it
// forever, and a permanently claimed slot is a permanently un-evictable one, i.e. exactly the
// poisoning this file has already had to fix twice. Past the cap the claim lifts and the
// ordinary eviction path may act, which is the honest reading of an open this old anyway
// (2× the default tune timeout, and 6× the recovery re-open's bound).
const FEED_CLAIM_MS = 30000
// Feed-cache maintenance tick: the idle reclaim sweep + the store byte cap. Nothing that
// is not being served GROWS quickly (an idle replica only gains bytes through the
// zap-prefetch neighbour warm), so this is a housekeeping interval, not a control loop —
// the serving core's own per-drive reclaim throttle is 30 s for the feed being watched.
const FEED_SWEEP_MS = 60000
// …and the backstop on ONE tick of it. The tick is busy-guarded so a slow sweep cannot
// overlap itself, and that guard is a single boolean with no way back if the pass never
// settles: BOTH disk bounds then die silently for the rest of the session. Four ticks is
// far longer than any honest pass (a full 12-feed sweep is metadata reads) and short enough
// that a wedged pass costs minutes, not the session.
const FEED_SWEEP_STUCK_MS = 4 * FEED_SWEEP_MS

// Constant-time string compare for the cast token. The realistic attack surface is small
// (a 256-bit random hex path segment, on a LAN, and a receiver hands the whole URL to any
// peer that asks it — see the note above), but a byte-by-byte early return in front of
// decrypted entitled content is not worth defending, and this costs nothing. Length is
// compared first and non-secretly — the token length is public.
function constantTimeEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// RFC1918 private IPv4 — the address families a TV on the same LAN can actually reach.
function isPrivateIPv4 (ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  const m = /^172\.(\d{1,3})\./.exec(ip)
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

// A dotted-quad IPv4 literal (any range, loopback included) — the shape the cast server
// can bind() to directly. A hostname is not one, and neither is anything with a slash,
// colon, query or userinfo in it.
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
function isIPv4Literal (s) {
  const m = IPV4_LITERAL.exec(String(s))
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && (o === '0' || !o.startsWith('0')))
}

// Peer addresses arrive in more than one spelling for the same host: a dual-stack listener
// reports an IPv4 peer as the IPv4-MAPPED form `::ffff:192.168.1.128`, IPv6 literals may be
// bracketed and are case-insensitive, and a link-local carries a `%zone` suffix. Compare
// normalised or the pin below silently never matches. (Not a general IPv6 canonicaliser —
// receiver pinning is an exact-address check between two values that come from the same
// LAN, and anything it cannot normalise simply fails to match, which is the safe direction.)
//
// IPv4-mapped addresses have THREE spellings for the same host and all of them are folded,
// because a v4 pin that meets an unfolded one does not error — it silently never matches:
//
//   ::ffff:192.168.1.5           what node:net and bare-tcp actually report, and the only
//                                one reachable from a socket today
//   0:0:0:0:0:ffff:192.168.1.5   the uncompressed form — a hand-written receiverHost
//   ::ffff:c0a8:0105             the hex form RFC 4291 also permits
//
// The last two are unreachable from a remoteAddress on either runtime; they are folded for
// the value the HOST supplies, where a plausible spelling that quietly pins nothing is the
// same failure this whole normaliser exists to prevent. The fold is exact rather than
// permissive: only ::ffff:0:0/96 (which is by definition v4-mapped) matches, so ::ffff:0:c0a8:105
// — IPv4-TRANSLATED, a different block — is left alone rather than mistaken for it.
const V4_MAPPED_RE = /^(?:::|(?:0{1,4}:){5})ffff:(.+)$/
const V4_MAPPED_HEX_RE = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
function normalizePeer (addr) {
  if (typeof addr !== 'string' || !addr) return null
  let s = addr.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone > 0) s = s.slice(0, zone)
  const mapped = V4_MAPPED_RE.exec(s)
  if (mapped) {
    const tail = mapped[1]
    const hex = V4_MAPPED_HEX_RE.exec(tail)
    if (isIPv4Literal(tail)) s = tail
    else if (hex) {
      const n = (parseInt(hex[1], 16) * 65536) + parseInt(hex[2], 16)
      s = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
    }
  }
  return s || null
}

// `advertiseHost` becomes the AUTHORITY of a URL that carries the session token, so it has
// to be an authority and nothing else. Unvalidated, `evil.example/x?` produced
// `http://evil.example/x?:41234/cast/<token>/index.m3u8` — a perfectly valid URL that
// sends the token to a third party as a query string. The caller controls this value, so
// this is hardening on a public SDK surface rather than a boundary, but a check that
// costs one regex belongs on the one input that can redirect a credential.
// Accepted: an IPv4 literal, a bracketed IPv6 literal, or a DNS hostname.
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/
function isCastHost (s) {
  if (typeof s !== 'string' || !s || s.length > 253) return false
  if (s.startsWith('[')) return s.endsWith(']') && /^\[[0-9A-Fa-f:.]+\]$/.test(s) // IPv6 literal
  if (isIPv4Literal(s)) return true
  return HOSTNAME_RE.test(s)
}

// `receiverHost` -> the normalised address list the cast handler pins to, or null for the
// default (unpinned). One string, or an array: a multi-room Cast GROUP is the case where a
// single address is wrong, because the members fetch the media themselves rather than
// through the device the sender launched on — a host that casts to a group must pass every
// member's address, or leave the pin off. That is also why this option is opt-in and unset
// by default: WP4 does not speak the Cast protocol and cannot discover any of this itself.
//
// ⚠ AN EMPTY ARRAY THROWS. Every other bad value here fails closed — '', 0, false, 'tv.local',
// '192.168.1.5:8009', ['1234'] and [{}] all reject on the call — but `[]` used to return null,
// and null means UNPINNED. So the one input that says "pin this session" and names nothing was
// also the one that silently served every peer, while the host's own code believed it had
// pinned. The way to get there is not exotic: a host building a multi-room group's member list
// from a lookup that came back empty (a member offline, an API hiccup, the group not joined
// yet) — precisely the case the pin exists for. Omitting the option is how you ask for no pin.
function normalizeReceivers (v) {
  if (v == null) return null
  const list = Array.isArray(v) ? v : [v]
  if (!list.length) {
    throw new Error('receiverHost must be an IP address, or an array of them (got an empty array — omit receiverHost to leave the session unpinned)')
  }
  const out = []
  for (const raw of list) {
    const n = normalizePeer(typeof raw === 'string' ? raw : '')
    // An IP literal only. A hostname would need a DNS round trip per request, and a pin
    // that never matches is indistinguishable from a cast that simply does not work — so
    // reject on the CALL rather than let a typo become a silently dead session. The IPv6
    // side is a shape check, not a parser (it must contain a colon, so a bare '1234'
    // cannot slip through as one); an unparseable value would only ever fail to match.
    if (!n || !(isIPv4Literal(n) || (n.includes(':') && /^[0-9a-f:]+$/.test(n)))) {
      throw new Error('receiverHost must be an IP address, or an array of them (got ' + JSON.stringify(raw) + ')')
    }
    if (!out.includes(n)) out.push(n)
  }
  return out
}

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

// Minimum interval between panel-topic refresh() kicks (_kickPanelDiscovery). Each
// refresh is a full DHT query — the app-side login ladders tick every 2.5 s, and a
// per-tick refresh would fire a lookup storm on a box whose radio is the bottleneck.
const PANEL_REFRESH_MIN_MS = 5000

// The post-login stagger (_schedulePostLogin). Prewarm and the stale-replica sweep used
// to fire in the SAME tick as the 'streams' emit — exactly when the host is sending its
// own post-login traffic (the RN app's "remember me" write, the Splash->Menu prefs
// round-trip) — and on a single-threaded TV worklet the pile-up left IPC messages parked
// for ~40 MEASURED seconds, long enough for a viewer quitting the app to lose the write.
// Prewarm at 3 s: its product value is a warm FIRST zap, and a viewer physically cannot
// zap before the menu has painted (itself seconds of RN work that benefits from an idle
// worklet) — the delay costs warmth only for a zap inside those 3 s. The sweep at 20 s:
// disk hygiene over namespaces stale since before this boot; nothing about the session
// needs it early, so it waits until prewarm's dials have settled.
const PREWARM_DELAY_MS = 3000
const REPLICA_SWEEP_DELAY_MS = 20000
// How many sweep iterations run between real setTimeout yields (_doSweepStaleReplicas).
// Awaiting already-resolved bee reads drains as MICROTASKS — the loop never reaches the
// poll phase and IPC 'data' never runs — so the yield must be a macrotask.
const SWEEP_YIELD_EVERY = 250

export class AliranPlayer extends Emitter {
  constructor ({ panelPubKey, storeDir = './aliran-store', http, fs, os, hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, reclaimBudgetBytes, feedLimit, remote, deviceId, deviceLabel, appVersion, platform } = {}) {
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
    // OPTIONAL, unlike http/fs: node:os (Node) or bare-os (Bare). Only startCast() needs
    // it — to find this device's LAN address — and only when the host does not pass an
    // explicit advertiseHost. Kept optional so a pre-cast integrator constructing
    // AliranPlayer({ http, fs }) by hand keeps working; startCast() is the one call that
    // says so, and it says so with a message that names the fix.
    this._os = os || null
    this._store = null
    this._swarm = null
    this._panelBee = null
    this._catalogWatcher = null
    this._call = null
    this._panelPeerKey = null // hex public key of the peer that PROVED it is the panel (see _maybeArmRpc)
    this._panelDiscovery = null // the panel topic's PeerDiscovery — report() kicks refresh() when the RPC is down
    this._rpcProbeMs = 8000 // hello-probe bound for candidate RPC sockets (tests shrink it)
    this._loginRpcWaitMs = 10000 // login's bounded wait for the RPC to arm (tests shrink it) — see _awaitPanelRpc
    this._panelRefreshAt = 0 // last _kickPanelDiscovery, so refresh() fires at most every PANEL_REFRESH_MIN_MS
    this._bootTrace = [] // boot diagnosis marks, construction -> first 'streams' (see _mark / bootTrace)
    this._bootSocketSeen = false // so the connection handler marks only the FIRST socket
    this._server = null
    // --- cast to a TV (startCast): the SECOND, LAN-scoped server ---
    // Everything here is null while no cast session exists, and goes back to null on
    // stopCast(). The loopback server above is untouched by all of it.
    this._castServer = null // LAN http server, bound to ONE private address — created per session, closed by stopCast()
    this._castSockets = null // its live sockets, so stopCast() can hang up a receiver that is mid-stream
    this._cast = null // { streamId, source, token, drive, feedCacheKey, host, port, url, … }
    this._castFeedKey = null // the pinned feed's _feeds key — _trimFeeds must never evict it
    this._castOp = null // serializes startCast/stopCast (a double-tapped Cast button must not leave two servers)
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
    //
    // This is a bound on HANDLES — open drives and swarm topics — and it was never a disk
    // answer: prewarm's opens are connections only (~free), and playback is what fills a
    // replica. Where the platform hole-punches, a cached feed settles at ~one live window
    // and 12 costs almost nothing. Where it CANNOT (32-bit Android ABIs), every byte a
    // zapped-through feed replicated survives until eviction unlinks it, so a host on that
    // hardware can lower this — see normalizeFeedLimit and the VIEWER DISK BUDGET note.
    this._feedLimit = normalizeFeedLimit(feedLimit)
    // …and the BYTE bound the count above cannot express (see the VIEWER DISK BUDGET note).
    this._feedBudgetBytes = normalizeReclaimBudget(reclaimBudgetBytes) // per-feed: over this, the ACTIVE feed ROTATES (0 = off)
    // Store-wide: over this, inactive feeds are purged oldest-first. Floored at the
    // DEFAULT budget when rotation is switched off, because `reclaimBudgetBytes: 0` means
    // "do not rotate", not "hold no warm cache" — deriving 0 × 4 from it would evict every
    // cached feed on the first sweep, which is the opposite of what that option asks for.
    this._storeBudgetBytes = FEED_STORE_BUDGET_FEEDS * (this._feedBudgetBytes || FEED_ROTATE_BUDGET_BYTES)
    this._storeHeldWarned = false // the store cap could not be enforced (see _trimFeedBytes) — recorded once per engine
    // cacheKey -> consecutive _trimFeedBytes passes that could not measure that feed. Rebuilt
    // from scratch every pass, so a feed that leaves the cache (or answers again) drops out on
    // its own and this can never grow past the cache. A feed stuck here is invisible to the
    // store cap — see the skip branch in _trimFeedBytes.
    this._measureSkips = new Map()
    this._measureSkipWarned = false // …said once per engine, like _storeHeldWarned
    // The PARK GATE, or null: { done, release, timer, startedAt }. While it is set, media
    // requests PARK on `done` instead of resolving a null drive — see _armFeedSwap /
    // _mediaTarget. It is a property of the SERVING side and four callers that know nothing
    // about any rotation may release it (the park timer, serveFeed on a zap, stop(),
    // _purgeAndRebuild) — which is exactly why it is no longer also the rotation's mutex.
    this._feedSwap = null
    // The rotation MUTEX, and NOTHING ELSE: the in-flight _rotateActiveFeed's token, or null.
    // Cleared by that rotation's own finally, and — see stop()/_purgeAndRebuild — by a
    // teardown, because the rotation's one deliberately unbounded await (drive.purge()) is
    // exactly what a store deleted underneath it can leave pending forever, and a mutex left
    // set switches rotation off for the life of the process. It used to be the same field as
    // the park gate above, and that
    // conflation was a live hazard rather than a tidiness point: any of the four park
    // releasers took the single-flight guard down mid-rotation, leaving the interval between
    // drive.purge() and the reopen unguarded — the one interval where a second rotation
    // would build a second Hyperdrive over a namespace that is being deleted, which is the
    // deadlock the single-flight feed cache exists to prevent.
    //
    // It also used to carry the rotation's CACHE SLOT (`{ cacheKey, slot }`), so that
    // _evictFeed could refuse to evict what the rotation was working on. That was the same
    // conflation one layer down and it failed the same way: a mutex's lifetime is the
    // function's, and the moment this finally cleared it, an open the rotation had put in the
    // cache and was still going to serve was unprotected. Slot ownership is a property of the
    // SLOT now — see _claimSlot — so it lasts exactly as long as the open it protects, and no
    // path that touches the cache has to know a rotation exists.
    this._feedRotate = null
    // TEARDOWN GENERATION. Bumped by stop() and by _purgeAndRebuild(), i.e. by everything
    // that invalidates the store, the swarm and the feed cache at once. Long-running work
    // captures it and re-checks after EVERY await: `this._active !== a` only says the
    // viewer zapped, and a rotation that passed that check could still reach _ensureStore()
    // afterwards and build a NEW Corestore + Hyperswarm and join a topic after stop() had
    // returned — or, under _purgeAndRebuild, hand the rebuilt engine a store rooted in a
    // directory that was just rmSync'd.
    this._epoch = 0
    // …and the PREVENTIVE half of that, because the epoch alone is only ever checked AFTER
    // the fact. INVARIANT: while this is true, the store and the swarm are gone or going and
    // NOTHING may build new ones — _openFeed refuses rather than calling _ensureStore(), which
    // is the one path that would otherwise create a fresh Corestore in a directory
    // _purgeAndRebuild is about to rmSync, or join a swarm stop() has destroyed. Set by both
    // teardowns; cleared by _purgeAndRebuild once the delete is done and it is rebuilding (a
    // corruption purge is a RECOVERY — the retry _recover fires afterwards must be allowed to
    // open on the fresh store), never cleared by stop(), which is terminal.
    this._storeDown = false
    // The loopback server's request handler, kept so the rotation can reach its
    // whenDrained()/inflight() accounting (createDriveHandler hangs them on the returned
    // function). _ensureServer passes the same object to http.createServer.
    this._handler = null
    this._feedMaintTimer = null // feed-cache maintenance tick (idle reclaim sweep + store byte cap)
    this._feedDiscovery = null
    this._feeds = new Map() // feedKey:encKey -> Promise<{ drive, discovery }> — opened feeds (single-flight), reused across resolve()s
    // feedKey -> [{ key, socket }] for the connections its replica was PURGED on, until the
    // next time that feed is SERVED. The deferred half of the eviction teardown: the socket
    // decides whether to hang up, the key does it. See _recordPurgedFeed.
    this._purgedFeeds = new Map()
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
    // The logged-in account name. Set by _doLogin, cleared by stop() — the predicate
    // for "a login has established what this viewer may see", and the key the grant
    // watcher below needs to find its own record. Deliberately NOT folded into
    // _session: that one exists only when the panel issued a token, while the grant
    // watch must run for any successful login.
    this._username = null
    // Live entitlement refresh: watcher over this viewer's OWN `user/<name>` record in
    // the replicated panel bee — the same signed source login() reads its grants from
    // (see sdk/login.js). Lifetime tracks _catalogWatcher's: re-armed by _openPanel
    // after a corruption purge, closed by stop().
    this._grantWatcher = null
    this._pushPending = null // coalescing guard for _pushCatalog (see there)
    this._pushAgain = false // a push arrived mid-rebuild — sweep once more before settling
    this._pushTimeoutMs = 30000 // ceiling on ONE display-list rebuild (see _pushCatalog)
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
  // calls that a future edit would forget. Only the diagnostic events are recorded:
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
      // A cast that ended ON ITS OWN. "The TV stopped and I do not know why" is a report an
      // operator gets, and without this the only trace of the cause was a 'cast' event the
      // host app consumed and dropped — nothing reached the ring, so the report looked like
      // a normal viewing session.
      //
      // ⚠ state + streamId + reason ONLY, listed one field at a time. The ring leaves this
      // device inside a problem report, and a cast session's url and token must never ride
      // along on one. _endCast's payload deliberately carries neither, and this case must
      // stay narrow enough that adding a field to that payload later cannot change it.
      case 'cast':
        return this._recordEvent('cast', `${arg && arg.state} ${arg && arg.streamId} (${arg && arg.reason})`)
    }
  }

  // Append one breadcrumb. Detail is truncated AT RECORD TIME (not at send time) so a
  // pathological error message can never make the ring itself expensive to hold.
  _recordEvent (type, detail) {
    const d = shortLabel(detail, REPORT_EVENT_DETAIL_MAX)
    this._eventRing.push({ t: Date.now(), type: shortLabel(type, 40) || 'event', detail: d })
    if (this._eventRing.length > REPORT_EVENT_LIMIT) this._eventRing.splice(0, this._eventRing.length - REPORT_EVENT_LIMIT)
  }

  // --- boot trace (diagnosis) ---

  // Timestamped marks from construction to the first 'streams' emit, so a slow start can
  // be ATTRIBUTED on a device (store open, DHT bind, first socket, RPC armed, each
  // sdk/login.js phase) instead of guessed at from the login screen's spinner. Marks are
  // cheap ({t,name,detail} pushes), never emitted as events, and capped so a retry
  // ladder that never lands cannot grow the array for as long as the screen keeps trying.
  _mark (name, detail) {
    if (this._bootTrace.length >= 400) return
    this._bootTrace.push({ t: Date.now(), name, ...(detail == null ? {} : { detail: String(detail) }) })
  }

  // A copy, so a host logging the trace cannot hold (or mutate) the live array.
  bootTrace () {
    return this._bootTrace.slice()
  }

  // --- public API ---

  // Join the panel's topic and replicate its signed DB. Resolves once the topic is
  // joined (the actual socket dials in the background — login retries cover the gap).
  async connect (panelPubKey) {
    if (panelPubKey) this._panelKey = panelPubKey
    if (!this._panelKey) throw new Error('no panelPubKey configured')
    this._mark('connect')
    await this._recover(() => this._openPanel())
    this.emit('ready')
  }

  /**
   * The engine half of a CACHED WARM START: stand the loopback server up before any
   * login so a host can paint a lineup it cached on disk last session (display metadata
   * only — a cache never holds keys, so playback still waits for the real login).
   * Resolves to the server's port; the host re-points its cached art/guide/thumb URLs
   * at it (client/backend/catalog-cache.mjs rewriteOrigins).
   *
   * Safe pre-login by construction: _ensureServer binds 127.0.0.1 only, and every route
   * guards on its drive being open — an art request that arrives before the assets
   * replica opens 404s cleanly (hosts already treat a 404 as "no art right now") rather
   * than parking. The drive opens are kicked here best-effort so previously replicated
   * poster blocks serve as soon as the store allows: now if the panel DB is already
   * open, otherwise on 'ready' — and the real login re-runs both anyway (single-flight,
   * idempotent).
   */
  async warmStart () {
    const port = await this._ensureServer()
    this._mark('warm-start')
    const kick = () => { this._openAssets().catch(() => {}); this._openEpg().catch(() => {}) }
    if (this._panelBee) kick()
    else this.once('ready', kick)
    return port
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
   * WHAT A CALLER MUST DO WITH A REJECTION. Tell the two apart and act differently — and
   * the default runs toward KEEPING, because erasing is irreversible and costs a viewer a
   * walk to another room for a phone:
   *
   *   transient   'not connected to panel', a closed channel, a swarm still dialling, a
   *               bare 'unknown user' (the account record has not REPLICATED to this
   *               device yet — the local bee is empty for the first moments after the
   *               panel socket comes up), and most of what the panel says — keep the
   *               stored material and try again.
   *   terminal    'key handover does not match this account' (which is what a password
   *               rotation looks like from here, because the panel mints a NEW keypair),
   *               a session token that does not verify, a success that issued no token,
   *               and the two `session` codes that are a VERDICT ON THIS ACCOUNT:
   *               'account disabled' and 'unknown user' — ERASE the stored material.
   *
   * "Anything the panel said" IS NOT THE RULE, and reading it that way destroyed accounts.
   * The same `session` responder answers 'bad request', 'no session challenge (login
   * first)', 'missing deviceId', 'auth failed', 'sessions unavailable' and 'device-limit':
   * a malformed call, a lost one-shot challenge, a panel missing its own signing key, an
   * operator whose device slots are full. None of those is a judgement on these keys.
   * client/backend/signin-vault.mjs is the worked classification, code by code, and
   * tools/signin-vault-test.mjs fails if the panel grows a code nobody has classified.
   *
   * AND BOUND THE RETRY BY LOGINS, NOT BY TIME. Every attempt that reaches the panel
   * spends a `login` the panel's throttle counts (LOCKOUT_THRESHOLD, per account and per
   * peer) — but 'not connected to panel' is thrown before any RPC leaves the device, so
   * those cost nothing. A loop that cannot tell the two apart locks the account out of the
   * panel it is trying to reach.
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
    this._mark('streams', streams.length + ' streams')
    // Second argument (S53): the panel-delivered VOD provider config, or undefined.
    // Additive — every existing listener takes one argument and is untouched.
    this.emit('streams', streams, this._vod || undefined)
    this._schedulePostLogin() // prewarm + stale-replica sweep, STAGGERED — see the constants
    return streams
  }

  // Arm the deferred post-login work (see PREWARM_DELAY_MS / REPLICA_SWEEP_DELAY_MS for
  // why it is deferred at all). Epoch-guarded, the file's own idiom: stop(), a corruption
  // purge or a re-login during the delay makes the pending timer a silent no-op — a
  // re-login simply re-schedules (prewarm is idempotent, the sweep is single-flight).
  // Unref'd so a pending timer never keeps a worklet alive.
  _schedulePostLogin () {
    const gen = this._epoch
    const arm = (ms, fn) => {
      const t = setTimeout(() => { if (this._epoch === gen && this._store) fn() }, ms)
      if (typeof t.unref === 'function') t.unref()
    }
    if (this._prewarmN) arm(PREWARM_DELAY_MS, () => this.prewarm().catch(() => {})) // background warm — never blocks login
    arm(REPLICA_SWEEP_DELAY_MS, () => this._sweepStaleReplicas()) // background disk sweep — never blocks or fails login
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
    // login order for uncurated streams. SERIAL on purpose: the ids are already in zap
    // order, so serial warms ch1 — the channel a viewer actually lands on — FIRST, and
    // spreads the per-feed Noise-handshake CPU across time instead of stacking N
    // concurrent handshakes on the single worklet thread right after a login.
    const ids = this._curatedIds().slice(0, n === Infinity ? undefined : n)
    for (const id of ids) {
      try {
        const k = this._entitled.get(id)
        if (!k || !k.encryptionKey) continue
        const feedKey = await this._currentFeedKey(id, k.feedKey)
        if (feedKey) await this._openFeed(feedKey, k.encryptionKey)
      } catch { /* prewarm is best-effort; a real play will retry */ }
    }
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
        if (!this._kickPanelDiscovery()) return { error: 'offline' }
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
      // …AND LET GO OF THE PREVIOUS CHANNEL'S FEED. These two fields are what every disk path
      // reads as "the feed being watched, never touch it" (_trimFeeds on the key,
      // _sweepIdleFeeds and _trimFeedBytes on both), and they were assigned in two places and
      // cleared in NONE. Zapping from a P2P channel to a redirect one therefore left the feed
      // just left behind pinned as `held` for the rest of the session: exempt from the idle
      // sweep, uncounted against the store cap by being unevictable, and eating the cap's
      // budget while nothing served a single byte from it. Both halves have to go — clearing
      // only the key leaves the drive-identity guards pinning it just as hard. The replica
      // stays in the warm cache and a zap back is still instant; it is merely evictable again.
      this._activeFeedKey = null
      this._feedDrive = null
      this._feedDiscovery = null
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

  // --- cast to a TV -----------------------------------------------------------------
  //
  // resolve() hands the host a 127.0.0.1 URL. A TV cannot reach it — that loopback bind
  // is the entire security boundary for normal playback, because the bytes behind it are
  // DECRYPTED entitled content. So casting does not widen that server; it stands up a
  // SECOND one that exists only while a cast session does, bound to ONE private LAN
  // address, whose every path is behind a fresh 32-byte token:
  //
  //     http://<lan-ip>:<port>/cast/<token>/index.m3u8
  //
  // ONE address, not 0.0.0.0. This server was originally bound to all interfaces with the
  // token as its only access control, which meant it also answered on the VPN tunnel,
  // every container bridge, the mobile-data interface, and — on a host whose only
  // non-internal IPv4 is public (a desktop on a VPS, a flat network, a routable carrier
  // v4) — on the open internet. And the token is NOT a secret the network keeps: a receiver
  // reads the whole URL back to any unauthenticated peer that joins its session (measured —
  // see the CAST_PREFIX note above). So the bind is the SAME address the URL advertises,
  // _lanAddress() REFUSES to pick a non-RFC1918 one, and a host that knows its receiver's
  // address can pin the server to it (startCast({ receiverHost })).
  //
  // The token lives in the PATH, not the query string: the serving core splits the query
  // off before routing (sdk/serve.js), so a ?token= would be silently discarded rather
  // than checked — a wrong-token request would then be served, not refused.
  //
  // The path prefix is also what makes the playlist work UNCHANGED. The broadcaster's
  // playlists carry bare relative segment names (ffmpeg's hls muxer writes the basename;
  // mirrorDirToDrive copies the file byte-for-byte), so a receiver that fetched
  // …/cast/<token>/index.m3u8 resolves `seg123.ts` against it and asks for
  // …/cast/<token>/seg123.ts on its own. No playlist rewriting, no per-segment signing.
  //
  // The feed drive is PINNED for the session. The loopback route resolves against
  // this._feedDrive, which every zap replaces — a receiver holding a stable URL must not
  // silently follow the phone's channel changes mid-playlist. Pinning also protects the
  // feed from _trimFeeds (eviction PURGES the replica's storage) and from the loopback
  // handler's expired-block reclaim (see _requestHandler).
  //
  // Pinned to the CHANNEL, not to a Hyperdrive object: a tune-watchdog retune (which
  // closes and re-opens the same feedKey) and a broadcaster restart (which rotates the
  // channel onto a new one) both re-point the session — see _recastFeed, which also
  // records what that does NOT cover.

  /**
   * Start serving an entitled stream to a TV on this device's LAN.
   *
   * Resolves to { url, host, port, token, streamId, source, feedKey, type, candidates,
   * receiverHost }.
   * Hand `url` to the receiver. Redirect channels (S23) — and any host configured
   * hybrid.mode 'cdn-only' — resolve to a remote URL with source 'cdn' and NO local
   * server at all: host/port/token are undefined, and a redirect channel's `headers`
   * rides along exactly as it does from resolve().
   *
   * opts:
   *   advertiseHost  override the auto-detected LAN address (a virtual adapter winning
   *                  the pick, an operator-known hostname, a host with no RFC1918
   *                  address at all). Validated as a bare authority — it becomes the
   *                  host of a URL that carries the session token. An IPv4 literal that
   *                  is one of this device's own addresses is also what the server binds
   *                  to; anything else (a hostname, a NAT address) falls back to a
   *                  0.0.0.0 bind, which is then the host's explicit choice. That fallback
   *                  is this option's alone: an AUTO-picked address the device has lost by
   *                  bind time (the network moved while the feed opened) REJECTS instead of
   *                  widening — see _bindAddress.
   *   receiverHost   OPT-IN receiver pin: an IP address (or an array of them) that is the
   *                  ONLY peer this session serves — everything else 404s, identically to
   *                  a wrong token. Off by default. It exists because the token is NOT the
   *                  boundary on a shared network: a receiver reads the full media URL back
   *                  to any unauthenticated peer that joins its session (measured — see the
   *                  CAST_PREFIX note at the top of this file), so pinning is what turns
   *                  "read the URL and fetch it" into "read the URL AND answer as the TV".
   *                  WP4 cannot discover the address itself (the engine does not speak the
   *                  Cast protocol) — the host passes it once it knows which device it
   *                  launched on. ⚠ A multi-room GROUP fetches from each member, so pass
   *                  every member's address or leave the pin off. ⚠ An EMPTY array throws:
   *                  asking for a pin and naming nothing must not quietly serve everyone.
   *   readIdleMs     stalled-read abort window for THIS session (default
   *                  CAST_READ_IDLE_MS); 0 disables it.
   *   reclaim        opt the cast handler INTO expired-block reclaim (default off — see
   *                  the CAST RECLAIM POLICY note at the top of this file).
   *
   * Serialized against stopCast(): a double-tapped Cast button cannot leave two servers.
   */
  startCast (streamId, opts = {}) {
    const run = () => this._doStartCast(streamId, opts)
    const p = (this._castOp || Promise.resolve()).then(run, run)
    this._castOp = p.catch(() => {}) // a failed op must not poison the next one
    return p
  }

  /**
   * End the cast session: hang up the receiver's sockets, close the LAN server, forget
   * the token, unpin the feed. Idempotent — resolves false when nothing was casting.
   */
  stopCast () {
    const run = () => this._doStopCast()
    const p = (this._castOp || Promise.resolve()).then(run, run)
    this._castOp = p.catch(() => {})
    return p
  }

  /**
   * The live cast session (same shape startCast() resolved to), or null.
   *
   * `url` is always a string here: _doStartCast publishes this._cast only AFTER the bind
   * succeeds, precisely so this getter cannot hand out the half-built session (url null,
   * port null) that it used to expose between the pin and the listen — a shape
   * sdk/index.d.ts declares impossible. That ordering is also why this getter does not
   * need to serialize on _castOp.
   */
  castSession () {
    const c = this._cast
    if (!c) return null
    return {
      streamId: c.streamId,
      url: c.url,
      host: c.host ?? undefined,
      port: c.port ?? undefined,
      token: c.token ?? undefined,
      source: c.source,
      feedKey: c.feedKey ?? null,
      type: c.type,
      headers: c.headers,
      candidates: c.candidates,
      receiverHost: c.receivers ?? undefined
    }
  }

  async _doStartCast (streamId, { advertiseHost, receiverHost, readIdleMs, reclaim } = {}) {
    const keys = this._entitled.get(streamId)
    if (!keys) throw new Error('not entitled to ' + streamId)
    // advertiseHost becomes the authority of a token-bearing URL — check its SHAPE before
    // anything else, so a caller typo fails on the call rather than on the receiver.
    if (advertiseHost != null && !isCastHost(advertiseHost)) {
      throw new Error('advertiseHost must be a bare hostname or IP address (got ' + JSON.stringify(String(advertiseHost)) + ')')
    }
    // receiverHost is compared against a SOCKET's remote address, so it must be a literal:
    // resolving a name per request is not something a media serve can afford, and a
    // silently-never-matching pin would look exactly like a broken cast.
    const receivers = normalizeReceivers(receiverHost)
    // Live catalog read first (the resolve() contract): an admin URL edit or a feedKey
    // rotation must reach a cast the same way it reaches a tune.
    const chan = await this._currentChannel(streamId, keys)
    const type = chan.type === 'vod' ? 'vod' : 'live'

    // Redirect channels: the viewer already plays an operator-set remote https URL, so
    // there is nothing local to serve and no reason to open a socket. Hand the receiver
    // the same URL the phone would have played. Checked before the cdn-only branch below,
    // exactly as resolve() orders them — a redirect record names its own URL and the
    // operator's cdnUrl template has nothing to say about it.
    if (chan.redirect && chan.url) {
      return this._castRemote(streamId, chan.url, type, null, chan.headers ?? undefined)
    }

    // hybrid.mode 'cdn-only' means "never open P2P", and this call USED TO IGNORE IT: it
    // opened a Hyperdrive, joined a swarm topic and replicated on a host that had
    // explicitly configured the opposite. resolve() honours the mode by returning the
    // operator's own cdnUrl(streamId), and _thumbTarget honours it by refusing to warm a
    // drive; mirror resolve(). Mirroring beats refusing here: a receiver plays an https
    // CDN URL directly, so a cdn-only host gets a WORKING Cast button that costs it no
    // P2P at all, and the shape is already proven by the redirect branch above. Ordered
    // like resolve(): before the "not broadcasting" check, so a catalog entry with no
    // feedKey still casts from the CDN.
    if (this._hybrid.mode === 'cdn-only') {
      return this._castRemote(streamId, this._hybrid.cdnUrl(streamId), type, chan.feedKey ?? null, undefined)
    }

    const feedKey = chan.feedKey
    if (!feedKey || !keys.encryptionKey) {
      throw new Error(type === 'vod' ? 'title is not available right now' : 'channel is not broadcasting right now')
    }
    // Resolve the LAN address BEFORE opening anything: "no usable interface" is an
    // instant, actionable failure, not something to discover after a 15 s tune.
    const picked = advertiseHost ? { address: String(advertiseHost), candidates: undefined } : this._lanAddress()
    const host = picked.address

    // Open (or reuse) the feed through the same bounded single-flight path every other
    // caller uses. Reuse matters: casting the channel the viewer is already watching must
    // not open a second Hyperdrive over the same store namespace.
    let feed = await this._openFeedWithin(feedKey, keys.encryptionKey, this._tune.timeoutMs)
    if (!feed) feed = await this._openFeedWithin(feedKey, keys.encryptionKey, this._tune.timeoutMs)
    if (!feed) throw new Error(`tune timeout: the feed did not open within ${Math.round(this._tune.timeoutMs * 2 / 1000)}s — try again`)

    // Replace any previous session (and its port + token), handing the teardown the NEW
    // pin: it trims the cache, and the feed we just opened must already be protected when
    // it does — the previous session's unpinning is exactly what can put the cache over
    // its cap.
    const cacheKey = feedKey + ':' + keys.encryptionKey
    await this._doStopCast(cacheKey)
    const token = b4a.toString(hcrypto.randomBytes(CAST_TOKEN_BYTES), 'hex')
    // Built here but NOT published to this._cast yet — see below.
    const session = {
      streamId, source: 'p2p', type, feedKey, token,
      drive: feed.drive,
      feedCacheKey: cacheKey,
      host, port: null, url: null, headers: undefined,
      candidates: picked.candidates,
      receivers // null = unpinned (the default); otherwise the only addresses served
    }
    this._castFeedKey = cacheKey // pin: _trimFeeds must not purge it mid-cast
    let port
    try {
      // `host` is passed so the bind can be narrowed to it, and `candidates !== undefined`
      // says the address was AUTO-PICKED rather than supplied — which decides whether a
      // no-longer-owned address may widen the bind to 0.0.0.0 or must fail (see
      // _startCastServer). The pick happened before the feed opened, i.e. up to 2×
      // tune.timeoutMs ago, which is long enough for the network to have moved.
      //
      // The handler needs no session handed to it: it resolves this._cast per request, and
      // this._cast is published below, after the bind — a socket that is listening but has
      // no session simply 404s everything, which is the correct answer for that instant.
      port = await this._startCastServer({
        readIdleMs: Number.isFinite(readIdleMs) && readIdleMs >= 0 ? readIdleMs : CAST_READ_IDLE_MS,
        reclaim: reclaim === true
      }, host, picked.candidates !== undefined)
    } catch (err) {
      await this._doStopCast() // never leave a pinned feed (or a half-built server) behind a failed bind
      throw err
    }
    session.port = port
    session.url = `http://${host}:${port}/cast/${token}/index.m3u8`
    // PUBLISH LAST. this._cast used to be assigned before the bind, which made
    // castSession() briefly return { url: null, port: null } — a shape sdk/index.d.ts
    // declares impossible (url: string). Nothing can be served before this line anyway:
    // the socket is listening but the handler resolves every path against this._cast.
    this._cast = session
    return { url: session.url, host, port, token, streamId, source: 'p2p', feedKey, type, candidates: picked.candidates, receiverHost: receivers ?? undefined }
  }

  // The no-local-server cast: a redirect channel's operator-set URL, or a cdn-only host's
  // own cdnUrl(). Identical shape either way — the receiver dials a remote URL and this
  // device serves nothing, so there is no address, no port and no token to mint.
  async _castRemote (streamId, url, type, feedKey, headers) {
    await this._doStopCast()
    this._cast = {
      streamId, source: 'cdn', url, type,
      token: null, drive: null, feedCacheKey: null, host: null, port: null,
      feedKey, headers, candidates: undefined
    }
    return { url, host: undefined, port: undefined, token: undefined, streamId, source: 'cdn', feedKey, type, headers }
  }

  // A session that ended WITHOUT the host asking — the pinned feed was purged or closed
  // out from under it. Both callers have already dropped the drive handle synchronously
  // (so requests 404 instead of reading a purged drive); this is what actually ENDS the
  // session: closes the socket, clears the token, unpins, and tells the host.
  //
  // Before this existed, those paths nulled cast.drive and stopped: the listener stayed
  // bound for the life of the process, castSession() kept handing out a url and token that
  // answered 404 forever, and the host UI showed "Casting" with nothing behind it. The old
  // comment called that "a dead cast, which is the truth" — the host was never told.
  //
  // Fire-and-forget through the SAME _castOp chain as startCast/stopCast, so it cannot
  // interleave with a session the host is starting right now.
  _endCast (reason) {
    const dying = this._cast
    if (!dying) return
    const run = () => {
      // ⚠ Identity check, not a null check. This runs at the BACK of the _castOp queue, and
      // a startCast() already in flight can publish a brand-new session before we get
      // there — most easily through _openFeedWithin's own timeout eviction, which is a
      // caller of _endCast. Tearing down the session that REPLACED the dead one would turn
      // a self-heal into a bug that kills the cast the host just asked for.
      if (this._cast !== dying) return
      // …and it must still be the DEAD session. Every caller nulls cast.drive immediately
      // before calling this; a drive back on it means something RE-POINTED the session while
      // this waited its turn (a rotation follow, or a retune that landed just after the
      // guard gave up on it). That session recovered — ending it would be the same "kill the
      // cast the host is watching" bug the identity check above exists to prevent.
      if (dying.drive) return
      return this._doStopCast().then((ended) => {
        if (ended) this.emit('cast', { state: 'ended', streamId: dying.streamId, reason })
      })
    }
    const p = (this._castOp || Promise.resolve()).then(run, run)
    this._castOp = p.catch(() => {})
  }

  // nextPin: the feed cache key the CALLER is about to pin (startCast replacing a session).
  // Passing it keeps the incoming feed protected across the _trimFeeds() below, which the
  // outgoing session's unpinning is precisely what can trigger.
  async _doStopCast (nextPin = null) {
    const cast = this._cast
    // Clear the session state FIRST: resolveTarget reads this._cast synchronously, so a
    // request racing the teardown must see "no session" (404) rather than a drive whose
    // server is already closing.
    this._cast = null
    this._castFeedKey = nextPin
    const server = this._castServer; this._castServer = null
    const sockets = this._castSockets; this._castSockets = null
    // Hang up first, then close. A receiver holds keep-alive sockets open for the whole
    // programme, and close() alone waits for them: without this, stopCast() would park
    // until the TV happened to disconnect (bare-http1's close destroys only IDLE ones —
    // lib/server.js, `connection === null || connection.idle`).
    if (sockets) for (const s of sockets) { try { s.destroy() } catch {} }
    if (server) await this._closeCastServer(server, sockets)
    if (cast && cast.feedCacheKey) {
      // ONE reclaim pass over the feed this session pinned. Reclaim was OFF for the whole
      // session (CAST RECLAIM POLICY), so the replica has been accumulating ~1× bitrate of
      // blocks that are already unfetchable swarm-wide, and unpinning alone frees NOTHING:
      // the handler's reclaim only ever runs on a live playlist serve for that drive, so
      // without this the disk stays committed until the viewer happens to tune the channel
      // again. Fire-and-forget and never throws — stopCast() must not wait on disk I/O.
      //
      // NOT when the caller is re-pinning this very feed (startCast replacing a session on
      // the same channel, incl. a double-tapped Cast button): the receiver is not going
      // away, and freeing its below-window blocks is the one thing the whole policy exists
      // to prevent.
      if (cast.drive && cast.type !== 'vod' && nextPin !== cast.feedCacheKey) this._reclaimCastFeed(cast.drive)
      // The unpinned feed re-enters the normal LRU (and the loopback handler's reclaim).
      this._trimFeeds()
    }
    return !!cast
  }

  // Close the LAN listener, bounded. The bound is NOT cosmetic and the two runtimes do not
  // agree on what close() does — measured, not assumed:
  //
  //   node:http   Server.close() closes the listen handle SYNCHRONOUSLY and then waits for
  //               connections to drain before firing the callback. The port is free the
  //               moment close() returns.
  //   bare-http1  close() (lib/server.js) delegates to bare-tcp's Server.close(), which
  //               only sets CLOSING and calls _closeMaybe() — and _closeMaybe() invokes
  //               binding.close() on the LISTENER only when _connections.size === 0. So on
  //               Bare the port stays BOUND until the last connection drains, and the
  //               sweep above is what makes that happen (socket.destroy() is itself async,
  //               so the sockets are usually still counted when close() runs).
  //
  // Which means the old claim here — "the listener is already destroyed by close(), so the
  // bound only affects the callback" — is true on Node and FALSE on Bare, which is what
  // ships in the app. If a socket never settles, the timeout returns with the port still
  // bound. That is worth saying out loud rather than silently returning: a stopped cast
  // holding an off-loopback listener is exactly the surface this feature promised to close.
  // (bare-tcp also never clears its BOUND state bit, so `server.listening` stays true
  // there forever — it is only a usable signal on Node, which is where the lane asserts it.)
  async _closeCastServer (server, sockets) {
    let closed = false
    let timer = null
    let sweep = null
    await new Promise((resolve) => {
      const done = () => { if (timer) clearTimeout(timer); if (sweep) clearTimeout(sweep); resolve() }
      try {
        server.close(() => { closed = true; done() })
      } catch { done(); return }
      // Second sweep at the halfway mark: a connection accepted between the sweep in
      // _doStopCast and close() is not in `sockets`, and on Bare one such socket is enough
      // to hold the listener bound. bare-tcp exposes its live connections as a Set;
      // node:http's `connections` is a deprecated NUMBER, so only iterate a real iterable.
      sweep = setTimeout(() => {
        if (sockets) for (const s of sockets) { try { s.destroy() } catch {} }
        const live = server.connections
        if (live && typeof live[Symbol.iterator] === 'function') {
          for (const s of live) { try { s.destroy() } catch {} }
        }
      }, CAST_CLOSE_MS / 2)
      timer = setTimeout(done, CAST_CLOSE_MS)
    })
    // Only report when the port really may still be held. `listening` is honest on Node
    // (false after close() = the port is already free and only the drain callback is
    // outstanding, which is not worth recording) and permanently true on Bare, where a
    // close that did not settle DOES mean still bound — so the two runtimes land on the
    // right answer through the same expression.
    //
    // Into the BREADCRUMB RING, not 'error'. 'error' is the friendly host-UI channel — the
    // strings on it are written for a viewer to read and act on ("switch to it again to
    // retry") — and a viewer who just pressed Stop cannot do anything with a port-release
    // diagnostic, nor should they see one. It is real operator evidence, though (a lingering
    // off-loopback listener is the exact surface this feature promised to close), so it goes
    // where operator evidence goes: the ring that rides along on a problem report. Silence
    // was the one option ruled out; the earlier code chose the loudest instead.
    if (!closed && server.listening !== false) {
      this._recordEvent('cast-close', `port not released within ${CAST_CLOSE_MS}ms — a wedged connection may still hold the LAN listener`)
    }
    return closed
  }

  // One expired-block reclaim pass over a feed a cast session just released. Reads the
  // drive's CURRENT playlist for the window (the handler's reclaim gets the body from the
  // serve it rides; there is no serve here) and never throws — a stop must not fail
  // because a drive was closed or purged underneath it.
  _reclaimCastFeed (drive) {
    let timer = null
    // Bounded: the playlist blob is the ONE rolling blob in the drive, so a read of it can
    // commit to blocks no peer holds and never settle (the stalled-read shape the serve
    // core's idle abort exists for). A reclaim that never runs is fine; a promise that
    // never settles is not.
    const bounded = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CAST_RECLAIM_READ_MS) })
    Promise.race([Promise.resolve().then(() => drive.get('/index.m3u8')), bounded])
      .then(async (buf) => {
        if (timer) { clearTimeout(timer); timer = null }
        if (!buf) return
        const text = b4a.toString(buf)
        if (!text || /#EXT-X-ENDLIST/m.test(text)) return // VOD is never reclaimed
        await reclaimBelowWindow(drive, text)
      })
      .catch(() => { if (timer) { clearTimeout(timer); timer = null } })
  }

  // The LAN server. Created per session (stopCast closes it), so a new session always
  // means a new port AND a new token — a receiver holding the old URL cannot drift onto
  // the new one.
  //
  // BOUND TO ONE ADDRESS, not 0.0.0.0, whenever `host` is an IPv4 literal this device
  // actually owns — which is every auto-picked address, because _lanAddress() enumerates
  // them. A 0.0.0.0 bind meant the token was the ONLY thing between decrypted entitled
  // content and every interface the device has: the VPN tunnel, each container bridge, the
  // mobile-data interface, and the public internet on a host whose only non-internal IPv4
  // is routable. Narrowing the bind removes the whole class instead of trusting the token
  // to hold on surfaces the feature never meant to reach.
  //
  // The fallback stays 0.0.0.0 for an `advertiseHost` we cannot bind — a hostname, or a
  // NAT/forwarded address that belongs to a router rather than to us. That is the host
  // explicitly asking to be reachable at a name this device does not own, so a wide bind is
  // the only thing that can honour it, and it is a choice the caller made.
  //
  // ⚠ It is a choice ONLY on that path, which an earlier version of this comment got wrong by
  // claiming it for both. An AUTO-PICKED address (`mustOwn`) nobody chose: _lanAddress() runs
  // before the feed opens and _bindAddress re-enumerates after it, up to 2× tune.timeoutMs
  // later, so a Wi-Fi handoff, a VPN toggle or a DHCP change in that window means the device
  // no longer owns the address the URL is about to advertise — and widening to 0.0.0.0 there
  // would answer on every interface for an address that is already dead. Failing is both
  // safer and more useful (the URL would not have worked anyway), and the two cases are
  // already distinguishable: only the auto-pick reports `candidates`.
  async _startCastServer (handlerOpts, host, mustOwn = false) {
    const server = this._http.createServer(this._castRequestHandler(handlerOpts))
    server.on('error', () => {}) // a socket-level server error must never throw into the host
    const sockets = new Set()
    server.on('connection', (s) => {
      sockets.add(s)
      try { s.on('close', () => sockets.delete(s)) } catch {}
    })
    // Published BEFORE the listen: a rejected bind used to leave a fully constructed server
    // that nothing ever closed, because _castServer was only assigned on success and
    // _doStopCast had nothing to find. It is the one error path the teardown did not cover.
    this._castServer = server
    this._castSockets = sockets
    const bind = this._bindAddress(host, mustOwn)
    await new Promise((resolve, reject) => {
      let done = false
      server.once('error', (err) => { if (!done) { done = true; reject(err) } })
      server.listen(0, bind, () => { if (!done) { done = true; resolve() } })
    })
    return server.address().port
  }

  // What to bind() for an advertised host: the address itself when this device owns it,
  // 0.0.0.0 otherwise. Loopback literals count as owned (the lane casts to 127.0.0.1),
  // which is why this checks every address including the internal ones.
  //
  // mustOwn = the address was AUTO-PICKED, not supplied. Then "otherwise" is not a fallback,
  // it is a stale pick — refuse instead of widening (see _startCastServer).
  _bindAddress (host, mustOwn = false) {
    if (isIPv4Literal(host)) {
      let ifaces = null
      try { ifaces = this._os && this._os.networkInterfaces() } catch {}
      for (const list of Object.values(ifaces || {})) {
        for (const a of list || []) {
          if (a && a.address === host) return host
        }
      }
      if (host.startsWith('127.')) return host // always ours, even with no `os` to ask
    }
    if (mustOwn) {
      // Only reachable for an address _lanAddress() DID enumerate a moment ago, so this is
      // the network moving under the session, not a bad input.
      throw new Error(`this device no longer has the LAN address ${host} — the network changed while the feed opened (Wi-Fi handoff, VPN, a new lease). Start the cast again, or pass { advertiseHost }.`)
    }
    return '0.0.0.0' // a hostname, an IPv6 literal, or a NAT address — not ours to bind
  }

  // Cast request handler: a SECOND createDriveHandler instance whose resolveTarget serves
  // only /cast/<token>/… off the pinned drive. Everything else — /assets/*, /epg/*,
  // /feedthumb/*, a bare /index.m3u8, a stale token, a request after stopCast() — is null,
  // which the serving core answers 404.
  //
  // Synchronous BY CHOICE, like _thumbTarget. The serving core now AWAITS resolveTarget —
  // the loopback handler parks media requests on it while the active feed rotates (see
  // _mediaTarget) — so "synchronous by contract" is no longer true of the factory. It is
  // still true of this resolver and must stay true: every branch here is a refusal, and
  // there is nothing to wait for, because a cast session's pinned feed is never rotated
  // out from under the receiver — _rotateActiveFeed refuses a pinned feed twice, before and
  // after its drain, and if a session is published onto the drive inside the remaining
  // window it ends that session (_castLostDrive) rather than serving it a purged replica.
  //
  // ⚠ ALSO SEPARATE FROM THE LOOPBACK HANDLER'S READ ACCOUNTING. This is a second
  // createDriveHandler, so it owns a second InFlight: handler.inflight/whenDrained here are
  // NOT the ones the rotation drains. That is only safe while the refusals above hold, and
  // step 1 of _rotateActiveFeed says so at the drain itself.
  _castRequestHandler ({ readIdleMs, reclaim }) {
    return createDriveHandler((p, req) => {
      const cast = this._cast
      if (!cast || !cast.token || !cast.drive) return null
      // RECEIVER PIN (opt-in, unset by default — see startCast's receiverHost). A receiver
      // hands the whole media URL, token included, to any unauthenticated peer that asks it
      // over the Cast protocol (measured — see the note at the top of this file), so the
      // token cannot be the boundary on a shared network. When the host knows which device
      // it launched on, this makes the address part of the boundary too: an attacker then
      // needs the URL AND an L2 position that lets it answer as the TV.
      //
      // 404, never 403: a refusal must not confirm that the path exists. It returns null
      // like every other refusal here, so a wrong address and a wrong token are the same
      // response byte for byte.
      if (cast.receivers && !cast.receivers.includes(normalizePeer(req && req.socket && req.socket.remoteAddress))) return null
      if (!p.startsWith(CAST_PREFIX)) return null
      const slash = p.indexOf('/', CAST_PREFIX.length)
      const token = slash < 0 ? p.slice(CAST_PREFIX.length) : p.slice(CAST_PREFIX.length, slash)
      if (!constantTimeEqual(token, cast.token)) return null
      let rest = slash < 0 ? '' : p.slice(slash)
      // The serving core only rewrites a bare '/' — under a token prefix the equivalent
      // is /cast/<token> and /cast/<token>/, so do it here.
      if (rest === '' || rest === '/') rest = '/index.m3u8'
      return { drive: cast.drive, path: rest, media: true }
    }, {
      // The receiver is cross-origin by construction (the Default Media Receiver page is
      // served from https://www.gstatic.com), so without these it fetches the playlist and
      // then NO segments at all. Measured — see the CORS note in sdk/serve.js.
      cors: true,
      // The phone is not playing this feed locally while it casts, so these playlist
      // serves are the ONLY thing pulling its segments: keep the whole-window read-ahead
      // (churn headroom) and let a metered network narrow it, exactly as on loopback.
      liveReadAhead: () => (this._netExpensive ? 3 : Infinity),
      readIdleMs,
      // Default OFF — see the CAST RECLAIM POLICY note at the top of this file.
      ...(reclaim ? { reclaim: true } : {}),
      onError: (err) => { if (isCorruptionError(err)) this._purge().catch(() => {}) }
    })
  }

  // This device's LAN IPv4, as a receiver on the same network must address it. Returns
  // { address, candidates } — `candidates` is every private address that qualified, in
  // pick order, and `address` is candidates[0].
  //
  // Two filters, and it is worth being exact about what each one buys, because an earlier
  // version of this comment described a filter the code did not have:
  //
  //   169.254.0.0/16 is SKIPPED. An APIPA address means DHCP never answered, so nothing
  //   can route to it; advertising one produces a cast that simply never connects.
  //
  //   RFC1918 is REQUIRED, not preferred. The old code ended `find(isPrivateIPv4) ||
  //   found[0]`, so on a host whose only non-internal IPv4 is public — a desktop on a VPS,
  //   a flat network, a routable carrier v4 — startCast() advertised, and bound, an
  //   internet-reachable server for decrypted entitled content. Refusing is the only
  //   defensible default; `advertiseHost` is the deliberate override and the error says so.
  //
  // ⚠ WHAT THIS CANNOT TELL APART, said plainly because the old comment claimed otherwise.
  // It named "a container bridge" as the thing the private-address filter protects against
  // — but a container bridge is private, so the filter is a no-op against its own example.
  // Hyper-V (172.25.x), WSL2, Docker (172.17.x) and carrier CGNAT on rmnet_data* (10.x) are
  // ALL RFC1918 and all indistinguishable from Wi-Fi here: os.networkInterfaces() carries
  // no route metric, no gateway and no link state. On this repo's own build box, `Wi-Fi
  // 192.168.1.104` and `vEthernet (Default Switch) 172.25.64.1` both qualify, and the pick
  // is decided purely by enumeration order. A phone that is casting is on Wi-Fi AND usually
  // has mobile data up, so this is the common case, not an edge one.
  //
  // So the pick is a guess and is documented as one. What the SDK can do honestly is hand
  // the host every candidate (returned here, and on the resolved session as `candidates`)
  // so a UI can offer "try another address" instead of leaving the viewer with a Cast
  // button that produces a receiver which never connects.
  _lanAddress () {
    if (!this._os) throw new Error('cast needs an injected `os` module (createPlayer wires it) — or pass { advertiseHost }')
    let ifaces = null
    try { ifaces = this._os.networkInterfaces() } catch {}
    const found = []
    for (const list of Object.values(ifaces || {})) {
      for (const a of list || []) {
        // family is 'IPv4' on node:os and bare-os; the numeric 4 covers older node:os.
        if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue
        if (typeof a.address !== 'string' || !a.address || a.address.startsWith('169.254.')) continue
        found.push(a.address)
      }
    }
    if (!found.length) throw new Error('no usable LAN IPv4 address on this device — connect to Wi-Fi, or pass { advertiseHost }')
    const candidates = found.filter(isPrivateIPv4)
    if (!candidates.length) {
      throw new Error('no private (RFC1918) IPv4 address on this device — the only candidate' +
        (found.length > 1 ? 's are ' : ' is ') + found.join(', ') +
        ', and casting there would publish entitled content beyond the LAN. Pass { advertiseHost } to override.')
    }
    return { address: candidates[0], candidates }
  }

  // Follow a feed swap that happens UNDER a cast session. Two paths already own such a
  // swap and both are about the ACTIVE stream: the tune watchdog's retune, which CLOSES
  // the drive before re-opening the same feedKey (a pinned cast would then be reading a
  // closed drive — 500s, not a stall), and the catalog's rotation follow, where a
  // broadcaster restart moves the channel to a new feedKey and the old one goes dead.
  // A cast is pinned to a CHANNEL, so following either is the correct meaning of the pin;
  // only the phone's ZAPPING must not move it.
  //
  // LIMIT: a cast pinned to a channel the phone has zapped AWAY from is not tracked by
  // either caller, so it does not follow a feedKey rotation — the receiver stalls and the
  // host restarts the session. Following that would need the cast to carry its own
  // catalog watcher.
  _recastFeed (streamId, cacheKey, drive) {
    const c = this._cast
    if (!c || c.source !== 'p2p' || c.streamId !== streamId || !drive) return
    c.drive = drive
    c.feedCacheKey = cacheKey
    c.feedKey = cacheKey.split(':')[0]
    this._castFeedKey = cacheKey
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
    // A zap that lands while the previous channel is mid-ROTATION ends the park right
    // here: the drive the parked requests were waiting for has arrived (a different one,
    // but they re-read _feedDrive — see _mediaTarget), and spending the rest of the park
    // budget on the channel the viewer just LEFT would put the rotation's cost on the zap.
    // The rotation itself carries on and purges its old drive; that drive is not this one.
    if (this._feedSwap) this._releaseFeedSwap(this._feedSwap)
    // A replica this session already purged (an LRU trim, the store byte cap, the tune
    // ladder's last rung, a wedged open) cannot replicate over the connection it was purged
    // on — and `feed` may well be a CACHED one that a prefetch re-opened dead minutes ago,
    // so this belongs here, at the serve, rather than on the open. See _healPurgedFeed.
    this._healPurgedFeed(feedKeyHex)
    this._trimFeeds()
    this._startFeedMaintenance() // idle reclaim + store byte cap, armed on first play (see there)
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
          // The teardown guard that used to be duplicated here now lives INSIDE
          // _ensureStore(), in front of its own early return — one enforcement point for the
          // one function that builds a Corestore and a Hyperswarm, rather than a check each
          // caller has to remember. It throws a plain Error, which withRecovery does not treat
          // as corruption, so it propagates here exactly as this line did.
          await this._ensureStore()
          const d = new Hyperdrive(this._store.namespace('replica:' + feedKeyHex), b4a.from(feedKeyHex, 'hex'), { encryptionKey: b4a.from(encKeyHex, 'hex') })
          await d.ready()
          return d
        })
        // …and again once the drive is ready: ready() is where a teardown lands most often,
        // and joining a topic on a swarm that stop() destroyed (or that the rebuild just
        // created, with a drive from the store it replaced) is the leak the epoch exists for.
        if (this._storeDown || !this._swarm) {
          try { const p = drive.close(); if (p && p.catch) p.catch(() => {}) } catch {}
          throw new Error('the store was torn down while this feed opened')
        }
        this._trackReplica(feedKeyHex) // hint file for the stale-namespace sweep (see _sweepStaleReplicas)
        // pull always; announce (re-seed to other viewers) only under 'reseed' policy
        const discovery = this._swarm.join(drive.discoveryKey, { server: this._uploadPolicy !== 'client-only', client: true })
        return { drive, discovery }
      })()
      this._feeds.set(cacheKey, feed)
      // The settled value, hung on the promise itself: /feedthumb resolves SYNCHRONOUSLY
      // (createDriveHandler CAN await a resolveTarget now — the media branch parks on one
      // during a rotation — but _thumbTarget deliberately does not use that: a thumbnail
      // must never park a request behind a DHT lookup), so it needs to tell an open drive
      // from an open still in flight without awaiting. Kept here rather than in a parallel
      // map because it then dies with the cache entry — one fewer thing every eviction
      // path must remember to clear. It is also what makes an ACTIVE ROTATION read as
      // "cold" to every synchronous reader: _rotateActiveFeed parks a bare promise in this
      // cache while the drive is purged, and a promise with no `settled` is exactly the
      // "an open is in flight, serve nothing yet" case this field already described.
      feed.then((f) => { feed.settled = f }, () => {})
      feed.catch(() => { if (this._feeds.get(cacheKey) === feed) this._feeds.delete(cacheKey) }) // drop a failed open so a retry re-opens
    }
    return feed
  }

  // _openFeed bounded by a timeout: null on expiry, after evicting the cached promise
  // so the NEXT attempt re-opens fresh instead of awaiting the same wedged open.
  //
  // …unless the slot is CLAIMED, in which case _evictFeed refuses and the next attempt ADOPTS
  // the same open with a fresh bound. That is the better outcome, not a degraded one: the
  // claimant is going to serve what this open settles to, and building a second Hyperdrive
  // over the namespace it is opening is the deadlock the single-flight cache exists to
  // prevent. It is also why this expiry is safe to leave pointed at a rotation's re-open —
  // its timeout semantics are cache MAINTENANCE, and maintenance does not get to act on a
  // slot somebody else is holding.
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
  //
  // COUNT ONLY — the byte bound is _trimFeedBytes, deliberately a separate, independent
  // trigger. Twelve feeds is a statement about swarm topics and open sessions, which is
  // what this bound was built for and what it is still right about; it says nothing at
  // all about disk (see the VIEWER DISK BUDGET note), and conflating the two would mean
  // a byte-driven purge had to argue with a topic-driven one.
  _trimFeeds () {
    if (this._feeds.size <= this._feedLimit) return
    for (const key of [...this._feeds.keys()]) {
      if (this._feeds.size <= this._feedLimit) break
      if (key === this._activeFeedKey) continue // never drop the feed we are serving
      // …nor the feed a cast session pinned. Eviction PURGES the replica's storage, so
      // browsing far enough while a TV plays would delete the drive out from under the
      // receiver — and the phone's own zapping is exactly what fills the cache.
      if (key === this._castFeedKey) continue
      this._evictFeed(key)
    }
  }

  // --- cache-slot ownership ---
  //
  // A CLAIM is one fact hung on the cache slot ITSELF: somebody has this open in flight and is
  // going to use what it settles to, so no other path may take it out of the cache. Two places
  // enforce it — _evictFeed and _retuneActive, the only two that delete a slot they did not
  // create — and neither of them has to know who the claimant is or what it is doing.
  //
  // IT REPLACES A ROTATION-SCOPED TOKEN, and the change is one of SHAPE rather than a better
  // guard. `_feedRotate.slot` had the rotation's lifetime: the instant _rotateActiveFeed's
  // finally ran, an open it had put in the cache and was still going to serve became naked,
  // and every path that had to honour the token had to know a rotation existed. A claim lives
  // exactly as long as the thing it protects, which is the property that was missing.
  //
  // TWO RELEASE MODES, because the two slots a rotation claims have different lifetimes:
  //   - explicit only, for an ALREADY-SETTLED entry (the live feed, held across the drain and
  //     the measure — a settle-driven release would fire on the next microtask and protect
  //     nothing);
  //   - on settle, for an open still IN FLIGHT — which is what lets the claim outlive the
  //     function that took it, capped by FEED_CLAIM_MS so a wedged open cannot poison the slot
  //     forever. The cap's timer is unref'd: nothing awaits it, so it is housekeeping in
  //     sdk/serve.js's sense (contrast bounded() there, whose timer is the only thing that can
  //     settle the promise its caller is awaiting).
  //
  // Refcounted rather than a boolean so that two claims on one slot cannot release each
  // other's; the returned release is idempotent and safe to call from a finally.
  _claimSlot (promise, untilSettled = false) {
    if (!promise) return () => {}
    let timer = null
    let released = false
    promise.claims = (promise.claims || 0) + 1
    const release = () => {
      if (released) return
      released = true
      promise.claims--
      if (timer) { clearTimeout(timer); timer = null }
    }
    if (untilSettled) {
      timer = setTimeout(release, FEED_CLAIM_MS)
      timer.unref?.()
      promise.then(release, release)
    }
    return release
  }

  _evictFeed (cacheKey) {
    const feed = this._feeds.get(cacheKey)
    if (!feed) return
    // ⚠ A CLAIMED SLOT IS NOT THIS FUNCTION'S TO TAKE — see _claimSlot. Somebody has an open
    // in flight under this key and will serve what it settles to; deleting the entry orphans
    // that drive and the purge below unlinks it, which is a served-drive-less play plus a
    // deleted replica. Reachable from every blind caller: the tune watchdog's last rung,
    // _openFeedWithin's timeout, _trimFeeds once a zap has moved _activeFeedKey off the
    // rotating channel, and the two callers that grab a rotation's placeholder and react to
    // the null it settles to (_doStartCast, serveFeed). Refusing is not a lost eviction — the
    // claimant releases when its open settles, and whatever sent us here comes round again.
    if (feed.claims) return
    this._feeds.delete(cacheKey)
    // ⚠ PURGE ONLY WHAT WE HAVE ALREADY SEEN SETTLE, and that is the invariant rather than a
    // precaution. purge() deletes storage BY PATH and a namespace's path is deterministic
    // (corestore 'replica:<feedKey>'), so arming one on an open that is STILL IN FLIGHT means
    // the unlink lands at an unknown later time — possibly after some other caller has opened
    // a SECOND drive over the same namespace and is serving it, at which point the viewer is
    // watching a drive whose files have been deleted underneath it. That is the exact failure
    // this file has now been round twice. A pending open is therefore CLOSED, never purged:
    // close drops handles and is harmless to a successor, and the bytes forgone are those of a
    // replica that never finished opening — near zero, since a feed only grows once it is
    // being served.
    const settled = !!feed.settled
    Promise.resolve(feed).then((f) => {
      if (!f || !f.drive) return
      if (this._feedDrive === f.drive) { this._feedDrive = null; this._feedDiscovery = null }
      // Eviction PURGES the storage. _trimFeeds already refuses to evict a cast-pinned
      // feed, but the other callers do not know about the pin — the tune ladder's last
      // rung purges the replica of the channel it gave up on (see _startTuneWatchdog), and
      // that fires while the phone is ON the cast channel, so it is NOT the documented
      // "zapped away" limit. Drop the handle synchronously so requests 404 instead of
      // reading a purged drive…
      if (this._cast && this._cast.drive === f.drive) {
        this._cast.drive = null
        this._castFeedKey = null
        // …and then actually END the session. Nulling the drive alone left the listener
        // bound for the life of the process, castSession() handing out a url and token
        // that answered 404 forever, and the host UI showing "Casting" with nothing behind
        // it. The old comment claimed "the host sees a dead cast, which is the truth" —
        // the host saw nothing at all.
        this._endCast('feed-evicted')
      }
      // Eviction (cache overflow / rotation-away / wedged open) purges the replica's
      // STORAGE, not just the handles: drive.purge() (hyperdrive 11) closes the
      // drive and deletes both cores (db + blobs) from disk, so an evicted feed
      // costs zero bytes instead of a stranded namespace forever. stop() and
      // _closeFeeds deliberately do NOT purge — a normal app restart must keep its
      // warm caches; only eviction pays the cold-restart cost. Never throws: a
      // refused purge falls back to the old plain close.
      if (!settled) { try { f.drive.close().catch(() => {}) } catch {} return } // see above
      //
      // ⚠ NOTE THE CONNECTIONS FIRST — this is the last instant they are readable. A purged
      // core never replicates again over the connection it was purged on, and this drive's
      // peers are the only record of which connections those are; purge() closes before it
      // unlinks, and that close empties the list (see _feedPeerKeys). Destroying them HERE
      // would be wrong — eviction fires on ordinary zapping, one socket carries every
      // channel of a peer, and an unconditional hang-up per eviction would interrupt every
      // other cached feed for a channel the viewer may never come back to. So the hang-up
      // is deferred to the serve that actually needs it: _healPurgedFeed.
      this._recordPurgedFeed(cacheKey.slice(0, cacheKey.indexOf(':')), f.drive)
      f.drive.purge().catch(() => { try { f.drive.close().catch(() => {}) } catch {} })
    }).catch(() => {})
  }

  // --- feed-cache maintenance: idle reclaim sweep + store byte cap ---

  // One periodic tick for everything that bounds DISK rather than topics. Armed on the
  // first serveFeed() (the _statusTimer pattern) rather than on the first _openFeed():
  // playback is what fills a replica, and a session that only ever prewarmed connections
  // has nothing to sweep. Cleared by stop() and by a corruption purge, re-armed by the
  // next play. Idempotent — every caller may just call it.
  //
  // unref'd: this is housekeeping, and housekeeping must never be the reason a Node host
  // (or a test) fails to exit. The 3 s peers ticker is not unref'd because a host that
  // stops consuming 'peers' has stopped playing anyway; this one outlives playback.
  // ⚠ THE BUSY GUARD IS ITSELF BOUNDED, and that is not defensive tidiness. A single await
  // in this pass that never settles used to switch BOTH disk bounds off for the rest of the
  // session, silently: `busy` stayed true, every later tick returned at the first line, and
  // nothing anywhere reported it. The wedge is real and cheap to reach — _measureFeed ->
  // measureDriveBytes -> drive.getBlobs() does not settle on a replica whose blobs header
  // never replicated (an off-air but entitled channel that a /feedthumb grid request
  // opened; any prewarmed feed with no peer). The awaits are bounded individually now
  // (FEED_MEASURE_MS here, the read bound inside reclaimIdleFeed, and sdk/serve.js's own
  // probe bound), but "the tick can never wedge permanently" must not depend on having
  // enumerated every await correctly — so the guard also expires on its own.
  _startFeedMaintenance () {
    if (this._feedMaintTimer) return
    let busy = false
    this._feedMaintTimer = setInterval(() => {
      if (busy) return // a sweep over 12 replicas can outlast the interval on a slow disk
      busy = true
      let released = false
      const release = () => { if (!released) { released = true; busy = false } }
      // Whichever comes first: the pass finishing, or the backstop. A pass that outlives the
      // backstop keeps running (there is nothing safe to cancel mid-purge) — it just stops
      // owning the guard, so the NEXT tick may run. That risks two overlapping passes, which
      // is survivable: every operation in them is idempotent, _evictFeed is a no-op on a key
      // already gone, and the alternative is both bounds dead until the app restarts.
      const stuck = setTimeout(release, FEED_SWEEP_STUCK_MS)
      stuck.unref?.() // housekeeping must never hold a host process open
      ;(async () => {
        await this._sweepIdleFeeds() // frees bytes where the platform can hole-punch…
        await this._trimFeedBytes() // …and unlinks whole replicas where it cannot
      })()
        .catch(() => { /* housekeeping is best-effort by construction */ })
        .then(() => { clearTimeout(stuck); release() })
    }, FEED_SWEEP_MS)
    this._feedMaintTimer.unref?.()
  }

  _stopFeedMaintenance () {
    if (this._feedMaintTimer) { clearInterval(this._feedMaintTimer); this._feedMaintTimer = null }
  }

  // IDLE-FEED RECLAIM. Reclaim has only ever reached the feed being SERVED: it hangs off a
  // live playlist serve for a `media: true` target, and _feedDrive is the only drive this
  // engine ever marks media:true. Everything else in the cache — the prewarm lineup, every
  // channel zapped through, every feed a /feedthumb opened — has therefore never had a
  // single block freed in the life of a session, even on a platform that hole-punches
  // perfectly. That is the main 64-bit win and it costs one metadata pass per feed.
  //
  // reclaimIdleFeed reads the drive's OWN /index.m3u8 to find the window (there is no
  // serve to hand it one) and skips VOD, which has no rolling window to be below. It never
  // throws, and its read is bounded — a superseded playlist blob no peer holds would
  // otherwise wedge this whole sweep, not just its own pass.
  //
  // WHAT IT COSTS, stated plainly because standing bandwidth is why zapPrefetch is off by
  // default: that read may fetch a few KB of playlist per idle feed per tick — ~30 KB/min
  // for a full cache, ~2 MB/hour. Sequential, not parallel: this runs off every critical
  // path and 12 concurrent metadata reads in the Bare worklet buy nothing. Mostly it is
  // idempotent no-op work — an idle replica is not growing, so the pass that follows the
  // one that freed its blocks finds nothing left to free.
  //
  // NEVER THE SERVED FEED, and the skip is written three ways on purpose: the two cache
  // keys (which is what _trimFeeds skips on) plus drive IDENTITY, because a rotation
  // replaces the drive behind a key and a cast can be pinned to a drive whose key moved
  // (see _recastFeed). Reclaiming the drive a receiver is reading is the one thing in this
  // file that turns a recoverable lag into a permanent stall — see CAST RECLAIM POLICY.
  async _sweepIdleFeeds () {
    for (const [key, feed] of [...this._feeds]) {
      if (key === this._activeFeedKey || key === this._castFeedKey) continue
      const f = feed.settled // an open still in flight has no drive to sweep; it will be here next tick
      if (!f || !f.drive) continue
      if (f.drive === this._feedDrive) continue
      if (this._cast && this._cast.drive === f.drive) continue
      await reclaimIdleFeed(f.drive)
    }
  }

  // STORE BYTE CAP — the second, independent bound on the feed cache (_trimFeeds is the
  // first and stays: this one never lets the cache grow past the count). Purge inactive
  // feeds oldest-first until the measured store is back under _storeBudgetBytes.
  //
  // Measured, not estimated: measureDriveBytes answers what a replica actually costs on
  // disk, which is the only number that means anything on a platform where clear() frees
  // nothing (the whole reason this exists). It returns null where no honest number is
  // available, and nothing may ever be purged on a guess.
  //
  // ⚠ AN UNMEASURABLE FEED SKIPS THAT FEED, NOT THE PASS. This used to read `if (!m) return`,
  // which sounds like the same caution and is not: measureDriveBytes merges "this PLATFORM
  // cannot report sizes" with "this ONE replica did not answer", and the second is neither
  // rare nor exotic — sdk/serve.js bounds its own probe precisely because drive.getBlobs()
  // NEVER SETTLES on a replica whose blobs header did not replicate (an off-air but entitled
  // channel a /feedthumb grid request opened; any prewarmed feed with no peer), and it
  // deliberately reports that as transient rather than latching its budget off. Abandoning
  // the whole pass on it did the equivalent one level up: one such feed in the cache killed
  // the store cap on every 60 s tick, for the rest of the session, silently.
  //
  // Skipping is also what keeps "never purge on a guess" true, with no second mechanism
  // needed: a skipped feed contributes to neither `held` nor `cached` and is not in
  // `evictable`, so it can never be evicted and never pushes another feed over the line. On a
  // genuinely unmeasurable PLATFORM every feed skips, `cached` stays 0, and the pass returns
  // having done nothing — exactly the old bail-out, arrived at by arithmetic instead of by a
  // special case. What is lost is only the skipped feed's bytes going uncounted, which is why
  // a feed that keeps skipping leaves a breadcrumb (see _measureSkips).
  //
  // WHAT IS PROTECTED, and it is written FOUR ways, matching _sweepIdleFeeds rather than
  // _trimFeeds. Guarding by cache key alone was wrong here, and the root cause was not in
  // this function: _maybeReresolveActiveFeed moves _feedDrive and a.feedKey when a
  // broadcaster restarts a channel onto a new feedKey, but _activeFeedKey is assigned in
  // exactly one place (serveFeed), so after any catalog rotation the key guard named a DEAD
  // feed and the drive actually being watched was unprotected — this pass would hand it to
  // _evictFeed, which purges. (_maybeReresolveActiveFeed keeps the key in sync now; the
  // drive-identity checks are the belt to that braces, and they also cover a cast pinned to
  // a drive whose key moved — see _recastFeed.)
  //
  //   - VOD is EXEMPT, like every other disk path in this engine (the Reclaim class in
  //     serve.js, reclaimIdleFeed, the rotation). A title's replica is a legitimate SEEK
  //     CACHE that grows to the full title — 2 h at 2 Mbit/s ≈ 1.7 GiB — so without the
  //     exemption watching one film puts the store over the 2 GiB cap and this pass purges
  //     every other cached feed, every 60 s, for the rest of the film.
  //
  // THE ACCOUNTING, which was the second defect and the worse one. `total` summed EVERY
  // settled feed, protected ones included, while the eviction loop skipped past those
  // without subtracting them — so once the protected set alone exceeded the cap the exit
  // condition became unreachable and the loop purged the entire warm cache on every tick,
  // forever, while the feed actually over budget was never touched. The cap is therefore
  // applied to what this pass can actually EVICT, against what is left of the budget after
  // the protected feeds have taken their share.
  async _trimFeedBytes () {
    if (!this._feeds.size) return
    const vod = this._vodCacheKeys()
    const evictable = []
    const skips = new Map() // this pass's unmeasurable feeds; replaces _measureSkips at the end
    let held = 0 // bytes in feeds this pass may not touch
    let cached = 0 // bytes it may
    for (const [key, feed] of [...this._feeds]) {
      const f = feed.settled
      if (!f || !f.drive) continue
      const m = await this._measureFeed(f.drive)
      if (!m) { skips.set(key, (this._measureSkips.get(key) || 0) + 1); continue } // see above
      const pinned = key === this._activeFeedKey || key === this._castFeedKey ||
        f.drive === this._feedDrive || (this._cast && this._cast.drive === f.drive) ||
        vod.has(key)
      if (pinned) { held += m.bytes; continue }
      cached += m.bytes
      evictable.push({ key, bytes: m.bytes })
    }
    // A feed that answers again, or leaves the cache, drops out of the ledger by construction
    // — this map is built fresh every pass and only carries forward what skipped again.
    this._measureSkips = skips
    // …and say so once, for the same reason the store-cap breadcrumb below exists: a replica
    // that is invisible to the cap is holding disk nothing in this engine can account for, and
    // "why is this device full when the cap says otherwise" has to be answerable. Three passes
    // (~3 minutes) rather than one, because a single miss is ordinary — a drive closing under
    // the measurement, a momentarily busy core.
    if (!this._measureSkipWarned) {
      for (const [key, n] of skips) {
        if (n < 3) continue
        this._measureSkipWarned = true
        this._recordEvent('store-cap', `feed ${key.slice(0, 8)} has not been measurable for ${n} passes — its bytes are not counted against the ${Math.round(this._storeBudgetBytes / 1048576)} MiB store cap and the cap cannot evict it`)
        break
      }
    }
    // What the warm cache may hold: the cap minus what the protected feeds are already
    // holding — but never less than one feed's budget. That floor is the anti-livelock, and
    // it is a deliberate trade rather than an oversight: the protected set has members with
    // no bound of their own (a cast-pinned replica; a VOD title; the active feed when
    // rotation is switched off), and when one of those alone exceeds the cap, purging the
    // cache frees bytes that the next tick immediately re-purges without ever bringing the
    // store under. Overshooting the cap by one feed's budget is the lesser harm against
    // deleting every warm replica a viewer has, once a minute, to no effect.
    const floor = this._feedBudgetBytes || FEED_ROTATE_BUDGET_BYTES
    const budget = Math.max(this._storeBudgetBytes - held, floor)
    // …and say so ONCE, because "the cap is not being enforced" is exactly the kind of thing
    // that must not be silent when an operator is asking why a device filled up. Once per
    // engine: this runs every 60 s and would otherwise flush the breadcrumb ring.
    //
    // ⚠ THE TRIGGER IS THE FLOOR ENGAGING, NOT `held >= cap`, and the difference was a blind
    // band, not a rounding detail. The floor takes over the moment `cap - held < floor` — at
    // the defaults, held > 1.5 GiB — while this breadcrumb used to wait for held >= 2 GiB. In
    // between, the warm cache was already being trimmed to one feed's budget and nothing said
    // so: precisely the "why did my cache vanish" question this line exists to answer.
    if (this._storeBudgetBytes - held < floor && !this._storeHeldWarned) {
      this._storeHeldWarned = true
      this._recordEvent('store-cap', `${Math.round(held / 1048576)} MiB is held by feeds this pass cannot evict (active / cast-pinned / VOD) against a ${Math.round(this._storeBudgetBytes / 1048576)} MiB cap — the warm cache is being trimmed to ${Math.round(floor / 1048576)} MiB, and the store cannot be brought under the cap until that feed is released`)
    }
    if (cached <= budget) return
    for (const e of evictable) { // insertion order = oldest first, same as _trimFeeds
      if (cached <= budget) break
      this._evictFeed(e.key) // purges the replica's storage — that is the point here
      // _evictFeed is fire-and-forget (the purge rides the settled open), so this is the
      // POST-eviction figure, not a confirmed one. The next tick re-measures; over-purging
      // on a stale number costs a re-zap, under-purging costs one more tick.
      cached -= e.bytes
    }
  }

  // The feed cache keys that belong to VOD titles, as a Set. Built per pass rather than
  // kept as state: _entitled is the login snapshot and _feedKeyLive is the catalog view, so
  // BOTH spellings of a title's key can be in the cache at once (a re-ingest moves the
  // feedKey while the old replica is still open), and a Set built now cannot go stale.
  _vodCacheKeys () {
    const keys = new Set()
    for (const [streamId, k] of this._entitled) {
      if (!k || k.type !== 'vod' || !k.encryptionKey) continue
      if (k.feedKey) keys.add(k.feedKey + ':' + k.encryptionKey)
      const live = this._feedKeyLive.get(streamId)
      if (live) keys.add(live + ':' + k.encryptionKey)
    }
    return keys
  }

  // measureDriveBytes, tolerantly: null for "no honest number available" — an unmeasurable
  // platform, a drive closing under the measurement, anything at all. Every caller treats
  // null as "do not act", so a failure to measure can never cause a purge.
  //
  // BOUNDED (FEED_MEASURE_MS): the measurement reaches drive.getBlobs(), which never
  // settles on a replica whose blobs header never replicated — see the constant. Both
  // callers are on paths where a permanently pending await is far worse than a missing
  // number: the maintenance tick (which would lose both disk bounds for the session) and
  // step 2 of a rotation (which would hold the mutex and the park indefinitely).
  //
  // BOUNDING THIS IS ONLY HALF THE FIX, and the other half is at the call site, not here:
  // _trimFeedBytes must skip the one feed rather than abandon the pass, or the wedge simply
  // moves from "this await never returns" to "this pass never gets past feed #3". See there.
  //
  // The loser of the race needs no handler of its own: Promise.race attaches its own
  // resolve/reject to EVERY element, so a measurement that rejects after the timer won is
  // already handled and cannot reach the worklet's unhandledRejection (which does SIGABRT —
  // that rule is real, it just does not bite here). Verified rather than assumed.
  //
  // ⚠ AND THE TIMER IS NOT unref'd, for sdk/serve.js's bounded() reason: when the wrapped
  // measurement never settles — the case this bound exists for — this timer is the ONLY thing
  // that can settle the promise the caller is awaiting, and an unref'd one on a host whose
  // loop is otherwise empty simply never fires (Node reports an unsettled top-level await and
  // exits). Immaterial inside the app, which always has a socket or an interval keeping the
  // loop alive; it can hang a tool host mid-rotation, which is where this is actually run.
  async _measureFeed (drive) {
    let timer = null
    try {
      const bounded = new Promise((resolve) => { timer = setTimeout(() => resolve(null), FEED_MEASURE_MS) })
      return (await Promise.race([measureDriveBytes(drive), bounded])) || null
    } catch { return null } finally { if (timer) clearTimeout(timer) }
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
    // Macrotask yield, every SWEEP_YIELD_EVERY iterations of the two long loops below:
    // on a large catalog they are thousands of awaited bee reads that mostly resolve
    // from cache, i.e. pure microtask churn that starves the IPC 'data' handler (see the
    // constant). Yielding changes no semantics — the keep-set is still built in full
    // before any purge, and a thrown error still aborts purging nothing.
    let iter = 0
    const breathe = async () => {
      if (++iter % SWEEP_YIELD_EVERY !== 0) return
      await new Promise((resolve) => { const t = setTimeout(resolve, 20); if (typeof t.unref === 'function') t.unref() })
    }
    const keep = new Set()
    try {
      // Every feedKey any replicated catalog record names (entitled or not).
      for await (const node of this._panelBee.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
        if (node && node.value && node.value.feedKey) keep.add(node.value.feedKey)
        await breathe()
      }
      // Login-snapshot keys plus the live catalog view of each entitled stream.
      for (const [id, k] of this._entitled) {
        if (k && k.feedKey) keep.add(k.feedKey)
        const cur = await this._currentFeedKey(id, k && k.feedKey)
        if (cur) keep.add(cur)
        await breathe()
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
    // FIRST, before anything is torn down: _username gates _doPushCatalog, and a push
    // that slipped through mid-teardown would call _ensureServer() and leave a NEW
    // listening server behind after stop() had already closed the old one.
    this._username = null
    // Same reasoning, one level deeper. Long-running work that captured the epoch (the feed
    // rotation and its recovery) re-checks it after every await and abandons everything it
    // was going to do — because "the viewer zapped" and "the engine is gone" are different
    // questions, and only the second one makes _ensureStore() build a fresh Corestore and
    // Hyperswarm and join a topic after this function has returned.
    this._epoch++
    this._storeDown = true // …and the preventive half: no new store, no new swarm join (see _openFeed)
    // The rotation MUTEX, which the epoch does not cover. A rotation normally clears it in
    // its own finally, but that finally sits behind the one await the design leaves
    // deliberately unbounded — drive.purge() — and a store torn down underneath a purge is
    // plausibly exactly what leaves it pending forever. The mutex would then stay set for the
    // life of the process, i.e. rotation permanently OFF, which on a 32-bit build removes the
    // only remaining bound on disk growth. Identity-checked when the rotation does resume, so
    // clearing it here cannot clobber a newer one.
    this._feedRotate = null
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
    this._stopFeedMaintenance()
    // Release any parked media requests before the server closes under them. They resolve
    // to null (no _feedDrive) and 404, which is the honest answer for a stopped engine —
    // leaving the gate armed would hold each one until its own timer, on a socket that is
    // already going away.
    if (this._feedSwap) this._releaseFeedSwap(this._feedSwap)
    await this.stopCast() // the LAN socket must not outlive the engine that fed it
    const server = this._server; this._server = null
    if (server) { try { await new Promise((resolve) => server.close(resolve)) } catch {} }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} }
    const grantWatcher = this._grantWatcher; this._grantWatcher = null
    if (grantWatcher) { try { await grantWatcher.close() } catch {} }
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
    // (_username was already nulled at the top of stop() — it dies with the session for
    // the same reason the token does: a service switch reuses the engine, and a stale
    // name would re-arm the grant watch on another operator's bee, where 'user/<name>'
    // is a DIFFERENT person's record.)
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
    // The purged-replica ledger dies with the cache it belongs to. Both callers (stop and
    // the corruption purge) destroy the swarm right after, so every socket it names is
    // about to be gone anyway — and holding them would pin dead connections for nothing.
    this._purgedFeeds.clear()
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
  //
  // SPLIT IN TWO, because the rotation needs the halves at different instants (see
  // _rotateActiveFeed step 4a): the peers can only be READ off a drive that is still open, and
  // they must not be HUNG UP ON until the replica's storage is gone. The ladder's own use is
  // unchanged — both halves back to back, on the active drive, with no re-dial.
  _teardownFeedPeers (drive = this._feedDrive, redial = false) {
    return this._hangUpOnPeers(this._feedPeerKeys(drive), redial)
  }

  // The PUBLIC KEYS of the peers carrying this feed, deduplicated. Readable only while the
  // drive is OPEN: drive.purge() closes before it unlinks (hyperdrive 11 — `await this.close()`,
  // then core.purge()), hypercore's last-session close calls replicator.destroy(), and that
  // closes every peer channel and empties replicator.peers. A closed or purged drive answers
  // with an empty list, and so does a freshly re-opened replica — it has no peers of its own,
  // which is the defect step 4a exists for.
  //
  // ⚠ KEYS, NOT THE SOCKETS THEMSELVES, and that is a bug fix rather than a style choice. A
  // socket captured here can be gone by the time a caller acts on it: MEASURED across an e2e
  // run, three of six rotations reached their hang-up with the captured stream ALREADY
  // destroyed, so a 'close' hook armed on it never fired and the re-dial never ran. What has to
  // be hung up on is whatever connection to that PEER is live at that moment, which may be a
  // different socket than the one the drive was reading.
  _feedPeerKeys (drive = this._feedDrive) {
    if (!drive || !drive.core || !this._swarm) return []
    const seen = new Map()
    for (const peer of [...drive.core.peers]) {
      const key = peer && peer.stream && peer.stream.remotePublicKey
      if (key) seen.set(b4a.toString(key, 'hex'), key)
    }
    return [...seen.values()]
  }

  // Hang up on each of these peers — one socket usually carries all of a peer's channels, so
  // this is per PEER, not per feed — and return how many live connections were destroyed. With
  // `redial`, dial each of them straight back instead of waiting out hyperswarm's backoff; see
  // _redialPeer for why that is not the same thing as doing nothing, and _rotateActiveFeed
  // step 4b for the caller that cannot afford the difference.
  //
  // The dial is armed on the connection's own 'close' because joinPeer() no-ops while the old
  // connection is still in _allConnections, and hyperswarm's close handler (registered when the
  // connection was made, so it runs first) is what removes it. A peer with NO live connection is
  // dialled at once instead: there is nothing to wait for, and a hang-up that found nothing to
  // hang up on is exactly the case where the swarm may already have given up on it.
  _hangUpOnPeers (keys, redial = false) {
    const swarm = this._swarm
    if (!swarm || !keys.length) return 0
    let n = 0
    for (const key of keys) {
      let live = null
      for (const conn of swarm.connections) {
        if (conn.remotePublicKey && b4a.equals(conn.remotePublicKey, key)) { live = conn; break }
      }
      if (!live) {
        if (redial) this._redialPeer(swarm, key)
        continue
      }
      n++
      if (redial) live.once('close', () => this._redialPeer(swarm, key))
      try { live.destroy() } catch {}
    }
    return n
  }

  // Dial a peer we deliberately hung up on, NOW, rather than at hyperswarm's failure backoff.
  //
  // ⚠ THE BACKOFF IS THE WHOLE PROBLEM, and it is not a tuning preference: hyperswarm cannot
  // tell a recycle from a failure, so our own teardown runs peerInfo._disconnected() and walks
  // the peer up the ladder — attempts 0/1 → ~1-1.5 s, 2 → ~5-6 s, 3 → ~15-17 s, past 3 → NO
  // retry timer at all and the peer is garbage-collected (hyperswarm lib/retry-timer.js
  // _selectRetryTimer, index.js _maybeDeletePeer). attempts only resets when a connection
  // lived MIN_CONNECTION_TIME (15 s) before it dropped, so a feed that is torn down twice
  // inside that window is already at the 5-6 s rung — longer than the serving core's whole
  // availability wait (waitMs 6000), i.e. the parked media request 404s and the viewer is
  // remounted. MEASURED: with the dial left to the backoff, one e2e run recovered in 18 ms and
  // the next in 1270 ms, and the rotation after that never made it inside waitMs at all.
  //
  // The lookup path is not a fix either, which is why this does not just call
  // discovery.refresh(): PeerDiscovery.refresh() returns the in-flight _currentRefresh when
  // there is one, so the "fresh" lookup a re-open triggers can be a query that already ran and
  // already delivered its peers.
  //
  // joinPeer/leavePeer as a PAIR is the public API that says "connect to this peer now"
  // without the lasting consequences of an explicit peer (never GC'd, retried forever at
  // BACKOFF_X): joinPeer re-creates a GC'd PeerInfo, caps a de-prioritised one at attempts 3
  // so _updatePriority stops refusing it, and enqueues — and hyperswarm's queue drain has no
  // cooloff, so the dial starts synchronously. leavePeer immediately after only clears the
  // explicit flag; _maybeDeletePeer then finds the pending connection and keeps the peer.
  //
  // ⚠ IT IS NOT GUARANTEED TO PRODUCE A DIAL, and nothing here may pretend otherwise. joinPeer
  // no-ops whenever _allConnections already holds anything for that key (a socket whose close
  // has not landed, or a dial started before we hung up), and a dial that does go out can still
  // lose the duplicate-connection tie-break at the far end (hyperswarm _handleServerConnection,
  // ERR_DUPLICATE) and land the peer back on the very backoff this exists to avoid. Both are why
  // the caller hangs up on the LIVE connection to the peer first (_hangUpOnPeers) and arms this
  // on that connection's own 'close' — with the old socket gone, joinPeer's early return cannot
  // fire and the far end has nothing to tie-break against.
  _redialPeer (swarm, publicKey) {
    if (!swarm || swarm !== this._swarm || swarm.destroyed || !publicKey) return
    try { swarm.joinPeer(publicKey); swarm.leavePeer(publicKey) } catch {}
  }

  // --- purged-replica ledger: eviction notes the connections, the next SERVE spends them ---

  // Remember which connections a feed's replica was purged on. THE CONTRACT: any purge of a
  // feed replica that something could re-open later goes through here first, while the drive
  // is still open — a purge that skips it is a channel that dies on its next tune. That is
  // _evictFeed (the count bound, the store byte cap through it, the tune ladder's last rung,
  // a wedged open) and _rotateActiveFeed's step 4. Not _sweepIdleFeeds, which clears and
  // never purges, and not _doSweepStaleReplicas, which only touches namespaces absent from
  // the catalog AND out of the cache — nothing is replicating those, and its bare open never
  // downloads, so corestore never attached the core to a stream that could be poisoned.
  //
  // ⚠ SOCKETS HERE, KEYS AT _feedPeerKeys, AND THE DIFFERENCE IS THE QUESTION EACH ANSWERS.
  // The rotation asks "get this peer dialled again, now" — a peer-shaped question, and it
  // MUST be, because the socket it captured is frequently dead by the time it acts (measured:
  // three rotations in six), so anything hung on that object never runs. This ledger asks a
  // different one: "is the connection that poisoned this replica STILL the live one?" Only
  // the object can answer that, and it matters because eviction and re-open are minutes
  // apart, not milliseconds. If the socket has since been replaced, the replacement is a
  // fresh protomux that carries the replica perfectly well — hanging up on the PEER there
  // would drop a healthy connection that is very likely serving other feeds too, and cost the
  // whole lineup a reconnect to fix nothing. So the socket DECIDES and the key ACTS: what
  // survives the gate is handed to _hangUpOnPeers, which re-resolves the live connection and
  // arms _redialPeer on it. Nothing is ever armed on a captured socket, so the failure that
  // forced _feedPeerKeys cannot reach this path.
  //
  // Keyed by feedKey rather than the cache key: the poison follows the DISCOVERY key (same
  // protomux channel), and that derives from the feed key alone — a re-key opens the same
  // namespace and inherits the same dead channel. Connections already gone are dropped on the
  // way in, and so are the records of feeds whose connections have all since died: a feed
  // purged on a connection that no longer exists has nothing left to hang up on, and neither
  // the entry nor the socket it pins is worth carrying for the rest of the session.
  _recordPurgedFeed (feedKeyHex, drive) {
    for (const [key, list] of this._purgedFeeds) {
      if (!list.some((p) => !p.socket.destroyed)) this._purgedFeeds.delete(key)
    }
    const seen = new Map()
    if (drive && drive.core && this._swarm) {
      for (const peer of [...drive.core.peers]) {
        const socket = peer && peer.stream
        if (!socket || socket.destroyed || !socket.remotePublicKey) continue
        seen.set(b4a.toString(socket.remotePublicKey, 'hex'), { key: socket.remotePublicKey, socket })
      }
    }
    if (seen.size) this._purgedFeeds.set(feedKeyHex, [...seen.values()])
    else this._purgedFeeds.delete(feedKeyHex)
  }

  // Called when a feed BECOMES THE SERVED ONE. If its replica was purged on a connection that
  // is still up, hang up on that peer so the swarm dials fresh.
  //
  // ⚠ A CORE WHOSE STORAGE WAS PURGED DOES NOT RE-ATTACH TO AN ALREADY-ESTABLISHED PROTOMUX.
  // Measured on the bare stack — corestore 6.18.4 / hyperdrive 11.13.4 / hypercore 10.38.2 /
  // hyperswarm 4.17.0 / protomux 3.11.0, no SDK involved:
  //   close() + re-open, same namespace ................ replication resumes at once
  //   purge() + re-open, same namespace ................ NEVER resumes (15/30/60 s+)
  //   purge() + 5 s delay + re-open .................... NEVER — so it is not a race
  //   purge() + re-open under a DIFFERENT namespace .... NEVER — the discovery key is the
  //     same, so it is the same protomux channel either way
  //   purge() + re-open + destroy the connection ....... resumes at once
  // (hypercore's last-session close does call replicator.destroy(), which closes each peer
  // channel — so a closed channel is not the whole story. Whatever state remains, only a
  // fresh socket clears it.)
  //
  // AND THE TUNE LADDER CANNOT RESCUE IT, which is why the fix cannot be left to recovery:
  // the rung that would fix it IS this teardown ('feed:reconnect'), and it is skipped
  // precisely BECAUSE the symptom is zero peers — with no peer to hang up on,
  // _startTuneWatchdog goes straight to the friendly error. Measured on the e2e lane with
  // this call removed: 'feed:open', 'feed:ready', 'feed:retune', NO 'feed:reconnect', then
  // "tune timeout … after 18s" while the socket sat there undestroyed, still carrying the
  // channel next door. Dead for the session, on a re-zap to any trimmed channel.
  //
  // DEFERRED TO THE SERVE, not done at the eviction and not at every re-open:
  //   - at the EVICTION it would fire on ordinary zapping, for a channel the viewer may
  //     never return to, and take every other feed on that connection down with it;
  //   - at every RE-OPEN it would fire for background prefetch too (prewarm, the neighbour
  //     warm, the /feedthumb warm), i.e. interrupt the channel that is PLAYING for the sake
  //     of one that is not. A prefetch that opens a purged feed leaves the record in place
  //     and gets a replica that downloads nothing until the viewer actually zaps to it —
  //     the prefetch is wasted, the playback is not.
  // Residual, stated rather than implied: the serve DOES interrupt the other feeds on that
  // connection, which is the same trade the ladder's own rung makes — prefetch bandwidth
  // against a channel that would otherwise not play at all. One hang-up covers every feed
  // purged on that connection, though, because the ones behind it find their socket already
  // gone and correctly do nothing.
  _healPurgedFeed (feedKeyHex) {
    const purged = this._purgedFeeds.get(feedKeyHex)
    if (!purged) return 0
    this._purgedFeeds.delete(feedKeyHex)
    const swarm = this._swarm
    if (!swarm) return 0
    const keys = purged.filter((p) => !p.socket.destroyed && swarm.connections.has(p.socket)).map((p) => p.key)
    // redial, because hyperswarm's own backoff is not a recovery for a tune the viewer is
    // waiting on: our teardown walks the peer up the retry ladder (1-1.5 s, 5-6 s, 15-17 s,
    // then nothing) exactly as it does for the rotation — see _redialPeer.
    const n = this._hangUpOnPeers(keys, true)
    if (n > 0) this.emit('status', { state: 'feed:reconnect' })
    return n
  }

  // ⚠ THERE IS DELIBERATELY NO RETRY LOOP BEHIND THIS, and the history is worth keeping because
  // the obvious fix was the wrong one. A dial that did not take was observed once as a 10078 ms
  // recovery — exactly tune.rescanMs, i.e. the dial had failed silently and _checkFeedPeers'
  // zero-peer rescan rescued the channel ten seconds later, four times the park budget. The
  // first response was a bounded re-dial chase (dial, re-check, dial again). The actual cause
  // was upstream of it: the teardown was arming its re-dial on a SOCKET captured before the
  // purge, and by the time it ran, three rotations in six had a captured socket that was already
  // destroyed — so the 'close' hook never fired and no dial was ever attempted. Keying the
  // hang-up on the PEER instead (_feedPeerKeys, _hangUpOnPeers) fixed it at the source, the
  // chase became a loop that never ran a second pass, and it was removed rather than left in as
  // insurance against a bug that no longer exists.
  //
  // What guards it now is the e2e lane, which asserts the re-opened replica gains a peer inside
  // 3 s WITH THE RESCAN DISABLED — so a dial that stops taking fails loudly instead of being
  // masked by a recovery ten seconds later, which is what a retry loop here would also have
  // done. If that assertion ever starts flaking, the answer is to find the next root cause, not
  // to re-add the chase.

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
    // ⚠ NOT IF SOMEBODY ELSE OWNS THIS SLOT — see _claimSlot, and note that _evictFeed is NOT
    // the only path that has to honour a claim, which is why the check lives on the slot
    // rather than inside that function. This one's whole method is delete → await → close →
    // re-open, and during a rotation the value it would await is the drive the rotation has
    // just opened and is a microtask away from publishing: closing it makes _feedDrive a
    // CLOSED handle, and every media request for the rest of the play resolves to it. Narrow
    // but reachable — the tune ladder fires this on a schedule over a multi-hour session.
    //
    // Standing down costs the ladder nothing: a rotation is itself re-opening this exact feed
    // (which is what a retune wanted), and the rung after this one fires either way.
    if (pending && pending.claims) return
    this._feeds.delete(cacheKey)
    let castUnpointed = false // this retune left a pinned cast holding no drive
    try {
      const f = await pending
      if (f && f.drive) {
        if (this._feedDrive === f.drive) { this._feedDrive = null; this._feedDiscovery = null }
        // A cast pinned to this feed is about to be reading a CLOSED drive — drop its
        // handle so requests 404 for the few hundred ms of the reopen instead of 500ing,
        // then re-point it below.
        if (this._cast && this._cast.drive === f.drive) { this._cast.drive = null; castUnpointed = true }
        await f.drive.close()
      }
    } catch {}
    if (this._active !== a) {
      // Zapped away while closing — that resolve owns the serving slot now, and this
      // retune will never reopen the feed. A cast whose drive we just dropped would sit
      // there 404ing forever behind a bound socket, so end it properly instead. (This
      // return used to be the second way to make a zombie session; the first was
      // _evictFeed.)
      if (castUnpointed) this._endCast('retune-abandoned')
      return
    }
    // The reopen below is UNBOUNDED on purpose (see the note above this function), and a
    // cast whose drive was just dropped holds null until it lands. If that open REJECTS the
    // only caller is `.catch(() => {})`; if it never settles — the likelier of the two —
    // nothing downstream runs at all. Either way castUnpointed was consumed only on the
    // branch above, so the session sat there with no drive, 404ing behind a bound socket,
    // with nothing left to end it: the same zombie shape this path was rewritten to remove,
    // in the same function. The tune watchdog does not cover it either — its last rung calls
    // _evictFeed on a cache entry this function already deleted, and _evictFeed's own
    // _endCast rides the OLD open settling. So the CAST gets its own bound here. The
    // RETUNE's wait is unchanged: a slow reopen still recovers the tune when it lands.
    const stranded = castUnpointed ? this._cast : null
    let castGuard = null
    if (stranded) {
      castGuard = setTimeout(() => {
        if (this._cast === stranded && !stranded.drive) this._endCast('retune-failed')
      }, this._tune.timeoutMs)
      castGuard.unref?.() // diagnostics must never hold a host process open
    }
    let feed
    try {
      feed = await this._openFeed(a.feedKey, keys.encryptionKey)
    } catch (err) {
      if (castGuard) clearTimeout(castGuard)
      if (stranded && this._cast === stranded && !stranded.drive) this._endCast('retune-failed')
      throw err
    }
    if (castGuard) clearTimeout(castGuard)
    // This retune only CLOSED the drive, so it needs no teardown of its own — but the feed
    // it is re-opening may have been PURGED earlier and never served since: the tune
    // ladder's last rung evicts the active feed, and a host that calls reconnectActiveFeed()
    // afterwards re-arms the watchdog straight into this function, with no serveFeed in
    // between to spend the record. See _healPurgedFeed.
    this._healPurgedFeed(a.feedKey)
    // Re-point the cast BEFORE the _active check below. A cast is pinned to the CHANNEL,
    // and whether the phone zapped away during the reopen has nothing to do with whether
    // this channel's feed is now open again — doing it after the check is what left a
    // zapped-during-retune cast holding the null drive it was given above.
    this._recastFeed(a.streamId, cacheKey, feed.drive) // a cast on this channel follows the retune
    if (this._active !== a) return
    this._feedDrive = feed.drive
    this._feedDiscovery = feed.discovery
    a.lastSig = null
    a.lastAdvance = Date.now()
  }

  // --- active-feed rotation (the viewer disk bound where clear() frees nothing) ---

  // PURGE the active feed's replica and re-open it empty, in place, without the host
  // player losing the channel. This is the bound of last resort from the VIEWER DISK
  // BUDGET note: on a 32-bit Android ABI the serving core's below-window reclaim frees
  // ZERO bytes, so a watch session grows ~0.9 GB/hour with nothing else to stop it, and
  // unlink is the only operation that actually returns the bytes.
  //
  // Modelled closely on _retuneActive — the precedent for swapping the served drive out
  // from under a live play — with four differences, each of which is a hazard rather than
  // a preference:
  //
  //   1. A CAST-PINNED FEED IS NEVER ROTATED. _retuneActive can drop the pinned drive and
  //      re-point the session because it CLOSES the drive and re-opens the same content;
  //      this purges it. Purging the feed a receiver is reading deletes, from under it,
  //      the only copy of every block below the live window (they are unfetchable
  //      swarm-wide — see CAST RECLAIM POLICY), i.e. exactly the hazard _trimFeeds
  //      documents where it refuses to evict _castFeedKey. Disk is the lesser problem, so
  //      this refuses and says so.
  //
  //      ⚠ AND THEN A CAST-PINNED FEED HAS NO DISK BOUND AT ALL WHILE THE PIN LASTS. The
  //      earlier version of this line said "let stopCast()'s own reclaim pass bound it
  //      later", which is not true on the platform this whole feature exists for: that pass
  //      is _reclaimCastFeed -> reclaimBelowWindow -> clear(), and clear() is the no-op that
  //      frees ZERO bytes wherever the storage layer cannot hole-punch. So on a 32-bit ABI
  //      the honest statement is: reclaim is off for the pinned feed by policy, rotation
  //      refuses it, _trimFeedBytes counts it as held and cannot evict it, and stopCast()
  //      frees nothing. The bytes come back when the pin is RELEASED and the replica is
  //      unlinked — by an eviction, by the store cap once it is evictable again, or by the
  //      stale-namespace sweep on the next run. A long cast on a small device is therefore
  //      genuinely unbounded until it ends, and that is a known limit, not an oversight.
  //   2. REQUESTS PARK instead of 404ing. _retuneActive's reopen leaves _feedDrive null
  //      for a few hundred ms and the serving core answers a null target with an INSTANT
  //      404 — no availability wait, no peer lookup — which costs ExoPlayer 3 retries, an
  //      onError and a 2.5 s remount. A retune is rare and reactive (playback is already
  //      broken); a rotation fires on a HEALTHY stream, so it may not spend that. The park
  //      is a bet with a real downside when it is lost — see FEED_SWAP_PARK_MS, which
  //      states the arithmetic, and _armFeedSwap / _mediaTarget.
  //   3. IN-FLIGHT READS ARE DRAINED first. drive.purge() closes the drive; a segment read
  //      still running when it lands dies mid-body. Bounded (FEED_DRAIN_MS) — past the
  //      bound the purge happens anyway and those responses are destroyed, which is the
  //      same thing an abort already does to them. The drain runs BEFORE the park is armed:
  //      nothing has been taken away yet, so requests arriving during it are served the real
  //      drive, and the park budget is spent only on the phase that needs it.
  //   4. THE OLD SWARM SESSION IS DESTROYED (in the finally, on every exit — see
  //      _retireDiscovery). _retuneActive leaks one per retune, and a recurring rotation
  //      would make that leak a growth curve; so would a rotation that only retired the
  //      session on the path where it SUCCEEDED, which is what this used to do.
  //   5. THE FEED'S PEERS ARE HUNG UP ON AND DIALLED STRAIGHT BACK (steps 4a/4b).
  //      _retuneActive needs nothing of the sort — it CLOSES the drive, and a closed core
  //      re-attaches to its existing connections on re-open immediately. A PURGED one never
  //      does, at any delay and under any namespace, so a rotation that skipped this handed
  //      back a peerless replica and killed the channel for the session. Step 4a carries the
  //      measurement table; it is the difference on this list that the feature does not work
  //      without.
  //
  // Re-opening over the SAME corestore namespace is safe here for a reason worth stating,
  // because it is the opposite of what the single-flight cache warns about: the old drive
  // is fully GONE (purge = close + delete both cores' storage) before the new open starts,
  // so there is no second drive and no deadlock. A rotation that OVERLAPPED its old and new
  // drives would deadlock exactly as the cache's comment says — which is why this is strictly
  // sequential and refuses to start a second rotation. What "fully gone" does NOT buy is the
  // REPLICATION side: the new core does not take over the old one's protomux channel, which
  // is difference 5 above and step 4a's whole subject.
  //
  // EVERY AWAIT HERE IS BOUNDED, and the one that is interesting is drive.purge(). Nothing may
  // PROCEED without it — reopening a namespace whose delete is still in flight is precisely
  // the overlap above — so its bound is a WATCHDOG rather than a timeout: past FEED_PURGE_MS
  // this function abandons the rotation entirely instead of carrying on. That distinction is
  // the whole design. Unbounded, a purge that never settled took the rotation mechanism and
  // this channel's cache slot down permanently, which is strictly worse than the black screen
  // the watchdog costs.
  //
  // THE CACHE SLOT UNDER cacheKey IS CLAIMED from the moment the mutex is taken until this
  // rotation's re-open has SETTLED — through the live entry, the placeholder and the re-open
  // in turn, with no gap between them. That interval deliberately outlives this function: the
  // re-open is still in flight on the failure path, and it is _recoverFailedRotation that
  // finishes the job. See _claimSlot; the two paths that must honour it are _evictFeed and
  // _retuneActive.
  //
  // Returns true when the drive was actually swapped. Never throws.
  async _rotateActiveFeed (a, info = null) {
    if (!a || this._active !== a) return false
    // ONE AT A TIME — see the sequential note above. This used to read `if (this._feedSwap)`,
    // i.e. the single-flight guard and the park gate were the SAME field, and that was a
    // live hazard rather than an aesthetic one: _releaseFeedSwap clears _feedSwap and FOUR
    // callers that know nothing about a rotation call it while one is still running (the
    // park timer, serveFeed() on any zap, stop(), _purgeAndRebuild()). From that moment the
    // guard was DOWN, including across the interval between drive.purge() and the reopen —
    // exactly the interval this function's own comment says a second rotation would deadlock
    // in. The mutex below is set here and cleared in this function's finally, by nothing
    // else, so it is still true when a second over-budget callback arrives.
    if (this._feedRotate) return false
    // vod (S8a): a title's replica is a SEEK CACHE, not a rolling buffer. Purging it
    // mid-film throws away everything behind the playhead that the viewer may scrub back
    // to, and the "it grows forever" premise does not hold — a finished title is a
    // bounded download. Every other disk path in this engine skips VOD for the same
    // reason (see the Reclaim class in serve.js); this one does too.
    if (a.vod) return false
    const keys = this._entitled.get(a.streamId)
    if (!keys || !keys.encryptionKey) return false
    const cacheKey = a.feedKey + ':' + keys.encryptionKey
    const pending = this._feeds.get(cacheKey)
    const drive = this._feedDrive
    if (!pending || !drive) return false
    // The cache entry must BE the served drive. If a rotation-follow or a retune has moved
    // _feedDrive to a drive this key no longer names, purging by key would delete a replica
    // nobody asked about and leave the one that is growing. Also: `settled` (not `await`)
    // keeps this synchronous — an open still in flight is not a feed that is over budget.
    const f = pending.settled
    if (!f || f.drive !== drive) return false
    // ⚠ THE PIN CHECK IS NOT GATED ON this._cast. It used to read
    // `this._cast && (this._cast.drive === drive || this._castFeedKey === cacheKey)`, which
    // made the KEY half dead code whenever _cast was null — and _cast is null in two windows
    // where the feed is very much still pinned: _doStopCast() sets `this._cast = null` while
    // _castFeedKey still holds the pin (it is only re-pointed at the end), and _doStartCast()
    // publishes this._cast LAST, after an async LAN socket bind, while _castFeedKey was
    // pinned before it. The three sibling guards (_trimFeeds, _sweepIdleFeeds,
    // _trimFeedBytes) all test the key on its own; this now matches them.
    if (this._castPins(drive, cacheKey)) {
      // The only "log" this file has is the status stream, which is also the problem-report
      // breadcrumb ring (_recordEmit) — i.e. the surface an operator can actually read back
      // from a viewer's device. A refusal that left no trace would make "why did this
      // device fill up?" unanswerable.
      this.emit('status', { state: 'feed:rotate', streamId: a.streamId, skipped: 'cast-pinned', message: 'not rotated: a cast session is pinned to this feed' })
      return false
    }

    const startedAt = Date.now()
    // TAKE THE MUTEX (see the top of this function) and capture the teardown generation:
    // `this._active !== a` says only that the viewer zapped, and every await below is a
    // place where stop() or _purgeAndRebuild() can have destroyed the store and the swarm
    // underneath this. Without the epoch check a rotation that got past the drain would
    // still reach _ensureStore() and build a NEW Corestore + Hyperswarm and join a topic
    // AFTER stop() returned, or hand the rebuilt engine a store over a just-deleted
    // directory. Checked after each await, including inside the recovery path.
    const epoch = this._epoch
    const rot = { cacheKey }
    this._feedRotate = rot
    // CLAIM THE CACHE SLOT — from HERE, not from the moment the placeholder goes in. The
    // mutex has to be taken before the drain (a second over-budget callback would otherwise
    // start a second drain and a second purge of the same drive), and that left ~11 s of drain
    // + measure in which the slot was unowned while the cache entry still held the LIVE feed:
    // an _evictFeed in there — the tune ladder's last rung is the reachable one — purged the
    // drive being watched, and this rotation then re-installed a placeholder over a key it had
    // just evicted and purged an already-purging drive. The claim covers the whole critical
    // section instead, moving from the settled entry to the placeholder to the re-open, so
    // there is no instant between the mutex and the new drive in which the slot is anyone
    // else's. `pending` is already settled, so this claim is explicit-release only — the
    // finally lets it go on every path, including the four that back out before the purge.
    let releaseSlot = this._claimSlot(pending)
    let swap = null // the park gate, armed at step 3 — NOT here (see FEED_SWAP_PARK_MS)
    let settle = null
    const placeholder = new Promise((resolve) => { settle = resolve })
    let installed = false // the placeholder is the cache entry for cacheKey
    let opening = null // the re-open, kept in scope so the finally can chain the old session on it
    let oldDiscovery = null // the purged feed's swarm session, retired in the finally (see step 6)
    let reopened = null
    let purged = false // the old replica's storage is gone — nothing may be pointed at it
    let bytes = info && Number.isFinite(info.bytes) ? info.bytes : null
    let done = null // the success payload, emitted OUTSIDE the try (see below)
    let swapped = false
    try {
      // 1. DRAIN. Parked requests are not in flight — resolveTarget has not returned for
      //    them — so they cannot deadlock this wait; only reads already piping bytes can.
      //
      //    ⚠ THIS CANNOT SEE CAST READS, and it is worth saying so rather than implying a
      //    coverage it does not have: handler.inflight/whenDrained belong to the LOOPBACK
      //    handler's InFlight instance, and _castRequestHandler is a SECOND
      //    createDriveHandler with its own. A rotation of a cast-pinned feed is refused
      //    outright (twice — before and after this drain), so the only way a cast read can
      //    touch this drive is a session that publishes during the awaits below, which the
      //    re-check at step 3 and _castLostDrive after the purge exist to catch. If this
      //    function ever stops refusing a pinned feed, this drain has to be taught about the
      //    cast handler first.
      const h = this._handler
      if (h && h.whenDrained) { try { await h.whenDrained(drive, FEED_DRAIN_MS) } catch {} }
      if (this._epoch !== epoch) return false // the engine was stopped or purged under us
      if (this._active !== a) return false // zapped away mid-drain; that resolve() owns the slot now
      // 2. MEASURE, while the drive still exists — an unlinked one cannot answer. The
      //    trigger already measured to decide, so this pass is only paid for when the
      //    caller did not carry a number (and null, "unmeasurable", is a fine answer: it
      //    costs the event a field, not the rotation). Bounded inside _measureFeed.
      if (bytes === null) { const m = await this._measureFeed(drive); bytes = m ? m.bytes : null }
      if (this._epoch !== epoch || this._active !== a) return false
      // 3a. RE-CHECK THE PIN. The check at the top is ~1.5 s of awaits old by now, and
      //     _doStartCast can resolve THIS drive (it reuses the cache through
      //     _openFeedWithin) and publish its session inside that window. Rotating then
      //     purges the replica the receiver is reading — the exact hazard the refusal at the
      //     top exists to prevent, arrived a moment later. This is the last point at which
      //     backing out is free.
      if (this._castPins(drive, cacheKey)) {
        this.emit('status', { state: 'feed:rotate', streamId: a.streamId, skipped: 'cast-pinned', message: 'not rotated: a cast session was pinned to this feed while it drained' })
        return false
      }
      // 3b. ARM THE PARK — here, not at the top. It used to be armed before the drain, back
      //     when the drain was 1500 ms and the park 4000: the two of them plus the measure
      //     billed against that one budget and left ≤2.5 s for the reopen, which is the ONLY
      //     phase in which _feedDrive is null and therefore the only phase the park is for.
      //     Both numbers have since moved (FEED_DRAIN_MS is 6000, FEED_SWAP_PARK_MS 2500) and
      //     they no longer share a budget at all — which is the whole point of arming here.
      //     From this line to the finally below, a media request waits for the new drive
      //     instead of resolving a null one.
      swap = this._armFeedSwap()
      // 3c. DROP THE HANDLES synchronously, so nothing can start a fresh read of a drive
      //    that is about to be unlinked — and park the CACHE ENTRY in the same breath,
      //    which is a different hazard with the same shape. The window between "the drive
      //    is gone" and "the new one is open" is exactly when another caller can ask for
      //    this feed: /feedthumb on the channel being watched falls through to the cache
      //    the moment _feedDrive is null, and startCast/prewarm can want the same key.
      //    _openFeed would then build a SECOND Hyperdrive over a namespace that is being
      //    purged. A promise with no `settled` is already this cache's "an open is in
      //    flight" state — every synchronous reader treats it as cold, and every awaiting
      //    caller is handed the drive this rotation opens. Installed HERE rather than at
      //    the top so that an abandoned rotation (the checks above) leaves the cache exactly
      //    as it found it; from here on the whole sequence is committed and the next await
      //    is the purge itself.
      if (this._feedDrive === drive) { this._feedDrive = null; this._feedDiscovery = null }
      this._feeds.set(cacheKey, placeholder) // set(), not delete+set: the entry keeps its LRU position
      // The claim moves with the slot — released off the settled entry, taken on the
      // placeholder, with no gap between the two. `untilSettled` so it also lifts by itself if
      // this function somehow leaves without releasing it.
      releaseSlot()
      releaseSlot = this._claimSlot(placeholder, true)
      installed = true
      // 4a. FORCE A FRESH DIAL. Without this the rotation completes, reports success, hands
      //    back a replica with ZERO peers — and the channel is dead for the rest of the
      //    session. On a 32-bit build that is EVERY rotation, i.e. the feature trades a full
      //    disk for a dead channel. This is the most load-bearing fact about the whole
      //    mechanism, so it is recorded here rather than left to be re-derived:
      //
      //    ⚠ A CORE WHOSE STORAGE WAS PURGED DOES NOT RE-ATTACH TO AN ALREADY-ESTABLISHED
      //    PROTOMUX. Measured on plain corestore 6.18.4 / hyperdrive 11.13.4 /
      //    hypercore 10.38.2 / hyperswarm 4.17.0 / protomux 3.11.0, with no SDK involved:
      //      close() + re-open, same namespace ................ replication resumes at once
      //      purge() + re-open, same namespace ................ NEVER resumes (15/30/60 s+)
      //      purge() + 5 s delay + re-open .................... NEVER — so it is not a race
      //      purge() + re-open under a DIFFERENT namespace .... NEVER — the discovery key is
      //        the same, so it is the same protomux channel either way
      //      purge() + re-open + destroy the connection ....... resumes at once
      //    (hypercore's last-session close does call replicator.destroy(), which closes each
      //    peer channel — so a closed channel is not the whole story. Whatever the remaining
      //    state is, only a fresh socket clears it. A fresh dial is REQUIRED.)
      //
      //    AND THE TUNE LADDER CANNOT RESCUE IT, which is why this is not left to recovery:
      //    the rung that would fix it is 'feed:reconnect' — this same teardown — and it is
      //    skipped precisely BECAUSE the symptom is zero peers (_startTuneWatchdog only
      //    reconnects when there is a peer to tear down; with none it goes straight to the
      //    friendly error). Observed after one rotation before this line existed: 404s
      //    throughout, a 'feed:retune' at ~36 s (a close+reopen — no help, the channel is
      //    already poisoned), the friendly error at ~61 s, _feedDrive nulled, dead for the
      //    session.
      //
      //    THE CAPTURE HAS TO BE HERE AND THE HANG-UP HAS TO BE LATER, which is the one part
      //    of this that is not free to choose:
      //
      //      CAPTURE now, because this is the last instant the feed's peers are readable at
      //      all. They hang off drive.core.peers, purge() closes before it unlinks, and that
      //      close empties the list (see _feedPeerKeys). The re-opened replica cannot supply
      //      them either — it has no peers, which is the defect itself. Both later positions
      //      would need this list stashed from exactly here, so "capture at 4a" is forced. It
      //      is the peers' KEYS that are captured, not their sockets: see _feedPeerKeys for
      //      the measurement that made that distinction load-bearing.
      //
      //      HANG UP AFTER THE PURGE (step 4b), because the dial that follows is IMMEDIATE
      //      (_redialPeer, not hyperswarm's backoff) and a fresh socket arriving while the old
      //      cores are still open would have corestore attach THEM to it — and then the purge
      //      would poison the new connection exactly as it poisoned the old one. That window is
      //      a close() against a localhost dial: single-digit milliseconds on both sides, i.e.
      //      a coin toss. Ordering it after the purge closes the window completely and costs
      //      only that the dial no longer overlaps the unlink.
      //
      //      AND BEFORE THE RE-OPEN — MEASURED, not reasoned. The isolation table's passing row
      //      is purge → re-open → destroy, so hanging up FIRST was an untested ordering and was
      //      run as an experiment against the e2e lane, three runs each with the zero-peer
      //      rescan disabled so nothing could mask the result:
      //        before the re-open (this) ... peer back in 306 / 1 / 302 ms, picture in 449 / 25 / 357 ms
      //        after the re-open ........... peer back in 310 / 309 / 302 ms, picture in 1960 / 1587 / 2073 ms
      //      The dial itself takes equally well either way — the ordering is NOT what decides
      //      whether it lands. What decides it is the FAILURE path, and that is why this one
      //      ships: after the re-open, the hang-up is gated on the re-open having SUCCEEDED, so
      //      a re-open that misses its bound hands _recoverFailedRotation a connection that can
      //      never carry this feed, and the channel stays dead. That is not a theory — the third
      //      "after" run failed the lane's own recovery case ("playback returns after a failed
      //      rotation"), the case section 6 exists for. Doing it here also happens to get the
      //      picture back sooner (the fresh socket is up before the core starts downloading),
      //      but correctness on the failure path is the reason, not the speed.
      //
      //      Every downstream path therefore inherits a healthy connection: the abandoned-purge
      //      watchdog, the epoch and catalog bails, and the recovery. Nothing above step 3c
      //      reaches any of this — the cast-pinned refusals, the vod refusal and the
      //      _active/epoch bails all return earlier — and a re-dial is not a cost to pay for a
      //      rotation that never purged.
      //
      //    IT COSTS THE PARK NOTHING, so FEED_SWAP_PARK_MS stays 2500. Both halves are
      //    synchronous — a capture, then a destroy plus a joinPeer — and nothing here waits on
      //    the socket's 'close' or on the dial, so the park (armed at 3b, released in the
      //    finally) still covers purge + re-open and only those; the re-open does not wait on a
      //    peer either (_openFeed is ready() + join()). What the dial spends is the SERVING
      //    core's availability wait, not the park: a parked request wakes to a real drive and
      //    then sits in waitEntry for up to waitMs (6000, sdk/serve.js), which is a wait rather
      //    than a 404. MEASURED end to end on the e2e lane, over the rotation the park exists
      //    for: swap 54-99 ms, live edge advancing again 650-957 ms later — and most of THAT is
      //    waiting for the broadcaster's next playlist rewrite, not for the socket. Against the
      //    real DHT the dial is one holepunch to a peer we were connected to a moment ago (no
      //    lookup — see _redialPeer), which leaves the 6000 ms budget with room to spare.
      //    Raising the park would not help any of this and would only delay the 404 it exists
      //    to avoid (arithmetic there).
      //
      //    ⚠ AND IT IS THE PARK THAT STAYS PUT, NOT THE DIAL THAT IS FREE. Left to hyperswarm's
      //    own backoff this does NOT fit the availability wait — that is what _redialPeer is
      //    for, and the measurement that forced it is recorded there.
      //
      //    RESIDUALS, stated rather than implied. (a) One socket carries ALL of a peer's
      //    channels, so this also interrupts the prewarmed neighbours and every other cached
      //    feed replicating from the same broadcaster; they re-replicate automatically on the
      //    fresh connection and they are prefetch, not playback, so the trade is a moment of
      //    their download against this channel surviving at all. (b) A purge that DEGRADES to a
      //    plain close (the fallback below) would not have needed a dial, and there is no way
      //    to know that before calling it — one wasted re-dial on a path that already failed to
      //    free any bytes. (c) A catalog re-key that landed during the drain has already opened
      //    the new feed, quite possibly on this very socket, and it eats the same re-dial.
      const feedPeerKeys = this._feedPeerKeys(drive)
      // …and the same capture into the purged-replica ledger that _evictFeed makes, for the
      // paths where step 4b's hang-up does NOT happen or does not take: a throw between here
      // and there, a re-dial that loses the duplicate-connection tie-break (_redialPeer is
      // explicit that it cannot guarantee a dial), or a rotation that recovers into
      // _recoverFailedRotation. Belt to 4b's braces, and free: on the ordinary path 4b
      // destroys these very connections, so the record finds them dead at the next serve and
      // correctly does nothing. See _recordPurgedFeed for why the ledger holds sockets while
      // this step holds keys.
      // (cacheKey, not a.feedKey: a catalog re-key during the drain moves a.feedKey, and the
      // replica being purged here is the one cacheKey was built from — the same reason step 7
      // re-checks `moved`.)
      this._recordPurgedFeed(cacheKey.slice(0, cacheKey.indexOf(':')), drive)
      // 4. PURGE. Same fallback as _evictFeed: a refused purge degrades to a plain close,
      //    which frees no bytes but leaves the namespace re-openable, so the rotation still
      //    completes and the next one retries.
      //
      //    ⚠ THE ONE AWAIT NOTHING MAY PROCEED WITHOUT — and therefore the one that needs a
      //    WATCHDOG rather than a bound. Re-opening a namespace whose delete is still in
      //    flight is the overlap this function's header calls a deadlock, so a timeout here
      //    cannot mean "carry on": it means GIVE UP. Without one, a purge that never settles
      //    was not degraded but permanently fatal — the mutex was never cleared, so no channel
      //    could rotate again for the life of the process (on a 32-bit ABI, the only disk bound
      //    there is, gone), and the cache kept a placeholder that never resolved and that
      //    _evictFeed correctly refuses to touch, so every later tune of this channel threw
      //    'tune timeout' forever. stop() and _purgeAndRebuild release the mutex for exactly
      //    this reason; a hung purge with no teardown behind it had no escape at all.
      let purgeTimer = null
      const purging = drive.purge().catch(() => { try { return drive.close().catch(() => {}) } catch {} })
      purged = await Promise.race([
        purging.then(() => true, () => true),
        new Promise((resolve) => { purgeTimer = setTimeout(() => resolve(false), FEED_PURGE_MS) })
      ])
      clearTimeout(purgeTimer)
      // 4b. HANG UP AND DIAL STRAIGHT BACK — the other half of step 4a, placed here because
      //    the storage is gone by this line and a fresh socket can therefore only ever pick up
      //    the replica this rotation is about to open. It resolves the LIVE connection to each
      //    captured peer rather than reusing a socket captured at 4a, because the one the drive
      //    was reading may already be gone by now (_feedPeerKeys carries that measurement); the
      //    invariant it buys is that whatever connection carries the re-opened replica was
      //    established AFTER the purge. Run on BOTH purge outcomes: `purged` false means the
      //    UNLINK is still running, and close() — which is what leaves the connection unable to
      //    carry this feed again — has long since happened, so abandoning the rotation into an
      //    unrecoverable connection would just hand the tune ladder the same dead channel.
      //    (Residual: if it were close() itself that hung, the cores are still open and the
      //    fresh socket inherits them. That is a device where nothing works anyway, and the
      //    alternative — leaving the peer wedged — is not better.)
      const redialing = this._hangUpOnPeers(feedPeerKeys, true)
      // The old drive is closed either way — close is the first thing purge() does — so its
      // swarm session goes with it on both outcomes. Retired in the finally, once whatever
      // replaces it has landed; see step 6.
      oldDiscovery = f.discovery
      // A cast that published onto THIS drive between step 3a and here is now pointed at a
      // replica that no longer exists: every read 500s or 404s behind a still-bound LAN
      // socket while castSession() keeps handing out a live url, which is the zombie-cast
      // shape _evictFeed and _retuneActive were both rewritten to eliminate. This was the
      // one purge path in the file with no _endCast. (Nothing usually happens here: the
      // window is small and the two pin checks cover the rest of it.)
      //
      // 'feed-evicted' rather than a new 'feed-rotated': the reason strings are a declared
      // union in sdk/index.d.ts and widening a public union belongs with that file's edit,
      // not this one. It is also the honest label — from the session's side the pinned
      // replica was purged out from under it, which is exactly what 'feed-evicted' means
      // everywhere else it is used.
      this._castLostDrive(drive, 'feed-evicted')
      // The watchdog fired: the unlink is still running and re-opening over it is the one
      // thing this function must not do. Drop the slot (so the channel can be tuned again
      // rather than awaiting a placeholder that never resolves) and the mutex (the finally
      // does that), say so — this is otherwise a silent, total loss of the disk bound — and
      // hand recovery to the ladder that owns it, WITHOUT a re-open of our own.
      if (!purged) {
        this._dropPlaceholder(cacheKey, placeholder)
        installed = false
        this.emit('status', { state: 'feed:rotate', streamId: a.streamId, failed: true, message: `rotation abandoned: the replica purge did not settle within ${FEED_PURGE_MS} ms — falling back to the tune ladder` })
        if (!this._tuneTimer) this._startTuneWatchdog()
        return false
      }
      if (this._epoch !== epoch) { this._dropPlaceholder(cacheKey, placeholder); installed = false; return false }
      // …and one thing can have moved under all of that: the CATALOG can rotate this
      // channel onto a new feedKey while the purge runs (_maybeReresolveActiveFeed, a
      // broadcaster restart). Then the drive just unlinked was the DEAD one — still the
      // right thing to unlink — the follow has already opened and served its replacement,
      // and _feedDrive was left pointing at it by the identity check above. Re-opening
      // a.feedKey here would open the NEW feed under the OLD cache key and hand
      // _recastFeed a pin naming a feed that no longer exists. Stop instead.
      if (a.feedKey + ':' + keys.encryptionKey !== cacheKey) { this._dropPlaceholder(cacheKey, placeholder); installed = false; return false }
      // 5. RE-OPEN, BOUNDED. Hand the single-flight slot to the real open ATOMICALLY:
      //    _openFeed reads the cache and installs its own entry before it awaits anything,
      //    so no other caller can slip in between these two statements.
      //
      //    ⚠ THE BOUND IS THE POINT — AND IT MUST NOT BE _openFeedWithin. An open that never
      //    settles left the park to expire into a null _feedDrive, every media request 404ing
      //    for the rest of the session, the `finally` never running (so the mutex and the
      //    cache placeholder were held forever) and — worst for diagnosis — NO feed:rotate
      //    event ever emitted. So this is bounded. But the OBVIOUS way to bound it was worse
      //    than the unbounded version it replaced: _openFeedWithin's expiry calls
      //    _evictFeed(cacheKey), and _evictFeed used to schedule a purge() on whatever that
      //    still-pending open eventually settled to. On a slow reopen that was:
      //      the bound expires -> a purge is armed on the in-flight open of replica #1 ->
      //      this throws -> _recoverFailedRotation opens replica #2 over the SAME
      //      `replica:<feedKey>` namespace while #1 is still opening (the overlap this
      //      function's header says deadlocks) -> #1 settles -> its purge unlinks the storage
      //      #2 is using, which the recovery has just assigned to _feedDrive.
      //    _openFeedWithin's timeout semantics are cache MAINTENANCE, and maintenance has no
      //    business acting on a slot somebody is holding. Both halves of that are fixed at the
      //    source now rather than avoided here — _evictFeed never purges an unsettled open,
      //    and it refuses a CLAIMED slot outright — but the plain race stays: it is still the
      //    right bound for a caller that manages its own slot.
      //
      //    Leaving the pending open in the cache on expiry is the point, not an oversight:
      //    the recovery's _openFeedWithin is single-flight through the same entry, so it
      //    ADOPTS this open with a longer bound instead of building a second drive. The
      //    losing race arm needs no handler — _openFeed already attaches two to the promise.
      //
      //    ⚠ AND THE TIMER IS NOT unref'd, per the rule sdk/serve.js states at bounded(): when
      //    the open never settles this timer is the ONLY thing that can settle the promise
      //    being awaited here, and an unref'd one on a host whose loop is otherwise empty never
      //    fires. Immaterial in the app; it can hang a tool host mid-rotation.
      this._dropPlaceholder(cacheKey, placeholder)
      installed = false
      const reopenMs = Math.max(FEED_REOPEN_FLOOR_MS, swap.startedAt + FEED_SWAP_PARK_MS - Date.now())
      opening = this._openFeed(a.feedKey, keys.encryptionKey)
      // …AND THE CLAIM MOVES ONE LAST TIME, ONTO SOMETHING THAT OUTLIVES THIS FUNCTION. This
      // is where the rotation-scoped token failed: on the common failure — a slow device, the
      // race timer winning — the throw below runs the finally, the token was dropped there,
      // and the open still in the cache was left naked for _recoverFailedRotation's own expiry
      // (and for _doStartCast and serveFeed, which grab the placeholder and react to the null
      // it settles to) to evict and purge, while the recovery was about to build replica #2
      // over the same namespace. A claim released ON SETTLE covers exactly the interval that
      // matters, whether or not this function is still running.
      releaseSlot()
      releaseSlot = null
      this._claimSlot(opening, true)
      let reopenTimer = null
      try {
        reopened = await Promise.race([opening, new Promise((resolve) => {
          reopenTimer = setTimeout(() => resolve(null), reopenMs)
        })])
      } finally { clearTimeout(reopenTimer) }
      if (!reopened) throw new Error(`the replica did not re-open within ${reopenMs} ms`)
      if (this._epoch !== epoch) {
        // Stopped or purged while the replica re-opened. _closeFeeds() ran before this cache
        // entry existed, so nothing else will ever close this drive.
        this._abandonFeed(cacheKey, reopened)
        reopened = null // parked callers must be handed null, not a closing drive
        return false
      }
      // 6. SWARM SESSION HYGIENE — done in the finally, by _retireDiscovery, for EVERY exit
      //    rather than only this one. _openFeed joined the topic again, and hyperswarm's
      //    join() returns a SESSION on the topic's shared PeerDiscovery (hyperswarm 4.17
      //    index.js: an existing, undestroyed discovery answers with discovery.session()).
      //    PeerDiscovery only calls swarm.leave() when its session list reaches ZERO
      //    (_destroyMaybe), so destroying the old session AFTER the new join lands takes
      //    the count 1 → 2 → 1: the topic is never actually left, no unannounce is sent and
      //    no DHT round trip is paid. Nothing in this file has ever destroyed a discovery —
      //    every open/reopen leaks one session for the life of the process, and
      //    _retuneActive leaks one per retune. A rotation recurs, so it must not.
      //    (_evictFeed's identical leak is left alone deliberately: out of scope here.)
      //
      //    ⚠ IT USED TO BE A STATEMENT HERE, which is the half of the path that never fails.
      //    The race timer winning throws two lines up, and the epoch checks return, and on all
      //    of those the OLD session was never destroyed while the in-flight open went on to
      //    join the topic anyway — one leaked session per failed rotation, on a device where
      //    failure is the common outcome. Moving it to the finally is why there is nothing
      //    left to do at this line.
      // 7. SWAP THE STATE. _recastFeed before the _active check, for _retuneActive's
      //    reason: a cast is pinned to the CHANNEL, and a zap during the reopen has no
      //    bearing on whether this channel's feed is open again. (A cast pinned to THIS
      //    drive was refused at the top; this covers a session pinned to the same channel
      //    through a different key.)
      //
      //    ⚠ RE-CHECKED, not merely checked before step 5. The catalog can rotate this channel
      //    onto a new feedKey DURING the re-open just as it can during the purge, and
      //    _maybeReresolveActiveFeed does the whole follow itself: it opens the new feed,
      //    publishes it as _feedDrive and moves a.feedKey AND _activeFeedKey onto it. Step 7
      //    would then overwrite _feedDrive with this replica of the OLD key while
      //    _activeFeedKey names the new one — a dead feed served under a guard that protects a
      //    different one, which is precisely the mismatch _maybeReresolveActiveFeed's own
      //    _activeFeedKey line exists to prevent. The purge still counts (the bytes came back
      //    and the event says so); only the publish is wrong.
      const moved = a.feedKey + ':' + keys.encryptionKey !== cacheKey
      if (!moved) this._recastFeed(a.streamId, cacheKey, reopened.drive)
      if (!moved && this._active === a) {
        this._feedDrive = reopened.drive
        this._feedDiscovery = reopened.discovery
        // The replica is EMPTY and its playlist has not landed yet, so everything that
        // watches for "this feed is not advancing" is about to fire at a drive that is doing
        // nothing wrong. Three clocks, and the comment here used to name only the first two
        // and then claim they reset the tune watchdog "exactly as _retuneActive does" —
        // which was wrong about which clock the watchdog reads:
        //   - a.lastSig / a.lastAdvance are read by the HYBRID probes (_startStallWatchdog
        //     and the CDN recovery probe), not by the tune watchdog;
        //   - _peersLostAt is _checkFeedPeers' clock, and a freshly opened replica holds ZERO
        //     peers until the dial step 4b forced lands (tens of ms on the e2e testnet; one
        //     holepunch against the real DHT), so leaving it set escalates a healthy feed to
        //     'feed:rescan';
        //
        //     ⚠ AND THE REASON IT HAS ZERO PEERS IS NOT WHAT THIS COMMENT USED TO SAY. It
        //     claimed they were zero "by construction until corestore re-adds the core on the
        //     existing swarm connections" — i.e. that the existing connections would pick the
        //     new replica up on their own. THEY NEVER DO. A core whose storage was purged does
        //     not re-attach to an already-established protomux: not after a delay, not under a
        //     different namespace, never. A fresh dial is REQUIRED, which is why steps 4a/4b
        //     hang up on this feed's peers and dial them straight back — the full measurement
        //     table, the ordering and the costs are there. Left as written, that assumption cost the
        //     channel the rest of the session: zero peers forever, and the tune ladder's one
        //     rung that would have fixed it skipped for being exactly that symptom.
        //   - the tune watchdog's clock is the `started` local inside _startTuneWatchdog's
        //     closure, which nothing outside that closure can reach. Restarting the timer is
        //     the only way to reset it, and it is only correct to do so while one is already
        //     running (it is armed exclusively in p2p-only mode, so the guard also keeps
        //     this from arming live machinery anywhere else).
        a.lastSig = null
        a.lastAdvance = Date.now()
        this._peersLostAt = null
        if (this._tuneTimer) this._startTuneWatchdog()
      }
      done = { bytes, durationMs: Date.now() - startedAt, redialing }
      swapped = !moved && this._active === a
    } catch (err) {
      if (installed) this._dropPlaceholder(cacheKey, placeholder)
      // The old drive is gone and the new open did not land: _feedDrive is null and every
      // media request 404s until something re-opens. That "something" used to be named as
      // the tune watchdog — but _startTuneWatchdog() returns immediately unless the play is
      // p2p-only AND p2p AND non-VOD, so on a hybrid build nothing armed at all, and where
      // it did arm the first rung is 30 s away. A rotation fires on a HEALTHY stream, so
      // 30 s of black screen (or none at all) is not an acceptable recovery for it: re-open
      // now, bounded, and fall back to the watchdog only if that also fails.
      this._recoverFailedRotation(a, cacheKey, keys.encryptionKey, epoch, err)
      return false
    } finally {
      // Hand every awaiting caller the new feed — or null, which the cache's readers
      // already treat as a failed open (_openFeedWithin returns null, _retuneActive tests
      // `f && f.drive`, prewarm ignores it). NEVER a rejection: an unhandled one aborts the
      // Bare worklet, and this promise may legitimately have no handlers at all.
      settle(reopened || null)
      // Let the cache slot go — a no-op once the claim has moved onto the re-open, which
      // releases itself when it settles. Every path that backs out before that (the drain and
      // measure checks, the pin re-check, a throw) passes through here, so the live feed can
      // never be left permanently un-evictable by a rotation that gave up.
      if (releaseSlot) releaseSlot()
      // LAST LOOK AT THE CAST, and only once the replica really was purged (`purged` — on an
      // abandoned rotation this same drive is alive and well, and ending a legitimately
      // pinned session would be the bug, not the fix). _doStartCast resolves its drive and
      // THEN awaits a LAN socket bind before publishing this._cast, so a session that read
      // the old drive before step 3a can still appear after the _endCast above ran. By here
      // every re-pointing has happened (_recastFeed in step 7), so a session still holding
      // this drive is holding a replica that no longer exists. Idempotent: a no-op unless
      // that is exactly the case.
      if (purged) this._castLostDrive(drive, 'feed-evicted')
      // STEP 6, for every exit rather than the one that succeeded — see there. `opening` is
      // what makes the ordering right on the failure paths too: the session is destroyed only
      // once the re-open that replaces it has landed, so the topic is never actually left. A
      // rotation that gave up before step 5 has no replacement coming and passes null, which
      // destroys it at once — the honest reading of a topic with no drive behind it.
      if (oldDiscovery) { this._retireDiscovery(oldDiscovery, opening); oldDiscovery = null }
      // Release the park BEFORE the mutex: a request waking to find _feedDrive already set
      // is the whole point, and the mutex is what keeps a second rotation out until this one
      // has finished tidying up. `swap` is null when the rotation was abandoned before the
      // purge — nothing was ever parked, so there is nothing to release.
      if (swap) this._releaseFeedSwap(swap)
      // The MUTEX only. It no longer carries the cache slot, so dropping it here — which is
      // required, or a wedged rotation switches rotation off for the whole process — does not
      // expose the open this rotation is still going to serve: that is the claim's job, and
      // the claim outlives this function.
      if (this._feedRotate === rot) this._feedRotate = null
    }
    // OUTSIDE THE TRY, deliberately. The success emit used to sit next to the return inside
    // it, so anything that threw out of emit() — the _recordEmit breadcrumb ring is on that
    // path — would be caught by the rotation's own catch and turn a rotation that had
    // ALREADY SWAPPED THE DRIVE into `failed: true`, arming a recovery on a perfectly
    // healthy feed. (Emitter.emit wraps each listener in its own try/catch, so a host
    // listener cannot actually reach it today; the point is that the success path must not
    // be inside the failure handler's scope for a future edit to make it reachable again.)
    //
    // The event is the whole reason the rotation is observable: durationMs says whether the
    // park covered the swap or the viewer saw it, and bytes is what the purge returned to
    // the filesystem (null when the platform could not measure). Before it, the reclaim path
    // logged NOTHING — three nested empty catches and no way to attribute a full disk.
    if (done) {
      // The re-dial count rides in the MESSAGE rather than as a field of its own: the status
      // shapes are a declared union in sdk/index.d.ts and widening a public one belongs with
      // that file's edit. It earns its place in the breadcrumb ring anyway — "the picture came
      // back two seconds after the swap" is otherwise unattributable, and a 0 here on a feed
      // that then goes quiet says the peer was already gone before the rotation touched it.
      this.emit('status', { state: 'feed:rotate', streamId: a.streamId, bytes: done.bytes, durationMs: done.durationMs, message: `rotated ${a.streamId}: ${done.bytes == null ? 'unmeasured' : Math.round(done.bytes / 1048576) + ' MiB'} freed in ${done.durationMs} ms; ${done.redialing} peer connection(s) re-dialling` })
    }
    return swapped
  }

  // Is this feed pinned by a cast session? Drive identity OR cache key, and the key check is
  // NOT conditional on this._cast — see the call site at the top of _rotateActiveFeed for
  // the two windows in which _cast is null while the pin is live.
  _castPins (drive, cacheKey) {
    if (cacheKey && this._castFeedKey === cacheKey) return true
    return !!(drive && this._cast && this._cast.drive === drive)
  }

  // A cast session whose pinned drive has just been purged/closed out from under it. Drops
  // the handle synchronously (so requests 404 instead of reading a dead drive) and then
  // actually ENDS the session — _endCast closes the LAN socket, kills the token, unpins and
  // tells the host. Returns whether there was one. No-op when the session was already
  // re-pointed at a live drive (_recastFeed ran first).
  _castLostDrive (drive, reason) {
    const c = this._cast
    if (!c || !drive || c.drive !== drive) return false
    c.drive = null
    this._endCast(reason)
    return true
  }

  // Remove the rotation's cache placeholder — but only if it is still the entry under that
  // key. A teardown (stop/_purgeAndRebuild clears _feeds) or another caller can have put a
  // REAL open there in the meantime, and an unconditional delete would evict a live feed
  // nobody asked about.
  _dropPlaceholder (cacheKey, placeholder) {
    if (this._feeds.get(cacheKey) === placeholder) this._feeds.delete(cacheKey)
  }

  // A feed that finished opening after a teardown, on either of the two paths that can reach
  // one (the rotation's post-reopen epoch check and its recovery's). Nothing else will ever
  // close it — _closeFeeds ran before this cache entry existed — and CLOSE is the only safe
  // verb: purge deletes storage BY PATH, and after a _purgeAndRebuild those paths belong to
  // the store the rebuild just created.
  //
  // The DISCOVERY goes with it, which neither branch used to do: _openFeed joins the topic,
  // so abandoning the drive alone leaked one swarm session per teardown-during-rotation — in
  // the very function whose step 6 exists to stop the rotation leaking exactly that.
  // Destroy a swarm session whose drive is gone — but not before its REPLACEMENT join has
  // landed, when one is on its way. hyperswarm's join() returns a session on the topic's
  // shared PeerDiscovery, and PeerDiscovery only calls swarm.leave() when its session count
  // reaches zero, so retiring the old one after the new join takes the count 1 → 2 → 1: the
  // topic is never actually left and no unannounce or DHT round trip is paid. `opening` is
  // that replacement — pass the in-flight open and this waits for it, whatever the caller did
  // in the meantime and whether or not the caller is still running.
  //
  // Null `opening` means "nothing is replacing this", and then destroying at once is right:
  // the alternative is a joined topic with no drive behind it for the life of the process.
  // Never throws, and a re-open that was handed back the SAME session (an undestroyed
  // discovery answers join() with discovery.session()) is left alone.
  _retireDiscovery (discovery, opening = null) {
    if (!discovery) return
    const kill = (next) => {
      if (next && next.discovery === discovery) return
      try { const p = discovery.destroy(); if (p && p.catch) p.catch(() => {}) } catch {}
    }
    if (opening && opening.then) opening.then(kill, () => kill(null))
    else kill(null)
  }

  _abandonFeed (cacheKey, feed) {
    if (!feed || !feed.drive) return
    const q = this._feeds.get(cacheKey)
    if (q && q.settled === feed) this._feeds.delete(cacheKey)
    try { const p = feed.drive.close(); if (p && p.catch) p.catch(() => {}) } catch {}
    try { const p = feed.discovery && feed.discovery.destroy(); if (p && p.catch) p.catch(() => {}) } catch {}
  }

  // Recovery after a rotation failed with the old replica already purged. Fire-and-forget
  // and never throws. One bounded re-open (FEED_REOPEN_MS — not the park's budget: nothing
  // is parked any more, the gate was released when the rotation gave up), then the tune
  // watchdog as the last resort, which is what the failure path used to rely on ALONE.
  //
  // IT INHERITS STEP 4b's FRESH DIAL, and it has to: a purged replica cannot replicate over
  // the connection that was carrying it, so a recovery that re-opened into that connection
  // would hand back exactly the peerless drive the rotation would have. Nothing here needs to
  // repeat the hang-up — the rotation does it the instant the purge settles, which is upstream
  // of every way this function can be reached — but nothing here may re-establish one either,
  // and a future edit that moved it onto the rotation's success path would silently poison
  // this one.
  //
  // Every branch re-checks the teardown epoch and the active tune: this runs after the
  // rotation returned, so a stop(), a purge or a zap can land at any point in it, and
  // assigning _feedDrive on a stopped engine or for a channel the viewer has left is how a
  // dead drive gets served.
  //
  // THE COMMON FAILURE IS A SLOW RE-OPEN, NOT A DEAD ONE, so the single-flight cache is the
  // point of this path rather than an incidental: _openFeedWithin ADOPTS the open the rotation
  // left in flight with a longer bound instead of building a second Hyperdrive over a
  // namespace that one is already opening. That adoption used to be undermined by
  // _openFeedWithin's own expiry, which evicted (and so purged) the very open it had just
  // adopted; it cannot now, because the rotation's claim on that slot outlives the rotation —
  // see _claimSlot.
  //
  // Residual, stated: if this bound ALSO expires and the open lands afterwards, nothing here
  // publishes it. It stays in the cache as a warm, correctly-claimed entry, so a re-zap serves
  // it instantly and the tune ladder's retune picks it up once the claim lifts — a slower
  // recovery than this one, not a lost feed.
  _recoverFailedRotation (a, cacheKey, encKeyHex, epoch, err) {
    this.emit('status', { state: 'feed:rotate', streamId: a.streamId, failed: true, message: 'rotation failed: ' + ((err && err.message) || err) + ' — re-opening' })
    const feedKeyHex = cacheKey.slice(0, cacheKey.indexOf(':'))
    Promise.resolve()
      .then(() => this._openFeedWithin(feedKeyHex, encKeyHex, FEED_REOPEN_MS))
      .then((feed) => {
        if (this._epoch !== epoch) {
          this._abandonFeed(cacheKey, feed) // drive AND swarm session — see there
          return
        }
        if (this._active !== a) return
        if (feed && feed.drive) {
          this._recastFeed(a.streamId, cacheKey, feed.drive)
          // Only if nothing else has already taken the slot: a zap's serveFeed, a catalog
          // follow or a later rotation may have set a drive while this open was in flight,
          // and that one is the current truth.
          if (!this._feedDrive) {
            this._feedDrive = feed.drive
            this._feedDiscovery = feed.discovery
            a.lastSig = null
            a.lastAdvance = Date.now()
            this._peersLostAt = null
            this.emit('status', { state: 'feed:ready' })
          }
          if (this._tuneTimer) this._startTuneWatchdog() // the replica is empty — same reset as step 7
          return
        }
        // Still nothing. Say so (the first emit promised a re-open; silence here would make
        // the breadcrumb ring lie) and hand recovery to the ladder that owns it: the tune
        // watchdog in p2p-only mode, the hybrid stall watchdog otherwise — the latter needs
        // no arming and already treats a null _feedDrive as a stalled playlist, which is its
        // trigger for falling back to the CDN.
        this.emit('status', { state: 'feed:rotate', streamId: a.streamId, failed: true, message: 'rotation recovery failed: the replica did not re-open — falling back to the tune ladder' })
        if (!this._tuneTimer) this._startTuneWatchdog()
      })
      .catch(() => {})
  }

  // The park gate — and ONLY the park gate. It used to double as the rotation's
  // single-flight guard, which is why four unrelated callers releasing it was a correctness
  // bug and not just a naming problem; the mutex is _feedRotate now (see the constructor and
  // the top of _rotateActiveFeed), and this field is free to be released by anyone whose
  // business is "stop parking requests": the timer below, serveFeed() on a zap, stop() and
  // _purgeAndRebuild().
  //
  // ONE timer for the whole rotation rather than one per parked request: the bound is a
  // property of the swap, not of any request, and this way a request that arrives late waits
  // only for what is left of the budget. Releasing it clears _feedSwap, so the very next
  // request takes the ordinary synchronous path.
  //
  // The timer is USUALLY a backstop rather than the normal exit — and the stronger claim
  // that used to stand here ("in every failure it can see, the rotation's finally is what
  // wakes the parked requests; the timer only covers a drive.purge() that never settles") was
  // overstated, so it is corrected rather than quietly dropped. Two things end the park:
  //
  //   the rotation's finally, in every case where the reopen's own bound is what is LEFT of
  //   this budget — the common one; and
  //
  //   this timer, in every case where the purge alone took more than
  //   FEED_SWAP_PARK_MS - FEED_REOPEN_FLOOR_MS. Past that the reopen is bounded by the FLOOR,
  //   which runs past park expiry: the timer fires, the parked requests wake to a null
  //   _feedDrive and 404, and the reopen then succeeds — so the rotation reports success and
  //   the lost park is not reported anywhere. See FEED_REOPEN_FLOOR_MS, which carries the
  //   arithmetic and why the floor stays. On 32-bit Android with a slow unlink that is
  //   uncommon but routine over a multi-hour session.
  //
  // (The rotation's longest await is drive.purge(), which nothing may proceed without —
  // reopening a namespace whose delete is in flight is the deadlock the single-flight cache
  // exists to prevent. This timer is what covers the viewer for it. FEED_PURGE_MS covers the
  // ENGINE for it, and only in the pathological case: it is a watchdog on a purge that never
  // settles at all, an order of magnitude past this park, and it abandons the rotation rather
  // than releasing it to carry on.)
  //
  // A swap NEVER rejects and always releases — the rotation's finally, this timer, or a
  // zap landing in serveFeed, whichever comes first. Leaving one armed would park every
  // media request for the rest of the session, which is far worse than the 404 it exists
  // to avoid.
  _armFeedSwap () {
    let release = null
    const done = new Promise((resolve) => { release = resolve })
    const swap = { done, release, timer: null, startedAt: Date.now() }
    swap.timer = setTimeout(() => this._releaseFeedSwap(swap), FEED_SWAP_PARK_MS)
    swap.timer.unref?.() // a rotation must never hold a host process open
    this._feedSwap = swap
    return swap
  }

  // Idempotent, and identity-checked so a late timer cannot clear a NEWER swap.
  _releaseFeedSwap (swap) {
    if (!swap) return
    if (swap.timer) { clearTimeout(swap.timer); swap.timer = null }
    if (this._feedSwap === swap) this._feedSwap = null
    swap.release()
  }

  // The serving core's over-budget hook (see _requestHandler): it measured the drive it is
  // serving and the replica is past _feedBudgetBytes. Only the ACTIVE tune rotates — a
  // cached feed nobody is serving is the byte cap's business (_trimFeedBytes), and an
  // identity check is what keeps the two from acting on each other's drives.
  //
  // Fires repeatedly by construction (once per throttled reclaim pass while the replica is
  // over budget), which is what makes _rotateActiveFeed's mutex load-bearing rather than
  // theoretical: during a rotation _feedDrive is null, so this returns at the line below —
  // but the instant the new drive is published, another over-budget callback for the OLD
  // drive can still be in flight, and the mutex is what refuses it.
  _onFeedOverBudget (drive, info) {
    const a = this._active
    if (!a || !drive || drive !== this._feedDrive) return
    this._rotateActiveFeed(a, info).catch(() => {}) // never throws; the catch is belt and braces
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
    // ⚠ THE _storeDown INVARIANT IS ENFORCED HERE, and here is the ONE place it can be
    // enforced completely: this is the only function that builds a Corestore and a Hyperswarm,
    // and every path that wants either arrives through it. It used to be checked in _openFeed
    // alone, which left the other four callers (prewarm, the two sign-in rendezvous paths,
    // _openPanel) able to create a fresh store in a directory _purgeAndRebuild was about to
    // rmSync, or join a topic on a swarm stop() had destroyed.
    //
    // IN FRONT OF THE EARLY RETURN, not after it: between _purgeAndRebuild setting the flag
    // and its `this._store = null`, the OLD store is still hanging on this object, and handing
    // it out is handing out a store whose directory is about to be deleted.
    //
    // A FLAG RATHER THAN AN EPOCH COMPARISON, on purpose: a corruption purge bumps the epoch
    // ITSELF, so `this._epoch !== captured` would also refuse the retry _recover fires after
    // the rebuild — it would break the self-heal it is standing next to. See the field's
    // declaration for the full invariant.
    if (this._storeDown) throw new Error('the store is being torn down')
    if (this._store) return
    // ONE bounded cache budget shared by every bee this store opens (panel catalog +
    // each feed's metadata bee — feeds/assets are namespaced off this store, so the
    // budget flows to all of them). Without it each hyperbee keeps per-instance caches
    // keyed by the ever-growing seq — ~1.5 KB of heap retained per replicated append,
    // forever: a viewer replicates ~2700 appends/h per watched channel, so a long TV
    // session leaks ~4 MB/h (same leak the broadcaster fixed in channel.js). Rache
    // evicts randomly; a re-read of an evicted node is a cheap replica-store hit.
    // Recreated per store (not per player) so a corruption purge drops it with the store.
    this._mark('store-open')
    this._store = new Corestore(this._storeDir, { globalCache: new Rache({ maxSize: 4096 }) })
    await this._store.ready()
    this._mark('store-ready') // disk-bound: grows with the store, nothing GCs it at boot
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
    this._mark('swarm-ready') // includes the awaited dht.ready() (UDP bind + DHT bootstrap)
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
      if (!this._bootSocketSeen) { this._bootSocketSeen = true; this._mark('first-socket') }
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
    const arm = (how) => {
      if (this._call || socket.destroyed) return
      this._call = call
      if (remoteKey) this._panelPeerKey = remoteKey
      this._mark('rpc-armed', how)
      socket.on('close', () => { if (this._call === call) this._call = null })
    }
    if (remoteKey && remoteKey === this._panelPeerKey) return arm('remembered')
    ;(async () => {
      try {
        const res = await Promise.race([
          call('hello'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('rpc probe timeout')), this._rpcProbeMs).unref?.())
        ])
        if (res && typeof res.challenge === 'string') arm('probed')
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
    this._mark('panel-topic-joined')
    this._watchCatalog()
    this._watchEpgKey()
    this._watchGrants() // no-op before the first login; re-arms the grant watch after a purge
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

  // Live entitlement refresh (S57): watch this viewer's OWN `user/<name>` record and
  // follow its `wrapped` grant map, so channels granted mid-session appear without a
  // re-login. Armed from _doLogin (first login) and from _openPanel (re-arm after a
  // corruption purge rebuilds the bee); a no-op until a login has set _username.
  //
  // WHY THIS IS NOT SELF-GRANTING. The record lives in the panel-signed hyperbee the
  // client merely REPLICATES: every append carries the panel's signature, the client
  // holds no writer key, and a forged `wrapped` entry cannot be appended. This is the
  // exact record — and the exact field — login() already derives its grants from
  // (sdk/login.js reads salt/verifier/encPriv/wrapped straight out of it; the RPC only
  // supplies the OPRF evaluation and the session token). Following it live therefore
  // reads the panel's SIGNED statement of entitlement, not a client assertion.
  //
  // Cheap by construction: the panel writes `user/<name>` essentially only when that
  // user's grant set CHANGES (panel/src/sources.js reconcileGrants puts under
  // `if (dirty)`, deleteStream only for users that held the grant). A half-hourly source
  // sync over an unchanged playlist re-puts catalog records but touches no user record,
  // so this watcher stays silent through exactly the churn that wakes _watchCatalog.
  // A few paths do re-put the record with an UNCHANGED id set (set-password, status and
  // device edits, package provenance migration) — those cost one wasted record read and
  // push nothing, because the refresh below finds no delta.
  _watchGrants () {
    if (!this._panelBee || !this._username) return
    const prev = this._grantWatcher; this._grantWatcher = null
    // .catch, not try/catch: close() returns a promise, so a synchronous try around a
    // non-awaited call catches nothing and a rejection would surface as an UNHANDLED
    // rejection — which is what aborts the Bare worklet (the S22 crash class).
    if (prev) prev.close().catch(() => {}) // re-login/re-arm: never leave two watchers on one bee
    const key = 'user/' + this._username
    const watcher = this._panelBee.watch({ gte: key, lte: key }) // one record, not a range
    this._grantWatcher = watcher
    ;(async () => {
      try {
        // Catch up FIRST. A hyperbee watcher only reports appends made after it starts,
        // so every arming point has a blind window behind it: a corruption purge rebuilds
        // the replica from scratch, and a client that was disconnected (backgrounded
        // phone, dead panel socket) misses whatever landed meanwhile. Usually free at
        // login: it re-reads the record login() just used, so nothing differs. Not
        // ALWAYS free — sdk/login.js builds its projection under `if (enc && cat)`, so a
        // granted id whose catalog record was momentarily unreadable is absent from
        // _entitled while present in `wrapped`, and this catch-up (and every later one)
        // re-reads that id's catalog record. That is the intended repair, not waste.
        //
        // NOT wrapped in _recover, unlike the loop below. A purge re-runs _openPanel,
        // which re-arms this watcher, which would catch up again — so recovering HERE
        // could spin purge→arm→fail→purge on a persistently bad replica. A failed
        // catch-up is cheap to lose: the next append to the record re-runs it, and real
        // corruption is still found (and purged) by _watchCatalog and resolve().
        try { await this._refreshEntitlements() } catch {}
        for await (const _ of watcher) { // eslint-disable-line no-unused-vars
          if (this._grantWatcher !== watcher) return // superseded by purge/stop/re-login
          await this._recover(() => this._refreshEntitlements())
        }
      } catch (err) {
        // The bee closing underneath us (stop/purge) ends the watcher — not an error.
        if (this._grantWatcher === watcher && !this._purging) this.emit('error', err)
      }
    })()
  }

  // Re-derive _entitled from the replicated user record and re-emit the display list.
  //
  // ADMITS only REDIRECT channels (`redirect:true` + `url`). That asymmetry is the whole
  // security argument. A redirect channel's url+headers sit in CLEARTEXT in the same
  // replicated catalog, so its entitlement is already an authorization check the client
  // performs in resolve() — admitting one on the strength of a signed `wrapped[id]` is
  // exactly as strong as what login does today. A P2P channel's key is sealTo(user.pub,
  // secret) and needs the account private key to open; that key is derived from the
  // password inside login() and deliberately NOT retained by the engine, so a newly
  // granted P2P stream still waits for the next login — the same boundary a re-KEYED
  // stream already sits behind (see resolve()). Entries land with encryptionKey:null,
  // which every P2P path in this file already treats as "nothing to open" (prewarm,
  // _warmNeighbor, _retuneActive, _thumbTarget, _maybeReresolveActiveFeed, the replica
  // sweep) — the null is inert by construction, not by new guards.
  //
  // REMOVES ids the panel has revoked, so a revoked channel can no longer be resolve()d.
  // It deliberately does NOT touch this._active: revoke() + the package reconcile that
  // follows it are TWO puts, and the intermediate one is grant-less — tearing down
  // playback there would yank a viewer mid-watch over a state that exists for
  // milliseconds. An already-resolved play runs to its end, which matches the posture
  // panel/src/ops.js revoke() already documents (a client may have cached the key;
  // real revocation of live content is a stream-key rotation).
  async _refreshEntitlements () {
    const who = this._username
    if (!this._panelBee || !who) return
    const node = await this._panelBee.get('user/' + who)
    // A momentarily unreadable record (or a deleted account) must not silently empty
    // the lineup — leave the last known entitlement standing and wait for the next tick.
    if (!node || !node.value || !node.value.wrapped) return
    // A login (re-login, or a switch to another account) ran while that get was in
    // flight: _doLogin nulls _username before it rebuilds _entitled precisely so this
    // check can fire. Without it a refresh started for the PREVIOUS user would write
    // that user's grants into the incoming session's freshly cleared map.
    if (this._username !== who) return
    const wrapped = node.value.wrapped
    const granted = (id) => Object.prototype.hasOwnProperty.call(wrapped, id) // ids may be 'constructor' etc. — NAME_RE allows it
    let changed = false
    // Removal is SYMMETRIC with admission below: only entries this method could put
    // back may be taken away. Dropping a P2P entry would be a one-way door — the admit
    // loop cannot re-seal one without the account key — and the panel's ORDINARY revoke
    // path walks straight through that door: panel/src/admin-server.js and admin-cli.js
    // both call ops.revoke() and THEN reconcilePackages(), two separate puts, and the
    // intermediate record is grant-less. A viewer watching a package-covered P2P channel
    // would lose it for the rest of the session even though the panel's end state still
    // grants it. So P2P entitlement stays login-scoped in BOTH directions, exactly as it
    // was before live refresh existed; redirect channels, which we can always re-admit
    // from the catalog, follow the record live.
    for (const [id, k] of this._entitled) {
      if (granted(id) || k.redirect !== true) continue
      this._entitled.delete(id)
      this._feedKeyLive.delete(id) // its lifetime is exactly _entitled's (see the constructor)
      changed = true
    }
    for (const id of Object.keys(wrapped)) {
      if (this._entitled.has(id)) continue
      const cat = await this._panelBee.get('catalog/' + id)
      // Re-checked EVERY iteration, not once before the loop: _doLogin's teardown +
      // rebuild is synchronous, so an account switch can complete in full between two
      // turns of this loop. Without this, a refresh that began for the previous user
      // would write THAT user's redirect channels — url and provider headers included —
      // into the incoming user's freshly built map.
      if (this._username !== who) return
      const v = cat && cat.value
      // Panel write ORDER is load-bearing here: applyFeed puts catalog/<id> before
      // reconcileGrants writes user/<name>, so a granted id always has its record. If a
      // future panel path ever granted first, this skip would hold until the NEXT append
      // to user/<name> — which for a stable account can be days.
      if (!v || v.redirect !== true || !v.url) continue // P2P (or not yet cataloged): next login
      this._entitled.set(id, { feedKey: null, encryptionKey: null, redirect: true, url: v.url, headers: v.headers ?? null, type: v.type ?? null, durationSec: v.durationSec ?? null })
      changed = true
    }
    if (changed && this._username === who) await this._pushCatalog()
  }

  // Rebuild the display list for the current session from the latest replicated
  // catalog records and emit it. Display-only for P2P: the sealed stream keys in
  // _entitled come from the user record at login and are not touched here — a stream
  // whose feed was re-keyed (new feedKey in the catalog) needs a fresh login to unseal
  // anyway. Which STREAMS are in the map is now maintained live by _refreshEntitlements.
  //
  // Coalesced: _watchCatalog and _watchGrants both land here, and one source sync fires
  // both. Each call costs one bee get per entitled stream (~126 on a live events
  // lineup), so a burst of appends must collapse into ONE rebuild instead of queueing a
  // full sweep per append. Leading-edge plus ONE trailing re-run: a call that arrives
  // mid-rebuild may describe state the in-flight sweep already read past, so it sets the
  // flag and the loop sweeps once more — any number of arrivals collapse into that
  // single extra pass. Callers await the whole thing, trailing pass included.
  //
  // BOUNDED, and that is not optional once the promise is shared. _doPushCatalog does an
  // unbounded bee.get per entitled stream, and on a sparse replica whose panel socket has
  // died a get can park forever — the same hazard _currentChannel races a timer for. Left
  // unbounded here, ONE hung sweep would never settle _pushPending, so every later call
  // would be handed that dead promise and BOTH watchers would park for the life of the
  // process, silently and with no error. A timed-out sweep is abandoned WITHOUT emitting:
  // a truncated lineup would read as "these channels are gone", so the previous list
  // stands and the next append retries.
  _pushCatalog () {
    if (this._pushPending) { this._pushAgain = true; return this._pushPending }
    const run = async () => {
      do {
        this._pushAgain = false
        let timer
        try {
          await Promise.race([
            this._doPushCatalog(),
            new Promise((resolve) => { timer = setTimeout(resolve, this._pushTimeoutMs) })
          ])
        } finally { clearTimeout(timer) }
      } while (this._pushAgain)
    }
    this._pushPending = run().finally(() => { this._pushPending = null; this._pushAgain = false })
    return this._pushPending
  }

  async _doPushCatalog () {
    // Gate on the LOGIN, not on _entitled.size — the comment above this method has always
    // said "once a login has established what the user is entitled to see", and with
    // grants now revocable mid-session an emptied map is a real lineup that the host
    // must be told about, not a pre-login state to suppress.
    if (!this._username || !this._panelBee) return
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
    // The catalog can rotate a channel BACK onto a feedKey this session already purged
    // (a broadcaster flipping between sources, a key the viewer watched and the LRU
    // trimmed), and this path serves it without ever passing through serveFeed.
    this._healPurgedFeed(feedKey)
    // …AND THE CACHE KEY THAT NAMES IT. This line was missing, and it was not cosmetic:
    // _activeFeedKey is what every disk path uses to mean "never touch the feed being
    // watched" (_trimFeeds, _sweepIdleFeeds, _trimFeedBytes), and it is assigned in exactly
    // one other place — serveFeed(). So after ANY broadcaster feedKey rotation the guard
    // named a feed that no longer exists, the drive actually being served was unprotected,
    // and _trimFeedBytes would hand it to _evictFeed, which purges the replica out from
    // under the viewer. (The disk paths grew drive-identity checks as well; this is the
    // root cause those checks are the belt to.)
    this._activeFeedKey = feedKey + ':' + keys.encryptionKey
    // A cast on this channel follows the rotation too: the OLD feedKey is dead (the
    // broadcaster restarted onto a new one), so a pin left behind would serve a feed that
    // never advances again.
    this._recastFeed(a.streamId, feedKey + ':' + keys.encryptionKey, feed.drive)
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
    // The store directory is about to be deleted and rebuilt, so every piece of in-flight
    // work that holds a drive, a namespace or a cache key from the OLD store is invalid from
    // here. A rotation is the sharp case: past its drain it would re-open through
    // _ensureStore() and leave the rebuilt engine sharing a store rooted in a directory this
    // function just rmSync'd. Bumping the epoch is what makes it abandon at its next await —
    // but only at an await it actually reaches, so the store-building path is refused up
    // front instead (see _openFeed and the _storeDown invariant).
    this._epoch++
    // The generation THIS purge owns. Everything below re-reads it before touching shared
    // teardown state, because a purge is not the only teardown and it is not the last word:
    // see the _storeDown line near the end.
    const gen = this._epoch
    this._storeDown = true
    // …and release the rotation mutex, for the reason stop() states at greater length: the
    // rotation's finally sits behind an unbounded drive.purge(), and the rmSync below is the
    // most likely thing in this file to leave one pending forever. A mutex never cleared is
    // rotation switched off for the life of the process.
    this._feedRotate = null
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    // The maintenance tick measures and purges feeds on a store that is about to be
    // deleted out from under it; the next play re-arms it on the rebuilt one. Same for a
    // rotation's park gate: the drive it was waiting for is not coming.
    this._stopFeedMaintenance()
    if (this._feedSwap) this._releaseFeedSwap(this._feedSwap)
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} } // corrupt bees may refuse; bee close below retries
    const grantWatcher = this._grantWatcher; this._grantWatcher = null
    if (grantWatcher) { try { await grantWatcher.close() } catch {} } // _openPanel below re-arms it (_username survives the purge)
    this._zapRanges.clear() // warm ranges die with their (closing) cores; the prefetch loop re-warms on the fresh store
    // A cast session's pinned drive is one of the feeds about to be closed, so the session
    // is over whatever happens — end it honestly (socket down, URL dead) instead of
    // leaving a receiver pointed at a handler that would 500 on a closed drive. Not
    // awaited: _purgeAndRebuild is on the recovery path and must not park on a socket.
    this.stopCast().catch(() => {})
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
    // The delete is done; from here this function is REBUILDING, and everything below (and
    // the _recover retry that called us) must be allowed to open on the fresh store. Nothing
    // between the flag going up and this line can throw — every step is wrapped — so the
    // engine cannot be left refusing to open feeds forever.
    //
    // ⚠ ONLY IF THIS PURGE STILL OWNS THE FLAG. _storeDown has two writers with opposite
    // lifetimes: stop() sets it TERMINALLY and by design never clears it, while this function
    // sets and clears it. Clearing unconditionally meant a purge parked on `await s.destroy()`
    // or a `c.close()` above could let stop() run to completion underneath it and then, on
    // resuming, re-open the door stop() had just shut — _ensureStore() building a fresh
    // Corestore and Hyperswarm, re-creating the directory this function had rmSync'd, and
    // joining the panel topic AFTER stop() returned. The epoch is what tells the two apart
    // (stop() bumps it too, and _recover's retry sees the fresh store either way), so the
    // rebuild below is CLAIMED rather than assumed. If it moved, there is nothing to rebuild:
    // stop() is terminal and the engine is finished.
    if (this._epoch !== gen) return
    this._storeDown = false
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
      remoteSecret: this._remote.control,
      // Boot trace: sdk/login.js reports each protocol phase's cost through here.
      trace: (name, ms, extra) => this._mark('login:' + name, ms + 'ms' + (extra ? ' ' + extra : ''))
    }
  }

  // Ask hyperswarm to look the panel topic up again, at most every PANEL_REFRESH_MIN_MS.
  // Without this, a topic joined before the panel announced (or across its restart) waits
  // on hyperswarm's own periodic refresh — TEN MINUTES plus jitter — which is the
  // measured "minutes on the login screen" worst case. docs/kb/bare-worklet.md prescribes
  // exactly this kick-on-poll. Returns false when connect() never joined the topic —
  // genuinely offline, nothing can re-arm.
  _kickPanelDiscovery () {
    if (!this._panelDiscovery) return false
    const now = Date.now()
    if (now - this._panelRefreshAt >= PANEL_REFRESH_MIN_MS) {
      this._panelRefreshAt = now
      try { this._panelDiscovery.refresh({ client: true, server: false }) } catch {}
    }
    return true
  }

  // The two login doors' shared RPC gate: where they used to throw 'not connected to
  // panel' the instant `_call` was unarmed, they now kick the discovery and wait a
  // BOUNDED moment for the socket + hello probe to land — on the measured boot the RPC
  // arms at ~5 s and the old instant-throw handed the viewer to a 2.5 s retry tick that
  // burned 2.4 more. Waiting here is free by construction: the panel's lockout counts
  // only attempts that reach it, and this throws before any RPC leaves the device. The
  // error string is byte-identical to the old one on purpose — the screens' TRANSIENT
  // regexes, the worklet's NOT_CONNECTED match and the resume-cost refund all key on it.
  async _awaitPanelRpc () {
    if (this._call) return
    if (!this._kickPanelDiscovery()) throw new Error('not connected to panel')
    const t0 = Date.now()
    const ok = await this._waitUntil(() => this._call, this._loginRpcWaitMs)
    this._mark('login-rpc-wait', (Date.now() - t0) + 'ms ' + (ok ? 'armed' : 'gave up'))
    if (!ok) throw new Error('not connected to panel')
  }

  async _doLogin (username, password) {
    this._mark('login-attempt', this._call ? 'password' : 'password no-rpc')
    await this._awaitPanelRpc()
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
    this._mark('login-attempt', this._call ? 'keys' : 'keys no-rpc')
    await this._awaitPanelRpc()
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
    this._mark('assets-open')
    await this._openAssets()
    this._mark('assets-ready')
    this._openEpg().catch(() => {}) // the guide is never allowed to delay (or fail) a login
    const port = await this._ensureServer() // posters must be loadable before anything plays
    this._mark('server-ready')
    // Stand the live-entitlement machinery down for the rebuild below. Deliberately here
    // and not at the top of _doLogin: a REJECTED login (wrong password) must not clobber
    // the session already running, so nothing may be torn down until oprfLogin has
    // returned. From here to the _watchGrants() at the end, _username is null — which
    // blocks both _refreshEntitlements and _doPushCatalog, so no half-built lineup can
    // be emitted and no stale refresh can write into the map being rebuilt.
    this._username = null
    const grantWatcher = this._grantWatcher; this._grantWatcher = null
    if (grantWatcher) grantWatcher.close().catch(() => {}) // fire-and-forget (see _watchGrants on why .catch)
    this._entitled.clear()
    // _feedKeyLive AUGMENTS _entitled (same streamId keys, fresher feedKey), so it must
    // die with it. A re-login or a user switch can hand the SAME streamId a different
    // channel — a stale entry here would then out-vote the new snapshot's feedKey and
    // point /feedthumb at the previous session's feed for the rest of the session.
    this._feedKeyLive.clear()
    const display = streams.map((s) => {
      this._entitled.set(s.id, { feedKey: s.feedKey, encryptionKey: s.encryptionKey, redirect: s.redirect === true, url: s.url ?? null, headers: s.headers ?? null, type: s.type ?? null, durationSec: s.durationSec ?? null })
      return this._display(port, s.id, s)
    })
    // Set only AFTER the snapshot is rebuilt: _username is what unblocks _pushCatalog,
    // and a catalog append landing mid-login must not push a half-built lineup. Arming
    // the grant watch last, on the finished map, keeps its first catch-up a no-op.
    this._username = username
    this._watchGrants()
    return display
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

  // Resolve /feedthumb/<streamId> against the feed cache. SYNCHRONOUS — and now by
  // CHOICE, not by contract: createDriveHandler awaits resolveTarget (the media branch
  // parks on it while the active feed rotates, see _mediaTarget), so this route could
  // wait and deliberately does not. That is what makes every rule below a "serve it now
  // or 404" decision instead of a wait, and it is the right answer for a grid cell:
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

  // The ACTIVE feed as a serving target, or null. Split out of the resolver below because
  // two paths now reach it — a request that arrives while nothing is happening, and one
  // that PARKED through a rotation and is asking again on the other side.
  //
  // Cast-pinned feed: opt this target out of the expired-block reclaim. The phone is
  // expected to stop local playback while it casts (so these serves should not happen at
  // all), but nothing in the engine ENFORCES that — a host that keeps the phone playing
  // the cast channel would otherwise free, from under the receiver, the one remaining copy
  // of every block below the live window. Decided here, with the exact drive in hand,
  // because the handler awaits before reclaiming and a zap can swap _feedDrive in that
  // window. (A cast-pinned feed is never ROTATED either — _rotateActiveFeed refuses — so
  // the two disk paths agree about the pin.)
  _mediaTarget (p) {
    if (!this._feedDrive) return null
    const pinned = this._cast && this._cast.drive === this._feedDrive
    return { drive: this._feedDrive, path: p, media: true, ...(pinned ? { reclaim: false } : {}) }
  }

  // Request handler for HLS players (and poster art): the shared progressive
  // serving core (sdk/serve.js) — availability wait, block-progressive bodies with
  // Range support, live-edge read-ahead, abort tolerance (a player aborts requests
  // routinely, and an unhandled stream error SIGABRTs the Bare worklet). Targets
  // resolve PER REQUEST so a retune/rotation swaps the served feed live.
  //
  // The handler object is KEPT (_handler): createDriveHandler hangs its per-drive
  // read accounting on the returned function — inflight(drive) and
  // whenDrained(drive, ms) — and the rotation has to drain a drive before it unlinks it.
  _requestHandler () {
    const handler = createDriveHandler((p) => {
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
      // /cast/* belongs to the LAN server and ONLY to it. Refusing it here keeps the two
      // surfaces from quietly becoming one: nothing about holding a token should make the
      // loopback server answer differently, and a bug that pointed a receiver at 127.0.0.1
      // must fail loudly instead of half-working.
      if (p.startsWith(CAST_PREFIX)) return null
      // MEDIA — the only branch that may WAIT. While the active feed rotates (its replica
      // is purged and re-opened, see _rotateActiveFeed) there is deliberately no drive to
      // resolve, and the serving core turns a null target into an INSTANT 404: no
      // availability wait, no peer lookup, just "not found". ExoPlayer answers that with 3
      // retries, an onError and a remount 2.5 s later — ≈5.5 s of black screen for a swap
      // that takes a few hundred ms. So park instead: return a promise that resolves once
      // the rotation releases (or its bound expires — see FEED_SWAP_PARK_MS), and resolve
      // the target THEN.
      //
      // ⚠ AN EXPIRED PARK IS WORSE THAN NOT PARKING, by the length of the park. The claim
      // that used to close this paragraph — "the park expiring falls back to null, i.e. to
      // exactly today's behavior, so this is never worse than not parking" — is false: the
      // fallback value is the same, but it arrives FEED_SWAP_PARK_MS later, which moves the
      // player's whole recovery ladder along with it (404 at t=PARK, remount at PARK+5.5 s,
      // instead of t≈0 and 5.5 s). FEED_SWAP_PARK_MS carries the full arithmetic and the
      // three structural changes that keep the downside small; what matters here is only
      // that this branch is a bet with a real cost when it is lost, not a free improvement.
      //
      // The parked branch re-reads _feedDrive rather than closing over the swap's result:
      // a zap can land mid-rotation, and the drive a request should be served from is
      // whatever is active when it wakes, not whatever the rotation ended up opening.
      const swap = this._feedSwap
      if (swap) return swap.done.then(() => this._mediaTarget(p))
      return this._mediaTarget(p)
    }, {
      // Churn headroom: replicate the ACTIVE stream's whole live window on-device
      // (not just the newest 3 segments), so an upstream peer's death cannot take
      // away media between the playhead and the live edge — the player's live
      // offset becomes the survival budget. Re-evaluated per playlist serve: on a
      // metered network the burst cost of a zap (one window × bitrate) is real
      // money, so fall back to the serve-core default there.
      liveReadAhead: () => (this._netExpensive ? 3 : Infinity),
      // Disk bound (the flip side of the full-window read-ahead above): clear the blob
      // blocks below the live window as playlists serve. Nothing that could have been
      // served is lost — the cleared blocks are already unfetchable swarm-wide, because
      // the broadcaster cleared them at rotation. Feed target only (media: true) and live
      // playlists only; VOD is never reclaimed (see the Reclaim class in serve.js).
      //
      // ⚠ THIS IS NOT A DISK BOUND ON EVERY PLATFORM, and the claim that used to stand
      // here — that the viewer's disk "holds ~one live window per feed instead of growing
      // ~1× bitrate forever (≈0.9 GB/hour at 2 Mbps)", "safe by construction" — was the
      // load-bearing wrong sentence in this file. It is true exactly where the platform
      // can hole-punch a storage file. On 32-bit Android ABIs the `fs-native-extensions`
      // addon is excluded from the build, random-access-file's `_del` reports success and
      // frees ZERO bytes, and so clear() bounds the BITFIELD while the file keeps growing
      // at ~1× bitrate for the whole watch session. What bounds disk there is the byte
      // budget below plus rotation (unlink) — see the VIEWER DISK BUDGET note at the top
      // of this file. Reclaim stays on: where it works it is nearly free and it keeps the
      // rotation budget from being reached at all.
      reclaim: true,
      // The rotation trigger. The serving core measures the drive it is serving and calls
      // this when the replica crosses the budget; only the ACTIVE tune acts on it (see
      // _onFeedOverBudget), and a cast-pinned or VOD feed is refused inside the rotation.
      reclaimBudgetBytes: this._feedBudgetBytes,
      onOverBudget: (drive, info) => this._onFeedOverBudget(drive, info),
      // Corruption can also surface at read time (the blobs core opens lazily): heal
      // in the background; the host player's retry re-opens the feed on the fresh store.
      onError: (err) => { if (isCorruptionError(err)) this._purge().catch(() => {}) }
    })
    this._handler = handler
    return handler
  }
}
