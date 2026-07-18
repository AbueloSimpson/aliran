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
  if (cmd === 'set-admin-password') {
    const name = pos[0]; if (!name) return usage()
    ops.setAdminPassword({ config, keys, dataDir: config.dataDir }, name, await needPassword(name, opts))
    console.log(`Password updated for admin "${name}" (existing admin sessions revoked).`)
    return
  }
  if (cmd === 'list-admins') {
    for (const a of ops.listAdmins({ config, keys, dataDir: config.dataDir })) {
      console.log(a.name, '->', JSON.stringify({ status: a.status, createdAt: a.createdAt }))
    }
    return
  }

  // Publisher enrollment (S26) touches only the private publishers file — like the
  // admin commands it needs no store (no ELOCKED while the panel is running).
  if (cmd === 'add-publisher') {
    const name = pos[0]; if (!name) return usage()
    const p = ops.addPublisher({ config, keys, dataDir: config.dataDir }, name, { scopes: str(opts.scopes) })
    console.log(`Enrolled publisher "${name}" (scopes: ${p.scopes.length ? p.scopes.join(', ') : '(none — add some or it cannot register anything)'}).`)
    console.log('Put BOTH lines in THAT site\'s broadcaster .env — the secret is shown ONCE, the panel keeps only the public key:')
    console.log('  PUBLISHER_NAME=' + name)
    console.log('  PUBLISHER_KEY=' + p.secretKey)
    return
  }
  if (cmd === 'list-publishers') {
    for (const p of ops.listPublishers({ config, keys, dataDir: config.dataDir })) {
      console.log(p.name, '->', JSON.stringify({ status: p.status, scopes: p.scopes, publicKey: p.publicKey.slice(0, 16) + '…', addedAt: p.addedAt }))
    }
    return
  }
  if (cmd === 'set-publisher-scopes') {
    const [name, scopes] = pos; if (!name || scopes == null) return usage()
    const p = ops.setPublisherScopes({ config, keys, dataDir: config.dataDir }, name, scopes)
    console.log(`Scopes for publisher "${name}" = ${p.scopes.length ? p.scopes.join(', ') : '(none)'} (applies from its next registration).`)
    return
  }
  if (cmd === 'set-publisher-status') {
    const [name, status] = pos; if (!name || !status) return usage()
    ops.setPublisherStatus({ config, keys, dataDir: config.dataDir }, name, status)
    console.log(`Publisher "${name}" is now ${status}.` + (status === 'revoked' ? ' Its registrations are rejected until re-activated.' : ''))
    return
  }
  if (cmd === 'remove-publisher') {
    const name = pos[0]; if (!name) return usage()
    ops.removePublisher({ config, keys, dataDir: config.dataDir }, name)
    console.log(`Removed publisher "${name}". (Revoking instead keeps the audit trail.)`)
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

    case 'delete-user': {
      const username = pos[0]; if (!username) return usage(await done())
      await ops.deleteUser(ctx, username)
      console.log(`Deleted user "${username}". (Already-issued session tokens ride out their offline validity window.)`)
      break
    }

    case 'delete-stream': {
      const id = pos[0]; if (!id) return usage(await done())
      const r = await ops.deleteStream(ctx, id)
      console.log(`Purged stream "${id}": catalog record, private key, art, and ${r.grantsRevoked} grant(s).`)
      console.log('(Clients that already unsealed the key may have it cached; re-adding the id mints a fresh key.)')
      break
    }

    case 'list-devices': {
      const username = pos[0]; if (!username) return usage(await done())
      for (const d of await ops.listDevices(ctx, username)) {
        console.log(d.deviceId, '->', JSON.stringify({ label: d.label, issuedAt: d.issuedAt, expiresAt: d.expiresAt, expired: d.expired }))
      }
      break
    }

    case 'logout-device': {
      const [username, deviceId] = pos; if (!username || !deviceId) return usage(await done())
      const u = await ops.revokeDevice(ctx, username, deviceId)
      console.log(`Removed device "${deviceId}" from "${username}" (${u.devices} enrolled). Cooperative: the SDK drops to login on its next online check.`)
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
        isLive: opts.live != null ? opts.live : undefined,
        order: opts.order != null ? String(opts.order) : undefined, // ops validates (0-9999 | 'null')
        featured: opts.featured != null ? opts.featured : undefined
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
      let after = ''
      do {
        const { users, next } = await ops.listUsers(ctx, { after, limit: 500 })
        for (const u of users) {
          console.log('user/' + u.username, '->', JSON.stringify({ status: u.status, grants: u.grants, maxDevices: u.maxDevices }))
        }
        after = next
      } while (after)
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
  delete-user <u>                       Delete the account record entirely
  add-stream <id> [--feed <hex>] [--key <hex>] [--title T] [--category C]
  delete-stream <id>                    FULL purge: catalog + private key + grants + art
  grant <u> <streamId>                  Entitle a user to a stream
  revoke <u> <streamId>                 Remove an entitlement
  set-meta <id> [--title --feed --live --order <n|null> --featured [true|false] --poster ...]
                                        (art fields take an 'assets/…' path or an https:// URL; '' clears)
  set-max-devices <u> <n>               Concurrent device limit
  list-devices <u>                      Show a user's enrolled devices
  logout-device <u> <deviceId>          Drop one device enrollment (no tokenVersion bump)
  logout-all <u>                        Revoke all sessions
  list                                  List users and streams
  add-admin <name> [--password <pw>]    Create an admin for the HTTP admin API (min 8 chars)
  remove-admin <name>                   Delete an admin account
  set-admin-password <name> [--password <pw>]   Rotate an admin password (revokes their sessions)
  list-admins                           List admin accounts
  add-publisher <name> [--scopes "east-*,espn2"]   Enroll a broadcaster site: per-site keypair
                                        (secret printed ONCE) + streamId-glob channel scopes
  list-publishers                       List enrolled publishers
  set-publisher-scopes <name> <globs>   Replace a publisher's channel scopes (comma-separated)
  set-publisher-status <name> <active|revoked>   Revoke/re-activate a publisher's key
  remove-publisher <name>               Hard-delete a publisher (revoke keeps the audit trail)
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
