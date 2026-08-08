// i18n catalog + usage guard (S56a). Static and offline: it reads the locale JSON in
// i18n/locales/, the runtime's own PLURAL_FORMS table, and the two viewer apps'
// sources. No bundler, no app, no network.
//
// A translation catalog is the one part of the app where a mistake is invisible until
// a viewer in another country sees it, so the checks are the five things that actually
// break at render time:
//
//   1  KEY PARITY. Every locale carries exactly en's key set — normalized for plural
//      variance, because ru legitimately has `.few`/`.many` where en has neither and
//      ja legitimately has only `.other`. No empty values anywhere.
//   2  PLACEHOLDER PARITY. The `{name}` set of a value is identical across locales. A
//      translator may move `{count}`; dropping it renders a sentence with a hole,
//      inventing one renders a literal brace.
//   3  PLURAL FORMS. Each locale's plural families carry exactly the forms
//      pluralForm() can return for that locale — a missing form is a key rendered raw
//      at a count nobody tested. The required-forms table is PARSED OUT OF
//      i18n/src/index.ts (the repo's duplicate-and-assert convention, as in
//      tools/e2e-reports-test.mjs) so the guard and the runtime cannot drift.
//   4  REPORT COPY PINS. sdk/react-native/src/report.ts is a NEVER-TOUCH file whose
//      consent line and category labels are shown verbatim to viewers; the English
//      catalog entries that replace them at render time must still equal them
//      byte-for-byte. Only checked once those keys exist (they arrive in S56b).
//   4b WORKLET WHITELIST. client/backend/backend.mjs gates the persisted `language`
//      pref against its own copy of the locale codes (the Bare worklet cannot import
//      the TypeScript runtime). Same duplicate-and-assert treatment: the two lists must
//      stay identical, or a language the picker offers is silently not persisted.
//   5  USAGE SCAN. Every key a t()/tn() call site names — literal, or a literal prefix
//      with a runtime tail like t('report.category.' + c) — exists in en. Unused
//      catalog keys are a warning, never a failure: en grows one screen at a time.
//
// Run: node tools/i18n-test.mjs   (npm run test:i18n)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES_DIR = path.join(root, 'i18n', 'locales')
const RUNTIME = path.join(root, 'i18n', 'src', 'index.ts')
const REPORT_TS = path.join(root, 'sdk', 'react-native', 'src', 'report.ts')
const WORKLET = path.join(root, 'client', 'backend', 'backend.mjs')
const SCAN_DIRS = [path.join(root, 'client', 'src'), path.join(root, 'desktop', 'renderer', 'src')]
const ALL_FORMS = ['one', 'few', 'many', 'other']

let failures = 0
let warnings = 0
const ok = (msg) => console.log('  ok   ' + msg)
const fail = (msg) => { console.error('  FAIL ' + msg); failures++ }
const warn = (msg) => { console.log('  warn ' + msg); warnings++ }
const check = (cond, msg) => { if (cond) ok(msg); else fail(msg) }
const sorted = (set) => [...set].sort()
const some = (list, n = 6) => list.slice(0, n).join(', ') + (list.length > n ? `, +${list.length - n} more` : '')

// ---- the runtime's plural contract, read out of the TypeScript source -------------

function readPluralForms () {
  const src = fs.readFileSync(RUNTIME, 'utf8')
  const block = src.match(/export const PLURAL_FORMS[^=]*=\s*\{([\s\S]*?)\n\}/)
  if (!block) throw new Error('i18n/src/index.ts: PLURAL_FORMS not found in a shape the guard can read')
  const table = {}
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*'?([A-Za-z-]+)'?\s*:\s*\[([^\]]*)\]/)
    if (!m) continue
    table[m[1]] = [...m[2].matchAll(/'([a-z]+)'/g)].map((f) => f[1])
  }
  if (!table.en) throw new Error('i18n/src/index.ts: PLURAL_FORMS parsed without an `en` row')
  return table
}

// ---- catalogs ---------------------------------------------------------------------

const PLURAL_FORMS = readPluralForms()
const KNOWN = Object.keys(PLURAL_FORMS)

