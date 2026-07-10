// Desktop P2P viewer / test harness.
//
//   node tools/viewer.js <feedKeyHex> <encryptionKeyHex> [--port 0]
//
// Replicates a broadcaster's encrypted feed over Hyperswarm (downloading AND re-seeding),
// then serves it on http://127.0.0.1:<port>/index.m3u8 so you can play it in VLC / a
// browser, or validate it with ffprobe. This is the reference behavior the client's Bare
// worklet mirrors — proving the whole P2P path without an Android build.

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import http from 'http'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import { driveHandler } from './lib/serve-drive.js'

const [feedKeyHex, encKeyHex] = process.argv.slice(2)
const portArgIdx = process.argv.indexOf('--port')
const wantPort = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 0

if (!feedKeyHex || !encKeyHex) {
  console.error('Usage: node tools/viewer.js <feedKeyHex> <encryptionKeyHex> [--port N]')
  process.exit(1)
}

async function main () {
  // Ephemeral store so the viewer is a fresh peer each run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-viewer-'))
  const store = new Corestore(dir)
  await store.ready()

  const drive = new Hyperdrive(store, b4a.from(feedKeyHex, 'hex'), {
    encryptionKey: b4a.from(encKeyHex, 'hex')
  })
  await drive.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => drive.replicate(socket))
  // server:true too -> we re-seed to other viewers (the mesh).
  swarm.join(drive.discoveryKey, { server: true, client: true })
  console.log('Joining swarm, waiting for peers…')
  await swarm.flush()

  const server = http.createServer(driveHandler(drive))
  await new Promise((resolve) => server.listen(wantPort, '127.0.0.1', resolve))
  const port = server.address().port
  console.log(`\nViewer ready:  http://127.0.0.1:${port}/index.m3u8`)
  console.log('Open that URL in VLC or a browser, or validate with ffprobe.')

  const shutdown = async () => {
    server.close(); await swarm.destroy(); await store.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => { console.error(err); process.exit(1) })
