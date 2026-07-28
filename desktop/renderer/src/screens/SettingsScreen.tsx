// Settings — account, playback (the "Smooth zapping" switch, S21), service info,
// live diagnostics (active source + peers + entitled count), sign out. Sign out
// clears the saved (safeStorage-wrapped) credentials so the next boot lands on
// Login instead of auto-authorizing.
//
// "Report a problem" is NOT here (S51): it lives on the player (NowPlayingBar's
// Report button / the `r` key), because a useful report must carry the channel
// being watched — which Settings cannot know.

import React, { useEffect, useState } from 'react'
import { backend } from '../bridge'
import { clearPin, hasPin, hideRestricted, setHideRestricted } from '../parental'
import { PinEntryModal, PinSetupModal } from '../components/PinModal'

// Parental modal state machine: set up a new PIN, change it, or verify the current
// one before a destructive/visibility change ('remove' / 'toggle').
type PinModalState = null | { kind: 'setup' } | { kind: 'change' } | { kind: 'verify'; then: 'remove' | 'toggle' }

export function SettingsScreen ({ onSignOut, onBack }: { onSignOut: () => void; onBack: () => void }) {
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)
  const [pinSet, setPinSet] = useState<boolean>(hasPin)
  const [hideR, setHideR] = useState<boolean>(hideRestricted)
  const [pinModal, setPinModal] = useState<PinModalState>(null)

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onBack()
    }
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

      <div className="settings-group-title">PARENTAL CONTROLS</div>
      <div className="settings-group">
        {!pinSet && (
          <>
            <div className="settings-row">
              <span className="row-label">PIN</span>
              <span className="row-value">not set — access-controlled channels are hidden</span>
            </div>
            <div className="settings-row">
              <button className="settings-btn" onClick={() => setPinModal({ kind: 'setup' })}>Set PIN…</button>
            </div>
          </>
        )}
        {pinSet && (
          <>
            <div
              className="toggle-row"
              role="switch"
              aria-checked={hideR}
              onClick={() => setPinModal({ kind: 'verify', then: 'toggle' })}
            >
              <span className="toggle-texts">
                <span className="row-label">Hide restricted channels</span>
                <span className="toggle-hint">Off: access-controlled channels show in the lists and ask for the PIN before playing. On: they disappear from the lists entirely. Changing this asks for the PIN.</span>
              </span>
              <span className={'toggle-pill' + (hideR ? ' on' : '')}>{hideR ? 'ON' : 'OFF'}</span>
            </div>
            <div className="settings-row">
              <button className="settings-btn" onClick={() => setPinModal({ kind: 'change' })}>Change PIN…</button>
              <button className="settings-btn danger" onClick={() => setPinModal({ kind: 'verify', then: 'remove' })}>Remove PIN…</button>
            </div>
          </>
        )}
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

      {(pinModal?.kind === 'setup' || pinModal?.kind === 'change') && (
        <PinSetupModal
          change={pinModal.kind === 'change'}
          onDone={() => { setPinSet(true); setPinModal(null) }}
          onClose={() => setPinModal(null)}
        />
      )}
      {pinModal?.kind === 'verify' && (
        <PinEntryModal
          title={pinModal.then === 'remove' ? 'Remove PIN' : 'Hide restricted channels'}
          hint={pinModal.then === 'remove'
            ? 'Enter the current PIN to remove it. Access-controlled channels go back to being hidden.'
            : 'Enter the PIN to change the visibility of access-controlled channels.'}
          onOk={() => {
            if (pinModal.then === 'remove') { clearPin(); setPinSet(false); setHideR(false) } else {
              const next = !hideR
              setHideRestricted(next)
              setHideR(next)
            }
            setPinModal(null)
          }}
          onClose={() => setPinModal(null)}
        />
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

