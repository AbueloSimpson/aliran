// "Send to TV" — the state behind the picker sheet, kept out of the component so the
// rules are testable without a renderer.
//
// TWO WAYS TO PUT A CHANNEL ON A TELEVISION, AND THEY ARE NOT THE SAME THING. The sheet
// shows them in two sections for that reason, and this module is where the difference
// actually lives:
//
//   HANDOFF ("Your devices")  Another Aliran device on this account is asked to tune the
//                             channel itself. It joins the swarm, it decrypts, it plays.
//                             This phone sends one message and is then free — put it in
//                             a pocket, switch it off, walk out of the house. Nothing is
//                             served from here and there is no URL to leak.
//
//   CAST ("Cast devices")     A Chromecast has no Aliran engine, so THIS PHONE becomes
//                             the origin server: it opens a second HTTP server on the
//                             local network and the television fetches every segment
//                             from it. The phone must stay awake and on the network, it
//                             is decrypting and serving the whole time, and the media
//                             URL is readable off the television by anything on the
//                             network that asks it. That is not a defect to hide; it is
//                             what casting is, and the sheet says so.
//
// Where both are possible the handoff is better in every dimension a viewer would care
// about, which is why it is the first section.
//
// PINNING. A cast session can be told to serve ONE address and refuse every other peer.
// The engine cannot find that address — it does not speak the Cast protocol — so it comes
// from the Cast layer here, after the session connects and before the server starts. Two
// cases have no address to give: a multi-room GROUP (every member fetches, so one address
// would 404 the rest) and a platform that would not say. Both run unpinned, and `pinned`
// on the active session is what the sheet shows for it. An unpinned session is never a
// silent default.
import { Platform } from 'react-native'
import { backend, type Stream } from './worklet'
import type { RemotePeer } from '@aliran/react-native'
import * as cast from './cast'

/** A television on the account rendezvous — the handoff section of the picker. */
export interface HandoffTarget {
  kind: 'handoff'
  deviceId: string
  name: string
  platform: string | null
}

/** A Chromecast the Cast SDK found — the cast section of the picker. */
export interface CastTarget {
  kind: 'cast'
  deviceId: string
  name: string
  model?: string
  /** Its LAN address, or null when the platform did not give a usable one. The PIN. */
  address: string | null
  /** A multi-room group: every member fetches, so there is no single address to pin. */
  isGroup: boolean
}

export type SendTarget = HandoffTarget | CastTarget

/** What is running now. `kind` is the mode the viewer is in and the sheet says which. */
export interface ActiveSend {
  kind: 'handoff' | 'cast'
  deviceId: string
  deviceName: string
  streamId: string
  streamTitle: string
  /** Cast only: the session serves ONE address and refuses the rest. False = it serves
   *  any peer that can read the URL off the television. Shown, never assumed. */
  pinned: boolean
  /** Cast only: why it is not pinned — a multi-room group has no single address. */
  group: boolean
  /** Cast only: the LAN address the television was told to fetch from. */
  host?: string
  /** Cast only: the other private addresses this device offered. What to try when a
   *  television cannot reach the one that was picked. */
  candidates?: string[]
}

/** Why a send did not happen. The sheet turns these into sentences (tvplay.error.*);
 *  anything not on the list falls back to the generic one. */
export type SendFailure =
  | 'cast-connect'    // the television refused the session, or never answered
  | 'cast-serve'      // the engine would not stand the server up
  | 'cast-load'       // the session is up and the television would not take the URL
  | 'refused'         // handoff: remote control is switched off there
  | 'unentitled'      // handoff: that account cannot show this channel
  | 'unavailable'     // handoff: it took the command and could not carry it out
  | 'timeout'         // handoff: nothing came back — NEVER "it declined"
  | 'unknown'         // handoff: not on the list, or not a television
  | 'offline'
  | 'failed'

let active: ActiveSend | null = null
let peers: RemotePeer[] = []

