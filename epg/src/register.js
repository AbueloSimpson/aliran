// EPG service → panel: publish the guide-drive pointer (meta/epgKey).
//
// Same challenge-sign convention as broadcaster/library registration (their
// register.js files are the reference copies — separate deployables each ship
// their own): sign hash(challenge || payload) with the Ed25519 publisher secret,
// panel verifies against the enrolled publisher entry and demands scope `epg`.
// This is the ONLY panel write this service ever makes, and it happens once at
// first boot and once per epoch rotation.

import ProtomuxRPC from 'protomux-rpc'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { authSign } from '@aliran/core'

export function panelClient (socket) {
  const rpc = new ProtomuxRPC(socket)
  const call = async (method, payload) => {
    const buf = payload === undefined ? b4a.alloc(0) : b4a.from(JSON.stringify(payload))
    return JSON.parse(b4a.toString(await rpc.request(method, buf)))
  }
  return { rpc, call }
}

// payload: { publisher, key, epoch, rotatedAt }
export async function setEpgKeyWithPanel (call, publisherSecretHex, payload) {
  const hello = await call('hello')
  const challenge = b4a.from(hello.challenge, 'hex')
  const msg = hcrypto.hash(b4a.concat([challenge, b4a.from(JSON.stringify(payload))]))
  const sig = authSign(b4a.from(publisherSecretHex, 'hex'), msg)
  const res = await call('setEpgKey', { payload, sig: b4a.toString(sig, 'hex') })
  if (res.error) throw new Error('setEpgKey failed: ' + res.error)
  return res
}
