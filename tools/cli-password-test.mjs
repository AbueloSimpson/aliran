// How the four bootstrap CLIs take a password. No network, no docker — each CLI is
// spawned against a throwaway DATA_DIR. npm run test:cli-password
//
// THE BUG THIS LOCKS DOWN. docker-compose.yml and docs/reseller-panel.md used to document
//   docker compose run --rm panel node src/admin-cli.js add-admin <name> <password>
// but the password has always been a FLAG. The positional landed in pos[1] and was
// dropped, so the CLI fell through to its hidden prompt. Two ways that ended badly:
//
//   with a TTY     the operator is asked for a password they believe they already gave,
//                  and the account ends up with whatever they type — not the argv value.
//   with no TTY    readline with terminal:true never fires its question callback. The
//                  promise never settled, the event loop drained, and node exited **0**.
//                  `… add-admin bob pw && echo ok` printed "ok" and created NO admin.
//
// The second one is the dangerous one: a silent false success during first-time bootstrap.
// So the assertions below care as much about the EXIT CODE as about the message.
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const log = (...a) => console.log(...a)

// A value we can grep the output for. If a refusal ever echoes the stray argument back,
// this shows up — and stderr here lands in docker logs, CI logs and scrollback.
const SECRET = 'S3CRET-must-not-appear'
const GOOD = 'a-good-password-9'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aliran-cli-pw-'))
const dataDir = (tag) => {
  const d = path.join(tmp, tag)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// stdin: 'pipe' with input (automation), or 'ignore' = no TTY and no pipe (CI, -T,
// </dev/null). Never a TTY — a test harness has none, which is exactly the case that broke.
function run (cli, args, { input, dir } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir },
    input: input === undefined ? undefined : input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : undefined
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// ===== The contract, run against every CLI that asks for a password =====
// name        the CLI's own script name, which its messages quote back
// cli         absolute path to the entrypoint
// dir         a fresh DATA_DIR
// cmd/who     the account-creating command and a principal name
// listCmd     a read-back verb proving the account really exists
// setup       anything the CLI needs first (the panel needs its keypair)
function checkPasswordContract ({ name, cli, dir, cmd, who, listCmd, setup }) {
  if (setup) {
    const s = run(cli, setup, { dir })
    assert.strictEqual(s.code, 0, `${name}: setup ${setup.join(' ')} failed: ${s.out}`)
  }

  // 1. THE DOCUMENTED-BUT-BROKEN FORM. Must refuse, must exit non-zero, must point at the
  //    flag, and must NOT echo the password back into the log stream.
  const positional = run(cli, [cmd, who, SECRET], { dir })
  assert.strictEqual(positional.code, 1, `${name}: a positional password must exit 1, got ${positional.code}`)
  assert.ok(/not as an argument/.test(positional.out), `${name}: the refusal says the password is not an argument: ${positional.out}`)
  assert.ok(positional.out.includes('--password'), `${name}: the refusal names --password: ${positional.out}`)
  assert.ok(!positional.out.includes(SECRET), `${name}: the refusal LEAKED the password into its output: ${positional.out}`)

  // 2. THE SILENT-SUCCESS REGRESSION. No TTY and no pipe used to exit 0 having done
  //    nothing. Anything other than a non-zero exit here is the old bug back.
  const blind = run(cli, [cmd, who], { dir })
  assert.notStrictEqual(blind.code, 0, `${name}: no TTY and no pipe must NOT report success (this was the silent exit-0)`)
  assert.ok(/No terminal to ask on/.test(blind.out), `${name}: it says why it cannot ask: ${blind.out}`)

  // 3. The pipe: automation WITHOUT putting the password in argv.
  const piped = run(cli, [cmd, who], { input: GOOD + '\n', dir })
  assert.strictEqual(piped.code, 0, `${name}: a piped password must work: ${piped.out}`)

  // 4. The flag still works — it is the documented automation escape hatch.
  const flagged = run(cli, [cmd, who + '2', '--password', GOOD], { dir })
  assert.strictEqual(flagged.code, 0, `${name}: --password must work: ${flagged.out}`)

  // Both accounts really exist: an exit 0 that created nothing is the whole point here.
  const listed = run(cli, [listCmd], { dir })
  assert.ok(listed.out.includes(who), `${name}: ${listCmd} shows the piped account: ${listed.out}`)
  assert.ok(listed.out.includes(who + '2'), `${name}: ${listCmd} shows the --password account: ${listed.out}`)
  log(`${name}: positional refused (no leak) · no-TTY exits non-zero · pipe + --password both create ✓`)
}

checkPasswordContract({
  name: 'panel add-admin',
  cli: path.join(ROOT, 'panel', 'src', 'admin-cli.js'),
  dir: dataDir('panel'),
  setup: ['init'],
  cmd: 'add-admin',
  who: 'bob',
  listCmd: 'list-admins'
})

checkPasswordContract({
  name: 'broadcaster add-admin',
  cli: path.join(ROOT, 'broadcaster', 'src', 'control-cli.js'),
  dir: dataDir('broadcaster'),
  cmd: 'add-admin',
  who: 'op',
  listCmd: 'list-admins'
})

checkPasswordContract({
  name: 'library add-admin',
  cli: path.join(ROOT, 'library', 'src', 'library-cli.js'),
  dir: dataDir('library'),
  cmd: 'add-admin',
  who: 'op',
  listCmd: 'list-admins'
})

// ===== Panel: the other three password verbs share the helper =====
// set-admin-password is store-free like add-admin; create-user and set-password run AFTER
// openStore, so this also proves the refusal fires on the store-backed path (and still
// before any write).
{
  const dir = dataDir('panel-verbs')
  const cli = path.join(ROOT, 'panel', 'src', 'admin-cli.js')
  assert.strictEqual(run(cli, ['init'], { dir }).code, 0, 'panel init')
  assert.strictEqual(run(cli, ['add-admin', 'bob'], { input: GOOD + '\n', dir }).code, 0, 'seed an admin to rotate')
  for (const [cmd, who] of [['set-admin-password', 'bob'], ['create-user', 'alice'], ['set-password', 'alice']]) {
    const r = run(cli, [cmd, who, SECRET], { dir })
    assert.strictEqual(r.code, 1, `panel ${cmd}: a positional password must exit 1, got ${r.code}: ${r.out}`)
    assert.ok(r.out.includes('--password'), `panel ${cmd}: names --password: ${r.out}`)
    assert.ok(!r.out.includes(SECRET), `panel ${cmd}: LEAKED the password: ${r.out}`)
  }
  log('panel set-admin-password / create-user / set-password: positional refused, no leak ✓')
}

// ===== Reseller: same contract, plus the positional command it MUST keep =====
{
  const dir = dataDir('reseller')
  const cli = path.join(ROOT, 'reseller', 'src', 'reseller-cli.js')

  // add-admin seeds THE root and refuses a second one, so the shared contract (which makes
  // two accounts) does not fit. Check the same four behaviors against one root + set-password.
  const positional = run(cli, ['add-admin', 'boss', SECRET], { dir })
  assert.strictEqual(positional.code, 1, 'reseller add-admin: a positional password must exit 1')
  assert.ok(!positional.out.includes(SECRET), 'reseller add-admin: no leak')
  assert.ok(positional.out.includes('--password'), 'reseller add-admin: names --password')

  const blind = run(cli, ['add-admin', 'boss'], { dir })
  assert.notStrictEqual(blind.code, 0, 'reseller add-admin: no TTY and no pipe must NOT report success')

  assert.strictEqual(run(cli, ['add-admin', 'boss'], { input: GOOD + '\n', dir }).code, 0, 'reseller add-admin: pipe works')
  assert.ok(run(cli, ['list-principals'], { dir }).out.includes('boss'), 'reseller: the root admin exists')

  const setPw = run(cli, ['set-password', 'boss', SECRET], { dir })
  assert.strictEqual(setPw.code, 1, 'reseller set-password: a positional password must exit 1')
  assert.ok(!setPw.out.includes(SECRET), 'reseller set-password: no leak')
  assert.strictEqual(run(cli, ['set-password', 'boss', '--password', GOOD], { dir }).code, 0, 'reseller set-password: --password works')
  log('reseller add-admin / set-password: positional refused (no leak) · no-TTY exits non-zero · pipe + --password work ✓')

  // ⚠ THE REGRESSION GUARD. The refusal counts positionals, so it must live in the password
  // verbs ONLY — `mint <name> <amount>` legitimately takes two and must not be caught by it.
  const mint = run(cli, ['mint', 'boss', '500'], { dir })
  assert.strictEqual(mint.code, 0, `reseller mint <name> <amount> must still work: ${mint.out}`)
  assert.ok(mint.out.includes('500'), `reseller mint credited: ${mint.out}`)
  assert.ok(run(cli, ['balance', 'boss'], { dir }).out.includes('500'), 'reseller balance reads back')
  log('reseller mint <name> <amount>: two positionals still accepted ✓')
}

// ===== The usage text must survive its own template literal =====
// The footer shows `printf '%s\n' "$PW" | …`. Inside a template literal that \n has to be
// written \\n or it renders as a REAL newline and splits the example across two lines —
// which is how the first draft of this footer shipped. Assert the line is intact.
{
  const PIPE_EXAMPLE = "printf '%s\\n' \"$PW\" |"
  const dir = dataDir('usage')
  const panelCli = path.join(ROOT, 'panel', 'src', 'admin-cli.js')
  assert.strictEqual(run(panelCli, ['init'], { dir }).code, 0, 'panel init for the usage check')
  for (const [name, cli, d] of [
    ['panel', panelCli, dir],
    ['broadcaster', path.join(ROOT, 'broadcaster', 'src', 'control-cli.js'), dataDir('usage-b')],
    ['library', path.join(ROOT, 'library', 'src', 'library-cli.js'), dataDir('usage-l')],
    ['reseller', path.join(ROOT, 'reseller', 'src', 'reseller-cli.js'), dataDir('usage-r')]
  ]) {
    const out = run(cli, [], { dir: d }).out
    assert.ok(out.includes(PIPE_EXAMPLE), `${name} usage: the pipe example is broken across lines (escape \\n as \\\\n):\n${out}`)
  }
  log('usage footers: the printf pipe example stays on one line ✓')
}

fs.rmSync(tmp, { recursive: true, force: true })
log('\nAll CLI password-argument tests passed.')