const catalogs = {}
for (const file of fs.readdirSync(LOCALES_DIR).sort()) {
  if (!file.endsWith('.json')) continue
  catalogs[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'))
}

console.log(`i18n: ${Object.keys(catalogs).length}/${KNOWN.length} catalogs, ${Object.keys(catalogs.en ?? {}).length} keys in en\n`)

if (!catalogs.en) {
  console.error('  FAIL i18n/locales/en.json is missing — it is the source catalog')
  process.exit(1)
}
const en = catalogs.en

for (const code of Object.keys(catalogs)) {
  if (!KNOWN.includes(code)) fail(`locales/${code}.json: ${code} is not a supported locale (see PLURAL_FORMS)`)
}
const pending = KNOWN.filter((c) => !catalogs[c])
if (pending.length) console.log(`  note not written yet (S56d): ${pending.join(' ')}\n`)

// A plural family is a key X for which en carries BOTH X.one and X.other. That rule is
// what keeps report.category.other — a category value spelled 'other' — from being read
// as the plural tail of a family called report.category.
const families = new Set()
for (const key of Object.keys(en)) {
  if (key.endsWith('.one') && en[key.slice(0, -4) + '.other'] !== undefined) families.add(key.slice(0, -4))
}
const variantsOf = (fam, forms) => forms.map((f) => `${fam}.${f}`)
const allVariants = new Set(families.size ? [...families].flatMap((f) => variantsOf(f, ALL_FORMS)) : [])
const baseKeys = Object.keys(en).filter((k) => !allVariants.has(k))

// ---- 1. key parity + no empty values ----------------------------------------------

console.log('1. key parity')
for (const code of KNOWN) {
  const cat = catalogs[code]
  if (!cat) continue
  const expected = new Set([...baseKeys, ...[...families].flatMap((f) => variantsOf(f, PLURAL_FORMS[code]))])
  const actual = new Set(Object.keys(cat))
  const missing = sorted(expected).filter((k) => !actual.has(k))
  const extra = sorted(actual).filter((k) => !expected.has(k))
  if (missing.length) fail(`${code}: ${missing.length} key(s) missing — ${some(missing)}`)
  if (extra.length) fail(`${code}: ${extra.length} key(s) this locale should not carry — ${some(extra)}`)
  const empty = sorted(actual).filter((k) => typeof cat[k] !== 'string' || cat[k].trim() === '')
  if (empty.length) fail(`${code}: ${empty.length} empty value(s) — ${some(empty)}`)
  if (!missing.length && !extra.length && !empty.length) ok(`${code}: ${actual.size} keys, all present and non-empty`)
}

// ---- 2. placeholder parity ---------------------------------------------------------

console.log('\n2. placeholder parity')
const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))

let phBad = 0
for (const code of KNOWN) {
  const cat = catalogs[code]
  if (!cat || code === 'en') continue
  for (const key of baseKeys) {
    if (cat[key] === undefined) continue
    if (!sameSet(placeholders(en[key]), placeholders(cat[key]))) {
      fail(`${code}: ${key} placeholders {${sorted(placeholders(cat[key]))}} != en {${sorted(placeholders(en[key]))}}`)
      phBad++
    }
  }
  // Plural variants are compared against en's `.other`: en has no `.few`/`.many` to
  // compare a Russian value against, and every form of a family says the same thing.
  for (const fam of families) {
    const ref = placeholders(en[`${fam}.other`])
    for (const key of variantsOf(fam, PLURAL_FORMS[code])) {
      if (cat[key] === undefined) continue
      if (!sameSet(ref, placeholders(cat[key]))) {
        fail(`${code}: ${key} placeholders {${sorted(placeholders(cat[key]))}} != en ${fam}.other {${sorted(ref)}}`)
        phBad++
      }
    }
  }
}
if (!phBad) ok(`${baseKeys.length + families.size} key(s) carry the same placeholders in every written locale`)

// ---- 3. plural forms ---------------------------------------------------------------

console.log('\n3. plural forms')
if (!families.size) {
  ok('no plural families in en yet — nothing to require')
} else {
  for (const code of KNOWN) {
    const cat = catalogs[code]
    if (!cat) continue
    const bad = []
    for (const fam of families) {
      const present = ALL_FORMS.filter((f) => cat[`${fam}.${f}`] !== undefined)
      const want = PLURAL_FORMS[code]
      if (present.join(',') !== [...want].sort((a, b) => ALL_FORMS.indexOf(a) - ALL_FORMS.indexOf(b)).join(',')) {
        bad.push(`${fam} has [${present}] want [${want}]`)
      }
    }
    if (bad.length) fail(`${code}: ${some(bad, 3)}`)
    else ok(`${code}: ${families.size} family/families carry exactly [${PLURAL_FORMS[code]}]`)
  }
}

// ---- 4. report copy pins ------------------------------------------------------------

