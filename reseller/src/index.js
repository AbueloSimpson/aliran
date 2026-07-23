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
import { startControlServer } from './control-server.js'

// Nested-aware config merge for tests/embedders: top-level scalars replace, the
// known nested objects merge key-by-key.
function mergeConfig (base, overrides) {
  const out = { ...base, ...overrides }
  for (const k of ['panel', 'control', 'lockout', 'argon2']) {
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

  const control = await startControlServer(ctx, {
    host: config.control.host,
    port: config.control.port,
    sessionTtlMs: config.control.sessionTtlHours * 3600000,
    lockout: config.lockout,
    loginVerifyTimeoutMs: overrides.loginVerifyTimeoutMs
  })

  return {
    config,
    ctx,
    control,
    async close () {
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
