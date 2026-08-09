// Settings — account, playback (the "Smooth zapping" switch, S21), service info,
// live diagnostics (active source + peers + entitled count), sign out. Sign out
// clears the saved (safeStorage-wrapped) credentials so the next boot lands on
// Login instead of auto-authorizing.
//
// "Report a problem" is NOT here (S51): it lives on the player (NowPlayingBar's
// Report button / the `r` key), because a useful report must carry the channel
// being watched — which Settings cannot know.

import React, { useEffect, useState } from 'react'
import { SUPPORTED_LOCALES, useI18n } from '@aliran/i18n'
import { backend } from '../bridge'
import { applyLocale, saveLanguage, savedLanguage } from '../i18n'
import { clearPin, hasPin, hideRestricted, setHideRestricted } from '../parental'
import { PinEntryModal, PinSetupModal } from '../components/PinModal'

// Parental modal state machine: set up a new PIN, change it, or verify the current
// one before a destructive/visibility change ('remove' / 'toggle').
type PinModalState = null | { kind: 'setup' } | { kind: 'change' } | { kind: 'verify'; then: 'remove' | 'toggle' }

export function SettingsScreen ({ onSignOut, onBack }: { onSignOut: () => void; onBack: () => void }) {
  const { t } = useI18n()
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)
  const [pinSet, setPinSet] = useState<boolean>(hasPin)
  const [hideR, setHideR] = useState<boolean>(hideRestricted)
  const [pinModal, setPinModal] = useState<PinModalState>(null)
  // The PINNED language ('' = follow the system, which is the <select>'s empty value).
  const [language, setLanguage] = useState<string>(savedLanguage() ?? '')

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

  // Persist, then resolve from the CHOICE — not from the store. applyLocale() takes
  // the same saved > system order the app booted with, so "System language" (code '')
  // still needs no separate branch, but a blocked or full localStorage can no longer
  // leave the UI in the old language while this row shows the new one.
  function chooseLanguage (code: string) {
    setLanguage(code)
    saveLanguage(code || null)
    applyLocale(code || null)
  }

  function signOut () {
    backend.clearCredentials()
    backend.streams = [] // drop the session's display list; a fresh login rebuilds it
    onSignOut()
  }

  const d = backend.descriptor
  return (
    <div className="settings">
      <div className="section-header">{t('settings.header')}</div>

      <div className="settings-group-title">{t('settings.group.account')}</div>
      <div className="settings-group">
        <Row label={t('settings.signedInAs')} value={username ?? '—'} />
        <Row label={t('settings.entitledChannels')} value={String(channels)} />
      </div>

      <div className="settings-group-title">{t('settings.group.playback')}</div>
      <div className="settings-group">
        <div className="toggle-row" role="switch" aria-checked={smoothZap} onClick={toggleSmoothZap}>
          <span className="toggle-texts">
            <span className="row-label">{t('settings.smoothZap')}</span>
            <span className="toggle-hint">{t('settings.smoothZapHintDesktop')}</span>
          </span>
          <span className={'toggle-pill' + (smoothZap ? ' on' : '')}>{smoothZap ? t('common.on') : t('common.off')}</span>
        </div>
      </div>

      <div className="settings-group-title">{t('settings.group.language')}</div>
      <div className="settings-group">
        <div className="toggle-row">
          <span className="toggle-texts">
            <span className="row-label">{t('settings.language')}</span>
            <span className="toggle-hint">{t('settings.language.hint')}</span>
          </span>
          {/* The 14 names are rendered in their own language and never translated —
              nobody should have to read a foreign word to find their own language.
              Only the "follow the system" row names a behavior, so only it is copy. */}
          <select
            className="settings-select"
            aria-label={t('settings.language')}
            value={language}
            onChange={(e) => chooseLanguage(e.target.value)}
          >
            <option value="">{t('settings.language.system')}</option>
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l.code} value={l.code}>{l.nativeName}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-group-title">{t('settings.group.parental')}</div>
      <div className="settings-group">
        {!pinSet && (
          <>
            <div className="settings-row">
              <span className="row-label">{t('settings.pin')}</span>
              <span className="row-value">{t('settings.pinNotSet')}</span>
            </div>
            <div className="settings-row">
              <button className="settings-btn" onClick={() => setPinModal({ kind: 'setup' })}>{t('settings.setPin')}</button>
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
                <span className="row-label">{t('settings.hideRestricted')}</span>
                <span className="toggle-hint">{t('settings.hideRestrictedHint')}</span>
              </span>
              <span className={'toggle-pill' + (hideR ? ' on' : '')}>{hideR ? t('common.on') : t('common.off')}</span>
            </div>
            <div className="settings-row">
              <button className="settings-btn" onClick={() => setPinModal({ kind: 'change' })}>{t('settings.changePin')}</button>
              <button className="settings-btn danger" onClick={() => setPinModal({ kind: 'verify', then: 'remove' })}>{t('settings.removePin')}</button>
            </div>
          </>
        )}
      </div>

      <div className="settings-group-title">{t('settings.group.service')}</div>
      <div className="settings-group">
        <Row label={t('settings.service')} value={d?.name ?? '—'} />
        <Row label={t('settings.panelKey')} value={(d?.panelPubKey ?? '').slice(0, 16) + '…'} />
        <Row label={t('settings.playback')} value="p2p-only" />
      </div>

      <div className="settings-group-title">{t('settings.group.diagnostics')}</div>
      <div className="settings-group">
        <Row label={t('settings.activeSource')} value={source ? source.toUpperCase() : '—'} />
        <Row label={t('settings.peers')} value={peers != null ? String(peers) : '—'} />
      </div>

      <button className="signout" onClick={signOut}>{t('settings.signOut')}</button>
      {/* Sentence + key hint, composed here: the catalog never carries a key name
          baked into prose, and the "·" join is punctuation, not copy. */}
      <div className="signout-hint">{t('settings.signOutHint')} · {t('hints.escBack', { esc: 'Esc' })}</div>

      {/* Public build only (the runtime-entered service): forget the panel key +
          credentials and restart to the Connect screen. Operator builds bake their
          descriptor into the artifact — nothing to change. */}
      {backend.descriptorSource === 'runtime' && (
        <>
          <button className="change-service" onClick={() => backend.clearService()}>{t('settings.changeService')}</button>
          <div className="signout-hint">{t('settings.changeServiceHintDesktop')}</div>
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
          title={pinModal.then === 'remove' ? t('settings.removePinTitle') : t('settings.hideRestricted')}
          hint={pinModal.then === 'remove'
            ? t('settings.removePinHint')
            : t('settings.hideRestrictedPinHint')}
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

