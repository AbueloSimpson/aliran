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
//   { type:'report', category, text? }         viewer problem report (S50c) — one of
//                                    the seven sdk/report.js categories + optional
//                                    free text; answered with 'report-result'
//   { type:'vod-list', kind? }       the external VOD provider's catalog (S53c) —
//                                    kind 'movies' (default) or 'series' (S54a)
//                                    -> 'vod-list-result' (which ECHOES the kind)
//   { type:'vod-info', id }          one title's playable URL -> 'vod-info-result'
//   { type:'vod-series-info', id }   one series' seasons + episodes (S54a)
//                                    -> 'vod-series-info-result'
//   { type:'vod-categories' }        the provider's genre NAMES (S54d) — the same
//                                    already-downloaded catalog serves them, so this
//                                    costs no extra request -> 'vod-categories-result'
//   { type:'vod-prefs-set', list?, history? }   device-local VOD prefs (S54a, D9):
//                                    "My List" and watch history, each a WHOLE-ARRAY
//                                    replacement this process re-validates and caps
//                                    (500 / 200) before writing. Neither ever reaches
//                                    the panel or the provider. Answers with 'prefs'.
// Messages out: identical to the worklet protocol (see backend.mjs header), except
// 'prefs' carries creds: { username } | null — no password. 'report-result'
// { ok, error?, retryAfter?, id? } answers a 'report' (error 'unsupported' = the
// panel predates reports or has them disabled). 'streams' carries an optional
// `vod` (S53) — the panel's external VOD provider config { enabled, apiBase,
// service, sources, params }, present ONLY when the operator enabled one (absent =
// no VOD section). The renderer's state() snapshot mirrors it as `vod: … | null`
// for screens that mount after the one-shot message.
// 'vod-list-result' { ok, kind, items?, error? }, 'vod-info-result' { id, ok, url?,
// durationSec?, error? }, 'vod-series-info-result' { id, ok, detail?, error? } and
// 'vod-categories-result' { ok, categories?, error? } answer the four VOD requests
// (S53c, S54a, S54d). The provider is called
// from HERE, never from the renderer: the renderer is file:// (CORS blocks it) and,
// more importantly, the credential the provider wants IS the viewer's password,
// which never leaves this process (episode URLs arrive with the token already
// substituted, which is the only form the renderer ever sees). Error codes are the
// provider module's typed 'auth' | 'network' | 'bad-response' — no provider text, no
// HTTP codes. The 'prefs' reply also carries the device-local vodList/vodHistory.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createPlayer } from '@aliran/player-sdk'
import { listMovies, listSeries, listCategories, getMovieInfo, getSeriesInfo } from './vod-provider.js'

const TRANSIENT_LOGIN = /not connected|channel closed/i
const LOGIN_RETRY_MS = 2500
const LOGIN_MAX_RETRIES = 24 // ≈1 minute of dialing before the error surfaces

// How many channels to pre-warm at login (lowest curated order first) — the same
// bounded default as the phone app: covers the typical zapping range without opening
// hundreds of DHT topics on a big catalog.
const PREWARM_CHANNELS = 12

// Device-local VOD prefs (S54a, design D9) — "My List" and watch history. This process
// owns the prefs file, so it — not the renderer — decides what a valid entry is and how
// many fit: a setter carries a whole array, and it is re-validated, de-duplicated and
// capped here. Same limits and same gates as the phone worklet
// (client/backend/backend.mjs), which is the copy this one must not drift from.
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

