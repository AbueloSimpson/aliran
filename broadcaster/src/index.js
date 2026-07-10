// Aliran broadcaster — content origin.
//
// Pipeline (see docs/architecture.md):
//   ingest (OBS RTMP / RTSP / HLS / file)
//     -> ffmpeg transcode to live HLS   (PROTECTION=self)
//        or multi-DRM packager to CENC   (PROTECTION=drm)
//     -> write rolling segments into an ENCRYPTED Hyperdrive
//     -> seed over Hyperswarm; clients replicate + re-seed each other
//   -> register the stream (feedKey, encryptionKey, metadata) with the panel
//
// SCAFFOLD: drive/swarm wiring is laid out; the ffmpeg spawn + directory->drive mirror
// and the panel registration RPC are marked TODO.

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { config } from './config.js'

async function main () {
  if (!config.panelPubKey) {
    console.warn('PANEL_PUBKEY not set — the stream will seed but will not be registered in a catalog.')
  }

  const store = new Corestore(config.dataDir)
  await store.ready()

  // The feed: an ENCRYPTED Hyperdrive. The encryption key is shared only with
  // entitled clients (via the panel). Persist/reuse it across restarts.
  const encryptionKey = crypto.randomBytes(32) // TODO: persist in DATA_DIR and reuse
  const drive = new Hyperdrive(store.namespace('feed'), { encryptionKey })
  await drive.ready()

  console.log('Feed key       :', b4a.toString(drive.key, 'hex'))
  console.log('Encryption key :', b4a.toString(encryptionKey, 'hex'), '(share only via the panel)')

  const swarm = new Hyperswarm({
    bootstrap: config.bootstrap.length ? config.bootstrap : undefined
  })
  swarm.on('connection', (socket) => {
    // TODO (optional): check the peer against the panel allowlist before replicating
    // (best-effort bandwidth gate; encryption is the hard gate).
    drive.replicate(socket)
  })
  swarm.join(drive.discoveryKey, { server: true, client: false })
  await swarm.flush()
  console.log('Seeding feed on the DHT…')

  // --- Ingest + packaging -------------------------------------------------------
  // TODO:
  //  1. Resolve INPUT:
  //     - 'rtmp'  -> start an RTMP listener (e.g. node-media-server) on RTMP_PORT for OBS
  //     - rtsp/http/file -> pass directly to ffmpeg -i
  //  2. PROTECTION=self: spawn ffmpeg ->
  //       ffmpeg -re -i <INPUT> -c:v libx264 -c:a aac -f hls \
  //         -hls_time <HLS_TIME> -hls_list_size <HLS_LIST_SIZE> \
  //         -hls_flags delete_segments+append_list -hls_segment_type fmp4 out/index.m3u8
  //     PROTECTION=drm: run a CENC/CMAF multi-DRM packager instead (CPIX vendor keys).
  //  3. Watch out/ and mirror new/changed files into the drive:
  //       drive.put('/index.m3u8', ...); drive.put('/segN.m4s', ...)
  //     Delete old segments from the drive to keep it small.
  //
  // registerWithPanel({ feedKey: drive.key, encryptionKey, streamId: config.streamId })

  console.log('[stub] ffmpeg ingest + drive mirror not wired yet — see TODO in src/index.js.')

  process.on('SIGINT', async () => {
    console.log('\nShutting down…')
    await swarm.destroy()
    await store.close()
    process.exit(0)
  })
}

// TODO: connect to the panel by PANEL_PUBKEY over the DHT and call an authenticated
// `register-stream` RPC (or write via a shared admin credential).
// async function registerWithPanel ({ feedKey, encryptionKey, streamId }) { ... }

main().catch((err) => { console.error(err); process.exit(1) })
