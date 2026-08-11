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
// Single-slot memo (S22 round 8): a stable OUTPUT identity per (catalog, pin, hide)
// lets catalog.ts's WeakMap-cached derivations hit across every screen mount —
// without it each mount's fresh filter array forced the seconds-long regroup of a
// large vod catalog. The pin/hide flags ride the key so parental changes recompute.
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

/**
 * Is this channel REFUSED outright on this device — no challenge, nothing to enter, it
 * simply is not here?
 *
 * THE SECOND CLAUSE OF THE RULE AT THE TOP OF THIS FILE. With no PIN configured a
 * restricted channel does not exist on this device: visibleStreams() takes it out of
 * every list, and there is no PIN to compare an entry against. needsPin() therefore
 * answers false for it — correct for a channel nothing local can reach, and wrong the
 * moment something outside the lists names one.
 *
 * Exactly one thing can: a `play` command from another device on the account. It arrives
 * with an id, and the id is resolved against the UNFILTERED catalog, because the engine
 * deliberately does not tune it for you — it hands the host a command precisely so the
 * host applies this rule (sdk/player.js, onPlay). A television that hides a channel must
 * not play it because a phone asked.
 *
 * `hide` does NOT belong here. A device WITH a PIN that has hidden its restricted
 * channels can still be sent one: it has a challenge to raise, and raising it is what
 * the file header means by "any leftover path into playback still asks".
 */
export function blockedWithoutPin (restricted: boolean | undefined): boolean {
  return restricted === true && !hasPin()
}

// The channels the app may start BY ITSELF, with no viewer action behind the choice:
// the cold-start hero, and the fallback after a DECLINED PIN challenge. Both used to
// pick over the WHOLE list, which on "PIN set + hide off" — restricted channels listed
// on purpose, gated rather than hidden — can hand back a restricted channel: the app
// tuned it unprompted, and cancelling the prompt swapped in a DIFFERENT restricted one
// (found 2026-08-11). An automatic pick has nothing to gate, so it must not make one.
//
// Feed this to pickHero() at the call site rather than importing it here: this module
// stays import-free so tools/desktop-parental-test.mjs can transpile the desktop twin
// on its own. An EMPTY result — every visible channel locked — means play nothing and
// leave the screen on its empty state; the viewer picks a channel and play() gates
// that, the one guarded path into playback. After markUnlocked() this is everything.
export function autoTunable (streams: Stream[]): Stream[] {
  return streams.filter((s) => !needsPin(s))
}
