// Aliran desktop engine host — runs @aliran/player-sdk in the Electron MAIN process
// (native modules are N-API prebuilds, so the same graph the Node e2e uses loads here
// unchanged). This is the desktop sibling of the Android worklet shell
// (client/backend/backend.mjs): the same in/out message protocol, so the renderer-side
// bridge mirrors @aliran/react-native's AliranBackend and the app screens port
// mechanically. Differences from the worklet, all deliberate:
//
//   - The engine boots HERE at app start (the renderer never sends panelPubKey).
//   - Saved credentials ("remember me", D1) are wrapped with Electron safeStorage
//     (DPAPI on Windows) instead of plaintext-at-rest, and the password NEVER goes
//     back to the renderer: the 'prefs' reply carries { username } only, and the
//     splash's auto-login is a message the main process fulfils from its own store
//     ({ type: 'auto-login' }).
//   - The transient-login retry loop ('not connected to panel' while the swarm dials,
//     or a mid-login socket drop) lives here, once, instead of in every screen.
//
// Messages in (renderer -> main over the 'aliran:msg' channel):
//   { username, password }           OPRF login -> 'streams' on success
//   { type:'auto-login' }            login with the saved credentials (splash path)
//   { streamId }                     resolve + serve -> { type:'port', ... }
//   { type:'prefs-get' | 'creds-clear' }
//   { type:'favorites-set', favorites }
//   { type:'reconnect' }             wedged-transport escalation (stall ladder)
//   { type:'zap-prefetch-set', zapPrefetch }   runtime "Smooth zapping" toggle
//   { type:'net-info', expensive, cellular }   host network profile (S25 upload gate)
// Messages out: identical to the worklet protocol (see backend.mjs header), except
// 'prefs' carries creds: { username } | null — no password.

import fs from 'node:fs'
import path from 'node:path'
import { createPlayer } from '@aliran/player-sdk'

const TRANSIENT_LOGIN = /not connected|channel closed/i
const LOGIN_RETRY_MS = 2500
const LOGIN_MAX_RETRIES = 24 // ≈1 minute of dialing before the error surfaces

// How many channels to pre-warm at login (lowest curated order first) — the same
// bounded default as the phone app: covers the typical zapping range without opening
// hundreds of DHT topics on a big catalog.
const PREWARM_CHANNELS = 12

export class EngineHost {
  /**
   * @param {object} opts
   * @param {object} opts.descriptor  parsed service descriptor (panelPubKey, name, …)
   * @param {string} opts.userData   app.getPath('userData') — store + prefs live here
   * @param {object} opts.safeStorage Electron safeStorage (DPAPI credential wrap)
   * @param {(msg: object) => void} opts.onMessage  out-message sink (broadcast to windows)
   */
  constructor ({ descriptor, userData, safeStorage, onMessage }) {
    this.descriptor = descriptor
    this.userData = userData
    this.safeStorage = safeStorage
    this.send = (msg) => { try { onMessage(msg) } catch {} }
    this.player = null
    this.ready = false
    // The engine's last confirmed serve — mirrored into the renderer bridge's cache
    // for late-mounting screens (same fields AliranBackend keeps).
    this.last = { port: null, url: null, source: null, streamId: null, recordType: null, durationSec: null }
    // The operator/user's CONFIGURED upload policy. The network gate (S25) flips the
    // live policy to 'client-only' on metered links and restores THIS on the way back.
    this.basePolicy = 'reseed'
    this.loginToken = 0 // invalidates a stale transient-retry loop when a new login starts
  }

  storeDir () { return path.join(this.userData, 'aliran-store') }
  prefsPath () { return path.join(this.userData, 'aliran-prefs.json') }

  // --- device-local prefs (favorites + "Smooth zapping" + wrapped credentials) ---
  // Stored BESIDE the corestore, never in it: the store is a disposable cache that
  // corruption recovery purges wholesale, and prefs must survive that.

  readPrefs () {
    try {
      const p = JSON.parse(fs.readFileSync(this.prefsPath(), 'utf8'))
      return {
        credsUser: typeof p?.credsUser === 'string' ? p.credsUser : null,
        credsEnc: typeof p?.credsEnc === 'string' ? p.credsEnc : null,
        favorites: Array.isArray(p?.favorites) ? p.favorites.filter((x) => typeof x === 'string') : [],
        smoothZapping: typeof p?.smoothZapping === 'boolean' ? p.smoothZapping : null
      }
    } catch {
      return { credsUser: null, credsEnc: null, favorites: [], smoothZapping: null }
    }
  }