export class EngineHost {
  /**
   * @param {object} opts
   * @param {object} opts.descriptor  parsed service descriptor (panelPubKey, name, …)
   * @param {string} opts.userData   app.getPath('userData') — store + prefs live here
   * @param {object} opts.safeStorage Electron safeStorage (DPAPI credential wrap)
   * @param {(msg: object) => void} opts.onMessage  out-message sink (broadcast to windows)
   * @param {string} [opts.appVersion] shell version (app.getVersion()) — attached to
   *   problem reports so an operator can tell which build a complaint came from
   * @param {string} [opts.platform] host platform label; defaults to process.platform
   */
  constructor ({ descriptor, descriptorSource = descriptor ? 'baked' : null, userData, safeStorage, onMessage, appVersion = null, platform = null }) {
    this.descriptor = descriptor
    // 'baked' (operator build: config shipped in the artifact) or 'runtime' (public
    // build: the Connect screen persisted it) — Settings offers "Change service"
    // only for the runtime kind.
    this.descriptorSource = descriptorSource
    this.userData = userData
    this.safeStorage = safeStorage
    this.appVersion = appVersion
    this.platform = platform || process.platform
    this.send = (msg) => { try { onMessage(msg) } catch {} }
    this.player = null
    this.ready = false
    // The engine's last confirmed serve — mirrored into the renderer bridge's cache
    // for late-mounting screens (same fields AliranBackend keeps). `headers` is the
    // redirect-channel provider hotlink set (Referer/Origin/User-Agent), carried here
    // so state() hands it to a late-mounting player AND so index.js can arm the
    // main-process webRequest injection (Part C) off the same 'port' send — the
    // renderer's hls.js cannot set those forbidden headers itself.
    this.last = { port: null, url: null, source: null, streamId: null, recordType: null, durationSec: null, headers: null }
    // The operator/user's CONFIGURED upload policy. The network gate (S25) flips the
    // live policy to 'client-only' on metered links and restores THIS on the way back.
    this.basePolicy = 'reseed'
    this.loginToken = 0 // invalidates a stale transient-retry loop when a new login starts
    // The pair the CURRENT session signed in with, kept in memory only (S53c). The
    // external VOD provider is authenticated with the viewer's own app password —
    // that is the pass-off model — and it is needed on every provider call, but
    // readPassword() can only answer when the OS provided encryption AND the
    // credentials were saved (a 'creds-clear'/no-safeStorage install has neither).
    // So a successful login remembers the pair HERE: never written to disk, never
    // sent to the renderer, gone when the process exits.
    this.sessionCreds = null
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
        smoothZapping: typeof p?.smoothZapping === 'boolean' ? p.smoothZapping : null,
        // Per-install device id (S50c); absent on prefs written by an older build —
        // deviceId() mints one on the next boot.
        deviceId: /^[0-9a-f]{16}$/.test(p?.deviceId || '') ? p.deviceId : null,
        // Device-local VOD prefs (S54a). Re-gated on READ as well as on write: the
        // file is plain JSON in userData, so what comes back is no more trustworthy
        // than what went in, and a corrupt entry must not reach a screen.
        vodList: gateVodList(p?.vodList),
        vodHistory: gateVodHistory(p?.vodHistory)
      }
    } catch {
      return { credsUser: null, credsEnc: null, favorites: [], smoothZapping: null, deviceId: null, vodList: [], vodHistory: [] }
    }
  }

  // Per-install device id: 8 random bytes, minted once into prefs and never rotated.
  // Without it every install of an account collapses onto one derived fallback id
  // (sdk/login.js), so the panel's device list and per-device revocation cannot tell
  // two machines apart — and the report pseudonym cannot either.
  deviceId () {
    const p = this.readPrefs()
    if (p.deviceId) return p.deviceId
    const id = randomBytes(8).toString('hex')
    this.writePrefs({ ...p, deviceId: id })
    return id
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
      smoothZapping: p.smoothZapping,
      vodList: p.vodList,
      vodHistory: p.vodHistory
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

  // The descriptor's dev-only credentials (baked/dev builds; see 'auto-login').
  devCreds () {
    const d = this.descriptor?.dev
    return typeof d?.username === 'string' && typeof d?.password === 'string'
      ? { username: d.username, password: d.password }
      : null
  }

  // --- external VOD provider (S53c) ---

  // What the provider client authenticates with. The descriptor's `vod.dev` block
  // (gitignored dev configs only) WINS when it is filled in; otherwise the viewer's
  // own login pair — app username -> username, app password -> token. This is the
  // ONLY consumer of a decrypted password inside main, and neither half is ever
  // returned to the renderer (publicDescriptor() drops `vod` for the same reason).
  vodDeps () {
    const dev = this.descriptor?.vod?.dev
    return {
      dev: dev && typeof dev.username === 'string' && typeof dev.token === 'string' ? { username: dev.username, token: dev.token } : null,
      saved: this.sessionCreds || this.readPassword()
    }
  }

  // The provider config the panel delivered at login (null = no provider/disabled).
  vodConfig () {
    try { return this.player ? this.player.vodConfig() : null } catch { return null }
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
      uploadPolicy: this.descriptor.uploadPolicy,
      // Identity + provenance for the panel's device list and problem reports (S50c).
      deviceId: this.deviceId(),
      appVersion: this.appVersion || undefined,
      platform: this.platform
    })
    if (this.descriptor.uploadPolicy === 'client-only' || this.descriptor.uploadPolicy === 'reseed') {
      this.basePolicy = this.descriptor.uploadPolicy
    }
    const p = this.player
    p.on('ready', () => { this.ready = true; this.send({ type: 'ready' }) })
    p.on('streams', (streams, vod) => this.send({ type: 'streams', streams, ...(vod ? { vod } : {}) }))
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
      vod: this.player ? this.player.vodConfig() : null, // S53: null = no provider / disabled
      ...this.last,
      creds: p.credsUser ? { username: p.credsUser } : null,
      favorites: p.favorites,
      smoothZapping: p.smoothZapping,
      // S54a: device-local VOD prefs, so a screen mounting late renders My List and
      // "recently watched" without waiting for a 'prefs' round-trip.
      vodList: p.vodList,
      vodHistory: p.vodHistory,
      descriptor: this.descriptor ? publicDescriptor(this.descriptor) : null,
      descriptorSource: this.descriptorSource
    }
  }

  // --- the transient-aware login (one retry loop for typed AND auto logins) ---

  async login (username, password, { save = true } = {}) {
    const token = ++this.loginToken
    for (let i = 0; ; i++) {
      try {
        await this.player.login(username, password)
        if (token === this.loginToken) this.sessionCreds = { username, password }
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
      // Sign-out drops the in-memory pair too, or the next viewer on this machine
      // would reach the provider as the previous one (S53c).
      this.sessionCreds = null
      this.sendPrefs()
    } else if (msg.type === 'favorites-set' && Array.isArray(msg.favorites)) {
      this.writePrefs({ ...this.readPrefs(), favorites: msg.favorites.filter((x) => typeof x === 'string') })
      this.sendPrefs()
    } else if (msg.type === 'vod-prefs-set') {
      // Device-local "My List" / watch history (S54a, D9). Either array may be
      // omitted — the players write history far more often than the list changes —
      // and each supplied one REPLACES its stored counterpart wholesale, gated and
      // capped here. Nothing about this leaves the machine.
      const prefs = this.readPrefs()
      this.writePrefs({
        ...prefs,
        ...(Array.isArray(msg.list) ? { vodList: gateVodList(msg.list) } : {}),
        ...(Array.isArray(msg.history) ? { vodHistory: gateVodHistory(msg.history) } : {})
      })
      this.sendPrefs()
    } else if (msg.type === 'auto-login') {
      // Saved (safeStorage-wrapped) credentials win; a baked descriptor's `dev`
      // block is the fallback so an operator/dev test build signs itself in on the
      // very first boot (the Login screen already pre-fills from the same block —
      // this closes the one remaining click). Public builds have no `dev` block by
      // construction (keyless artifacts bake no descriptor at all).
      const c = this.readPassword() || this.devCreds()
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
    } else if (msg.type === 'report') {
      // Viewer problem report (S50c). player.report() never throws and never rejects,
      // so this branch always answers — and it answers even with no engine, because a
      // UI awaiting 'report-result' must never be left hanging.
      if (!this.player) {
        this.send({ type: 'report-result', ok: false, error: 'offline' })
      } else {
        this.player.report({ category: msg.category, text: msg.text })
          .then((res) => this.send({
            type: 'report-result',
            ok: res.ok === true,
            ...(res.error ? { error: res.error } : {}),
            ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}),
            ...(res.id ? { id: res.id } : {})
          }))
          .catch((err) => this.send({ type: 'report-result', ok: false, error: String(err?.message || err) }))
      }
    } else if (msg.type === 'vod-list') {
      // The external provider's catalog. Like 'report', this branch ALWAYS answers —
      // the screen awaits 'vod-list-result' and must never be left spinning. The
      // provider module never throws and never rejects; the .catch is belt-and-braces
      // and still yields a typed code, never an exception string (which could carry
      // the request URL, and with it the token).
      //
      // The reply ECHOES the kind (S54a): Movies and Series can both be in flight, and
      // the bridge matches the answer to the request that asked for it. An unknown or
      // absent kind is 'movies' — the shape older renderers send.
      const kind = msg.kind === 'series' ? 'series' : 'movies'
      const config = this.vodConfig()
      if (!config) {
        // Defensive only: the renderer gates the whole section on the same config.
        this.send({ type: 'vod-list-result', kind, ok: false, error: 'bad-response' })
      } else {
        const list = kind === 'series' ? listSeries : listMovies
        list(config, this.vodDeps())
          .then((res) => this.send({ type: 'vod-list-result', kind, ...res }))
          .catch(() => this.send({ type: 'vod-list-result', kind, ok: false, error: 'network' }))
      }
    } else if (msg.type === 'vod-categories') {
      // The provider's genre NAMES (S54d) — the Genres tab labels its cards with them,
      // and an item's `categories` are numeric INDEXES into this array, so the order is
      // load-bearing and is passed through untouched. The same cached catalog download
      // that served 'vod-list' answers this, so it costs no extra request. Same
      // always-answers contract as the other three branches.
      const config = this.vodConfig()
      if (!config) {
        this.send({ type: 'vod-categories-result', ok: false, error: 'bad-response' })
      } else {
        listCategories(config, this.vodDeps())
          .then((res) => this.send({ type: 'vod-categories-result', ...res }))
          .catch(() => this.send({ type: 'vod-categories-result', ok: false, error: 'network' }))
      }
    } else if (msg.type === 'vod-series-info' && typeof msg.id === 'string') {
      // One series' seasons + episodes (S54a). Same always-answers contract as
      // 'vod-list'; the episode URLs in `detail` already carry the substituted token,
      // which is the only form that ever crosses to the renderer.
      const id = msg.id
      const config = this.vodConfig()
      if (!config) {
        this.send({ type: 'vod-series-info-result', id, ok: false, error: 'bad-response' })
      } else {
        getSeriesInfo(config, id, this.vodDeps())
          .then((res) => this.send({ type: 'vod-series-info-result', id, ...res }))
          .catch(() => this.send({ type: 'vod-series-info-result', id, ok: false, error: 'network' }))
      }
    } else if (msg.type === 'vod-info' && typeof msg.id === 'string') {
      // The reply carries the id back: the grid may have several tiles in flight and
      // matches the answer to the tile that asked.
      const id = msg.id
      const config = this.vodConfig()
      if (!config) {
        this.send({ type: 'vod-info-result', id, ok: false, error: 'bad-response' })
      } else {
        getMovieInfo(config, id, this.vodDeps())
          .then((res) => this.send({ type: 'vod-info-result', id, ...res }))
          .catch(() => this.send({ type: 'vod-info-result', id, ok: false, error: 'network' }))
      }
    } else if (typeof msg.username === 'string' && typeof msg.password === 'string') {
      this.login(msg.username, msg.password).catch(fail)
    } else if (typeof msg.streamId === 'string') {
      // The engine's ResolveResult `type` rides as `recordType` (the message's own
      // `type` is the envelope discriminant): 'vod' = finished library title.
      this.player.resolve(msg.streamId)
        .then(({ port, url, source, type, durationSec, headers }) => {
          // `headers` is redirect-only (undefined for P2P/localhost/CDN serves —
          // sdk/player.js resolve() attaches it on the redirect branch alone). Kept
          // beside `url` here and forwarded on the 'port' send: the renderer bridge
          // mirrors it for <HlsVideo>, but the actual injection is main-side
          // (redirect-headers.js), armed from this same message in index.js.
          this.last = { port: port ?? null, url, source, streamId: msg.streamId, recordType: type ?? null, durationSec: durationSec ?? null, headers: headers ?? null }
          this.send({ type: 'port', port, url, source, streamId: msg.streamId, recordType: type, durationSec, headers })
        })
        .catch(fail)
    }
  }
}

// The renderer only needs the presentational descriptor fields — panelPubKey rides
// along for the Settings "service" card, but engine knobs stay main-side. Note what
// is NOT here: the `vod.dev` provider credential (S53c) stays in this process, the
// way the saved password does.
function publicDescriptor (d) {
  return {
    panelPubKey: d.panelPubKey,
    name: d.name || 'Aliran',
    branding: d.branding,
    sections: d.sections,
    dev: d.dev
  }
}
