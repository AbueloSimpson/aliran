// Full language names for track menus (S54 polish). Provider manifests label their
// audio/subtitle tracks with terse codes ("spa", "eng t1") — viewers should read
// "Spanish", not an ISO code. `Intl.DisplayNames` covers everything when the engine
// has it (desktop Chromium, jest's node); Hermes on Android may not, so a static map
// of the codes that actually occur in the wild backs it up. MIRRORED in
// client/src/lang.ts — keep the two copies in step.

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

/** "spa" → "Spanish", "pt-BR" → "Portuguese (BR)". Unknown/absent code → null. */
export function languageName (code: string | null | undefined): string | null {
  if (!code || typeof code !== 'string') return null
  const trimmed = code.trim()
  if (!trimmed) return null
  const [base, region] = trimmed.replace(/_/g, '-').split('-')
  const key = base.toLowerCase()
  let name = NAMES[key] ?? null
  if (name === null) {
    // Engines with Intl.DisplayNames resolve anything the map does not carry.
    try {
      const DN = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of (c: string): string | undefined } }).DisplayNames
      if (DN) {
        const resolved = new DN(['en'], { type: 'language' }).of(key)
        // of() echoes the input back for unknown codes — an echo is not a name.
        if (resolved && resolved.toLowerCase() !== key) name = resolved
      }
    } catch { /* invalid code or no Intl — fall through */ }
  }
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
