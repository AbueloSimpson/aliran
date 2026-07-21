// Theme drift guard — the app, the panel dashboard and the broadcaster dashboard
// must read as ONE product.
//
// Two separate deployables cannot share a stylesheet at runtime (the panel and the
// broadcaster ship in different containers and serve their own static files), so the
// canonical palette is DUPLICATED as a marked block in both. Duplication without a
// check is just drift with extra steps — that is exactly how the two dashboards ended
// up warm-orange and cool-cyan before 2026-07-21. This test is the check.
//
// It asserts:
//   A. the marked block is byte-identical in both stylesheets
//   B. its values still track client/src/theme.ts DEFAULT_COLORS (the S18 single
//      source of brand colour) — so the dashboards cannot quietly diverge from the
//      product they administer
//
// Run: npm run test:theme
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEETS = [
  'panel/admin-ui/style.css',
  'broadcaster/control-ui/style.css'
]
const START = '/* ---- ALIRAN SHARED THEME'
const END = '/* ---- end shared theme ---- */'

let failures = 0
const fail = (msg) => { console.error('  FAIL ' + msg); failures++ }
const ok = (msg) => console.log('  ok   ' + msg)

function sharedBlock (rel) {
  const css = readFileSync(path.join(root, rel), 'utf8')
  const i = css.indexOf(START)
  const j = css.indexOf(END)
  if (i === -1 || j === -1 || j < i) throw new Error(`${rel}: shared theme block not found (looked for "${START}" … "${END}")`)
  return css.slice(i, j + END.length)
}

function tokens (block) {
  const out = {}
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().toLowerCase()
  return out
}

console.log('theme: shared palette')

// ---- A. the two stylesheets carry the same block, byte for byte
const blocks = SHEETS.map((rel) => [rel, sharedBlock(rel)])
if (blocks[0][1] === blocks[1][1]) {
  ok(`shared block byte-identical across ${SHEETS.length} stylesheets`)
} else {
  fail('shared theme block DIFFERS between:\n         ' + SHEETS.join('\n         ') +
       '\n         Edit both, or neither — see the comment at the top of each block.')
  const a = tokens(blocks[0][1]); const b = tokens(blocks[1][1])
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) console.error(`         --${k}: ${blocks[0][0]}=${a[k] ?? '(absent)'}  ${blocks[1][0]}=${b[k] ?? '(absent)'}`)
  }
}

// ---- B. the palette still tracks the product's own colours
const theme = readFileSync(path.join(root, 'client/src/theme.ts'), 'utf8')
const defaults = {}
const dc = theme.slice(theme.indexOf('const DEFAULT_COLORS'))
for (const m of dc.matchAll(/^\s{2}([a-zA-Z]+):\s*'(#[0-9a-fA-F]{6})'/gm)) defaults[m[1]] = m[2].toLowerCase()

// css token  ->  client/src/theme.ts DEFAULT_COLORS key
const MAP = {
  bg: 'background',
  panel: 'surface',
  text: 'text',
  muted: 'textDim',
  accent: 'accent'
}
const tk = tokens(blocks[0][1])
for (const [cssVar, clientKey] of Object.entries(MAP)) {
  const want = defaults[clientKey]
  const got = tk[cssVar]
  if (!want) { fail(`client/src/theme.ts DEFAULT_COLORS has no "${clientKey}" — did the app theme change shape?`); continue }
  if (got !== want) fail(`--${cssVar} is ${got}, but the app's DEFAULT_COLORS.${clientKey} is ${want}`)
}
if (!failures) ok('palette tracks client/src/theme.ts DEFAULT_COLORS (' + Object.keys(MAP).length + ' mapped tokens)')

console.log(failures ? `\ntheme: ${failures} FAILURE(S)` : '\ntheme: PASS')
process.exit(failures ? 1 : 0)
