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

// The documented env knobs each service reads (src/config.js + log.js) — the
// settable surface of server_set_env. A NAME list only (validation itself is
// delegated to the in-image `node src/config.js --check`, which cannot drift); a
// knob missing here fails safe: it just isn't settable until the list is updated.
const SETTABLE_ENV = {
  panel: [
    'RELAY_ONLY', 'ARGON2_MEM_KIB', 'ARGON2_TIME', 'MAX_DEVICES_DEFAULT',
    'SESSION_TTL_DAYS', 'LEGACY_PUBLISHER', 'POW_DIFFICULTY',
    'LOCKOUT_THRESHOLD', 'LOCKOUT_SECONDS', 'SWARM_RCVBUF_MB', 'SWARM_SNDBUF_MB',
    'BOOTSTRAP', 'ADMIN_ENABLED', 'ADMIN_HOST', 'ADMIN_PORT',
    'ADMIN_SESSION_TTL_HOURS', 'ANALYTICS_RETENTION_DAYS', 'SOURCES_TICK_MS',
    'SOURCES_BOOT_DELAY_MS', 'SOURCES_SYNC_INTERVAL_MS', 'SOURCES_FETCH_TIMEOUT_MS',
    'SOURCES_MAX_BYTES', 'SOURCES_MAX_CHANNELS',
    // Viewer problem reports (S50) — the TUNABLES only. The two knobs that carry
    // credentials (REPORTS_WEBHOOK_URL, REPORTS_TELEGRAM_BOT_TOKEN) are refused
    // below; REPORTS_TELEGRAM_CHAT_ID is a bare id, useless without the token.
    'REPORTS_RETENTION_DAYS', 'REPORTS_MAX_PER_WINDOW', 'REPORTS_WINDOW_SECONDS',
    'REPORTS_ALERT_COUNT', 'REPORTS_ALERT_WINDOW_MIN', 'REPORTS_STORM_SAMPLE',
    'REPORTS_GLOBAL_PER_MIN', 'REPORTS_TELEGRAM_CHAT_ID',
    'LOG_FORMAT'
  ],
  broadcaster: [
    'STREAM_ID', 'TITLE', 'CATEGORY', 'INPUT', 'RTMP_PORT', 'PUBLIC_HOST',
    'INGEST_PORT_BASE', 'INGEST_PORT_MAX', 'VAAPI_DEVICE', 'HLS_TIME',
    'HLS_LIST_SIZE', 'FEED_BUFFER', 'FEED_ROTATE_HOURS', 'FEED_ROTATE_TREE_MB',
    'FEED_ROTATE_GRACE_MS', 'FEED_CACHE_MAX', 'FFMPEG_MAX_RSS_MB',
    'SLATE_ENABLED', 'SLATE_DIR', 'SLATE_AFTER', 'SLATE_RETRY_MS',
    'RESUME_PACE', 'RESUME_PACE_MIN', 'RESUME_PACE_TARGET_MS', 'RESUME_PACE_MAX_MS',
    'RESUME_CONCURRENCY', 'HLS_WORK_DIR', 'SWARM_MAX_PEERS', 'SWARM_RCVBUF_MB',
    'SWARM_SNDBUF_MB', 'BOOTSTRAP', 'CONTROL_ENABLED', 'CONTROL_HOST',
    'CONTROL_PORT', 'CONTROL_SESSION_TTL_HOURS', 'LOCKOUT_THRESHOLD',
    'LOCKOUT_SECONDS', 'ANALYTICS_RETENTION_DAYS', 'ARGON2_MEM_KIB', 'ARGON2_TIME',
    'LOG_FORMAT'
  ],
  library: [
    'HLS_TIME', 'INGEST_CONCURRENCY', 'SWARM_MAX_PEERS', 'SWARM_RCVBUF_MB',
    'SWARM_SNDBUF_MB', 'BOOTSTRAP', 'CONTROL_ENABLED', 'CONTROL_HOST',
    'CONTROL_PORT', 'CONTROL_SESSION_TTL_HOURS', 'LOCKOUT_THRESHOLD',
    'LOCKOUT_SECONDS', 'ARGON2_MEM_KIB', 'ARGON2_TIME', 'LOG_FORMAT'
  ],
  reseller: [
    'PANEL_ADMIN_URL', 'PANEL_TIMEOUT_MS', 'DAYS_PER_MONTH', 'TRIAL_HOURS',
    'TRIAL_DAILY_CAP_DEFAULT', 'MAX_DEVICES_LIMIT_DEFAULT', 'SWEEP_INTERVAL_SEC',
    'RECONCILE_INTERVAL_SEC', 'RECONCILE_REPAIR', 'CONTROL_HOST', 'CONTROL_PORT',
    'CONTROL_SESSION_TTL_HOURS', 'TRUST_PROXY_HEADER', 'LOCKOUT_THRESHOLD',
    'LOCKOUT_SECONDS', 'ARGON2_MEM_KIB', 'ARGON2_TIME', 'BRAND_NAME',
    'BRAND_THEME_FILE', 'BRAND_LOGO_FILE', 'BRAND_FAVICON_FILE',
    'BRAND_LOGIN_BG_FILE', 'BRAND_LOGIN_STYLE', 'LOG_FORMAT'
  ]
}

