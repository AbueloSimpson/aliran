// Aliran broadcaster control UI — vanilla JS over the S12a control API only.
// Auth token lives in sessionStorage; any 401 drops back to the login view.
// Live status (ffmpeg/peers/registered/playlist) is polled every 5 s and patched
// into the table rows in place, so buttons, sort order and open dialogs never get
// clobbered. Channels render as a sortable/filterable TABLE: the old card stack was
// fine at 6 channels and unusable at 69.
'use strict'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const POLL_MS = 5000
const LOGS_POLL_MS = 2000 // logs dialog refresh while open
let token = sessionStorage.getItem('aliranControlToken')
let who = sessionStorage.getItem('aliranControlName') || ''
let channels = []
let panelConfigured = false
let caps = null // /api/capabilities — ffmpeg probe (protocols + deep-verified encoders)
let renderedShape = '' // meta fingerprint of the rendered rows (full re-render only on change)
let pollTimer = null

// view state (client-side only — never round-trips to the API)
let sortKey = 'state'
let sortDir = 1
let filterText = ''
let quickFilter = 'all'

// ---------------------------------------------------------------- api

async function api (method, path, body) {
  const headers = {}
  if (token) headers.authorization = 'Bearer ' + token
  if (body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
  const res = await fetch(path, { method, headers, body })
  let data = {}
  try { data = await res.json() } catch {}
  if (res.status === 401 && token) { logout(); throw new Error('session expired — sign in again') }
  if (!res.ok) throw new Error((data.error || 'HTTP ' + res.status) + (data.retryAfter ? ` — retry in ${data.retryAfter}s` : ''))
  return data
}

// ---------------------------------------------------------------- views

function show (view) {
  $('#login-view').hidden = view !== 'login'
  $('#app-view').hidden = view !== 'app'
}

function logout () {
  token = null
  sessionStorage.removeItem('aliranControlToken')
  sessionStorage.removeItem('aliranControlName')
  stopPoll()
  renderedShape = ''
  show('login')
}

$('#logout-btn').addEventListener('click', logout)
$('#side-toggle').addEventListener('click', () => $('#app-view').classList.toggle('side-open'))
$('#nav-add').addEventListener('click', () => { $('#add-panel').open = true })

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('#login-error')
  errEl.hidden = true
  try {
    const { token: t } = await api('POST', '/api/login', { username: $('#login-user').value.trim(), password: $('#login-pass').value })
    token = t
    who = $('#login-user').value.trim()
    sessionStorage.setItem('aliranControlToken', token)
    sessionStorage.setItem('aliranControlName', who)
    $('#login-pass').value = ''
    await enterApp()
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  }
})

async function enterApp () {
  $('#who').textContent = who
  show('app')
  // The probe runs once per broadcaster process; a slow/failed probe must not block the UI.
  api('GET', '/api/capabilities').then((c) => { caps = c; populateKindSelect() }).catch(() => {})
  populateKindSelect()
  await refresh()
  startPoll()
}

// ---------------------------------------------------------------- ingest kinds

const KIND_LABELS = {
  test: 'test pattern',
  pull: 'pull (URL)',
  file: 'file (path)',
  rtmp: 'RTMP push (OBS)',
  srt: 'SRT push (authenticated)',
  udp: 'UDP-TS push'
}
const PUSH_KINDS = ['rtmp', 'srt', 'udp']

// A push kind is offered only when the host ffmpeg build has the protocol. Unknown
// (probe still running / failed) counts as available — start() re-checks server-side.
function kindAvailable (kind) {
  if (!PUSH_KINDS.includes(kind)) return true
  return !caps || caps.protocols?.[kind] !== false
}

