#!/usr/bin/env node
// Reseller panel bootstrap CLI (library-cli.js pattern — touches only DATA_DIR
// files, safe while the service runs).
//
//   node src/reseller-cli.js add-admin <name> [--password <pw>]   Seed THE root admin
//   node src/reseller-cli.js list-principals [--role <r>]
//   node src/reseller-cli.js remove-principal <name>
//   node src/reseller-cli.js set-password <name> [--password <pw>]
//   node src/reseller-cli.js mint <name> <amount> [--note <t>]    Offline credit mint
//   node src/reseller-cli.js balance <name>
//
// Everything past bootstrap (co-admins, supers, resellers, transfers) happens
// through the running service's API/UI where the capability gates live — the CLI
// deliberately only seeds and inspects.

import readline from 'readline'
import fs from 'fs'
import { Writable } from 'stream'
import { config } from './config.js'
import { addPrincipal, removePrincipal, listPrincipals, setPrincipalPassword, loadPrincipals } from './control-auth.js'
import { openLedger } from './ledger.js'

function parseArgs (argv) {
  const pos = []; const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; opts[k] = v }
    else pos.push(a)
  }
  return { pos, opts }
}

// Password sources, and why the prompt is the default — see panel/src/admin-cli.js for the
// full note. Short version: the prompt keeps the password out of argv; a pipe does too and
// needs no TTY; --password does not. readline with terminal:true on a non-TTY stdin never
// fires its callback, so this used to exit **0** having created nothing.
let pipedLines = null
function nextPipedLine () {
  if (pipedLines == null) {
    let raw = ''
    try { raw = fs.readFileSync(0, 'utf8') } catch { raw = '' } // closed stdin reads as empty
    pipedLines = raw.split(/\r?\n/)
  }
  return pipedLines.shift()
}

async function promptHidden (query) {
  if (!process.stdin.isTTY) {
    const line = nextPipedLine()
    if (!line) {
      throw new Error(`No terminal to ask on, and stdin has no line for "${query.trim()}".\n` +
        `  Pipe it in:  printf '%s\\n' "$PW" | node src/reseller-cli.js …\n` +
        '  Or use --password <pw>, which puts the password in argv where `ps` and the\n' +
        '  shell history show it. Prefer the pipe in automation.')
    }
    return line
  }
  return new Promise((resolve) => {
    let muted = false
    const out = new Writable({ write (c, e, cb) { if (!muted) process.stdout.write(c, e); cb() } })
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true })
    rl.question(query, (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
    muted = true
  })
}

// This CLI has never taken the password as an argument — it is a FLAG. A positional one
// landed in pos[1] and was silently dropped. Refuse it and name the real forms. The stray
// value is never printed back: it is almost certainly the password, and stderr here lands
// in docker logs, CI logs, and scrollback. (`mint <name> <amount>` genuinely takes two
// positionals, which is why this check lives here and not in parseArgs.)
function needPassword (cmd, name, opts, pos) {
  if (pos.length > 1) {
    console.error(`${cmd} takes the password as a flag, not as an argument (got ${pos.length - 1} extra).\n` +
      `  node src/reseller-cli.js ${cmd} ${name}                       asks for it here\n` +
      `  printf '%s\\n' "$PW" | node src/reseller-cli.js ${cmd} ${name}  reads it from the pipe\n` +
      `  node src/reseller-cli.js ${cmd} ${name} --password '<pw>'      puts it in the command\n` +
      'The last form shows the password in `ps` and in the shell history. Use it only in automation.')
    process.exit(1)
  }
  return opts.password != null && opts.password !== true ? String(opts.password) : promptHidden(`Password for ${name}: `)
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, opts } = parseArgs(rest)
  const ctx = { config, dataDir: config.dataDir }

  if (cmd === 'add-admin') {
    const name = pos[0]; if (!name) return usage()
    const existing = Object.values(loadPrincipals(ctx.dataDir))
    if (existing.some((p) => p.root)) {
      console.error('A root admin already exists — co-admins are created by the root through the UI/API.')
      process.exit(1)
    }
    const password = await needPassword('add-admin', name, opts, pos)
    addPrincipal(ctx, { username: name, password, role: 'admin', root: true, parent: null, createdBy: 'cli' })
    console.log(`Seeded root admin "${name}" (credentials in ${config.dataDir}/secrets/principals.json — local-only).`)
    return
  }
  if (cmd === 'list-principals') {
    const ledger = openLedger(ctx.dataDir)
    for (const p of listPrincipals(ctx)) {
      if (opts.role && p.role !== opts.role) continue
      console.log(p.name, '->', JSON.stringify({ role: p.role, root: p.root || undefined, parent: p.parent, status: p.status, balance: ledger.balance(p.name) }))
    }
    return
  }
  if (cmd === 'remove-principal') {
    const name = pos[0]; if (!name) return usage()
    removePrincipal(ctx, name)
    console.log(`Removed principal "${name}".`)
    return
  }
  if (cmd === 'set-password') {
    const name = pos[0]; if (!name) return usage()
    const password = await needPassword('set-password', name, opts, pos)
    setPrincipalPassword(ctx, name, password)
    console.log(`Password updated for "${name}" (existing sessions revoked).`)
    return
  }
  if (cmd === 'mint') {
    const name = pos[0]; const amount = parseInt(pos[1], 10)
    if (!name || !Number.isInteger(amount) || amount <= 0) return usage()
    if (!loadPrincipals(ctx.dataDir)[name]) { console.error(`no such principal: ${name}`); process.exit(1) }
    const ledger = openLedger(ctx.dataDir)
    ledger.append({ type: 'MINT', actor: 'cli', entries: [{ principal: name, delta: amount }], note: typeof opts.note === 'string' ? opts.note : 'cli mint' })
    console.log(`Minted ${amount} credit(s) to "${name}" (balance: ${ledger.balance(name)}).`)
    return
  }
  if (cmd === 'balance') {
    const name = pos[0]; if (!name) return usage()
    if (!loadPrincipals(ctx.dataDir)[name]) { console.error(`no such principal: ${name}`); process.exit(1) }
    console.log(openLedger(ctx.dataDir).balance(name))
    return
  }
  usage()
}

function usage () {
  console.log(`Aliran reseller panel CLI

  add-admin <name> [--password <pw>]      Seed THE root admin (refused if one exists)
  list-principals [--role <r>]            Names, roles, status, balances
  remove-principal <name>                 Delete a principal record (root refused)
  set-password <name> [--password <pw>]   Rotate a password (revokes their sessions)
  mint <name> <amount> [--note <t>]       Offline credit mint (bootstrap/emergency)
  balance <name>                          Print a principal's derived balance

add-admin and set-password NEVER take the password as an argument. Give it in one of
three ways — the first keeps it out of argv, so use it when you have a terminal:

  node src/reseller-cli.js add-admin boss                       asks for it here (hidden)
  printf '%s\\n' "$PW" | node src/reseller-cli.js add-admin boss  reads it from the pipe
  node src/reseller-cli.js add-admin boss --password '<pw>'      puts it in the command

The flag form shows the password in \`ps\` and in the shell history. Use it only in
automation. With no terminal, use the pipe: \`docker compose run -T --rm reseller …\`.
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
