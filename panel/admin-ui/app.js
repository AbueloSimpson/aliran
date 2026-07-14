// Aliran panel admin dashboard — vanilla JS over the S11a/S16a admin API only.
// Auth token lives in sessionStorage; any 401 drops back to the login view.
'use strict'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const PAGE = 50 // users per /api/users page (server caps at 500)

let token = sessionStorage.getItem('aliranAdminToken')
let who = sessionStorage.getItem('aliranAdminName') || ''
let users = []
let usersNext = null // cursor for the next page (null = no more)
let userPrefix = ''
let streams = []
let admins = []
let obsTimer = null // 10 s observability poll, runs only while the Overview tab is open
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
  stopObsPoll()
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

const TAB_NAMES = ['streams', 'users', 'admins', 'overview']
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    for (const name of TAB_NAMES) $('#' + name + '-section').hidden = tab.dataset.tab !== name
    if (tab.dataset.tab === 'overview') startObsPoll()
    else stopObsPoll()
  })
}

// ---------------------------------------------------------------- refresh + render

async function refresh () {
  const [status, s, a] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/streams'), api('GET', '/api/admins')])
  streams = s
  admins = a
  $('#status-chips').innerHTML =
    `<span class="chip"><b>${status.users}</b> users</span>` +
    `<span class="chip"><b>${status.streams}</b> streams</span>` +
    `<span class="chip"><b>${status.live}</b> live</span>` +
    `<span class="chip"><b>${status.admins}</b> admins</span>` +
    `<span class="chip mono" title="panel public key">${esc(status.panelKey.slice(0, 12))}…</span>`
  renderStreams()
  renderAdmins()
  await loadUsers(true) // back to page 1, keeping the current search prefix
  if (!$('#overview-section').hidden) await loadObservability().catch(() => {})
}

// Cursor-paged user listing (S16a): reset=true replaces the table (new search /
// after a mutation), reset=false appends the next page ("Load more").
async function loadUsers (reset) {
  if (reset) { users = []; usersNext = null }
  const q = new URLSearchParams({ limit: PAGE })
  if (userPrefix) q.set('prefix', userPrefix)
  if (usersNext) q.set('after', usersNext)
  const r = await api('GET', '/api/users?' + q)
  users = users.concat(r.users)
  usersNext = r.next
  renderUsers()
}

let searchTimer = null
$('#user-search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    userPrefix = $('#user-search').value.trim()
    loadUsers(true).catch((err) => toast(err.message, true))
  }, 250)
})

$('#users-more').addEventListener('click', () => loadUsers(false).catch((err) => toast(err.message, true)))

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
        <button class="btn small danger" data-act="del">delete</button>
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
    tr.querySelector('[data-act=del]').addEventListener('click', () => deleteUser(u.username))
    tbody.appendChild(tr)
  }
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${userPrefix ? `no users matching "${esc(userPrefix)}"` : 'no users yet'}</td></tr>`
  }
  $('#users-more').hidden = !usersNext
  $('#user-count').textContent =
    (userPrefix ? `prefix "${userPrefix}" — ` : '') + `${users.length} shown` + (usersNext ? ', more available' : '')
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
          ${s.featured ? '<span class="badge featured">★ FEATURED</span>' : ''}
          ${(s.category || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}
        </div>
        <p class="stream-desc">${esc(s.description) || '<i>no description</i>'}</p>
        <div class="mono muted">feed: ${s.feedKey ? esc(s.feedKey.slice(0, 16)) + '…' : '(not set)'}</div>
        <div class="art-row"></div>
        <div class="stream-foot">
          <button class="btn small" data-act="edit">Edit metadata</button>
          <label class="curation" title="rail position for client UIs — lower sorts first; empty = unordered">order
            <input type="number" min="0" max="9999" step="1" class="order-input" value="${s.order ?? ''}" placeholder="—"></label>
          <label class="curation" title="hero hint: featured live streams are preferred for the client hero slot">
            <input type="checkbox" class="featured-input" ${s.featured ? 'checked' : ''}> featured</label>
          <span class="spacer"></span>
          <button class="btn small danger" data-act="delete">Delete</button>
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
    card.querySelector('[data-act=delete]').addEventListener('click', () => deleteStream(s))
    card.querySelector('.order-input').addEventListener('change', (e) => {
      const raw = e.target.value.trim()
      act(() => api('PATCH', `/api/streams/${s.id}`, { order: raw === '' ? null : parseInt(raw, 10) }),
        raw === '' ? `order cleared for "${s.id}"` : `order ${raw} for "${s.id}"`)
    })
    card.querySelector('.featured-input').addEventListener('change', (e) => {
      act(() => api('PATCH', `/api/streams/${s.id}`, { featured: e.target.checked }),
        `"${s.id}" is ${e.target.checked ? 'now' : 'no longer'} featured`)
    })
    list.appendChild(card)
  }
  if (streams.length === 0) list.innerHTML = '<div class="card muted">No streams yet — add one above.</div>'
}

function renderAdmins () {
  const tbody = $('#admins-table tbody')
  tbody.innerHTML = ''
  for (const a of admins) {
    const isSelf = a.name === who
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><b>${esc(a.name)}</b>${isSelf ? ' <span class="chip">you</span>' : ''}</td>
      <td><span class="badge ${a.status === 'active' ? 'active' : 'disabled'}">${esc(a.status)}</span></td>
      <td class="muted">${a.createdAt ? new Date(a.createdAt).toLocaleString() : '—'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="password">password</button>
        <button class="btn small danger" data-act="remove">remove</button>
      </div></td>`
    tr.querySelector('[data-act=password]').addEventListener('click', () => changeAdminPassword(a.name))
    tr.querySelector('[data-act=remove]').addEventListener('click', () => removeAdminAccount(a.name))
    tbody.appendChild(tr)
  }
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
// opts.danger styles the OK button destructively.
function dialog (title, fields, { okLabel = 'Save', body = '', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#dlg')
    $('#dlg-title').textContent = title
    $('#dlg-ok').textContent = okLabel
    $('#dlg-ok').className = 'btn ' + (danger ? 'danger' : 'primary')
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
    const v = await dialog(`Disable ${u.username}?`, [], { okLabel: 'Disable', danger: true, body: '<p class="muted">Their sessions are revoked immediately; they cannot log in until re-enabled.</p>' })
    if (!v) return
  }
  act(() => api('POST', `/api/users/${u.username}/status`, { status: next }), `"${u.username}" is now ${next}`)
}