function populateKindSelect () {
  const sel = $('#nc-kind')
  const prev = sel.value
  sel.innerHTML = ''
  for (const kind of ['test', 'pull', 'file', ...PUSH_KINDS]) {
    if (PUSH_KINDS.includes(kind) && !kindAvailable(kind)) continue // hide what can't work
    const opt = document.createElement('option')
    opt.value = kind
    opt.textContent = KIND_LABELS[kind]
    sel.appendChild(opt)
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  syncSourceInput()
}

function syncSourceInput () {
  const kind = $('#nc-kind').value
  const src = $('#nc-source')
  src.hidden = !(kind === 'pull' || kind === 'file')
  src.placeholder = kind === 'file' ? 'file path' : 'source URL (https / rtsp / rtmp / srt / udp)'
}

$('#nc-kind').addEventListener('change', syncSourceInput)

function startPoll () {
  stopPoll()
  pollTimer = setInterval(() => { refresh().catch(() => {}) }, POLL_MS)
}

function stopPoll () {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

// ---------------------------------------------------------------- refresh + render

async function refresh () {
  const [status, list] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/channels')])
  channels = list
  panelConfigured = !!status.panelConfigured
  $('#panel-state').className = panelConfigured ? 'chip' : 'chip warn'
  $('#panel-state').innerHTML = panelConfigured
    ? 'panel &#10003;'
    : '<span title="set PANEL_PUBKEY + PUBLISHER_KEY to auto-register channels">panel not configured</span>'
  renderChannels()
  renderTiles()
  api('GET', '/api/incidents').then(renderIncidents).catch(() => {})
  // 24 h trends from the aggregate analytics rollups (S48) — best-effort, the
  // table renders fine without them (older broadcaster, or analytics disabled).
  api('GET', '/api/analytics?days=2').then(renderTrends).catch(() => {})
}

// Per-channel last-24h aggregates: peak/mean peer links + egress bytes. Peer
// figures render with "≥" — origin-side peer counts are a LOWER BOUND on
// audience, since viewers also serve each other (see docs/analytics.md).
function renderTrends (a) {
  if (!a || !a.enabled) return
  const cutoff = Date.now() - 24 * 3600000
  const agg = new Map() // id -> { peak, meanSum, meanN, egress }
  const fold = (dateStr, hourKey, entry) => {
    const t = Date.parse(dateStr + 'T00:00:00Z') + (+hourKey) * 3600000
    if (!(t >= cutoff) || !entry || !entry.channels) return
    for (const [id, c] of Object.entries(entry.channels)) {
      let x = agg.get(id)
      if (!x) { x = { peak: 0, meanSum: 0, meanN: 0, egress: 0 }; agg.set(id, x) }
      if (c.peers && typeof c.peers.max === 'number') x.peak = Math.max(x.peak, c.peers.max)
      if (c.peers && typeof c.peers.mean === 'number') { x.meanSum += c.peers.mean; x.meanN++ }
      x.egress += c.egressBytes || 0
    }
  }
  for (const d of a.days || []) for (const [h, e] of Object.entries(d.hours || {})) fold(d.date, h, e)
  if (a.current) fold(a.current.date, a.current.hour, a.current)
  for (const tr of document.querySelectorAll('#chan-rows tr[data-id]')) {
    const cell = tr.querySelector('.trend-cell')
    if (!cell) continue
    const x = agg.get(tr.dataset.id)
    if (!x) { cell.textContent = '—'; cell.classList.add('muted'); continue }
    const mean = x.meanN ? Math.round((x.meanSum / x.meanN) * 10) / 10 : 0
    cell.classList.remove('muted')
    cell.innerHTML = `<span title="last 24 h — peak ≥${x.peak} / mean ≥${mean} peer links (lower bound: viewers also serve each other) · ${esc(fmtBytes(x.egress))} sent to peers">≥${x.peak} pk · ${esc(fmtBytes(x.egress))}</span>`
  }
}

function fmtBytes (n) {
  if (n == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i]
}

// Correlated events only — a lone ffmpeg respawn never appears here. That is the point:
// at ~2.5 respawns per channel per hour, listing them individually would be the same
// noise that hid the 2026-07-21 fleet event in the first place.
function renderIncidents (list) {
  const card = $('#incidents-card')
  const ol = $('#incidents-list')
  if (!Array.isArray(list) || list.length === 0) { card.hidden = true; return }
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    if (s < 90) return s + 's ago'
    const m = Math.round(s / 60)
    return m < 90 ? m + 'm ago' : Math.round(m / 60) + 'h ago'
  }
  const describe = (e) => {
    if (e.type === 'fleet-restart') {
      const span = Math.max(1, Math.round(((e.lastAt || e.t) - (e.firstAt || e.t)) / 1000))
      return `<b>${e.channels}${e.of ? ' of ' + e.of : ''} channels restarted together</b> — ${e.restarts} respawns over ${span}s. Correlated, so this is an upstream or host event, not one flaky source.`
    }
    if (e.type === 'source-failover') return `<b>${esc(e.channel)}</b> failed over to backup source ${e.index} of ${(e.of || 1) - 1}`
    if (e.type === 'source-primary-retry') return `<b>${esc(e.channel)}</b> returned to its primary source`
    return esc(e.type)
  }
  ol.innerHTML = list.slice(0, 8).map((e) =>
    `<li><span class="when">${ago(e.t)}</span><span class="what">${describe(e)}</span></li>`).join('')
  $('#incidents-note').textContent = `· ${list.length} since this broadcaster started`
  card.hidden = false
}

// Every tile below is derived from real API values. Nothing here is decorative — if a
// number can't be sourced from /api/channels or /api/status it does not get a tile.
function renderTiles () {
  const total = channels.length
  const running = channels.filter((c) => c.running).length
  const onAir = channels.filter((c) => c.state === 'up').length
  const issues = channels.filter((c) => c.running && c.state !== 'up' && c.state !== 'starting').length
  const peers = channels.reduce((n, c) => n + (c.running ? (c.peers || 0) : 0), 0)
  const peerChannels = channels.filter((c) => c.running && c.peers > 0).length
  const restarts = channels.reduce((n, c) => n + (c.watchdog?.restarts || 0), 0)
  const unregistered = channels.filter((c) => c.running && !c.registered && c.registerError).length

  const tile = (k, v, s, cls) => `<div class="tile ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`
  $('#tiles').innerHTML = [
    tile('On air', onAir, `of ${total} channel${total === 1 ? '' : 's'}`, onAir === running && running > 0 ? 'ok' : ''),
    tile('Needs attention', issues, issues ? 'retrying or waiting' : 'none', issues ? 'warn' : ''),
    // Sum of per-channel swarm connections — NOT a viewer count. One viewer with S21
    // zap-prefetch on holds connections to its rail neighbours too, so a single person
    // browsing a category can show up here as 5-6. Label says "links" for that reason.
    tile('Peer links', peers, peerChannels ? `on ${peerChannels} channel${peerChannels === 1 ? '' : 's'} · not unique viewers` : 'no peers connected'),
    tile('Watchdog restarts', restarts, 'this broadcaster run', restarts > 0 ? 'warn' : ''),
    tile('Register errors', unregistered, unregistered ? 'channel(s) rejected' : 'none', unregistered ? 'err' : '')
  ].join('')

  const banner = $('#banner')
  if (total === 0) { banner.className = 'banner'; banner.textContent = 'No channels configured yet.'; return }
  if (issues || unregistered) {
    banner.className = 'banner warn'
    banner.textContent = `${onAir}/${running} live — ${issues + unregistered} need attention`
  } else if (running === 0) {
    banner.className = 'banner'
    banner.textContent = `${total} channel${total === 1 ? '' : 's'} configured, none running`
  } else {
    banner.className = 'banner ok'
    banner.textContent = `All ${running} running channel${running === 1 ? '' : 's'} live`
  }
}

function metaShape () {
  return JSON.stringify(channels.map((c) => [c.id, c.title, c.description, c.category, c.input, c.transcode, c.hls, c.feedKey, c.legacy, c.ingest]))
}

// Human summary of a typed input (see broadcaster/src/channel.js normalizeInput).
function inputSummary (input) {
  if (input == null) return '—'
  if (typeof input === 'string') return input // pre-S15a string (upgraded on boot)
  switch (input.kind) {
    case 'test': return 'test pattern'
    case 'file': return 'file ' + input.path
    case 'pull': return 'pull ' + input.url
    case 'rtmp': return `RTMP listener :${input.port}`
    case 'srt': return `SRT listener :${input.port}` + (input.passphrase ? ' 🔒' : ' (no passphrase!)')
    case 'udp': return `UDP-TS listener :${input.port}`
    default: return input.kind
  }
}

// Human summary of transcode settings (null = defaults = software x264 passthrough-ish).
function transcodeSummary (t) {
  if (!t) return 'libx264 (defaults)'
  if (t.encoder === 'copy') return 'copy (passthrough)'
  const bits = [t.encoder]
  if (t.resolution && t.resolution !== 'source') bits.push(t.resolution)
  if (t.fps && t.fps !== 'source') bits.push(t.fps + 'fps')
  if (t.videoBitrateKbps != null) bits.push(t.videoBitrateKbps + 'kbps')
  if (t.preset && t.preset !== 'balanced') bits.push(t.preset)
  // Only worth showing when it is not the default: 'auto' is what every channel carries.
  if (t.hwDecode === true) bits.push('GPU decode')
  else if (t.hwDecode === false && NVENC_UI.includes(t.encoder)) bits.push('CPU decode')
  if (t.gpu != null) bits.push('gpu' + t.gpu)
  if (t.audioTracks === 'all') bits.push('all audio')
  if (t.audioCodec && t.audioCodec !== 'aac') bits.push(t.audioCodec)
  if (t.logo?.path) bits.push('logo')
  if (t.subtitles?.path) bits.push('subs')
  return bits.join(' · ')
}

function renderChannels () {
  const body = $('#chan-rows')
  const shape = metaShape()
  if (shape !== renderedShape) {
    renderedShape = shape
    body.innerHTML = ''
    for (const c of channels) body.appendChild(channelRow(c))
  }
  for (const c of channels) updateStatus(c)
  applyView()
}

function channelRow (c) {
  const frag = document.createDocumentFragment()
  const tr = document.createElement('tr')
  tr.dataset.id = c.id
  const input = inputSummary(c.input)
  tr.innerHTML = `
    <td><span class="badge run-badge idle">STOPPED</span></td>
    <td>
      <div class="cell-chan">
        <span class="t" title="as seeded by this broadcaster — the PANEL is authoritative for title/description/category, so if it was edited there this may be stale">${esc(c.title)}</span>
        <span class="mono muted">${esc(c.id)}${c.legacy ? ' · <span class="badge legacy" title="env-configured channel (STREAM_ID) — legacy data layout">env</span>' : ''}</span>
        ${(c.category || []).length ? `<span class="muted" style="font-size:11px">${esc((c.category || []).join(' · '))}</span>` : ''}
      </div>
    </td>
    <td class="cell-input mono muted" title="${esc(input)} · ${esc(transcodeSummary(c.transcode))} · hls ${esc(c.hls?.time)}s ×${esc(c.hls?.listSize)}">${esc(input)}</td>
    <td class="cell-health"><span class="muted">stopped</span></td>
    <td class="num peers-cell muted">—</td>
    <td class="num restarts-cell muted">—</td>
    <td class="num trend-cell muted">—</td>
    <td class="num uptime-cell muted">—</td>
    <td><div class="row-actions">
      <button class="btn small primary" data-act="startstop">Start</button>
      ${c.ingest?.pushUrl ? '<button class="btn small" data-act="copy" title="copy the push URL for your encoder (OBS / ffmpeg / hardware)">Push URL</button>' : ''}
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small" data-act="logs" title="last ffmpeg log lines — why a source won't play">Logs</button>
      <button class="btn small danger" data-act="remove">×</button>
    </div></td>`
  tr.querySelector('[data-act=startstop]').addEventListener('click', (e) => startStop(c.id, e.currentTarget))
  tr.querySelector('[data-act=edit]').addEventListener('click', () => editChannel(c.id))
  tr.querySelector('[data-act=logs]').addEventListener('click', () => showLogs(c.id))
  tr.querySelector('[data-act=remove]').addEventListener('click', () => removeChannel(c.id))
  const copyBtn = tr.querySelector('[data-act=copy]')
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(c.ingest.pushUrl))

  // the inline "why is it unhealthy" tail lives in its own row under this one
  const logTr = document.createElement('tr')
  logTr.className = 'log-row'
  logTr.dataset.logFor = c.id
  logTr.hidden = true
  logTr.innerHTML = '<td colspan="9"><pre class="log-inline mono"></pre></td>'

  frag.appendChild(tr)
  frag.appendChild(logTr)
  return frag
}

async function copyText (text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('push URL copied')
  } catch {
    window.prompt('Copy the push URL:', text) // clipboard API blocked — manual fallback
  }
}

// One badge per channel state (S15c): ON AIR / waiting for publisher / backoff+exit.
function stateBadge (c) {
  switch (c.state) {
    case 'up': return { text: 'ON AIR', cls: 'live', tip: 'ffmpeg is up and the live edge is advancing' }
    // Short copy because it lives in a table cell now; the full wording that used to be
    // the badge label moved to the tooltip rather than being dropped.
    case 'waiting-input': return { text: 'WAITING', cls: 'warn', tip: 'listener is up — WAITING FOR PUBLISHER to connect' }
    case 'backoff': return { text: 'RETRYING' + (c.watchdog?.lastExit != null ? ` (${c.watchdog.lastExit})` : ''), cls: 'err', tip: 'ffmpeg exited; the watchdog is respawning it with backoff' }
    case 'starting': return { text: 'STARTING', cls: 'dim', tip: 'ffmpeg spawned, no playlist yet' }
    default: return { text: 'STOPPED', cls: 'idle', tip: 'not running' }
  }
}

