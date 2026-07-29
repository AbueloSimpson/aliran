// Replicate a LIVE channel from a running broadcaster over the public DHT and serve the
// decrypted rolling window over plain HTTP, so a browser can actually play it.
//
// Two things this proves that nothing else has:
//   1. the P2P leg — a fresh store, never having seen this feed, pulls a GPU-TRANSCODED
//      production channel across the DHT
//   2. client playback — the served HLS goes into a real hls.js + Chromium stack, which is
//      the only way to answer "can the desktop shell actually play our HEVC output"
//
//   node tools/gpu-viewer-serve.mjs <panelDataDir> <streamId> [httpPort]
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import http from 'http'
import os from 'os'; import fs from 'fs'; import path from 'path'
import b4a from 'b4a'
import { driveHandler } from './lib/serve-drive.js'

const [panelDir, streamId, portArg] = process.argv.slice(2)
if (!panelDir || !streamId) { console.error('usage: node tools/gpu-viewer-serve.mjs <panelDataDir> <streamId> [port]'); process.exit(2) }
const PORT = Number(portArg || 8899)

// The panel is the source of truth for both halves of a viewer's credentials: the feedKey
// lives in the replicated catalog, the encryption key in its private secrets file.
const secrets = JSON.parse(fs.readFileSync(path.join(panelDir, 'secrets', 'streams.json'), 'utf8'))
const encryptionKey = secrets[streamId]
if (!encryptionKey) { console.error(`no stored secret for "${streamId}"`); process.exit(1) }

const feedKey = process.env.FEED_KEY
if (!feedKey) { console.error('set FEED_KEY=<hex> (read it from the panel catalog or the broadcaster API)'); process.exit(1) }

const store = new Corestore(fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-viewer-')))
await store.ready()
const replica = new Hyperdrive(store, b4a.from(feedKey, 'hex'), { encryptionKey: b4a.from(encryptionKey, 'hex') })
await replica.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (s) => replica.replicate(s))
swarm.join(replica.discoveryKey, { server: false, client: true })
console.log(`viewer joined topic for ${streamId}; feedKey ${feedKey.slice(0, 16)}…`)

// A tiny page that plays the replicated window through hls.js, so what gets exercised is the
// same transmux path the desktop shell uses — not a native <video> shortcut that would
// quietly pass for the wrong reason.
const PAGE = `<!doctype html><meta charset=utf-8><title>${streamId}</title>
<body style="background:#111;color:#eee;font:13px system-ui;margin:0;padding:12px">
<div id=s>loading hls.js…</div><video id=v controls autoplay muted style="width:100%;max-width:900px;background:#000"></video>
<pre id=log style="white-space:pre-wrap;font-size:12px"></pre>
<script src="/hls.js"></script>
<script>
const v=document.getElementById('v'),S=document.getElementById('s'),L=document.getElementById('log')
const say=(m)=>{L.textContent+=m+'\\n'}
window.__state={hlsSupported:!!(window.Hls&&Hls.isSupported()),errors:[],levels:null,playing:false}
if(!window.Hls){S.textContent='hls.js failed to load';}
else if(!Hls.isSupported()){S.textContent='hls.js reports UNSUPPORTED in this browser'}
else{
  const h=new Hls({enableWorker:false})
  h.on(Hls.Events.MANIFEST_PARSED,(e,d)=>{window.__state.levels=d.levels.map(l=>({codecs:l.videoCodec+'/'+l.audioCodec,w:l.width,h:l.height}));say('manifest: '+JSON.stringify(window.__state.levels))})
  h.on(Hls.Events.ERROR,(e,d)=>{window.__state.errors.push({type:d.type,details:d.details,fatal:d.fatal});say('ERROR '+d.type+' '+d.details+(d.fatal?' FATAL':''))})
  h.loadSource('/index.m3u8');h.attachMedia(v)
  v.addEventListener('playing',()=>{window.__state.playing=true;S.textContent='PLAYING'})
  setInterval(()=>{window.__state.t=v.currentTime;window.__state.vw=v.videoWidth;window.__state.vh=v.videoHeight},500)
}
</script>`

// Same major the desktop shell declares (hls.js ^1.6.0), so the transmux path under test is
// the one that actually ships. HLS_JS overrides the location.
const hlsPath = process.env.HLS_JS || path.join(process.cwd(), 'desktop', 'node_modules', 'hls.js', 'dist', 'hls.min.js')
const media = driveHandler(replica)
http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0]
  if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
  if (u === '/hls.js') {
    try { const js = fs.readFileSync(hlsPath); res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(js) } catch { res.writeHead(404); return res.end('hls.js not found at ' + hlsPath) }
  }
  return media(req, res)
}).listen(PORT, '127.0.0.1', () => console.log(`viewer serving http://127.0.0.1:${PORT}  (page + replicated HLS)`))
