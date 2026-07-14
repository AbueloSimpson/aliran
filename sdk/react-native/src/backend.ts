// AliranBackend — hosts the Aliran engine in a Bare worklet and speaks its IPC
// protocol (line-delimited JSON; see client/backend/backend.mjs). The host app
// supplies the worklet bundle (bare-pack output, base64 string or raw bytes) — the
// binding stays free of build-time coupling to any one backend build.

import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'

export interface Stream {
  id: string
  title: string
  description?: string
  category?: string[]
  isLive?: boolean
  viewerCount?: number
  poster?: string
  backdrop?: string
  logo?: string
  /** Panel curation hint: rail/list sort key (lower first; null/absent sorts last). */
  order?: number | null
  /** Panel curation hint: featured stream (hero / menu wallpaper pick). */
  featured?: boolean
}

// JSON-safe hybrid CDN<->P2P config, passed through to the engine (sdk/player.js).
// cdnUrl is a template STRING ('{streamId}' is substituted) — functions can't cross IPC.
export interface HybridConfig {
  mode?: 'p2p-only' | 'hybrid' | 'cdn-only'
  start?: 'preferP2P' | 'preferCDN'
  cdnUrl?: string
  readyTimeoutMs?: number
  rebufferMsToFallback?: number
  probeIntervalMs?: number
}

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[] }
  | { type: 'login-error'; message: string }
  | { type: 'port'; port?: number; url?: string; source?: 'p2p' | 'cdn' }
  | { type: 'status'; peers?: number; state?: string; message?: string }
  | { type: 'error'; message: string }
  | { type: 'fallback'; streamId: string; url: string; reason: 'timeout' | 'stall' }
  | { type: 'source-changed'; streamId: string; source: 'p2p' | 'cdn'; url: string }

export interface StartOptions {
  panelPubKey: string
  hybrid?: HybridConfig
  /** console.log every backend message (dev instrumentation — shows in `adb logcat -s ReactNativeJS`). */
  debug?: boolean
}

export class AliranBackend {
  // Last entitlement list from the backend. Screens that mount AFTER login (e.g. a
  // home screen navigated to on {type:'streams'}) read this instead of missing the
  // one-shot message.
  streams: Stream[] = []
  // Last media-server port / active-source URL. The server is persistent (one port
  // per session), and the one-shot {type:'port'} reply to play() can land before the
  // player screen mounts.
  port: number | null = null
  url: string | null = null
  source: 'p2p' | 'cdn' | null = null

  private worklet = new Worklet()
  private ipc: any
  private buf = ''
  private debug = false
  private listeners = new Set<(m: BackendMessage) => void>()

  /**
   * Boot the worklet with a bare-pack bundle (base64 string or raw bytes) and connect
   * to the panel. Bytes are passed via startBytes so the binary bundle is preserved
   * intact; the filename extension must be `.bundle`.
   */
  start (bundle: string | Uint8Array, opts: StartOptions) {
    this.debug = !!opts.debug
    const bytes = typeof bundle === 'string' ? b4a.from(bundle, 'base64') : bundle
    this.worklet.start('/app.bundle', bytes as any)
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    this.send({ panelPubKey: opts.panelPubKey, hybrid: opts.hybrid })
  }

  onMessage (fn: (m: BackendMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) } // void, so it can be a useEffect cleanup
  }

  login (username: string, password: string) { this.send({ username, password }) }
  play (streamId: string) { this.send({ streamId }) }
  /** Dev direct-play by raw keys (no login). */
  playRaw (feedKey: string, encryptionKey: string) { this.send({ feedKey, encryptionKey }) }

  private send (obj: unknown) { this.ipc.write(b4a.from(JSON.stringify(obj) + '\n')) }

  private onData (chunk: string) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as BackendMessage
        if (this.debug) console.log('[backend]', line.length > 200 ? msg.type : line)
        if (msg.type === 'streams') this.streams = msg.streams
        if (msg.type === 'port') {
          this.port = msg.port ?? null
          this.url = msg.url ?? (msg.port ? `http://127.0.0.1:${msg.port}/index.m3u8` : null)
          this.source = msg.source ?? (this.url ? 'p2p' : null)
        }
        if (msg.type === 'fallback') { this.url = msg.url; this.source = 'cdn' }
        if (msg.type === 'source-changed') { this.url = msg.url; this.source = msg.source }
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}
