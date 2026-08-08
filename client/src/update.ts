// OTA update check plumbing shared by App (the banner) and Settings (the manual
// "Check for updates" row). Module singleton — like the backend — so both surfaces
// see the same verdict and the throttle survives remounts.
//
// Gate: a panel connection must exist to ask — the baked key (operator flavor) or a
// runtime-paired service (keyless flavor, per the re-hosting decision: a paired
// keyless build checks the PAIRED panel for its own applicationId). An unpaired
// keyless install has no update source at all. The check itself is cheap (a sparse
// manifest read); the throttle exists so foreground flapping doesn't hammer it.

import { getAppInfo, type NativeAppInfo, type UpdateCheckResult, type UpdateEntry } from '@aliran/react-native'
import { backend } from './worklet'
import { hasBakedKey } from './config'

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface AvailableUpdate {
  entry: UpdateEntry
  mandatory: boolean
}

let lastCheckAt = 0
let appInfo: NativeAppInfo | null | undefined // undefined = never asked
let available: AvailableUpdate | null = null
const listeners = new Set<(u: AvailableUpdate) => void>()

/** The running build's native identity, resolved once (null = no installer module —
 *  iOS/desktop/dev/stale APK). Also feeds the Settings version row. */
export async function appInfoCached (): Promise<NativeAppInfo | null> {
  if (appInfo === undefined) appInfo = await getAppInfo()
  return appInfo
}

/** Subscribe to "an update is available" verdicts (fires on every check that finds
 *  one, and immediately when one is already known). Returns the unsubscribe. */
export function onUpdateAvailable (fn: (u: AvailableUpdate) => void) {
  listeners.add(fn)
  if (available) fn(available)
  return () => { listeners.delete(fn) }
}

/**
 * Run an update check. Resolves null when the check does not APPLY here (no panel
 * to ask, no installer module) — distinct from { status: 'unknown' }, which is the
 * engine saying "cannot answer right now, try later". Unforced calls respect the
 * 6 h throttle and answer from the cache; Settings' manual row passes force.
 */
export async function checkForUpdate (opts: { force?: boolean } = {}): Promise<UpdateCheckResult | null> {
  if (!hasBakedKey() && !backend.service) return null
  const info = await appInfoCached()
  if (!info) return null // nothing could install the result anyway
  if (!opts.force && Date.now() - lastCheckAt < CHECK_INTERVAL_MS) {
    return available ? { status: 'available', entry: available.entry, mandatory: available.mandatory } : null
  }
  lastCheckAt = Date.now()
  const res = await backend.checkUpdate({ appId: info.packageName, platform: 'android', versionCode: info.versionCode })
  if (res.status === 'available' && res.entry) {
    available = { entry: res.entry, mandatory: !!res.mandatory }
    listeners.forEach((fn) => fn(available as AvailableUpdate))
  } else if (res.status === 'current' || res.status === 'none') {
    // A definite "no update" clears a stale verdict (e.g. the operator pulled the
    // entry between checks). 'unknown' clears nothing — it is not an answer.
    available = null
  }
  return res
}
