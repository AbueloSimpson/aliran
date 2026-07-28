// Parental controls (device policy). The WORKLET owns the stored state — a salted
// PIN digest + the hide-restricted toggle in the prefs file (client/backend/
// backend.mjs); the RN layer only ever sees "a PIN exists" + hide, mirrored on
// backend.parental. This module wraps that with the visibility rule and the
// per-session unlock. Desktop twin: desktop/renderer/src/parental.ts — keep the
// rules in step.
//
//   no PIN on this device  → restricted channels DO NOT EXIST in any list
//   PIN set                → they appear, but tuning one asks for the PIN
//                            (once per app session)
//   PIN set + "hide" on    → hidden from the lists again (any leftover path into
//                            playback still asks)

import { backend, type Stream } from './worklet'

let sessionUnlocked = false
export function markUnlocked (): void { sessionUnlocked = true }

export function hasPin (): boolean { return backend.parental != null }
export function hideRestricted (): boolean { return backend.parental?.hide === true }
export function validPinFormat (pin: string): boolean { return /^\d{4,8}$/.test(pin) }

// The single visibility rule every browse surface applies to the display list.
export function visibleStreams (streams: Stream[]): Stream[] {
  if (!hasPin() || hideRestricted()) return streams.filter((s) => !s.restricted)
  return streams
}

// Does tuning THIS channel need a PIN entry first?
export function needsPin (s: Stream | null | undefined): boolean {
  return !!s?.restricted && hasPin() && !sessionUnlocked
}