// Sort rank for the Status column: most-urgent first, so an ops view surfaces
// problems at the top rather than sorting them alphabetically into the middle.
const STATE_RANK = { backoff: 0, 'waiting-input': 1, starting: 2, up: 3 }
const stateRank = (c) => (c.running ? (STATE_RANK[c.state] ?? 3) : 9)

// Patch the live bits (badge, health, counters, start/stop button, inline logs)
// without re-rendering the row.
function updateStatus (c) {
  const tr = $('#chan-rows').querySelector(`tr[data-id="${CSS.escape(c.id)}"]`)
  if (!tr) return
  const run = tr.querySelector('.run-badge')
  const badge = stateBadge(c)
  run.textContent = badge.text
  run.className = 'badge run-badge ' + badge.cls
  run.title = badge.tip || ''
  const btn = tr.querySelector('[data-act=startstop]')
  btn.textContent = c.running ? 'Stop' : 'Start'
  btn.classList.toggle('primary', !c.running)

  const health = tr.querySelector('.cell-health')
  const peersCell = tr.querySelector('.peers-cell')
  const restartsCell = tr.querySelector('.restarts-cell')
  const uptimeCell = tr.querySelector('.uptime-cell')
  updateInlineLogs(tr, c)

  const restarts = c.watchdog?.restarts || 0
  restartsCell.textContent = restarts || '—'
  restartsCell.className = 'num restarts-cell' + (restarts ? ' ' : ' muted')

  if (!c.running) {
    health.innerHTML = '<span class="muted">stopped</span>'
    peersCell.textContent = '—'; peersCell.className = 'num peers-cell muted'
    uptimeCell.textContent = '—'; uptimeCell.className = 'num uptime-cell muted'
    return
  }
  const bits = [
    c.ffmpegUp
      ? '<span class="badge ok">ffmpeg</span>'
      : `<span class="badge err">ffmpeg DOWN${c.ffmpegExit != null ? ' (' + esc(c.ffmpegExit) + ')' : ''}</span>`
  ]
  // Running on a backup is the single most important thing to surface: the channel looks
  // healthy but its primary source is down, and nobody would otherwise notice.
  if (c.sourceIndex > 0) {
    bits.push(`<span class="badge warn" title="primary source is failing — now pulling backup ${c.sourceIndex} of ${(c.sourceCount || 1) - 1}: ${esc(c.activeSource || '')}\nThe watchdog re-probes the primary automatically.">BACKUP ${c.sourceIndex}</span>`)
  }
  // SLATE is the other "healthy-looking but wrong" state, and the more misleading of the
  // two: a slated channel has ffmpeg up, a playlist, and peers — every other badge on this
  // row is green — while viewers are watching SOURCE OFFLINE bars. Without this the only
  // way to notice is to play the channel yourself.
  if (c.slate?.slated) {
    const since = c.slate.since ? ` for ${fmtUp(Date.now() - c.slate.since)}` : ''
    bits.push(`<span class="badge err" title="viewers are seeing the offline slate${since}, NOT the source — ${c.slate.failures || 0} consecutive failed respawns. The watchdog re-probes the real source periodically and drops the slate as soon as it comes back.">SLATE</span>`)
  }
  // Where the DECODE runs. 'auto' + the per-source CPU fallback mean the operator cannot
  // infer this from the channel's settings, and the difference is ~8x in CPU cost, so a
  // channel that quietly dropped to the CPU is worth seeing at a glance.
  if (c.hwDecode?.active) {
    bits.push(`<span class="badge ok" title="decoding on the GPU (NVDEC)${c.hwDecode.gpu != null ? ' — device ' + c.hwDecode.gpu : ''}">GPU</span>`)
  } else if (c.hwDecode?.fellBack) {
    bits.push('<span class="badge warn" title="GPU decode was requested but THIS SOURCE could not be decoded by the GPU (CUVID declined it — e.g. a 10-bit stream), so the watchdog fell back to the CPU decoder. The channel is fine, it just costs more CPU. A restart re-tries the GPU.">CPU (fell back)</span>')
  }
  if (c.registered) bits.push('<span class="badge ok">reg</span>')
  else if (c.registerError) bits.push(`<span class="badge err" title="${esc(c.registerError)}">reg ✗</span>`)
  else if (panelConfigured) bits.push('<span class="badge dim">registering…</span>')
  else bits.push('<span class="badge dim" title="set PANEL_PUBKEY + PUBLISHER_KEY to auto-register">no panel</span>')
  bits.push(c.playlist ? '<span class="badge ok">playlist</span>' : '<span class="badge dim">no playlist</span>')
  health.innerHTML = bits.join(' ')

  peersCell.textContent = c.peers ?? 0
  peersCell.className = 'num peers-cell'
  // Uptime = how long the CURRENT ffmpeg has been alive, not how long ago the operator
  // pressed Start. On a flaky source those differ by hours, and the ffmpeg clock is the
  // one that says whether media is actually flowing. Channel age lives in the tooltip.
  const ffSince = c.watchdog?.lastRestartAt ?? c.startedAt
  uptimeCell.textContent = ffSince ? fmtUp(Date.now() - ffSince) : '—'
  uptimeCell.className = 'num uptime-cell' + (ffSince ? '' : ' muted')
  uptimeCell.title = c.startedAt
    ? `ffmpeg up ${fmtUp(Date.now() - ffSince)} · channel started ${fmtUp(Date.now() - c.startedAt)} ago`
    : ''
}

// While a running channel is NOT healthy ('up'), surface its last few ffmpeg lines
// in the row beneath it — the diagnosis usually IS the last line.
async function updateInlineLogs (tr, c) {
  const logTr = tr.nextElementSibling
  if (!logTr || !logTr.classList.contains('log-row')) return
  const pre = logTr.querySelector('.log-inline')
  const show = c.running && c.state !== 'up' && c.state !== 'starting'
  if (!show) { logTr.hidden = true; return }
  try {
    const r = await api('GET', `/api/channels/${encodeURIComponent(c.id)}/logs?lines=3`)
    if (r.lines.length === 0) { logTr.hidden = true; return }
    pre.textContent = r.lines.map((e) => e.line).join('\n')
    logTr.hidden = tr.classList.contains('hidden-row') // stay hidden if the row is filtered out
  } catch { logTr.hidden = true }
}

function fmtUp (ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 90) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 90) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '')
}

// ---------------------------------------------------------------- filter + sort

function matchesQuick (c) {
  switch (quickFilter) {
    case 'onair': return c.state === 'up'
    case 'issues': return c.running && c.state !== 'up' && c.state !== 'starting'
    case 'stopped': return !c.running
    default: return true
  }
}

function matchesText (c) {
  if (!filterText) return true
  const hay = [c.id, c.title, (c.category || []).join(' '), inputSummary(c.input)].join(' ').toLowerCase()
  return hay.includes(filterText)
}

function sortValue (c) {
  switch (sortKey) {
    case 'id': return c.id.toLowerCase()
    case 'peers': return c.running ? (c.peers || 0) : -1
    case 'restarts': return c.watchdog?.restarts || 0
    case 'uptime': { const t = c.watchdog?.lastRestartAt ?? c.startedAt; return t ? Date.now() - t : -1 }
    default: return stateRank(c)
  }
}

// Reorders the existing DOM rows (each channel row drags its log row with it) and
// applies the filters. Called after every poll, so it must not rebuild anything.
function applyView () {
  const body = $('#chan-rows')
  const ordered = [...channels].sort((a, b) => {
    const av = sortValue(a); const bv = sortValue(b)
    if (av < bv) return -1 * sortDir
    if (av > bv) return 1 * sortDir
    return a.id.localeCompare(b.id)
  })
  let visible = 0
  for (const c of ordered) {
    const tr = body.querySelector(`tr[data-id="${CSS.escape(c.id)}"]`)
    if (!tr) continue
    const logTr = tr.nextElementSibling
    body.appendChild(tr)
    if (logTr && logTr.classList.contains('log-row')) body.appendChild(logTr)
    const ok = matchesQuick(c) && matchesText(c)
    tr.classList.toggle('hidden-row', !ok)
    if (logTr && logTr.classList.contains('log-row') && !ok) logTr.hidden = true
    if (ok) visible++
  }
  $('#row-count').textContent = channels.length
    ? `${visible} of ${channels.length} channel${channels.length === 1 ? '' : 's'}`
    : ''
  const empty = $('#empty-msg')
  if (channels.length === 0) { empty.hidden = false; empty.textContent = 'No channels yet — add one above.' } else if (visible === 0) { empty.hidden = false; empty.textContent = 'No channels match this filter.' } else empty.hidden = true

  for (const th of document.querySelectorAll('th.sortable')) {
    th.classList.toggle('sorted-asc', th.dataset.sort === sortKey && sortDir === 1)
    th.classList.toggle('sorted-desc', th.dataset.sort === sortKey && sortDir === -1)
  }
}

