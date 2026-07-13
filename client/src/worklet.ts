// Boots the Bare worklet (the P2P backend) and provides a small typed IPC wrapper.
// See docs/architecture.md and backend/backend.mjs.

import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
// Base64-encoded Bare bundle produced by `npm run bundle-backend` (app.bundle.js is a
// generated CommonJS module: `module.exports = "<base64>"`). Decoded to bytes below.
import bundleBase64 from '../backend/app.bundle.js'

export type BackendMessage =
  | { type: 'ready' }
  | { type: 'streams'; streams: Stream[] }
  | { type: 'login-error'; message: string }
  | { type: 'port'; port: number }
  | { type: 'status'; peers?: number; state?: string }
  | { type: 'error'; message: string }

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
}

export class Backend {
  // Last entitlement list from the backend. Screens that mount AFTER login (e.g. Home,
  // navigated to on {type:'streams'}) read this instead of missing the one-shot message.
  streams: Stream[] = []
  // Last media-server port. The server is persistent (one port per session), and the
  // one-shot {type:'port'} reply to play() usually lands BEFORE PlayerScreen mounts.
  port: number | null = null

  private worklet = new Worklet()
  private ipc: any
  private buf = ''
  private listeners = new Set<(m: BackendMessage) => void>()

  start (panelPubKey: string) {
    // Pass the bundle as bytes (TypedArray -> startBytes) so the binary bare-bundle is
    // preserved intact; a UTF-8 string would corrupt it. Filename ext must be .bundle.
    this.worklet.start('/app.bundle', b4a.from(bundleBase64, 'base64'))
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    this.send({ panelPubKey })
  }

  onMessage (fn: (m: BackendMessage) => void) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) } // void, so it can be a useEffect cleanup
  }
  login (username: string, password: string) { this.send({ username, password }) }
  play (streamId: string) { this.send({ streamId }) }

  private send (obj: unknown) { this.ipc.write(b4a.from(JSON.stringify(obj) + '\n')) }
  private onData (chunk: string) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as BackendMessage
        console.log('[backend]', line.length > 200 ? msg.type : line)
        if (msg.type === 'streams') this.streams = msg.streams
        if (msg.type === 'port') this.port = msg.port
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}

export const backend = new Backend()
