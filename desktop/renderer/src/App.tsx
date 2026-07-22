// App root — the screen state machine (no router dep; the phone app's stack mapped
// to plain state):
//
//   splash (auto-auth with saved credentials)
//     ├─ login   (exception path: none saved / auth failed)
//     └─ menu    (hub: icon bar over the featured stream's wallpaper)
//          ├─ live        one fullscreen video surface + browse/detail overlays
//          ├─ favorites   device-local ★ channels
//          ├─ search      client-side catalog filter
//          └─ settings    account / service / diagnostics / sign out
//
// A configured service descriptor is the app's only prerequisite: without one
// (desktop/config/service.json missing) it shows the setup hint instead.

import React, { useEffect, useState } from 'react'
import { backend } from './bridge'
import { SplashScreen } from './screens/SplashScreen'
import { LoginScreen } from './screens/LoginScreen'
import { MenuScreen, type MenuTarget } from './screens/MenuScreen'
import { LiveScreen } from './screens/LiveScreen'
import { FavoritesScreen } from './screens/FavoritesScreen'
import { SearchScreen } from './screens/SearchScreen'
import { SettingsScreen } from './screens/SettingsScreen'

type Screen = 'splash' | 'login' | 'menu' | 'live' | 'favorites' | 'search' | 'settings'

export function App () {
  // A renderer reload mid-session (dev Ctrl+R) still has the engine logged in —
  // resume straight into the app instead of re-authorizing.
  const [screen, setScreen] = useState<Screen>(() => (backend.streams.length ? 'live' : 'splash'))
  const [authorizing, setAuthorizing] = useState(!!backend.creds)
  // A channel picked in Favorites/Search jumps into Live playing it.
  const [liveStart, setLiveStart] = useState<string | undefined>(undefined)

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

  const watch = (streamId: string) => { setLiveStart(streamId); setScreen('live') }
  const toMenu = () => { setLiveStart(undefined); setScreen('menu') }

  const go = (target: MenuTarget) => {
    if (target === 'exit') { window.close(); return }
    if (target === 'live') setLiveStart(undefined)
    setScreen(target)
  }

  if (screen === 'splash') return <SplashScreen authorizing={authorizing} />
  if (screen === 'login') return <LoginScreen />
  if (screen === 'menu') return <MenuScreen onGo={go} />
  if (screen === 'favorites') return <FavoritesScreen onWatch={watch} onBack={toMenu} />
  if (screen === 'search') return <SearchScreen onWatch={watch} onBack={toMenu} />
  if (screen === 'settings') return <SettingsScreen onBack={toMenu} onSignOut={() => setScreen('login')} />
  return <LiveScreen key={liveStart ?? 'live'} initialStreamId={liveStart} onExit={toMenu} />
}
