// Aliran broadcaster control UI — vanilla JS over the S12a control API only.
// Auth token lives in sessionStorage; any 401 drops back to the login view.
// Live status (ffmpeg/peers/registered/playlist) is polled every 5 s and patched
// into the cards in place, so buttons and open dialogs never get clobbered.
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
let renderedShape = '' // meta fingerprint of the rendered cards (full re-render only on change)
let pollTimer = null

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
  $('#status-chips').innerHTML =
    `<span class="chip"><b>${status.channels}</b> channel${status.channels === 1 ? '' : 's'}</span>` +
    `<span class="chip"><b>${status.running}</b> running</span>` +
    (panelConfigured
      ? '<span class="chip">panel ✓</span>'
      : '<span class="chip warn" title="set PANEL_PUBKEY + PUBLISHER_KEY to auto-register channels">panel not configured</span>')
  renderChannels()
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
  return bits.join(' · ')
}

function renderChannels () {
  const list = $('#channels-list')
  const shape = metaShape()
  if (shape !== renderedShape) {
    renderedShape = shape
    list.innerHTML = ''
    if (channels.length === 0) list.innerHTML = '<div class="card muted">No channels yet — add one above.</div>'
    else for (const c of channels) list.appendChild(channelCard(c))
  }
  for (const c of channels) updateStatus(c)
}

function channelCard (c) {
  const card = document.createElement('div')
  card.className = 'card chan-card'
  card.dataset.id = c.id
  card.innerHTML = `
    <div class="chan-head">
      <h3>${esc(c.title)}</h3>
      <span class="mono muted">${esc(c.id)}</span>
      <span class="badge run-badge idle">STOPPED</span>
      ${c.legacy ? '<span class="badge legacy" title="env-configured channel (STREAM_ID) — legacy data layout">env</span>' : ''}
      ${(c.category || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
    </div>
    <p class="chan-desc">${esc(c.description) || '<i>no description</i>'}</p>
    <div class="status-strip"><span class="muted">stopped</span></div>
    <pre class="log-inline mono" hidden></pre>
    <div class="mono muted">input: ${esc(inputSummary(c.input))} · ${esc(transcodeSummary(c.transcode))} · hls ${esc(c.hls?.time)}s ×${esc(c.hls?.listSize)} · feed: ${c.feedKey ? esc(c.feedKey.slice(0, 16)) + '…' : '(on first start)'}</div>
    ${c.ingest?.pushUrl ? `
    <div class="push-row">
      <span class="muted">push URL</span>
      <span class="mono push-url">${esc(c.ingest.pushUrl)}</span>
      <button class="btn small" data-act="copy" title="copy the push URL for your encoder (OBS / ffmpeg / hardware)">copy</button>
    </div>` : ''}
    <div class="chan-foot">
      <button class="btn small primary" data-act="startstop">Start</button>
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small" data-act="logs" title="last ffmpeg log lines — why a source won't play">Logs</button>
      <button class="btn small danger" data-act="remove">Remove</button>
    </div>`
  card.querySelector('[data-act=startstop]').addEventListener('click', (e) => startStop(c.id, e.currentTarget))
  card.querySelector('[data-act=edit]').addEventListener('click', () => editChannel(c.id))
  card.querySelector('[data-act=logs]').addEventListener('click', () => showLogs(c.id))
  card.querySelector('[data-act=remove]').addEventListener('click', () => removeChannel(c.id))
  const copyBtn = card.querySelector('[data-act=copy]')
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(c.ingest.pushUrl))
  return card
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
    case 'up': return { text: 'ON AIR', cls: 'live' }
    case 'waiting-input': return { text: 'WAITING FOR PUBLISHER', cls: 'warn' }
    case 'backoff': return { text: 'RETRYING' + (c.watchdog?.lastExit != null ? ` (exit ${c.watchdog.lastExit})` : ''), cls: 'err' }
    case 'starting': return { text: 'STARTING', cls: 'dim' }
    default: return { text: 'STOPPED', cls: 'idle' }
  }
}

