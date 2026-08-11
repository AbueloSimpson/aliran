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
// Single-slot memo (S22 round 8): a stable OUTPUT identity per (catalog, pin, hide)
// lets catalog-side caches hit across every screen mount — without it each mount's
// fresh filter array forced the seconds-long regroup of a large vod catalog. The
// pin/hide flags ride the key so parental changes recompute.
let visCache: { src: Stream[]; pin: boolean; hide: boolean; out: Stream[] } | null = null
export function visibleStreams (streams: Stream[]): Stream[] {
  const pin = hasPin()
  const hide = hideRestricted()
  if (visCache && visCache.src === streams && visCache.pin === pin && visCache.hide === hide) return visCache.out
  const out = (!pin || hide) ? streams.filter((s) => !s.restricted) : streams
  visCache = { src: streams, pin, hide, out }
  return out
}

// Does tuning THIS channel need a PIN entry first?
export function needsPin (s: Stream | null | undefined): boolean {
  return !!s?.restricted && hasPin() && !sessionUnlocked
}

// The channels the app may start BY ITSELF, with no viewer action behind the choice:
// the cold-start hero, and the fallback after a DECLINED PIN challenge. Both used to
// pick over the WHOLE list, which on "PIN set + hide off" — restricted channels listed
// on purpose, gated rather than hidden — can hand back a restricted channel: the app
// tuned it unprompted, and cancelling the prompt swapped in a DIFFERENT restricted one
// (found 2026-08-11). An automatic pick has nothing to gate, so it must not make one.
//
// Feed this to pickHero() at the call site rather than importing it here: this module
// stays import-free so tools/desktop-parental-test.mjs can transpile this file on its
// own. An EMPTY result — every visible channel locked — means play nothing and leave
// the screen on its empty state; the viewer picks a channel and play() gates that,
// the one guarded path into playback. After markUnlocked() this is everything.
export function autoTunable (streams: Stream[]): Stream[] {
  return streams.filter((s) => !needsPin(s))
}
