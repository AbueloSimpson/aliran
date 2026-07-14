// Aliran panel admin dashboard — vanilla JS over the S11a admin API only.
// Auth token lives in sessionStorage; any 401 drops back to the login view.
'use strict'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let token = sessionStorage.getItem('aliranAdminToken')
let who = sessionStorage.getItem('aliranAdminName') || ''
let users = []
let streams = []
const artCache = new Map() // 'assets/<id>/<file>' -> blob object URL

// ---------------------------------------------------------------- api

async function api (method, path, body, contentType) {
  const headers = {}
  if (token) headers.authorization = 'Bearer ' + token
  if (contentType) headers['content-type'] = contentType
  else if (body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
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
  sessionStorage.removeItem('aliranAdminToken')
  sessionStorage.removeItem('aliranAdminName')
  for (const url of artCache.values()) URL.revokeObjectURL(url)
  artCache.clear()
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
    sessionStorage.setItem('aliranAdminToken', token)
    sessionStorage.setItem('aliranAdminName', who)
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
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    $('#streams-section').hidden = tab.dataset.tab !== 'streams'
    $('#users-section').hidden = tab.dataset.tab !== 'users'
  })
}

// ---------------------------------------------------------------- refresh + render

async function refresh () {
  // /api/users is cursor-paged since S16a ({users,next}); real search/paging UI is S16b —
  // until then one max-size page keeps the table complete for realistic deployments.
  const [status, u, s] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/users?limit=500'), api('GET', '/api/streams')])
  users = u.users
  streams = s
  $('#status-chips').innerHTML =
    `<span class="chip"><b>${status.users}</b> users</span>` +
    `<span class="chip"><b>${status.streams}</b> streams</span>` +
    `<span class="chip"><b>${status.live}</b> live</span>` +
    `<span class="chip mono" title="panel public key">${esc(status.panelKey.slice(0, 12))}…</span>`
  renderUsers()
  renderStreams()
}

