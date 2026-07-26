// Ops notifications for viewer problem reports (S50b) — FAIL-DARK by construction.
//
// One job: when the correlation engine (src/reports.js) OPENS an alert, push it to
// wherever the operator actually looks. Two targets, both optional:
//
//   - a generic webhook (REPORTS_WEBHOOK_URL). The body carries the same message
//     under four different key names — {title, message, text, content} — because
//     ntfy reads title/message, Slack reads text and Discord reads content, and
//     each ignores the keys it does not know. So ONE knob works with all three
//     (plus anything else that accepts JSON) with no per-provider adapter. A
//     plain ntfy topic URL also honours the `X-Title` header, so that goes too.
//   - a Telegram bot (REPORTS_TELEGRAM_BOT_TOKEN + REPORTS_TELEGRAM_CHAT_ID) via
//     POST {telegramApiBase}/bot<token>/sendMessage. `telegramApiBase` is
//     injectable so the e2e suite can point it at a local stub server.
//
// THE INVARIANT: a dead endpoint must never back-pressure the panel. An alert
// opens on the report INGEST path, which is the lowest-priority responder during
// exactly the kind of storm that opens alerts — so notification is queued, never
// awaited: `notify()` enqueues and returns, a single serial worker drains the
// queue (the makeSourcesScheduler discipline: one flight at a time, never
// re-entrant), each attempt is guarded by its own AbortController timeout and a
// response byte-cap (the fetchFeed() discipline), and after 3 attempts over ~30 s
// the notification is DROPPED with a logged warning. The queue itself is bounded:
// past `queueMax` the OLDEST pending notification is dropped, so a blackholed
// endpoint costs a bounded amount of memory and zero ingest latency.
//
// Unconfigured (both knobs empty) = a complete no-op: `enabled:false`, no timers,
// no queue, no fetch — notify() returns immediately.
//
// Privacy: an alert carries channel, kind, per-category tallies and a distinct-
// reporter COUNT. There is no username, device id or reporter pseudonym in it,
// and this module adds none — see the S50a header in src/reports.js.

// Per-attempt request timeout. Generous enough for a cold serverless webhook,
// short enough that three attempts still fit the ~30 s budget.
const DEFAULT_TIMEOUT_MS = 8000
// Cap on the response we read. We do not need the body at all (only the status),
// but reading a bounded prefix gives a useful error snippet and releases the
// socket; a webhook that answers with a gigabyte can never balloon panel memory.
const DEFAULT_MAX_BYTES = 64 * 1024
// Backoff BETWEEN attempts. 3 attempts total: t=0, +2 s, +10 s — with the 8 s
// per-attempt timeout that is ~34 s worst case before the drop.
const DEFAULT_BACKOFF_MS = [2000, 8000]
// Bounded queue. A real deployment never has more than a couple of alerts in
// flight; this only ever matters when the endpoint is down.
const DEFAULT_QUEUE_MAX = 50

const TELEGRAM_API_BASE = 'https://api.telegram.org'

const CATEGORY_LABELS = {
  'no-audio': 'no audio',
  'black-screen': 'black screen',
  'visual-artifacts': 'visual artifacts',
  buffering: 'buffering',
  'wrong-content': 'wrong content',
  login: 'login',
  other: 'other'
}

// HTTP header values must be latin-1; a channel name is operator/feed-supplied and
// may hold anything. Strip to printable ASCII and cap — a title header can never
// throw inside fetch, and can never smuggle a newline into the request.
function headerSafe (s, max = 120) {
  return String(s ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, max)
}

// One line of human text out of an alert record. Counts only — see the privacy
// note above. Reporter counts past the in-memory set cap are a LOWER bound, and
// say so (the same "≥" honesty the analytics surfaces use).
export function renderAlert (alert = {}) {
  const channel = alert.channel || null
  const count = Number.isFinite(alert.reporters) ? alert.reporters : 0
  const ge = alert.reportersCapped ? '≥ ' : ''
  const who = `${ge}${count} distinct viewer${count === 1 ? '' : 's'}`
  const title = alert.kind === 'login'
    ? `Aliran: login problems (${who})`
    : `Aliran: problem on ${channel || '(no channel)'} (${who})`
  const cats = Object.entries(alert.categories || {})
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${CATEGORY_LABELS[c] || c} ${n}`)
    .join(', ')
  const parts = [`${who} reported a problem`]
  if (channel) parts.push(`on ${channel}`)
  if (cats) parts.push(`— ${cats}`)
  if (alert.shedCount > 0) parts.push(`(+${alert.shedCount} shed by the breaker)`)
  parts.push(`· alert ${alert.id || '?'}`)
  return { title, message: parts.join(' '), channel, count }
}

// POST JSON with a hard timeout and a bounded response read. Throws a plain Error
// with a short, log-safe message on any failure (including a non-2xx status).
async function postJson (url, body, headers, { timeoutMs, maxBytes, fetchImpl }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'follow'
      })
    } catch (err) {
      throw new Error(ac.signal.aborted ? `timed out after ${timeoutMs}ms` : (err.cause?.message || err.message || String(err)))
    }
    // Read at most maxBytes of the response, then let it go. Errors while draining
    // are irrelevant — the status is what decides success.
    let snippet = ''
    try {
      if (res.body) {
        const reader = res.body.getReader()
        const chunks = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) { try { await reader.cancel() } catch {} break }
          chunks.push(Buffer.from(value))
        }
        snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 140)
      }
    } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}${snippet ? ' — ' + snippet : ''}`)
    return { status: res.status }
  } finally { clearTimeout(timer) }
}