async function doLogoutAll (username) {
  const v = await dialog(`Log out all sessions of ${username}?`, [], { okLabel: 'Log out all' })
  if (!v) return
  act(() => api('POST', `/api/users/${username}/logout-all`), `sessions revoked for "${username}"`)
}

async function deleteUser (username) {
  const v = await dialog(`Delete user ${username}?`, [], {
    okLabel: 'Delete', danger: true,
    body: `<p class="warn-text"><b>Removes the account record entirely</b> — grants and device enrollments included.</p>
           <p class="muted">Session tokens already issued keep validating offline until they expire.
           Recreating "${esc(username)}" later starts from a blank record.</p>`
  })
  if (!v) return
  act(() => api('DELETE', `/api/users/${username}`), `deleted user "${username}"`)
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
    okLabel: 'Revoke', danger: true,
    body: '<p class="muted">Removes the sealed key from their record. A client that already cached the key needs a stream-key rotation to be fully locked out.</p>'
  })
  if (!v) return
  act(() => api('DELETE', `/api/users/${username}/grants/${streamId}`), `revoked "${streamId}" from "${username}"`)
}

// Devices dialog with per-device revoke ✕ (S16a: cooperative — no tokenVersion bump).
async function showDevices (username) {
  const render = (devices) => (devices.length
    ? devices.map((d) => `<li data-device="${esc(d.deviceId)}">
        <span class="mono">${esc(d.deviceId)}</span> ${esc(d.label)}
        <button class="device-x" title="remove this device enrollment">✕</button><br>
        <span class="muted">issued ${d.issuedAt ? new Date(d.issuedAt).toLocaleString() : '—'} ·
        ${d.expired ? 'expired' : 'expires ' + (d.expiresAt ? new Date(d.expiresAt).toLocaleString() : '—')}</span></li>`).join('')
    : '<li class="muted">no active devices</li>')
  const wire = () => {
    for (const btn of document.querySelectorAll('#devices-list .device-x')) {
      btn.addEventListener('click', async () => {
        const deviceId = btn.closest('li').dataset.device
        try {
          await api('DELETE', `/api/users/${username}/devices/${encodeURIComponent(deviceId)}`)
          toast(`device removed from "${username}"`)
          const fresh = await api('GET', `/api/users/${username}/devices`)
          $('#devices-list').innerHTML = render(fresh)
          wire()
        } catch (err) { toast(err.message, true) }
      })
    }
  }
  try {
    const devices = await api('GET', `/api/users/${username}/devices`)
    const p = dialog(`Devices of ${username}`, [], {
      okLabel: 'Close',
      body: `<ul class="devices" id="devices-list">${render(devices)}</ul>
             <p class="muted">✕ drops that client to the login screen on its next online check (cooperative —
             no token bump, other devices stay signed in). For a hard sign-out everywhere use “logout all”.</p>`
    })
    wire() // dialog() has already put the body in the DOM
    await p
    await refresh() // the row's device count may have changed
  } catch (err) { toast(err.message, true) }
}

// ---------------------------------------------------------------- admin actions

