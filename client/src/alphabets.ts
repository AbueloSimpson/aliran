// Per-locale letter-rail alphabets for the in-player channel search (WS15).
//
// The search overlay's left rail is QUICK INPUT — tapping a key appends that
// character to the query — so each GUI locale gets the script a viewer of that
// language actually types: Cyrillic for ru, Devanagari for hi, gojūon kana for ja,
// Hangul jamo for ko, Thai for th, and plain Latin for every Latin-script locale
// (zh-Hans included: pinyin input is Latin). Because a service's channel NAMES can
// stay English while the GUI is not, every non-Latin rail carries a toggle back to
// the plain English A–Z (railLetters(locale, true) is ALWAYS Latin A–Z).
//
// Pure module: no React, no theme, no backend — the SearchPanel renders these and a
// jest suite pins them. Matching support lives here too: normalizeSearch() extends
// the vod fold() (case + diacritic folding) with a compatibility→conjoining Hangul
// jamo mapping, so a rail ㄱ matches the decomposed initial of 가 in a folded title
// (fold()'s NFD leaves Hangul decomposed as conjoining jamo).

import { fold } from './vod/sort'

export type RailScript = 'latin' | 'cyrillic' | 'devanagari' | 'kana' | 'hangul' | 'thai'

export const LATIN: readonly string[] = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
export const DIGITS: readonly string[] = [...'0123456789']

// Russian alphabet, full 33 letters — the rail is input, not an index, so even the
// rarely-initial signs stay (a query can need any of them mid-word).
export const CYRILLIC: readonly string[] = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ']

// Devanagari: the independent vowels, then the consonants (varga order).
export const DEVANAGARI: readonly string[] = [
  'अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ए', 'ऐ', 'ओ', 'औ',
  'क', 'ख', 'ग', 'घ', 'ङ', 'च', 'छ', 'ज', 'झ', 'ञ',
  'ट', 'ठ', 'ड', 'ढ', 'ण', 'त', 'थ', 'द', 'ध', 'न',
  'प', 'फ', 'ब', 'भ', 'म', 'य', 'र', 'ल', 'व', 'श', 'ष', 'स', 'ह'
]

// Hiragana gojūon, あ-row order (the full syllabary — the rail scrolls; row heads
// alone could not type most titles).
export const KANA: readonly string[] = [
  'あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ',
  'さ', 'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'て', 'と',
  'な', 'に', 'ぬ', 'ね', 'の', 'は', 'ひ', 'ふ', 'へ', 'ほ',
  'ま', 'み', 'む', 'め', 'も', 'や', 'ゆ', 'よ',
  'ら', 'り', 'る', 'れ', 'ろ', 'わ', 'を', 'ん'
]

// Hangul compatibility jamo: the 14 basic consonants, then the 10 basic vowels.
export const HANGUL_JAMO: readonly string[] = [
  'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
  'ㅏ', 'ㅑ', 'ㅓ', 'ㅕ', 'ㅗ', 'ㅛ', 'ㅜ', 'ㅠ', 'ㅡ', 'ㅣ'
]

// Thai consonants in dictionary order (the two obsolete letters ฃ/ฅ omitted).
export const THAI: readonly string[] = [
  'ก', 'ข', 'ค', 'ฆ', 'ง', 'จ', 'ฉ', 'ช', 'ซ', 'ฌ', 'ญ',
  'ฎ', 'ฏ', 'ฐ', 'ฑ', 'ฒ', 'ณ', 'ด', 'ต', 'ถ', 'ท', 'ธ', 'น',
  'บ', 'ป', 'ผ', 'ฝ', 'พ', 'ฟ', 'ภ', 'ม', 'ย', 'ร', 'ล', 'ว',
  'ศ', 'ษ', 'ส', 'ห', 'ฬ', 'อ', 'ฮ'
]

const SCRIPT_BY_LOCALE: Record<string, RailScript> = {
  ru: 'cyrillic',
  hi: 'devanagari',
  ja: 'kana',
  ko: 'hangul',
  th: 'thai'
  // en es pt fr nl de it tr zh-Hans (pinyin) — everything else falls back to latin.
}

const TABLE: Record<RailScript, readonly string[]> = {
  latin: LATIN,
  cyrillic: CYRILLIC,
  devanagari: DEVANAGARI,
  kana: KANA,
  hangul: HANGUL_JAMO,
  thai: THAI
}

/** The rail script the GUI locale renders by default. */
export function scriptForLocale (locale: string): RailScript {
  return SCRIPT_BY_LOCALE[locale] ?? 'latin'
}

/** The rail's letters. `latin: true` is the English-alphabet toggle — ALWAYS the
 *  plain A–Z, whatever the locale (channel names can be English under any GUI). */
export function railLetters (locale: string, latin: boolean): readonly string[] {
  return latin ? LATIN : TABLE[scriptForLocale(locale)]
}

// --- Hangul-aware search folding ---------------------------------------------------
//
// fold() runs NFD, which decomposes a composed syllable (가 U+AC00) into CONJOINING
// jamo (ᄀ U+1100 + ᅡ U+1161) — but the rail (and a soft keyboard's lone jamo) emit
// COMPATIBILITY jamo (ㄱ U+3131), which NFD leaves alone. Mapping the compatibility
// forms onto the conjoining initials/vowels makes a rail ㄱ match the start of 가나.

const JAMO_CONSONANT: Record<string, string> = {
  'ㄱ': 'ᄀ', 'ㄲ': 'ᄁ', 'ㄴ': 'ᄂ', 'ㄷ': 'ᄃ', 'ㄸ': 'ᄄ',
  'ㄹ': 'ᄅ', 'ㅁ': 'ᄆ', 'ㅂ': 'ᄇ', 'ㅃ': 'ᄈ', 'ㅅ': 'ᄉ',
  'ㅆ': 'ᄊ', 'ㅇ': 'ᄋ', 'ㅈ': 'ᄌ', 'ㅉ': 'ᄍ', 'ㅊ': 'ᄎ',
  'ㅋ': 'ᄏ', 'ㅌ': 'ᄐ', 'ㅍ': 'ᄑ', 'ㅎ': 'ᄒ'
}
const VOWEL_COMPAT_FIRST = 0x314F // ㅏ
const VOWEL_COMPAT_LAST = 0x3163 // ㅣ (compat vowels are contiguous, as are conjoining)
const VOWEL_CONJOINING_FIRST = 0x1161 // ᅡ

function mapJamo (ch: string): string {
  const mapped = JAMO_CONSONANT[ch]
  if (mapped) return mapped
  const code = ch.charCodeAt(0)
  if (code >= VOWEL_COMPAT_FIRST && code <= VOWEL_COMPAT_LAST) {
    return String.fromCharCode(VOWEL_CONJOINING_FIRST + (code - VOWEL_COMPAT_FIRST))
  }
  return ch
}

/** Case/diacritic-insensitive fold for channel search — the vod fold() plus the
 *  compatibility→conjoining Hangul jamo mapping above. Apply to BOTH sides. */
export function normalizeSearch (s: string): string {
  return [...fold(s)].map(mapJamo).join('')
}