// Patch the live bits (run badge, status strip, start/stop button, inline logs)
// without re-rendering.
function updateStatus (c) {
  const card = $('#channels-list').querySelector(`[data-id="${CSS.escape(c.id)}"]`)
  if (!card) return
  const run = card.querySelector('.run-badge')
  const badge = stateBadge(c)
  run.textContent = badge.text
  run.className = 'badge run-badge ' + badge.cls
  const btn = card.querySelector('[data-act=startstop]')
  btn.textContent = c.running ? 'Stop' : 'Start'
  btn.classList.toggle('primary', !c.running)
  const strip = card.querySelector('.status-strip')
  updateInlineLogs(card, c)
  if (!c.running) { strip.innerHTML = '<span class="muted">stopped</span>'; return }
  const bits = [
    c.ffmpegUp
      ? '<span class="badge ok">ffmpeg ✓</span>'
      : `<span class="badge err">ffmpeg DOWN${c.ffmpegExit != null ? ' (exit ' + esc(c.ffmpegExit) + ')' : ''}</span>`,
    `<span class="chip"><b>${c.peers}</b> peer${c.peers === 1 ? '' : 's'}</span>`
  ]
  if (c.registered) bits.push('<span class="badge ok">registered ✓</span>')
  else if (c.registerError) bits.push(`<span class="badge err" title="${esc(c.registerError)}">register ✗</span>`)
  else if (panelConfigured) bits.push('<span class="badge dim">registering…</span>')
  else bits.push('<span class="badge dim" title="set PANEL_PUBKEY + PUBLISHER_KEY to auto-register">no panel</span>')
  bits.push(c.playlist ? '<span class="badge ok">playlist ✓</span>' : '<span class="badge dim">no playlist yet</span>')
  if (c.watchdog?.restarts > 0) bits.push(`<span class="chip" title="watchdog respawns of ffmpeg this run">${c.watchdog.restarts} restart${c.watchdog.restarts === 1 ? '' : 's'}</span>`)
  if (c.startedAt) bits.push(`<span class="chip">up ${fmtUp(Date.now() - c.startedAt)}</span>`)
  strip.innerHTML = bits.join(' ')
}

// While a running channel is NOT healthy ('up'), surface its last few ffmpeg lines
// right on the card — the diagnosis usually IS the last line.
async function updateInlineLogs (card, c) {
  const pre = card.querySelector('.log-inline')
  if (!pre) return
  const show = c.running && c.state !== 'up' && c.state !== 'starting'
  if (!show) { pre.hidden = true; return }
  try {
    const r = await api('GET', `/api/channels/${encodeURIComponent(c.id)}/logs?lines=3`)
    if (r.lines.length === 0) { pre.hidden = true; return }
    pre.textContent = r.lines.map((e) => e.line).join('\n')
    pre.hidden = false
  } catch { pre.hidden = true }
}

