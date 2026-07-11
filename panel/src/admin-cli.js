#!/usr/bin/env node
// Aliran panel admin CLI. Writes signed records into the account/catalog Hyperbee.
//
//   node src/admin-cli.js <command> [args] [--flags]
//
// See docs/reference.md. Stream encryption keys live in a panel-private secrets file
// (DATA_DIR/secrets/streams.json), NOT in the replicated DB.

import readline from 'readline'
import { Writable } from 'stream'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  evaluateFull, randomSalt, deriveVerifier, wrapKeyFrom, wrap,
  userKeyPair, sealTo, authKeyPair
} from '@aliran/core'
import { config } from './config.js'
import { initKeys, openKeys } from './keys.js'
import { openStore, argonOpts, loadSecrets, saveSecrets } from './store.js'

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
  const { store, db } = await openStore(config.dataDir, keys)
  const done = async () => { await store.close() }

  switch (cmd) {
    case 'create-user': {
      const username = pos[0]; if (!username) return usage(await done())
      const password = await needPassword(username, opts)
      const rwd = evaluateFull(keys.oprf, password)
      const salt = randomSalt()
      const argon = argonOpts(config)
      const kp = userKeyPair()
      const auth = authKeyPair()
      const wk = wrapKeyFrom(rwd)
      const record = {
        salt: b4a.toString(salt, 'hex'),
        verifier: b4a.toString(deriveVerifier(rwd, salt, argon), 'hex'),
        argon,
        pub: b4a.toString(kp.publicKey, 'hex'),
        encPriv: wrap(wk, kp.secretKey),
        authPub: b4a.toString(auth.publicKey, 'hex'),
        authPrivEnc: wrap(wk, auth.secretKey),
        wrapped: {},
        devices: [],
        tokenVersion: 1,
        maxDevices: config.maxDevicesDefault,
        status: 'active'
      }
      await db.put('user/' + username, record)
      console.log(`Created user "${username}".`)
      break
    }

    case 'set-password': {
      const username = pos[0]; if (!username) return usage(await done())
      const node = await db.get('user/' + username)
      if (!node) { console.error('No such user:', username); break }
      const user = node.value
      const password = await needPassword(username, opts)
      const rwd = evaluateFull(keys.oprf, password)
      const salt = randomSalt()
      const argon = argonOpts(config)
      const kp = userKeyPair()
      const auth = authKeyPair()
      const wk = wrapKeyFrom(rwd)
      // Re-seal existing grants to the new keypair (admin has the stream secrets).
      const secrets = loadSecrets(config.dataDir)
      const wrapped = {}
      for (const streamId of Object.keys(user.wrapped || {})) {
        const encKeyHex = secrets[streamId]
        if (encKeyHex) wrapped[streamId] = sealTo(kp.publicKey, b4a.from(encKeyHex, 'hex'))
      }
      user.salt = b4a.toString(salt, 'hex')
      user.verifier = b4a.toString(deriveVerifier(rwd, salt, argon), 'hex')
      user.argon = argon
      user.pub = b4a.toString(kp.publicKey, 'hex')
      user.encPriv = wrap(wk, kp.secretKey)
      user.authPub = b4a.toString(auth.publicKey, 'hex')
      user.authPrivEnc = wrap(wk, auth.secretKey)
      user.wrapped = wrapped
      user.devices = []
      user.tokenVersion = (user.tokenVersion || 1) + 1 // invalidate old sessions
      await db.put('user/' + username, user)
      console.log(`Password updated for "${username}" (re-sealed ${Object.keys(wrapped).length} grant(s)).`)
      break
    }

    case 'add-stream': {
      const id = pos[0]; if (!id) return usage(await done())
      const secrets = loadSecrets(config.dataDir)
      const encKeyHex = (opts.key && opts.key !== true) ? String(opts.key) : b4a.toString(crypto.randomBytes(32), 'hex')
      secrets[id] = encKeyHex
      saveSecrets(config.dataDir, secrets)
      const catalog = {
        title: opts.title && opts.title !== true ? String(opts.title) : id,
        description: opts.description && opts.description !== true ? String(opts.description) : '',
        category: opts.category && opts.category !== true ? [String(opts.category)] : [],
        type: 'live',
        protection: 'self',
        feedKey: opts.feed && opts.feed !== true ? String(opts.feed) : null,
        isLive: false,
        poster: null, backdrop: null, logo: null,
        status: opts.feed ? 'live' : 'idle'
      }
      await db.put('catalog/' + id, catalog)
      console.log(`Registered stream "${id}".`)
      console.log('  feedKey:', catalog.feedKey || '(set later with set-meta --feed)')
      console.log('  encKey :', encKeyHex, '(private; give to the broadcaster)')
      break
    }

    case 'grant': {
      const [username, streamId] = pos; if (!username || !streamId) return usage(await done())
      const node = await db.get('user/' + username)
      if (!node) { console.error('No such user:', username); break }
      const secrets = loadSecrets(config.dataDir)
      const encKeyHex = secrets[streamId]
      if (!encKeyHex) { console.error('No secret for stream:', streamId, '(add-stream first)'); break }
      const user = node.value
      user.wrapped = user.wrapped || {}
      user.wrapped[streamId] = sealTo(b4a.from(user.pub, 'hex'), b4a.from(encKeyHex, 'hex'))
      await db.put('user/' + username, user)
      console.log(`Granted "${username}" access to "${streamId}".`)
      break
    }

    case 'set-meta': {
      const id = pos[0]; if (!id) return usage(await done())
      const node = await db.get('catalog/' + id)
      if (!node) { console.error('No such stream:', id); break }
      const c = node.value
      for (const f of ['title', 'description', 'feed', 'poster', 'backdrop', 'logo', 'status']) {
        if (opts[f] != null && opts[f] !== true) c[f === 'feed' ? 'feedKey' : f] = String(opts[f])
      }
      if (opts.category && opts.category !== true) c.category = [String(opts.category)]
      if (opts.live != null) c.isLive = opts.live === true || /^(1|true|yes)$/i.test(opts.live)
      await db.put('catalog/' + id, c)
      console.log(`Updated metadata for "${id}".`)
      break
    }

    case 'set-max-devices': {
      const [username, n] = pos; if (!username || !n) return usage(await done())
      const node = await db.get('user/' + username); if (!node) { console.error('No such user'); break }
      node.value.maxDevices = parseInt(n, 10)
      await db.put('user/' + username, node.value)
      console.log(`maxDevices for "${username}" = ${node.value.maxDevices}`)
      break
    }

    case 'logout-all': {
      const username = pos[0]; if (!username) return usage(await done())
      const node = await db.get('user/' + username); if (!node) { console.error('No such user'); break }
      node.value.tokenVersion = (node.value.tokenVersion || 1) + 1
      node.value.devices = []
      await db.put('user/' + username, node.value)
      console.log(`All sessions revoked for "${username}" (tokenVersion=${node.value.tokenVersion}).`)
      break
    }

    case 'list': {
      for await (const { key, value } of db.createReadStream()) {
        if (key.startsWith('user/')) console.log(key, '->', JSON.stringify({ status: value.status, grants: Object.keys(value.wrapped || {}), maxDevices: value.maxDevices }))
        else console.log(key, '->', JSON.stringify({ title: value.title, feedKey: value.feedKey, isLive: value.isLive, status: value.status }))
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
  add-stream <id> [--feed <hex>] [--key <hex>] [--title T] [--category C]
  grant <u> <streamId>                  Entitle a user to a stream
  set-meta <id> [--title --feed --live --poster ...]
  set-max-devices <u> <n>               Concurrent device limit
  logout-all <u>                        Revoke all sessions
  list                                  List users and streams
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
