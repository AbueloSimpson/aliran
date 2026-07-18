#!/usr/bin/env node
// White-label brand builder (S19). Turns a brand directory into a branded release
// APK with its own Android applicationId (com.aliranclient.<id>), launcher icon,
// app name, splash logo, wallpaper, and theme — from the unmodified codebase.
//
//   node tools/brand.mjs sunburst --dev            # repo example brand, local panel
//   node tools/brand.mjs /path/to/acme             # real operator brand (outside the repo)
//
// What it does:
//   1. validate the brand dir (descriptor sanity; credentials are REJECTED)
//   2. generate an Android res overlay under client/android/app/build/aliranBrand/<id>/
//      (adaptive launcher icon, app_name, splash logo / wallpaper / TV banner drawables)
//   3. swap the Metro-bundled client/config/service.json for the brand descriptor
//      (the dev config is backed up and ALWAYS restored, even on failure)
//   4. run the property-gated gradle flavor build (-PaliranBrandId/-PaliranBrandRes)
//
// The default no-flavor build is untouched: without those properties build.gradle
// declares no flavors, and the swapped config is restored the moment the build ends.
// Operator guide: docs/white-label.md
import { spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync, cpSync, unlinkSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const clientDir = join(repoRoot, 'client')
const androidDir = join(clientDir, 'android')
const configPath = join(clientDir, 'config', 'service.json')
const backupPath = join(clientDir, 'config', 'service.brand-backup.json')
const GENERATED_MARKER = '//brand-mjs'

// Flavor names may not collide with build types / standard source sets.
const RESERVED_IDS = ['debug', 'release', 'main', 'test', 'androidtest', 'profile', 'app']

const usage = `usage: node tools/brand.mjs <brand> [--dev] [--id <id>] [--variant release|debug] [--install] [--no-build]
  <brand>      brand id under client/brands/<id>, or a path to a brand dir outside the repo
  --dev        fill panelPubKey / bootstrap / hybrid / dev login from the local gitignored
               client/config/service.json (demo + local testing builds only)
  --id <id>    override the brand id (default: the brand dir's basename)
  --variant    release (default) or debug
  --install    adb install -r the built APK when the build succeeds
  --no-build   validate + generate the res overlay only (no config swap, no gradle)`

function fail (msg) {
  console.error(`brand.mjs: ${msg}`)
  process.exit(1)
}

// ---------- arguments ----------
const argv = process.argv.slice(2)
let brandArg = null
const opts = { dev: false, id: null, variant: 'release', install: false, build: true }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dev') opts.dev = true
  else if (a === '--id') opts.id = argv[++i]
  else if (a === '--variant') opts.variant = argv[++i]
  else if (a === '--install') opts.install = true
  else if (a === '--no-build') opts.build = false
  else if (a === '--help' || a === '-h') { console.log(usage); process.exit(0) }
  else if (a.startsWith('-')) fail(`unknown option ${a}\n${usage}`)
  else if (brandArg) fail(`unexpected argument ${a}\n${usage}`)
  else brandArg = a
}
if (!brandArg) fail(usage)
if (!['release', 'debug'].includes(opts.variant)) fail(`--variant must be release or debug`)

const brandDir = (brandArg.includes('/') || brandArg.includes(sep) || isAbsolute(brandArg))
  ? resolve(brandArg)
  : join(clientDir, 'brands', brandArg)
if (!existsSync(join(brandDir, 'service.json'))) fail(`no service.json in ${brandDir}`)

const id = (opts.id ?? basename(brandDir)).toLowerCase()
if (!/^[a-z][a-z0-9]{0,23}$/.test(id)) {
  fail(`brand id '${id}' must be 1-24 lowercase letters/digits, starting with a letter (it becomes the applicationId suffix; use --id to override the dir name)`)
}
if (RESERVED_IDS.includes(id)) fail(`brand id '${id}' collides with an Android build-type/source-set name — use --id`)

