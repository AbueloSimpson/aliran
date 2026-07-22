// Preload bridge — the ONLY surface the renderer gets (contextIsolation on, sandbox
// on, no nodeIntegration). Three calls: fire-and-forget engine messages in, engine
// events out, and one initial-state snapshot. The typed wrapper over this lives in
// renderer/src/bridge.ts; message shapes are the worklet IPC protocol (see
// main/engine.js).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aliran', {
  send: (msg) => ipcRenderer.send('aliran:msg', msg),
  state: () => ipcRenderer.invoke('aliran:state'),
  onMessage: (fn) => {
    const handler = (_event, msg) => fn(msg)
    ipcRenderer.on('aliran:event', handler)
    return () => ipcRenderer.removeListener('aliran:event', handler)
  }
})
