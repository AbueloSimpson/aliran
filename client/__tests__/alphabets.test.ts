// Per-locale letter-rail alphabets (WS15, src/alphabets.ts): each GUI locale's rail
// renders that language's script, and the English toggle ALWAYS yields the plain
// Latin A–Z (channel names can be English under any GUI). normalizeSearch extends
// the vod fold() with the compatibility→conjoining Hangul jamo mapping, so a rail
// ㄱ matches the initial of a composed 가.

import { SUPPORTED_LOCALES } from '@aliran/i18n'
import {
  LATIN, DIGITS, CYRILLIC, DEVANAGARI, KANA, HANGUL_JAMO, THAI,
  scriptForLocale, railLetters, normalizeSearch
} from '../src/alphabets'

const AZ = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code)

test('every supported locale has a rail script', () => {
  // The alphabet table must never lag the locale roster: a new catalog gets a rail
  // (latin fallback at minimum) without touching this module.
  expect(LOCALES).toHaveLength(14)
  for (const code of LOCALES) {
    expect(railLetters(code, false).length).toBeGreaterThan(0)
  }
})

test('the right script per locale', () => {
  // Latin-script GUIs — zh-Hans included (pinyin input is Latin).
  for (const code of ['en', 'es', 'pt', 'fr', 'nl', 'de', 'it', 'tr', 'zh-Hans']) {
    expect(scriptForLocale(code)).toBe('latin')
    expect(railLetters(code, false)).toEqual(LATIN)
  }
  expect(railLetters('ru', false)).toEqual(CYRILLIC)
  expect(railLetters('hi', false)).toEqual(DEVANAGARI)
  expect(railLetters('ja', false)).toEqual(KANA)
  expect(railLetters('ko', false)).toEqual(HANGUL_JAMO)
  expect(railLetters('th', false)).toEqual(THAI)
  // Spot the scripts themselves (first letter of each writing system).
  expect(CYRILLIC[0]).toBe('А') // U+0410, not the Latin A
  expect(DEVANAGARI[0]).toBe('अ')
  expect(KANA[0]).toBe('あ')
  expect(HANGUL_JAMO[0]).toBe('ㄱ')
  expect(THAI[0]).toBe('ก')
})

test('the English toggle always yields the plain A-Z, whatever the locale', () => {
  for (const code of LOCALES) {
    expect([...railLetters(code, true)]).toEqual(AZ)
  }
})

test('the digits row is 0-9', () => {
  expect([...DIGITS]).toEqual([...'0123456789'])
})

test('normalizeSearch: case + diacritic folding (the vod fold contract)', () => {
  expect(normalizeSearch('Amélie')).toBe('amelie')
  expect(normalizeSearch('CANAL Ñ')).toBe(normalizeSearch('canal ñ'))
})

test('normalizeSearch: a rail jamo matches the initial of a composed syllable', () => {
  // 가나 TV — the rail emits compatibility ㄱ (U+3131); the folded title carries the
  // conjoining initial of 가. Both sides normalized must substring-match.
  expect(normalizeSearch('가나 TV').includes(normalizeSearch('ㄱ'))).toBe(true)
  expect(normalizeSearch('가나 TV').includes(normalizeSearch('ㅏ'))).toBe(true) // vowel too
  expect(normalizeSearch('나라 TV').includes(normalizeSearch('ㄱ'))).toBe(false)
})
