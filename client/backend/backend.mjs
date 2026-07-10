// Aliran client backend — runs inside the Android app via react-native-bare-kit.
//
// Bundle with:  npx bare-pack --target android --linked --out backend/app.bundle backend/backend.mjs
//
// Responsibilities (see docs/architecture.md):
//   - Open the panel's signed Hyperbee by its PINNED public key (from config), replicate,
//     and `bee.watch()` for live catalog updates.
//   - Login: PoW + blinded OPRF round-trip to the panel; derive wrapKey; verify against
//     the signed user record; unwrap the user's stream keys. Persist an encrypted session.
//   - On stream select: open the feed Hyperdrive (decrypting) + assets drive, join the
//     swarm (server+client so we re-seed), and run a localhost HTTP server with Range
//     support that maps requests to drive read streams.
//   - IPC with React Native: receive {panelPubKey}/{username,password}/{streamId};
//     send back {streams}, {port}, {status}.
//
// SCAFFOLD: the IPC loop + server skeleton are laid out; crypto (OPRF, unwrap) is TODO.

/* global BareKit */
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import http from 'bare-http1'
import b4a from 'b4a'

const IPC = BareKit.IPC

// --- tiny line-delimited JSON IPC helper -------------------------------------------
function send (msg) { IPC.write(b4a.from(JSON.stringify(msg) + '\n')) }

let store, panelBee, swarm

async function boot (panelPubKey) {
  store = new Corestore('./aliran-store') // Bare tmp/app storage path
  await store.ready()
  swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))

  panelBee = new Hyperbee(store.get({ key: b4a.from(panelPubKey, 'hex') }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await panelBee.ready()
  swarm.join(panelBee.core.discoveryKey, { client: true })

  // TODO: bee.watch() -> push updated catalog to RN on change.
  send({ type: 'ready' })
}

async function login (username, password) {
  // TODO:
  //  1. solve PoW; blind password; call panel OPRF RPC (via a protomux-rpc connection);
  //  2. rwd = unblind(response); wrapKey = Argon2id(rwd, salt from signed user record);
  //  3. verify; unwrap this user's stream keys; seal an encrypted session (Keystore on RN side);
  //  4. send the allowed stream list.
  send({ type: 'login-error', message: 'login not implemented (scaffold)' })
}

async function playStream (streamId) {
  // TODO: look up {feedKey, encryptionKey} from the replicated catalog (must be unwrapped
  // for this user), then:
  const server = http.createServer((req, res) => {
    // TODO: map req.url -> drive.createReadStream(path, { start, end }) honoring Range;
    //   set Content-Type: application/vnd.apple.mpegurl for .m3u8, video/mp4 for segments;
    //   serve /assets/* from the assets drive.
    res.writeHead(501); res.end('not implemented')
  })
  server.listen(0, '127.0.0.1', () => {
    send({ type: 'port', port: server.address().port })
  })
}

// --- IPC dispatch ------------------------------------------------------------------
let buf = ''
IPC.on('data', (data) => {
  buf += b4a.toString(data)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.panelPubKey) boot(msg.panelPubKey).catch(err => send({ type: 'error', message: String(err) }))
    else if (msg.username) login(msg.username, msg.password).catch(err => send({ type: 'error', message: String(err) }))
    else if (msg.streamId) playStream(msg.streamId).catch(err => send({ type: 'error', message: String(err) }))
  }
})
