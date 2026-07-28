// Parental-PIN dialogs (reusing the report modal's card styling).
//   <PinEntryModal>  one field, verified against the stored PIN — gates playback
//                    of a restricted channel and confirms parental-settings changes.
//   <PinSetupModal>  new PIN + confirmation (plus the current PIN when changing).
// Esc cancels either; Enter submits.

import React, { useEffect, useRef, useState } from 'react'
import { setPin, validPinFormat, verifyPin } from '../parental'

const FORMAT_HINT = 'PIN must be 4 to 8 digits.'

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
    setError('Wrong PIN — try again.')
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <form className="report-card pin-card" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="section-header">{title.toUpperCase()}</div>
        {hint && <p className="pin-hint">{hint}</p>}
        <PinField label="PIN" value={pin} onChange={(v) => { setPinValue(v); setError(null) }} autoFocus />
        {error && <p className="pin-error">{error}</p>}
        <div className="pin-buttons">
          <button type="button" className="report-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="report-send" disabled={pin.length < 4}>OK</button>
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
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEscape(onClose)

  async function submit (e: React.FormEvent) {
    e.preventDefault()
    if (busy.current) return
    if (!validPinFormat(next)) { setError(FORMAT_HINT); return }
    if (next !== confirm) { setError('The PINs do not match.'); setConfirm(''); return }
    busy.current = true
    if (change && !(await verifyPin(current))) {
      busy.current = false
      setCurrent('')
      setError('Wrong current PIN.')
      return
    }
    await setPin(next)
    onDone()
  }

  return (
    <div className="report-backdrop" onClick={onClose}>
      <form className="report-card pin-card" role="dialog" aria-label={change ? 'Change PIN' : 'Set PIN'} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="section-header">{change ? 'CHANGE PIN' : 'SET PARENTAL PIN'}</div>
        <p className="pin-hint">
          {change
            ? 'Pick a new 4–8 digit PIN for access-controlled channels.'
            : 'A 4–8 digit PIN, saved only on this device. Access-controlled channels stay hidden until a PIN exists; with one set, they appear and ask for it before playing.'}
        </p>
        {change && <PinField label="Current PIN" value={current} onChange={(v) => { setCurrent(v); setError(null) }} autoFocus />}
        <PinField label="New PIN" value={next} onChange={(v) => { setNext(v); setError(null) }} autoFocus={!change} />
        <PinField label="Repeat new PIN" value={confirm} onChange={(v) => { setConfirm(v); setError(null) }} />
        {error && <p className="pin-error">{error}</p>}
        <div className="pin-buttons">
          <button type="button" className="report-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="report-send" disabled={next.length < 4 || confirm.length < 4 || (change && current.length < 4)}>Save</button>
        </div>
      </form>
    </div>
  )
}
