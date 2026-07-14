// Aliran broadcaster control UI — vanilla JS over the S12a control API only.
// Auth token lives in sessionStorage; any 401 drops back to the login view.
// Live status (ffmpeg/peers/registered/playlist) is polled every 5 s and patched
// into the cards in place, so buttons and open dialogs never get clobbered.
'use strict'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const POLL_MS = 5000
let token = sessionStorage.getItem('aliranControlToken')
let who = sessionStorage.getItem('aliranControlName') || ''
let channels = []
let panelConfigured = false
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
  await refresh()
  startPoll()
}

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
  return JSON.stringify(channels.map((c) => [c.id, c.title, c.description, c.category, c.input, c.hls, c.feedKey, c.legacy]))
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
    <div class="mono muted">input: ${esc(c.input)} · hls ${esc(c.hls?.time)}s ×${esc(c.hls?.listSize)} · feed: ${c.feedKey ? esc(c.feedKey.slice(0, 16)) + '…' : '(on first start)'}</div>
    <div class="chan-foot">
      <button class="btn small primary" data-act="startstop">Start</button>
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small danger" data-act="remove">Remove</button>
    </div>`
  card.querySelector('[data-act=startstop]').addEventListener('click', (e) => startStop(c.id, e.currentTarget))
  card.querySelector('[data-act=edit]').addEventListener('click', () => editChannel(c.id))
  card.querySelector('[data-act=remove]').addEventListener('click', () => removeChannel(c.id))
  return card
}

// Patch the live bits (run badge, status strip, start/stop button) without re-rendering.
function updateStatus (c) {
  const card = $('#channels-list').querySelector(`[data-id="${CSS.escape(c.id)}"]`)
  if (!card) return
  const run = card.querySelector('.run-badge')
  run.textContent = c.running ? 'ON AIR' : 'STOPPED'
  run.className = 'badge run-badge ' + (c.running ? 'live' : 'idle')
  const btn = card.querySelector('[data-act=startstop]')
  btn.textContent = c.running ? 'Stop' : 'Start'
  btn.classList.toggle('primary', !c.running)
  const strip = card.querySelector('.status-strip')
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
  if (c.startedAt) bits.push(`<span class="chip">up ${fmtUp(Date.now() - c.startedAt)}</span>`)
  strip.innerHTML = bits.join(' ')
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

// fields: [{name, label, type='text', value, options?, placeholder?}] → values object or null.
function dialog (title, fields, { okLabel = 'Save', body = '' } = {}) {
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
        for (const o of f.options) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; input.appendChild(opt) }
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea')
        input.rows = 3
      } else {
        input = document.createElement('input')
        input.type = f.type || 'text'
      }
      if (f.value != null) input.value = f.value
      if (f.placeholder) input.placeholder = f.placeholder
      inputs[f.name] = input
      label.append(f.label, input)
      holder.appendChild(label)
    }
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
  const body = {
    id: $('#nc-id').value.trim(),
    title: $('#nc-title').value.trim() || undefined,
    category: $('#nc-category').value.trim() || undefined,
    input: $('#nc-input').value.trim() || undefined
  }
  try {
    const r = await api('POST', '/api/channels', body)
    e.target.reset()
    await refresh()
    await dialog(`Channel "${r.id}" created`, [], {
      okLabel: 'Done',
      body: `<p>Feed encryption key (persisted in this channel's <span class="mono">feed.key</span>):</p>
             <div class="keybox mono">${esc(r.encryptionKey)}</div>
             <p class="muted">Starting the channel delivers it to the panel automatically — you only need to
             copy it for a panel you administer by hand (admin-cli / panel dashboard add-stream).</p>`
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

async function editChannel (id) {
  const c = channels.find((x) => x.id === id)
  if (!c) return
  const v = await dialog(`Edit ${c.id}`, [
    { name: 'title', label: 'Title', value: c.title },
    { name: 'description', label: 'Description', type: 'textarea', value: c.description },
    { name: 'category', label: 'Category (comma-separated)', value: (c.category || []).join(', ') },
    { name: 'input', label: 'Input (test · rtsp/http URL · file path)', value: c.input },
    { name: 'hlsTime', label: 'HLS segment seconds (1-30)', type: 'number', value: c.hls?.time },
    { name: 'hlsListSize', label: 'HLS window segments (2-60)', type: 'number', value: c.hls?.listSize }
  ])
  if (!v) return
  const body = {
    description: v.description,
    category: v.category.split(',').map((x) => x.trim()).filter(Boolean)
  }
  if (v.title.trim()) body.title = v.title.trim()
  if (v.input.trim()) body.input = v.input.trim()
  if (v.hlsTime !== '') body.hlsTime = v.hlsTime
  if (v.hlsListSize !== '') body.hlsListSize = v.hlsListSize
  act(async () => {
    const r = await api('PATCH', `/api/channels/${encodeURIComponent(id)}`, body)
    toast(r.restartRequired ? `"${id}" updated — changes apply on next start` : `"${id}" updated`)
  })
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
