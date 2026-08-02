// EPG service ⇄ panel pointer link.
//
// Slimmed cousin of library/src/panel-link.js: this service has exactly ONE record
// to deliver — the current guide-drive pointer — so the per-stream queue collapses
// to a single latest-state-wins payload. Everything else that made that link
// reliable in anger is kept: serialized delivery over one socket, retry-on-error,
// and the discovery-refresh nudge for a panel that restarted under a new swarm
// identity (a re-announced panel is otherwise found only at hyperswarm's ~10-min
// topic refresh — the 2026-07-16 VPS incident).

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { panelClient, setEpgKeyWithPanel } from './register.js'

const RETRY_MS = 5000
const RELOOKUP_MIN_MS = 5 * 1000
const RELOOKUP_MAX_MS = 60 * 1000

export class PanelPointerLink {
  constructor (config) {
    this.config = config
    this.enabled = !!(config.panelPubKey && config.publisherKey)
    this.swarm = null
    this._sockets = new Map()
    this._payload = null // latest desired { publisher, key, epoch, rotatedAt }
    this._seq = 0
    this._deliveredSeq = 0
    this.lastError = null
    this._processing = false
    this._retryTimer = null
    this._relookupTimer = null
    this._relookupDelay = RELOOKUP_MIN_MS
    this._discovery = null
    this._closed = false
  }

  connect () {
    if (!this.enabled || this.swarm || this._closed) return
    const bootstrap = this.config.bootstrap && this.config.bootstrap.length ? this.config.bootstrap : undefined
    this.swarm = new Hyperswarm({ bootstrap })
    this.swarm.on('connection', (socket) => {
      this._sockets.set(socket, panelClient(socket))
      socket.on('error', () => {})
      socket.on('close', () => {
        this._sockets.delete(socket)
        if (this._sockets.size === 0 && this._pending()) { this._relookupDelay = RELOOKUP_MIN_MS; this._armRelookup() }
      })
      this._relookupDelay = RELOOKUP_MIN_MS
      if (this._relookupTimer) { clearTimeout(this._relookupTimer); this._relookupTimer = null }
      this._process()
    })
    this._discovery = this.swarm.join(crypto.hash(b4a.from(this.config.panelPubKey, 'hex')), { client: true, server: false })
  }

  // Record the latest pointer and kick delivery. Safe to call before connect().
  setDesired (info) {
    this._payload = {
      ...(this.config.publisherName ? { publisher: this.config.publisherName } : {}),
      key: info.key,
      blobsKey: info.blobsKey ?? null,
      epoch: info.epoch,
      rotatedAt: info.rotatedAt
    }
    this._seq++
    this._process()
  }

  delivered () { return this._deliveredSeq >= this._seq && this._seq > 0 }
  _pending () { return this._deliveredSeq < this._seq }

  _pickSocket () {
    for (const [socket, client] of this._sockets) {
      if (!socket.destroyed) return client
      this._sockets.delete(socket)
    }
    return null
  }

  async _process () {
    if (this._processing || !this.enabled || this._closed) return
    this._processing = true
    try {
      while (this._pending() && !this._closed) {
        const client = this._pickSocket()
        if (!client) { this._armRelookup(); break }
        const sentSeq = this._seq
        try {
          await setEpgKeyWithPanel(client.call, this.config.publisherKey, this._payload)
          this._deliveredSeq = Math.max(this._deliveredSeq, sentSeq)
          this.lastError = null
          console.log(`[epg] panel pointer set: epoch ${this._payload.epoch} key ${this._payload.key.slice(0, 8)}…`)
        } catch (err) {
          this.lastError = err?.message || String(err)
          // Policy rejects (unknown-publisher/revoked/out-of-scope) can never succeed
          // with the same payload — stop retrying, keep the error loud in status();
          // an operator fix (enroll/scope `epg`) is picked up on the next setDesired
          // (boot or rotation).
          if (/\b(unknown-publisher|revoked|out-of-scope)\b/.test(this.lastError)) {
            console.error(`[epg] panel REJECTED the pointer by policy: ${this.lastError} — enroll publisher "${this.config.publisherName}" with scope "epg" in the panel`)
            this._deliveredSeq = Math.max(this._deliveredSeq, sentSeq)
            break
          }
          this._scheduleRetry()
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
    this._relookupTimer = setTimeout(() => {
      this._relookupTimer = null
      if (this._closed || this._pickSocket() || !this._pending()) return
      try { this._discovery.refresh({ client: true, server: false }).catch(() => {}) } catch {}
      this._relookupDelay = Math.min(this._relookupDelay * 2, RELOOKUP_MAX_MS)
      this._armRelookup()
    }, this._relookupDelay)
    if (this._relookupTimer.unref) this._relookupTimer.unref()
  }

  status () {
    return {
      enabled: this.enabled,
      connected: !!this._pickSocket(),
      delivered: this.delivered(),
      lastError: this.lastError
    }
  }

  async close () {
    this._closed = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._relookupTimer) { clearTimeout(this._relookupTimer); this._relookupTimer = null }
    this._discovery = null
    if (this.swarm) { try { await this.swarm.destroy() } catch {} this.swarm = null }
    this._sockets.clear()
  }
}
