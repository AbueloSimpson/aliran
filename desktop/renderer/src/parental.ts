// Parental controls (device-local). A PIN plus visibility rules for channels the
// panel marked `restricted`:
//
//   no PIN on this device  → restricted channels DO NOT EXIST in any list
//   PIN set                → they appear, but playing one asks for the PIN
//                            (once per app session)
//   PIN set + "hide" on    → they vanish from the lists again (playing via any
//                            leftover path still asks)
//
// Stored in localStorage like the volume — a device preference, never sent
// anywhere. The PIN is kept as SHA-256(salt ‖ pin): that keeps it out of casual
// devtools snooping, but this is a PARENTAL gate on the viewer's own machine,
// not a security boundary.

import type { Stream } from './types'

const KEY = 'aliran.parental.v1'

interface Rec { salt: string; hash: string; hide: boolean }

function load (): Rec | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || '')
    if (typeof r.salt === 'string' && typeof r.hash === 'string') return { salt: r.salt, hash: r.hash, hide: r.hide === true }
  } catch { /* absent/corrupt = no PIN */ }
  return null
}

function save (rec: Rec | null) {
  try {
    if (rec) localStorage.setItem(KEY, JSON.stringify(rec))
    else localStorage.removeItem(KEY)
  } catch { /* full/blocked storage is not an error */ }
}

async function digest (salt: string, pin: string): Promise<string> {
  const data = new TextEncoder().encode(salt + '|' + pin)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hasPin (): boolean { return load() != null }

export function validPinFormat (pin: string): boolean { return /^\d{4,8}$/.test(pin) }

export async function setPin (pin: string): Promise<void> {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('')
  const prev = load()
  save({ salt, hash: await digest(salt, pin), hide: prev?.hide ?? false })
}

export async function verifyPin (pin: string): Promise<boolean> {
  const rec = load()
  if (!rec) return false
  return (await digest(rec.salt, pin)) === rec.hash
}

export function clearPin (): void {
  save(null)
  sessionUnlocked = false
}

export function hideRestricted (): boolean { return load()?.hide === true }

export function setHideRestricted (on: boolean): void {
  const rec = load()
  if (rec) save({ ...rec, hide: on })
}

// One unlock covers the app session (until the window closes) — a parent zapping
// through their own lineup should not re-type the PIN per channel.
let sessionUnlocked = false
export function isUnlocked (): boolean { return sessionUnlocked }
export function markUnlocked (): void { sessionUnlocked = true }

// The single visibility rule every browse surface applies to the display list.
export function visibleStreams (streams: Stream[]): Stream[] {
  if (!hasPin() || hideRestricted()) return streams.filter((s) => !s.restricted)
  return streams
}

// Does tuning THIS channel need a PIN entry first?
export function needsPin (s: Stream | null | undefined): boolean {
  return !!s?.restricted && hasPin() && !sessionUnlocked
}