// Keys server_set_env REFUSES no matter the service: secrets and identity material
// have dedicated flows that keep them server-side, and DATA_DIR is pinned by
// docker-compose.yml. The hint tells the operator the right road.
const REFUSED_ENV = {
  PUBLISHER_KEY: 'a publisher secret — panel_add_publisher (or server_install) writes it into the box .env server-side',
  PUBLISHER_NAME: 'set beside PUBLISHER_KEY by panel_add_publisher — the pair must match the panel enrollment',
  PANEL_PUBKEY: 'the panel identity — server_install writes it during install',
  PANEL_ADMIN_USER: 'the reseller\'s panel credential — set it on the box by hand (it is a secret pairing)',
  PANEL_ADMIN_PASS: 'a secret — never transits the MCP; set it on the box by hand',
  WEBHOOK_SECRET: 'a secret — never transits the MCP; set it on the box by hand',
  REPORTS_TELEGRAM_BOT_TOKEN: 'a bot secret — never transits the MCP; put it in panel/.env on the box by hand (docs/reports.md), then apply it with a plain `docker compose up -d panel`',
  // A notification URL is not "just a URL": an ntfy topic, a Slack incoming
  // webhook and a Discord webhook all carry their CREDENTIAL in the path, so
  // anyone holding the url can post as the operator. Setting it here would copy
  // that credential into the model's context and echo it back in the applied
  // pairs — the same reason PANEL_ADMIN_PASS is refused. The tunables around it
  // stay settable, so an operator can still tune the alert rules through the MCP.
  REPORTS_WEBHOOK_URL: 'a notification endpoint that carries its own credential in the path (ntfy topic / Slack / Discord webhook urls are secrets) — set it in panel/.env on the box by hand (docs/reports.md), then apply it with a plain `docker compose up -d panel`; panel_test_notify proves it works afterwards',
  DATA_DIR: 'pinned to /data by docker-compose.yml (environment wins over env_file)'
}

