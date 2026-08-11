// Google Cast binding (phone only). The ONE place this app talks to
// react-native-google-cast, so every rule below is enforced in a single file rather
// than at each call site.
//
// THREE THINGS THIS FILE EXISTS TO SURVIVE.
//
//   1. NO PLAY SERVICES. The Cast framework is absent on Fire OS sticks, AOSP boxes and
//      de-Googled phones, and this fleet has such devices. Availability is asked through
//      CastContext.getPlayServicesState(), which probes GoogleApiAvailability and never
//      touches CastContext.getSharedInstance() — the call that throws where the answer is
//      no. The UI asks BEFORE it draws a button, so the outcome is a missing button.
//
//   2. NO MODULE AT ALL. A build can be assembled without react-native-google-cast, so
//      the require() below is guarded and everything under it degrades to "cast is not
//      available here".
//
//      A jest run is NOT one of those, whatever this comment used to say. The package is
//      installed in the test workspace and loads; what a test run lacks is the NATIVE
//      side, so the module answers and every call under it reaches nothing. Tests are
//      given __mocks__/react-native-google-cast.js through jest.config.js rather than the
//      real package, and that mock file records why the substitution had to move into
//      config to be reliable.
//
//   3. A TELEVISION. Casting FROM an Android TV is meaningless (the set IS the receiver)
//      and the button would sit in the D-pad path — the S7 lesson, see NowPlayingBar.
//      Gated off wholesale.
//
// WHAT THE HOST OWES THE ENGINE. The Aliran engine serves the cast stream from this phone
// and can be told to serve ONE address and refuse every other peer. It cannot find that
// address — it does not speak the Cast protocol — so the address comes from here, off the
// device the viewer picked, and goes into startCast() before the server binds. Two device
// facts decide it, and both are on the Device object the picker already holds:
// `ipAddress`, and whether `capabilities` says MultizoneGroup.
import { PermissionsAndroid, Platform, type Permission } from 'react-native'

/** A Chromecast the discovery manager can see. */
export interface CastDevice {
  id: string
  name: string
  model?: string
  /**
   * The device's LAN address — the pin for a cast session — or null when the platform did
   * not give a usable one. Never a bare copy of what the bridge sent: see parseAddress.
   */
  address: string | null
  /**
   * A multi-room GROUP. It fetches the media from every member rather than through the
   * device the sender launched on, and the members' own addresses are not exposed, so a
   * group has no correct pin and must run unpinned.
   */
  isGroup: boolean
}

// The library, resolved once. A build without it (a jest run) leaves this null and every
// function below turns into a no-op.
let lib: any = null
try { lib = require('react-native-google-cast') } catch { lib = null }

function castContext (): any {
  // Named export in v4; the default export is the same class.
  return lib?.CastContext ?? lib?.default ?? null
}

/**
 * Could this build/device cast at all? A synchronous, cheap pre-filter — the library is
 * present, this is Android, and this is not a television. It does NOT prove the Cast
 * framework is usable: only castAvailable() does, and that one is async.
 */
export function castSupported (): boolean {
  return !!lib && Platform.OS === 'android' && !Platform.isTV
}

/**
 * Does this device actually have the Cast framework? getPlayServicesState() answers
 * 'success' | 'missing' | 'updating' | 'updateRequired' | 'disabled' | 'invalid', and
 * only the first one means "cast is possible here". Anything else — including a null
 * from a platform that does not implement the probe — hides the button.
 *
 * Never rejects.
 */
export async function castAvailable (): Promise<boolean> {
  if (!castSupported()) return false
  try {
    return (await castContext()?.getPlayServicesState?.()) === 'success'
  } catch { return false }
}

