// Aliran viewer i18n — the whole translation runtime (S56 design D1). No i18next, no
// format.js, no dependency of any kind, and deliberately no `Intl.PluralRules`: Hermes
// on Android ships without a dependable ICU (the same reason client/src/lang.ts keeps a
// static language table), and the 14 locales below need exactly four plural rules.
//
// Engine and SDK error prose stays English by design — only UI chrome lives here. So
// does operator/provider content: channel names, categories, EPG programme titles, VOD
// titles and service.name are NEVER translated.
import en from '../locales/en.json'

export type Locale =
  | 'en' | 'es' | 'pt' | 'fr' | 'nl' | 'de' | 'it'
  | 'ru' | 'tr' | 'hi' | 'ja' | 'zh-Hans' | 'ko' | 'th'

export type PluralForm = 'one' | 'few' | 'many' | 'other'

/** A locale catalog: flat, dot-namespaced keys onto ready-to-render strings. */
export type Catalog = Record<string, string>

export interface LocaleInfo {
  code: Locale
  nativeName: string
}

/** Picker order. Native names on purpose — nobody should have to read a foreign name
 *  to find their own language. */
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'pt', nativeName: 'Português' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'nl', nativeName: 'Nederlands' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'ru', nativeName: 'Русский' },
  { code: 'tr', nativeName: 'Türkçe' },
  { code: 'hi', nativeName: 'हिन्दी' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'zh-Hans', nativeName: '中文（简体）' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'th', nativeName: 'ไทย' }
]

// The forms pluralForm() can return for each locale — i.e. exactly the sibling keys a
// catalog must carry for every tn() family. tools/i18n-test.mjs MACHINE-READS this
// literal, so keep it a plain object of string arrays and change it together with
// pluralForm() below.
export const PLURAL_FORMS: Record<Locale, PluralForm[]> = {
  en: ['one', 'other'],
  es: ['one', 'other'],
  pt: ['one', 'other'],
  fr: ['one', 'other'],
  nl: ['one', 'other'],
  de: ['one', 'other'],
  it: ['one', 'other'],
  ru: ['one', 'few', 'many'],
  tr: ['one', 'other'],
  hi: ['one', 'other'],
  ja: ['other'],
  'zh-Hans': ['other'],
  ko: ['other'],
  th: ['other']
}

const EN: Catalog = en

// Catalogs are bundled, never fetched: the apps must render offline and on first run.
// A locale with no catalog yet falls through to English key by key (see t()).
const CATALOGS: Partial<Record<Locale, Catalog>> = { en: EN }

const CODES = new Set<string>(SUPPORTED_LOCALES.map((l) => l.code))

let current: Locale = 'en'
const listeners = new Set<() => void>()

export function getLocale (): Locale {
  return current
}

export function setLocale (locale: Locale): void {
  if (locale === current) return
  current = locale
  for (const fn of listeners) fn()
}

/** Subscribe to locale changes; the return value unsubscribes. Module-level identity,
 *  so it is safe as the `subscribe` argument of useSyncExternalStore. */
export function onLocaleChange (fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Map any BCP-47-ish tag a device may hand us onto a supported locale.
 * `es_MX` / `es-419` → es, `pt-BR` → pt, any `zh-*` → zh-Hans, unknown → en.
 */
export function resolveLocale (tag: string | null | undefined): Locale {
  if (!tag) return 'en'
  const base = tag.replace(/_/g, '-').toLowerCase().split('-')[0]
  // Simplified is the only Chinese script we ship, so every zh-* tag lands on it.
  if (base === 'zh') return 'zh-Hans'
  return CODES.has(base) ? (base as Locale) : 'en'
}

/** CLDR-exact for our 14 locales. Negative and fractional counts fold onto the
 *  absolute value — the UI only ever counts things. */
export function pluralForm (locale: Locale, n: number): PluralForm {
  const i = Math.abs(n)
  switch (locale) {
    case 'ru': {
      const m10 = i % 10
      const m100 = i % 100
      if (m10 === 1 && m100 !== 11) return 'one'
      if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'few'
      return 'many'
    }
    // French, Portuguese and Hindi count zero with the singular.
    case 'fr':
    case 'pt':
    case 'hi':
      return i <= 1 ? 'one' : 'other'
    // No grammatical number — one form for every count.
    case 'ja':
    case 'zh-Hans':
    case 'ko':
    case 'th':
      return 'other'
    default:
      return i === 1 ? 'one' : 'other'
  }
}

// Plain `{name}` substitution, split/join rather than String.replace so a value
// containing `$&` cannot turn into a replacement pattern. No escaping: every value is
// rendered as React text, never as markup.
function interpolate (s: string, vars: Record<string, string | number>): string {
  let out = s
  for (const k of Object.keys(vars)) out = out.split('{' + k + '}').join(String(vars[k]))
  return out
}

/** Translate `key`, substituting `{name}` placeholders. Falls back to English, then to
 *  the key itself — a missing string is never a blank screen. */
export function t (key: string, vars?: Record<string, string | number>): string {
  const s = CATALOGS[current]?.[key] ?? EN[key] ?? key
  return vars ? interpolate(s, vars) : s
}

/** Count-aware translate: picks the `key`.<form> sibling for `n` and passes `{n}`. */
export function tn (key: string, n: number, vars?: Record<string, string | number>): string {
  return t(key + '.' + pluralForm(current, n), { n, ...vars })
}

export { useI18n } from './react'