function fmtUp (ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 90) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 90) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '')
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
             copy the <b>push URL</b> from its card into your encoder. Remember to open the port in your
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
function encoderOptions (current) {
  const names = ['copy', 'libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_amf']
  return names.map((name) => {
    if (name === 'copy') return { value: 'copy', label: 'copy (passthrough — no re-encode)' }
    const e = caps?.encoders?.[name]
    const usable = !caps || (e && e.verified) // unknown probe = optimistic; start() re-checks
    const label = name + (name === 'h264_amf' ? ' (EXPERIMENTAL)' : '') + (usable ? '' : ' — unavailable')
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
  const v = await dialog(`Edit ${c.id}`, [
    { name: 'title', label: 'Title', value: c.title },
    { name: 'description', label: 'Description', type: 'textarea', value: c.description },
    { name: 'category', label: 'Category (comma-separated)', value: (c.category || []).join(', ') },
    { name: 'kind', label: 'Ingest', type: 'select', options: kindOpts, value: input.kind },
    { name: 'source', label: 'Source', value: input.url || input.path || '', placeholder: 'URL or file path' },
    { name: 'port', label: 'Listen port (blank = keep/auto)', type: 'number', value: input.port ?? '' },
    { name: 'streamKey', label: 'Stream key (blank = keep current)', value: input.streamKey ?? '', title: 'obscurity only — firewall the port; SRT+passphrase is the authenticated push' },
    { name: 'passphrase', label: 'SRT passphrase (10-79 chars; empty = unencrypted)', value: input.passphrase ?? '', title: 'SRT + passphrase = authenticated push (enforced by the SRT handshake)' },
    { name: 'latencyMs', label: 'SRT latency ms (20-5000)', type: 'number', value: input.latencyMs ?? '' },
    { name: 'timeoutMs', label: 'UDP idle timeout ms (1000-60000)', type: 'number', value: input.timeoutMs ?? '' },
    { name: 'encoder', label: 'Encoder', type: 'select', options: encoderOptions(t.encoder), value: t.encoder || 'libx264' },
    { name: 'resolution', label: 'Resolution', type: 'select', options: ['source', '1080p', '720p', '480p', '360p'], value: t.resolution || 'source' },
    { name: 'fps', label: 'Frame rate', type: 'select', options: ['source', '24', '25', '30', '50', '60'], value: String(t.fps ?? 'source') },
    { name: 'videoBitrateKbps', label: 'Video bitrate kbps (blank = quality-based)', type: 'number', value: t.videoBitrateKbps ?? '' },
    { name: 'audioBitrateKbps', label: 'Audio bitrate kbps (blank = 128)', type: 'number', value: t.audioBitrateKbps ?? '' },
    { name: 'preset', label: 'Encoder preset', type: 'select', options: ['fast', 'balanced', 'quality'], value: t.preset || 'balanced' },
    { name: 'hlsTime', label: 'HLS segment seconds (1-30)', type: 'number', value: c.hls?.time },
    { name: 'hlsListSize', label: 'HLS window segments (2-60)', type: 'number', value: c.hls?.listSize }
  ], {
    body: c.running ? '<p class="muted">This channel is running — ingest/transcode changes apply on the next start. Changing the SOURCE rotates the feed identity (viewers follow automatically).</p>' : '',
    onReady (inputs) {
      const showFor = {
        source: ['pull', 'file'],
        port: PUSH_KINDS,
        streamKey: ['rtmp'],
        passphrase: ['srt'],
        latencyMs: ['srt'],
        timeoutMs: ['udp']
      }
      const encDetail = ['resolution', 'fps', 'videoBitrateKbps', 'audioBitrateKbps', 'preset']
      const sync = () => {
        const kind = inputs.kind.value
        for (const [name, kinds] of Object.entries(showFor)) {
          inputs[name].closest('label').hidden = !kinds.includes(kind)
        }
        inputs.source.previousSibling.textContent = kind === 'file' ? 'File path' : 'Source URL'
        const copy = inputs.encoder.value === 'copy'
        for (const name of encDetail) inputs[name].closest('label').hidden = copy
      }
      inputs.kind.addEventListener('change', sync)
      inputs.encoder.addEventListener('change', sync)
      sync()
    }
  })
  if (!v) return
  const body = {
    description: v.description,
    category: v.category.split(',').map((x) => x.trim()).filter(Boolean)
  }
  if (v.title.trim()) body.title = v.title.trim()

  const kind = v.kind
  if (kind === 'pull' || kind === 'file') {
    const src = v.source.trim()
    if (!src) return toast(kind + ' input needs a ' + (kind === 'file' ? 'path' : 'URL'), true)
    body.input = kind === 'pull' ? { kind, url: src } : { kind, path: src }
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

  body.transcode = v.encoder === 'copy'
    ? { encoder: 'copy' }
    : {
        encoder: v.encoder,
        resolution: v.resolution,
        fps: v.fps === 'source' ? 'source' : Number(v.fps),
        preset: v.preset,
        ...(v.videoBitrateKbps !== '' ? { videoBitrateKbps: Number(v.videoBitrateKbps) } : {}),
        ...(v.audioBitrateKbps !== '' ? { audioBitrateKbps: Number(v.audioBitrateKbps) } : {})
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
