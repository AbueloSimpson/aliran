// Aliran reseller panel — service entry. Same factory shape as library/src/index.js:
// startReseller(overrides) wires the stores + control server (later stages add the
// panel client and sweeps) and resolves once the control server listens; the main
// guard runs it from the CLI with the env config.

import path from 'path'
import { fileURLToPath } from 'url'
import { config as baseConfig } from './config.js'
import { makeMutex } from './store.js'
import { openLedger } from './ledger.js'
import { makePanelClient } from './panel-client.js'
import { makeAccounts } from './accounts.js'
import { makeSweeps } from './sweeps.js'
import { startControlServer } from './control-server.js'
import { addPrincipal, loadPrincipals } from './control-auth.js'
import { initLogging } from './log.js'

initLogging('reseller')

// Nested-aware config merge for tests/embedders: top-level scalars replace, the
// known nested objects merge key-by-key.
function mergeConfig (base, overrides) {
  const out = { ...base, ...overrides }
  for (const k of ['panel', 'control', 'lockout', 'argon2', 'branding', 'webhook']) {
    out[k] = { ...base[k], ...(overrides[k] || {}) }
  }
  return out
}

export async function startReseller (overrides = {}) {
  const config = mergeConfig(baseConfig, overrides)
  const ctx = {
    config,
    dataDir: config.dataDir,
    mutex: makeMutex()
  }
  ctx.ledger = openLedger(config.dataDir)
  ctx.panel = makePanelClient(config)
  ctx.accounts = makeAccounts(ctx)
  ctx.sweeps = makeSweeps(ctx)

  // Managed hosts with an ephemeral filesystem (Render's free plan, most PaaS
  // containers) wipe DATA_DIR on every redeploy, so a root admin seeded once via
  // the CLI would vanish. Seed it from the environment instead: if no root exists
  // and RESELLER_ADMIN_USER/RESELLER_ADMIN_PASS are set, create one now. A no-op
  // once a root is present, so it is safe on every boot.
  const bootUser = process.env.RESELLER_ADMIN_USER
  const bootPass = process.env.RESELLER_ADMIN_PASS
  if (bootUser && bootPass) {
    const existing = Object.values(loadPrincipals(config.dataDir))
    if (!existing.some((p) => p.root)) {
      try {
        addPrincipal(ctx, { username: bootUser, password: bootPass, role: 'admin', root: true, parent: null, createdBy: 'env' })
        console.log(`Seeded root admin "${bootUser}" from RESELLER_ADMIN_USER (no root existed)`)
      } catch (err) {
        // A bad bootstrap value must not take the service down — the health check
        // has to keep answering so the deploy is not marked failed.
        console.error(`RESELLER_ADMIN bootstrap failed (${err.message}); seed a root admin with reseller-cli.js add-admin`)
      }
    }
  }

  const control = await startControlServer(ctx, {
    host: config.control.host,
    port: config.control.port,
    sessionTtlMs: config.control.sessionTtlHours * 3600000,
    lockout: config.lockout,
    trustProxyHeader: config.control.trustProxyHeader,
    loginVerifyTimeoutMs: overrides.loginVerifyTimeoutMs
  })

  // Tests drive the sweeps through the ops routes instead of wall-clock timers.
  if (!overrides.noSweeps) ctx.sweeps.start()

  return {
    config,
    ctx,
    control,
    async close () {
      ctx.sweeps.stop()
      await control.close()
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  startReseller().then(({ config, control }) => {
    console.log(`Reseller control API + UI on http://${control.host}:${control.port} (data: ${config.dataDir})`)
    console.log(`Panel admin API: ${config.panel.url}${config.panel.username ? '' : '  ⚠ PANEL_ADMIN_USER/PASS not set — account operations will fail until configured'}`)
  }).catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
