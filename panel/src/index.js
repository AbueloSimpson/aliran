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
import { loadAdmins, loadPublishers, legacyPublisherActiveWithNamed } from './ops.js'
import { makeRing } from './activity.js'
import { makeAnalytics } from './analytics.js'
import { makeBlobsKeyEnricher } from './blobs-key.js'
import { loadSources, makeSourcesScheduler } from './sources.js'
import { loadPackages, reconcilePackages } from './packages.js'
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

  // Legacy-publisher sunset nudge (S42): if named publishers are enrolled but the
  // shared init key is still accepted, unnamed registers keep verifying against it at
  // implicit scope '*'. Warn (never fail) so the operator sets LEGACY_PUBLISHER=0 once
  // every broadcaster carries PUBLISHER_NAME. See docs/security-model.md.
  if (legacyPublisherActiveWithNamed(config.legacyPublisher, loadPublishers(config.dataDir))) {
    const n = Object.keys(loadPublishers(config.dataDir)).length
    console.warn(`[legacy] LEGACY_PUBLISHER=1 while ${n} named publisher(s) are enrolled — the shared init key still accepts UNNAMED registers at implicit scope '*'. Set LEGACY_PUBLISHER=0 to close it once every broadcaster carries PUBLISHER_NAME.`)
  }

  // Channel packages (S44): converge every user's sealed grants with the package
  // registry before serving — the pass that also migrates pre-S44 records to the
  // provenance fields (manualGrants/packages). Idempotent: a converged deployment
  // appends nothing, so this is silent and free on every later boot.
  const pkgCount = Object.keys(loadPackages(config.dataDir)).length
  const rec = await reconcilePackages({ config, keys, db, assets, dataDir: config.dataDir })
  if (rec.users > 0) console.log(`[packages] reconciled ${pkgCount} package(s): +${rec.sealed} sealed, -${rec.removed} removed across ${rec.users} user record(s)`)
  else if (pkgCount > 0) console.log(`[packages] ${pkgCount} package(s) registered — all user grants converged`)

  const throttle = makeThrottle(config.lockout.threshold, config.lockout.seconds)
  const activity = makeRing(200) // in-memory observability feed (admin API + RPC events)
  // Privacy-preserving analytics (S48): aggregate-only counters → hourly buckets →
  // per-day rollups under DATA_DIR/analytics/. ANALYTICS_RETENTION_DAYS=0 turns the
  // whole thing off (no files, endpoints answer empty).
  const analytics = makeAnalytics({ dataDir: config.dataDir, retentionDays: config.analytics.retentionDays })

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
    attachLoginRpc(socket, { keys, difficulty: config.pow.difficulty, throttle, db, dataDir: config.dataDir, sessionTtlMs, activity, analytics, enrich, legacyPublisher: config.legacyPublisher })
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
    admin = await startAdminServer({ config, keys, db, assets, dataDir: config.dataDir, swarm, activity, analytics }, {
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

  // Analytics sampling (S48). Fast tick (5 min): the swarm connection count — every
  // open app holds the catalog connection, so this approximates "apps online" (it
  // also counts non-viewer peers like repeaters; surfaces label it approximate).
  // Slow tick (30 min + boot): catalog composition, an async bee scan kept OFF the
  // metrics path — /metrics reads the cached counts synchronously (S40 contract).
  const analyticsTimers = []
  if (analytics.enabled) {
    const scanCatalog = async () => {
      const counts = { live: 0, redirect: 0, vod: 0 }
      for await (const { value } of db.createReadStream({ gt: 'catalog/', lt: 'catalog0' })) {
        if (!value) continue
        if (value.redirect) counts.redirect++
        else if (value.type === 'vod') counts.vod++
        else counts.live++
      }
      analytics.setCatalog(counts)
    }
    analyticsTimers.push(setInterval(() => analytics.tick({ onlineApps: swarm.connections.size }), 300000))
    analyticsTimers.push(setInterval(() => scanCatalog().catch(() => {}), 1800000))
    analyticsTimers.push(setTimeout(() => scanCatalog().catch(() => {}), 20000))
    for (const t of analyticsTimers) t.unref()
    console.log(`Analytics: aggregate-only rollups in ${config.dataDir}/analytics (retention ${config.analytics.retentionDays}d). No per-user tracking exists — see docs/analytics.md.`)
  } else {
    console.log('Analytics: DISABLED (ANALYTICS_RETENTION_DAYS=0) — nothing is collected.')
  }

  const shutdown = async () => { for (const t of analyticsTimers) clearInterval(t); analytics.close(); sourcesSched.close(); if (admin) await admin.close(); await enrich.close(); await swarm.destroy(); await store.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  return { swarm, store, db, keys, admin, enrich, sourcesSched, analytics }
}

// Run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  startPanel().catch((err) => { console.error(err); process.exit(1) })
}
