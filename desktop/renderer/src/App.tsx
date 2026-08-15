// App root — the screen state machine (no router dep; the phone app's stack mapped
// to plain state):
//
//   connect (PUBLIC build first run: enter the operator's panel key + account)
//   splash  (auto-auth with saved credentials)
//     ├─ login   (exception path: none saved / auth failed)
//     └─ menu    (hub: icon bar over the featured stream's wallpaper)
//          ├─ live        one fullscreen video surface + browse/detail overlays
//          ├─ guide       the full EPG time-grid (WS4) — also reachable from Live's
//          │              channel list (OK on the already-playing row); tuning a
//          │              channel there lands back in Live playing it
//          ├─ vod         Movies & Series from the operator's external provider (S53;
//          │              the tile only exists while the panel delivers an enabled
//          │              provider config) → vodSeries (a series' seasons/episodes,
//          │              S54d) → vodPlayer, a plain <video>/hls.js surface
//          ├─ favorites   device-local ★ channels
//          ├─ search      client-side catalog filter
//          └─ settings    account / service / diagnostics / sign out
//
// Which door the app opens through depends on the descriptor source: an operator
// build ships one in the artifact (never sees 'connect'); the public build starts
// on 'connect' until a key is saved, then behaves identically.

import React, { useEffect, useState } from 'react'
import { backend } from './bridge'
import { applyTheme } from './theme'
import { ConnectScreen } from './screens/ConnectScreen'
import { SplashScreen } from './screens/SplashScreen'
import { LoginScreen } from './screens/LoginScreen'
import { MenuScreen, type MenuTarget } from './screens/MenuScreen'
import { LiveScreen } from './screens/LiveScreen'
import { GuideScreen } from './screens/GuideScreen'
import { FavoritesScreen } from './screens/FavoritesScreen'
import { SearchScreen } from './screens/SearchScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { VodScreen, type VodPick } from './screens/VodScreen'
import { VodSeriesScreen, type VodSeriesPick } from './screens/VodSeriesScreen'
import { VodPlayerScreen } from './screens/VodPlayerScreen'

type Screen = 'connect' | 'splash' | 'login' | 'menu' | 'live' | 'guide' | 'favorites' | 'search' | 'settings' | 'vod' | 'vodSeries' | 'vodPlayer'