$('#filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); applyView() })
$('#quick-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-f]')
  if (!btn) return
  quickFilter = btn.dataset.f
  for (const b of $('#quick-filters').querySelectorAll('button')) b.classList.toggle('active', b === btn)
  applyView()
})
for (const th of document.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    if (sortKey === th.dataset.sort) sortDir = -sortDir
    else { sortKey = th.dataset.sort; sortDir = 1 }
    applyView()
  })
}

// ---------------------------------------------------------------- dialog helper

// fields: [{name, label, type='text', value, options?, placeholder?, title?}] → values
// object or null. Select options are strings or {value,label,disabled?,title?} (a
// disabled option still renders — e.g. an unverified encoder with the probe error as
// its tooltip). opts.onReady(inputs) runs after the fields are built, for wiring
// dynamic show/hide (the label wrapping input X is inputs[X].closest('label')).
function dialog (title, fields, { okLabel = 'Save', body = '', onReady = null } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#dlg')
    $('#dlg-title').textContent = title
    $('#dlg-ok').textContent = okLabel
    const holder = $('#dlg-body')
    holder.innerHTML = body
    const inputs = {}
    for (const f of fields) {
      const label = document.createElement('label')
      let input
      if (f.type === 'select') {
        input = document.createElement('select')
        for (const o of f.options) {
          const opt = document.createElement('option')
          if (typeof o === 'object') {
            opt.value = o.value
            opt.textContent = o.label ?? o.value
            if (o.disabled) opt.disabled = true
            if (o.title) opt.title = o.title
          } else { opt.value = o; opt.textContent = o }
          input.appendChild(opt)
        }
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea')
        input.rows = 3
      } else {
        input = document.createElement('input')
        input.type = f.type || 'text'
      }
      if (f.value != null) input.value = f.value
      if (f.placeholder) input.placeholder = f.placeholder
      if (f.title) label.title = f.title
      inputs[f.name] = input
      label.append(f.label, input)
      holder.appendChild(label)
    }
    if (onReady) onReady(inputs)
    const done = (ok) => {
      dlg.removeEventListener('close', onClose)
      if (dlg.open) dlg.close()
      resolve(ok ? Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) : null)
    }
    const onClose = () => done(false)
    $('#dlg-cancel').onclick = () => done(false)
    $('#dlg-form').onsubmit = (e) => { e.preventDefault(); done(true) }
    dlg.addEventListener('close', onClose)
    dlg.showModal()
    const first = Object.values(inputs)[0]
    if (first) first.focus()
  })
}

function toast (msg, isError) {
  const t = $('#toast')
  t.textContent = msg
  t.className = isError ? 'err' : ''
  t.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { t.hidden = true }, 3500)
}

// Run an API action, toast the outcome, refresh the data.
async function act (fn, okMsg) {
  try {
    await fn()
    if (okMsg) toast(okMsg)
    await refresh()
  } catch (err) {
    toast(err.message, true)
  }
}

// ---------------------------------------------------------------- channel actions

$('#add-channel-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const kind = $('#nc-kind').value
  const source = $('#nc-source').value.trim()
  let input
  if (kind === 'pull') {
    if (!source) return toast('pull needs a source URL', true)
    input = { kind: 'pull', url: source }
  } else if (kind === 'file') {
    if (!source) return toast('file needs a path', true)
    input = { kind: 'file', path: source }
  } else {
    input = { kind } // push kinds: port auto-allocated, stream key generated — see Edit
  }
  const body = {
    id: $('#nc-id').value.trim(),
    title: $('#nc-title').value.trim() || undefined,
    category: $('#nc-category').value.trim() || undefined,
    input
  }
  try {
    const r = await api('POST', '/api/channels', body)
    e.target.reset()
    syncSourceInput()
    await refresh()
    const push = r.input && PUSH_KINDS.includes(r.input.kind)
    await dialog(`Channel "${r.id}" created`, [], {
      okLabel: 'Done',
      body: `<p>Feed encryption key (persisted in this channel's <span class="mono">feed.key</span>):</p>
             <div class="keybox mono">${esc(r.encryptionKey)}</div>
             <p class="muted">Starting the channel delivers it to the panel automatically — you only need to
             copy it for a panel you administer by hand (admin-cli / panel dashboard add-stream).</p>` +
             (push ? `<p class="muted">Push ingest on port <b>${esc(r.input.port)}</b> — start the channel and
             copy the <b>push URL</b> from its row into your encoder. Remember to open the port in your
             firewall for the encoder's IP.</p>` : '')
    })
  } catch (err) { toast(err.message, true) }
})

async function startStop (id, btn) {
  const c = channels.find((x) => x.id === id)
  if (!c) return
  if (c.running) {
    const v = await dialog(`Stop "${id}"?`, [], {
      okLabel: 'Stop',
      body: '<p class="muted">Tears down ffmpeg and stops seeding — viewers lose the live feed. The feed identity (feed.key) is kept for the next start.</p>'
    })
    if (!v) return
  }
  btn.disabled = true
  try {
    await act(() => api('POST', `/api/channels/${encodeURIComponent(id)}/${c.running ? 'stop' : 'start'}`),
      c.running ? `channel "${id}" stopped` : `channel "${id}" started`)
  } finally { btn.disabled = false }
}

// Encoder choices come from the capability probe: everything the validator accepts is
// listed, but an encoder that is not deep-verified on THIS host renders disabled with
// the probe error as its tooltip — no silent fallback, no mystery start failures.
// GPU decode is an NVIDIA-only path (broadcaster/src/hls.js hwDecodeArgs), and the
// validator rejects hwDecode/gpu on any other encoder — so these two controls only appear
// for the encoders that can actually use them.
const NVENC_UI = ['h264_nvenc', 'hevc_nvenc']

// Mirrors broadcaster/src/hls.js CUSTOM_RES_RE — a free-form raster alongside the presets.
const CUSTOM_RES_UI = /^\d{2,5}x\d{2,5}$/

// auto / on / off. 'on' is a hard requirement the host must satisfy, so it renders disabled
// with the probe's own error as the tooltip when GPU decode is not usable here — same rule
// as an unverified encoder: no silent fallback, no mystery start failures.
function hwDecodeOptions () {
  const cuda = caps?.hwDecode?.cuda
  const usable = !caps || !!cuda?.verified // unknown probe = optimistic; start() re-checks
  return [
    {
      value: 'auto',
      label: usable ? 'auto — GPU when the host supports it' : 'auto — CPU here (no GPU decode on this host)',
      title: 'Recommended. Resolved against the host probe each time the channel starts, and falls back to the CPU by itself if a particular source turns out to be undecodable on the GPU.'
    },
    {
      value: 'on',
      label: 'on — require GPU decode' + (usable ? '' : ' — unavailable'),
      disabled: !usable,
      title: usable ? 'Refuses to start if the host cannot decode on the GPU.' : (cuda?.error || 'GPU decode is not usable on this host')
    },
    { value: 'off', label: 'off — always decode on the CPU', title: 'Costs roughly 8x the CPU of the GPU path on the same channel. Pick it to leave the GPU free for other work.' }
  ]
}

// Device picker built from nvidia-smi (caps.gpus). Naming the card matters because the
// realistic deployment is a SHARED box — "which one is the live encoder already using" is
// the question an index alone cannot answer.
function gpuOptions (current) {
  const list = caps?.gpus || []
  const opts = [{ value: '', label: 'auto — let ffmpeg choose', title: 'ffmpeg uses its default device, normally GPU 0.' }]
  for (const g of list) {
    const mem = g.memoryMb ? ` · ${Math.round(g.memoryMb / 1024)} GB` : ''
    opts.push({ value: String(g.index), label: `${g.index}: ${g.name}${mem}` })
  }
  // A configured index the probe did not list (nvidia-smi missing, or the card was pulled)
  // must still render, or opening Edit would silently reset it to auto on save.
  if (current != null && !list.some((g) => g.index === current)) {
    opts.push({ value: String(current), label: `${current} — not detected on this host`, title: 'Configured previously. Either nvidia-smi is unavailable here or this device is gone.' })
  }
  return opts
}

