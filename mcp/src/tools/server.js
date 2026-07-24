// server_* tools — the SSH executor. It runs the documented install/maintenance
// shell sequences on the operator's box over the key in config.ssh. Registered only
// when the config has an `ssh` block.
//
// Secrets move SERVER-SIDE, never through the model: `server_install` runs
// `admin-cli init` (which mints the panel keys), writes the PUBLISHER secret straight
// into the box's broadcaster/.env, and returns only the panel PUBLIC key + a redacted
// summary. The admin passwords used for the dashboards come from the local config
// (the same creds the panel_/broadcaster_ tools log in with) — read from config, never
// passed by the model, never echoed back.

import { z } from 'zod'
import { shq } from '../ssh.js'

const REPO_URL = 'https://github.com/AbueloSimpson/aliran'

// Upsert KEY=VALUE lines in a remote .env (drop any existing line for KEY, append
// the new one). Values are shell-quoted; secrets stay on the box and are never
// returned to the model.
export async function upsertEnv (ssh, remotePath, pairs, opts = {}) {
  const parts = [`touch ${shq(remotePath)}`]
  for (const [k, v] of Object.entries(pairs)) {
    parts.push(`grep -v ${shq('^' + k + '=')} ${shq(remotePath)} > ${shq(remotePath + '.tmp')} 2>/dev/null; mv ${shq(remotePath + '.tmp')} ${shq(remotePath)}`)
    parts.push(`printf '%s\\n' ${shq(k + '=' + v)} >> ${shq(remotePath)}`)
  }
  return ssh.run(parts.join('; '), opts)
}

function parseInitKeys (stdout) {
  const pub = (stdout.match(/Panel public key[^\n]*\n\s*([0-9a-f]{64})/i) || [])[1]
  const publisher = (stdout.match(/Publisher key[^\n]*\n\s*([0-9a-f]{128})/i) || [])[1]
  return { publicKey: pub || null, publisherKey: publisher || null }
}

