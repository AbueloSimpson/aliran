// DesktopBackend — the renderer-side twin of @aliran/react-native's AliranBackend,
// speaking the same message protocol over the Electron IPC bridge instead of worklet
// IPC. Screens ported from the phone app keep their exact backend usage: the cached
// fields exist for late-mounting screens (the one-shot replies can land before a
// screen exists), and onMessage is the live feed.

import type { BackendMessage, EngineState, ReportCategory, SavedIdentity, ServiceDescriptor, Stream, VodConfig, VodInfoResult, VodListResult } from './types'

// A provider call the main process fails to answer would leave the grid spinning
// forever, so every request is bounded here. The provider client's own timeout is
// 20 s — this only fires if main itself never replies.
const VOD_REPLY_TIMEOUT_MS = 25000

class DesktopBackend {
  streams: Stream[] = []
  // Panel-delivered external VOD provider config (S53), or null when the operator has
  // none / has it disabled — null IS "no VOD section". Login-scoped: it arrives on the
  // 'streams' message and in the initial state snapshot, never mid-session.
  vod: VodConfig | null = null
  port: number | null = null
  url: string | null = null
  source: 'p2p' | 'cdn' | null = null
  // The stream the engine last confirmed serving (from the 'port' reply). ONE
  // localhost URL serves whatever feed is active, so this — not the URL — identifies
  // the channel behind the player.
  activeStreamId: string | null = null
  recordType: 'live' | 'vod' | null = null
  durationSec: number | null = null
  creds: SavedIdentity | null = null
  favorites: string[] = []
  smoothZapping: boolean | null = null
  prefsLoaded = false
  ready = false
  descriptor: ServiceDescriptor | null = null
  descriptorSource: 'baked' | 'runtime' | null = null

  private listeners = new Set<(m: BackendMessage) => void>()

  /** Subscribe to engine events + pull the initial snapshot. Call once before render. */
  async init (): Promise<void> {
    window.aliran.onMessage((m) => this.dispatch(m))
    const s: EngineState = await window.aliran.state()
    this.ready = s.ready
    this.streams = s.streams ?? []
    this.vod = s.vod ?? null
    this.port = s.port
    this.url = s.url
    this.source = s.source
    this.activeStreamId = s.streamId
    this.recordType = s.recordType
    this.durationSec = s.durationSec
    this.creds = s.creds
    this.favorites = s.favorites ?? []
    this.smoothZapping = s.smoothZapping
    this.prefsLoaded = true
    this.descriptor = s.descriptor
    this.descriptorSource = s.descriptorSource ?? (s.descriptor ? 'baked' : null)
  }

