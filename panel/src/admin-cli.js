#!/usr/bin/env node
// Aliran panel admin CLI. Thin wrapper over the shared ops (src/ops.js) — the same
// implementation the admin HTTP API (src/admin-server.js) uses, so the two can't drift.
//
//   node src/admin-cli.js <command> [args] [--flags]
//
// See docs/reference.md. Stream encryption keys live in a panel-private secrets file
// (DATA_DIR/secrets/streams.json), NOT in the replicated DB.

import readline from 'readline'
import { Writable } from 'stream'
import fs from 'fs'
import path from 'path'
import { config } from './config.js'
import { initKeys, openKeys } from './keys.js'
import { openStore } from './store.js'
import * as ops from './ops.js'

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

async function needPassword (username, opts) {
  return opts.password != null && opts.password !== true ? String(opts.password) : promptHidden(`Password for ${username}: `)
}

function requireKeys () {
  const keys = openKeys(config.dataDir)
  if (!keys) { console.error('Panel not initialized. Run: node src/admin-cli.js init'); process.exit(1) }
  return keys
}

const str = (v) => (v != null && v !== true ? String(v) : undefined)

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, opts } = parseArgs(rest)

  if (cmd === 'init') {
    const { publicKeyHex, publisherSecretHex } = initKeys(config.dataDir)
    console.log('Panel initialized.')
    console.log('Panel public key (give to clients):\n  ' + publicKeyHex)
    console.log('Publisher key (put in the broadcaster .env as PUBLISHER_KEY):\n  ' + publisherSecretHex)
    console.log('Keys are in ' + config.dataDir + '/keys (gitignored — BACK UP).')
    return
  }

  const keys = requireKeys()

  // Admin-account commands touch only the private admins file — no store needed
  // (and no ELOCKED when the panel is running).
  if (cmd === 'add-admin') {
    const name = pos[0]; if (!name) return usage()
    ops.addAdmin({ config, keys, dataDir: config.dataDir }, name, await needPassword(name, opts))
    console.log(`Created admin "${name}" (credentials in ${config.dataDir}/secrets/admins.json — panel-private).`)
    return
  }
  if (cmd === 'remove-admin') {
    const name = pos[0]; if (!name) return usage()
    ops.removeAdmin({ config, keys, dataDir: config.dataDir }, name)
    console.log(`Removed admin "${name}".`)
    return
  }

  const { store, db, assets } = await openStore(config.dataDir, keys)
  const ctx = { config, keys, db, assets, dataDir: config.dataDir }
  const done = async () => { await store.close() }

  switch (cmd) {
    case 'create-user': {
      const username = pos[0]; if (!username) return usage(await done())
      await ops.createUser(ctx, username, await needPassword(username, opts))
      console.log(`Created user "${username}".`)
      break
    }

    case 'set-password': {
      const username = pos[0]; if (!username) return usage(await done())
      const u = await ops.setPassword(ctx, username, await needPassword(username, opts))
      console.log(`Password updated for "${username}" (re-sealed ${u.grants.length} grant(s)).`)
      break
    }

    case 'set-status': {
      const [username, status] = pos; if (!username || !status) return usage(await done())
      const u = await ops.setUserStatus(ctx, username, status)
      console.log(`User "${username}" is now ${u.status}.`)
      break
    }

    case 'add-stream': {
      const id = pos[0]; if (!id) return usage(await done())
      const { catalog, encryptionKey } = await ops.addStream(ctx, id, {
        title: str(opts.title),
        description: str(opts.description),
        category: str(opts.category),
        feedKey: str(opts.feed),
        key: str(opts.key)
      })
      console.log(`Registered stream "${id}".`)
      console.log('  feedKey:', catalog.feedKey || '(set later with set-meta --feed)')
      console.log('  encKey :', encryptionKey, '(private; give to the broadcaster)')
      break
    }

    case 'grant': {
      const [username, streamId] = pos; if (!username || !streamId) return usage(await done())
      await ops.grant(ctx, username, streamId)
      console.log(`Granted "${username}" access to "${streamId}".`)
      break
    }

    case 'revoke': {
      const [username, streamId] = pos; if (!username || !streamId) return usage(await done())
      await ops.revoke(ctx, username, streamId)
      console.log(`Revoked "${username}" access to "${streamId}". (Full revocation of live content needs a stream-key rotation.)`)
      break
    }

    case 'set-meta': {
      const id = pos[0]; if (!id) return usage(await done())
      await ops.setMeta(ctx, id, {
        title: str(opts.title),
        description: str(opts.description),
        feedKey: str(opts.feed),
        poster: str(opts.poster),
        backdrop: str(opts.backdrop),
        logo: str(opts.logo),
        status: str(opts.status),
        category: str(opts.category),
        isLive: opts.live != null ? opts.live : undefined
      })
      console.log(`Updated metadata for "${id}".`)
      break
    }

    case 'upload-art': {
      const [id, kind, file] = pos
      if (!id || !kind || !file) return usage(await done())
      if (!fs.existsSync(file)) { console.error('file not found:', file); break }
      const ext = path.extname(file) || '.bin'
      const r = await ops.uploadArt(ctx, id, kind, fs.readFileSync(file), ext)
      console.log(`Uploaded ${kind} for "${id}" → ${r[kind]}`)
      break
    }

    case 'set-max-devices': {
      const [username, n] = pos; if (!username || !n) return usage(await done())
      const u = await ops.setMaxDevices(ctx, username, n)
      console.log(`maxDevices for "${username}" = ${u.maxDevices}`)
      break
    }

    case 'logout-all': {
      const username = pos[0]; if (!username) return usage(await done())
      const u = await ops.logoutAll(ctx, username)
      console.log(`All sessions revoked for "${username}" (tokenVersion=${u.tokenVersion}).`)
      break
    }

    case 'list': {
      for (const u of await ops.listUsers(ctx)) {
        console.log('user/' + u.username, '->', JSON.stringify({ status: u.status, grants: u.grants, maxDevices: u.maxDevices }))
      }
      for (const s of await ops.listStreams(ctx)) {
        console.log('catalog/' + s.id, '->', JSON.stringify({ title: s.title, feedKey: s.feedKey, isLive: s.isLive, status: s.status }))
      }
      break
    }

    default:
      usage()
  }
  await done()
}

function usage () {
  console.log(`Aliran panel admin CLI

  init                                  Generate panel signing + OPRF keys
  create-user <u> [--password <pw>]     Create a user (OPRF-enrolled)
  set-password <u> [--password <pw>]    Rotate password (re-seals grants, revokes sessions)
  set-status <u> <active|disabled>      Disable/re-enable an account (disable revokes sessions)
  add-stream <id> [--feed <hex>] [--key <hex>] [--title T] [--category C]
  grant <u> <streamId>                  Entitle a user to a stream
  revoke <u> <streamId>                 Remove an entitlement
  set-meta <id> [--title --feed --live --poster ...]
  set-max-devices <u> <n>               Concurrent device limit
  logout-all <u>                        Revoke all sessions
  list                                  List users and streams
  add-admin <name> [--password <pw>]    Create an admin for the HTTP admin API (min 8 chars)
  remove-admin <name>                   Delete an admin account
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
