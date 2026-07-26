// "Report a problem" from the player (S51) — opened from the NowPlayingBar's Report
// button (or the `r` key) while a channel is playing. Categories only, then Send:
// there is deliberately NO free-text input — the engine attaches the channel being
// watched plus its own diagnostics, which is the specific signal the operator needs.
//
// The 'login' category is excluded here on purpose: this modal only opens during
// playback, which means login worked. (The category still exists on the wire; the
// panel's login alert rule is unaffected.)

import React, { useEffect, useState } from 'react'
import { backend } from '../bridge'
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, type ReportCategory } from '../types'

const PLAYER_CATEGORIES = REPORT_CATEGORIES.filter((c) => c !== 'login')

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

export function ReportModal ({ channelTitle, onClose }: { channelTitle?: string; onClose: () => void }) {
  const [category, setCategory] = useState<ReportCategory | null>(null)
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
    backend.sendReport(category)
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <div className="report-card" role="dialog" aria-label="Report a problem" onClick={(e) => e.stopPropagation()}>
        <div className="section-header">REPORT A PROBLEM</div>
        {channelTitle && <div className="report-channel">{channelTitle}</div>}
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
                {PLAYER_CATEGORIES.map((c, i) => (
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