console.log('\n4. report copy pins (sdk/react-native/src/report.ts)')
function reportCopy () {
  const src = fs.readFileSync(REPORT_TS, 'utf8')
  const consentBlock = src.match(/export const REPORT_CONSENT\s*=\s*((?:\s*'(?:[^'\\]|\\.)*'\s*\+?)+)/)
  if (!consentBlock) throw new Error('report.ts: REPORT_CONSENT not found in a shape the guard can read')
  const consent = [...consentBlock[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('')
  const labelBlock = src.match(/export const REPORT_CATEGORY_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/)
  if (!labelBlock) throw new Error('report.ts: REPORT_CATEGORY_LABELS not found in a shape the guard can read')
  const labels = {}
  for (const m of labelBlock[1].matchAll(/^\s*'?([\w-]+)'?\s*:\s*'((?:[^'\\]|\\.)*)'/gm)) labels[m[1]] = m[2]
  return { consent, labels }
}

const { consent, labels } = reportCopy()
if (en['report.consent'] === undefined) {
  console.log('  note report.consent not extracted yet (S56b) — pin skipped')
} else {
  check(en['report.consent'] === consent, 'en report.consent is REPORT_CONSENT verbatim')
}
const labelKeys = Object.keys(labels).filter((c) => en[`report.category.${c}`] !== undefined)
if (!labelKeys.length) {
  console.log('  note report.category.* not extracted yet (S56b) — pins skipped')
} else {
  // The enum is closed and extracted in one go, so a half-extracted set is a bug, not
  // a stage — say so plainly rather than reporting it as a mismatch against undefined.
  for (const c of Object.keys(labels)) {
    const key = `report.category.${c}`
    if (en[key] === undefined) fail(`en ${key} is missing — the category enum is extracted as a whole`)
    else check(en[key] === labels[c], `en ${key} is REPORT_CATEGORY_LABELS['${c}'] verbatim`)
  }
}

// ---- 4b. worklet language whitelist (client/backend/backend.mjs) --------------------

console.log('\n4b. worklet language whitelist (client/backend/backend.mjs)')
function runtimeLocaleCodes () {
  const src = fs.readFileSync(RUNTIME, 'utf8')
  const block = src.match(/export const SUPPORTED_LOCALES[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!block) throw new Error('i18n/src/index.ts: SUPPORTED_LOCALES not found in a shape the guard can read')
  return [...block[1].matchAll(/code:\s*'([\w-]+)'/g)].map((m) => m[1])
}

function workletLanguageCodes () {
  const src = fs.readFileSync(WORKLET, 'utf8')
  const block = src.match(/const LANGUAGES\s*=\s*\[([^\]]*)\]/)
  if (!block) return null
  return [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
}

const runtimeCodes = runtimeLocaleCodes()
check(sorted(new Set(runtimeCodes)).join(',') === sorted(new Set(KNOWN)).join(','),
  'SUPPORTED_LOCALES and PLURAL_FORMS cover the same locales')
const workletCodes = workletLanguageCodes()
if (!workletCodes) {
  fail('client/backend/backend.mjs declares no LANGUAGES whitelist the guard can read')
} else {
  check(sorted(new Set(workletCodes)).join(',') === sorted(new Set(runtimeCodes)).join(','),
    `the worklet persists exactly the ${runtimeCodes.length} locales the picker offers`)
}

// ---- 5. usage scan -------------------------------------------------------------------

console.log('\n5. usage scan (client/src, desktop/renderer/src)')
function walk (dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

// t('key') / t('key', vars) / tn('key', n) / t('prefix.' + expr). The lookbehind keeps
// `format(`, `.t(` and the like out; a trailing `+` marks the prefix form.
const CALL = /(?<![$\w.])(tn?)\s*\(\s*'((?:[^'\\\n]|\\.)*)'\s*(\+|,|\))/g
const usedKeys = new Set()
const usedFamilies = new Set()
const usedPrefixes = new Set()
let callSites = 0

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8')
    const rel = path.relative(root, file).replace(/\\/g, '/')
    for (const m of src.matchAll(CALL)) {
      const [, fn, key, tail] = m
      callSites++
      const line = src.slice(0, m.index).split('\n').length
      if (tail === '+') {
        if (!key) { fail(`${rel}:${line}: ${fn}() called with an empty literal prefix — the guard cannot check it`) ; continue }
        usedPrefixes.add(key)
        if (!Object.keys(en).some((k) => k.startsWith(key))) fail(`${rel}:${line}: no en key starts with '${key}'`)
      } else if (fn === 'tn') {
        usedFamilies.add(key)
        if (!families.has(key)) fail(`${rel}:${line}: tn('${key}') needs en keys '${key}.one' and '${key}.other'`)
      } else {
        usedKeys.add(key)
        if (en[key] === undefined) fail(`${rel}:${line}: t('${key}') is not in en.json`)
      }
    }
  }
}
ok(`${callSites} t()/tn() call site(s) scanned, every referenced key resolves in en`)

const covered = new Set(usedKeys)
for (const fam of usedFamilies) for (const f of ALL_FORMS) covered.add(`${fam}.${f}`)
for (const p of usedPrefixes) for (const k of Object.keys(en)) if (k.startsWith(p)) covered.add(k)
const unused = Object.keys(en).filter((k) => !covered.has(k)).sort()
if (unused.length) warn(`${unused.length} en key(s) not referenced by either app — ${some(unused, 8)}`)
else ok('every en key is referenced by at least one call site')

// ---- result ---------------------------------------------------------------------------

console.log('')
if (failures) {
  console.error(`RESULT: FAIL ❌  ${failures} failure(s)`)
  process.exit(1)
}
console.log(`RESULT: PASS ✅  (key parity; placeholders; plural forms; report pins; usage scan)${warnings ? `  — ${warnings} warning(s)` : ''}`)