  writePrefs (prefs) {
    try { fs.writeFileSync(this.prefsPath(), JSON.stringify(prefs)) } catch (err) {
      this.send({ type: 'error', message: 'prefs write failed: ' + String(err?.message || err) })
    }
  }

  sendPrefs () {
    const p = this.readPrefs()
    this.send({
      type: 'prefs',
      creds: p.credsUser ? { username: p.credsUser } : null,
      favorites: p.favorites,
      smoothZapping: p.smoothZapping
    })
  }

  // Wrap/unwrap the saved password with the OS keychain (DPAPI via safeStorage).
  // When the OS can't provide encryption we simply don't save credentials — the app
  // still works, the splash just always lands on Login (stated, not silent: the
  // 'prefs' reply carries no creds so the UI never promises an auto-login).
  saveCredentials (username, password) {
    if (!this.safeStorage?.isEncryptionAvailable()) return
    try {
      const enc = this.safeStorage.encryptString(password).toString('base64')
      this.writePrefs({ ...this.readPrefs(), credsUser: username, credsEnc: enc })
    } catch (err) {
      this.send({ type: 'error', message: 'credential save failed: ' + String(err?.message || err) })
    }
  }

  readPassword () {
    const p = this.readPrefs()
    if (!p.credsUser || !p.credsEnc || !this.safeStorage?.isEncryptionAvailable()) return null
    try {
      return { username: p.credsUser, password: this.safeStorage.decryptString(Buffer.from(p.credsEnc, 'base64')) }
    } catch {
      return null // key changed (user profile reset) — treat as "no saved credentials"
    }
  }

  // --- engine lifecycle ---

  start () {
    if (this.player) return
    const saved = this.readPrefs().smoothZapping
    this.player = createPlayer({
      panelPubKey: this.descriptor.panelPubKey,
      storeDir: this.storeDir(),
      prewarm: PREWARM_CHANNELS,
      // The persisted "Smooth zapping" choice wins over the compiled default (off).
      zapPrefetch: saved ?? false,
      hybrid: this.descriptor.hybrid,
      swarm: this.descriptor.swarm,
      uploadPolicy: this.descriptor.uploadPolicy
    })
    if (this.descriptor.uploadPolicy === 'client-only' || this.descriptor.uploadPolicy === 'reseed') {
      this.basePolicy = this.descriptor.uploadPolicy
    }
    const p = this.player
    p.on('ready', () => { this.ready = true; this.send({ type: 'ready' }) })
    p.on('streams', (streams) => this.send({ type: 'streams', streams }))
    p.on('status', (status) => {
      if (status?.state === 'net:tuned') { try { console.log('[net]', status.message) } catch {} }
      this.send({ type: 'status', ...status })
    })
    p.on('peers', (peers) => this.send({ type: 'status', peers }))
    p.on('recovered', (err) => this.send({ type: 'status', state: 'store:reset', message: String(err?.message || err) }))
    p.on('fallback', (e) => this.send({ type: 'fallback', ...e }))
    p.on('source-changed', (e) => this.send({ type: 'source-changed', ...e }))
    p.on('feed-changed', (e) => {
      if (e.streamId === this.last.streamId) this.last.url = e.url
      this.send({ type: 'feed-changed', ...e })
    })
    p.on('zap-prefetch', (e) => this.send({ type: 'zap-prefetch', ...e }))
    // Background engine failures with no caller to throw to — most importantly the
    // tune watchdog's friendly timeout. Dropping these leaves the UI spinning forever.
    p.on('error', (err) => this.send({ type: 'error', message: String(err?.message || err) }))
    p.connect(this.descriptor.panelPubKey).catch((err) => this.send({ type: 'error', message: String(err?.message || err) }))
  }

  async stop () {
    const p = this.player
    this.player = null
    if (p) await p.stop()
  }

