// Settings — account, playback (the "Smooth zapping" switch, S21), service info,
// live diagnostics (active source + peers + entitled count), sign out. Sign out
// clears the saved (safeStorage-wrapped) credentials so the next boot lands on
// Login instead of auto-authorizing.

import React, { useEffect, useState } from 'react'
import { backend } from '../bridge'

export function SettingsScreen ({ onSignOut, onBack }: { onSignOut: () => void; onBack: () => void }) {
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'prefs') {
        setUsername(m.creds?.username ?? null)
        setSmoothZap(m.smoothZapping ?? false)
      }
      if (m.type === 'streams') setChannels(m.streams.length)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
      if (m.type === 'port' && m.source) setSource(m.source)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onBack() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  function toggleSmoothZap () {
    const next = !smoothZap
    setSmoothZap(next) // optimistic; the 'prefs' reply confirms
    backend.setZapPrefetch(next)
  }

  function signOut () {
    backend.clearCredentials()
    backend.streams = [] // drop the session's display list; a fresh login rebuilds it
    onSignOut()
  }

  const d = backend.descriptor
  return (
    <div className="settings">
      <div className="section-header">SETTINGS</div>

      <div className="settings-group-title">ACCOUNT</div>
      <div className="settings-group">
        <Row label="Signed in as" value={username ?? '—'} />
        <Row label="Entitled channels" value={String(channels)} />
      </div>

      <div className="settings-group-title">PLAYBACK</div>
      <div className="settings-group">
        <div className="toggle-row" role="switch" aria-checked={smoothZap} onClick={toggleSmoothZap}>
          <span className="toggle-texts">
            <span className="row-label">Smooth zapping</span>
            <span className="toggle-hint">Preloads nearby channels while you watch, so channel surfing starts instantly. Uses more data; pauses itself on constrained connections or when your stream is struggling.</span>
          </span>
          <span className={'toggle-pill' + (smoothZap ? ' on' : '')}>{smoothZap ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      <div className="settings-group-title">SERVICE</div>
      <div className="settings-group">
        <Row label="Service" value={d?.name ?? '—'} />
        <Row label="Panel key" value={(d?.panelPubKey ?? '').slice(0, 16) + '…'} />
        <Row label="Playback" value="p2p-only" />
      </div>

      <div className="settings-group-title">DIAGNOSTICS</div>
      <div className="settings-group">
        <Row label="Active source" value={source ? source.toUpperCase() : '—'} />
        <Row label="Peers" value={peers != null ? String(peers) : '—'} />
      </div>

      <button className="signout" onClick={signOut}>Sign out</button>
      <div className="signout-hint">Sign out forgets the saved sign-in on this device. · Esc back</div>

      {/* Public build only (the runtime-entered service): forget the panel key +
          credentials and restart to the Connect screen. Operator builds bake their
          descriptor into the artifact — nothing to change. */}
      {backend.descriptorSource === 'runtime' && (
        <>
          <button className="change-service" onClick={() => backend.clearService()}>Change service…</button>
          <div className="signout-hint">Forgets this service's panel key and sign-in, then restarts the app.</div>
        </>
      )}
    </div>
  )
}

function Row ({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </div>
  )
}
