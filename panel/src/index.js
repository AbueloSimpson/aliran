// Aliran panel node — origin of truth.
//
// Responsibilities (see docs/architecture.md and docs/security-model.md):
//   1. Open the single-writer, panel-SIGNED Hyperbee (accounts + catalog).
//   2. Open the assets Hyperdrive (posters/art).
//   3. Announce on the Hyperswarm DHT under a topic derived from the panel key so
//      clients can find us by public key (no IP/DNS).
//   4. Replicate the account/catalog DB + assets read-only to clients.
//   5. Serve the throttled OPRF login RPC (the brute-force choke point) and issue
//      session/entitlement tokens.
//
// This file is a SCAFFOLD: the wiring and TODOs are laid out; the crypto-sensitive
// pieces (OPRF, key wrapping, token signing) must be implemented carefully — prefer
// vetted libraries. Do not ship the stubbed handlers as-is.

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { config } from './config.js'
import { openKeys } from './keys.js'

async function main () {
  const keys = openKeys(config.dataDir) // loads panel signing + OPRF keys (run `admin-cli init` first)
  if (!keys) {
    console.error('No panel keys found. Run:  node src/admin-cli.js init')
    process.exit(1)
  }

  const store = new Corestore(config.dataDir)
  await store.ready()

  // Account + catalog DB: single-writer, signed by the panel key.
  const dbCore = store.get({ keyPair: keys.signing })
  const db = new Hyperbee(dbCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await db.ready()

  // Assets drive (posters/backdrops/logos), also panel-owned.
  const assets = new Hyperdrive(store.namespace('assets'))
  await assets.ready()

  console.log('Panel public key:', b4a.toString(keys.signing.publicKey, 'hex'))
  console.log('Assets drive key:', b4a.toString(assets.key, 'hex'))
  console.log('Give the panel public key to clients (build config or service descriptor).')

  // Discovery + replication.
  const swarm = new Hyperswarm({
    bootstrap: config.bootstrap.length ? config.bootstrap : undefined
    // TODO: relayOnly -> configure DHT so peers cannot observe the origin IP.
  })
  swarm.on('connection', (socket) => {
    store.replicate(socket) // replicates the DB + assets read-only to clients
    attachRpc(socket)       // OPRF login + token endpoints
  })

  const topic = crypto.hash(keys.signing.publicKey) // clients join the same topic
  swarm.join(topic, { server: true, client: false })
  await swarm.flush()
  console.log('Panel announced on the DHT. Waiting for clients…')

  // --- Login / OPRF RPC ---------------------------------------------------------
  function attachRpc (socket) {
    // TODO: wrap `socket` with protomux-rpc and register handlers:
    //
    //   rpc.respond('login', async (req) => {
    //     // req = { username, blindedPassword, pow }
    //     // 1. verify PoW (config.pow.difficulty)
    //     // 2. check per-(username, remotePublicKey) lockout (config.lockout)
    //     // 3. evaluate OPRF: return OPRF(oprfKey, blindedPassword)
    //     //    -> never returns account secrets; client derives rwd + verifies
    //     // 4. on repeated failure -> increment lockout counter
    //   })
    //
    //   rpc.respond('refresh', ...)      // sliding session token (device-key auth)
    //   rpc.respond('entitlement', ...)  // signed JWT for DRM/geo (when enabled)
    //
    // Implement OPRF with sodium-native ristretto255 scalar mult, or a vetted
    // OPAQUE/OPRF library. See docs/security-model.md.
  }

  process.on('SIGINT', async () => {
    console.log('\nShutting down…')
    await swarm.destroy()
    await store.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
