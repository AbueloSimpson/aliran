// Renderer bundle build — esbuild only (no dev server; `npm run build` then Ctrl+R
// in the running app). The main process is plain ESM Node and needs no build; the
// renderer is TS/TSX + CSS bundled to renderer/dist/ (gitignored), which
// renderer/index.html references. --watch rebuilds on change.

import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const options = {
  entryPoints: [path.join(root, 'renderer', 'src', 'main.tsx')],
  bundle: true,
  outdir: path.join(root, 'renderer', 'dist'),
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' }
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
