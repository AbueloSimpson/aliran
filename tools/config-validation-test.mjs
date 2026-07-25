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
  ['panel', { ANALYTICS_RETENTION_DAYS: 'abc' }, 'ANALYTICS_RETENTION_DAYS'],
  ['broadcaster', { FEED_BUFFER: 'rma' }, 'FEED_BUFFER'],
  ['broadcaster', { ANALYTICS_RETENTION_DAYS: '-1' }, 'ANALYTICS_RETENTION_DAYS'],
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

// ===== 1b: the --check dry-run entrypoint (S49a) =====
// `node src/config.js --check` (the file run DIRECTLY) must report on stdout and
// exit 0/1 instead of throwing — the MCP's server_set_env dry-runs a .env change
// in the built image this way before restarting. Importing the module (1/2a)
// must stay unaffected by a stray --check in argv (direct-run detection).
function probeCheck (svc, env) {
  return spawnSync(process.execPath, [path.join(root, svc, 'src', 'config.js'), '--check'],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })
}
for (const svc of ['panel', 'broadcaster', 'library', 'reseller']) {
  const r = probeCheck(svc, {})
  assert.strictEqual(r.status, 0, `${svc} --check must exit 0 on a clean env (stdout: ${r.stdout} stderr: ${r.stderr})`)
  assert.ok(r.stdout.includes(`${svc}: configuration OK`), `${svc} --check reports OK on stdout`)
  console.log(`  ok   ${svc} --check exits 0 on a clean env`)
}
const BAD_CHECK = [
  ['panel', { POW_DIFFICULTY: 'notanumber' }, 'POW_DIFFICULTY must be an integer'],
  ['broadcaster', { HLS_LIST_SIZE: '1' }, 'HLS_LIST_SIZE must be >= 2'],
  ['library', { INGEST_CONCURRENCY: '0' }, 'INGEST_CONCURRENCY must be >= 1'],
  ['reseller', { WEBHOOK_SECRET: 'short' }, 'WEBHOOK_SECRET must be at least 16 characters']
]
for (const [svc, env, needle] of BAD_CHECK) {
  const r = probeCheck(svc, env)
  assert.strictEqual(r.status, 1, `${svc} --check must exit 1 on a bad env (got ${r.status})`)
  assert.ok(r.stdout.includes(needle), `${svc} --check must print "${needle}" on stdout (got: ${r.stdout})`)
  assert.ok(!(r.stderr || '').includes('Error'), `${svc} --check reports cleanly, never a stack trace (stderr: ${r.stderr})`)
  console.log(`  ok   ${svc} --check exits 1 naming the problem`)
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