// opts:
//   webhookUrl, telegramBotToken, telegramChatId  — the D3 config knobs
//   telegramApiBase   — injectable for the e2e stub (default api.telegram.org)
//   timeoutMs, maxBytes, backoffMs[], queueMax    — the fail-dark budget
//   fetchImpl, log, clock                         — test seams
export function makeNotifier ({
  webhookUrl = '',
  telegramBotToken = '',
  telegramChatId = '',
  telegramApiBase = TELEGRAM_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  backoffMs = DEFAULT_BACKOFF_MS,
  queueMax = DEFAULT_QUEUE_MAX,
  fetchImpl = globalThis.fetch,
  log = console.warn
} = {}) {
  const targets = []
  if (webhookUrl) targets.push({ name: 'webhook' })
  if (telegramBotToken && telegramChatId) targets.push({ name: 'telegram' })
  const attempts = backoffMs.length + 1
  const stats = { sent: 0, failed: 0, dropped: 0, attempts: 0 }

  // Unconfigured: nothing at all. No queue, no worker, no fetch — and the panel
  // logs alerts either way (src/index.js keeps its console line).
  if (targets.length === 0) {
    return {
      enabled: false,
      targets: [],
      notify () { return Promise.resolve([]) },
      test () { return Promise.resolve({ enabled: false, results: [] }) },
      stats () { return { ...stats } },
      idle () { return Promise.resolve() },
      close () {}
    }
  }

  const queue = []
  let running = false
  let closed = false
  let idleWaiters = []

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })

  async function send (target, msg) {
    if (target.name === 'webhook') {
      // The one body shape that satisfies ntfy (title/message), Slack (text) and
      // Discord (content) simultaneously — each provider ignores the rest.
      const text = `${msg.title} — ${msg.message}`
      return postJson(webhookUrl, {
        title: msg.title,
        message: msg.message,
        text,
        content: text,
        channel: msg.channel,
        count: msg.count
      }, { 'x-title': headerSafe(msg.title) }, { timeoutMs, maxBytes, fetchImpl })
    }
    const base = String(telegramApiBase).replace(/\/+$/, '')
    return postJson(`${base}/bot${telegramBotToken}/sendMessage`, {
      chat_id: telegramChatId,
      text: `${msg.title}\n${msg.message}`,
      disable_web_page_preview: true
    }, {}, { timeoutMs, maxBytes, fetchImpl })
  }

  // Never throws: every outcome is a result row. Three attempts over ~30 s, then
  // the notification is DROPPED — a dead endpoint is a logged warning, never a
  // retry loop that outlives the incident it is reporting.
  async function deliver (target, msg) {
    let lastError = null
    for (let i = 0; i < attempts; i++) {
      if (closed) break
      if (i > 0) await sleep(backoffMs[i - 1])
      if (closed) break
      stats.attempts++
      try {
        const r = await send(target, msg)
        stats.sent++
        return { target: target.name, ok: true, status: r.status, attempts: i + 1 }
      } catch (err) {
        lastError = err.message || String(err)
      }
    }
    stats.failed++
    log(`[notify] ${target.name} notification DROPPED after ${attempts} attempt(s): ${lastError || 'closed'} — the panel is unaffected (fail-dark).`)
    return { target: target.name, ok: false, attempts, error: lastError || 'closed' }
  }

  // ONE flight at a time (the makeSourcesScheduler pattern): a burst of alerts
  // cannot open a burst of sockets, and ordering is preserved.
  async function pump () {
    if (running) return
    running = true
    try {
      while (queue.length && !closed) {
        const job = queue.shift()
        const results = []
        for (const t of targets) results.push(await deliver(t, job.msg))
        job.resolve(results)
      }
      // A close() mid-drain resolves the stragglers rather than leaving awaiters hanging.
      while (queue.length) queue.shift().resolve([{ ok: false, error: 'closed' }])
    } finally {
      running = false
      const waiters = idleWaiters
      idleWaiters = []
      for (const w of waiters) w()
    }
  }

  function enqueue (msg) {
    if (closed) return Promise.resolve([{ ok: false, error: 'closed' }])
    // Bounded: past the cap the OLDEST pending notification goes. Dropping the
    // stale one keeps the freshest state moving when an endpoint recovers.
    while (queue.length >= queueMax) {
      stats.dropped++
      queue.shift().resolve([{ ok: false, error: 'dropped (queue full)' }])
    }
    let resolve
    const done = new Promise((r) => { resolve = r })
    queue.push({ msg, resolve })
    pump().catch((err) => log('[notify] worker error (ignored):', err && (err.message || err)))
    return done
  }

  return {
    enabled: true,
    targets: targets.map((t) => t.name),

    // Fire-and-forget. Returns a promise for tests/CLI; production callers
    // (reports.onAlert) MUST NOT await it — that is the whole point.
    notify (alert) { return enqueue(renderAlert(alert)) },

    // POST /api/reports/test-notify + the `test-notify` CLI verb: same code path,
    // same targets, an obviously synthetic message.
    async test () {
      const results = await enqueue({
        title: 'Aliran: test notification',
        message: 'If you can read this, ops notifications are wired correctly. No viewer reported anything.',
        channel: null,
        count: 0
      })
      return { enabled: true, targets: targets.map((t) => t.name), results }
    },

    stats () { return { ...stats, queued: queue.length } },

    // Resolves once the worker has drained (test seam — nothing in the panel waits).
    idle () {
      if (!running && !queue.length) return Promise.resolve()
      return new Promise((r) => idleWaiters.push(r))
    },

    close () { closed = true }
  }
}