// ---------- read + validate the descriptor ----------
let descriptor
try {
  descriptor = JSON.parse(readFileSync(join(brandDir, 'service.json'), 'utf8'))
} catch (err) {
  fail(`invalid JSON in ${join(brandDir, 'service.json')}: ${err.message}`)
}
if (descriptor.dev) {
  fail('the brand descriptor carries a dev credentials block — brand dirs must never contain credentials. Remove it; use --dev to borrow the local gitignored dev config for demo builds.')
}
if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) fail('descriptor needs a non-empty "name"')
if (descriptor.branding != null && typeof descriptor.branding !== 'object') fail('"branding" must be an object')
if (descriptor.branding?.colors != null && typeof descriptor.branding.colors !== 'object') fail('"branding.colors" must be an object')
if (!existsSync(join(brandDir, 'icon.png'))) fail(`missing required icon.png in ${brandDir} (launcher-icon foreground)`)

// ---------- --dev merge from the local dev config ----------
if (opts.dev) {
  if (!existsSync(configPath)) fail(`--dev needs ${configPath} (your local dev config)`)
  const local = JSON.parse(readFileSync(configPath, 'utf8'))
  if (typeof descriptor.panelPubKey !== 'string' || descriptor.panelPubKey.startsWith('REPLACE_')) delete descriptor.panelPubKey
  for (const key of ['panelPubKey', 'bootstrap', 'hybrid', 'dev']) {
    if (descriptor[key] === undefined && local[key] !== undefined) descriptor[key] = local[key]
  }
}
const keyOk = typeof descriptor.panelPubKey === 'string' && /^[0-9a-f]{64}$/i.test(descriptor.panelPubKey)
if (!keyOk) {
  const msg = `descriptor panelPubKey is missing or a placeholder — set the operator's panel public key in the brand service.json, or build with --dev`
  if (opts.build) fail(msg)
  console.warn(`brand.mjs: warning: ${msg}`)
}

// Baked art is exposed to the app as Android drawable resources; RN's <Image>
// loads them by bare resource name. Wire them up unless the descriptor already
// points somewhere (e.g. an https URL).
descriptor.branding ??= {}
if (existsSync(join(brandDir, 'logo.png')) && !descriptor.branding.logo) descriptor.branding.logo = 'brand_logo'
if (existsSync(join(brandDir, 'wallpaper.png')) && !descriptor.branding.wallpaper) descriptor.branding.wallpaper = 'brand_wallpaper'

// ---------- generate the Android res overlay ----------
const overlay = join(androidDir, 'app', 'build', 'aliranBrand', id, 'res')
rmSync(overlay, { recursive: true, force: true })
for (const d of ['values', 'drawable', 'mipmap-anydpi-v26']) mkdirSync(join(overlay, d), { recursive: true })

// app_name: escape for XML, then Android string-resource quoting (apostrophes).
const appName = descriptor.name
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, "\\'")
writeFileSync(join(overlay, 'values', 'strings.xml'),
  `<resources>\n    <string name="app_name">${appName}</string>\n</resources>\n`)

// Launcher-icon background layer: a flat brand color (#RRGGBB only — Android
// resource colors are #AARRGGBB, so web rgba()/#RRGGBBAA strings don't apply).
let iconBg = descriptor.branding.colors?.primary ?? '#111111'
if (!/^#[0-9a-fA-F]{6}$/.test(iconBg)) {
  console.warn(`brand.mjs: warning: branding.colors.primary '${iconBg}' is not #RRGGBB — launcher-icon background falls back to #111111`)
  iconBg = '#111111'
}
writeFileSync(join(overlay, 'values', 'colors.xml'),
  `<resources>\n    <color name="brand_icon_bg">${iconBg}</color>\n</resources>\n`)