$('#add-admin-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const username = $('#na-name').value.trim()
  const password = $('#na-pass').value
  act(async () => {
    await api('POST', '/api/admins', { username, password })
    $('#na-name').value = ''; $('#na-pass').value = ''
  }, `created admin "${username}"`)
})

async function changeAdminPassword (name) {
  const isSelf = name === who
  const v = await dialog(`New password for admin ${name}`, [{ name: 'password', label: 'Password (min 8 chars)', type: 'password' }], {
    okLabel: 'Rotate',
    danger: isSelf,
    body: isSelf
      ? '<p class="warn-text">This is <b>your own</b> account — rotation revokes every session including this one. <b>You will be signed out.</b></p>'
      : `<p class="muted">All of ${esc(name)}'s admin sessions are revoked immediately.</p>`
  })
  if (!v) return
  try {
    await api('POST', `/api/admins/${name}/password`, { password: v.password })
    if (isSelf) { toast('password changed — sign in with the new one'); logout() } else {
      toast(`password rotated for admin "${name}"`)
      await refresh()
    }
  } catch (err) { toast(err.message, true) }
}

async function removeAdminAccount (name) {
  const isSelf = name === who
  const v = await dialog(`Remove admin ${name}?`, [], {
    okLabel: 'Remove', danger: true,
    body: (isSelf ? '<p class="warn-text">This is <b>your own</b> account — <b>you lose access immediately.</b></p>' : '') +
      `<p class="muted">${esc(name)}'s admin sessions die instantly. Recover from the box with
       <span class="mono">admin-cli add-admin</span> if needed.</p>`
  })
  if (!v) return
  try {
    await api('DELETE', `/api/admins/${name}`)
    if (isSelf) { logout() } else {
      toast(`removed admin "${name}"`)
      await refresh()
    }
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

// FULL purge (S16a). Deliberately heavyweight: typed confirmation + explicit caveats.
async function deleteStream (s) {
  const v = await dialog(`Delete stream ${s.id}?`, [
    { name: 'confirm', label: `Type "${s.id}" to confirm`, placeholder: s.id }
  ], {
    okLabel: 'Purge permanently', danger: true,
    body: `<p class="warn-text"><b>PERMANENT.</b> Purges the catalog record, the panel-private encryption key,
           every user's sealed grant, and the stream's art.</p>
           <p class="muted">Viewers that already unsealed the key may have it cached — fully locking out live
           content requires a stream-key rotation. Re-adding "${esc(s.id)}" later mints a fresh key.</p>`
  })
  if (!v) return
  if (v.confirm.trim() !== s.id) return toast('confirmation text did not match — nothing was deleted', true)
  act(() => api('DELETE', `/api/streams/${s.id}`), `stream "${s.id}" purged`)
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

// ---------------------------------------------------------------- observability

function fmtBytes (n) {
  if (n == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtUptime (sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'
}

async function loadObservability () {
  const o = await api('GET', '/api/observability')
  $('#obs-chips').innerHTML =
    `<span class="chip">uptime <b>${fmtUptime(o.uptimeSec)}</b></span>` +
    `<span class="chip">rss <b>${fmtBytes(o.mem.rss)}</b></span>` +
    `<span class="chip">heap <b>${fmtBytes(o.mem.heapUsed)}</b></span>` +
    `<span class="chip">connections <b>${o.swarm.connections}</b></span>` +
    `<span class="chip">peers <b>${o.swarm.peers}</b></span>` +
    `<span class="chip">data <b>${fmtBytes(o.data.bytes)}</b></span>` +
    `<span class="chip">disk free <b>${fmtBytes(o.data.diskFree)}</b></span>`
  const feed = $('#activity-feed')
  feed.innerHTML = o.activity.length ? '' : '<li class="muted">nothing yet — events appear as viewers log in, broadcasters register, and admins make changes</li>'
  for (const ev of o.activity) {
    const li = document.createElement('li')
    const detail = Object.entries(ev)
      .filter(([k]) => k !== 't' && k !== 'type')
      .map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' ')
    li.innerHTML = `<span class="muted mono">${new Date(ev.t).toLocaleTimeString()}</span>
      <span class="act-type act-${esc(ev.type)}">${esc(ev.type)}</span> <span class="mono">${detail}</span>`
    feed.appendChild(li)
  }
}

function startObsPoll () {
  stopObsPoll()
  loadObservability().catch((err) => toast(err.message, true))
  obsTimer = setInterval(() => loadObservability().catch(() => {}), 10000)
}

function stopObsPoll () {
  if (obsTimer) { clearInterval(obsTimer); obsTimer = null }
}

// ---------------------------------------------------------------- boot

;(async () => {
  if (!token) return show('login')
  try { await enterApp() } catch { logout() }
})()