// HEVC roughly halves bitrate at the same quality — real bandwidth saved on a P2P feed.
// Both apps already decode it (fleets run HEVC channels as `copy` today), so the label says
// what it costs and gains rather than warning the operator off it. Still never a default:
// the set of devices that can decode HEVC is narrower than for H.264.
const ENCODER_NOTE = {
  h264_amf: ' (EXPERIMENTAL)',
  hevc_nvenc: ' (HEVC — about half the bitrate)',
  libx265: ' (HEVC, software — about half the bitrate, ~8x the CPU of hevc_nvenc)'
}

function encoderOptions (current) {
  const names = ['copy', 'libx264', 'h264_nvenc', 'hevc_nvenc', 'libx265', 'h264_qsv', 'h264_vaapi', 'h264_amf']
  return names.map((name) => {
    if (name === 'copy') return { value: 'copy', label: 'copy (passthrough — no re-encode)' }
    const e = caps?.encoders?.[name]
    const usable = !caps || (e && e.verified) // unknown probe = optimistic; start() re-checks
    const label = name + (ENCODER_NOTE[name] || '') + (usable ? '' : ' — unavailable')
    return {
      value: name,
      label,
      disabled: !usable && name !== current, // keep the saved value selectable so PATCH won't silently change it
      title: !usable ? (e?.error || (e && !e.listed ? 'not in this ffmpeg build' : 'probe failed')) : undefined
    }
  })
}

