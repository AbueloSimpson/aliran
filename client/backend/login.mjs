// Client login protocol — runtime-agnostic (runs in Bare and in Node tests).
//
// Given an RPC call function to the panel and the replicated signed DB, performs the
// OPRF login and returns the streams the user may watch (with their decryption keys).
// No plaintext password ever leaves the device; only a blinded point does.

import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import { blind, finalize, verify, wrapKeyFrom, unwrap, sealOpen, powSolve } from '@aliran/core'

// Wrap a connection to the panel as a JSON RPC caller.
export function panelClient (socket) {
  const rpc = new ProtomuxRPC(socket)
  const call = async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    const res = await rpc.request(method, buf)
    return JSON.parse(b4a.toString(res))
  }
  return { rpc, call }
}

export async function login (call, db, username, password) {
  // 1. proof-of-work challenge from the panel
  const hello = await call('hello')
  const nonce = powSolve(b4a.from(hello.challenge, 'hex'), hello.difficulty)

  // 2. blinded OPRF round-trip (panel never sees the password)
  const { blinded, r } = blind(password)
  const res = await call('login', { username, blinded: b4a.toString(blinded, 'hex'), powNonce: b4a.toString(nonce, 'hex') })
  if (res.error) throw new Error('login failed: ' + res.error + (res.retryAfter ? ` (retry ${res.retryAfter}s)` : ''))
  const rwd = finalize(password, r, b4a.from(res.evaluated, 'hex'))

  // 3. verify against the replicated signed record (local)
  const node = await db.get('user/' + username)
  if (!node) throw new Error('unknown user')
  const user = node.value
  if (!verify(rwd, b4a.from(user.salt, 'hex'), b4a.from(user.verifier, 'hex'), user.argon)) {
    throw new Error('invalid credentials')
  }

  // 4. recover the private key and open the granted stream keys
  const priv = unwrap(wrapKeyFrom(rwd), user.encPriv)
  if (!priv) throw new Error('key recovery failed')
  const streams = []
  for (const id of Object.keys(user.wrapped || {})) {
    const enc = sealOpen(b4a.from(user.pub, 'hex'), priv, user.wrapped[id])
    const cat = await db.get('catalog/' + id)
    if (enc && cat) {
      streams.push({
        id,
        title: cat.value.title,
        description: cat.value.description,
        category: cat.value.category,
        isLive: cat.value.isLive,
        poster: cat.value.poster,
        feedKey: cat.value.feedKey,
        encryptionKey: b4a.toString(enc, 'hex')
      })
    }
  }
  return { streams, tokenVersion: user.tokenVersion }
}
