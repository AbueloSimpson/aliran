// Aliran desktop player — Electron main process (S35).
//
// Process split: the P2P engine (@aliran/player-sdk — swarm, OPRF login, localhost
// HLS serving) runs HERE in main via EngineHost; the renderer is a plain React app
// that plays localhost/remote HLS with hls.js and talks to the engine over one narrow
// IPC pair ('aliran:msg' in, 'aliran:event' out) exposed by preload.cjs behind
// contextIsolation. The renderer has no Node access at all.
//
// TWO DISTRIBUTION FLAVORS, one codebase (mirrors the phone app's baked-vs-runtime
// descriptor paths):
//   - OPERATOR build: config/service.json exists (dev) / is baked as a resource
//     (packaged) — the panel key ships in the artifact and the app boots straight
//     to splash/login. The runtime path below is disabled (baked wins).
//   - PUBLIC build: no baked descriptor — first run shows the Connect screen, the
//     viewer enters their operator's panel public key (+ credentials), and the
//     descriptor persists in userData ('set-service'). "Change service" clears it
//     ('service-clear') and relaunches clean.

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineHost } from './engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Two instances would fight over the corestore lock (and double-join the swarm) —
// hand the second launch to the first window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main () {
  // The renderer autoplays live video on tune/zap — don't require a user gesture.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  let engine = null
  let win = null

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(() => {
    const { descriptor, source } = loadDescriptor()
    engine = new EngineHost({
      descriptor,
      descriptorSource: source,
      userData: app.getPath('userData'),
      safeStorage,
      onMessage: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('aliran:event', msg) }
    })

    ipcMain.on('aliran:msg', (_e, msg) => {
      if (msg && msg.type === 'set-service') return setService(msg)
      if (msg && msg.type === 'service-clear') return clearService()
      engine.handle(msg)
    })
    ipcMain.handle('aliran:state', () => engine.state())

    win = new BrowserWindow({
      width: 1440,
      height: 810,
      minWidth: 960,
      minHeight: 540,
      backgroundColor: descriptor?.branding?.colors?.background || '#0B1220',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.once('ready-to-show', () => win.show())
    // Any external link (docs, operator URLs) opens in the system browser, never in
    // the player window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

    // Boot the engine only when there is a descriptor to boot with; without one the
    // renderer shows the Connect screen and 'set-service' boots it later.
    if (descriptor) engine.start()
  })

  // The Connect screen's submit (public flavor): validate + persist the entered
  // panel key, boot the engine on it, confirm to the renderer. Only reachable while
  // no descriptor is active (the Connect screen is only shown then) — the engine has
  // never started, so no teardown/restart dance is needed.
  function setService (msg) {
    const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('aliran:event', m) }
    if (engine.descriptor) return // baked/stored descriptor active — ignore
    const key = String(msg.panelPubKey || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(key)) {
      send({ type: 'login-error', message: 'That does not look like a panel key — expected 64 hex characters.' })
      return
    }
    const descriptor = { panelPubKey: key, name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : 'Aliran' }
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.writeFileSync(storedDescriptorPath(), JSON.stringify(descriptor, null, 2))
    } catch (err) {
      send({ type: 'login-error', message: 'Could not save the service settings: ' + String(err?.message || err) })
      return
    }
    engine.descriptor = descriptor
    engine.descriptorSource = 'runtime'
    engine.start()
    send({ type: 'service', descriptor: engine.state().descriptor })
  }

  // "Change service": forget the runtime descriptor AND the saved credentials
  // (they belong to that panel), then relaunch into a clean first-run state — a
  // running engine (swarm + store on the old panel) is simplest replaced whole.
  function clearService () {
    if (engine.descriptorSource !== 'runtime') return // never clears a baked descriptor
    try { fs.rmSync(storedDescriptorPath(), { force: true }) } catch {}
    try {
      engine.writePrefs({ ...engine.readPrefs(), credsUser: null, credsEnc: null })
    } catch {}
    app.relaunch()
    app.quit()
  }

  // Full teardown before quit (drop the swarm + release the store lock), bounded so
  // a wedged swarm can never hold the app open.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || !engine?.player) return
    e.preventDefault()
    quitting = true
    Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 3000))])
      .finally(() => app.quit())
  })

  app.on('window-all-closed', () => app.quit())
}

function storedDescriptorPath () {
  return path.join(app.getPath('userData'), 'aliran-service.json')
}

// The operator service descriptor (panel public key + branding). Resolution order:
//   1. BAKED  — packaged resource / dev desktop/config/service.json (operator build)
//   2. RUNTIME — userData/aliran-service.json, persisted by the Connect screen
//   3. none    — the renderer shows the Connect screen (public build, first run)
function loadDescriptor () {
  const baked = [
    app.isPackaged ? path.join(process.resourcesPath, 'config', 'service.json') : null,
    path.join(__dirname, '..', 'config', 'service.json')
  ].filter(Boolean)
  for (const p of baked) {
    const d = readDescriptor(p)
    if (d) return { descriptor: d, source: 'baked' }
  }
  const stored = readDescriptor(storedDescriptorPath())
  if (stored) return { descriptor: stored, source: 'runtime' }
  return { descriptor: null, source: null }
}

function readDescriptor (p) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (d?.panelPubKey && !String(d.panelPubKey).startsWith('REPLACE_')) return d
  } catch { /* absent/invalid — try the next source */ }
  return null
}