/**
 * Start looking for receivers, and call back with the list as it changes. Returns the
 * unsubscribe (usable as a useEffect cleanup).
 *
 * The framework runs discovery itself while the app is in the foreground and suspends it
 * in the background — startDiscovery/stopDiscovery are the iOS half of the library's API
 * and castSupported() already gated this to Android, so the two calls below are inert
 * belt-and-braces rather than anything this app relies on. So this does not "turn
 * discovery on": it subscribes to a list the framework is already keeping.
 */
export function discover (onDevices: (devices: CastDevice[]) => void): () => void {
  if (!castSupported()) return () => {}
  let stopped = false
  let sub: { remove?: () => void } | null = null
  let manager: any = null
  const push = (list: unknown) => {
    // A non-array is "no answer", not "no devices". getDevices() resolves AFTER the first
    // onDevicesUpdated on a warm framework, so treating undefined as an empty list would
    // wipe a list that had already arrived.
    if (stopped || !Array.isArray(list)) return
    onDevices(normalizeDevices(list))
  }
  try {
    manager = castContext()?.getDiscoveryManager?.()
    if (!manager) return () => {}
    sub = manager.onDevicesUpdated?.(push) ?? null
    manager.startDiscovery?.() // the library's iOS half; never reached on this Android-only path
    // …and the devices already known, because onDevicesUpdated only fires on a CHANGE.
    Promise.resolve(manager.getDevices?.()).then(push).catch(() => {})
  } catch {
    // No framework, or a library shape this build does not know. Silent: the sheet has
    // already decided whether to offer casting at all.
    return () => {}
  }
  return () => {
    stopped = true
    try { sub?.remove?.() } catch { /* already gone */ }
    try { manager?.stopDiscovery?.() } catch { /* already gone */ }
  }
}

function normalizeDevices (list: unknown[]): CastDevice[] {
  const out: CastDevice[] = []
  for (const d of list as any[]) {
    const id = d?.deviceId
    if (typeof id !== 'string' || !id) continue
    const caps: unknown = d?.capabilities
    out.push({
      id,
      name: String(d?.friendlyName || id),
      model: d?.modelName ? String(d.modelName) : undefined,
      address: parseAddress(d?.ipAddress),
      // 'MultizoneGroup' is the bridge's word for CastDevice.CAPABILITY_MULTIZONE_GROUP.
      isGroup: Array.isArray(caps) && caps.includes('MultizoneGroup')
    })
  }
  return out
}

/**
 * The address, out of what the Android bridge actually sends — in the ONE spelling the
 * engine's pin can match.
 *
 * IT IS NOT A BARE ADDRESS. The bridge stringifies a java.net.InetAddress, and
 * InetAddress.toString() renders as `hostname/1.2.3.4` — or `/1.2.3.4` when there is no
 * hostname. Passing that through as a host would produce a pin that matches nothing, and
 * a session that believes it is pinned is the worst possible outcome of this feature. So
 * the address is the part after the last slash.
 *
 * AND THE SPELLING IS NOT FREE EITHER, WHICH IS THE IPv6 HALF OF THE SAME BUG. The engine
 * compares the pin against a socket's remote address after a normaliser that lowercases,
 * drops the `%zone` and folds the v4-mapped forms — and which says in its own comment
 * that it is not a general IPv6 canonicaliser. Java's getHostAddress() renders IPv6
 * UNCOMPRESSED (`fe80:0:0:0:0:0:0:1%wlan0`, never `fe80::1`), the peer arrives compressed,
 * and the two are then different strings for one host: the pin matches nothing, the
 * television 404s, and the card says "only that TV can get the channel" over a cast that
 * does not work. Fail-closed for exposure and fail-open for honesty, one address family
 * over from the case this whole function exists to prevent. So an IPv6 address is put
 * into the canonical form (RFC 5952 — what inet_ntop produces, and therefore what the
 * socket will report), and anything that cannot be canonicalised with certainty returns
 * null: the session then runs UNPINNED and the card says so, which is true.
 *
 * Returns null for anything that is not an address on the local network.
 */
