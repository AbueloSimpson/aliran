// Full language names for track menus (S54 polish). Provider manifests label their
// audio/subtitle tracks with terse codes ("spa", "eng t1") — viewers should read
// "Spanish", not an ISO code. `Intl.DisplayNames` covers everything when the engine
// has it (desktop Chromium, jest's node); Hermes on Android may not, so a static map
// of the codes that actually occur in the wild backs it up. MIRRORED in
// client/src/lang.ts — keep the two copies in step.
//
// S56f/D8: the names follow the viewer's UI language where the engine can translate
// them — a Turkish viewer reads "İspanyolca". The English table below is what an engine
// without Intl.DisplayNames falls back to, so it stays exactly as it is.
import { getLocale } from '@aliran/i18n'

const NAMES: Record<string, string> = {
  en: 'English', eng: 'English',
  es: 'Spanish', spa: 'Spanish',
  pt: 'Portuguese', por: 'Portuguese',
  fr: 'French', fra: 'French', fre: 'French',
  de: 'German', deu: 'German', ger: 'German',
  it: 'Italian', ita: 'Italian',
  ar: 'Arabic', ara: 'Arabic',
  ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', zho: 'Chinese', chi: 'Chinese',
  ru: 'Russian', rus: 'Russian',
  hi: 'Hindi', hin: 'Hindi',
  tr: 'Turkish', tur: 'Turkish',
  nl: 'Dutch', nld: 'Dutch', dut: 'Dutch',
  pl: 'Polish', pol: 'Polish',
  sv: 'Swedish', swe: 'Swedish',
  no: 'Norwegian', nor: 'Norwegian',
  da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish',
  el: 'Greek', ell: 'Greek', gre: 'Greek',
  he: 'Hebrew', heb: 'Hebrew',
  cs: 'Czech', ces: 'Czech', cze: 'Czech',
  hu: 'Hungarian', hun: 'Hungarian',
  ro: 'Romanian', ron: 'Romanian', rum: 'Romanian',
  th: 'Thai', tha: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese',
  id: 'Indonesian', ind: 'Indonesian',
  ms: 'Malay', msa: 'Malay', may: 'Malay',
  uk: 'Ukrainian', ukr: 'Ukrainian',
  ca: 'Catalan', cat: 'Catalan',
  gl: 'Galician', glg: 'Galician',
  eu: 'Basque', eus: 'Basque', baq: 'Basque',
  fa: 'Persian', fas: 'Persian', per: 'Persian',
  ur: 'Urdu', urd: 'Urdu',
  bn: 'Bengali', ben: 'Bengali',
  ta: 'Tamil', tam: 'Tamil',
  te: 'Telugu', tel: 'Telugu',
  sr: 'Serbian', srp: 'Serbian',
  hr: 'Croatian', hrv: 'Croatian',
  bg: 'Bulgarian', bul: 'Bulgarian',
  sk: 'Slovak', slk: 'Slovak', slo: 'Slovak',
  sl: 'Slovenian', slv: 'Slovenian',
  lt: 'Lithuanian', lit: 'Lithuanian',
  lv: 'Latvian', lav: 'Latvian',
  et: 'Estonian', est: 'Estonian',
  fil: 'Filipino', tl: 'Filipino'
}

/** `Intl.DisplayNames` in one guarded call, or null. Guarded twice over: Hermes may not
 *  ship DisplayNames at all, and `of()` throws on the malformed codes providers emit. */
function displayName (key: string, locale: string): string | null {
  try {
    const DN = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of (c: string): string | undefined } }).DisplayNames
    if (typeof DN !== 'function') return null
    const resolved = new DN([locale], { type: 'language' }).of(key)
    // of() echoes the input back for unknown codes — an echo is not a name.
    return resolved && resolved.toLowerCase() !== key ? resolved : null
  } catch { return null } /* invalid code, unknown locale or no Intl */
}

/**
 * "spa" → "Spanish", "pt-BR" → "Portuguese (BR)". Unknown/absent code → null.
 *
 * In the viewer's own language when the engine can: `locale` defaults to the UI locale,
 * and a non-English one asks Intl.DisplayNames FIRST ("İspanyolca" for a Turkish
 * viewer). English — and any engine without DisplayNames — takes the static table, then
 * English DisplayNames for the codes the table does not carry. The region suffix stays
 * ASCII-uppercased on purpose: it is a BCP-47 subtag, not prose, and Turkish casing
 * would turn "(IT)" into "(İT)".
 */
export function languageName (code: string | null | undefined, locale: string = getLocale()): string | null {
  if (!code || typeof code !== 'string') return null
  const trimmed = code.trim()
  if (!trimmed) return null
  const [base, region] = trimmed.replace(/_/g, '-').split('-')
  const key = base.toLowerCase()
  let name = locale !== 'en' ? displayName(key, locale) : null
  if (name === null) name = NAMES[key] ?? null
  if (name === null) name = displayName(key, 'en')
  if (name === null) return null
  return region ? `${name} (${region.toUpperCase()})` : name
}

/** Display labels for a track list: the full language name when the code resolves,
 *  the provider's own title otherwise, a numbered fallback as the last resort —
 *  with duplicates numbered ("Spanish", "Spanish 2") so every row stays distinct. */
export function trackDisplayLabels (
  tracks: Array<{ language?: string; title?: string }>,
  fallbackWord: string
): string[] {
  const base = tracks.map((t, i) => languageName(t.language) || t.title || t.language || `${fallbackWord} ${i + 1}`)
  const seen = new Map<string, number>()
  return base.map((label) => {
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    return n === 1 ? label : `${label} ${n}`
  })
}