async function editChannel (id) {
  const c = channels.find((x) => x.id === id)
  if (!c) return
  const input = typeof c.input === 'object' && c.input ? c.input : { kind: 'test' }
  const t = c.transcode || {}
  const kindOpts = ['test', 'pull', 'file', ...PUSH_KINDS].map((k) => ({
    value: k,
    label: KIND_LABELS[k],
    disabled: !kindAvailable(k) && k !== input.kind,
    title: !kindAvailable(k) ? 'this ffmpeg build has no ' + k + ' protocol support' : undefined
  }))
  // Title / description / category are DELIBERATELY absent. They are panel-authoritative
  // (panel/src/rpc.js: the broadcaster seeds them when it first creates the catalog
  // record, and every re-register onto an existing record leaves them alone). Offering
  // them here would edit only the broadcaster's local copy while viewers kept seeing the
  // old value — a control that looks like it works and doesn't. Edit them in the panel.
  const v = await dialog(`Edit ${c.id}`, [
    { name: 'kind', label: 'Ingest', type: 'select', options: kindOpts, value: input.kind },
    { name: 'source', label: 'Source', value: input.url || input.path || '', placeholder: 'URL or file path' },
    {
      name: 'fallbacks',
      label: 'Backup sources (one URL per line, max 4)',
      type: 'textarea',
      value: (input.fallbacks || []).join('\n'),
      title: 'Tried in order when the primary keeps failing. The watchdog returns to the primary automatically once it recovers — failover is not sticky.'
    },
    { name: 'port', label: 'Listen port (blank = keep/auto)', type: 'number', value: input.port ?? '' },
    { name: 'streamKey', label: 'Stream key (blank = keep current)', value: input.streamKey ?? '', title: 'obscurity only — firewall the port; SRT+passphrase is the authenticated push' },
    { name: 'passphrase', label: 'SRT passphrase (10-79 chars; empty = unencrypted)', value: input.passphrase ?? '', title: 'SRT + passphrase = authenticated push (enforced by the SRT handshake)' },
    { name: 'latencyMs', label: 'SRT latency ms (20-5000)', type: 'number', value: input.latencyMs ?? '' },
    { name: 'timeoutMs', label: 'UDP idle timeout ms (1000-60000)', type: 'number', value: input.timeoutMs ?? '' },
    {
      name: 'cencKey',
      label: 'CENC decryption key (encrypted DASH, blank = none)',
      value: input.cencKey || '',
      placeholder: '32 hex characters',
      title: 'Decrypts a CENC/ClearKey .mpd source using a key you already hold. This is NOT a DRM client — Widevine and PlayReady need a licence server and a CDM, which ffmpeg does not have.'
    },
    { name: 'encoder', label: 'Encoder', type: 'select', options: encoderOptions(t.encoder), value: t.encoder || 'libx264' },
    {
      name: 'resolution',
      label: 'Resolution',
      type: 'select',
      options: ['source', '1080p', '720p', '480p', '360p', 'custom'],
      value: CUSTOM_RES_UI.test(t.resolution || '') ? 'custom' : (t.resolution || 'source')
    },
    {
      name: 'resolutionCustom',
      label: 'Custom size (WxH, both even)',
      value: CUSTOM_RES_UI.test(t.resolution || '') ? t.resolution : '',
      placeholder: '1280x720',
      title: 'Both numbers must be even — H.264 subsamples chroma 2x2 and rejects an odd raster. A preset scales by height and keeps the aspect; an explicit WxH is used exactly as typed, so it can letterbox or stretch.'
    },
    { name: 'fps', label: 'Frame rate', type: 'select', options: ['source', '24', '25', '30', '50', '60'], value: String(t.fps ?? 'source') },
    { name: 'videoBitrateKbps', label: 'Video bitrate kbps (blank = quality-based)', type: 'number', value: t.videoBitrateKbps ?? '' },
    { name: 'audioBitrateKbps', label: 'Audio bitrate kbps (blank = 128)', type: 'number', value: t.audioBitrateKbps ?? '' },
    {
      name: 'audioTracks',
      label: 'Audio tracks',
      type: 'select',
      options: [
        { value: 'first', label: 'first only (ffmpeg picks)' },
        { value: 'all', label: 'keep every track (multi-language)' }
      ],
      value: t.audioTracks || 'first',
      title: 'A multi-language source carries several audio tracks. The default keeps only the one ffmpeg judges best, which is how the wrong language ends up on air; "keep every track" carries them all as separate PIDs in the same segments.'
    },
    { name: 'audioCodec', label: 'Audio codec', type: 'select', options: ['aac', 'mp2', 'opus', 'copy'], value: t.audioCodec || 'aac' },
    { name: 'audioSampleRate', label: 'Audio sample rate', type: 'select', options: ['48000', '44100'], value: String(t.audioSampleRate ?? 48000) },
    {
      name: 'audioChannels',
      label: 'Audio channels',
      type: 'select',
      options: [{ value: '', label: 'keep source layout' }, { value: '1', label: 'mono' }, { value: '2', label: 'stereo' }, { value: '6', label: '5.1' }],
      value: t.audioChannels != null ? String(t.audioChannels) : ''
    },
    {
      name: 'logoPath',
      label: 'Logo image (path on the broadcaster, blank = none)',
      value: t.logo?.path || '',
      placeholder: '/srv/branding/logo.png',
      title: 'Burned into the picture, so viewers cannot turn it off. A PNG with transparency blends correctly. The file must exist on the BROADCASTER host, not on your machine.'
    },
    { name: 'logoCorner', label: 'Logo position', type: 'select', options: [{ value: 'tr', label: 'top right' }, { value: 'tl', label: 'top left' }, { value: 'br', label: 'bottom right' }, { value: 'bl', label: 'bottom left' }], value: t.logo?.corner || 'tr' },
    { name: 'logoMarginPx', label: 'Logo margin px', type: 'number', value: t.logo?.marginPx ?? 20 },
    { name: 'logoHeightPx', label: 'Logo height px (blank = native size)', type: 'number', value: t.logo?.heightPx ?? '' },
    {
      name: 'subtitlesPath',
      label: 'Burn in subtitles (.srt/.ass path, blank = none)',
      value: t.subtitles?.path || '',
      placeholder: '/srv/subs/channel.srt',
      title: 'Rendered into the picture itself. On the GPU path the frames make a round trip through system memory to do it, which costs roughly twice the GPU baseline — still well under decoding on the CPU.'
    },
    { name: 'preset', label: 'Encoder preset', type: 'select', options: ['fast', 'balanced', 'quality'], value: t.preset || 'balanced' },
    {
      name: 'hwDecode',
      label: 'GPU decode (NVDEC)',
      type: 'select',
      options: hwDecodeOptions(),
      value: t.hwDecode === true ? 'on' : t.hwDecode === false ? 'off' : 'auto',
      title: 'Decode and scale on the card instead of the CPU. Measured at ~8x less CPU per channel on the same output. The GPU encode session limit, not CPU, is what caps channels per box.'
    },
    {
      name: 'gpu',
      label: 'GPU device',
      type: 'select',
      options: gpuOptions(t.gpu ?? null),
      value: t.gpu != null ? String(t.gpu) : '',
      title: 'Pins BOTH the decoder and the encoder to one card. Use it to keep this channel off a GPU another service is already using.'
    },
    { name: 'probesizeKB', label: 'Probe size KB (blank = ffmpeg default ~5000)', type: 'number', value: c.ingestTuning?.probesizeKB ?? '', title: 'Raise for cheap HDMI/RTMP encoders with a sparse or late PMT — the cause of could-not-find-codec-parameters and of audio going missing. 10000-50000 is normal for a difficult box.' },
    { name: 'analyzeDurationMs', label: 'Analyze duration ms (blank = default ~5000)', type: 'number', value: c.ingestTuning?.analyzeDurationMs ?? '', title: 'How long ffmpeg may study the stream before deciding what is in it. Raise alongside probe size for irregular encoders.' },
    { name: 'threadQueueSize', label: 'Input queue packets (blank = ffmpeg default)', type: 'number', value: c.ingestTuning?.threadQueueSize ?? '', title: 'REAL input buffering: queue depth between demuxer and encoder. Raise to 512-4096 if the log says Thread message queue blocking — a bursty push source is overflowing it and dropping packets.' },
    { name: 'discardCorrupt', label: 'Tolerate corrupt packets', type: 'select', options: ['no', 'yes'], value: c.ingestTuning?.discardCorrupt ? 'yes' : 'no', title: 'Keep going through corrupt TS packets instead of aborting — marginal RF/HDMI capture chains produce them constantly.' },
    { name: 'genPts', label: 'Generate missing timestamps (genpts)', type: 'select', options: ['no', 'yes'], value: c.ingestTuning?.genPts ? 'yes' : 'no', title: 'Synthesise PTS for a source whose timestamps are missing or jump backwards. Without it the segmenter writes wrong EXTINF durations, or ffmpeg refuses packets with "non monotonically increasing dts". The segmenter needs a sane timeline more than the original one.' },
    { name: 'ignoreDts', label: 'Ignore DTS (igndts)', type: 'select', options: ['no', 'yes'], value: c.ingestTuning?.ignoreDts ? 'yes' : 'no', title: 'Let PTS drive and disregard DTS entirely. Use when DTS is the broken half; pairs with genpts on badly damaged sources.' },
    { name: 'ignoreDecodeErrors', label: 'Ignore decode errors', type: 'select', options: ['no', 'yes'], value: c.ingestTuning?.ignoreDecodeErrors ? 'yes' : 'no', title: 'Carry on through bitstream errors instead of treating them as fatal. Different from "tolerate corrupt packets": that drops bad packets at the container, this tells the DECODER to keep going with what it got.' },
    { name: 'userAgent', label: 'HTTP User-Agent (blank = ffmpeg default)', value: c.ingestTuning?.userAgent || '', placeholder: 'Mozilla/5.0 …', title: 'Many providers gate or vary on User-Agent, and ffmpeg’s default is a giveaway. HTTP sources only.' },
    { name: 'headers', label: 'Extra HTTP headers (one per line)', type: 'textarea', value: (c.ingestTuning?.headers || '').replace(/\r\n/g, '\n').trim(), placeholder: 'X-Auth-Token: …\nReferer: https://…', title: 'Auth tokens, Referer, cookies. Written one "Name: value" per line — CRLF termination is added for you. HTTP sources only.' },
    { name: 'rwTimeoutMs', label: 'HTTP read timeout ms (blank = none)', type: 'number', value: c.ingestTuning?.rwTimeoutMs ?? '', title: 'Fail a hung socket fast. Without it a frozen source waits on the watchdog stall detector, which only fires after the live edge has not moved for ~20 s. HTTP sources only.' },
    { name: 'fpsMode', label: 'Frame rate mode', type: 'select', options: [{ value: 'source', label: 'follow source' }, { value: 'cfr', label: 'constant (CFR)' }], value: c.transcode?.fpsMode || 'source', title: 'A variable-frame-rate source segments unevenly — EXTINF durations wander and players stutter at the joins. HLS wants CFR. Not the default because forcing it on an already-constant source only adds duplicated or dropped frames.' },
    { name: 'maxMuxQueue', label: 'Max muxing queue packets (blank = ffmpeg default)', type: 'number', value: c.transcode?.maxMuxQueue ?? '', title: '"Too many packets buffered for output stream" is a hard abort, not a warning. Raising this turns a dead channel into a brief memory bump. 2048 is a sane starting point.' },
    { name: 'audioSync', label: 'Correct audio drift', type: 'select', options: ['no', 'yes'], value: c.transcode?.audioSync ? 'yes' : 'no', title: 'On a 24/7 channel a source whose audio clock runs slightly off video walks visibly out of sync over hours, and nothing notices because every segment is individually fine. Re-encodes audio, so it cannot be combined with audio codec "copy".' },
    { name: 'tsMode', label: 'Timestamp handling', type: 'select', options: [{ value: 'default', label: 'leave alone' }, { value: 'avoidNegative', label: 'rebase to zero' }, { value: 'copyTs', label: 'preserve source timeline' }], value: c.transcode?.copyTs ? 'copyTs' : (c.transcode?.avoidNegativeTs ? 'avoidNegative' : 'default'), title: 'Rebase fixes a stream that starts at a negative timestamp (common after generating PTS). Preserve keeps the upstream timeline instead. They are opposite strategies, so this is one control rather than two checkboxes.' },
    { name: 'hlsTime', label: 'HLS segment seconds (1-30)', type: 'number', value: c.hls?.time },
    { name: 'hlsListSize', label: 'HLS window segments (2-64)', type: 'number', value: c.hls?.listSize }
  ], {
    body: `<p class="muted"><b>${esc(c.title)}</b>${(c.category || []).length ? ' · ' + esc((c.category || []).join(', ')) : ''}<br>
           Title, description and category are <b>panel-authoritative</b> — edit them in the panel
           admin dashboard. This broadcaster only seeds them when the channel is first created.</p>` +
          (c.running ? '<p class="muted">This channel is running — ingest/transcode changes apply on the next start. Changing the SOURCE rotates the feed identity (viewers follow automatically).</p>' : ''),
    onReady (inputs) {
      const showFor = {
        source: ['pull', 'file'],
        fallbacks: ['pull'], // backup urls only make sense for a pull source
        cencKey: ['pull'], // only a pulled manifest can be encrypted
        port: PUSH_KINDS,
        streamKey: ['rtmp'],
        passphrase: ['srt'],
        latencyMs: ['srt'],
        timeoutMs: ['udp']
      }
      // `copy` never decodes the picture, so everything that reshapes or draws on it is
      // meaningless there — and the validator rejects the logo/subtitle ones outright.
      // Audio settings deliberately stay visible: a video-copy channel still re-encodes
      // its audio, so codec/tracks/rate remain live controls.
      const encDetail = ['resolution', 'resolutionCustom', 'fps', 'videoBitrateKbps', 'preset',
        'logoPath', 'logoCorner', 'logoMarginPx', 'logoHeightPx', 'subtitlesPath']
      const nvencOnly = ['hwDecode', 'gpu'] // the validator rejects these on other encoders
      const logoDetail = ['logoCorner', 'logoMarginPx', 'logoHeightPx']
      const sync = () => {
        const kind = inputs.kind.value
        for (const [name, kinds] of Object.entries(showFor)) {
          inputs[name].closest('label').hidden = !kinds.includes(kind)
        }
        inputs.source.previousSibling.textContent = kind === 'file' ? 'File path' : 'Source URL'
        const copy = inputs.encoder.value === 'copy'
        for (const name of encDetail) inputs[name].closest('label').hidden = copy
        const nvenc = NVENC_UI.includes(inputs.encoder.value)
        for (const name of nvencOnly) inputs[name].closest('label').hidden = copy || !nvenc
        inputs.resolutionCustom.closest('label').hidden = copy || inputs.resolution.value !== 'custom'
        // Position/size only mean something once there is an image to place.
        const hasLogo = inputs.logoPath.value.trim() !== ''
        for (const name of logoDetail) inputs[name].closest('label').hidden = copy || !hasLogo
      }
      inputs.kind.addEventListener('change', sync)
      inputs.encoder.addEventListener('change', sync)
      inputs.resolution.addEventListener('change', sync)
      inputs.logoPath.addEventListener('input', sync)
      sync()
    }
  })
  if (!v) return
  // PATCH is partial (channel.js: `if (fields.title != null) …`), so omitting the
  // descriptive fields leaves the broadcaster's stored copy untouched rather than
  // blanking it. Only ingest/transcode/hls are this UI's business.
  const body = {}

  const kind = v.kind
  if (kind === 'pull' || kind === 'file') {
    const src = v.source.trim()
    if (!src) return toast(kind + ' input needs a ' + (kind === 'file' ? 'path' : 'URL'), true)
    // Always send fallbacks for a pull (even empty) so clearing the box actually clears
    // them — normalizeInput treats OMITTED as "keep stored" and [] as "clear".
    // cencKey is sent for every pull (even empty) for the same reason as fallbacks:
    // omitted means "keep the stored key", so clearing the box has to be explicit.
    body.input = kind === 'pull'
      ? {
          kind,
          url: src,
          fallbacks: v.fallbacks.split('\n').map((x) => x.trim()).filter(Boolean),
          cencKey: v.cencKey.trim()
        }
      : { kind, path: src }
  } else if (PUSH_KINDS.includes(kind)) {
    const inp = { kind }
    if (v.port !== '') inp.port = Number(v.port) // blank = inherit (same kind) or auto-alloc
    if (kind === 'rtmp' && v.streamKey.trim() !== '') inp.streamKey = v.streamKey.trim()
    if (kind === 'srt') {
      inp.passphrase = v.passphrase.trim() // '' is explicit: unencrypted push
      if (v.latencyMs !== '') inp.latencyMs = Number(v.latencyMs)
    }
    if (kind === 'udp' && v.timeoutMs !== '') inp.timeoutMs = Number(v.timeoutMs)
    body.input = inp
  } else {
    body.input = { kind: 'test' }
  }

  // Audio settings apply to `copy` too — only the video half is passed through.
  const audio = {
    audioTracks: v.audioTracks,
    audioCodec: v.audioCodec,
    audioSampleRate: Number(v.audioSampleRate),
    audioChannels: v.audioChannels === '' ? null : Number(v.audioChannels),
    audioSync: v.audioSync === 'yes',
    ...(v.audioBitrateKbps !== '' ? { audioBitrateKbps: Number(v.audioBitrateKbps) } : {})
  }
  // One control, two mutually exclusive flags — the validator rejects both together.
  const ts = {
    avoidNegativeTs: v.tsMode === 'avoidNegative',
    copyTs: v.tsMode === 'copyTs'
  }
  const stability = { maxMuxQueue: v.maxMuxQueue === '' ? null : Number(v.maxMuxQueue), ...ts }
  const logoPath = v.logoPath.trim()
  const subsPath = v.subtitlesPath.trim()
  const resolution = v.resolution === 'custom' ? v.resolutionCustom.trim() : v.resolution
  if (v.encoder !== 'copy' && v.resolution === 'custom' && !CUSTOM_RES_UI.test(resolution)) {
    return toast('custom resolution must look like 1280x720', true)
  }
  body.transcode = v.encoder === 'copy'
    ? { encoder: 'copy', ...audio, ...stability } // fpsMode is refused on copy
    : {
        encoder: v.encoder,
        resolution,
        fps: v.fps === 'source' ? 'source' : Number(v.fps),
        fpsMode: v.fpsMode,
        preset: v.preset,
        ...audio,
        ...stability,
        // Always sent, so clearing the box actually removes the logo/subtitles rather than
        // leaving the stored value in place (normalizeTranscode treats null as "clear").
        logo: logoPath
          ? {
              path: logoPath,
              corner: v.logoCorner,
              marginPx: v.logoMarginPx === '' ? 20 : Number(v.logoMarginPx),
              heightPx: v.logoHeightPx === '' ? null : Number(v.logoHeightPx)
            }
          : null,
        subtitles: subsPath ? { path: subsPath } : null,
        ...(v.videoBitrateKbps !== '' ? { videoBitrateKbps: Number(v.videoBitrateKbps) } : {}),
        ...(v.audioBitrateKbps !== '' ? { audioBitrateKbps: Number(v.audioBitrateKbps) } : {}),
        // Sent only for NVENC: normalizeTranscode REJECTS an explicit hwDecode/gpu on any
        // other encoder, so posting them for libx264 would turn a harmless hidden control
        // into a save that fails. gpu is always sent for nvenc (null clears a previous pin).
        ...(NVENC_UI.includes(v.encoder)
          ? {
              hwDecode: v.hwDecode === 'auto' ? 'auto' : v.hwDecode === 'on',
              gpu: v.gpu === '' ? null : Number(v.gpu)
            }
          : {})
      }

  // Demuxer tuning: blank means "use ffmpeg's default", so send null rather than 0.
  const num = (x) => (String(x).trim() === '' ? null : Number(x))
  body.ingestTuning = {
    probesizeKB: num(v.probesizeKB),
    analyzeDurationMs: num(v.analyzeDurationMs),
    threadQueueSize: num(v.threadQueueSize),
    discardCorrupt: v.discardCorrupt === 'yes',
    genPts: v.genPts === 'yes',
    ignoreDts: v.ignoreDts === 'yes',
    ignoreDecodeErrors: v.ignoreDecodeErrors === 'yes',
    userAgent: v.userAgent.trim(),
    headers: v.headers.trim(),
    rwTimeoutMs: num(v.rwTimeoutMs)
  }
  if (v.hlsTime !== '') body.hlsTime = v.hlsTime
  if (v.hlsListSize !== '') body.hlsListSize = v.hlsListSize
  act(async () => {
    const r = await api('PATCH', `/api/channels/${encodeURIComponent(id)}`, body)
    toast(r.restartRequired ? `"${id}" updated — changes apply on next start` : `"${id}" updated`)
  })
}

