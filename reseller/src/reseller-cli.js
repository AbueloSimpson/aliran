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

function promptHidden (query) {
  return new Promise((resolve) => {
    let muted = false
    const out = new Writable({ write (c, e, cb) { if (!muted) process.stdout.write(c, e); cb() } })
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true })
    rl.question(query, (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
    muted = true
  })
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
    const password = opts.password != null && opts.password !== true ? String(opts.password) : await promptHidden(`Password for ${name}: `)
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
    const password = opts.password != null && opts.password !== true ? String(opts.password) : await promptHidden(`Password for ${name}: `)
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
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