export function App () {
  // A renderer reload mid-session (dev Ctrl+R) still has the engine logged in —
  // resume straight into the app instead of re-authorizing. No descriptor at all
  // (public build, first run) → the Connect screen owns onboarding.
  const [screen, setScreen] = useState<Screen>(() => (backend.streams.length ? 'live' : backend.descriptor ? 'splash' : 'connect'))
  const [authorizing, setAuthorizing] = useState(!!backend.creds)
  // A channel picked in Favorites/Search jumps into Live playing it. The Guide's
  // tune also carries the active category chip — the tune's browsing context
  // (Phase 4): Live records it as the zap/reopen scope. Favorites/Search pass no
  // category; Live derives the scope from the channel's own filing.
  const [liveStart, setLiveStart] = useState<string | undefined>(undefined)
  const [liveStartCategory, setLiveStartCategory] = useState<string | undefined>(undefined)
  // The provider title the VOD grid (or a series' episode list) resolved
  // (url/title/runtime + the id the player writes watch history under). The grid does
  // the getMovieInfo call, so the player screen holds no provider credentials at all.
  const [vodPick, setVodPick] = useState<VodPick | null>(null)
  // The series whose detail page is open (S54d, design D6) — the desktop equivalent of
  // the phone app's VodSeries route.
  const [seriesPick, setSeriesPick] = useState<VodSeriesPick | null>(null)
  // Guide context (WS4): the channel Live was playing when it opened the guide (the
  // grid's mount row + NOW pill target; null from the Menu tile), and where Esc
  // returns to — the desktop stand-in for the phone stack's pop-back.
  const [guideCtx, setGuideCtx] = useState<{ streamId: string | null; from: 'menu' | 'live' }>({ streamId: null, from: 'menu' })

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') setScreen((s) => (s === 'connect' || s === 'splash' || s === 'login' ? 'live' : s))
      if (m.type === 'login-error') setScreen((s) => (s === 'splash' ? 'login' : s))
      if (m.type === 'ready') setAuthorizing(!!backend.creds)
      // Runtime descriptor accepted (Connect screen): brand colors/name may differ.
      if (m.type === 'service') { applyTheme(m.descriptor); document.title = m.descriptor.name ?? 'Aliran' }
    })
  }, [])

  const watch = (streamId: string, category?: string) => { setLiveStart(streamId); setLiveStartCategory(category); setScreen('live') }
  const toMenu = () => { setLiveStart(undefined); setLiveStartCategory(undefined); setScreen('menu') }

  const go = (target: MenuTarget) => {
    if (target === 'exit') { window.close(); return }
    if (target === 'live') { setLiveStart(undefined); setLiveStartCategory(undefined) }
    if (target === 'guide') setGuideCtx({ streamId: null, from: 'menu' })
    setScreen(target)
  }

  if (screen === 'connect') return <ConnectScreen />
  if (screen === 'splash') return <SplashScreen authorizing={authorizing} />
  if (screen === 'login') return <LoginScreen />
  if (screen === 'menu') return <MenuScreen onGo={go} />
  if (screen === 'guide') {
    return (
      <GuideScreen
        playingId={guideCtx.streamId}
        // Tuning navigates into Live playing the pick — the same watch() jump
        // Favorites/Search make. LiveScreen is keyed on liveStart, so a value-equal
        // re-tune still lands as a fresh mount (the client's tuneKey concern is a
        // remount here).
        onTune={watch}
        onBack={() => setScreen(guideCtx.from)}
      />
    )
  }
  if (screen === 'favorites') return <FavoritesScreen onWatch={watch} onBack={toMenu} />
  if (screen === 'search') return <SearchScreen onWatch={watch} onBack={toMenu} />
  if (screen === 'settings') return <SettingsScreen onBack={toMenu} onSignOut={() => setScreen('login')} />
  const vodGrid = (
    <VodScreen
      onPlay={(pick) => { setVodPick(pick); setScreen('vodPlayer') }}
      onOpenSeries={(pick) => { setSeriesPick(pick); setScreen('vodSeries') }}
      onBack={toMenu}
    />
  )
  if (screen === 'vod') return vodGrid
  if (screen === 'vodSeries') {
    if (!seriesPick) return vodGrid
    return (
      <VodSeriesScreen
        key={seriesPick.id}
        pick={seriesPick}
        onPlay={(pick) => { setVodPick(pick); setScreen('vodPlayer') }}
        onBack={() => setScreen('vod')}
      />
    )
  }
  if (screen === 'vodPlayer') {
    // No pick can only happen if a reload lands here — fall back to the grid rather
    // than a blank surface.
    if (!vodPick) return vodGrid
    return (
      <VodPlayerScreen
        key={vodPick.url}
        url={vodPick.url}
        title={vodPick.title}
        durationSec={vodPick.durationSec}
        id={vodPick.id}
        kind={vodPick.kind}
        seriesId={vodPick.seriesId}
        resumeSec={vodPick.resumeSec}
        // An episode goes back to the series it belongs to; a movie to the grid.
        onBack={() => setScreen(vodPick.kind === 'episode' && seriesPick ? 'vodSeries' : 'vod')}
      />
    )
  }
  return (
    <LiveScreen
      key={liveStart ?? 'live'}
      initialStreamId={liveStart}
      initialCategory={liveStartCategory}
      onExit={toMenu}
      // Two-tier OK (WS4): the channel list's already-playing row opens the guide
      // anchored on that channel; Esc there returns here. The jump props are
      // CLEARED for the round trip: Live remounts on Esc-back, and a stale
      // liveStart/liveStartCategory from an earlier Favorites/Search/Guide jump
      // would re-tune the OLD channel and rewrite the tune scope from a dead
      // prop — resuming via Live's own session memory (lastStreamId +
      // lastTuneScope) is the current state.
      onGuide={(streamId) => { setLiveStart(undefined); setLiveStartCategory(undefined); setGuideCtx({ streamId, from: 'live' }); setScreen('guide') }}
    />
  )
}
