// Config validation + structured-logging test (S40). Two halves:
//   1. every service's config.js FAILS FAST on a typo'd env var, with an error
//      naming the exact variable (subprocess probes — validation runs at import);
//   2. clean-env imports stay green, and LOG_FORMAT=json turns console lines into
//      parseable {ts,level,svc,msg} JSON while the default output stays untouched.
// No network, no DHT — deterministic, belongs in the required CI lane.
import { spawnSync } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'
import path from 'path'
import assert from 'assert'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfgUrl = (svc) => pathToFileURL(path.join(root, svc, 'src', 'config.js')).href

function probeImport (url, env) {
  return spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(url)}).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })`
  ], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })
}

// ===== 1: bad env → clear boot error naming the variable =====
const BAD = [
  ['panel', { LOCKOUT_THRESHOLD: 'abc' }, 'LOCKOUT_THRESHOLD'],
  ['panel', { ADMIN_PORT: '70000' }, 'ADMIN_PORT'],
  ['broadcaster', { FEED_BUFFER: 'rma' }, 'FEED_BUFFER'],
  ['broadcaster', { PANEL_PUBKEY: 'nothex' }, 'PANEL_PUBKEY'],
  ['broadcaster', { INGEST_PORT_BASE: '6000', INGEST_PORT_MAX: '5000' }, 'INGEST_PORT_BASE'],
  ['reseller', { PANEL_ADMIN_URL: 'not a url' }, 'PANEL_ADMIN_URL'],
  ['reseller', { WEBHOOK_SECRET: 'short' }, 'WEBHOOK_SECRET'],
  ['library', { INGEST_CONCURRENCY: '0' }, 'INGEST_CONCURRENCY'],
  ['repeater', { STATUS_PORT: 'abc' }, 'STATUS_PORT'],
  ['repeater', { BOOTSTRAP: 'no-port-here' }, 'BOOTSTRAP']
]
for (const [svc, env, needle] of BAD) {
  const r = probeImport(cfgUrl(svc), env)
  assert.notStrictEqual(r.status, 0, `${svc} must reject bad ${needle}`)
  assert.ok((r.stderr || '').includes(needle), `${svc} error must name ${needle} (got: ${r.stderr})`)
  console.log(`  ok   ${svc} rejects bad ${needle}`)
}

// ===== 2a: clean env still boots every config =====
for (const svc of ['panel', 'broadcaster', 'reseller', 'library', 'repeater']) {
  const r = probeImport(cfgUrl(svc), {})
  assert.strictEqual(r.status, 0, `${svc} clean config must load (stderr: ${r.stderr})`)
  console.log(`  ok   ${svc} clean config loads`)
}

// ===== 2b: LOG_FORMAT=json → parseable lines; default → byte-identical =====
const logUrl = pathToFileURL(path.join(root, 'panel', 'src', 'log.js')).href
const jsonRun = spawnSync(process.execPath, ['-e',
  `import(${JSON.stringify(logUrl)}).then(({ initLogging }) => { initLogging('probe'); console.log('hello', { a: 1 }); console.error(new Error('boom')) })`
], { env: { ...process.env, LOG_FORMAT: 'json' }, encoding: 'utf8', timeout: 30000 })
const info = JSON.parse(jsonRun.stdout.trim().split('\n')[0])
assert.ok(info.ts && info.level === 'info' && info.svc === 'probe', 'json line carries ts/level/svc')
assert.ok(info.msg.includes('hello') && info.msg.includes('"a":1'), 'json line serializes args')
const err = JSON.parse(jsonRun.stderr.trim().split('\n')[0])
assert.ok(err.level === 'error' && err.msg.includes('boom'), 'errors emit level=error on stderr')
const plainRun = spawnSync(process.execPath, ['-e',
  `import(${JSON.stringify(logUrl)}).then(({ initLogging }) => { initLogging('probe'); console.log('plain line') })`
], { env: { ...process.env, LOG_FORMAT: '' }, encoding: 'utf8', timeout: 30000 })
assert.strictEqual(plainRun.stdout.trim(), 'plain line', 'default output stays byte-identical')
console.log('  ok   LOG_FORMAT=json emits parseable lines; default output untouched')

console.log('\nconfig-validation: ALL PASS')