copyFileSync(join(brandDir, 'icon.png'), join(overlay, 'drawable', 'brand_icon.png'))
writeFileSync(join(overlay, 'drawable', 'brand_icon_fg.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<inset xmlns:android="http://schemas.android.com/apk/res/android"\n    android:drawable="@drawable/brand_icon"\n    android:inset="18%" />\n`)
const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/brand_icon_bg" />\n    <foreground android:drawable="@drawable/brand_icon_fg" />\n</adaptive-icon>\n`
// minSdk 29 > 26, so the anydpi-v26 adaptive icon overrides main's density PNGs everywhere.
writeFileSync(join(overlay, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive)
writeFileSync(join(overlay, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive)

for (const [src, dst] of [
  ['logo.png', join('drawable', 'brand_logo.png')],
  ['wallpaper.png', join('drawable', 'brand_wallpaper.png')],
  ['banner.png', join('drawable', 'tv_banner.png')] // overrides the stock TV banner
]) {
  if (existsSync(join(brandDir, src))) copyFileSync(join(brandDir, src), join(overlay, dst))
}
// Escape hatch: a full res tree in the brand dir wins over everything generated
// (e.g. hand-tuned per-density mipmaps instead of the adaptive icon).
if (existsSync(join(brandDir, 'res'))) cpSync(join(brandDir, 'res'), overlay, { recursive: true })

const flavor = id[0].toUpperCase() + id.slice(1)
const variantCap = opts.variant[0].toUpperCase() + opts.variant.slice(1)
const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', id, opts.variant, `app-${id}-${opts.variant}.apk`)

console.log(`brand: ${id}  ("${descriptor.name}", com.aliranclient.${id})`)
console.log(`overlay: ${overlay}`)
if (!opts.build) {
  console.log('--no-build: validation + res overlay done; skipping config swap and gradle.')
  process.exit(0)
}

// ---------- swap the bundled config, build, ALWAYS restore ----------
if (existsSync(backupPath)) {
  // A previous run died before restoring. Only auto-heal when the current config
  // is clearly one of ours; otherwise leave both files for the user to reconcile.
  let stale = null
  try { stale = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
  if (stale?.[GENERATED_MARKER]) {
    copyFileSync(backupPath, configPath)
    unlinkSync(backupPath)
    console.warn('brand.mjs: restored the dev config from a stale service.brand-backup.json (a previous run was interrupted)')
  } else {
    fail(`${backupPath} already exists but ${configPath} is not brand.mjs-generated — resolve the two files manually before building`)
  }
}
const hadConfig = existsSync(configPath)
if (hadConfig) copyFileSync(configPath, backupPath)
descriptor[GENERATED_MARKER] = `generated for brand '${id}' — the dev config is backed up at service.brand-backup.json and restored automatically; do not commit`
writeFileSync(configPath, JSON.stringify(descriptor, null, 2) + '\n')

let status = 1
try {
  // The RN release bundle task does not track config/service.json as an input
  // (docs/client-build.md gotcha) — drop its outputs so the swapped descriptor
  // is guaranteed to land in this APK.
  rmSync(join(androidDir, 'app', 'build', 'generated', 'assets', 'react'), { recursive: true, force: true })
  const gradleArgs = [
    `:app:assemble${flavor}${variantCap}`,
    `-PaliranBrandId=${id}`,
    `-PaliranBrandRes=${overlay}`,
    '--no-daemon'
  ]
  console.log(`gradle ${gradleArgs.join(' ')}`)
  const res = process.platform === 'win32'
    // NoDefaultCurrentDirectoryInExePath-safe: invoke the wrapper with an explicit .\ prefix.
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `.\\gradlew.bat ${gradleArgs.join(' ')}`], { cwd: androidDir, stdio: 'inherit' })
    : spawnSync('./gradlew', gradleArgs, { cwd: androidDir, stdio: 'inherit' })
  status = res.status ?? 1
} finally {
  if (hadConfig) {
    copyFileSync(backupPath, configPath)
    unlinkSync(backupPath)
  } else {
    rmSync(configPath, { force: true })
  }
  console.log('dev config restored.')
}
if (status !== 0) fail(`gradle build failed (exit ${status})`)
if (!existsSync(apkPath)) fail(`build reported success but no APK at ${apkPath}`)
console.log(`APK: ${apkPath}`)

if (opts.install) {
  const res = spawnSync('adb', ['install', '-r', apkPath], { stdio: 'inherit', shell: process.platform === 'win32' })
  if ((res.status ?? 1) !== 0) fail('adb install failed')
  console.log(`installed com.aliranclient.${id}`)
}
