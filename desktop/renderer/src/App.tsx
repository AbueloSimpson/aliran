// App root — the screen state machine (no router dep; the phone app's stack mapped
// to plain state):
//
//   splash (auto-auth with saved credentials)
//     ├─ login   (exception path: none saved / auth failed)
//     └─ menu    (hub — grows the full section bar in Stage B)
//          └─ live  (one fullscreen video surface + overlays)
//
// A configured service descriptor is the app's only prerequisite: without one
// (desktop/config/service.json missing) it shows the setup hint instead.

import React, { useEffect, useState } from 'react'
import { backend } from './bridge'
import { SplashScreen } from './screens/SplashScreen'
import { LoginScreen } from './screens/LoginScreen'
import { LiveScreen } from './screens/LiveScreen'

type Screen = 'splash' | 'login' | 'menu' | 'live'

export function App () {
  // A renderer reload mid-session (dev Ctrl+R) still has the engine logged in —
  // resume straight into the app instead of re-authorizing.
  const [screen, setScreen] = useState<Screen>(() => (backend.streams.length ? 'live' : 'splash'))
  const [authorizing, setAuthorizing] = useState(!!backend.creds)

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setScreen((s) => (s === 'splash' || s === 'login' ? 'live' : s))
      if (m.type === 'login-error') setScreen((s) => (s === 'splash' ? 'login' : s))
      if (m.type === 'ready') setAuthorizing(!!backend.creds)
    })
  }, [])

  if (!backend.descriptor) {
    return (
      <div className="setup-hint">
        <h1>Aliran desktop player</h1>
        <p>No service descriptor found. Copy <code>desktop/config/service.example.json</code> to <code>desktop/config/service.json</code> and set your operator's <code>panelPubKey</code>, then restart.</p>
      </div>
    )
  }

  if (screen === 'splash') return <SplashScreen authorizing={authorizing} />
  if (screen === 'login') return <LoginScreen />
  if (screen === 'menu') return <MenuStub onLive={() => setScreen('live')} />
  return <LiveScreen onExit={() => setScreen('menu')} />
}

// Minimal hub for Stage A — Stage B replaces it with the reference's icon-bar-over-
// wallpaper MenuScreen (sections data-driven from the descriptor).
function MenuStub ({ onLive }: { onLive: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onLive() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLive])
  return (
    <div className="menu-stub" onClick={onLive}>
      <div className="menu-stub-wordmark">{backend.descriptor?.name ?? 'Aliran'}</div>
      <div className="menu-stub-hint">Enter — Live TV</div>
    </div>
  )
}
