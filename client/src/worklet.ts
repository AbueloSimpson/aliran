// Boots the Bare worklet (the P2P backend) and provides a small typed IPC wrapper.
// See docs/architecture.md and backend/backend.mjs.

// @ts-expect-error — provided natively by react-native-bare-kit
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
// The bundle produced by `npm run bundle-backend`.
// @ts-expect-error — resolved at build time
import bundle from '../backend/app.bundle'

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
  private worklet = new Worklet()
  private ipc: any
  private buf = ''
  private listeners = new Set<(m: BackendMessage) => void>()

  start (panelPubKey: string) {
    this.worklet.start('/app.bundle', bundle)
    this.ipc = this.worklet.IPC
    this.ipc.on('data', (d: Uint8Array) => this.onData(b4a.toString(d)))
    this.send({ panelPubKey })
  }

  onMessage (fn: (m: BackendMessage) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
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
        this.listeners.forEach(fn => fn(msg))
      } catch { /* ignore partial/invalid */ }
    }
  }
}

export const backend = new Backend()
