// Parental-PIN dialogs (reusing the report modal's card styling).
//   <PinEntryModal>  one field, verified against the stored PIN — gates playback
//                    of a restricted channel and confirms parental-settings changes.
//   <PinSetupModal>  new PIN + confirmation (plus the current PIN when changing).
// Esc cancels either; Enter submits.

import React, { useEffect, useRef, useState } from 'react'
import { getLocale, useI18n } from '@aliran/i18n'
import { setPin, validPinFormat, verifyPin } from '../parental'

// A refused PIN is held as a CATALOG LEAF (pin.error.<code>), never as copy: the
// sentence is looked up at render, so a language change repaints a message that is
// already under the field.

function PinField ({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="pin-field">
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  )
}

function useEscape (onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
}

export function PinEntryModal ({ title, hint, onOk, onClose }: {
  title: string
  hint?: string
  /** Called after the entered PIN verified against the stored one. */
  onOk: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [pin, setPinValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEscape(onClose)

  async function submit (e: React.FormEvent) {
    e.preventDefault()
    if (busy.current) return
    busy.current = true
    if (await verifyPin(pin)) { onOk(); return }
    busy.current = false
    setPinValue('')
    setError('wrong')
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <form className="report-card pin-card" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="section-header">{title.toLocaleUpperCase(getLocale())}</div>
        {hint && <p className="pin-hint">{hint}</p>}
        <PinField label={t('pin.label')} value={pin} onChange={(v) => { setPinValue(v); setError(null) }} autoFocus />
        {error && <p className="pin-error">{t('pin.error.' + error)}</p>}
        <div className="pin-buttons">
          <button type="button" className="report-cancel" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="report-send" disabled={pin.length < 4}>{t('common.ok')}</button>
        </div>
      </form>
    </div>
  )
}

export function PinSetupModal ({ change, onDone, onClose }: {
  /** true = replace the existing PIN (asks for the current one first). */
  change?: boolean
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEscape(onClose)

  async function submit (e: React.FormEvent) {
    e.preventDefault()
    if (busy.current) return
    if (!validPinFormat(next)) { setError('format'); return }
    if (next !== confirm) { setError('mismatch'); setConfirm(''); return }
    busy.current = true
    if (change && !(await verifyPin(current))) {
      busy.current = false
      setCurrent('')
      setError('wrongCurrent')
      return
    }
    await setPin(next)
    onDone()
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <form className="report-card pin-card" role="dialog" aria-label={change ? t('pin.changeAria') : t('pin.setupAria')} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="section-header">{change ? t('pin.changeTitle') : t('pin.setupTitle')}</div>
        <p className="pin-hint">
          {change ? t('pin.changeHint') : t('pin.setupHint')}
        </p>
        {change && <PinField label={t('pin.current')} value={current} onChange={(v) => { setCurrent(v); setError(null) }} autoFocus />}
        <PinField label={t('pin.new')} value={next} onChange={(v) => { setNext(v); setError(null) }} autoFocus={!change} />
        <PinField label={t('pin.repeat')} value={confirm} onChange={(v) => { setConfirm(v); setError(null) }} />
        {error && <p className="pin-error">{t('pin.error.' + error)}</p>}
        <div className="pin-buttons">
          <button type="button" className="report-cancel" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="report-send" disabled={next.length < 4 || confirm.length < 4 || (change && current.length < 4)}>{t('common.save')}</button>
        </div>
      </form>
    </div>
  )
}