export function registerServerTools (ctx, h) {
  const { def, ok } = h
  const profileFlags = ctx.config.install.composeProfiles.map((p) => `--profile ${shq(p)} `).join('')
  const compose = (sub) => `docker compose ${profileFlags}${sub}`
  // Multi-host (S49c): every tool here takes an optional `host` naming an entry in
  // config ssh.hosts; omitted = the default box, byte-identical to single-host use.
  // Resolution happens per call — an unknown name is a loud error listing the
  // configured names before anything touches a box.
  const at = (host) => ({ ssh: ctx.sshFor(host), repoDir: ctx.repoDirFor(host) })
  const HOST_ARG = { host: z.string().optional().describe('named box from ssh.hosts (omit = the default box)') }

  // ---- read-only diagnostics ----
  def('server_preflight', {
    title: 'Preflight the box',
    description: 'Check the box has docker + compose + ffmpeg + git and reports their versions. Read-only.',
    inputSchema: { ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ host }) => {
    const { ssh, repoDir } = at(host)
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
    inputSchema: { ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ host }) => {
    const { ssh, repoDir } = at(host)
    const r = await ssh.run(`${compose('ps')}; echo '== commit =='; git -C ${shq(repoDir)} log --oneline -1 2>/dev/null || echo '(no repo)'`, { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, status: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_logs', {
    title: 'Service logs',
    description: 'docker compose logs (tail). Optional service = panel | broadcaster | library | reseller. Read-only.',
    inputSchema: { service: z.string().optional(), lines: z.number().int().min(1).max(2000).optional(), ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ service, lines, host }) => {
    const { ssh, repoDir } = at(host)
    const n = lines || 200
    const r = await ssh.run(compose(`logs --tail ${n} --no-color${service ? ' ' + shq(service) : ''}`), { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, logs: (r.stdout || r.stderr).trim() })
  })

  def('server_disk', {
    title: 'Disk usage',
    description: 'df -h + docker system df on the box, to spot a filling disk. Read-only.',
    inputSchema: { ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ host }) => {
    const { ssh } = at(host)
    const r = await ssh.run("df -h; echo '== docker =='; docker system df 2>/dev/null || true", { allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, disk: r.stdout.trim() })
  })

  // The repeater deliberately has NO admin API — a stock repeater opens ZERO
  // listening sockets (part of its co-tenancy/trust story), so its status is
  // SSH-shaped: compose state + logs, plus the opt-in loopback status server
  // when the operator enabled one (STATUS_PORT in repeater/.env).
  def('repeater_status', {
    title: 'Repeater status',
    description: 'Status of a repeater appliance over SSH — the repeater has NO admin API by design (a stock repeater opens zero listening sockets). Reports docker compose ps + a logs tail for the deploy/docker-compose.repeater.yml stack, and probes the opt-in loopback status server (/metrics) ON the box when STATUS_PORT is set in its repeater/.env; when it is not enabled, that is reported honestly rather than as an error. host = a named box from ssh.hosts (a repeater is typically its own machine). Install guidance: deploy/docker-compose.repeater.yml + the repeater KB.',
    inputSchema: { lines: z.number().int().min(1).max(400).optional(), ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ lines, host }) => {
    const { ssh, repoDir } = at(host)
    const rcompose = 'docker compose -f deploy/docker-compose.repeater.yml'
    const ps = await ssh.run(`${rcompose} ps`, { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    const logs = await ssh.run(`${rcompose} logs --tail ${lines || 80} --no-color`, { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    const portR = await ssh.run("grep '^STATUS_PORT=' repeater/.env 2>/dev/null | tail -1", { cwd: repoDir, allowFail: true, timeoutMs: 30000 })
    const portM = portR.stdout.match(/STATUS_PORT=(\d+)/)
    const port = portM ? Number(portM[1]) : 0
    let statusServer
    let metrics
    if (port > 0) {
      const met = await ssh.run(`curl -sf --max-time 5 http://127.0.0.1:${port}/metrics`, { allowFail: true, timeoutMs: 30000 })
      if (met.code === 0 && met.stdout.trim()) {
        statusServer = `enabled (STATUS_PORT=${port})`
        metrics = tail(met.stdout, 120)
      } else {
        statusServer = `configured (STATUS_PORT=${port}) but /metrics did not answer on the box loopback — is the repeater container up? (docker compose -f deploy/docker-compose.repeater.yml ps)`
      }
    } else {
      statusServer = 'not enabled — a stock repeater opens ZERO listening sockets by design. Opt in by setting STATUS_PORT in repeater/.env on the box (see the repeater KB: docs/kb/repeater-production-example.md), then recreate with docker compose -f deploy/docker-compose.repeater.yml up -d.'
    }
    return ok({ host: ssh.host, compose: ps.stdout.trim() || ps.stderr.trim() || '(no output)', statusServer, ...(metrics ? { metrics } : {}), logs: (logs.stdout || logs.stderr).trim() })
  })

  // ---- maintenance ----
  def('server_backup', {
    title: 'Cold backup',
    description: 'Run deploy/backup.sh: cold stop → tar the data volume → start. Briefly pauses NEW logins for the named services (viewers keep playing). Encrypt the archives at rest — a panel backup holds the signing/OPRF keys. See server_list_backups / server_restore for the way back.',
    inputSchema: { services: z.array(z.enum(['panel', 'broadcaster', 'library', 'reseller'])).optional(), outDir: z.string().optional(), ...HOST_ARG }
  }, async ({ services, outDir, host }) => {
    const { ssh, repoDir } = at(host)
    const svc = (services && services.length ? services : ['panel']).map(shq).join(' ')
    const out = outDir ? `-o ${shq(outDir)} ` : ''
    const r = await ssh.run(`sh ./deploy/backup.sh ${out}${svc}`, { cwd: repoDir, timeoutMs: 600000 })
    return ok({ host: ssh.host, result: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_list_backups', {
    title: 'List backups',
    description: 'List the backup archives on the box (what deploy/backup.sh / server_backup wrote; default dir ./backups under the repo). Read-only.',
    inputSchema: { dir: z.string().optional().describe('backup dir on the box (default ./backups, relative to the repo dir)'), ...HOST_ARG },
    annotations: { readOnlyHint: true }
  }, async ({ dir, host }) => {
    const { ssh, repoDir } = at(host)
    const d = dir || './backups'
    const r = await ssh.run(`ls -lh ${shq(d)}/*.tar.gz ${shq(d)}/*.tgz 2>/dev/null || echo '(no archives)'`, { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
    return ok({ host: ssh.host, dir: d, backups: r.stdout.trim(), note: 'restore with server_restore {service, archive}' })
  })

  def('server_restore', {
    title: 'Restore a service volume from a backup',
    description: 'Run deploy/restore.sh on the box: verify the archive → stop <service> → REPLACE its data-volume contents with the archive → start. Refuses a NON-EMPTY volume or a name-mismatched archive unless force:true; with force the current volume contents are DELETED first and are gone afterwards. Restoring a panel backup rolls users/grants/keys back to that archive\'s moment (issued sessions die). The result echoes exactly what was overwritten and from which archive.',
    inputSchema: {
      service: z.enum(['panel', 'broadcaster', 'library', 'reseller']),
      archive: z.string().describe('archive path ON THE BOX — absolute, or relative to the repo dir (server_list_backups shows them, e.g. backups/panel-20260724-070000.tar.gz)'),
      force: z.boolean().optional().describe('replace a NON-EMPTY volume / accept a name-mismatched archive — destroys the current contents'),
      ...HOST_ARG
    },
    annotations: { destructiveHint: true }
  }, async ({ service, archive, force, host }) => {
    const { ssh, repoDir } = at(host)
    const r = await ssh.run(`sh ./deploy/restore.sh ${force ? '--force ' : ''}${shq(service)} ${shq(archive)}`, { cwd: repoDir, timeoutMs: 600000 })
    return ok({ host: ssh.host, service, archive, result: r.stdout.trim(), stderr: r.stderr.trim() || undefined })
  })

  def('server_set_env', {
    title: 'Set service env knobs',
    description: 'Upsert documented env knobs in a service\'s .env on the box, VALIDATED BEFORE APPLIED: the new .env is dry-run through `node src/config.js --check` in the built image first — both configs fail-fast at boot, so an unvalidated typo would leave the service down. On a validation failure the .env is REVERTED and the exact problem list is returned. On success the change is applied by recreating that one service via plain `docker compose up -d <service>` (a compose `restart` does NOT re-read env files; never --force-recreate). Secrets (PUBLISHER_KEY etc.) are refused — they have dedicated flows. apply:false stages the change without the recreate.',
    inputSchema: {
      service: z.enum(['panel', 'broadcaster', 'library', 'reseller']),
      pairs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe('KEY: value map of documented knobs (e.g. {"MAX_DEVICES_DEFAULT": 5})'),
      apply: z.boolean().optional().describe('default true: recreate the service container with the new env. false = write + validate only; apply later with another server_set_env or server_update'),
      ...HOST_ARG
    },
    annotations: { destructiveHint: true }
  }, async ({ service, pairs, apply, host }) => {
    const { ssh, repoDir } = at(host)
    const entries = Object.entries(pairs || {})
    if (!entries.length) throw new Error('no pairs given — nothing to set')
    const allowed = SETTABLE_ENV[service]
    const set = {}
    for (const [key, value] of entries) {
      if (REFUSED_ENV[key]) throw new Error(`refusing to set ${key}: ${REFUSED_ENV[key]}`)
      if (!allowed.includes(key)) {
        throw new Error(`${key} is not a documented ${service} knob — settable keys: ${allowed.join(', ')}`)
      }
      const v = String(value)
      // One line per key, always: an embedded newline would smuggle extra
      // KEY=VALUE lines (e.g. a PUBLISHER_KEY) past the allowlist.
      if (/[\r\n\x00]/.test(v)) throw new Error(`${key}: the value must be a single line without control characters`)
      if (v.length > 512) throw new Error(`${key}: value too long (${v.length} chars, max 512)`)
      set[key] = v
    }

    const envPath = `${repoDir}/${service}/.env`
    const prevPath = `${envPath}.mcp-prev`
    const probe = await ssh.run(`[ -f ${shq(envPath)} ] && echo exists || echo absent`, { allowFail: true, timeoutMs: 30000 })
    const existed = /exists/.test(probe.stdout)
    if (existed) await ssh.run(`cp -p ${shq(envPath)} ${shq(prevPath)}`, { timeoutMs: 30000 })
    await upsertEnv(ssh, envPath, set, { cwd: repoDir })

    // Dry-run the NEW .env through the built image's fail-fast validation before
    // anything restarts. compose `run` reads env_file fresh, so this sees exactly
    // what the next boot would see. Works against pre---check images too: their
    // config.js still exits non-zero with the problem text on a bad env.
    const check = await ssh.run(compose(`run --rm ${shq(service)} node src/config.js --check`), { cwd: repoDir, allowFail: true, timeoutMs: 180000 })
    if (check.code !== 0) {
      if (existed) await ssh.run(`mv ${shq(prevPath)} ${shq(envPath)}`, { timeoutMs: 30000 })
      else await ssh.run(`rm -f ${shq(envPath)}`, { timeoutMs: 30000 })
      const report = [check.stdout.trim(), check.stderr.trim()].filter(Boolean).join('\n')
      throw new Error(`configuration REJECTED — the .env change was REVERTED, nothing was applied.\n${service} check-config said:\n${report}`)
    }
    if (existed) await ssh.run(`rm -f ${shq(prevPath)}`, { timeoutMs: 30000 })

    let applied
    if (apply === false) {
      applied = `NOT applied (apply:false) — staged in ${envPath}; it takes effect on the next recreate (server_set_env apply, or server_update). Note a plain compose restart does NOT re-read env files.`
    } else {
      const up = await ssh.run(compose(`up -d ${shq(service)}`), { cwd: repoDir, timeoutMs: 300000 })
      applied = `container recreated with the new env (docker compose up -d ${service}): ${(up.stdout.trim() || up.stderr.trim()).split('\n').pop() || 'done'}`
    }
    return ok({
      host: ssh.host,
      service,
      envPath,
      set,
      validation: `passed — ${service} check-config OK against the new .env in the built image`,
      applied,
      ...(service === 'broadcaster' && apply !== false ? { note: 'the broadcaster recreate re-runs boot-resume: every desired-running channel restarts (paced) — allow a minute or more on a large fleet' } : {})
    })
  })

  def('server_restart', {
    title: 'Restart services',
    description: 'docker compose restart of the named services (default: all). Bounces the process in the SAME container — use it after server_sysctl so swarms re-request their socket buffers. It does NOT apply .env changes (compose only re-reads env files on an up -d recreate — server_set_env does that itself). Broadcaster: boot-resume restarts every desired-running channel (paced — allow a minute or more on a large fleet). Never uses --force-recreate.',
    inputSchema: { services: z.array(z.enum(['panel', 'broadcaster', 'library', 'reseller'])).optional(), ...HOST_ARG },
    annotations: { destructiveHint: true }
  }, async ({ services, host }) => {
    const { ssh, repoDir } = at(host)
    const names = (services && services.length) ? services : null
    const r = await ssh.run(compose('restart' + (names ? ' ' + names.map(shq).join(' ') : '')), { cwd: repoDir, timeoutMs: 300000 })
    return ok({ host: ssh.host, restarted: names || 'all services', output: (r.stdout.trim() || r.stderr.trim()) || 'restarted' })
  })

  def('server_sysctl', {
    title: 'Apply host network tuning',
    description: 'Run deploy/sysctl/install.sh (needs root): raise net.core.rmem_max/wmem_max so the swarm socket buffers are not silently clamped. Then restart services to re-request the buffers. Worth running on a repeater box specifically (host:"<name>") — a repeater on default ceilings quietly caps out.',
    inputSchema: { ...HOST_ARG },
    annotations: { destructiveHint: true }
  }, async ({ host }) => {
    const { ssh, repoDir } = at(host)
    const r = await ssh.run('sudo deploy/sysctl/install.sh', { cwd: repoDir, allowFail: true, timeoutMs: 120000 })
    return ok({ host: ssh.host, result: (r.stdout || '').trim(), stderr: r.stderr.trim() || undefined, note: 'restart the services to apply: server_update, or docker compose restart' })
  })

  def('server_update', {
    title: 'Update the deployment',
    description: 'The §3B update recipe: git pull → COMPOSE_BAKE=false docker compose build → plain docker compose up -d (NEVER --force-recreate). Recreates only changed containers. A full rebuild can take several minutes; raise the client timeout or run it by hand for very large builds. dryRun:true only fetches and reports what WOULD deploy (commits + changed files) — nothing is pulled into the worktree, built, or restarted.',
    inputSchema: { dryRun: z.boolean().optional().describe('report what would deploy (git fetch + log + diff --stat against the upstream) without building or restarting anything'), ...HOST_ARG },
    annotations: { destructiveHint: true }
  }, async ({ dryRun, host }) => {
    const { ssh, repoDir } = at(host)
    if (dryRun) {
      // Fetch updates the remote-tracking refs only — the worktree, images and
      // containers stay untouched. '@{u}' = the checked-out branch's upstream,
      // exactly what the real run's `git pull --ff-only` would merge.
      await ssh.run('git fetch --quiet', { cwd: repoDir, timeoutMs: 120000 })
      const logR = await ssh.run("git log --oneline HEAD..'@{u}'", { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
      const statR = await ssh.run("git diff --stat HEAD '@{u}'", { cwd: repoDir, allowFail: true, timeoutMs: 60000 })
      const commits = logR.stdout.trim()
      return ok({
        host: ssh.host,
        dryRun: true,
        wouldDeploy: commits || '(nothing — the box is up to date with its upstream)',
        changedFiles: commits ? (statR.stdout.trim() || '(no file changes reported)') : '(none)',
        note: 'dry run only — nothing was pulled, built, or restarted. Run server_update without dryRun to deploy exactly this.'
      })
    }
    const pull = await ssh.run('git pull --ff-only', { cwd: repoDir, timeoutMs: 120000 })
    const build = await ssh.run(compose('build'), { cwd: repoDir, timeoutMs: 600000, allowFail: false })
    const up = await ssh.run(compose('up -d'), { cwd: repoDir, timeoutMs: 300000 })
    return ok({ host: ssh.host, pull: pull.stdout.trim(), build: tail(build.stdout, 20), up: up.stdout.trim() || up.stderr.trim() })
  })

  def('server_install', {
    title: 'Install Aliran on the box',
    description: 'Orchestrate the operator-guide §A install: clone → cp .env.example → build → admin-cli init (mints keys) → add-admin (panel + broadcaster, using the config credentials) → write PANEL_PUBKEY/PUBLISHER_KEY/ADMIN_ENABLED=1/CONTROL_ENABLED=1/INPUT into the box .env → up -d. The PUBLISHER secret is written into the box broadcaster .env; only the panel PUBLIC key is returned. Deliberately DEFAULT-BOX ONLY (no host param): this installs the full panel+broadcaster stack, a one-box affair — a repeater box is installed by hand per deploy/docker-compose.repeater.yml + the repeater KB, and broadcaster-only scale-out installs are an S20b follow-up.',
    inputSchema: { input: z.string().optional().describe('the env channel input (default "test")'), repoUrl: z.string().optional() }
  }, async ({ input, repoUrl }) => {
    const { ssh, repoDir } = at(null)
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