export function parseAddress (raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const tail = raw.slice(raw.lastIndexOf('/') + 1).trim()
  // The zone names an interface on THIS device and is no part of the peer's address; the
  // engine strips it too, so sending it would only be noise on the wire.
  const bare = tail.split('%')[0].toLowerCase()
  if (!bare) return null
  const addr = bare.includes(':') ? canonicalIPv6(bare) : bare
  return addr && isLanAddress(addr) ? addr : null
}

/**
 * An IPv6 literal in the one form a socket peer will be reported as: lowercase, no
 * leading zeros in a group, and the LONGEST run of two or more zero groups replaced by
 * `::` (leftmost on a tie). That is RFC 5952, and it is what inet_ntop — and therefore
 * every runtime that reports a remote address — produces.
 *
 * Deliberately a PARSER, not a tidier: eight groups after expansion, hex only, an
 * optional embedded IPv4 tail, and null for everything else. A value this cannot read is
 * a value whose spelling cannot be guaranteed to match, and an unpinned session that says
 * it is unpinned beats a pinned one that serves nobody.
 */
function canonicalIPv6 (addr: string): string | null {
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = expandGroups(halves[0])
  const tail = halves.length === 2 ? expandGroups(halves[1]) : []
  if (!head || !tail) return null
  // `::` stands for at least one omitted group, so a compressed form carries at most 7.
  const groups = halves.length === 2
    ? (head.length + tail.length > 7 ? null : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail])
    : (head.length === 8 ? head : null)
  if (!groups) return null
  // Re-compress from the full eight, so an input that compressed a single zero group —
  // or a shorter run than the longest — comes back out spelled the one canonical way.
  let bestAt = -1
  let bestLen = 0
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== '0') continue
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > bestLen) { bestLen = j - i; bestAt = i }
    i = j - 1
  }
  if (bestLen < 2) return groups.join(':')
  return groups.slice(0, bestAt).join(':') + '::' + groups.slice(bestAt + bestLen).join(':')
}

/** One side of a `::`, as zero-stripped hex groups — or null if any of it is not one.
 *  An embedded IPv4 tail (`::ffff:192.168.1.5`) counts as two groups. */
function expandGroups (half: string): string[] | null {
  if (half === '') return []
  const list = half.split(':')
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    const g = list[i]
    if (g.includes('.')) {
      if (i !== list.length - 1) return null // only ever the tail
      const o = g.split('.')
      if (o.length !== 4 || !o.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null
      const n = o.map(Number)
      out.push((n[0] * 256 + n[1]).toString(16), (n[2] * 256 + n[3]).toString(16))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(g.replace(/^0+(?=.)/, ''))
  }
  return out
}

/**
 * Is this an address on the local network — the only kind worth pinning a cast session
 * to? RFC1918, link-local, carrier-grade NAT, and the IPv6 equivalents.
 *
 * The cast server binds a PRIVATE address, so a receiver that can reach it has one too.
 * Anything else is the platform reporting something that is not the peer which will
 * fetch the media, and pinning to it would 404 the one that does.
 */
export function isLanAddress (addr: string): boolean {
  if (!addr) return false
  // IPv6 arrives with a zone suffix on Android ('fe80::1%wlan0'); the zone names an
  // interface on THIS device and is not part of the peer's address.
  const a = addr.split('%')[0].toLowerCase()
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(a)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(a)) return true // link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(a)) return true // CGNAT
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true // IPv6 unique-local
  return false
}

// How long a receiver has to produce a session. A set that is asleep has to wake, join
// the network and launch the receiver application before it can answer, so this is sized
// like a cold start rather than a local call — the picker shows a spinner on the row the
// whole time. It is a ceiling, not a wait: the ordinary answer is an event in under a
// second, and this only decides how long a television that says NOTHING may hold the sheet.
const SESSION_START_MS = 30000
// …and how often the current session is re-read while waiting. See awaitSession: the
// events are the answer, and this catches the two things they cannot report.
const SESSION_POLL_MS = 500