// Logs dialog: the channel's ffmpeg stderr ring, refreshed every 2 s while open.
async function showLogs (id) {
  const closed = dialog(`Logs — ${id}`, [], {
    okLabel: 'Close',
    body: '<div class="logmeta muted"></div><pre class="logbox mono">loading…</pre>'
  })
  const render = async () => {
    const box = $('#dlg .logbox')
    if (!box) return
    try {
      const r = await api('GET', `/api/channels/${encodeURIComponent(id)}/logs?lines=400`)
      const meta = $('#dlg .logmeta')
      if (meta) meta.textContent = `${r.state}${r.running ? ` · ${r.restarts} watchdog restart${r.restarts === 1 ? '' : 's'} this run` : ''} · refreshes every 2 s`
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24
      box.textContent = r.lines.length
        ? r.lines.map((e) => `${new Date(e.t).toLocaleTimeString()}  ${e.line}`).join('\n')
        : '(no ffmpeg output yet — the ring clears on every operator start)'
      if (atBottom) box.scrollTop = box.scrollHeight // follow the tail unless scrolled up
    } catch (err) {
      box.textContent = 'failed to fetch logs: ' + err.message
    }
  }
  await render()
  const timer = setInterval(render, LOGS_POLL_MS)
  await closed
  clearInterval(timer)
}

async function removeChannel (id) {
  const c = channels.find((x) => x.id === id)
  if (!c) return
  if (c.running) return toast(`stop "${id}" before removing it`, true)
  const v = await dialog(`Remove "${id}" from the registry?`, [], {
    okLabel: 'Remove',
    body: '<p class="muted">Only the registry entry goes away — the channel\'s store (feed identity + media) is kept on disk, and re-adding the same id reuses it.</p>'
  })
  if (!v) return
  act(() => api('DELETE', `/api/channels/${encodeURIComponent(id)}`), `channel "${id}" removed (data kept on disk)`)
}

// ---------------------------------------------------------------- boot

;(async () => {
  if (!token) return show('login')
  try { await enterApp() } catch { logout() }
})()

// ---------------------------------------------------------------- backup & restore
//
// Three artifacts, three handling rules (docs/kb/backup-and-rotation.md):
//   recovery archive  — the whole volume. Made and applied ON THE BOX: a cold backup stops
//                       the broadcaster, so it cannot make one for itself and still answer.
//                       This card LISTS them and shows the commands.
//   config snapshot   — channels.json exactly as it is, stream keys and passphrases
//                       included. Stays on the box; the API never serves the contents.
//   config template   — the same lineup with every credential removed. Downloadable.
//
// The warnings are the feature. A template import re-keys every push channel, and a stale
// archive restore forks a store. Both look like success unless something says otherwise.

let backupState = { caps: null, snapshots: [], archives: null }
let backupLoaded = false

async function loadBackup () {
  const [caps, snaps, arch] = await Promise.all([
    api('GET', '/api/config'),
    api('GET', '/api/config/snapshots'),
    api('GET', '/api/backups')
  ])
  backupState = { caps, snapshots: snaps.snapshots, archives: arch }
  backupLoaded = true
  renderBackup()
}

function fmtAge (hours) {
  if (hours == null) return '—'
  if (hours < 1) return Math.round(hours * 60) + ' min'
  if (hours < 48) return hours.toFixed(1) + ' h'
  return Math.round(hours / 24) + ' days'
}