function renderUsers () {
  const tbody = $('#users-table tbody')
  tbody.innerHTML = ''
  for (const u of users) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><b>${esc(u.username)}</b></td>
      <td><span class="badge ${u.status === 'active' ? 'active' : 'disabled'}">${esc(u.status)}</span></td>
      <td class="grants"></td>
      <td><button class="btn small" data-act="devices">${u.devices} device${u.devices === 1 ? '' : 's'}</button></td>
      <td><button class="btn small" data-act="max">${u.maxDevices ?? '—'}</button></td>
      <td><div class="row-actions">
        <button class="btn small" data-act="grant">+ grant</button>
        <button class="btn small" data-act="password">password</button>
        <button class="btn small" data-act="logout-all">logout all</button>
        <button class="btn small ${u.status === 'active' ? 'danger' : ''}" data-act="toggle">${u.status === 'active' ? 'disable' : 'enable'}</button>
      </div></td>`
    const grants = tr.querySelector('.grants')
    if (u.grants.length === 0) grants.innerHTML = '<span class="muted">—</span>'
    for (const g of u.grants) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.innerHTML = `${esc(g)} <button class="x" title="revoke">✕</button>`
      chip.querySelector('.x').addEventListener('click', () => revokeGrant(u.username, g))
      grants.appendChild(chip)
    }
    tr.querySelector('[data-act=devices]').addEventListener('click', () => showDevices(u.username))
    tr.querySelector('[data-act=max]').addEventListener('click', () => editMaxDevices(u))
    tr.querySelector('[data-act=grant]').addEventListener('click', () => grantStream(u))
    tr.querySelector('[data-act=password]').addEventListener('click', () => changePassword(u.username))
    tr.querySelector('[data-act=logout-all]').addEventListener('click', () => doLogoutAll(u.username))
    tr.querySelector('[data-act=toggle]').addEventListener('click', () => toggleStatus(u))
    tbody.appendChild(tr)
  }
}

function renderStreams () {
  const list = $('#streams-list')
  list.innerHTML = ''
  for (const s of streams) {
    const card = document.createElement('div')
    card.className = 'card stream-card'
    card.innerHTML = `
      <div class="stream-poster">${s.poster ? '' : 'no poster'}</div>
      <div class="stream-body">
        <div class="stream-head">
          <h3>${esc(s.title)}</h3>
          <span class="mono muted">${esc(s.id)}</span>
          <span class="badge ${s.isLive ? 'live' : 'idle'}">${s.isLive ? 'LIVE' : esc(s.status || 'idle')}</span>
          ${(s.category || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}
        </div>
        <p class="stream-desc">${esc(s.description) || '<i>no description</i>'}</p>
        <div class="mono muted">feed: ${s.feedKey ? esc(s.feedKey.slice(0, 16)) + '…' : '(not set)'}</div>
        <div class="art-row"></div>
        <div class="stream-foot">
          <button class="btn small" data-act="edit">Edit metadata</button>
        </div>
      </div>`
    if (s.poster) loadArt(card.querySelector('.stream-poster'), s.poster)
    const artRow = card.querySelector('.art-row')
    for (const kind of ['poster', 'backdrop', 'logo']) {
      const slot = document.createElement('div')
      slot.className = 'art-slot'
      slot.innerHTML = `<div class="art-thumb">${s[kind] ? '' : '—'}</div><button class="btn small" data-kind="${kind}">${kind}</button>`
      if (s[kind]) loadArt(slot.querySelector('.art-thumb'), s[kind])
      slot.querySelector('button').addEventListener('click', () => uploadArt(s.id, kind))
      artRow.appendChild(slot)
    }
    card.querySelector('[data-act=edit]').addEventListener('click', () => editMeta(s))
    list.appendChild(card)
  }
  if (streams.length === 0) list.innerHTML = '<div class="card muted">No streams yet — add one above.</div>'
}

// Fetch art with the auth token and render a blob URL (plain <img src> can't carry
// the Authorization header).
async function loadArt (el, assetPath) {
  try {
    let url = artCache.get(assetPath)
    if (!url) {
      const res = await fetch('/api/' + assetPath, { headers: { authorization: 'Bearer ' + token } })
      if (!res.ok) return
      url = URL.createObjectURL(await res.blob())
      artCache.set(assetPath, url)
    }
    el.innerHTML = `<img src="${url}" alt="">`
  } catch {}
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
      if (f.type === 'checkbox') label.className = 'inline'
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
      if (f.type === 'checkbox') input.checked = !!f.value
      else if (f.value != null) input.value = f.value
      if (f.placeholder) input.placeholder = f.placeholder
      inputs[f.name] = input
      if (f.type === 'checkbox') { label.append(input, f.label) } else { label.append(f.label, input) }
      holder.appendChild(label)
    }
    const done = (ok) => {
      dlg.removeEventListener('close', onClose)
      if (dlg.open) dlg.close()
      resolve(ok ? Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value])) : null)
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

// ---------------------------------------------------------------- user actions

$('#add-user-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const username = $('#nu-name').value.trim()
  const password = $('#nu-pass').value
  act(async () => {
    await api('POST', '/api/users', { username, password })
    $('#nu-name').value = ''; $('#nu-pass').value = ''
  }, `created user "${username}"`)
})

async function changePassword (username) {
  const v = await dialog(`New password for ${username}`, [{ name: 'password', label: 'Password', type: 'password' }])
  if (!v) return
  act(() => api('POST', `/api/users/${username}/password`, { password: v.password }),
    `password rotated for "${username}" (grants re-sealed, sessions revoked)`)
}

async function toggleStatus (u) {
  const next = u.status === 'active' ? 'disabled' : 'active'
  if (next === 'disabled') {
    const v = await dialog(`Disable ${u.username}?`, [], { okLabel: 'Disable', body: '<p class="muted">Their sessions are revoked immediately; they cannot log in until re-enabled.</p>' })
    if (!v) return
  }
  act(() => api('POST', `/api/users/${u.username}/status`, { status: next }), `"${u.username}" is now ${next}`)
}

async function doLogoutAll (username) {
  const v = await dialog(`Log out all sessions of ${username}?`, [], { okLabel: 'Log out all' })
  if (!v) return
  act(() => api('POST', `/api/users/${username}/logout-all`), `sessions revoked for "${username}"`)
}

async function editMaxDevices (u) {
  const v = await dialog(`Device limit for ${u.username}`, [{ name: 'max', label: 'Max concurrent devices', type: 'number', value: u.maxDevices }])
  if (!v) return
  act(() => api('POST', `/api/users/${u.username}/max-devices`, { maxDevices: parseInt(v.max, 10) }), 'device limit updated')
}

async function grantStream (u) {
  const available = streams.map((s) => s.id).filter((id) => !u.grants.includes(id))
  if (available.length === 0) return toast('no streams left to grant (add a stream first)', true)
  const v = await dialog(`Grant ${u.username} access to`, [{ name: 'streamId', label: 'Stream', type: 'select', options: available }], { okLabel: 'Grant' })
  if (!v) return
  act(() => api('POST', `/api/users/${u.username}/grants`, { streamId: v.streamId }), `granted "${v.streamId}" to "${u.username}"`)
}

async function revokeGrant (username, streamId) {
  const v = await dialog(`Revoke "${streamId}" from ${username}?`, [], {
    okLabel: 'Revoke',
    body: '<p class="muted">Removes the sealed key from their record. A client that already cached the key needs a stream-key rotation to be fully locked out.</p>'
  })
  if (!v) return
  act(() => api('DELETE', `/api/users/${username}/grants/${streamId}`), `revoked "${streamId}" from "${username}"`)
}

async function showDevices (username) {
  try {
    const devices = await api('GET', `/api/users/${username}/devices`)
    const items = devices.length
      ? devices.map((d) => `<li><span class="mono">${esc(d.deviceId)}</span> ${esc(d.label)}<br>
          <span class="muted">issued ${d.issuedAt ? new Date(d.issuedAt).toLocaleString() : '—'} ·
          ${d.expired ? 'expired' : 'expires ' + (d.expiresAt ? new Date(d.expiresAt).toLocaleString() : '—')}</span></li>`).join('')
      : '<li class="muted">no active devices</li>'
    await dialog(`Devices of ${username}`, [], { okLabel: 'Close', body: `<ul class="devices">${items}</ul>` })
  } catch (err) { toast(err.message, true) }
}

// ---------------------------------------------------------------- stream actions

$('#add-stream-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const body = {
    id: $('#ns-id').value.trim(),
    title: $('#ns-title').value.trim() || undefined,
    category: $('#ns-category').value.trim() || undefined,
    feedKey: $('#ns-feed').value.trim() || undefined
  }
  try {
    const r = await api('POST', '/api/streams', body)
    e.target.reset()
    await refresh()
    await dialog(`Stream "${r.id}" registered`, [], {
      okLabel: 'Done',
      body: `<p>Encryption key — give it to the broadcaster. <b>It is shown only once:</b></p>
             <div class="keybox mono">${esc(r.encryptionKey)}</div>
             <p>The key is kept panel-private; viewers receive it sealed per-user at login.</p>`
    })
  } catch (err) { toast(err.message, true) }
})

async function editMeta (s) {
  const v = await dialog(`Edit ${s.id}`, [
    { name: 'title', label: 'Title', value: s.title },
    { name: 'description', label: 'Description', type: 'textarea', value: s.description },
    { name: 'category', label: 'Category (comma-separated)', value: (s.category || []).join(', ') },
    { name: 'feedKey', label: 'Feed key (hex)', value: s.feedKey || '', placeholder: 'set when the broadcaster registers' },
    { name: 'status', label: 'Status', type: 'select', options: ['idle', 'live', 'offline'], value: s.status },
    { name: 'isLive', label: 'Live now', type: 'checkbox', value: s.isLive }
  ])
  if (!v) return
  const body = {
    title: v.title,
    description: v.description,
    category: v.category.split(',').map((x) => x.trim()).filter(Boolean),
    status: v.status,
    isLive: v.isLive
  }
  if (v.feedKey.trim()) body.feedKey = v.feedKey.trim()
  act(() => api('PATCH', `/api/streams/${s.id}`, body), `metadata updated for "${s.id}"`)
}

let artTarget = null
function uploadArt (id, kind) {
  artTarget = { id, kind }
  $('#art-file').value = ''
  $('#art-file').click()
}

$('#art-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  if (!file || !artTarget) return
  const { id, kind } = artTarget
  artTarget = null
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast('use a png/jpg/webp/gif image', true)
  act(async () => {
    const r = await api('POST', `/api/streams/${id}/art/${kind}`, file, file.type)
    const stale = artCache.get(r[kind])
    if (stale) { URL.revokeObjectURL(stale); artCache.delete(r[kind]) }
  }, `${kind} uploaded for "${id}"`)
})

// ---------------------------------------------------------------- boot

;(async () => {
  if (!token) return show('login')
  try { await enterApp() } catch { logout() }
})()
