// The React half of @aliran/i18n (S56 design D1): one hook, so a language change
// repaints the tree live instead of asking the viewer to restart the app.
//
// `t`/`tn` read module state, which React cannot see — useSyncExternalStore is what
// makes the change visible: onLocaleChange is the subscribe, getLocale the snapshot.
// Both have module-level identity, so neither needs memoizing at the call site.
//
// index.ts re-exports useI18n from here (one import path for consumers), which makes
// this a deliberate import cycle: the re-export is the LAST statement of index.ts, so
// everything this file reads is already initialized by the time it evaluates.
import { useSyncExternalStore } from 'react'
import { getLocale, onLocaleChange, t, tn, type Locale } from './index'

export interface I18n {
  t: typeof t
  tn: typeof tn
  locale: Locale
}

export function useI18n (): I18n {
  const locale = useSyncExternalStore(onLocaleChange, getLocale, getLocale)
  return { t, tn, locale }
}
