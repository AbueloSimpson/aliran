// Renderer entry: seed the bridge from the main process (subscribe first, snapshot
// second), apply the operator theme, then render. The index.html body carries the
// theme's default background so the seed await never flashes white.

import React from 'react'
import { createRoot } from 'react-dom/client'
import { backend } from './bridge'
import { applyTheme } from './theme'
import { App } from './App'
import './styles.css'

backend.init().then(() => {
  applyTheme(backend.descriptor)
  document.title = backend.descriptor?.name ?? 'Aliran'
  // Desktop network hint (best effort): Chromium's saveData signal is the closest
  // thing to "metered" the renderer can observe — it suspends Smooth zapping via the
  // engine's adaptive gate. Windows' real metered-connection flag isn't exposed to
  // the web platform; documented as a follow-up.
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; addEventListener?: (t: string, f: () => void) => void } }).connection
  if (conn) {
    const push = () => backend.setNetworkProfile(!!conn.saveData)
    push()
    conn.addEventListener?.('change', push)
  }
  createRoot(document.getElementById('root')!).render(<App />)
})
