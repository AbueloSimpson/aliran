// lang.ts — the track-language names TrackMenu renders. Pins the S56f/D8 contract:
// the name follows the viewer's UI language, English behaves exactly as it did before,
// and every degraded path (unknown code, malformed code, unknown locale, no ICU) still
// resolves to something renderable rather than throwing.
//
// desktop/renderer/src/lang.ts is a MANUAL MIRROR of client/src/lang.ts with no
// automated drift guard — the two files differ only in their "MIRRORED in ..." header
// line. Any change proved here must be made there by hand and diffed.

import { setLocale } from '@aliran/i18n'
import { languageName, trackDisplayLabels } from '../src/lang'

afterEach(() => setLocale('en'))

test('English is unchanged: the static table, the region suffix, and null for a non-name', () => {
  expect(languageName('spa')).toBe('Spanish')
  expect(languageName('fre')).toBe('French')
  expect(languageName('pt-BR')).toBe('Portuguese (BR)')
  expect(languageName('zzz')).toBe(null) // an echo of the input is not a name
  expect(languageName('')).toBe(null)
  expect(languageName(null)).toBe(null)
  expect(languageName('eng t1')).toBe(null) // malformed: Intl throws, we do not
})

test('the name follows the UI locale', () => {
  setLocale('tr')
  // The whole point of the segment: "Spanish" is not a word a Turkish viewer reads.
  expect(languageName('spa')).toBe('İspanyolca')
  expect(languageName('eng')).toBe('İngilizce')
  setLocale('ja')
  expect(languageName('fra')).toBe('フランス語')
  setLocale('es')
  expect(languageName('pt-BR')).toBe('portugués (BR)') // region stays an ASCII subtag
  expect(languageName('zzz')).toBe(null)
})

test('an explicit locale wins, and an unusable one falls back to English', () => {
  expect(languageName('spa', 'de')).toBe('Spanisch')
  expect(languageName('spa', 'not-a-locale!!')).toBe('Spanish')
})

test('track labels follow the locale and still number duplicates apart', () => {
  setLocale('tr')
  expect(trackDisplayLabels([{ language: 'spa' }, { language: 'es' }, { title: 'Comentario' }, {}], 'Parça'))
    .toEqual(['İspanyolca', 'İspanyolca 2', 'Comentario', 'Parça 4'])
})
