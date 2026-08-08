// Which language the desktop app starts in (S56 design D5). Detection + persistence
// only; the catalogs and t()/tn() live in @aliran/i18n.
//
// All-renderer and synchronous by design: the main process knows nothing about the
// language, so there is no IPC round trip to wait for and no engine change. The choice
// lives in localStorage beside the volume and the parental record (parental.ts) — a
// device preference that is never sent anywhere.
//
// index.html keeps a static lang="en" as the pre-JS default; main.tsx replaces it with
// the real locale before the first render and on every later change, so the browser's
// own text handling (hyphenation, font fallback, spellcheck) follows the UI.

import { SUPPORTED_LOCALES, resolveLocale, setLocale, type Locale } from '@aliran/i18n'

const KEY = 'aliran.language.v1'
const SUPPORTED = new Set<string>(SUPPORTED_LOCALES.map((l) => l.code))

/** The pinned language, or null while the app follows the system. */
export function savedLanguage (): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && SUPPORTED.has(v) ? v : null
  } catch {
    return null // blocked storage is not an error — it just means "no override"
  }
}

/** Pin a language, or pass null to follow the system again. */
export function saveLanguage (code: string | null): void {
  try {
    if (code && SUPPORTED.has(code)) localStorage.setItem(KEY, code)
    else localStorage.removeItem(KEY)
  } catch { /* full/blocked storage is not an error */ }
}

/**
 * First tag that names a language we actually ship, else 'en'. resolveLocale() answers
 * 'en' both for a real English tag and for a language we do not have, and only the
 * former may end the search — see client/src/i18n.ts, which resolves the same order.
 */
export function pickLocale (...tags: (string | null | undefined)[]): Locale {
  for (const tag of tags) {
    if (!tag) continue
    const base = tag.replace(/_/g, '-').toLowerCase().split('-')[0]
    if (base === 'zh' || SUPPORTED.has(base)) return resolveLocale(tag)
  }
  return 'en'
}

/**
 * Apply the resolution order: saved choice > system language > English.
 *
 * Pass `preferred` when the viewer has JUST picked a language. saveLanguage() is
 * deliberately silent when storage is blocked or full, so re-reading the store would
 * resolve back to the system language while the picker sits there showing the new one
 * — the choice must come from the CHOICE, not from what storage happened to accept.
 * Omit it (boot) to resolve from the persisted value.
 */
export function applyLocale (preferred?: string | null): Locale {
  const saved = preferred === undefined ? savedLanguage() : preferred
  const locale = pickLocale(saved, navigator.language)
  setLocale(locale)
  return locale
}