export function registerServerTools (ctx, h) {
  const { def, ok } = h
  const ssh = ctx.ssh
  const repoDir = ctx.config.install.repoDir
  const profileFlags = ctx.config.install.composeProfiles.map((p) => `--profile ${shq(p)} `).join('')
  const compose = (sub) => `docker compose ${profileFlags}${sub}`

  // ---- read-only diagnostics ----
  def('server_preflight', {
    title: 'Preflight the box',
    description: 'Check the box has docker + compose + ffmpeg + git and reports their versions. Read-only.',
    annotations: { readOnlyHint: true }
  }, async () => {
    const script = [
      'echo "== docker =="; command -v docker >/dev/null 2>&1 && docker --version || echo MISSING',
      'echo "== docker compose =="; docker compose version 2>/dev/null | head -1 || echo MISSING',
      'echo "== ffmpeg =="; command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version 2>/dev/null | head -1 || echo MISSING',
      'echo "== git =="; command -v git >/dev/null 2>&1 && git --version || echo MISSING',
      `echo "== repo =="; [ -d ${shq(repoDir + '/.git')} ] && echo "present at ${repoDir}" || echo "absent (${repoDir})"`
    ].join('; ')
    const r = await ssh.run(script, { allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, report: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_status', {
    title: 'Deployment status',
    description: 'docker compose ps + the deployed git commit for the box. Read-only.',
    annotations: { readOnlyHint: true }
  }, async () => {
    const r = await ssh.run(`${compose('ps')}; echo '== commit =='; git -C ${shq(repoDir)} log --oneline -1 2>/dev/null || echo '(no repo)'`, { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, status: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_logs', {
    title: 'Service logs',
    description: 'docker compose logs (tail). Optional service = panel | broadcaster | library | reseller. Read-only.',
    inputSchema: { service: z.string().optional(), lines: z.number().int().min(1).max(2000).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ service, lines }) => {
    const n = lines || 200
    const r = await ssh.run(compose(`logs --tail ${n} --no-color${service ? ' ' + shq(service) : ''}`), { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, logs: (r.stdout || r.stderr).trim() })
  })

  def('server_disk', {
    title: 'Disk usage',
    description: 'df -h + docker system df on the box, to spot a filling disk. Read-only.',
    annotations: { readOnlyHint: true }
  }, async () => {
    const r = await ssh.run("df -h; echo '== docker =='; docker system df 2>/dev/null || true", { allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, disk: r.stdout.trim() })
  })

  // ---- maintenance ----
  def('server_backup', {
    title: 'Cold backup',
    description: 'Run deploy/backup.sh: cold stop → tar the data volume → start. Briefly pauses NEW logins for the named services (viewers keep playing). Encrypt the archives at rest — a panel backup holds the signing/OPRF keys.',
    inputSchema: { services: z.array(z.enum(['panel', 'broadcaster', 'library', 'reseller'])).optional(), outDir: z.string().optional() }
  }, async ({ services, outDir }) => {
    const svc = (services && services.length ? services : ['panel']).map(shq).join(' ')
    const out = outDir ? `-o ${shq(outDir)} ` : ''
    const r = await ssh.run(`./deploy/backup.sh ${out}${svc}`, { cwd: repoDir, timeoutMs: 600000 })
    return ok({ host: ssh.host, result: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_sysctl', {
    title: 'Apply host network tuning',
    description: 'Run deploy/sysctl/install.sh (needs root): raise net.core.rmem_max/wmem_max so the swarm socket buffers are not silently clamped. Then restart services to re-request the buffers.',
    annotations: { destructiveHint: true }
  }, async () => {
    const r = await ssh.run('sudo deploy/sysctl/install.sh', { cwd: repoDir, allowFail: true, timeoutMs: 120000 })
    return ok({ host: ssh.host, result: (r.stdout || '').trim(), stderr: r.stderr.trim() || undefined, note: 'restart the services to apply: server_update, or docker compose restart' })
  })

  def('server_update', {
    title: 'Update the deployment',
    description: 'The §3B update recipe: git pull → COMPOSE_BAKE=false docker compose build → plain docker compose up -d (NEVER --force-recreate). Recreates only changed containers. A full rebuild can take several minutes; raise the client timeout or run it by hand for very large builds.',
    annotations: { destructiveHint: true }
  }, async () => {
    const pull = await ssh.run('git pull --ff-only', { cwd: repoDir, timeoutMs: 120000 })
    const build = await ssh.run(compose('build'), { cwd: repoDir, timeoutMs: 600000, allowFail: false })
    const up = await ssh.run(compose('up -d'), { cwd: repoDir, timeoutMs: 300000 })
    return ok({ host: ssh.host, pull: pull.stdout.trim(), build: tail(build.stdout, 20), up: up.stdout.trim() || up.stderr.trim() })
  })

  def('server_install', {
    title: 'Install Aliran on the box',
    description: 'Orchestrate the operator-guide §A install: clone → cp .env.example → build → admin-cli init (mints keys) → add-admin (panel + broadcaster, using the config credentials) → write PANEL_PUBKEY/PUBLISHER_KEY/ADMIN_ENABLED=1/CONTROL_ENABLED=1/INPUT into the box .env → up -d. The PUBLISHER secret is written into the box broadcaster .env; only the panel PUBLIC key is returned.',
    inputSchema: { input: z.string().optional().describe('the env channel input (default "test")'), repoUrl: z.string().optional() }
  }, async ({ input, repoUrl }) => {
    if (!ctx.config.panel || !ctx.config.broadcaster) {
      return h.fail('server_install needs both a "panel" and a "broadcaster" block in the config — their user/pass become the dashboard admin logins the panel_/broadcaster_ tools use.')
    }
    const steps = []
    // 1. clone (idempotent)
    await ssh.run(`[ -d ${shq(repoDir + '/.git')} ] || git clone ${shq(repoUrl || REPO_URL)} ${shq(repoDir)}`, { timeoutMs: 300000 })
    steps.push('cloned/verified repo')
    // 2. .env from examples (never clobber an existing .env)
    await ssh.run(`[ -f panel/.env ] || cp panel/.env.example panel/.env; [ -f broadcaster/.env ] || cp broadcaster/.env.example broadcaster/.env`, { cwd: repoDir })
    steps.push('.env files seeded from examples')
    // 3. build
    await ssh.run(compose('build'), { cwd: repoDir, timeoutMs: 600000 })
    steps.push('images built')
    // 4. init — mints keys; prints the panel public key + publisher secret ONCE
    const init = await ssh.run(compose('run --rm panel node src/admin-cli.js init'), { cwd: repoDir, timeoutMs: 120000 })
    const { publicKey, publisherKey } = parseInitKeys(init.stdout)
    if (!publicKey || !publisherKey) {
      return h.fail('could not read the panel public key + publisher key from `admin-cli init` (the panel may already be initialized — init only prints them on a fresh volume). Output:\n' + tail(init.stdout, 12))
    }
    steps.push('panel initialized (keys minted)')
    // 5. dashboard admins (creds come from the config; never echoed back)
    await ssh.run(compose(`run --rm panel node src/admin-cli.js add-admin ${shq(ctx.config.panel.username)} --password ${shq(ctx.config.panel.password)}`), { cwd: repoDir, timeoutMs: 120000 })
    await ssh.run(compose(`run --rm broadcaster node src/control-cli.js add-admin ${shq(ctx.config.broadcaster.username)} --password ${shq(ctx.config.broadcaster.password)}`), { cwd: repoDir, timeoutMs: 120000 })
    steps.push('dashboard admins created (panel + broadcaster)')
    // 6. write .env — the PUBLISHER secret lands server-side, never returned
    await upsertEnv(ssh, `${repoDir}/panel/.env`, { ADMIN_ENABLED: '1' }, { cwd: repoDir })
    await upsertEnv(ssh, `${repoDir}/broadcaster/.env`, { PANEL_PUBKEY: publicKey, PUBLISHER_KEY: publisherKey, CONTROL_ENABLED: '1', INPUT: input || 'test' }, { cwd: repoDir })
    steps.push('.env written (PUBLISHER_KEY server-side; ADMIN/CONTROL enabled)')
    // 7. up
    const up = await ssh.run(compose('up -d'), { cwd: repoDir, timeoutMs: 300000 })
    steps.push('docker compose up -d')
    return ok({
      host: ssh.host,
      panelPublicKey: publicKey,
      publisherKeyWrittenTo: `${repoDir}/broadcaster/.env (secret NOT returned)`,
      dashboards: 'ADMIN_ENABLED=1 (panel :3210), CONTROL_ENABLED=1 (broadcaster :3310)',
      steps,
      up: up.stdout.trim() || up.stderr.trim(),
      next: 'verify with server_status / server_logs; the panel PUBLIC key above goes into client builds'
    })
  })
}

function tail (s, n) {
  const lines = String(s || '').trimEnd().split('\n')
  return lines.slice(-n).join('\n')
}