/**
 * Connect to a receiver: resolves once a Cast SESSION really exists, or false.
 *
 * startSession() DOES NOT MEAN THAT, and believing it did is what broke casting on every
 * channel and every television. The bridge (RNGCSessionManager.java) looks the device up
 * in the MediaRouter's route list, calls `router.selectRoute(routeInfo)` and resolves
 * true — and selectRoute is fire-and-forget. Its promise means "a matching route was
 * selected", never "a session exists": the session is established asynchronously
 * afterwards and reported through onSessionStarted / onSessionStartFailed. So the flow
 * went straight on to stand a LAN origin server up and hand the media URL to a session
 * that was not there yet, every attempt failed, and the sheet blamed the URL. Measured
 * with a castv2 probe against two sets: no Default Media Receiver session existed at all.
 *
 * Lenient about the shape of "yes" and strict about "no": an explicit false from
 * startSession means no route matched, and there is nothing to wait for.
 */
export async function connect (deviceId: string): Promise<boolean> {
  if (!castSupported()) return false
  try {
    // The manager and the method are checked BEFORE the leniency about the return value.
    // Written as one optional chain, every miss on the way in produced `undefined`, which
    // is not `false` — so a library shape this build does not know read as a connected
    // session and the flow went on to stand a LAN origin server up for a television that
    // was never asked anything.
    const manager = castContext()?.getSessionManager?.()
    if (typeof manager?.startSession !== 'function') return false
    // SUBSCRIBED FIRST. A receiver that is already awake answers in a few hundred
    // milliseconds, and a listener attached after the request is a listener attached
    // after the event it exists for.
    const session = awaitSession(manager, deviceId)
    let selected
    try { selected = await manager.startSession(deviceId) } catch (err) { session.cancel(); throw err }
    if (selected === false) { session.cancel(); return false }
    return await session.settled
  } catch { return false }
}

/**
 * Wait for the session the request above asked for: true when one starts, false when the
 * framework says it will not, false when the television simply never answers.
 *
 * THE POLL IS NOT BELT-AND-BRACES. Two real cases produce no event at all, and both of
 * them would otherwise hold the sheet for the full ceiling and then report a failure over
 * a session that is up and working:
 *
 *   the route is ALREADY selected   the viewer casts a second channel to the set they are
 *                                   already casting to. selectRoute() has nothing to
 *                                   change, so no session STARTS — there is one already.
 *   a build with no events          the native side of this library attaches its session
 *                                   listener on host resume; a shape that does not emit
 *                                   still answers getCurrentCastSession().
 *
 * And the poll checks WHICH device, which the events need not: a session to another
 * television in the house is live at this moment for a viewer who is switching sets, and
 * answering "connected" off that one would hand this channel's URL to the wrong room.
 */
function awaitSession (manager: any, deviceId: string): { settled: Promise<boolean>; cancel: () => void } {
  const subs: { remove?: () => void }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let answer: ((ok: boolean) => void) | null = null
  const finish = (ok: boolean) => {
    if (!answer) return
    const done = answer
    answer = null
    if (timer) { clearTimeout(timer); timer = null }
    if (poll) { clearInterval(poll); poll = null }
    for (const s of subs) { try { s?.remove?.() } catch { /* already gone */ } }
    subs.length = 0
    done(ok)
  }
  const settled = new Promise<boolean>((resolve) => { answer = resolve })
  try {
    const started = manager.onSessionStarted?.(() => finish(true))
    if (started) subs.push(started)
    const failed = manager.onSessionStartFailed?.(() => finish(false))
    if (failed) subs.push(failed)
  } catch { /* a library shape without the events — the poll is then the whole answer */ }
  timer = setTimeout(() => finish(false), SESSION_START_MS)
  poll = setInterval(() => {
    currentSessionIs(manager, deviceId).then((yes) => { if (yes) finish(true) }).catch(() => {})
  }, SESSION_POLL_MS)
  return { settled, cancel: () => finish(false) }
}

