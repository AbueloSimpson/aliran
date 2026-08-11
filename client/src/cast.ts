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
//   2. NO MODULE AT ALL. A jest run has no native side, and the legacy flavor strips
//      native modules. require() is guarded and everything below degrades to
//      "cast is not available here".
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
import { Platform } from 'react-native'

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

// The library, resolved once. A build without it (jest, the legacy flavor) leaves this
// null and every function below turns into a no-op.
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
 * On ANDROID the framework runs discovery itself while the app is in the foreground and
 * suspends it in the background; startDiscovery/stopDiscovery are iOS-only and are called
 * here only so an iOS build would behave. So this does not "turn discovery on" — it
 * subscribes to a list the framework is already keeping.
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
    manager.startDiscovery?.() // iOS only; a no-op on Android
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
 * The address, out of what the Android bridge actually sends.
 *
 * IT IS NOT A BARE ADDRESS. The bridge stringifies a java.net.InetAddress, and
 * InetAddress.toString() renders as `hostname/1.2.3.4` — or `/1.2.3.4` when there is no
 * hostname. Passing that through as a host would produce a pin that matches nothing, and
 * a session that believes it is pinned while serving every peer is the worst possible
 * outcome of this feature. So the address is the part after the last slash, and it then
 * has to survive isLanAddress before it is used at all.
 *
 * Returns null for anything that is not an address on the local network.
 */
export function parseAddress (raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const tail = raw.slice(raw.lastIndexOf('/') + 1).trim()
  return isLanAddress(tail) ? tail : null
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

/**
 * Connect to a receiver. Resolves false when the framework says the session did not
 * start.
 *
 * Lenient about the shape of "yes" and strict about "no": only an explicit false is
 * treated as a refusal, because a session that started and then cannot take the media
 * fails again at loadMedia — which tears both halves down anyway.
 */
export async function connect (deviceId: string): Promise<boolean> {
  if (!castSupported()) return false
  try {
    return (await castContext()?.getSessionManager?.()?.startSession?.(deviceId)) !== false
  } catch { return false }
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

/** Hand the receiver a URL to play. `live` picks the stream type — a live channel has no
 *  duration, and the television's own controls must not offer a seek bar for one. */
export async function loadMedia (url: string, opts: { title?: string; live?: boolean; image?: string } = {}): Promise<boolean> {
  if (!castSupported()) return false
  try {
    const session = await castContext()?.getSessionManager?.()?.getCurrentCastSession?.()
    const client = session?.client ?? session?.getClient?.()
    if (!client?.loadMedia) return false
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
    return true
  } catch { return false }
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
