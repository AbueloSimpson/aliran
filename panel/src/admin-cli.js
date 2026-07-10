#!/usr/bin/env node
// Aliran panel admin CLI. Writes to the single-writer signed account/catalog DB.
//
//   node src/admin-cli.js <command> [args]
//
// This is a SCAFFOLD: `init` is functional; the account/catalog/device commands are
// stubbed with the intended behavior documented inline. See docs/reference.md.

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { config } from './config.js'
import { initKeys, openKeys } from './keys.js'

const [cmd, ...args] = process.argv.slice(2)

async function openDb () {
  const keys = openKeys(config.dataDir)
  if (!keys) throw new Error('Panel not initialized. Run: node src/admin-cli.js init')
  const store = new Corestore(config.dataDir)
  await store.ready()
  const db = new Hyperbee(store.get({ keyPair: keys.signing }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await db.ready()
  return { keys, store, db }
}

async function main () {
  switch (cmd) {
    case 'init': {
      const { publicKeyHex } = initKeys(config.dataDir)
      console.log('Panel initialized.')
      console.log('Panel public key (give this to clients):\n  ' + publicKeyHex)
      console.log('Keys stored in ' + config.dataDir + '/keys (gitignored — BACK UP).')
      break
    }

    case 'create-user': {
      const [username] = args
      if (!username) return usage()
      // TODO: prompt for a password (no echo), then:
      //   salt = random; verifier = Argon2id(OPRF(password), salt)
      //   db.put('user/'+username, { salt, verifier, wrapped:{}, devices:[], tokenVersion:1, status:'active' })
      console.log(`[stub] would create user "${username}" (Argon2id verifier, no plaintext).`)
      break
    }

    case 'set-password': {
      const [username] = args
      if (!username) return usage()
      console.log(`[stub] would rotate password for "${username}".`)
      break
    }

    case 'add-stream': {
      const [id] = args
      if (!id) return usage()
      const encryptionKey = b4a.toString(crypto.randomBytes(32), 'hex')
      // TODO: db.put('catalog/'+id, { title, category, type:'live', protection:'self',
      //   feedKey:null, encryptionKey, isLive:false, status:'idle', ... })
      console.log(`[stub] would register stream "${id}" with encryptionKey ${encryptionKey.slice(0, 12)}…`)
      break
    }

    case 'set-meta':
    case 'upload-art':
    case 'grant':
    case 'revoke':
    case 'set-max-devices':
    case 'list-devices':
    case 'logout-device':
    case 'logout-all':
    case 'unlock':
      console.log(`[stub] "${cmd}" not implemented yet — see docs/reference.md for intended behavior.`)
      break

    case 'list': {
      const { db, store } = await openDb()
      console.log('Users and streams:')
      for await (const { key, value } of db.createReadStream()) {
        console.log('  ' + key, JSON.stringify(value))
      }
      await store.close()
      break
    }

    default:
      usage()
  }
}

function usage () {
  console.log(`Aliran panel admin CLI

Usage: node src/admin-cli.js <command> [args]

  init                          Generate panel signing + OPRF keys
  create-user <username>        Create a user (prompts for password)
  set-password <username>       Rotate a user's password
  grant <username> <streamId>   Entitle a user to a stream
  revoke <username>             Disable a user
  add-stream <id> [--title ...] Register a stream (+ encryption key)
  set-meta <id> ...             Update catalog metadata
  upload-art <id> <kind> <file> Add poster/backdrop/logo to the assets drive
  set-max-devices <u> <n>       Concurrent device limit
  list-devices <u>              List a user's devices
  logout-device <u> <deviceId>  Revoke one device
  logout-all <u>                Revoke all sessions (bump tokenVersion)
  unlock <u>                    Clear brute-force lockout
  list                          List users and streams
`)
  process.exit(1)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
