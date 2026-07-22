// DesktopBackend — the renderer-side twin of @aliran/react-native's AliranBackend,
// speaking the same message protocol over the Electron IPC bridge instead of worklet
// IPC. Screens ported from the phone app keep their exact backend usage: the cached
// fields exist for late-mounting screens (the one-shot replies can land before a
// screen exists), and onMessage is the live feed.

import type { BackendMessage, EngineState, SavedIdentity, ServiceDescriptor, Stream } from './types'

class DesktopBackend {
  streams: Stream[] = []
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

  private listeners = new Set<(m: BackendMessage) => void>()

  /** Subscribe to engine events + pull the initial snapshot. Call once before render. */
  async init (): Promise<void> {
    window.aliran.onMessage((m) => this.dispatch(m))
    const s: EngineState = await window.aliran.state()
    this.ready = s.ready
    this.streams = s.streams ?? []
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
  }

  onMessage (fn: (m: BackendMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  login (username: string, password: string) { this.send({ username, password }) }
  /** Sign in with the credentials the main process has saved (splash auto-auth). */
  autoLogin () { this.send({ type: 'auto-login' }) }
  play (streamId: string) { this.send({ streamId }) }
  /** Tear down the active feed's swarm connections and dial fresh (stall-ladder
   *  escalation — see HlsVideo). */
  reconnect () { this.send({ type: 'reconnect' }) }
  setZapPrefetch (v: boolean) { this.send({ type: 'zap-prefetch-set', zapPrefetch: v }) }
  setNetworkProfile (expensive: boolean, cellular = false) { this.send({ type: 'net-info', expensive, cellular }) }
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
    if (msg.type === 'prefs') { this.creds = msg.creds; this.favorites = msg.favorites || []; this.smoothZapping = msg.smoothZapping ?? null; this.prefsLoaded = true }
    if (msg.type === 'streams') this.streams = msg.streams
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
