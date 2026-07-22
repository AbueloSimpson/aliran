// Aliran desktop player — Electron main process (S35).
//
// Process split: the P2P engine (@aliran/player-sdk — swarm, OPRF login, localhost
// HLS serving) runs HERE in main via EngineHost; the renderer is a plain React app
// that plays localhost/remote HLS with hls.js and talks to the engine over one narrow
// IPC pair ('aliran:msg' in, 'aliran:event' out) exposed by preload.cjs behind
// contextIsolation. The renderer has no Node access at all.

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
    const descriptor = loadDescriptor()
    engine = new EngineHost({
      descriptor,
      userData: app.getPath('userData'),
      safeStorage,
      onMessage: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('aliran:event', msg) }
    })

    ipcMain.on('aliran:msg', (_e, msg) => engine.handle(msg))
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
    // renderer shows the configuration hint (state().descriptor is null).
    if (descriptor) engine.start()
  })

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

// The operator service descriptor (panel public key + branding), same contract as the
// phone app's config/service.json. Dev runs read desktop/config/service.json;
// packaged builds read it from resources (electron-builder extraResources).
function loadDescriptor () {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'config', 'service.json') : null,
    path.join(__dirname, '..', 'config', 'service.json')
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (d?.panelPubKey && !String(d.panelPubKey).startsWith('REPLACE_')) return d
    } catch { /* try the next location */ }
  }
  return null
}
