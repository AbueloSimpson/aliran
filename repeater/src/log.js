// Structured logging (opt-in). LOG_FORMAT=json turns every console line into one
// JSON object per line — {ts, level, svc, msg} — for log shippers (Loki, ELK,
// CloudWatch, …). The default (unset or "text") keeps today's human lines
// byte-identical, so nothing changes for existing deploys.
//
// Implementation: console.log/warn/error are patched once at startup. That is
// deliberate — it catches every line the service (and its dependencies) prints
// without touching hundreds of call sites. info/warn go to stdout; error keeps
// its stderr semantics (docker/journald merge both into one stream anyway).
export function initLogging (svc) {
  const v = (process.env.LOG_FORMAT || '').trim().toLowerCase()
  if (v && v !== 'json' && v !== 'text') {
    console.warn(`log: unknown LOG_FORMAT "${process.env.LOG_FORMAT}" — using text`)
  }
  if (v !== 'json') return
  const render = (a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack || a.message
    try { return JSON.stringify(a) } catch { return String(a) }
  }
  const emit = (stream, level, args) => {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, svc, msg: args.map(render).join(' ') }) + '\n')
  }
  console.log = (...a) => emit(process.stdout, 'info', a)
  console.warn = (...a) => emit(process.stdout, 'warn', a)
  console.error = (...a) => emit(process.stderr, 'error', a)
}