/** Is the framework's current session a session with THIS device? False for no session,
 *  for a session with another receiver, and for anything that will not say. */
async function currentSessionIs (manager: any, deviceId: string): Promise<boolean> {
  const session = await manager.getCurrentCastSession?.()
  if (!session) return false
  const device = await session.getCastDevice?.()
  return !!device && device.deviceId === deviceId
}

/**
 * Ask for the notification permission the Cast framework's media notification needs, if
 * this device is new enough to require one and has not already answered.
 *
 * ASKED AT THE CAST, not at start-up: it is the one moment the app has a reason to want
 * it, and it is the moment a viewer can see why. The framework configures that
 * notification unconditionally (GoogleCastOptionsProvider) and from API 33 cannot post it
 * without the grant — so without this the shade and lock-screen controls were dead on
 * every current device however the manifest was written.
 *
 * NEVER BLOCKS AND NEVER THROWS. A refusal, an old platform, a missing module: the cast
 * goes ahead either way, and the standing chip on the Live screen is the sign that does
 * not depend on any of this.
 */
export async function askNotificationPermission (): Promise<void> {
  // Written as "is it 33 or more" rather than "is it under 33" on purpose: a platform that
  // does not report a numeric version answers NaN, and NaN fails BOTH comparisons — so the
  // negative form would have walked an unknown runtime into a permission dialog.
  if (Platform.OS !== 'android' || !(Number(Platform.Version) >= 33)) return
  try {
    // Read off the map rather than named: PERMISSIONS.POST_NOTIFICATIONS is absent from
    // older react-native typings AND from older runtimes, and this must degrade on both.
    const perm = (PermissionsAndroid.PERMISSIONS as Record<string, Permission>).POST_NOTIFICATIONS
    if (!perm || await PermissionsAndroid.check(perm)) return
    await PermissionsAndroid.request(perm)
  } catch { /* no native module, or the dialog could not be shown — cast anyway */ }
}

/** The name the receiver reports for itself, once a session exists — better than the
 *  discovery-list name for the active card. Null when there is nothing to ask. */
export async function sessionDeviceName (): Promise<string | null> {
  if (!castSupported()) return null
  try {
    const session = await castContext()?.getSessionManager?.()?.getCurrentCastSession?.()
    const device = await session?.getCastDevice?.()
    const name = device?.friendlyName
    return typeof name === 'string' && name ? name : null
  } catch { return null }
}

// How long the receiver has to get from "load accepted" to "playing". Sized like a cold
// tune on a set that has to fetch a playlist and fill a buffer, not like a local call.
const MEDIA_PLAY_MS = 20000

/**
 * Hand the receiver a URL to play, and resolve only once it IS playing. `live` picks the
 * stream type — a live channel has no duration, and the television's own controls must not
 * offer a seek bar for one.
 *
 * loadMedia() ON ITS OWN MEANS "THE RECEIVER ACCEPTED THE REQUEST", which is the same
 * promise-means-accepted trap as startSession() one screen up, and it cost the same thing:
 * the app declared the cast a success, the sheet put "Sending to TV" on screen, and the
 * television sat on a Chromecast logo with `playerState: NONE, buffered: 0`. Measured on a
 * TCL set — the receiver took the load, fetched once, and never played. The viewer was told
 * nothing at all, which is worse than an error.
 *
 * So the answer here is the receiver's own media status: PLAYING is the only success.
 * `loading` and `buffering` are progress, not arrival — a stalled cast sits in `buffering`
 * for ever, which is precisely the state that used to be reported as working.
 */
