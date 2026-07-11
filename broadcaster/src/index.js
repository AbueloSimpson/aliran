// Aliran broadcaster — v0.1.
//
//   ingest (test pattern / RTSP / HLS / file)
//     -> ffmpeg live HLS
//     -> mirror rolling segments into an ENCRYPTED Hyperdrive
//     -> seed over Hyperswarm (clients replicate + re-seed each other)
//
// The feed identity (drive key) is stable across restarts as long as DATA_DIR persists;
// the encryption key is persisted alongside it. Share {feedKey, encryptionKey} with
// entitled clients (via the panel, or manually for testing).

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { config } from './config.js'
import { startFfmpeg, mirrorDirToDrive } from './hls.js'
import { panelClient, registerWithPanel } from './register.js'

// Persist (and reuse) the feed encryption key so the feed identity is stable.
function loadOrCreateEncryptionKey (dataDir) {
  const p = path.join(dataDir, 'feed.key')
  if (fs.existsSync(p)) return b4a.from(fs.readFileSync(p, 'utf8').trim(), 'hex')
  fs.mkdirSync(dataDir, { recursive: true })
  const key = crypto.randomBytes(32)
  fs.writeFileSync(p, b4a.toString(key, 'hex'), { mode: 0o600 })
  return key
}

async function main () {
  const store = new Corestore(config.dataDir)
  await store.ready()

  const encryptionKey = loadOrCreateEncryptionKey(config.dataDir)
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey })
  await drive.ready()

  const feedKeyHex = b4a.toString(drive.key, 'hex')
  const encKeyHex = b4a.toString(encryptionKey, 'hex')

  console.log('=== Aliran broadcaster ===')
  console.log('Stream id :', config.streamId)
  console.log('Feed key  :', feedKeyHex)
  console.log('Enc key   :', encKeyHex)
  console.log('Share {feedKey, encKey} with clients. To test locally:')
  console.log(`  node ../tools/viewer.js ${feedKeyHex} ${encKeyHex}`)
  console.log('==========================')

  // Seed the feed.
  const swarm = new Hyperswarm({ bootstrap: config.bootstrap.length ? config.bootstrap : undefined })
  swarm.on('connection', (socket) => drive.replicate(socket))
  swarm.join(drive.discoveryKey, { server: true, client: false })
  await swarm.flush()
  console.log('Seeding on the DHT…')

  // Ingest → HLS → mirror into the drive.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-hls-'))
  const stopMirror = mirrorDirToDrive(outDir, drive, { interval: 500 })
  const ff = startFfmpeg(config, outDir, {
    onExit: (code) => console.log('ffmpeg exited with code', code)
  })
  console.log('ffmpeg producing HLS in', outDir)

  // Auto-register the stream with the panel (if configured).
  let panelSwarm = null
  if (config.panelPubKey && config.publisherKey) {
    panelSwarm = new Hyperswarm({ bootstrap: config.bootstrap.length ? config.bootstrap : undefined })
    let registered = false
    panelSwarm.on('connection', async (socket) => {
      if (registered) return
      try {
        const { call } = panelClient(socket)
        await registerWithPanel(call, config.publisherKey, {
          streamId: config.streamId,
          feedKey: feedKeyHex,
          encryptionKey: encKeyHex,
          title: config.title || config.streamId,
          category: config.category ? [config.category] : [],
          isLive: true
        })
        registered = true
        console.log('Registered stream "' + config.streamId + '" with the panel.')
      } catch (err) { console.error('Panel registration failed:', err.message) }
    })
    panelSwarm.join(crypto.hash(b4a.from(config.panelPubKey, 'hex')), { client: true, server: false })
    console.log('Connecting to panel to register…')
  } else {
    console.log('No PANEL_PUBKEY/PUBLISHER_KEY set — seeding only (register manually with admin-cli).')
  }

  const shutdown = async () => {
    console.log('\nShutting down…')
    stopMirror()
    try { ff.kill('SIGINT') } catch {}
    await swarm.destroy()
    if (panelSwarm) { try { await panelSwarm.destroy() } catch {} }
    await store.close()
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => { console.error(err); process.exit(1) })
