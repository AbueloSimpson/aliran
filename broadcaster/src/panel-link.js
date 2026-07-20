// Broadcaster ⇄ panel registration link (S15b).
//
// Replaces the old per-channel panel Hyperswarm (one swarm per running channel) with a
// SINGLE manager-owned connection to the panel plus a per-stream, latest-state-wins op
// queue. Every registration flows through here: isLive:true on start, isLive:false on stop,
// and a boot-time catch-up that heals stale-live catalog entries left by an unclean crash.
//
// Why the ops are serialized: the panel's `register` responder keeps ONE challenge per
// socket — `hello` hands it out, `register` consumes and rotates it. Two hello→register
// pairs interleaved on the same socket would make the second register verify a signature
// over an already-rotated challenge and fail. The per-channel design sidestepped this by
// using a separate socket per channel; a shared socket must run its register cycles one at
// a time. So ops are delivered strictly sequentially over whichever live connection exists.
//
// Latest-state-wins: setDesired(streamId, payload) overwrites any queued state for that
// stream and bumps a sequence number. A stream is "pending" while deliveredSeq < seq, so a
// stop that supersedes an in-flight start simply wins — we never deliver stale state.

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { panelClient, registerWithPanel } from './register.js'
import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'

const HEARTBEAT_MS = 5 * 60 * 1000 // idempotent re-assert of running streams
const RETRY_MS = 2000 // after a delivery error, before the queue retries

// Terminal policy rejects (S26 per-publisher enrollment): the panel refused this
// exact payload by POLICY — unknown/revoked publisher name or a streamId outside
// the site's scopes. Retrying the same payload can never succeed, and the 2 s
// transient-retry loop would head-of-line-block every other stream's ops behind
// it (observed live: one out-of-scope boot catch-up starved a whole lineup's
// registrations). These ops are marked delivered-with-error instead: the error
// surfaces via lastError()/registerError, and the 5-min heartbeat re-asserts
// RUNNING streams, so an admin-side fix (scope edit / re-activate) heals within
// a heartbeat, no broadcaster restart. `unauthorized` (bad key) stays on the
// transient path — its pre-S26 retry semantics are unchanged.
export const TERMINAL_REJECT_RE = /\b(unknown-publisher|revoked|out-of-scope)\b/

