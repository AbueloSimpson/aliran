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
import { startAdminServer } from './admin-server.js'
import { loadAdmins } from './ops.js'
import { makeRing } from './activity.js'
import { makeBlobsKeyEnricher } from './blobs-key.js'
import { loadSources, makeSourcesScheduler } from './sources.js'
import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'
import { initLogging } from './log.js'

initLogging('panel')

export async function startPanel () {
  const keys = openKeys(config.dataDir)
  if (!keys) { console.error('No panel keys. Run: node src/admin-cli.js init'); process.exit(1) }

  const { store, db, assets } = await openStore(config.dataDir, keys)
  const panelPubKey = b4a.toString(keys.signing.publicKey, 'hex')
  console.log('=== Aliran panel ===')
  console.log('Panel public key:', panelPubKey)
  console.log('====================')

  const throttle = makeThrottle(config.lockout.threshold, config.lockout.seconds)
  const activity = makeRing(200) // in-memory observability feed (admin API + RPC events)

  const sessionTtlMs = config.sessionTtlDays * 86400000
  const swarm = new Hyperswarm({ bootstrap: config.bootstrap.length ? config.bootstrap : undefined })
  // Size the UDP socket buffers before announcing (core/net-tune.js). Every client
  // replicates the catalog over this single swarm, so its send buffer carries the fan-out.
  logSwarmTuning(
    await tuneSwarm(swarm, { recvBytes: config.swarmRcvBuf, sendBytes: config.swarmSndBuf }),
    (line) => console.log('[net]', line)
  )
  // blobsKey catalog enrichment (S20a): register nudges it; it opens each feed drive
  // with the panel-stored encryptionKey (async, off the RPC path) and publishes the
  // blobs-core key so keyless repeaters (S20) can mirror ciphertext.
  const enrich = makeBlobsKeyEnricher({ store, swarm, db, dataDir: config.dataDir })
  swarm.on('connection', (socket) => {
    store.replicate(socket) // clients replicate the signed account/catalog DB
    attachLoginRpc(socket, { keys, difficulty: config.pow.difficulty, throttle, db, dataDir: config.dataDir, sessionTtlMs, activity, enrich, legacyPublisher: config.legacyPublisher })
  })

  const topic = hcrypto.hash(keys.signing.publicKey)
  swarm.join(topic, { server: true, client: false })
  await swarm.flush()
  console.log('Panel announced on the DHT. Serving login + catalog replication…')
  enrich.sweep().catch(() => {}) // heal pre-upgrade records / registers missed while down

  // Admin HTTP API (in-process — the Corestore is single-writer, so it can't run
  // as a separate process next to the panel). Opt-in via ADMIN_ENABLED=1.
  let admin = null
  if (config.admin.enabled) {
    if (Object.keys(loadAdmins(config.dataDir)).length === 0) {
      console.warn('Admin API enabled but no admins exist — create one: node src/admin-cli.js add-admin <name>')
    }
    admin = await startAdminServer({ config, keys, db, assets, dataDir: config.dataDir, swarm, activity }, {
      host: config.admin.host,
      port: config.admin.port,
      sessionTtlMs: config.admin.sessionTtlHours * 3600000,
      lockout: config.lockout
    })
    console.log(`Admin dashboard + API on http://${admin.host}:${admin.port}`)
  }

  // Remote channel sources (S27): pull provider JSON feeds on their intervals and
  // materialize them as redirect-channel categories. Runs in-process for the same
  // single-writer reason as the admin API.
  const sourcesSched = makeSourcesScheduler({ config, keys, db, assets, dataDir: config.dataDir, activity })
  const sourceCount = Object.keys(loadSources(config.dataDir)).length
  if (sourceCount > 0) console.log(`Channel sources: ${sourceCount} registered — due feeds sync ~${Math.round(config.sources.bootDelayMs / 1000)}s after boot, then every tick.`)

  const shutdown = async () => { sourcesSched.close(); if (admin) await admin.close(); await enrich.close(); await swarm.destroy(); await store.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  return { swarm, store, db, keys, admin, enrich, sourcesSched }
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  startPanel().catch((err) => { console.error(err); process.exit(1) })
}
