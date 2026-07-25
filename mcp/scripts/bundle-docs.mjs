// Bundle the repo docs corpus into the package (prepack — runs on `npm pack` /
// `npm publish`). A published @aliran/mcp has no repo checkout around it, so
// without this snapshot the mcp://aliran/docs/* resources and docs_search would
// degrade to empty; config.js falls back to docs-bundle/ exactly when the live
// ../../docs sibling is absent. The bundle dir is generated + gitignored — a repo
// checkout never reads it.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const src = path.resolve(pkgRoot, '..', 'docs')
const dest = path.join(pkgRoot, 'docs-bundle')

if (!fs.existsSync(src)) {
  process.stderr.write(`[bundle-docs] no docs/ sibling at ${src} — pack from a repo checkout\n`)
  process.exit(1)
}
fs.rmSync(dest, { recursive: true, force: true })
let n = 0
for (const rel of fs.readdirSync(src, { recursive: true })) {
  const relPath = String(rel)
  if (!relPath.endsWith('.md')) continue
  const from = path.join(src, relPath)
  if (!fs.statSync(from).isFile()) continue
  const to = path.join(dest, relPath)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  n++
}
if (!n) {
  process.stderr.write(`[bundle-docs] found no markdown under ${src}\n`)
  process.exit(1)
}
process.stderr.write(`[bundle-docs] bundled ${n} markdown docs -> ${dest}\n`)