function renderBackup () {
  const { caps, snapshots, archives } = backupState
  if (caps) $('#bk-snap-dir').textContent = 'stored in ' + caps.snapshotDir

  const tb = $('#bk-snap-table tbody')
  if (!snapshots.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">No snapshot yet. The broadcaster takes one automatically before you delete a channel.</td></tr>'
  } else {
    tb.innerHTML = snapshots.map((s) => {
      // A damaged snapshot is shown, never hidden: an operator must not believe they hold
      // a rollback point that cannot be read.
      if (s.unreadable) {
        return '<tr><td class="mono">' + esc(s.id) + '</td>' +
          '<td colspan="3"><span class="freshness stale">damaged</span> <span class="muted">' + esc(s.unreadable) + '</span></td>' +
          '<td><button class="btn small danger" data-snap-del="' + esc(s.id) + '">Delete</button></td></tr>'
      }
      const m = s.meta || {}
      return '<tr>' +
        '<td>' + esc(new Date(s.createdAt).toLocaleString()) + '<div class="muted mono">' + esc(s.id) + '</div></td>' +
        '<td>' + esc(s.note || '—') + '</td>' +
        '<td class="muted">' + (m.channels || 0) + ' channels · ' + (m.pushChannels || 0) + ' push</td>' +
        '<td class="muted">' + fmtBytes(s.bytes) + '</td>' +
        '<td><button class="btn small" data-snap-restore="' + esc(s.id) + '">Restore…</button> ' +
        '<button class="btn small danger" data-snap-del="' + esc(s.id) + '">Delete</button></td></tr>'
    }).join('')
  }

  const ab = $('#bk-arch-table tbody')
  $('#bk-arch-note').textContent = archives.available
    ? 'Found in ' + archives.dir + ' on the box.'
    : 'The broadcaster cannot see the archive directory: ' + archives.reason + '. Your archives can still exist. This dashboard cannot read them.'
  $('#bk-arch-why').textContent = archives.why || ''
  if (!archives.available || !archives.archives.length) {
    ab.innerHTML = '<tr><td colspan="4" class="muted">' +
      (archives.available ? 'No archive found. Run the backup command below.' : 'Nothing to show.') + '</td></tr>'
  } else {
    ab.innerHTML = archives.archives.map((a) =>
      '<tr><td class="mono">' + esc(a.name) + (a.legacyName ? ' <span class="muted">(old name format)</span>' : '') + '</td>' +
      '<td>' + fmtAge(a.ageHours) + '</td>' +
      '<td class="muted">' + fmtBytes(a.bytes) + '</td>' +
      '<td>' + (a.newest ? '<span class="freshness newest">newest — restore this one</span> ' : '') +
      '<span class="freshness ' + a.freshness + '">' + a.freshness + '</span></td></tr>'
    ).join('')
  }

  // The plain restore is offered on its own; the forcing variant is a separate, labelled
  // block, so --force is always a second deliberate copy.
  const c = archives.commands || {}
  $('#bk-arch-cmds').innerHTML = [
    c.assumes ? '<p class="muted">' + esc(c.assumes) + '</p>' : '',
    cmdBlock('Make an archive now (on the box)', c.backup),
    cmdBlock('Make one every hour (crontab -e)', c.cron),
    cmdBlock('Restore the newest archive', c.restore),
    cmdBlock('Only if the volume already holds data — this DELETES the contents first', c.restoreForce, true)
  ].join('')

  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); toast('command copied') } catch { toast('copy failed — select the text instead', true) }
    }
  }
  for (const btn of document.querySelectorAll('[data-snap-restore]')) btn.onclick = () => restoreSnapshot(btn.dataset.snapRestore)
  for (const btn of document.querySelectorAll('[data-snap-del]')) btn.onclick = () => deleteSnapshot(btn.dataset.snapDel)
}

function cmdBlock (label, cmd, danger) {
  if (!cmd) return ''
  return '<div class="cmd-block"><label>' + esc(label) + '</label>' +
    '<div class="cmd-row' + (danger ? ' force' : '') + '"><code>' + esc(cmd) + '</code>' +
    '<button class="btn small" data-copy="' + esc(cmd) + '">Copy</button></div></div>'
}

// Every list is shown, including the empty ones, so "this changes nothing" is visible
// rather than inferred from a short list.
function planBody (plan, title) {
  const line = (label, items, fmt) => {
    const text = items.length ? esc(items.map(fmt || ((x) => x)).join(', ')) : '<span class="plan-empty">none</span>'
    return '<p class="muted" style="margin:6px 0 0"><b>' + esc(label) + ':</b> ' + text + '</p>'
  }
  const parts = ['<p class="muted">' + esc(title) + '</p>']
  parts.push(line('Channels added', plan.add || [], (x) => x.id))
  parts.push(line('Channels changed', plan.update || [], (x) => x.id + (x.restartRequired ? ' (needs a restart)' : '')))
  parts.push(line('Channels removed', (plan.extra || []).filter((x) => x.willRemove), (x) => x.id))
  parts.push(line('Channels left alone', (plan.extra || []).filter((x) => !x.willRemove), (x) => x.id))
  for (const w of plan.warnings || []) parts.push('<p class="warn-line">' + esc(w) + '</p>')
  return parts.join('')
}

async function restoreSnapshot (id) {
  try {
    const plan = await api('POST', '/api/config/snapshots/' + encodeURIComponent(id) + '/plan', {})
    const body = planBody(plan, 'This is what a restore changes. Nothing has changed yet.') +
      '<p class="warn-line">The broadcaster takes a snapshot of the config as it is now, first. You can go back to it.</p>' +
      '<p class="muted">A channel that runs now keeps running. A change to its input applies when you restart it.</p>'
    if (!await dialog('Restore this snapshot?', [], { body, okLabel: 'Restore' })) return
    const r = await api('POST', '/api/config/snapshots/' + encodeURIComponent(id) + '/restore', { confirm: true })
    toast(r.summary || 'restored')
    if (r.result && r.result.failed && r.result.failed.length) {
      toast(r.result.failed.length + ' channel(s) failed: ' + r.result.failed.map((f) => f.id).join(', '), true)
    }
    await refresh()
    await loadBackup()
  } catch (err) { toast(err.message, true) }
}

async function deleteSnapshot (id) {
  const body = '<p class="mono">' + esc(id) + '</p>' +
    '<p class="warn-line">You cannot undo this. This snapshot is the only copy of the config at that moment, including the stream keys.</p>'
  if (!await dialog('Delete this snapshot?', [], { body, okLabel: 'Delete' })) return
  try {
    await api('DELETE', '/api/config/snapshots/' + encodeURIComponent(id))
    toast('snapshot deleted')
    await loadBackup()
  } catch (err) { toast(err.message, true) }
}

$('#nav-backup').addEventListener('click', () => { loadBackup().catch((err) => toast(err.message, true)) })

$('#bk-snap-take').addEventListener('click', async () => {
  const v = await dialog('Take a snapshot', [{ name: 'note', label: 'Note (optional)', placeholder: 'why you took this one' }], { okLabel: 'Take snapshot' })
  if (!v) return
  try {
    const r = await api('POST', '/api/config/snapshots', { note: v.note || '' })
    toast('snapshot ' + r.id + ' taken (' + fmtBytes(r.bytes) + ')')
    await loadBackup()
  } catch (err) { toast(err.message, true) }
})

$('#bk-tpl-download').addEventListener('click', async () => {
  try {
    const tpl = await api('GET', '/api/config/template')
    // Belt and braces on the client too: never write a file that says it holds secrets.
    if (tpl.contains !== 'no-secrets') { toast('refused: this file is not a secret-free template', true); return }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'broadcaster-template-' + stamp + '.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    toast('template downloaded — ' + tpl.omitted.length + ' field group(s) removed')
  } catch (err) { toast(err.message, true) }
})

$('#bk-tpl-import').addEventListener('click', () => $('#bk-tpl-file').click())

$('#bk-tpl-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]
  e.target.value = '' // let the operator pick the same file twice
  if (!file) return
  try {
    const template = JSON.parse(await file.text())
    const plan = await api('POST', '/api/config/template/plan', { template })
    const body = planBody(plan, 'This is what importing ' + file.name + ' changes. Nothing has changed yet.')
    if (!await dialog('Import this template?', [], { body, okLabel: 'Import' })) return
    const r = await api('POST', '/api/config/template/import', { template, confirm: true })
    toast(r.summary || 'imported')
    await refresh()
    await loadBackup()
  } catch (err) { toast(err.message, true) }
})
