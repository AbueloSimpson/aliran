// Panel login RPC handler (shared by src/index.js and the e2e test).
import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { evaluate, powVerify } from '@aliran/core'

const json = (o) => b4a.from(JSON.stringify(o))

// Fixed-window rate limiter on OPRF evaluations per (username, peer).
export function makeThrottle (threshold, windowSec) {
  const map = new Map()
  return (key) => {
    const now = Date.now()
    let e = map.get(key)
    if (!e || now - e.windowStart > windowSec * 1000) { e = { count: 0, windowStart: now }; map.set(key, e) }
    e.count++
    if (e.count > threshold) return { locked: true, retryAfter: Math.ceil((e.windowStart + windowSec * 1000 - now) / 1000) }
    return { locked: false }
  }
}

// Attach `hello` + `login` responders to a connection. `throttle` is shared across
// connections (created with makeThrottle).
export function attachLoginRpc (socket, { oprfKey, difficulty, throttle }) {
  const rpc = new ProtomuxRPC(socket)
  const peerHex = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : 'anon'
  let challenge = hcrypto.randomBytes(16)

  rpc.respond('hello', () => json({ challenge: b4a.toString(challenge, 'hex'), difficulty }))

  rpc.respond('login', (reqBuf) => {
    let req
    try { req = JSON.parse(b4a.toString(reqBuf)) } catch { return json({ error: 'bad request' }) }
    const { username, blinded, powNonce } = req || {}
    const ok = powNonce && powVerify(challenge, b4a.from(powNonce, 'hex'), difficulty)
    challenge = hcrypto.randomBytes(16) // rotate → one PoW per attempt
    if (!ok) return json({ error: 'bad proof-of-work' })
    const t = throttle((username || '') + '|' + peerHex)
    if (t.locked) return json({ error: 'locked', retryAfter: t.retryAfter })
    try {
      return json({ evaluated: b4a.toString(evaluate(oprfKey, b4a.from(blinded, 'hex')), 'hex') })
    } catch { return json({ error: 'eval failed' }) }
  })
  return rpc
}
