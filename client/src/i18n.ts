// Which language this app starts in (S56 design D5). Detection only — the catalogs
// and the t()/tn() runtime live in @aliran/i18n.
//
// IMPORTING THIS MODULE SETS THE LOCALE. That side effect is the point: React Native
// renders the first screen synchronously, so anything asynchronous would paint English
// and then repaint. App.tsx imports it before any screen, the device language is read
// from constants that are already in memory, and the very first frame is in the
// viewer's language.
//
// The saved override (worklet prefs, `language`) arrives later — with the {type:'prefs'}
// reply the splash already waits for — and App.tsx applies it there. Only the splash is
// on screen during that swap.
//
// PERMISSIONLESS by design: everything below is a core-module constant. No new Android
// permission, no locale library, nothing that can prompt the viewer.

import { NativeModules, Platform } from 'react-native'
import { SUPPORTED_LOCALES, resolveLocale, setLocale, type Locale } from '@aliran/i18n'
import { loadServiceDescriptor } from './config'

/**
 * The device's own UI language as a BCP-47-ish tag ('es-MX', 'pt-BR', 'ja'), or 'en'
 * when nothing will say. Every source is wrapped: these are optional native modules,
 * and a device that answers oddly must degrade to English, never crash the app before
 * its first frame.
 */
export function deviceLocaleTag (): string {
  try {
    if (Platform.OS === 'android') {
      // React Native's own I18nManager module carries the system locale as
      // `localeIdentifier` — a core module in every RN build, so no dependency and no
      // permission. Newer RN moves module constants behind getConstants().
      const mod = (NativeModules as Record<string, any>).I18nManager
      const constants = mod?.getConstants?.() ?? mod
      const tag = constants?.localeIdentifier
      // Android spells it with an underscore ('es_MX'); resolveLocale normalizes that
      // too, but the tag is also returned to callers, so hand out the BCP-47 form.
      if (typeof tag === 'string' && tag) return tag.replace(/_/g, '-')
    } else if (Platform.OS === 'ios') {
      const settings = (NativeModules as Record<string, any>).SettingsManager?.settings
      const tag = settings?.AppleLocale ?? (Array.isArray(settings?.AppleLanguages) ? settings.AppleLanguages[0] : null)
      if (typeof tag === 'string' && tag) return tag.replace(/_/g, '-')
    }
  } catch { /* no such module on this platform/build — fall through */ }
  try {
    // Last resort, and the one jest and any future platform take: Hermes' Intl is not
    // trusted for formatting (see lang.ts), but the resolved locale tag is just a string.
    const tag = Intl.DateTimeFormat().resolvedOptions().locale
    if (typeof tag === 'string' && tag) return tag
  } catch { /* no Intl at all */ }
  return 'en'
}

/** The operator's preferred language for viewers who have no supported one of their
 *  own (`defaultLocale` in the service descriptor). Optional; absent in every shipped
 *  descriptor so far. */
export function serviceDefaultLocale (): string | null {
  try {
    return loadServiceDescriptor().defaultLocale ?? null
  } catch {
    return null // an unconfigured build throws here; the language is not what's wrong
  }
}

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES.map((l) => l.code))

/**
 * First tag that names a language we actually ship, else 'en'. This is the resolution
 * order of D5 written once — saved pref > device > operator default > English — with
 * the caveat that makes it work: resolveLocale() answers 'en' both for a real English
 * tag and for a language we do not have, and only the former may end the search.
 */
export function pickLocale (...tags: (string | null | undefined)[]): Locale {
  for (const tag of tags) {
    if (!tag) continue
    const base = tag.replace(/_/g, '-').toLowerCase().split('-')[0]
    if (base === 'zh' || SUPPORTED.has(base)) return resolveLocale(tag)
  }
  return 'en'
}

// The first paint's language. Deliberately at module scope — see the header.
setLocale(pickLocale(deviceLocaleTag(), serviceDefaultLocale()))