export async function loadMedia (url: string, opts: { title?: string; live?: boolean; image?: string } = {}): Promise<boolean> {
  if (!castSupported()) return false
  try {
    const session = await castContext()?.getSessionManager?.()?.getCurrentCastSession?.()
    const client = session?.client ?? session?.getClient?.()
    if (!client?.loadMedia) return false
    // Subscribed BEFORE the load, for the same reason the session listener is: a receiver
    // that starts quickly reports it quickly.
    const playing = awaitPlayback(client)
    try {
      await loadRequest(client, url, opts)
    } catch (err) { playing.cancel(); throw err }
    playing.armFailure() // …only now may an `idle` be OUR media rather than the last one's
    return await playing.settled
  } catch { return false }
}

/**
 * Resolve true when the receiver reports it is PLAYING, false when it reports it went idle
 * because of an error, false when it never gets there at all.
 *
 * THE FAILURE VERDICT IS ARMED LATE, and that is not a detail: the status stream carries
 * the PREVIOUS media too. A receiver that was idle a moment ago — which is every receiver
 * that has just been connected to — would otherwise answer for a load that has not even
 * been sent yet, and every cast would fail instantly.
 */
function awaitPlayback (client: any): { settled: Promise<boolean>; cancel: () => void; armFailure: () => void } {
  const subs: { remove?: () => void }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let answer: ((ok: boolean) => void) | null = null
  let armed = false
  const finish = (ok: boolean) => {
    if (!answer) return
    const done = answer
    answer = null
    if (timer) { clearTimeout(timer); timer = null }
    for (const s of subs) { try { s?.remove?.() } catch { /* already gone */ } }
    subs.length = 0
    done(ok)
  }
  const settled = new Promise<boolean>((resolve) => { answer = resolve })
  try {
    const sub = client.onMediaStatusUpdated?.((status: { playerState?: string; idleReason?: string } | null) => {
      const state = status?.playerState
      if (state === 'playing') return finish(true)
      // The receiver saying, in its own words, that it could not play what it was given.
      if (armed && state === 'idle' && status?.idleReason === 'error') return finish(false)
    })
    if (sub) subs.push(sub)
  } catch { /* a library shape without the status stream — the ceiling is then the answer */ }
  timer = setTimeout(() => finish(false), MEDIA_PLAY_MS)
  return { settled, cancel: () => finish(false), armFailure: () => { armed = true } }
}

/** The load call itself, kept separate so the wait above reads as one thing. */
async function loadRequest (client: any, url: string, opts: { title?: string; live?: boolean; image?: string }): Promise<void> {
  await client.loadMedia({
    mediaInfo: {
      contentUrl: url,
      // HLS. The receiver refuses to guess, and gets it wrong when it tries.
      contentType: 'application/x-mpegURL',
      streamType: opts.live === false ? 'buffered' : 'live',
      metadata: {
        type: 'generic',
        title: opts.title ?? '',
        ...(opts.image ? { images: [{ url: opts.image }] } : {})
      }
    },
    autoplay: true
  })
}

/**
 * End the session AND stop the receiver application (the `true`). Without it the
 * television keeps the receiver up on a URL that is already dead — the server closes and
 * the token is forgotten the moment the cast stops — so it would sit on an error nobody
 * asked for. Idempotent and never throws.
 */
export async function endSession (): Promise<void> {
  if (!castSupported()) return
  try { await castContext()?.getSessionManager?.()?.endCurrentSession?.(true) } catch { /* already gone */ }
}

/**
 * The receiver dropped the session — someone picked up the TV remote, the set was
 * switched off, the network moved. The host must then stop serving: an origin server left
 * running for a receiver that is gone is this phone awake, decrypting and listening for
 * nobody.
 */
export function onSessionEnded (fn: () => void): () => void {
  if (!castSupported()) return () => {}
  let sub: { remove?: () => void } | null = null
  try { sub = castContext()?.getSessionManager?.()?.onSessionEnded?.(() => fn()) ?? null } catch { return () => {} }
  return () => { try { sub?.remove?.() } catch { /* already gone */ } }
}
