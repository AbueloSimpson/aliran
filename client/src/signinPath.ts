// WHO OWNS THE OUTCOME OF A SIGN-IN.
//
// The two screens a device with no session can land on (Login, Connect) each have more
// than one door: a typed password, a phone handover, and — as of WP2c — a restore from
// the device keystore. Every one of them finishes on the SAME worklet message,
// {type:'streams'}. That message says a session now exists. It does not say which door
// made it, and the doors do not persist the same things:
//
//   password   save the credentials that worked (and, on Connect, the service key that
//              was typed), then go to the menu
//   handover   save the operator key the TV ADOPTED — the phone brought it — and no
//              credentials at all: what crossed is key material, which never goes to the
//              prefs file. Its own panel stays up to say the sign-in worked, so it
//              navigates on the viewer's press rather than on 'streams'
//   restore    (WP2c) nothing to save — the material was already on the device
//
// Getting that wrong is not cosmetic. A door that leaves its inputs lying around after
// it FAILED, and a 'streams' handler that reads them because it has nothing better to
// go on, writes the failed attempt's key and password over a later door's success — and
// the device then dials the wrong operator with a dead password on its next boot. That
// is precisely what a second per-door flag, added each time a door is added, keeps
// re-introducing: the flags are set on the way in and nobody clears them on the way out.
//
// So ownership is one thing, explicit and exclusive:
//
//   claim()    a door takes the outcome when the viewer STARTS it. The latest press
//              owns it; there is no way to start a door except by pressing it.
//   release()  the door gives the outcome up the moment it can no longer produce one —
//              a terminal login error, a panel the viewer closed, a completed handover.
//   current    what the 'streams' handler switches on.
//
// THE PROPERTY THAT SURVIVES THE NEXT DOOR. The handler switches on `kind` and does
// NOTHING in the default case, so a door the handler has not been taught persists
// nothing rather than inheriting the persistence of whichever door was written first.
// Adding one is: add a `kind`, claim it where the door opens, release it where the door
// closes, add its case, AND gate it (below). Forgetting the case is inert; there is no
// arrangement of these pieces where forgetting makes some other door's branch run on your
// door's success.
//
// WHAT THIS DOES NOT DO, AND WHAT THE SCREEN STILL OWES. It answers "whose outcome is
// this?" It does NOT stop two doors being opened one after the other, and claim()
// deliberately REPLACES rather than refuses — the viewer's latest press has to win, or a
// half-finished attempt could lock a screen a viewer is standing in front of. So
// exclusivity is the SCREEN's job, and it has to run BOTH ways:
//
//   - every control that opens door A is disabled while door B is live, and the reverse.
//     Gating only one direction is the state this file was first shipped in, and it is
//     worth naming: the phone link went dead during a password attempt, and the submit
//     button stayed live while the phone panel was open.
//   - on a television that means DISABLED — not unmounted, and not merely covered. The
//     phone panel is an overlay rather than a Modal on purpose (a Modal is its own focus
//     container and swallows the remote), so everything behind it is still mounted and
//     still focusable, including a button carrying hasTVPreferredFocus.
//
// The failure that gets through is an ORDERING, and it is quiet: A claims, B claims over
// A, and then A's message arrives and is attributed to B. A phone handover completing
// while a password form owns the outcome writes THAT form's fields — a prefilled username
// and an empty password — against a session the form had nothing to do with, and the
// device dials its operator with a dead credential on the next start.
//
// A door with no viewer-facing control (SplashScreen's two, which open from the prefs
// reply rather than from a press) satisfies this by opening at most one: read `current`
// first and return if anything already owns the outcome.
//
// ONE THING OUTSIDE THIS FILE RIDES ON claim(), and it is here rather than in three
// screens because this is the only chokepoint in the app that means "somebody is signing
// in right now": "Play on a TV" re-arms its rendezvous join on it. A sign-out latches
// that join shut — the catalog push that triggers it keeps arriving afterwards, so
// without the latch the device rejoined the SIGNED-OUT account's rendezvous at the
// operator's next catalog edit — and a door opening is what says the next session will
// be a new one. A door added without a claim() loses the send-to-TV feature until the
// app is restarted; a door that claims correctly gets it for free.
import { useRef } from 'react'
import { armRendezvous } from './sendToTv'

/** A door, as its screen describes it. `kind` is what the 'streams' handler switches on;
 *  everything else on the object is whatever that door has to persist. */
export interface SigninPathHandle<T extends { kind: string }> {
  /** The door that owns the outcome right now, or null — nothing is in flight, or what
   *  was in flight has already failed. Read it ONCE per message and switch on the
   *  result; never test `kind` and then re-read it. */
  readonly current: T | null
  /** Take the outcome. Replaces any previous holder — the viewer's latest press wins. */
  claim: (path: T) => void
  /** Give the outcome up. Call it on EVERY terminal end of the door, success included. */
  release: () => void
}

export function useSigninPath<T extends { kind: string }> (): SigninPathHandle<T> {
  // A ref, not state: the worklet listener is registered once, so it closes over this
  // object and must see the live value rather than the value of its first render.
  const held = useRef<T | null>(null)
  return useRef<SigninPathHandle<T>>({
    get current () { return held.current },
    claim (path: T) { held.current = path; armRendezvous() },
    release () { held.current = null }
  }).current
}