  onMessage (fn: (m: BackendMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  login (username: string, password: string) { this.send({ username, password }) }
  /** Sign in with the credentials the main process has saved (splash auto-auth). */
  autoLogin () { this.send({ type: 'auto-login' }) }
  /** Public flavor: submit the operator's panel key (Connect screen). Main validates,
   *  persists it in userData, boots the engine, and answers with {type:'service'}
   *  (or a {type:'login-error'} for an invalid key). */
  setService (panelPubKey: string, name?: string) { this.send({ type: 'set-service', panelPubKey, name }) }
  /** Forget the runtime-entered service + saved credentials and relaunch clean.
   *  No-op on operator builds (the baked descriptor is not clearable). */
  clearService () { this.send({ type: 'service-clear' }) }
  play (streamId: string) { this.send({ streamId }) }
  /** Tear down the active feed's swarm connections and dial fresh (stall-ladder
   *  escalation — see HlsVideo). */
  reconnect () { this.send({ type: 'reconnect' }) }
  setZapPrefetch (v: boolean) { this.send({ type: 'zap-prefetch-set', zapPrefetch: v }) }
  setNetworkProfile (expensive: boolean, cellular = false) { this.send({ type: 'net-info', expensive, cellular }) }
  /**
   * Send a viewer problem report (S50c). Fire-and-forget: the answer arrives as
   * {type:'report-result'} on the message feed, so a modal subscribes before calling.
   * The engine attaches the active channel, peer count, app version/platform and its
   * recent event breadcrumbs; identity is the SESSION TOKEN, which the panel reduces
   * to a pseudonym on arrival — no username or device id is ever stored there.
   * Show REPORT_CONSENT before submitting.
   */
  sendReport (category: ReportCategory, text?: string) {
    this.send({ type: 'report', category, ...(text ? { text } : {}) })
  }

  /**
   * The external VOD provider's movie catalog (S53c). The fetch itself happens in
   * the MAIN process — the renderer is file://, so CORS forbids it there, and the
   * credential the provider wants is the viewer's password, which never crosses
   * this bridge. Promise-shaped so the screens read like the phone app's, which
   * calls the provider module directly; the wire underneath is still the one-way
   * send + a 'vod-list-result' on the message feed.
   */
  vodList (): Promise<VodListResult> {
    return this.request<VodListResult>({ type: 'vod-list' }, (m) =>
      m.type === 'vod-list-result'
        ? (m.ok ? { ok: true, items: m.items ?? [] } : { ok: false, error: m.error ?? 'bad-response' })
        : null)
  }

  /** One title's playable URL + runtime. Answers are matched by id: the grid can
   *  have more than one tile in flight. */
  vodInfo (id: string): Promise<VodInfoResult> {
    return this.request<VodInfoResult>({ type: 'vod-info', id }, (m) =>
      m.type === 'vod-info-result' && m.id === id
        ? (m.ok && m.url ? { ok: true, url: m.url, durationSec: m.durationSec ?? null } : { ok: false, error: m.error ?? 'bad-response' })
        : null)
  }

  // Send one message and settle on the first reply the matcher recognizes. A silent
  // main process resolves as a connection failure rather than hanging.
  private request<T> (msg: unknown, match: (m: BackendMessage) => T | null): Promise<T> {
    return new Promise<T>((resolve) => {
      let done = false
      const finish = (v: T) => { if (!done) { done = true; clearTimeout(timer); off(); resolve(v) } }
      const off = this.onMessage((m) => { const v = match(m); if (v) finish(v) })
      const timer = setTimeout(() => finish({ ok: false, error: 'network' } as unknown as T), VOD_REPLY_TIMEOUT_MS)
      this.send(msg)
    })
  }

  requestPrefs () { this.send({ type: 'prefs-get' }) }
  clearCredentials () { this.creds = null; this.send({ type: 'creds-clear' }) }
  toggleFavorite (streamId: string) {
    const next = this.favorites.includes(streamId)
      ? this.favorites.filter((id) => id !== streamId)
      : [...this.favorites, streamId]
    this.favorites = next // optimistic; the 'prefs' reply confirms
    this.send({ type: 'favorites-set', favorites: next })
  }

  isFavorite (streamId: string) { return this.favorites.includes(streamId) }

  private send (obj: unknown) { window.aliran.send(obj) }

  private dispatch (msg: BackendMessage) {
    if (msg.type === 'ready') this.ready = true
    if (msg.type === 'service') { this.descriptor = msg.descriptor; this.descriptorSource = 'runtime' }
    if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.prefsLoaded = true }
    if (msg.type === 'streams') { this.streams = msg.streams; this.vod = msg.vod ?? null }
    if (msg.type === 'port') {
      this.port = msg.port ?? null
      this.url = msg.url ?? (msg.port ? `http://127.0.0.1:${msg.port}/index.m3u8` : null)
      this.source = msg.source ?? (this.url ? 'p2p' : null)
      if (msg.streamId) this.activeStreamId = msg.streamId
      this.recordType = msg.recordType ?? null
      this.durationSec = msg.durationSec ?? null
    }
    if (msg.type === 'fallback') { this.url = msg.url; this.source = 'cdn' }
    if (msg.type === 'source-changed') { this.url = msg.url; this.source = msg.source }
    if (msg.type === 'feed-changed') this.url = msg.url // same localhost URL, new feed behind it
    this.listeners.forEach((fn) => { try { fn(msg) } catch {} })
  }
}

export const backend = new DesktopBackend()
export type { DesktopBackend }
