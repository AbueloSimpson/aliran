#!/usr/bin/env node
// Broadcaster control-API admin management (mirrors panel admin-cli's add-admin).
//
//   node src/control-cli.js add-admin <name> [--password <pw>]
//   node src/control-cli.js remove-admin <name>
//
// Touches only DATA_DIR/secrets/admins.json — safe while the broadcaster runs.

import readline from 'readline'
import { Writable } from 'stream'
import { config } from './config.js'
import { addAdmin, removeAdmin } from './control-auth.js'

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
    const password = opts.password != null && opts.password !== true ? String(opts.password) : await promptHidden(`Password for ${name}: `)
    addAdmin(ctx, name, password)
    console.log(`Created control admin "${name}" (credentials in ${config.dataDir}/secrets/admins.json — local-only).`)
    return
  }
  if (cmd === 'remove-admin') {
    const name = pos[0]; if (!name) return usage()
    removeAdmin(ctx, name)
    console.log(`Removed control admin "${name}".`)
    return
  }
  usage()
}

function usage () {
  console.log(`Aliran broadcaster control CLI

  add-admin <name> [--password <pw>]    Create an admin for the control API (min 8 chars)
  remove-admin <name>                   Delete an admin account
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