/**
 * WHERE THIS DEVICE STANDS WITH THE ACCOUNT RENDEZVOUS.
 *
 * A boolean was not enough, because the trigger is the CATALOG PUSH — the first moment a
 * login is known to have happened, and also a message the engine re-sends live on every
 * panel edit and every entitlement change. Three separate things have to hold:
 *
 *   HELD ACROSS THE AWAIT. The old latch was read before `startRemote()` and written
 *   after it, so two pushes inside one in-flight start sent two `remote-start` requests.
 *   The engine throws on the second ("a remote session is already running on this
 *   device") and that failure then CLEARED the latch the first call had just set — so
 *   every later push fired another doomed start for the life of the run, each holding a
 *   pending listener for the request timeout.
 *
 *   A PERMANENT NO IS FINAL. A build constructed without `remote: { control: true }`, or
 *   an account whose panel record predates tokenVersion, answers no and will answer no
 *   however long anyone waits — the binding's own docstring says exactly that. Only the
 *   two answers that decided nothing ('timeout' — the worklet never replied; 'offline' —
 *   no session yet) leave the door open for the next push.
 *
 *   A SIGN-OUT IS STICKY. leaveRendezvous() leaves, but the pushes do not stop: sign-out
 *   rewrites the prefs file and nothing else, so the engine keeps its session and keeps
 *   publishing the catalog. With a latch that merely reset, the next panel edit put a
 *   SIGNED-OUT device back on the signed-out account's rendezvous — announcing itself,
 *   `acceptPlay: true`, taking that account's commands — while the screen showed Login.
 *   Only armRendezvous() clears it, and only a sign-in door calls that.
 */
type JoinState = 'idle' | 'joining' | 'joined' | 'refused' | 'signed-out'
let join: JoinState = 'idle'
const listeners = new Set<() => void>()
// Torn down with the session, not with the sheet: a cast keeps running while the picker
// is closed, and the television dropping it has to stop the server either way.
let offSessionEnded: (() => void) | null = null
let offCastEnded: (() => void) | null = null

function emit () { for (const fn of [...listeners]) fn() }

