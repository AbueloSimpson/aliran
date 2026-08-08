// The @aliran/i18n runtime (S56a). The catalogs themselves are guarded statically by
// tools/i18n-test.mjs; this is the executable half — the behaviour no file scan can
// see, pinned before ~250 strings start depending on it:
//   - tag resolution, the thing that decides what a viewer sees on first run: region
//     and script subtags collapse onto the language we ship, and an unsupported
//     language falls to English rather than to a blank screen;
//   - the plural rules, per CLDR, including the two Russian boundaries that a naive
//     "n % 10" gets wrong (11 is `many`, not `one`; 12–14 are `many`, not `few`) and
//     the French/Portuguese/Hindi zero, which takes the SINGULAR;
//   - the fallback chain: a locale with no catalog yet still renders English, and a
//     key with no string anywhere renders as itself — never as an empty label;
//   - `{name}` interpolation, and tn() passing the count through as `{n}`.
//
// This suite has no device locale to read (jest is always English), so it drives
// setLocale() directly and restores 'en' at the end of every case.
import { PLURAL_FORMS, SUPPORTED_LOCALES, getLocale, pluralForm, resolveLocale, setLocale, t, tn } from '@aliran/i18n'
import type { Locale } from '@aliran/i18n'

afterEach(() => setLocale('en'))

describe('resolveLocale', () => {
  it('keeps the supported codes', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      if (code !== 'zh-Hans') expect(resolveLocale(code)).toBe(code)
    }
  })

  it('drops region and script subtags onto the language we ship', () => {
    expect(resolveLocale('es_MX')).toBe('es')
    expect(resolveLocale('es-419')).toBe('es')
    expect(resolveLocale('pt-BR')).toBe('pt')
    expect(resolveLocale('EN-GB')).toBe('en')
    expect(resolveLocale('fr_CA')).toBe('fr')
  })

  it('lands every Chinese tag on Simplified — the only script we ship', () => {
    expect(resolveLocale('zh')).toBe('zh-Hans')
    expect(resolveLocale('zh-CN')).toBe('zh-Hans')
    expect(resolveLocale('zh-Hant-TW')).toBe('zh-Hans')
    expect(resolveLocale('zh-Hans')).toBe('zh-Hans')
  })

  it('falls back to English for anything unsupported or absent', () => {
    expect(resolveLocale('pl')).toBe('en')
    expect(resolveLocale('sw-KE')).toBe('en')
    expect(resolveLocale('')).toBe('en')
    expect(resolveLocale(null)).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
  })
})

describe('pluralForm', () => {
  it('uses the singular only at exactly one for the plain locales', () => {
    for (const code of ['en', 'es', 'nl', 'de', 'it', 'tr'] as Locale[]) {
      expect(pluralForm(code, 0)).toBe('other')
      expect(pluralForm(code, 1)).toBe('one')
      expect(pluralForm(code, 2)).toBe('other')
    }
  })

  it('counts zero with the singular in fr/pt/hi', () => {
    for (const code of ['fr', 'pt', 'hi'] as Locale[]) {
      expect(pluralForm(code, 0)).toBe('one')
      expect(pluralForm(code, 1)).toBe('one')
      expect(pluralForm(code, 2)).toBe('other')
    }
  })

  it('has one form for the locales with no grammatical number', () => {
    for (const code of ['ja', 'zh-Hans', 'ko', 'th'] as Locale[]) {
      for (const n of [0, 1, 2, 11, 100]) expect(pluralForm(code, n)).toBe('other')
    }
  })

  it('gets the Russian boundaries right', () => {
    expect(pluralForm('ru', 1)).toBe('one')
    expect(pluralForm('ru', 21)).toBe('one')
    expect(pluralForm('ru', 101)).toBe('one')
    expect(pluralForm('ru', 11)).toBe('many') // …not `one`
    expect(pluralForm('ru', 111)).toBe('many')
    expect(pluralForm('ru', 2)).toBe('few')
    expect(pluralForm('ru', 24)).toBe('few')
    expect(pluralForm('ru', 12)).toBe('many') // …not `few`
    expect(pluralForm('ru', 14)).toBe('many')
    expect(pluralForm('ru', 5)).toBe('many')
    expect(pluralForm('ru', 0)).toBe('many')
  })

  it('only ever returns a form its locale declares in PLURAL_FORMS', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      for (let n = 0; n <= 130; n++) expect(PLURAL_FORMS[code]).toContain(pluralForm(code, n))
    }
  })
})

describe('t / tn', () => {
  it('renders the English source and interpolates {name}', () => {
    expect(t('common.ok')).toBe('OK')
    expect(t('common.back')).toBe('Back')
    // No catalog key needed for the substitution itself — the key falls through.
    expect(t('Hi {name}, {name}!', { name: 'Ana' })).toBe('Hi Ana, Ana!')
  })

  it('falls back to English, then to the key — never to an empty label', () => {
    setLocale('ru')
    expect(getLocale()).toBe('ru')
    expect(t('common.ok')).toBe('OK') // ru catalog not written yet (S56d)
    expect(t('nothing.here')).toBe('nothing.here')
  })

  it('picks the plural sibling for the active locale and passes {n}', () => {
    // live.peers is a real family now (S56b), so English renders. An UNWRITTEN family
    // still falls through to the key, which is how the rest of this test reads back
    // the form the runtime picked.
    expect(tn('live.peers', 1)).toBe('1 peer')
    expect(tn('live.peers', 4)).toBe('4 peers')
    expect(tn('nothing.here', 1)).toBe('nothing.here.one')
    setLocale('ru')
    expect(tn('live.peers', 4)).toBe('live.peers.few')
    expect(tn('live.peers', 11)).toBe('live.peers.many')
  })
})
