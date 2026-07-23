// Reseller panel config (env-driven). Mirrors library/src/config.js style.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadDotEnv () {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
loadDotEnv()

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10))

export const config = {
  dataDir: process.env.DATA_DIR || './data',
  // The panel admin API this service fronts. Loopback for the single-box case; an
  // https URL for a reseller box on different hardware (expose the panel's /api/*
  // ONLY IP-allowlisted to that box — see docs/reseller-panel.md). The service
  // authenticates as ONE dedicated full-privilege panel admin (create it with
  // `node src/admin-cli.js add-admin reseller-svc` on the panel).
  panel: {
    url: (process.env.PANEL_ADMIN_URL || 'http://127.0.0.1:3210').replace(/\/+$/, ''),
    username: process.env.PANEL_ADMIN_USER || null,
    password: process.env.PANEL_ADMIN_PASS || null,
    timeoutMs: int(process.env.PANEL_TIMEOUT_MS, 10000)
  },
  // 1 credit = 1 month = this many days, flat (locked pricing decision).
  daysPerMonth: int(process.env.DAYS_PER_MONTH, 31),
  trialHours: int(process.env.TRIAL_HOURS, 24),
  trialDailyCapDefault: int(process.env.TRIAL_DAILY_CAP_DEFAULT, 3),
  maxDevicesLimitDefault: int(process.env.MAX_DEVICES_LIMIT_DEFAULT, 3),
  // The subscription clock. The panel has NO account expiry, so this sweep is the
  // only thing that ever ends a lapsed subscription (backs off while the panel is
  // unreachable — the work list re-derives from expiresAt, so retry is free).
  sweepIntervalSec: int(process.env.SWEEP_INTERVAL_SEC, 300),
  reconcileIntervalSec: int(process.env.RECONCILE_INTERVAL_SEC, 3600),
  reconcileRepair: /^(1|true|yes)$/i.test(process.env.RECONCILE_REPAIR || ''),
  control: {
    // Loopback by default; 0.0.0.0 only behind a TLS reverse proxy. This dashboard
    // exists to be used by THIRD PARTIES — see deploy/Caddyfile.example.
    host: process.env.CONTROL_HOST || '127.0.0.1',
    port: int(process.env.CONTROL_PORT, 3330),
    sessionTtlHours: int(process.env.CONTROL_SESSION_TTL_HOURS, 12),
    // Behind a trusted proxy every connection carries the PROXY's socket IP, so
    // the username|ip login lockout would let one abuser lock a victim's username
    // for everybody. Name the proxy's client-IP header here (Cloudflare Tunnel:
    // cf-connecting-ip; Caddy/nginx: x-forwarded-for) and the throttle keys on
    // the real client instead. Set ONLY when the port is reachable exclusively
    // through that proxy — a directly reachable port lets clients spoof the
    // header and mint fresh throttle keys.
    trustProxyHeader: (process.env.TRUST_PROXY_HEADER || '').trim().toLowerCase()
  },
  lockout: {
    threshold: int(process.env.LOCKOUT_THRESHOLD, 10),
    seconds: int(process.env.LOCKOUT_SECONDS, 900)
  },
  // Argon2id cost for principal passwords (interactive-grade defaults).
  argon2: {
    memKiB: int(process.env.ARGON2_MEM_KIB, 65536),
    time: int(process.env.ARGON2_TIME, 2)
  },
  // White-label: brand name, optional logo/favicon image files (served at
  // /branding/logo + /branding/favicon), and an optional JSON file overriding
  // any of the 11 shared theme tokens (served as /branding.css ON TOP of the
  // byte-identical shared block — test:theme is untouched). Full manual:
  // docs/white-label.md → "Reseller panel dashboard".
  branding: {
    name: process.env.BRAND_NAME || '',
    themeFile: process.env.BRAND_THEME_FILE || '',
    logoFile: process.env.BRAND_LOGO_FILE || '',
    faviconFile: process.env.BRAND_FAVICON_FILE || '',
    // Login landing page: a full-viewport backdrop image (auto-scrimmed so the
    // card stays readable), or one of the built-in token-derived patterns
    // (glow — the default — plain, grid, dots, stripes). The image wins.
    loginBgFile: process.env.BRAND_LOGIN_BG_FILE || '',
    loginStyle: (process.env.BRAND_LOGIN_STYLE || '').trim().toLowerCase()
  },
  // Automated credit top-ups: setting a secret enables POST /api/webhooks/credits
  // (HMAC-SHA256-signed, idempotent). Use a long random value (32+ chars) — it is
  // the ONLY thing authenticating a mint.
  webhook: {
    secret: process.env.WEBHOOK_SECRET || ''
  }
}

// --- Fail-fast validation ---
// A typo'd env var must be a clear boot error naming the variable — never a silent
// default, and never a NaN that resurfaces later as a weird timeout or port error.
// Branding values stay permissive by design (a junk BRAND_LOGIN_STYLE falls back to
// glow; a missing image file 404s) — cosmetics must never stop the service.
const problems = []
const chkInt = (name, v, min, max) => {
  if (!Number.isInteger(v)) problems.push(`${name} must be an integer (got "${process.env[name]}")`)
  else if (min !== undefined && v < min) problems.push(`${name} must be >= ${min} (got ${v})`)
  else if (max !== undefined && v > max) problems.push(`${name} must be <= ${max} (got ${v})`)
}
const chkBool = (name) => {
  const v = process.env[name]
  if (v !== undefined && v !== '' && !/^(1|true|yes|0|false|no)$/i.test(v)) {
    problems.push(`${name} must be one of 1/true/yes/0/false/no (got "${v}")`)
  }
}

try {
  const u = new URL(config.panel.url)
  if (!/^https?:$/.test(u.protocol)) problems.push(`PANEL_ADMIN_URL must be http(s) (got "${config.panel.url}")`)
} catch {
  problems.push(`PANEL_ADMIN_URL is not a valid URL (got "${config.panel.url}")`)
}
chkInt('PANEL_TIMEOUT_MS', config.panel.timeoutMs, 1000)
chkInt('DAYS_PER_MONTH', config.daysPerMonth, 1)
chkInt('TRIAL_HOURS', config.trialHours, 1)
chkInt('TRIAL_DAILY_CAP_DEFAULT', config.trialDailyCapDefault, 0)
chkInt('MAX_DEVICES_LIMIT_DEFAULT', config.maxDevicesLimitDefault, 1)
chkInt('SWEEP_INTERVAL_SEC', config.sweepIntervalSec, 10)
chkInt('RECONCILE_INTERVAL_SEC', config.reconcileIntervalSec, 60)
chkBool('RECONCILE_REPAIR')
chkInt('CONTROL_PORT', config.control.port, 0, 65535)
chkInt('CONTROL_SESSION_TTL_HOURS', config.control.sessionTtlHours, 1)
chkInt('LOCKOUT_THRESHOLD', config.lockout.threshold, 1)
chkInt('LOCKOUT_SECONDS', config.lockout.seconds, 1)
chkInt('ARGON2_MEM_KIB', config.argon2.memKiB, 8)
chkInt('ARGON2_TIME', config.argon2.time, 1)
// The webhook secret is the ONLY thing authenticating a credit mint — a short one
// is a config mistake, not a preference.
if (config.webhook.secret && config.webhook.secret.length < 16) {
  problems.push('WEBHOOK_SECRET must be at least 16 characters (32+ recommended)')
}

if (problems.length) {
  throw new Error('reseller: invalid configuration —\n  - ' + problems.join('\n  - '))
}

export default config