  // Initial-state snapshot for the renderer bridge (screens can mount after the
  // one-shot messages already landed).
  state () {
    const p = this.readPrefs()
    return {
      ready: this.ready,
      streams: this.player ? this.player.listStreams() : [],
      ...this.last,
      creds: p.credsUser ? { username: p.credsUser } : null,
      favorites: p.favorites,
      smoothZapping: p.smoothZapping,
      descriptor: publicDescriptor(this.descriptor)
    }
  }

  // --- the transient-aware login (one retry loop for typed AND auto logins) ---

  async login (username, password, { save = true } = {}) {
    const token = ++this.loginToken
    for (let i = 0; ; i++) {
      try {
        await this.player.login(username, password)
        if (token === this.loginToken && save) this.saveCredentials(username, password)
        return // 'streams' already relayed by the event listener
      } catch (err) {
        if (token !== this.loginToken) return // superseded by a newer login attempt
        const msg = String(err?.message || err)
        if (TRANSIENT_LOGIN.test(msg) && i < LOGIN_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, LOGIN_RETRY_MS))
          continue
        }
        this.send({
          type: 'login-error',
          message: TRANSIENT_LOGIN.test(msg) ? 'Cannot reach the service — check your connection.' : msg
        })
        return
      }
    }
  }

  // --- renderer message dispatch (the worklet IPC dispatch, minus boot) ---

  handle (msg) {
    if (!msg || typeof msg !== 'object') return
    const fail = (err) => this.send({ type: 'error', message: String(err?.message || err) })
    if (msg.type === 'prefs-get') {
      this.sendPrefs()
    } else if (msg.type === 'creds-clear') {
      this.writePrefs({ ...this.readPrefs(), credsUser: null, credsEnc: null })
      this.sendPrefs()
    } else if (msg.type === 'favorites-set' && Array.isArray(msg.favorites)) {
      this.writePrefs({ ...this.readPrefs(), favorites: msg.favorites.filter((x) => typeof x === 'string') })
      this.sendPrefs()
    } else if (msg.type === 'auto-login') {
      const c = this.readPassword()
      if (c) this.login(c.username, c.password, { save: false })
      else this.send({ type: 'login-error', message: 'no saved credentials' })
    } else if (msg.type === 'reconnect') {
      if (this.player) { try { this.player.reconnectActiveFeed() } catch (err) { fail(err) } }
    } else if (msg.type === 'zap-prefetch-set') {
      this.writePrefs({ ...this.readPrefs(), smoothZapping: !!msg.zapPrefetch })
      if (this.player) { try { this.player.setZapPrefetch(msg.zapPrefetch) } catch (err) { fail(err) } }
      this.sendPrefs()
    } else if (msg.type === 'net-info') {
      if (this.player) {
        try {
          this.player.setNetworkProfile({ expensive: !!msg.expensive })
          // S25: on a metered link stop re-seeding; restore the configured policy the
          // moment the network is cheap again. Playback itself is never interrupted.
          const limited = !!msg.expensive || !!msg.cellular
          const want = limited ? 'client-only' : this.basePolicy
          this.player.setUploadPolicy(want).then((r) => {
            if (r.changed) this.send({ type: 'upload-policy', policy: r.policy, reason: limited ? (msg.cellular ? 'cellular' : 'metered') : 'unmetered' })
          }).catch(() => {})
        } catch (err) { fail(err) }
      }
    } else if (typeof msg.username === 'string' && typeof msg.password === 'string') {
      this.login(msg.username, msg.password).catch(fail)
    } else if (typeof msg.streamId === 'string') {
      // The engine's ResolveResult `type` rides as `recordType` (the message's own
      // `type` is the envelope discriminant): 'vod' = finished library title.
      this.player.resolve(msg.streamId)
        .then(({ port, url, source, type, durationSec }) => {
          this.last = { port: port ?? null, url, source, streamId: msg.streamId, recordType: type ?? null, durationSec: durationSec ?? null }
          this.send({ type: 'port', port, url, source, streamId: msg.streamId, recordType: type, durationSec })
        })
        .catch(fail)
    }
  }
}

// The renderer only needs the presentational descriptor fields — panelPubKey rides
// along for the Settings "service" card, but engine knobs stay main-side.
function publicDescriptor (d) {
  return {
    panelPubKey: d.panelPubKey,
    name: d.name || 'Aliran',
    branding: d.branding,
    sections: d.sections,
    dev: d.dev
  }
}
