#!/usr/bin/env node
// Library control-API admin management (self-contained copy of the broadcaster's
// control-cli.js — separate deployables each ship their own; see control-auth.js).
//
//   node src/library-cli.js add-admin <name> [--password <pw>]
//   node src/library-cli.js remove-admin <name>
//   node src/library-cli.js set-admin-password <name> [--password <pw>]
//   node src/library-cli.js list-admins
//
// Touches only DATA_DIR/secrets/admins.json — safe while the library runs.

import readline from 'readline'
import fs from 'fs'
import { Writable } from 'stream'
import { config } from './config.js'
import { addAdmin, removeAdmin, listAdmins, setAdminPassword } from './control-auth.js'

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
        `  Pipe it in:  printf '%s\\n' "$PW" | node src/library-cli.js …\n` +
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
// in docker logs, CI logs, and scrollback.
function needPassword (cmd, name, opts, pos) {
  if (pos.length > 1) {
    console.error(`${cmd} takes the password as a flag, not as an argument (got ${pos.length - 1} extra).\n` +
      `  node src/library-cli.js ${cmd} ${name}                       asks for it here\n` +
      `  printf '%s\\n' "$PW" | node src/library-cli.js ${cmd} ${name}  reads it from the pipe\n` +
      `  node src/library-cli.js ${cmd} ${name} --password '<pw>'      puts it in the command\n` +
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
    const password = await needPassword('add-admin', name, opts, pos)
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
  if (cmd === 'set-admin-password') {
    const name = pos[0]; if (!name) return usage()
    const password = await needPassword('set-admin-password', name, opts, pos)
    setAdminPassword(ctx, name, password)
    console.log(`Password updated for control admin "${name}" (existing sessions revoked).`)
    return
  }
  if (cmd === 'list-admins') {
    for (const a of listAdmins(ctx)) console.log(a.name, '->', JSON.stringify({ status: a.status, createdAt: a.createdAt }))
    return
  }
  usage()
}

function usage () {
  console.log(`Aliran library control CLI

  add-admin <name> [--password <pw>]    Create an admin for the control API (min 8 chars)
  remove-admin <name>                   Delete an admin account
  set-admin-password <name> [--password <pw>]   Rotate an admin password (revokes their sessions)
  list-admins                           List admin accounts

The password is NEVER an argument. Give it in one of three ways — the first keeps it
out of argv, so use it when you have a terminal:

  node src/library-cli.js add-admin op                       asks for it here (hidden)
  printf '%s\\n' "$PW" | node src/library-cli.js add-admin op  reads it from the pipe
  node src/library-cli.js add-admin op --password '<pw>'      puts it in the command

The flag form shows the password in \`ps\` and in the shell history. Use it only in
automation. With no terminal, use the pipe: \`docker compose run -T --rm library …\`.
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
