// Native OTA installer binding (Android): typed wrappers over the
// NativeModules.AliranUpdate module that ships in this package's android/ library
// (autolinked into any consuming RN app). On platforms/builds WITHOUT the module —
// iOS, desktop, jest, an APK built before the library existed — every call degrades
// instead of throwing at import time: getAppInfo() resolves null, the two gates
// resolve false, and only installApk() rejects (it is the one call that must never
// pretend to have worked).
//
// The flow these serve (OTA app updates): backend.checkUpdate(getAppInfo()) →
// backend.downloadUpdate() → 'update-ready' { path } → canRequestInstall() /
// openInstallSettings() → installApk(path). The engine sha256-verifies before
// 'update-ready'; Android's same-signer check is the final backstop.

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native'

/** What the running APK says about itself. Native and flavor-aware: packageName is
 *  the brand applicationId — exactly the appId the panel's updates manifest keys on —
 *  and versionCode/versionName are the INSTALLED build's, not package.json's. */
export interface NativeAppInfo {
  packageName: string
  versionCode: number
  versionName: string
}

interface AliranUpdateNative {
  getAppInfo (): Promise<NativeAppInfo>
  canRequestInstall (): Promise<boolean>
  openInstallSettings (): Promise<boolean>
  installApk (path: string): Promise<boolean>
}

function native (): AliranUpdateNative | null {
  if (Platform.OS !== 'android') return null
  return ((NativeModules as Record<string, unknown>).AliranUpdate as AliranUpdateNative) ?? null
}

/** Identity of the running build, or null where the installer module is absent. */
export async function getAppInfo (): Promise<NativeAppInfo | null> {
  const m = native()
  if (!m) return null
  try { return await m.getAppInfo() } catch { return null }
}

/** Whether this app may launch APK installs (the Android O+ per-app
 *  "install unknown apps" setting; always true below O). False without the module. */
export async function canRequestInstall (): Promise<boolean> {
  const m = native()
  if (!m) return false
  try { return await m.canRequestInstall() } catch { return false }
}

/** Open the system "install unknown apps" screen for this app, so the viewer can
 *  grant the permission and come back. Resolves false when there is nothing to
 *  open (pre-O, module absent). */
export async function openInstallSettings (): Promise<boolean> {
  const m = native()
  if (!m) return false
  try { return await m.openInstallSettings() } catch { return false }
}

/** Hand a downloaded-and-verified APK (the 'update-ready' path — must be inside the
 *  app's own files dir) to Android's PackageInstaller. Resolves once the OS
 *  confirmation UI has taken over (the install's real outcome arrives as the app
 *  restarting on the new build, or the viewer cancelling); rejects when no installer
 *  exists here or the session fails before the handoff. */
export function installApk (path: string): Promise<boolean> {
  const m = native()
  if (!m) return Promise.reject(new Error('APK installer unavailable on this platform'))
  return m.installApk(path)
}

/** The install's TERMINAL verdict. installApk() resolves at the confirmation-UI
 *  handoff, but the OS reports the real outcome later through the same session —
 *  e.g. a same-signer refusal after the viewer confirms. A successful update
 *  replaces the process before this can fire, so in practice only failures are
 *  heard. Returns an unsubscribe. */
export function onInstallResult (cb: (r: { success: boolean, message?: string }) => void): () => void {
  const sub = DeviceEventEmitter.addListener('aliranUpdateInstallResult', cb)
  return () => sub.remove()
}
