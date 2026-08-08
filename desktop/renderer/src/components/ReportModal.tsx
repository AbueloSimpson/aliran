// "Report a problem" from the player (S51) — opened from the NowPlayingBar's Report
// button (or the `r` key) while a channel is playing. Categories only, then Send:
// there is deliberately NO free-text input — the engine attaches the channel being
// watched plus its own diagnostics, which is the specific signal the operator needs.
//
// The 'login' category is excluded here on purpose: this modal only opens during
// playback, which means login worked. (The category still exists on the wire; the
// panel's login alert rule is unaffected.)

import React, { useEffect, useState } from 'react'
import { useI18n } from '@aliran/i18n'
import { backend } from '../bridge'
import { REPORT_CATEGORIES, type ReportCategory } from '../types'

const PLAYER_CATEGORIES = REPORT_CATEGORIES.filter((c) => c !== 'login')

// Human text for every error code AliranPlayer.report() can answer with. A viewer must
// never see a wire code, and must never be told to retry into a closed door:
// 'unsupported' and the throttles all end with "nothing more to do".
//
// The i18n pair is a parameter rather than a hook call so this stays the pure lookup it
// was; the modal calls it at RENDER time (it stores the engine's answer, not the
// sentence), which is what keeps an outcome already on screen following a language
// change.
function reportMessage (
  { t, tn }: ReturnType<typeof useI18n>,
  error: string | undefined,
  retryAfter?: number
): string {
  const mins = retryAfter ? Math.max(1, Math.round(retryAfter / 60)) : 10
  switch (error) {
    case undefined: return t('report.result.sent')
    case 'cooldown':
    case 'locked': return tn('report.result.cooldown', mins)
    case 'unsupported': return t('report.result.unsupported')
    case 'not-logged-in':
    case 'unauthorized':
    case 'expired': return t('report.result.signIn')
    case 'offline': return t('report.result.offline')
    default: return t('report.result.failed')
  }
}

/** What the engine answered, kept verbatim so the sentence is built at render. */
interface ReportOutcome { error?: string; retryAfter?: number }

export function ReportModal ({ channelTitle, onClose }: { channelTitle?: string; onClose: () => void }) {
  const i18n = useI18n()
  const { t } = i18n
  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ReportOutcome | null>(null)

  useEffect(() => backend.onMessage((m) => {
    if (m.type !== 'report-result') return
    setSending(false)
    setResult({ error: m.ok ? undefined : (m.error ?? 'failed'), retryAfter: m.retryAfter })
  }), [])

  function submit () {
    if (!category || sending) return
    setSending(true)
    setResult(null)
    backend.sendReport(category)
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <div className="report-card" role="dialog" aria-label={t('report.dialogAria')} onClick={(e) => e.stopPropagation()}>
        <div className="section-header">{t('report.title')}</div>
        {channelTitle && <div className="report-channel">{channelTitle}</div>}
        {result
          ? (
            <>
              <p className="report-result">{reportMessage(i18n, result.error, result.retryAfter)}</p>
              <button className="report-send" autoFocus onClick={onClose}>{t('common.close')}</button>
            </>
            )
          : (
            <>
              <div className="settings-group-title">{t('report.hint').toUpperCase()}</div>
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
                    <span>{t('report.category.' + c)}</span>
                  </button>
                ))}
              </div>

              {/* The catalog's copy of REPORT_CONSENT — tools/i18n-test.mjs pins the
                  English against sdk/react-native/src/report.ts byte for byte. */}
              <p className="report-consent">{t('report.consent')}</p>

              <button className="report-send" disabled={!category || sending} onClick={submit}>
                {sending ? t('report.sending') : t('report.send')}
              </button>
              <button className="report-cancel" onClick={onClose}>{t('common.cancel')}</button>
            </>
            )}
      </div>
    </div>
  )
}
