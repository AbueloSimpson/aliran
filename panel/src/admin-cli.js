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
import { pairingCode } from '@aliran/core'
import { writeFileAtomic } from '@aliran/core/atomic-write.js'
import { config } from './config.js'
import { initKeys, openKeys } from './keys.js'
import { sealEscrow, openEscrow, verifyBundle, checkEnvelope, serializeEscrow, MIN_PASSPHRASE } from './escrow.js'
import { openStore } from './store.js'
import * as ops from './ops.js'
import * as sources from './sources.js'
import * as packages from './packages.js'
import { makeReports } from './reports.js'
import { makeNotifier } from './notify.js'

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

// "hm=1,hs=2" -> { hm: '1', hs: '2' }; "" -> {}. Values may contain '=' (split once).
function parseKeyVals (s) {
  const out = {}
  for (const pair of String(s).split(',')) {
    const t = pair.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i < 1) { console.error(`Bad param "${t}" — expected key=value.`); process.exit(1) }
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, opts } = parseArgs(rest)

  if (cmd === 'init') {
    const { publicKeyHex, publisherSecretHex } = initKeys(config.dataDir)
    console.log('Panel initialized.')
    console.log('Panel public key (give to clients):\n  ' + publicKeyHex)
    // The same key in the form a viewer can actually type on a TV remote. Derived, so
    // it is available the moment the keypair exists — no panel boot needed.
    console.log('Service pairing code (viewers type this instead):\n  ' + pairingCode(publicKeyHex))
    console.log('Publisher key (put in the broadcaster .env as PUBLISHER_KEY):\n  ' + publisherSecretHex)
    console.log('Keys are in ' + config.dataDir + '/keys (gitignored — BACK UP).')
    return
  }

  // verify-escrow runs BEFORE requireKeys on purpose: its whole point is to work on a
  // machine that is not the panel — an operator's laptop, a recovery box, anywhere
  // Node runs. No DATA_DIR, no store, no swarm. It therefore cannot become a second
  // writer for the same identity, which the never-two-writers rule makes strictly
  // worse than downtime (docs/kb/backup-and-rotation.md).
  if (cmd === 'verify-escrow') {
    const file = pos[0]
    if (!file) return usage()
    let env
    try {
      env = checkEnvelope(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      console.error('Cannot read this escrow file: ' + (err.message || err))
      process.exit(1)
    }
    // The fingerprint is cleartext, so print it BEFORE asking for anything. An
    // operator holding several files finds the right one without typing a passphrase.
    console.log('Escrow file:      ' + path.resolve(file))
    console.log('Created:          ' + env.createdAt)
    console.log('Service:          ' + (env.fingerprint.serviceName || '(not set)'))
    console.log('Panel public key: ' + env.fingerprint.panelPublicKey)
    console.log('Pairing code:     ' + env.fingerprint.pairingCode)
    console.log('Sealed files:     ' + env.fingerprint.files.map((f) => `${f.name} (${f.bytes} B)`).join(', '))
    console.log('KDF:              argon2id, ' + Math.round(env.kdf.memlimit / 1048576) + ' MiB, ' + env.kdf.opslimit + ' ops')
    console.log('')

    const passphrase = str(opts.passphrase) ?? await promptHidden('Escrow passphrase: ')
    let opened
    try {
      opened = await openEscrow({ envelope: env, passphrase })
    } catch (err) {
      console.error('FAILED: ' + (err.message || err))
      process.exit(1)
    }
    const result = verifyBundle(opened.files, env.fingerprint)
    for (const c of result.checks) console.log(` ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
    console.log('')
    if (!result.ok) {
      console.error('VERIFY FAILED — do not rely on this copy. Export a new one.')
      process.exit(1)
    }
    console.log('VERIFIED — this file decrypts and holds the identity its fingerprint names.')

    // Extraction is a separate, explicit flag into an EMPTY directory. Escrow with no
    // way out is not a backup, but writing straight into a live DATA_DIR is how a
    // deployment ends up with two panels signing under one identity.
    const to = str(opts['restore-to'])
    if (to) {
      if (fs.existsSync(to) && fs.readdirSync(to).length) {
        console.error(`\nRefusing to write into ${to}: the directory is not empty.`)
        process.exit(1)
      }
      fs.mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const [name, content] of Object.entries(opened.files)) {
        // Atomic per file: a crash here must never leave a TRUNCATED key on disk. A
        // half-written signing key or OPRF key reads as a valid file and locks every
        // viewer out; an absent one is obvious and the restore can simply be re-run.
        writeFileAtomic(path.join(to, name), content, { mode: 0o600 })
      }
      console.log('\nWrote ' + Object.keys(opened.files).length + ' key files to ' + path.resolve(to))
      console.log('STOP before you use them. Only ONE panel may ever run with this identity.')
      console.log('Confirm the old panel is stopped and cannot restart, then move these files')
      console.log('into that deployment\'s DATA_DIR/keys/.')
    }
    return
  }

  const keys = requireKeys()

  // Encrypted identity escrow (src/escrow.js). This path needs shell access on the
  // box, so it changes no attacker's economics and is always available — unlike the
  // admin-API export, which is off unless ESCROW_EXPORT=1.
  if (cmd === 'export-escrow') {
    const kdf = { opslimit: config.escrow.argon2.ops, memlimit: config.escrow.argon2.memMiB * 1048576 }
    // Check the destination FIRST. Everything below is a passphrase prompt and a
    // deliberately slow KDF, and none of it should be spent to then hit ENOENT.
    const outPath = str(opts.out)
    if (outPath) {
      if (fs.existsSync(outPath)) {
        console.error(`Refusing to overwrite ${outPath}. Pass --out <file> with a new name.`)
        process.exit(1)
      }
      const outDir = path.dirname(path.resolve(outPath))
      if (!fs.existsSync(outDir)) {
        console.error(`No such directory: ${outDir}. Create it first.`)
        process.exit(1)
      }
    }
    let passphrase = str(opts.passphrase)
    if (passphrase) {
      console.log('Note: --passphrase puts the passphrase in your shell history. Prefer the prompt.')
    } else {
      console.log(`Choose an escrow passphrase (minimum ${MIN_PASSPHRASE} characters).`)
      console.log('This passphrase is the ONLY protection on the exported file. Five or six')
      console.log('random words beat one clever word. Store it apart from the file itself.')
      passphrase = await promptHidden('Escrow passphrase: ')
      if (passphrase !== await promptHidden('Repeat passphrase:  ')) {
        console.error('The two passphrases are different. Nothing was written.')
        process.exit(1)
      }
    }

    console.log(`\nDeriving the file key (argon2id, ${config.escrow.argon2.memMiB} MiB, ${config.escrow.argon2.ops} ops) — this takes a moment…`)
    const { envelope, fingerprint, filename } = await sealEscrow({
      dataDir: config.dataDir,
      passphrase,
      serviceName: config.serviceName,
      kdf
    })
    // Prove the file before it exists on disk: open it again with the same passphrase
    // and check the identity inside. An untested escrow copy is a hope, not a backup.
    const opened = await openEscrow({ envelope, passphrase })
    const result = verifyBundle(opened.files, fingerprint)
    for (const c of result.checks) console.log(` ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
    if (!result.ok) {
      console.error('\nThe file failed its own verification. Nothing was written. This is a bug — report it.')
      process.exit(1)
    }

    const out = outPath || filename
    if (fs.existsSync(out)) {
      console.error(`\nRefusing to overwrite ${out}. Pass --out <file> with a new name.`)
      process.exit(1)
    }
    // Atomic: a partially written escrow file is a backup that cannot be restored from,
    // and the "refusing to overwrite" guard above would then block a retry at the same
    // path. Either the whole envelope lands or nothing does, so re-running always works.
    writeFileAtomic(out, serializeEscrow(envelope), { mode: 0o600 })
    console.log('\nWrote ' + path.resolve(out))
    console.log('  Panel public key: ' + fingerprint.panelPublicKey)
    console.log('  Pairing code:     ' + fingerprint.pairingCode)
    console.log('  Sealed files:     ' + fingerprint.files.map((f) => f.name).join(', '))
    console.log('\nNow move it OFF this box. A copy that stays here protects you from nothing.')
    console.log('Then prove the copy at its destination:')
    console.log('  node src/admin-cli.js verify-escrow <the-copy>')
    return
  }

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

  // Remote channel sources (S27). Registry edits touch only DATA_DIR/sources.json —
  // no store, safe beside a running panel (which picks changes up on its next tick).
  // sync-source / remove-source need the store: run them with the panel STOPPED, or
  // use the admin API / dashboard against the live panel instead.
  if (cmd === 'add-source') {
    const [name, url] = pos; if (!name || !url || !opts.category) return usage()
    const s = sources.addSource({ config, keys, dataDir: config.dataDir }, name, {
      url,
      format: str(opts.format),
      category: str(opts.category),
      prefix: str(opts.prefix),
      groups: opts.groups != null && opts.groups !== true ? String(opts.groups) : undefined, // comma group-titles (m3u)
      intervalMs: opts['interval-hours'] != null ? Math.round(parseFloat(opts['interval-hours']) * 3600000) : undefined,
      autoGrant: opts['auto-grant'] != null ? opts['auto-grant'] : undefined,
      allowCleartext: opts['allow-cleartext'] != null ? opts['allow-cleartext'] : undefined, // let this source import http:// stream urls
      enabled: opts.disabled === true ? false : undefined
    })
    console.log(`Added ${s.format} source "${name}" → category "${s.category}" (prefix "${s.prefix}", every ${Math.round(s.intervalMs / 3600000 * 10) / 10}h, autoGrant ${s.autoGrant}` +
      ((s.groups || []).length ? `, groups: ${s.groups.join(', ')}` : '') + ').')
    console.log('The running panel syncs it on its next tick; for an immediate pull use the dashboard "Sync now" or sync-source (panel stopped).')
    return
  }
  if (cmd === 'list-sources') {
    const all = sources.loadSources(config.dataDir)
    if (Object.keys(all).length === 0) console.log('(no sources)')
    for (const [name, s] of Object.entries(all)) {
      console.log(name, '->', JSON.stringify({
        url: s.url, format: s.format || 'json', category: s.category, prefix: s.prefix, groups: s.groups || null,
        enabled: s.enabled !== false, autoGrant: s.autoGrant !== false,
        lastSync: s.lastSync ? new Date(s.lastSync).toISOString() : null, lastError: s.lastError || null, lastReport: s.lastReport || null
      }))
    }
    return
  }
  if (cmd === 'set-source') {
    const name = pos[0]; if (!name) return usage()
    const s = sources.setSource({ config, keys, dataDir: config.dataDir }, name, {
      url: str(opts.url),
      format: str(opts.format),
      category: str(opts.category),
      prefix: str(opts.prefix),
      intervalMs: opts['interval-hours'] != null ? Math.round(parseFloat(opts['interval-hours']) * 3600000) : undefined,
      autoGrant: opts['auto-grant'] != null ? opts['auto-grant'] : undefined,
      allowCleartext: opts['allow-cleartext'] != null ? opts['allow-cleartext'] : undefined, // flip the http:// exemption for this source
      enabled: opts.enabled != null ? opts.enabled : undefined,
      exclude: opts.exclude != null && opts.exclude !== true ? String(opts.exclude) : undefined, // comma feed-ids; '' clears
      groups: opts.groups != null && opts.groups !== true ? String(opts.groups) : undefined // comma group-titles; '' takes every group
    })
    console.log(`Updated ${s.format || 'json'} source "${name}" (category "${s.category}", enabled ${s.enabled !== false}` +
      ((s.exclude || []).length ? `, ${s.exclude.length} excluded` : '') +
      ((s.groups || []).length ? `, groups: ${s.groups.join(', ')}` : '') + '). Changes apply on its next sync.')
    return
  }

  // Viewer problem reports (S50). The store re-reads DATA_DIR/reports/ per operation
  // and needs no Corestore, so these verbs work BESIDE a running panel — that is the
  // point (an operator triaging reports should not have to stop the service).
  // Two honest limits:
  //   - a live panel holds alerts.json in memory and flushes it lazily, so
  //     `list-alerts` here can be up to a few seconds stale (and there is
  //     deliberately no CLI alert ack/resolve: the live panel's next flush would
  //     overwrite it — use the dashboard/API for those).
  //   - `test-notify` reads the same REPORTS_* env this shell has, so run it with
  //     the panel's .env loaded or it will report "no targets configured".
  if (cmd === 'list-reports' || cmd === 'ack-report' || cmd === 'resolve-report' || cmd === 'list-alerts') {
    const reports = makeReports({ dataDir: config.dataDir, retentionDays: config.reports.retentionDays })
    if (!reports.enabled) {
      console.log('Viewer reports are DISABLED (REPORTS_RETENTION_DAYS=0) — nothing is collected.')
      return
    }
    if (cmd === 'list-reports') {
      const rows = reports.list({
        status: str(opts.status),
        channel: str(opts.channel),
        category: str(opts.category),
        limit: opts.limit != null ? String(opts.limit) : 50
      })
      if (!rows.length) console.log('(no reports)')
      for (const r of rows) {
        console.log(r.id, '->', JSON.stringify({
          at: new Date(r.lastAt || r.at).toISOString(),
          status: r.status,
          category: r.category,
          channel: r.channel,
          count: r.count,
          reporter: r.reporter, // a pseudonym — never a username or device id
          platform: r.platform,
          appVersion: r.appVersion,
          peers: r.peers,
          text: r.text
        }))
      }
      reports.close()
      return
    }
    if (cmd === 'list-alerts') {
      const rows = reports.listAlerts({ status: str(opts.status) })
      if (!rows.length) console.log('(no alerts)')
      for (const a of rows) {
        console.log(a.id, '->', JSON.stringify({
          opened: new Date(a.openedAt).toISOString(),
          last: new Date(a.lastAt || a.openedAt).toISOString(),
          status: a.status,
          kind: a.kind,
          channel: a.channel,
          reporters: (a.reportersCapped ? '>=' : '') + a.reporters,
          categories: a.categories,
          shed: a.shedCount || 0,
          sampled: a.sampled || 0
        }))
      }
      console.log('(a running panel flushes alerts lazily — this view can be a few seconds behind)')
      reports.close()
      return
    }
    const id = pos[0]; if (!id) { reports.close(); return usage() }
    const out = cmd === 'ack-report' ? reports.ack(id) : reports.resolve(id, pos.slice(1).join(' ') || str(opts.note))
    reports.close()
    if (!out.ok) { console.error(`No report "${id}" (${out.error}).`); process.exitCode = 1; return }
    console.log(`Report "${id}" is now ${out.report.status}` + (out.report.note ? ` — note: ${out.report.note}` : '') + '.')
    return
  }

  if (cmd === 'test-notify') {
    const notifier = makeNotifier({
      webhookUrl: config.reports.webhookUrl,
      telegramBotToken: config.reports.telegramBotToken,
      telegramChatId: config.reports.telegramChatId
    })
    if (!notifier.enabled) {
      console.log('No ops notification targets configured. Set REPORTS_WEBHOOK_URL and/or REPORTS_TELEGRAM_BOT_TOKEN + REPORTS_TELEGRAM_CHAT_ID in the panel .env.')
      return
    }
    console.log(`Sending a test notification to: ${notifier.targets.join(', ')} …`)
    const out = await notifier.test()
    for (const r of out.results) {
      console.log(r.ok ? `  ${r.target}: OK (HTTP ${r.status}, ${r.attempts} attempt(s))` : `  ${r.target}: FAILED after ${r.attempts} attempt(s) — ${r.error}`)
    }
    notifier.close()
    if (out.results.some((r) => !r.ok)) process.exitCode = 1
    return
  }

  const { store, db, assets } = await openStore(config.dataDir, keys)
  const ctx = { config, keys, db, assets, dataDir: config.dataDir }
  const done = async () => { await store.close() }

  switch (cmd) {
    case 'create-user': {
      const username = pos[0]; if (!username) return usage(await done())
      await ops.createUser(ctx, username, await needPassword(username, opts))
      const autoGranted = await sources.grantSourcesToUser(ctx, username).catch(() => 0) // best-effort (S27); next sync reconciles
      // Default packages (S44) — best-effort like the source hook; the next reconcile converges any miss.
      const withDefaults = await packages.applyDefaultPackages(ctx, username).catch(() => null)
      console.log(`Created user "${username}".` + (autoGranted ? ` Auto-granted ${autoGranted} source channel(s).` : '') +
        (withDefaults ? ` Default package(s): ${withDefaults.packages.join(', ')}.` : ''))
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
      await packages.reconcilePackages(ctx) // converge package selector state after the purge (S44)
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
      const rec = await packages.reconcilePackages(ctx) // a glob/category member may cover the new id (S44)
      console.log(`Registered stream "${id}".`)
      console.log('  feedKey:', catalog.feedKey || '(set later with set-meta --feed)')
      console.log('  encKey :', encryptionKey, '(private; give to the broadcaster)')
      if (rec.sealed) console.log(`  packages: sealed for ${rec.users} package-holding user(s)`)
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
      // Revoke removes the MANUAL entitlement (S44) — a package that still covers
      // the id re-seals it in this reconcile; say so instead of lying "revoked".
      await packages.reconcilePackages(ctx, { onlyUser: username })
      const after = await ops.getUser(ctx, username)
      if (after.grants.includes(streamId)) {
        console.log(`Removed the manual grant, but "${username}" still has "${streamId}" via package(s): ${after.packages.join(', ')} — remove the package or edit its members.`)
      } else {
        console.log(`Revoked "${username}" access to "${streamId}". (Full revocation of live content needs a stream-key rotation.)`)
      }
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
        featured: opts.featured != null ? opts.featured : undefined,
        restricted: opts.restricted != null ? opts.restricted : undefined,
        epgUrl: opts['epg-url'] != null ? str(opts['epg-url']) || '' : undefined, // '' clears
        epgId: opts['epg-id'] != null ? str(opts['epg-id']) || '' : undefined
      })
      if (opts.category != null) await packages.reconcilePackages(ctx) // retag moves the id across category: members (S44)
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

    case 'list-categories': {
      const rows = await ops.listCategories(ctx)
      if (!rows.length) { console.log('(no categories in use)'); break }
      for (const c of rows) {
        console.log(`${c.slug.padEnd(28)} ${String(c.channels).padStart(4)} ch  ` +
          `${c.label !== c.slug ? 'label="' + c.label + '" ' : ''}` +
          `${c.order != null ? 'order=' + c.order + ' ' : ''}` +
          `${c.hidden ? 'HIDDEN ' : ''}${c.registered ? '' : '(unregistered)'}`)
      }
      break
    }

    case 'rename-category': {
      const [from, to] = pos; if (!from || !to) return usage(await done())
      const r = await ops.renameCategory(ctx, from, to)
      await packages.reconcilePackages(ctx) // retagged channels move across category: members (S44)
      console.log(`Renamed "${r.from}" → "${r.to}": ${r.channels} channel(s), ${r.registry} registry entr${r.registry === 1 ? 'y' : 'ies'}.`)
      console.log('Note: children of a parent move with it. A SOURCE-owned rail is reasserted on the next sync — rename the source instead (set-source --category).')
      break
    }

    case 'merge-categories': {
      const to = opts.into; const from = pos
      if (!from.length || !to) return usage(await done())
      const r = await ops.mergeCategories(ctx, from, to)
      await packages.reconcilePackages(ctx) // retagged channels move across category: members (S44)
      console.log(`Merged ${r.from.map((f) => '"' + f + '"').join(', ')} → "${r.to}": ${r.channels} channel(s) retagged, ${r.registry} registry entr${r.registry === 1 ? 'y' : 'ies'} dropped.`)
      break
    }

    // Channel packages / bouquets (S44). These need the store (every change
    // materializes into sealed grants): run them with the panel STOPPED, or use
    // the dashboard Packages tab / admin API against the live panel instead.
    case 'add-package': {
      const name = pos[0]; if (!name) return usage(await done())
      const p = await packages.addPackage(ctx, name, {
        label: str(opts.label),
        members: str(opts.members),
        default: opts.default != null ? opts.default : undefined
      })
      console.log(`Added package "${name}" (label "${p.label}", ${p.members.length} member(s)${p.default ? ', DEFAULT for new users' : ''}).`)
      console.log('Members:', p.members.length ? p.members.join(', ') : '(none yet — set-package --members)')
      break
    }

    case 'set-package': {
      const name = pos[0]; if (!name) return usage(await done())
      const p = await packages.setPackage(ctx, name, {
        label: str(opts.label),
        members: opts.members != null && opts.members !== true ? String(opts.members) : undefined, // '' clears
        default: opts.default != null ? opts.default : undefined
      })
      console.log(`Updated package "${name}" (${p.members.length} member(s)${p.default ? ', DEFAULT' : ''}): sealed ${p.reconciled.sealed}, removed ${p.reconciled.removed} grant(s) across ${p.reconciled.users} user(s).`)
      break
    }

    case 'list-packages': {
      const rows = await packages.listPackages(ctx)
      if (!rows.length) { console.log('(no packages)'); break }
      for (const p of rows) {
        console.log(p.name, '->', JSON.stringify({
          label: p.label, members: p.members, default: !!p.default, resolves: p.resolved.length, holders: p.holders
        }))
      }
      break
    }

    case 'show-package': {
      const name = pos[0]; if (!name) return usage(await done())
      const p = await packages.getPackage(ctx, name)
      console.log(`${p.name} — "${p.label}"${p.default ? ' (DEFAULT for new users)' : ''}, ${p.holders} holder(s)`)
      console.log('  members :', p.members.length ? p.members.join(', ') : '(none)')
      console.log(`  resolves: ${p.resolved.length} channel(s)` + (p.resolved.length ? ' — ' + p.resolved.join(', ') : ''))
      break
    }

    case 'remove-package': {
      const name = pos[0]; if (!name) return usage(await done())
      const r = await packages.removePackage(ctx, name)
      console.log(`Removed package "${name}": ${r.reconciled.removed} grant(s) removed across ${r.reconciled.users} user record(s) (manual grants and other packages survive).`)
      break
    }

    case 'set-user-packages': {
      const [username, list] = pos; if (!username || list == null) return usage(await done())
      const u = await packages.setUserPackages(ctx, username, list === '""' || list === "''" ? '' : list)
      console.log(`Packages for "${username}" = ${u.packages.length ? u.packages.join(', ') : '(none)'} — ${u.grants.length} effective grant(s).`)
      break
    }

    case 'sync-source': {
      const name = pos[0]; if (!name) return usage(await done())
      const r = await sources.syncSource(ctx, name)
      console.log(`Synced source "${name}" in ${r.ms}ms: +${r.added} added, ~${r.updated} updated, -${r.removed} removed` +
        (r.notModified ? ' (feed not modified)' : '') + `, ${r.granted} grant(s) sealed.`)
      if (r.conflicts?.length) console.log('  conflicts (ids owned by manual channels/another source, skipped):', r.conflicts.join(', '))
      if (r.skippedCount) console.log(`  skipped ${r.skippedCount} invalid feed entr${r.skippedCount === 1 ? 'y' : 'ies'}:`, r.skipped.map((s) => `${s.id} (${s.reason})`).join(', '))
      if (r.truncated) console.log(`  truncated ${r.truncated} entr${r.truncated === 1 ? 'y' : 'ies'} beyond the channel cap`)
      break
    }

    case 'remove-source': {
      const name = pos[0]; if (!name) return usage(await done())
      const r = await sources.removeSource(ctx, name, { keepChannels: opts['keep-channels'] === true })
      console.log(`Removed source "${name}": ` + (r.detached
        ? `${r.detached} channel(s) detached (they live on as manual redirect channels).`
        : `${r.removed} channel(s) purged (catalog + keys + grants + art).`))
      break
    }

    // External VOD provider (S53). The record lives in the replicated bee, so these
    // need the store: run them with the panel STOPPED, or use the dashboard Sources
    // tab / the admin API against the live panel instead.
    case 'vod-config': {
      const v = await ops.getVodConfig(ctx)
      if (!v) { console.log('No VOD provider configured (viewers see no VOD section).'); break }
      console.log(JSON.stringify(v, null, 2))
      if (!v.enabled) console.log('(disabled — viewers see no VOD section until --enabled true)')
      break
    }

    case 'vod-config-set': {
      const patch = {}
      if (opts.enabled != null) patch.enabled = opts.enabled
      if (opts['api-base'] != null) patch.apiBase = opts['api-base'] === true ? '' : String(opts['api-base'])
      if (opts.service != null) patch.service = opts.service === true ? '' : String(opts.service)
      // Per-kind source values MERGE onto what is stored (the API replaces the whole
      // map, so the CLI reads it back first) — editing the series source must not
      // silently drop the movies one. A bare flag ("--movies-source" with no value)
      // clears that kind.
      for (const kind of ['movies', 'series']) {
        if (opts[`${kind}-source`] == null) continue
        const cur = patch.sources !== undefined ? patch.sources : ((await ops.getVodConfig(ctx)) || {}).sources || {}
        const val = opts[`${kind}-source`] === true ? '' : String(opts[`${kind}-source`])
        patch.sources = { ...cur, [kind]: val }
        if (!val) delete patch.sources[kind]
      }
      // --params replaces the whole map ("" clears it); --param k=v merges ONE key onto
      // whatever is stored (the common "add hs=2" edit without retyping the rest).
      if (opts.params != null) {
        patch.params = parseKeyVals(opts.params === true ? '' : String(opts.params))
      }
      if (opts.param != null && opts.param !== true) {
        const one = parseKeyVals(String(opts.param))
        const cur = patch.params !== undefined ? patch.params : ((await ops.getVodConfig(ctx)) || {}).params || {}
        patch.params = { ...cur, ...one }
      }
      if (Object.keys(patch).length === 0) return usage(await done())
      const v = await ops.setVodConfig(ctx, patch)
      console.log(`VOD provider ${v.enabled ? 'ENABLED' : 'disabled'} -> ` + JSON.stringify({ apiBase: v.apiBase, service: v.service, sources: v.sources, params: v.params }))
      console.log('Viewers pick this up at their NEXT login (the record is read there, not watched).')
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
  export-escrow [--out <file>]          Export DATA_DIR/keys/ ENCRYPTED under a passphrase you
                                        type here. This is the only supported way to get the
                                        identity off the box. The file verifies itself before
                                        it is written. Move it off this box afterwards.
  verify-escrow <file> [--restore-to <empty-dir>]
                                        Prove an escrow file decrypts and holds the identity its
                                        fingerprint names. Needs NO panel and no DATA_DIR — run
                                        it wherever the copy lives. --restore-to extracts the key
                                        files into an EMPTY directory; only one panel may ever
                                        run with an identity, so move them by hand from there.
  create-user <u> [--password <pw>]     Create a user (OPRF-enrolled)
  set-password <u> [--password <pw>]    Rotate password (re-seals grants, revokes sessions)
  set-status <u> <active|disabled>      Disable/re-enable an account (disable revokes sessions)
  delete-user <u>                       Delete the account record entirely
  add-stream <id> [--feed <hex>] [--key <hex>] [--title T] [--category C]
  delete-stream <id>                    FULL purge: catalog + private key + grants + art
  grant <u> <streamId>                  Entitle a user to a stream
  revoke <u> <streamId>                 Remove an entitlement
  set-meta <id> [--title --feed --live --order <n|null> --featured [true|false] --restricted [true|false] --poster ...]
                                        (--restricted marks the channel access-controlled: players ask for the parental PIN)
                                        (art fields take an 'assets/…' path or an https:// URL; '' clears)
                [--epg-url https://…/guide.json --epg-id <id-in-that-feed>]  Attach a program guide ('' clears)
  set-max-devices <u> <n>               Concurrent device limit
  list-devices <u>                      Show a user's enrolled devices
  logout-device <u> <deviceId>          Drop one device enrollment (no tokenVersion bump)
  logout-all <u>                        Revoke all sessions
  list                                  List users and streams
  add-admin <name> [--password <pw>]    Create an admin for the HTTP admin API (min 8 chars)
  remove-admin <name>                   Delete an admin account
  set-admin-password <name> [--password <pw>]   Rotate an admin password (revokes their sessions)
  list-admins                           List admin accounts
  add-publisher <name> [--scopes "east-*,sports-1"]   Enroll a broadcaster site: per-site keypair
                                        (secret printed ONCE) + streamId-glob channel scopes
  list-publishers                       List enrolled publishers
  set-publisher-scopes <name> <globs>   Replace a publisher's channel scopes (comma-separated)
  set-publisher-status <name> <active|revoked>   Revoke/re-activate a publisher's key
  remove-publisher <name>               Hard-delete a publisher (revoke keeps the audit trail)
  add-source <name> <url> --category <label> [--format json|m3u] [--groups "Live Events,PPV"]
                          [--prefix p.] [--interval-hours N] [--auto-grant false] [--allow-cleartext] [--disabled]
                                        Register a remote channel feed as a category. --format m3u reads an M3U
                                        playlist: ids come from the channel names, #EXTVLCOPT lines import as
                                        playback headers, and --groups picks the group-titles to take (blank = all).
                                        Point several sources at ONE playlist, each with its own groups, category
                                        and prefix, to split a mixed list into the right rails.
                                        --allow-cleartext lets THIS source import http:// (non-TLS) stream urls;
                                        off by default, and manual channels are never affected. http only plays
                                        where the client permits cleartext.
  list-sources                          List channel sources + last sync state
  set-source <name> [--url --format --category --prefix --interval-hours --auto-grant --allow-cleartext true|false
                     --enabled true|false --exclude "feedId1,feedId2" --groups "Live Events"]
                                        (--exclude DESELECTS feed entries: removed + skipped every sync; "" re-includes all)
                                        (--groups filters an m3u by group-title; "" takes every group)
                                        (--allow-cleartext true lets this source import http:// stream urls; source-scoped)
  list-categories                       Category vocabulary in use + per-category channel counts
  rename-category <from> <to>           Rename a rail; children of a parent move with it
  merge-categories <a> <b> … --into <c> Retag several categories onto one
  add-package <name> [--label L] [--members "news-24,sports-*,category:Deportes,source:anime"] [--default]
                                        Define a channel package (bouquet); members are stream ids,
                                        id globs, and category:/source: selectors resolved at reconcile
  set-package <name> [--label --members "…" --default true|false]   Edit a package ("" clears members)
  list-packages / show-package <name>   Packages + counts / one package with its resolved channels
  remove-package <name>                 Remove a package (grants it alone covered are removed)
  set-user-packages <u> <p1,p2|"">      Replace a user's packages ("" clears) — seals/removes immediately
                                        (package commands need the store: panel stopped, or use the dashboard)
  vod-config                            Show the external VOD provider record (svcmeta/vod)
  vod-config-set [--enabled true|false] [--api-base https://…/api] [--service X]
                 [--movies-source Y] [--series-source Z] [--params "hm=1,hs=2"] [--param hs=2]
                                        Configure the VOD provider the APPS call directly.
                                        --params replaces the map, --param merges one key;
                                        each --*-source merges its kind ("" clears that kind).
                                        No series source = the apps show movies only.
                                        Enabling needs an apiBase + service; viewers pick the
                                        change up at their NEXT login. (Needs the store: panel
                                        stopped, or use the dashboard/API.)
  sync-source <name>                    Pull + apply the feed NOW (panel stopped — or use the dashboard)
  remove-source <name> [--keep-channels]  Remove a source; purges its channels unless --keep-channels
  list-reports [--status new|ack|resolved] [--channel c] [--category c] [--limit n]
                                        Viewer problem reports (S50) — reporters are 16-hex
                                        pseudonyms; no username or device id is ever stored
  ack-report <id> / resolve-report <id> [note]   Acknowledge / close one report
  list-alerts [--status open|ack|resolved]       Correlation alerts (ack/resolve them in the
                                        dashboard — a live panel would overwrite a CLI write)
  test-notify                           Send a synthetic ops notification through the configured
                                        webhook / Telegram targets (report verbs work beside a
                                        running panel; they touch only DATA_DIR/reports/)
`)
}

main().catch((err) => { console.error(err.message || err); process.exit(1) })
