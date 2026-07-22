// Minimal headless Aliran viewer — the SDK quickstart, runnable.
//
//   node examples/headless-player.mjs --panel-key <hex> --user demo --pass secret [--channel ch1]
//
// Logs in over the DHT (OPRF — the password never leaves this process in plaintext),
// prints the entitled lineup, resolves one channel, and serves it on localhost until
// Ctrl-C. Point any HLS player at the printed URL, e.g.:
//
//   ffplay http://127.0.0.1:PORT/index.m3u8
//
// Credentials/key can also come from the environment: ALIRAN_PANEL_KEY,
// ALIRAN_USER, ALIRAN_PASS.

import { createPlayer } from '@aliran/player-sdk'

function arg (name, envName) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return envName ? process.env[envName] : undefined
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: node examples/headless-player.mjs --panel-key <hex> --user <name> --pass <password>
                                        [--channel <streamId>] [--store <dir>]

  --panel-key   panel public key (hex) — printed by the panel at init   [ALIRAN_PANEL_KEY]
  --user        Aliran username                                         [ALIRAN_USER]
  --pass        Aliran password                                         [ALIRAN_PASS]
  --channel     stream id to play (default: first live entitled channel)
  --store       replica cache dir (default ./aliran-store — disposable)`)
  process.exit(0)
}

const panelKey = arg('panel-key', 'ALIRAN_PANEL_KEY')
const user = arg('user', 'ALIRAN_USER')
const pass = arg('pass', 'ALIRAN_PASS')
if (!panelKey || !user || !pass) {
  console.error('missing --panel-key/--user/--pass (or ALIRAN_* env). See --help.')
  process.exit(1)
}

const player = createPlayer({
  panelPubKey: panelKey,
  storeDir: arg('store') || './aliran-store'
  // Optional extras (see the README): prewarm, zapPrefetch, uploadPolicy, swarm.
})

player.on('peers', (n) => process.stdout.write(`\rpeers: ${n}   `))
player.on('status', ({ state }) => console.log('status:', state))
player.on('feed-changed', ({ streamId }) =>
  console.log(`\n${streamId}: feed rotated — same URL, reload your player`))
player.on('error', (err) => console.error('\nengine:', err.message))

console.log('connecting to the panel over the DHT…')
await player.connect()

// The swarm may still be dialing when we try — 'not connected to panel' means retry.
let streams
for (let i = 0; ; i++) {
  try {
    streams = await player.login(user, pass)
    break
  } catch (err) {
    if (i < 30 && /not connected to panel/.test(String(err.message))) {
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    throw err
  }
}

console.log(`\nentitled channels (${streams.length}):`)
for (const s of streams) {
  console.log(`  ${s.isLive ? '●' : '○'} ${s.id.padEnd(20)} ${s.title || ''}`)
}

const pick = arg('channel') || (streams.find((s) => s.isLive) || streams[0] || {}).id
if (!pick) {
  console.error('no entitled channels for this user')
  await player.stop()
  process.exit(1)
}

console.log(`\nresolving '${pick}'…`)
const r = await player.resolve(pick)
if (r.source === 'cdn') {
  console.log(`redirect channel — play the remote URL directly:\n\n  ${r.url}\n`)
} else {
  console.log(`serving over P2P — point any HLS player at:\n\n  ffplay ${r.url}\n`)
}
console.log('Ctrl-C to stop.')

process.on('SIGINT', async () => {
  console.log('\nstopping…')
  await player.stop()
  process.exit(0)
})