// A restarted panel announces the topic under a BRAND-NEW swarm identity (its Hyperswarm
// keypair is ephemeral), and hyperswarm re-queries a client-mode topic only every ~10 min —
// so a lookup that resolved just before/during a panel restart strands queued ops behind a
// dead peer record (2026-07-16 VPS incident: 15+ min of registered:false, lastError:null,
// fixed only by restarting the broadcaster). While ops are pending with no socket we force
// discovery.refresh() ourselves on this backoff schedule.
export const RELOOKUP_MIN_MS = 5 * 1000
export const RELOOKUP_MAX_MS = 60 * 1000
// How long without a socket before status names the cause instead of a silent null.
export const NO_LINK_REPORT_MS = 10 * 1000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class PanelLink {
  constructor (config) {
    this.config = config
    this.enabled = !!(config.panelPubKey && config.publisherKey)
    this.publisherKey = config.publisherKey
    this.swarm = null
    this._sockets = new Map() // socket -> panelClient({ rpc, call }); one ProtomuxRPC per socket
    this._streams = new Map() // streamId -> { payload, seq, deliveredSeq, live, lastError }
    this._seq = 0
    this._processing = false
    this._retryTimer = null
    this._heartbeat = null
    this._closed = false
    this._discovery = null // PeerDiscoverySession from swarm.join — .refresh() re-queries the topic
    this._relookupTimer = null
    this._relookupDelay = RELOOKUP_MIN_MS
    this._disconnectedSince = null // timestamp while we hold no live socket; null when connected
  }

  // Join the panel's DHT topic (client-mode). Non-blocking: connections arrive later and
  // kick the queue. A no-op when the panel isn't configured (seed-only broadcaster).
  connect () {
    if (!this.enabled || this.swarm || this._closed) return
    const bootstrap = this.config.bootstrap && this.config.bootstrap.length ? this.config.bootstrap : undefined
    const swarm = new Hyperswarm({ bootstrap })
    this.swarm = swarm
    // Fire-and-forget: connect() is synchronous by design (connections arrive later and
    // kick the queue), and tuning must not gate the panel link coming up.
    tuneSwarm(swarm, { recvBytes: this.config.swarmRcvBuf, sendBytes: this.config.swarmSndBuf })
      .then((r) => logSwarmTuning(r, (line) => console.log('[net]', line)))
      .catch(() => {})
    swarm.on('connection', (socket) => this._onConnection(socket))
    this._discovery = swarm.join(crypto.hash(b4a.from(this.config.panelPubKey, 'hex')), { client: true, server: false })
    this._disconnectedSince = Date.now() // disconnected until the first connection lands
    this._heartbeat = setInterval(() => this._reassert(), HEARTBEAT_MS)
    if (this._heartbeat.unref) this._heartbeat.unref()
    this._process()
  }

  // ONE ProtomuxRPC per socket, reused for every (serialized) register cycle — the
  // panel replicates its store over the same muxed stream but we never answer that
  // channel; only the register RPC matters here (same as the old per-channel swarm).
  // `client` is injectable so unit tests can hand a late connection to the queue.
  _onConnection (socket, client = panelClient(socket)) {
    this._sockets.set(socket, client)
    socket.on('error', () => {})
    socket.on('close', () => {
      this._sockets.delete(socket)
      if (this._sockets.size === 0 && !this._closed) {
        this._disconnectedSince = Date.now()
        this._relookupDelay = RELOOKUP_MIN_MS
        if (this._nextPending()) this._armRelookup()
      }
    })
    this._disconnectedSince = null
    this._relookupDelay = RELOOKUP_MIN_MS
    if (this._relookupTimer) { clearTimeout(this._relookupTimer); this._relookupTimer = null }
    this._process()
  }

  // Record the latest desired registration state for a stream and kick delivery. Returns
  // the sequence number — pass it to flush() to await this exact state landing on the panel.
  setDesired (streamId, payload) {
    let st = this._streams.get(streamId)
    if (!st) { st = { payload: null, seq: 0, deliveredSeq: 0, live: false, lastError: null }; this._streams.set(streamId, st) }
    st.payload = payload
    st.seq = ++this._seq
    this._process()
    return st.seq
  }

  // Wait until `streamId`'s state at-or-after `seq` has been delivered, or timeout. Returns
  // true if it landed, false on timeout (callers proceed anyway — a stop must not hang).
  async flush (streamId, seq, timeoutMs = 5000) {
    if (!this.enabled || this._closed) return true
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const st = this._streams.get(streamId)
      if (!st || st.deliveredSeq >= seq) return true
      if (Date.now() >= deadline) return false
      await sleep(50)
    }
  }

  // Wait until every stream's latest desired state has been delivered, or timeout.
  async flushAll (timeoutMs = 5000) {
    if (!this.enabled || this._closed) return true
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let pending = false
      for (const st of this._streams.values()) if (st.deliveredSeq < st.seq) { pending = true; break }
      if (!pending) return true
      if (Date.now() >= deadline) return false
      await sleep(50)
    }
  }

  // True once the panel has accepted our latest state for this stream AND that state is live.
  isRegistered (streamId) {
    const st = this._streams.get(streamId)
    return !!(st && st.live && st.deliveredSeq >= st.seq)
  }

  lastError (streamId) {
    const st = this._streams.get(streamId)
    if (!st) return null
    // Undelivered state with no panel socket: name the actual blocker. A stale delivery
    // error from the dead socket (or a silent null — the VPS incident's face) would send
    // the operator hunting in the wrong place.
    if (st.deliveredSeq < st.seq) {
      const down = this._downForMs()
      if (down >= NO_LINK_REPORT_MS) {
        return `no panel connection for ${Math.round(down / 1000)}s` +
          (st.lastError ? ` (last error: ${st.lastError})` : '')
      }
    }
    return st.lastError
  }

  // Milliseconds we've been without a live panel socket (0 when connected/disabled/closed).
  _downForMs () {
    if (!this.enabled || this._closed || this._disconnectedSince == null) return 0
    if (this._pickSocket()) return 0
    return Date.now() - this._disconnectedSince
  }

  // Link-level health for status/ops surfaces and tests.
  health () {
    let pendingOps = 0
    for (const st of this._streams.values()) if (st.deliveredSeq < st.seq) pendingOps++
    return {
      enabled: this.enabled,
      connected: !!this._pickSocket(),
      disconnectedForMs: this._downForMs(),
      pendingOps
    }
  }

  _pickSocket () {
    for (const [socket, client] of this._sockets) {
      if (!socket.destroyed) return { socket, client }
      this._sockets.delete(socket)
    }
    return null
  }

  _nextPending () {
    for (const [streamId, st] of this._streams) {
      if (st.deliveredSeq < st.seq) return { streamId, st }
    }
    return null
  }

  // Deliver queued ops one at a time over a single live connection. Re-entrancy-guarded so
  // the register cycles never interleave (see the challenge-rotation note above).
  async _process () {
    if (this._processing || !this.enabled || this._closed) return
    this._processing = true
    try {
      for (;;) {
        if (this._closed) break
        const pending = this._nextPending()
        if (!pending) break
        const picked = this._pickSocket()
        if (!picked) { this._armRelookup(); break } // no live connection — resume when one (re)connects; nudge discovery meanwhile
        const { st } = pending
        const sentSeq = st.seq
        const payload = st.payload
        try {
          await registerWithPanel(picked.client.call, this.publisherKey, payload)
          st.deliveredSeq = Math.max(st.deliveredSeq, sentSeq)
          st.live = payload.isLive !== false
          st.lastError = null
        } catch (err) {
          st.lastError = err && err.message ? err.message : String(err)
          if (TERMINAL_REJECT_RE.test(st.lastError)) {
            // Policy reject: done with THIS state (error kept for status); the
            // queue moves on so one mis-scoped channel can't starve the rest.
            st.deliveredSeq = Math.max(st.deliveredSeq, sentSeq)
            st.live = false
            continue
          }
          if (picked.socket.destroyed) this._sockets.delete(picked.socket)
          this._scheduleRetry() // don't hot-loop; retry shortly (or on the next connection)
          break
        }
      }
    } finally {
      this._processing = false
    }
  }

  _scheduleRetry () {
    if (this._retryTimer || this._closed) return
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._process() }, RETRY_MS)
    if (this._retryTimer.unref) this._retryTimer.unref()
  }

  _armRelookup () {
    if (this._relookupTimer || this._closed || !this._discovery) return
    this._relookupTimer = setTimeout(() => { this._relookupTimer = null; this._relookup() }, this._relookupDelay)
    if (this._relookupTimer.unref) this._relookupTimer.unref()
  }

  // Ops are stranded (pending, no socket): force a fresh DHT query for the panel topic so
  // a re-announced panel (new swarm identity after a restart) is found NOW, not at
  // hyperswarm's own ~10-min topic refresh. Keeps nudging with backoff until a connection
  // arrives (_onConnection stands it down) or the queue empties.
  _relookup () {
    if (this._closed || !this._discovery) return
    if (this._pickSocket()) return // connected — the queue drains on its own
    if (!this._nextPending()) return // nothing stranded — _process re-arms on demand
    try { this._discovery.refresh({ client: true, server: false }).catch(() => {}) } catch {}
    this._relookupDelay = Math.min(this._relookupDelay * 2, RELOOKUP_MAX_MS)
    this._armRelookup()
  }

  // Heartbeat: idempotently re-assert running streams (isLive:true). Idle streams are left
  // alone — their last delivered isLive:false stands. Cheap insurance against a missed edge.
  _reassert () {
    if (!this.enabled || this._closed) return
    let bumped = false
    for (const st of this._streams.values()) {
      if (st.payload && st.payload.isLive !== false) { st.seq = ++this._seq; bumped = true }
    }
    if (bumped) this._process()
  }

  async close () {
    this._closed = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._relookupTimer) { clearTimeout(this._relookupTimer); this._relookupTimer = null }
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null }
    this._discovery = null
    if (this.swarm) { try { await this.swarm.destroy() } catch {} this.swarm = null }
    this._sockets.clear()
  }
}
