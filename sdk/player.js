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
//   'cast' ({state,streamId,reason})  the cast session ENDED ON ITS OWN — state 'ended'.
//                        reason 'feed-evicted' (the tune ladder ran out and purged the
//                        pinned replica) | 'retune-abandoned' (a zap landed mid-retune
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
import { panelClient, login as oprfLogin } from './login.js'
import { isCorruptionError, withRecovery } from './recover.js'
import { createDriveHandler, playlistUris, reclaimBelowWindow, THUMB_PATH } from './serve.js'
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
function normalizePeer (addr) {
  if (typeof addr !== 'string' || !addr) return null
  let s = addr.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone > 0) s = s.slice(0, zone)
  if (s.startsWith('::ffff:') && isIPv4Literal(s.slice(7))) s = s.slice(7)
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
function normalizeReceivers (v) {
  if (v == null) return null
  const list = Array.isArray(v) ? v : [v]
  if (!list.length) return null
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

export class AliranPlayer extends Emitter {
  constructor ({ panelPubKey, storeDir = './aliran-store', http, fs, os, hybrid, prewarm, tune, zapPrefetch, swarm, uploadPolicy, deviceId, deviceLabel, appVersion, platform } = {}) {
    super()
    if (!http || !fs) throw new Error('AliranPlayer needs injected { http, fs } runtime modules (use index.js in Node)')
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
    this._server = null
    // --- cast to a TV (send-to-TV): the SECOND, LAN-scoped server ---
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
    // { username, token, expiresAt, deviceId } — the token is a panel-signed bearer
    // credential, so it lives in memory only and dies with stop().
    this._session = null
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
    const streams = await this._recover(() => this._doLogin(username, password))
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
   *                  0.0.0.0 bind, which is then the host's explicit choice.
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
   *                  every member's address or leave the pin off.
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
      // `host` is passed so the bind can be narrowed to it (see _startCastServer). The
      // handler needs no session handed to it: it resolves this._cast per request, and
      // this._cast is published below, after the bind — a socket that is listening but has
      // no session simply 404s everything, which is the correct answer for that instant.
      port = await this._startCastServer({
        readIdleMs: Number.isFinite(readIdleMs) && readIdleMs >= 0 ? readIdleMs : CAST_READ_IDLE_MS,
        reclaim: reclaim === true
      }, host)
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
    // outstanding, which is not worth an event) and permanently true on Bare, where a
    // close that did not settle DOES mean still bound — so the two runtimes land on the
    // right answer through the same expression.
    if (!closed && server.listening !== false) {
      this.emit('error', new Error(`cast server did not release its port within ${CAST_CLOSE_MS}ms — a wedged connection may be holding the LAN listener open`))
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
  // the only thing that can honour it, and it is a choice the caller made, not a default.
  async _startCastServer (handlerOpts, host) {
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
    const bind = this._bindAddress(host)
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
  _bindAddress (host) {
    if (!isIPv4Literal(host)) return '0.0.0.0' // a hostname or an IPv6 literal — not ours to bind
    let ifaces = null
    try { ifaces = this._os && this._os.networkInterfaces() } catch {}
    if (!ifaces) return host.startsWith('127.') ? host : '0.0.0.0'
    for (const list of Object.values(ifaces)) {
      for (const a of list || []) {
        if (a && a.address === host) return host
      }
    }
    return host.startsWith('127.') ? host : '0.0.0.0'
  }

  // Cast request handler: a SECOND createDriveHandler instance whose resolveTarget serves
  // only /cast/<token>/… off the pinned drive. Everything else — /assets/*, /epg/*,
  // /feedthumb/*, a bare /index.m3u8, a stale token, a request after stopCast() — is null,
  // which the serving core answers 404. Synchronous by contract, like _thumbTarget.
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
      // …nor the feed a cast session pinned. Eviction PURGES the replica's storage, so
      // browsing far enough while a TV plays would delete the drive out from under the
      // receiver — and the phone's own zapping is exactly what fills the cache.
      if (key === this._castFeedKey) continue
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
    this._active = null
    this._zapDir = 0
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    await this.stopCast() // the LAN socket must not outlive the engine that fed it
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
    // Full teardown is the ONE place the session token dies (a purge and a socket drop
    // both keep it — see _doLogin). A service switch replaces the engine wholesale, so
    // this is also what stops a token following a viewer to another operator's panel.
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
    const feed = await this._openFeed(a.feedKey, keys.encryptionKey)
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
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    const watcher = this._catalogWatcher; this._catalogWatcher = null
    if (watcher) { try { await watcher.close() } catch {} } // corrupt bees may refuse; bee close below retries
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
    if (this._panelKey) {
      await this._openPanel()
      this._openAssets().catch(() => {}) // posters re-replicate in the background once the panel reconnects
      this._openEpg().catch(() => {}) // so does the guide
    }
  }

  async _doLogin (username, password) {
    if (!this._call) throw new Error('not connected to panel')
    const res = await oprfLogin(this._call, this._panelBee, username, password, { deviceId: this._deviceId || undefined, deviceLabel: this._deviceLabel || undefined })
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
    this._session = res.token ? { username, token: res.token, expiresAt: res.expiresAt ?? null, deviceId: res.deviceId ?? null } : null
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
      // /cast/* belongs to the LAN server and ONLY to it. Refusing it here keeps the two
      // surfaces from quietly becoming one: nothing about holding a token should make the
      // loopback server answer differently, and a bug that pointed a receiver at 127.0.0.1
      // must fail loudly instead of half-working.
      if (p.startsWith(CAST_PREFIX)) return null
      if (!this._feedDrive) return null
      // Cast-pinned feed: opt this target out of the expired-block reclaim below. The
      // phone is expected to stop local playback while it casts (so these serves should
      // not happen at all), but nothing in the engine ENFORCES that — a host that keeps
      // the phone playing the cast channel would otherwise free, from under the receiver,
      // the one remaining copy of every block below the live window. Decided here, with
      // the exact drive in hand, because the handler awaits before reclaiming and a zap
      // can swap _feedDrive in that window.
      const pinned = this._cast && this._cast.drive === this._feedDrive
      return { drive: this._feedDrive, path: p, media: true, ...(pinned ? { reclaim: false } : {}) }
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