/** Subscribe to the active-session state. Returns the unsubscribe. */
export function subscribe (fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function activeSend (): ActiveSend | null { return active }

/** The televisions this account can hand a channel to. Controllers are filtered out —
 *  a play sent to one is refused 'unknown', so it has no business in a picker. */
export function handoffTargets (): HandoffTarget[] {
  return peers
    .filter((p) => p.role === 'tv')
    .map((p) => ({ kind: 'handoff' as const, deviceId: p.deviceId, name: p.label || deviceFallbackName(p), platform: p.platform }))
}

function deviceFallbackName (p: RemotePeer): string {
  // A device that never set a label still has to be pickable and still has to be
  // TELLABLE APART from the next one, so the id tail rides along.
  return `${p.platform || 'device'} · ${p.deviceId.slice(0, 6)}`
}

/**
 * How this device names itself to the rest of the account. The Android model
 * ('SM-S908B'), which is the only device name React Native can read without a native
 * module, with the platform behind it where it cannot.
 *
 * A HANDLE, NOT A CREDENTIAL — it is the peer's own claim, it is shown in other people's
 * pickers, and nothing authenticates it. Keep it to what a viewer needs to pick the right
 * set in the room.
 */
export function deviceLabel (): string {
  const model = (Platform.constants as { Model?: string } | undefined)?.Model
  const kind = Platform.isTV ? 'TV' : 'phone'
  return model ? `${model} (${kind})` : `Aliran ${kind}`
}

/**
 * Join the account rendezvous. Called once a session exists (App, after login).
 *
 * The ROLE follows the device and nothing else: a television announces itself and takes
 * commands, everything else looks up and sends them. A phone never announces, so a phone
 * never appears in anybody's picker.
 *
 * Never throws. A build without `remote: { control: true }` answers false and this
 * feature simply is not there — which is correct, and not a runtime failure to report.
 */
export async function joinRendezvous (): Promise<boolean> {
  if (join !== 'idle') return join === 'joined' // see JoinState: every other value is final for now
  join = 'joining'
  let res
  try {
    // acceptPlay is OMITTED, and the omission is the feature. The per-set take-over switch
    // is a persisted preference, and the worklet — which owns the prefs file — resolves it
    // into this very call. Passing `true` from here is what the old code did, and it made
    // the switch unbuildable: the set is announced and taking commands from the moment the
    // join lands, so a preference applied by a setRemoteAccept() after this promise
    // resolves leaves a window on EVERY boot in which a television whose viewer switched
    // this off is taking commands anyway. The preference has to be in the join.
    res = await backend.startRemote({
      role: Platform.isTV ? 'tv' : 'controller',
      label: deviceLabel()
    })
  } catch {
    if (join === 'joining') join = 'idle' // nothing was decided — the next push retries
    return false
  }
  // A sign-out landed while this was in flight. Its `remote-leave` may have reached an
  // engine that had not joined yet, so if the start then succeeded the device is on a
  // rendezvous nobody is signed in to — leave it again. The state is left alone: only a
  // sign-in door re-arms it.
  if (join !== 'joining') {
    if (res.ok === true) { try { backend.stopRemote() } catch { /* no engine */ } }
    return false
  }
  if (res.ok === true) { join = 'joined'; return true }
  join = res.error === 'timeout' || res.error === 'offline' ? 'idle' : 'refused'
  return false
}

/**
 * A SIGN-IN DOOR HAS OPENED, so whatever session comes next is a new one.
 *
 * Called from signinPath.claim() — the module every door of every sign-in screen already
 * goes through, and the only chokepoint in this app that means "somebody is signing in
 * right now". It clears a sign-out, and it clears a refusal too: an account whose panel
 * record has no rendezvous is a property of the ACCOUNT, so the next one to sign in on
 * this device deserves its own answer.
 *
 * Idempotent, and it never joins anything itself — the catalog push does that.
 */
export function armRendezvous (): void {
  if (join === 'signed-out' || join === 'refused') join = 'idle'
}

/**
 * SIGN-OUT. Three things stop together, and the first is the one that is easy to forget:
 *
 *   1. LEAVE THE RENDEZVOUS. Its key is derived from the ACCOUNT, so a signed-out device
 *      that stays on it is still announcing "a device of this account is here" and, on a
 *      television, still accepting that account's commands.
 *   2. Stop anything being sent — a cast still running is this device serving entitled
 *      content to a television for an account it no longer holds.
 *   3. HOLD the door shut. The catalog push that triggers a join keeps arriving after a
 *      sign-out (it rewrites the prefs file; the engine keeps its session and keeps
 *      publishing), so a latch that merely reset put this device straight back on the
 *      signed-out account's rendezvous at the operator's next catalog edit. Only a
 *      sign-in door re-opens it — see armRendezvous().
 */
export function leaveRendezvous (): void {
  join = 'signed-out'
  stopSending().catch(() => {})
  peers = []
  try { backend.stopRemote() } catch { /* no engine, or never joined */ }
  emit()
}

/** Keep the peer list mirrored here so the sheet reads it synchronously at mount.
 *  Called once from App; returns the unsubscribe. */
export function watchPeers (): () => void {
  return backend.onRemotes((list) => {
    peers = list
    // A television that left the rendezvous cannot still be playing what we sent it.
    if (active?.kind === 'handoff' && !list.some((p) => p.deviceId === active?.deviceId)) {
      active = null
    }
    emit()
  })
}

/**
 * Hand the channel to another Aliran device. Resolves null on success, or the reason.
 *
 * `ok` means the television ACCEPTED — it checked its own entitlements and told its host
 * to tune. What then happened arrives as a status push, not here.
 */
export async function sendHandoff (target: HandoffTarget, stream: Stream): Promise<SendFailure | null> {
  const res = await backend.remotePlay(target.deviceId, stream.id)
  if (!res.ok) return normalizeRemoteError(res.error)
  active = {
    kind: 'handoff',
    deviceId: target.deviceId,
    deviceName: target.name,
    streamId: stream.id,
    streamTitle: stream.title,
    pinned: false,
    group: false
  }
  emit()
  return null
}

function normalizeRemoteError (code: string | undefined): SendFailure {
  switch (code) {
    case 'refused': case 'unentitled': case 'unavailable':
    case 'timeout': case 'unknown': case 'offline':
      return code
    default:
      // The engine's vocabulary can grow past this build's copy of it. An unknown code
      // gets the generic sentence, never a guess at which of the six it resembles.
      return 'failed'
  }
}

/**
 * Cast the channel to a Chromecast.
 *
 * THE PIN IS DECIDED FIRST, before anything is connected or served, because pinning is a
 * START-TIME option on the engine: there is no way to narrow a session that is already
 * running. Both facts it rests on come off the device the viewer tapped —
 *
 *   no address        the platform did not report one, or reported something that is not
 *                     on the local network (see cast.parseAddress). Nothing to pin to.
 *   a GROUP           every member fetches the media itself, so one address would serve
 *                     one speaker and 404 the rest. Nothing correct to pin to.
 *
 * — and either one means the session runs unpinned. That is a state, not a fallback: it
 * is on the active card in words, because unpinned is what most sessions will be.
 *
 * Every failure after the session connects tears down what the earlier steps built. A
 * cast session left up with no media, or an origin server left running for a television
 * that never took the URL, are both this phone awake and serving for nobody.
 */
export async function sendCast (target: CastTarget, stream: Stream): Promise<SendFailure | null> {
  const pin = target.address && !target.isGroup ? target.address : null

  // Before the session, so the framework's media notification can post the moment one
  // exists. Never blocks the cast — see askNotificationPermission.
  await cast.askNotificationPermission()

  if (!(await cast.connect(target.deviceId))) return 'cast-connect'

  const started = await backend.startCast(stream.id, pin ? { receiverHost: pin } : {})
  if (!started.ok || !started.session) { await cast.endSession(); return 'cast-serve' }

  const ok = await cast.loadMedia(started.session.url, {
    title: stream.title,
    live: stream.type !== 'vod',
    image: stream.logo
  })
  if (!ok) {
    await backend.stopCast()
    await cast.endSession()
    return 'cast-load'
  }

  // WHAT THE ENGINE PINNED, NOT WHAT WE ASKED IT TO. `session.receiverHost` is the
  // engine's own normalised list (sdk/player.js normalizeReceivers) and it is typed on
  // CastSessionInfo precisely so a host can confirm; absent means the session serves any
  // peer that can read the URL off the television. The sentence a viewer reads their
  // exposure off has to be computed from that, because everything between the request
  // and the answer can drop the pin — an address the engine would not take, an option a
  // worklet does not know. The one direction this can be wrong is a worklet too old to
  // echo the field, and then it reads "unpinned" on a session that is pinned: the
  // warning overstates the exposure rather than hiding it.
  const pinnedTo = started.session.receiverHost
  active = {
    kind: 'cast',
    deviceId: target.deviceId,
    // What the RECEIVER calls itself once connected, when it will say — a group renames
    // itself between discovery and a session more often than a single set does.
    deviceName: (await cast.sessionDeviceName()) || target.name,
    streamId: stream.id,
    streamTitle: stream.title,
    pinned: Array.isArray(pinnedTo) && pinnedTo.length > 0,
    group: target.isGroup,
    host: started.session.host,
    candidates: started.session.candidates
  }
  armTeardown()
  emit()
  return null
}

/**
 * The two ways a cast stops without anybody pressing Stop here, and both have to reach
 * the other half:
 *
 *   the television dropped the session  -> stop serving (an origin server with no
 *                                          receiver is this phone awake for nobody)
 *   the engine ended the session        -> end it on the television too, or it sits on
 *                                          a URL that now 404s
 */
function armTeardown () {
  disarmTeardown()
  offSessionEnded = cast.onSessionEnded(() => {
    backend.stopCast().catch(() => {})
    clearActive()
  })
  offCastEnded = backend.onCastEnded(() => {
    cast.endSession().catch(() => {})
    clearActive()
  })
}

function disarmTeardown () {
  try { offSessionEnded?.() } catch { /* already gone */ }
  try { offCastEnded?.() } catch { /* already gone */ }
  offSessionEnded = null
  offCastEnded = null
}

function clearActive () {
  disarmTeardown()
  active = null
  emit()
}

/** Stop whatever is running. Idempotent, and it stops BOTH halves of a cast. */
export async function stopSending (): Promise<void> {
  const was = active
  clearActive()
  if (!was) return
  if (was.kind === 'cast') {
    await backend.stopCast().catch(() => {})
    await cast.endSession()
  } else {
    await backend.remoteStop(was.deviceId).catch(() => {})
  }
}

/** Test seam: drop everything this module is holding between cases. */
export function __resetForTests () {
  disarmTeardown()
  active = null
  peers = []
  join = 'idle'
  listeners.clear()
}
