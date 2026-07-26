// Settings — account, playback (the "Smooth zapping" switch, S21), service info,
// live diagnostics (active source + peers + entitled count), "Report a problem"
// (S50c), sign out. Sign out clears the saved (safeStorage-wrapped) credentials so
// the next boot lands on Login instead of auto-authorizing.

import React, { useEffect, useState } from 'react'
import { backend } from '../bridge'
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, REPORT_TEXT_MAX, type ReportCategory } from '../types'

export function SettingsScreen ({ onSignOut, onBack }: { onSignOut: () => void; onBack: () => void }) {
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)
  const [reportOpen, setReportOpen] = useState(false)

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

  // Esc closes the report modal first, then leaves Settings — otherwise dismissing a
  // half-typed report would drop the viewer out of the screen entirely.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (reportOpen) setReportOpen(false)
      else onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, reportOpen])

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
        <button className="settings-action" onClick={() => setReportOpen(true)}>
          <span className="toggle-texts">
            <span className="row-label">Report a problem</span>
            <span className="toggle-hint">Tell the service what went wrong with a channel — no account details are sent.</span>
          </span>
          <span className="row-value">›</span>
        </button>
      </div>

      {reportOpen && <ReportModal onClose={() => setReportOpen(false)} />}

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

// Human text for every error code AliranPlayer.report() can answer with. A viewer must
// never see a wire code, and must never be told to retry into a closed door:
// 'unsupported' and the throttles all end with "nothing more to do".
function reportMessage (error: string | undefined, retryAfter?: number): string {
  const mins = retryAfter ? Math.max(1, Math.round(retryAfter / 60)) : 10
  switch (error) {
    case undefined: return 'Thanks — your report was sent.'
    case 'cooldown':
    case 'locked': return `You already reported this. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
    case 'unsupported': return "This service doesn't accept problem reports."
    case 'not-logged-in':
    case 'unauthorized':
    case 'expired': return 'Please sign in again, then report the problem.'
    case 'offline': return 'Not connected to the service right now — try again in a moment.'
    default: return "Couldn't send the report. Try again in a moment."
  }
}

// "Report a problem" (S50c) — the desktop twin of the phone/TV modal. Same shape and
// the same consent line: a vertical category list first (keyboard-navigable, no
// pointer required), the optional note LAST and skippable, then send.
function ReportModal ({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => backend.onMessage((m) => {
    if (m.type !== 'report-result') return
    setSending(false)
    setResult(reportMessage(m.ok ? undefined : (m.error ?? 'failed'), m.retryAfter))
  }), [])

  function submit () {
    if (!category || sending) return
    setSending(true)
    setResult(null)
    backend.sendReport(category, text.trim() || undefined)
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <div className="report-card" role="dialog" aria-label="Report a problem" onClick={(e) => e.stopPropagation()}>
        <div className="section-header">REPORT A PROBLEM</div>
        {result
          ? (
            <>
              <p className="report-result">{result}</p>
              <button className="report-send" autoFocus onClick={onClose}>Close</button>
            </>
            )
          : (
            <>
              <div className="settings-group-title">WHAT WENT WRONG?</div>
              <div className="report-categories">
                {REPORT_CATEGORIES.map((c, i) => (
                  <button
                    key={c}
                    className={'report-category' + (category === c ? ' selected' : '')}
                    autoFocus={i === 0}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                  >
                    <span className="report-mark">{category === c ? '●' : '○'}</span>
                    <span>{REPORT_CATEGORY_LABELS[c]}</span>
                  </button>
                ))}
              </div>

              {/* LAST input, and skippable — Tab from the categories reaches Send
                  without ever entering it, and nothing here requires typing. */}
              <div className="settings-group-title">ADD A NOTE (OPTIONAL)</div>
              <textarea
                className="report-note"
                value={text}
                maxLength={REPORT_TEXT_MAX}
                placeholder="What did you see?"
                onChange={(e) => setText(e.target.value.slice(0, REPORT_TEXT_MAX))}
              />

              <p className="report-consent">{REPORT_CONSENT}</p>

              <button className="report-send" disabled={!category || sending} onClick={submit}>
                {sending ? 'Sending…' : 'Send report'}
              </button>
              <button className="report-cancel" onClick={onClose}>Cancel</button>
            </>
            )}
      </div>
    </div>
  )
}
