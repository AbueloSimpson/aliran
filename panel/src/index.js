// Aliran panel node — origin of truth + login authority.
//
//   - announce on the HyperDHT under a topic derived from the panel public key
//   - replicate the signed account/catalog Hyperbee to clients (read-only)
//   - serve the login RPC: proof-of-work admission + per-(user,peer) throttling +
//     oblivious OPRF evaluation (the brute-force choke point). The panel never sees the
//     password or the OPRF result, and returns no account secrets — the client reads
//     the (replicated, signed) record itself and finalizes locally.
//
// See docs/security-model.md and docs/architecture.md.

import Hyperswarm from 'hyperswarm'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { config } from './config.js'
import { openKeys } from './keys.js'
import { openStore } from './store.js'
import { makeThrottle, attachLoginRpc } from './rpc.js'

export async function startPanel () {
  const keys = openKeys(config.dataDir)
  if (!keys) { console.error('No panel keys. Run: node src/admin-cli.js init'); process.exit(1) }

  const { store, db } = await openStore(config.dataDir, keys)
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  console.log('=== Aliran panel ===')
  console.log('Panel public key:', panelPubKey)
  console.log('====================')

  const throttle = makeThrottle(config.lockout.threshold, config.lockout.seconds)

  const sessionTtlMs = config.sessionTtlDays * 86400000
  const swarm = new Hyperswarm({ bootstrap: config.bootstrap.length ? config.bootstrap : undefined })
  swarm.on('connection', (socket) => {
    store.replicate(socket) // clients replicate the signed account/catalog DB
    attachLoginRpc(socket, { keys, difficulty: config.pow.difficulty, throttle, db, sessionTtlMs })
  })

  const topic = hcrypto.hash(keys.signing.publicKey)
  swarm.join(topic, { server: true, client: false })
  await swarm.flush()
  console.log('Panel announced on the DHT. Serving login + catalog replication…')

  const shutdown = async () => { await swarm.destroy(); await store.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  return { swarm, store, db, keys }
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  startPanel().catch((err) => { console.error(err); process.exit(1) })
}
