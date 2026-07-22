// Library → panel title registration (authenticated with the publisher key).
//
// Self-contained copy of broadcaster/src/register.js — same rationale as the control
// auth/server skeleton (see control-auth.js): panel, broadcaster and library are
// separate deployables, so each ships its own copy. If you fix a bug here, fix it there.
//
// The library signs hash(challenge || payload) with the Ed25519 publisher secret;
// the panel verifies against its stored publisher public key, then writes the public
// catalog record and stores the encryption key in its private secrets.

import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { authSign } from '@aliran/core'

// Wrap a connection to the panel as a JSON RPC caller (same shape as the client's).
export function panelClient (socket) {
  const rpc = new ProtomuxRPC(socket)
  const call = async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    return JSON.parse(b4a.toString(await rpc.request(method, buf)))
  }
  return { rpc, call }
}

export async function registerWithPanel (call, publisherSecretHex, payload) {
  const hello = await call('hello')
  const challenge = b4a.from(hello.challenge, 'hex')
  const msg = hcrypto.hash(b4a.concat([challenge, b4a.from(JSON.stringify(payload))]))
  const sig = authSign(b4a.from(publisherSecretHex, 'hex'), msg)
  const res = await call('register', { payload, sig: b4a.toString(sig, 'hex') })
  if (res.error) throw new Error('register failed: ' + res.error)
  return res
}
