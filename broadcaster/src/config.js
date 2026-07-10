// Broadcaster config (env-driven). Mirrors panel/src/config.js style.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadDotEnv () {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
loadDotEnv()

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10))

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  panelPubKey: process.env.PANEL_PUBKEY || null,
  streamId: process.env.STREAM_ID || 'default',
  input: process.env.INPUT || 'rtmp',
  rtmpPort: int(process.env.RTMP_PORT, 1935),
  hls: { time: int(process.env.HLS_TIME, 2), listSize: int(process.env.HLS_LIST_SIZE, 6) },
  protection: process.env.PROTECTION || 'self',
  bootstrap: (process.env.BOOTSTRAP || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

export default config
