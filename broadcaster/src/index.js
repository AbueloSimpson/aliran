// Aliran broadcaster — multi-channel node (S12a).
//
//   channel = ingest (test pattern / RTSP / HLS / file)
//     -> ffmpeg live HLS
//     -> mirror rolling segments into an ENCRYPTED Hyperdrive
//     -> seed over Hyperswarm (clients replicate + re-seed each other)
//     -> auto-register with the panel (publisher-key auth)
//
// Channels are runtime start/stoppable via the ChannelManager (src/channel.js) and,
// when CONTROL_ENABLED=1, over the authed HTTP control API (src/control-server.js).
//
// Back-compat: with the control API disabled this behaves exactly like the old
// single-stream broadcaster — the env-configured channel (STREAM_ID/INPUT/...) keeps
// the legacy DATA_DIR-root store + feed.key, so existing feed identities and
// pre-seeded feed.key files keep working. With the control API enabled, the env
// channel is auto-started only if STREAM_ID is explicitly set.

import { config } from './config.js'
import { ChannelManager, isPushInput, pushUrl } from './channel.js'
import { startControlServer } from './control-server.js'
import { loadAdmins } from './control-auth.js'

async function main () {
  const manager = new ChannelManager(config)
  // init() only PREPARES (loads the registry, warms probes, connects the panel link). The
  // auto-resume is run LAST, via manager.resumeAll() below, AFTER the control server is
  // listening — otherwise resuming a large fleet blocks the boot before the server ever binds,
  // so /healthz and /api are dead for the whole ~minutes-long ramp and monitoring reads it as
  // an outage. Order now: prepare → start control server → (env channel) → paced resume.
  await manager.init({ resume: false })

  let control = null
  if (config.control.enabled) {
    if (Object.keys(loadAdmins(config.dataDir)).length === 0) {
      console.warn('Control API enabled but no admins exist — create one: node src/control-cli.js add-admin <name>')
    }
    control = await startControlServer({ config, manager, dataDir: config.dataDir }, {
      host: config.control.host,
      port: config.control.port,
      sessionTtlMs: config.control.sessionTtlHours * 3600000,
      lockout: config.lockout
    })
    console.log(`Control API on http://${control.host}:${control.port}`)
  }

  // The env-configured channel. Always started in legacy mode (no control API);
  // with the API enabled it starts only when STREAM_ID is explicitly configured.
  const wantEnvChannel = !config.control.enabled || process.env.STREAM_ID !== undefined
  if (wantEnvChannel) {
    const ch = await manager.ensureLegacy({
      id: config.streamId,
      title: config.title,
      category: config.category,
      input: config.input,
      hls: config.hls,
      protection: config.protection
    })
    const { feedKey, encryptionKey } = await manager.start(ch.meta.id)

    console.log('=== Aliran broadcaster ===')
    console.log('Stream id :', ch.meta.id)
    console.log('Feed key  :', feedKey)
    console.log('Enc key   :', encryptionKey)
    if (isPushInput(ch.meta.input)) {
      console.log('Push URL  :', pushUrl(ch.meta.input, config.publicHost))
      console.log(`            (waiting for a publisher; set the encoder keyframe interval to ${ch.meta.hls.time}s)`)
    }
    console.log('Share {feedKey, encKey} with clients. To test locally:')
    console.log(`  node ../tools/viewer.js ${feedKey} ${encryptionKey}`)
    console.log('==========================')
    console.log('Seeding on the DHT…')
    if (config.panelPubKey && config.publisherKey) console.log('Connecting to panel to register…')
    else console.log('No PANEL_PUBKEY/PUBLISHER_KEY set — seeding only (register manually with admin-cli).')
  } else if (control) {
    console.log('No STREAM_ID in the environment — channels are managed via the control API.')
  }

  // Auto-resume the persisted desired-running channels LAST, with the control server already
  // listening so /healthz reports {resuming, resumed, total} throughout and /api comes alive
  // channel-by-channel as the (paced) ramp proceeds. Not awaited-before-serving on purpose.
  manager.resumeAll().catch((err) => console.error('boot resume error:', err))

  const shutdown = async () => {
    console.log('\nShutting down…')
    if (control) { try { await control.close() } catch {} }
    await manager.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => { console.error(err); process.exit(1) })
