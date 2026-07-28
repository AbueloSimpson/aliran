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
let publishers = []
let channelSources = []
let channelPackages = [] // S44 bouquets — resolved id arrays double as the Users-tab provenance data
let categories = []
let vodConfig = null // S53 external VOD provider (svcmeta/vod) — null = never configured
let obsTimer = null // 10 s observability poll, runs only while the Overview tab is open
let anTimer = null // 60 s analytics poll, runs only while the Analytics tab is open
let rpTimer = null // 30 s reports poll, runs only while the Reports tab is open
const artCache = new Map() // 'assets/<id>/<file>' -> blob object URL
const SINGLES_INLINE = 3 // per-channel chips shown inline; more fold into one bundle chip
const expandedGrants = new Set() // usernames whose full chip list is expanded

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
  stopAnalyticsPoll()
  stopReportsPoll()
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

const TAB_NAMES = ['streams', 'users', 'packages', 'admins', 'publishers', 'sources', 'categories', 'reports', 'analytics', 'overview']
// One-line topbar description per tab, shown under the page title.
const TAB_SUBTITLES = {
  streams: 'the live channel catalog your viewers see',
  users: 'viewer accounts, devices and channel entitlements',
  packages: 'channel bouquets granted to users as one unit',
  admins: 'accounts for this dashboard',
  publishers: 'broadcaster site identities and their channel scopes',
  sources: 'remote channel feeds and the external VOD provider',
  categories: 'the rail vocabulary — labels, order, visibility',
  reports: 'viewer problem reports and correlation alerts',
  analytics: 'aggregate usage counts — no per-user tracking exists',
  overview: 'panel health and recent activity'
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    const name = tab.dataset.tab
    $('#page-title').textContent = name[0].toUpperCase() + name.slice(1)
    $('#page-sub').textContent = TAB_SUBTITLES[name] || ''
    for (const name of TAB_NAMES) $('#' + name + '-section').hidden = tab.dataset.tab !== name
    if (tab.dataset.tab === 'overview') startObsPoll()
    else stopObsPoll()
    if (tab.dataset.tab === 'analytics') startAnalyticsPoll()
    else stopAnalyticsPoll()
    if (tab.dataset.tab === 'reports') startReportsPoll()
    else stopReportsPoll()
  })
}

// ---------------------------------------------------------------- refresh + render

async function refresh () {
  const [status, s, a, p, src, cats, pkgs, vod] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/streams'), api('GET', '/api/admins'), api('GET', '/api/publishers'), api('GET', '/api/sources'), api('GET', '/api/categories'), api('GET', '/api/packages'), api('GET', '/api/vod-config')])
  streams = s
  categories = cats
  admins = a
  publishers = p
  channelSources = src
  channelPackages = pkgs
  vodConfig = vod
  $('#status-chips').innerHTML =
    `<span class="chip"><b>${status.users}</b> users</span>` +
    `<span class="chip"><b>${status.streams}</b> streams</span>` +
    `<span class="chip"><b>${status.live}</b> live</span>` +
    `<span class="chip"><b>${status.admins}</b> admins</span>` +
    `<span class="chip mono" title="panel public key">${esc(status.panelKey.slice(0, 12))}…</span>`
  renderStreams()
  renderAdmins()
  renderPublishers()
  renderSources()
  renderPackages()
  renderCategories()
  renderVodConfig()
  await loadUsers(true) // back to page 1, keeping the current search prefix
  // The reports badge rides every refresh so an alert is visible from any tab.
  // Best-effort on purpose: a panel without the reports store must not break refresh.
  loadReportsBadge().catch(() => {})
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
  // Sorts the loaded rows only — the list is server-paged behind "Load more".
  const rows = sortRows('users-table', users, {
    username: (u) => u.username,
    status: (u) => u.status,
    grants: (u) => (u.grants || []).length,
    devices: (u) => u.devices,
    max: (u) => u.maxDevices ?? null
  })
  for (const u of rows) {
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
    // Provenance split (S44): one chip per assigned PACKAGE (✕ unassigns the whole
    // bouquet), then per-channel chips — manual grants, then source auto-grants.
    // A channel covered by a package is folded into its package chip; a channel
    // that is manual AND package-covered still shows its manual chip.
    const grants = tr.querySelector('.grants')
    const pkgIds = new Set()
    for (const name of u.packages || []) {
      const p = channelPackages.find((x) => x.name === name)
      for (const id of (p && p.resolved) || []) pkgIds.add(id)
      const chip = document.createElement('span')
      chip.className = 'chip pkg'
      chip.title = `package "${name}"${p ? ` — ${p.resolved.length} channel(s)` : ' (no longer defined)'} · members live on the Packages tab · ✕ removes the package from this user`
      chip.innerHTML = `▣ <b>${esc(p ? p.label : name)}</b> <button class="x" title="remove package">✕</button>`
      chip.querySelector('.x').addEventListener('click', () => removeUserPackage(u, name))
      grants.appendChild(chip)
    }
    // Auto-granted source channels fold into ONE chip per source ("⇣ name · N") —
    // with auto-grant sources a user holds every imported channel, and hundreds of
    // per-channel chips made the row unreadable. Individual revokes of auto grants
    // only lasted until the source's next sync anyway; manage those on Sources.
    const manual = new Set(u.manualGrants || [])
    const srcOf = new Map(streams.map((s) => [s.id, s.source || null]))
    const bySource = new Map()
    const singles = []
    for (const g of u.grants) {
      if (pkgIds.has(g) && !manual.has(g)) continue // folded into the package chip
      if (!manual.has(g)) {
        const src = srcOf.get(g)
        if (src) { bySource.set(src, (bySource.get(src) || 0) + 1); continue }
      }
      singles.push(g)
    }
    for (const [name, n] of [...bySource].sort()) {
      const chip = document.createElement('span')
      chip.className = 'chip auto'
      chip.title = `${n} channel(s) auto-granted by source "${name}" — the source engine owns these; a manual revoke lasts only until its next sync (manage on the Sources tab)`
      chip.innerHTML = `⇣ <b>${esc(name)}</b> · ${n}`
      grants.appendChild(chip)
    }
    // Per-channel grants collapse into ONE bundle chip past a handful — like a
    // package, just unnamed. Click to expand into revocable chips, and back.
    const showAll = expandedGrants.has(u.username)
    if (!showAll && singles.length > SINGLES_INLINE) {
      const chip = document.createElement('span')
      chip.className = 'chip more'
      chip.innerHTML = `▤ <b>${singles.length}</b> channels`
      chip.title = 'individually granted channels — click to list them'
      chip.addEventListener('click', () => { expandedGrants.add(u.username); renderUsers() })
      grants.appendChild(chip)
    } else {
      for (const g of singles) {
        const auto = !manual.has(g)
        const chip = document.createElement('span')
        chip.className = 'chip' + (auto ? ' auto' : '')
        if (auto) chip.title = 'auto-granted by a channel source (auto-grant) — a revoke lasts only until that source\'s next sync'
        chip.innerHTML = `${esc(g)} <button class="x" title="revoke">✕</button>`
        chip.querySelector('.x').addEventListener('click', () => revokeGrant(u.username, g))
        grants.appendChild(chip)
      }
      if (showAll && singles.length > SINGLES_INLINE) {
        const chip = document.createElement('span')
        chip.className = 'chip more'
        chip.textContent = 'collapse'
        chip.title = 'fold these back into one bundle chip'
        chip.addEventListener('click', () => { expandedGrants.delete(u.username); renderUsers() })
        grants.appendChild(chip)
      }
    }
    if (grants.childElementCount === 0) grants.innerHTML = '<span class="muted">—</span>'
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

// Streams tab view state (client-side: /api/streams returns the full catalog):
// text search, category / status / origin filters, and a page cursor.
const streamView = { q: '', cat: '', state: '', src: '', page: 0, per: 50 } // per: 0 = all
let openStreamId = null // channel whose inline editor row is expanded (null = none)

function filteredStreams () {
  const q = streamView.q.toLowerCase()
  return streams.filter((s) =>
    (!q || s.id.toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q)) &&
    (!streamView.cat || (s.category || []).includes(streamView.cat)) &&
    (!streamView.state ||
      (streamView.state === 'live'
        ? s.isLive
        : streamView.state === 'redirect'
          ? !!s.redirect
          : streamView.state === 'restricted' ? !!s.restricted : !s.isLive && !s.redirect)) &&
    (!streamView.src || (streamView.src === '(manual)' ? !s.source : s.source === streamView.src)))
}

// ---------------------------------------------------------------- column sorting
//
// Any <th data-sort="key"> becomes a sort control. One click sorts ascending, a
// second flips to descending, a third clears the sort — every table has a natural
// order worth getting back to (catalog order on streams, the tree on categories),
// so an operator is never stuck in a sorted view. The state is per table and lives
// only in the page; a reload starts from the natural order again.
const sortState = {} // tableId -> { key, dir } — dir 1 = ascending, -1 = descending, 0 = off

function wireSort (tableId, render) {
  sortState[tableId] = { key: null, dir: 0 }
  for (const th of $('#' + tableId).querySelectorAll('thead th[data-sort]')) {
    th.classList.add('sortable')
    th.tabIndex = 0
    th.addEventListener('click', () => {
      const st = sortState[tableId]
      if (st.key === th.dataset.sort) st.dir = st.dir === 1 ? -1 : 0
      else { st.key = th.dataset.sort; st.dir = 1 }
      if (st.dir === 0) st.key = null
      markSort(tableId)
      render()
    })
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click() } })
  }
}

function markSort (tableId) {
  const st = sortState[tableId]
  for (const th of $('#' + tableId).querySelectorAll('thead th[data-sort]')) {
    th.dataset.dir = st.key === th.dataset.sort ? (st.dir === 1 ? 'asc' : 'desc') : ''
  }
}

// Sort a COPY of `rows` by the picked column. `cols` maps each data-sort key to a
// value getter; numbers compare numerically, everything else as text with numeric
// collation (so "ch-2" lands before "ch-10"). A getter returns null or '' for a cell
// that shows "—", and those rows sink to the bottom whichever way the column runs —
// a descending sort must not fill the first page with blanks. An unsorted table
// returns the array it was given, untouched.
function sortRows (tableId, rows, cols) {
  const st = sortState[tableId]
  const get = st && st.key && cols[st.key]
  if (!get) return rows
  const blank = (v) => v == null || v === ''
  return [...rows].sort((a, b) => {
    const x = get(a); const y = get(b)
    if (blank(x) || blank(y)) return blank(x) && blank(y) ? 0 : blank(x) ? 1 : -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * st.dir
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * st.dir
  })
}

wireSort('streams-table', () => { streamView.page = 0; renderStreams() }) // a re-sort starts at page 1
wireSort('users-table', renderUsers)
wireSort('categories-table', renderCategories)
wireSort('packages-table', renderPackages)
wireSort('sources-table', renderSources)
wireSort('publishers-table', renderPublishers)
wireSort('admins-table', renderAdmins)

// Rebuild a filter <select>'s options (keeping its "all" first option), holding on
// to the current pick when it still exists.
function fillSelect (sel, values, current) {
  while (sel.options.length > 1) sel.remove(1)
  for (const v of values) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = v
    sel.appendChild(o)
  }
  sel.value = values.includes(current) ? current : ''
}

function renderStreams () {
  const catSel = $('#stream-cat')
  const srcSel = $('#stream-src')
  fillSelect(catSel, [...new Set(streams.flatMap((s) => s.category || []))].sort(), streamView.cat)
  streamView.cat = catSel.value
  const srcNames = [...new Set(streams.map((s) => s.source).filter(Boolean))].sort()
  fillSelect(srcSel, srcNames.length ? ['(manual)', ...srcNames] : [], streamView.src)
  streamView.src = srcSel.value

  const hits = sortRows('streams-table', filteredStreams(), {
    id: (s) => s.id,
    title: (s) => s.title || '',
    status: (s) => (s.isLive ? 'live' : s.status || 'idle'),
    category: (s) => (s.category || []).join(', '),
    origin: (s) => s.source || s.origin || '',
    order: (s) => s.order ?? null
  })
  const per = streamView.per > 0 ? streamView.per : (hits.length || 1)
  const pages = Math.max(1, Math.ceil(hits.length / per))
  if (streamView.page >= pages) streamView.page = pages - 1
  const pageStreams = hits.slice(streamView.page * per, (streamView.page + 1) * per)

  $('#stream-count').textContent = hits.length === streams.length
    ? `${streams.length} channel${streams.length === 1 ? '' : 's'}`
    : `${hits.length} of ${streams.length} channels`
  $('#streams-page').textContent = `${streamView.page + 1}/${pages}`
  $('#streams-prev').disabled = streamView.page === 0
  $('#streams-next').disabled = streamView.page >= pages - 1

  const tbody = $('#streams-table tbody')
  tbody.innerHTML = ''
  for (const s of pageStreams) {
    const open = openStreamId === s.id
    const tr = document.createElement('tr')
    tr.className = 'stream-row' + (open ? ' open' : '')
    tr.innerHTML = `
      <td class="mono muted">${esc(s.id)}</td>
      <td><button class="link-btn stream-name" title="open this channel's editor">${esc(s.title)}</button>${s.featured ? ' <span class="badge featured" title="hero hint: featured live streams are preferred for the client hero slot">★</span>' : ''}</td>
      <td><span class="badge ${s.isLive ? 'live' : 'idle'}">${s.isLive ? 'LIVE' : esc(s.status || 'idle')}</span>${s.redirect ? ' <span class="badge redirect" title="CDN redirect channel — viewers play the URL, not a P2P feed">⇢</span>' : ''}${s.restricted ? ' <span class="badge restricted" title="access controlled — players require the parental PIN before playing">PIN</span>' : ''}</td>
      <td>${(s.category || []).map((c) => `<span class="chip cat-chip" data-cat="${esc(c)}" title="filter the list by this category">${esc(c)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
      <td class="muted">${s.source
        ? `<span title="imported from channel source &quot;${esc(s.source)}&quot; — the feed overwrites mapped fields on every sync">⇣ ${esc(s.source)}</span>`
        : s.origin
          ? `<span title="registered by enrolled publisher &quot;${esc(s.origin)}&quot; (last register)">⇡ ${esc(s.origin)}</span>`
          : '—'}</td>
      <td class="muted">${s.order ?? '—'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="edit">edit</button>
        <button class="btn small danger" data-act="del" title="delete this channel">✕</button>
      </div></td>`
    tr.querySelector('.stream-name').addEventListener('click', () => {
      openStreamId = open ? null : s.id
      renderStreams()
    })
    tr.querySelector('[data-act=edit]').addEventListener('click', () => editMeta(s))
    tr.querySelector('[data-act=del]').addEventListener('click', () => deleteStream(s))
    for (const el of tr.querySelectorAll('.cat-chip')) {
      el.addEventListener('click', () => {
        streamView.cat = el.dataset.cat
        streamView.page = 0
        renderStreams()
      })
    }
    tbody.appendChild(tr)
    if (open) {
      const dtr = document.createElement('tr')
      dtr.className = 'stream-detail-row'
      const td = document.createElement('td')
      td.colSpan = 7
      td.appendChild(streamDetailCard(s))
      dtr.appendChild(td)
      tbody.appendChild(dtr)
    }
  }
  if (hits.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${streams.length
      ? 'No channels match the current filters.'
      : 'No streams yet — add one with the form above.'}</td></tr>`
  }
}

// The expanded per-channel editor, shown under its table row when the name is
// clicked: poster, description, feed/url line, art slots and curation controls.
function streamDetailCard (s) {
  const card = document.createElement('div')
  card.className = 'stream-card'
  card.innerHTML = `
    <div class="stream-poster">${s.poster ? '' : 'no poster'}</div>
    <div class="stream-body">
      <p class="stream-desc">${esc(s.description) || '<i>no description</i>'}</p>
      <div class="mono muted">${s.redirect
        ? `url: ${esc(s.url || '')}`
        : `feed: ${s.feedKey ? esc(s.feedKey.slice(0, 16)) + '…' : '(not set)'}`}</div>
      <div class="art-row"></div>
      <div class="stream-foot">
        <button class="btn small" data-act="edit">Edit metadata</button>
        <label class="curation" title="rail position for client UIs — lower sorts first; empty = unordered">order
          <input type="number" min="0" max="9999" step="1" class="order-input" value="${s.order ?? ''}" placeholder="—"></label>
        <label class="curation" title="hero hint: featured live streams are preferred for the client hero slot">
          <input type="checkbox" class="featured-input" ${s.featured ? 'checked' : ''}> featured</label>
        <label class="curation" title="access controlled — players require the parental PIN before playing this channel">
          <input type="checkbox" class="restricted-input" ${s.restricted ? 'checked' : ''}> restricted</label>
        <span class="spacer"></span>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
    </div>`
  if (s.poster) loadArt(card.querySelector('.stream-poster'), s.poster)
  const artRow = card.querySelector('.art-row')
  for (const kind of ['poster', 'backdrop', 'logo']) {
    const slot = document.createElement('div')
    slot.className = 'art-slot'
    slot.innerHTML = `<div class="art-thumb">${s[kind] ? '' : '—'}</div>
      <button class="btn small" data-act="upload">${kind}</button>
      <button class="btn small" data-act="url" title="use a remote https:// image URL instead of an upload">url</button>`
    if (s[kind]) loadArt(slot.querySelector('.art-thumb'), s[kind])
    slot.querySelector('[data-act=upload]').addEventListener('click', () => uploadArt(s.id, kind))
    slot.querySelector('[data-act=url]').addEventListener('click', () => setArtUrl(s, kind))
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
  card.querySelector('.restricted-input').addEventListener('change', (e) => {
    act(() => api('PATCH', `/api/streams/${s.id}`, { restricted: e.target.checked }),
      e.target.checked
        ? `"${s.id}" is access controlled — players ask for the parental PIN (viewers pick it up at next catalog sync)`
        : `"${s.id}" is no longer access controlled`)
  })
  return card
}

let streamSearchTimer = null
$('#stream-search').addEventListener('input', () => {
  clearTimeout(streamSearchTimer)
  streamSearchTimer = setTimeout(() => {
    streamView.q = $('#stream-search').value.trim()
    streamView.page = 0
    renderStreams()
  }, 150)
})
for (const [sel, key] of [['#stream-cat', 'cat'], ['#stream-state', 'state'], ['#stream-src', 'src']]) {
  $(sel).addEventListener('change', () => {
    streamView[key] = $(sel).value
    streamView.page = 0
    renderStreams()
  })
}
$('#streams-prev').addEventListener('click', () => { streamView.page--; renderStreams() })
$('#streams-next').addEventListener('click', () => { streamView.page++; renderStreams() })

// Enrolled broadcaster identities (S26): per-site keys + channel scopes.
function renderPublishers () {
  const tbody = $('#publishers-table tbody')
  tbody.innerHTML = ''
  $('#publisher-count').textContent = publishers.length
    ? `${publishers.length} publisher${publishers.length === 1 ? '' : 's'}`
    : ''
  const rows = sortRows('publishers-table', publishers, {
    name: (p) => p.name,
    status: (p) => p.status,
    added: (p) => p.addedAt || null
  })
  for (const p of rows) {
    const revoked = p.status !== 'active'
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><b>${esc(p.name)}</b></td>
      <td><span class="badge ${revoked ? 'disabled' : 'active'}">${esc(p.status)}</span></td>
      <td class="scopes">${p.scopes.length
        ? p.scopes.map((s) => `<span class="chip mono">${esc(s)}</span>`).join(' ')
        : '<span class="muted" title="no scopes — this publisher cannot register anything yet">—</span>'}</td>
      <td class="mono muted" title="${esc(p.publicKey)}">${esc((p.publicKey || '').slice(0, 12))}…</td>
      <td class="muted">${p.addedAt ? new Date(p.addedAt).toLocaleString() : '—'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="scopes">scopes</button>
        <button class="btn small ${revoked ? '' : 'danger'}" data-act="toggle">${revoked ? 'activate' : 'revoke'}</button>
        <button class="btn small danger" data-act="remove">remove</button>
      </div></td>`
    tr.querySelector('[data-act=scopes]').addEventListener('click', () => editPublisherScopes(p))
    tr.querySelector('[data-act=toggle]').addEventListener('click', () => togglePublisher(p))
    tr.querySelector('[data-act=remove]').addEventListener('click', () => removePublisherEntry(p.name))
    tbody.appendChild(tr)
  }
  if (publishers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no publishers enrolled — broadcasters are using the shared legacy key. Use ＋ Enroll publisher to give each site its own scoped key.</td></tr>'
  }
}

// Remote channel sources (S27): provider feeds materialized as redirect-channel categories.
// Categories are rendered as a shallow tree: a parent row, then its children indented
// beneath it. The hierarchy is encoded in the slug ('Parent/Child'), so there is nothing
// to join — sorting the slugs already groups them.
function renderCategories () {
  const tbody = $('#categories-table tbody')
  const count = $('#category-count')
  tbody.innerHTML = ''
  if (!categories.length) {
    count.textContent = ''
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no categories yet — they appear as soon as a channel carries one</td></tr>'
    return
  }
  // A sort applies WITHIN each level — roots against roots, a parent's children
  // against each other — so the tree keeps its shape whichever column you pick.
  const cs = (list) => sortRows('categories-table', list, {
    slug: (c) => c.slug,
    label: (c) => c.label || '',
    channels: (c) => c.channels,
    order: (c) => c.order ?? null
  })
  const real = categories.filter((c) => !c.parent)
  const realSlugs = new Set(real.map((r) => r.slug))
  const kids = (p) => cs(categories.filter((c) => c.parent === p))
  // A parent slug is often IN USE without being a category itself: production carries
  // Movies/English and Movies/Español, but nothing is tagged plain "Movies". Give each
  // such prefix a heading row of its own — without one its children dangle at the
  // bottom of the table under a stray tree marker, which is where the biggest rails
  // (85 and 57 channels) ended up. A heading owns no channels, so its count is the
  // total of the rails below it.
  const groups = [...new Set(categories.filter((c) => c.parent && !realSlugs.has(c.parent)).map((c) => c.parent))]
    .map((slug) => ({
      slug,
      label: slug,
      group: true, // no presentation entry, no membership — a heading and nothing else
      channels: categories.filter((c) => c.parent === slug).reduce((n, c) => n + c.channels, 0),
      order: null,
      hidden: false,
      registered: false
    }))
  // Slug order is the baseline the API already returns rows in — re-apply it so a
  // heading takes its alphabetical place instead of trailing the real entries.
  const tops = real.concat(groups).sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }))
  const ordered = []
  for (const t of cs(tops)) { ordered.push([t, 0]); for (const k of kids(t.slug)) ordered.push([k, 1]) }
  // Search keeps a matching child's parent on screen, so the tree never shows an
  // indented row with nothing above it.
  const q = $('#category-search').value.trim().toLowerCase()
  const hit = (c) => c.slug.toLowerCase().includes(q) || (c.label || '').toLowerCase().includes(q)
  const shown = q === '' ? ordered : ordered.filter(([c, depth]) => hit(c) || (depth === 0 && kids(c.slug).some(hit)))
  const realShown = shown.filter(([c]) => !c.group).length // headings are not categories
  count.textContent = q === ''
    ? `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`
    : `${realShown} of ${categories.length}`
  if (!realShown) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">no category matches "${esc(q)}"</td></tr>`
    return
  }
  for (const [c, depth] of shown) {
    const tr = document.createElement('tr')
    if (c.group) tr.className = 'cat-group'
    tr.innerHTML = `
      <td>${depth ? '<span class="muted">└ </span>' : ''}<b>${esc(c.slug.split('/').pop())}</b>${depth ? '' : ''}<br><span class="mono muted">${esc(c.slug)}</span></td>
      <td>${c.group || c.label === c.slug ? '<span class="muted">—</span>' : esc(c.label)}</td>
      <td${c.group ? ' class="muted" title="no channel carries this slug — the total counts the rails below it"' : ''}>${c.channels}</td>
      <td class="muted">${c.order != null ? c.order : '—'}</td>
      <td>${c.group
        ? '<span class="chip" title="a prefix its rails share (Movies/English, Movies/Español) — no channel carries it on its own. Edit it to give the group a label and an order; rename it to move every rail below it.">group</span>'
        : (c.hidden ? '<span class="badge disabled">hidden</span> ' : '') + (c.registered ? '' : '<span class="chip" title="in use on channels but has no presentation entry yet">unregistered</span>')}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="edit">edit</button>
        <button class="btn small" data-act="rename">rename</button>
        ${c.group
          ? '' // merge moves channels and this heading has none; forget needs an entry to drop
          : `<button class="btn small" data-act="merge">merge</button>
        <button class="btn small danger" data-act="forget"${c.registered ? '' : ' disabled'}>forget</button>`}
      </div></td>`
    tr.querySelector('[data-act=edit]').addEventListener('click', () => editCategory(c))
    tr.querySelector('[data-act=rename]').addEventListener('click', () => renameCategoryDlg(c))
    if (!c.group) {
      tr.querySelector('[data-act=merge]').addEventListener('click', () => mergeCategoryDlg(c))
      const forget = tr.querySelector('[data-act=forget]')
      if (c.registered) forget.addEventListener('click', () => forgetCategory(c))
    }
    tbody.appendChild(tr)
  }
}

async function editCategory (c) {
  const v = await dialog(`Presentation — ${c.slug}`, [
    { name: 'label', label: 'Display label (blank = use the slug)', value: c.label === c.slug ? '' : c.label },
    { name: 'order', label: 'Order (0-9999, blank = unset)', type: 'number', value: c.order ?? '' },
    { name: 'hidden', label: 'Hidden', type: 'select', options: ['no', 'yes'], value: c.hidden ? 'yes' : 'no' }
  ], { body: '<p class="muted">Presentation only. This never changes which channels carry the category, so a source sync cannot undo it.</p>' })
  if (!v) return
  act(() => api('POST', '/api/categories', {
    slug: c.slug,
    label: v.label.trim() || c.slug,
    order: v.order === '' ? null : Number(v.order),
    hidden: v.hidden === 'yes'
  }), `"${c.slug}" updated`)
}

async function renameCategoryDlg (c) {
  const childCount = categories.filter((x) => x.parent === c.slug).length
  const v = await dialog(`Rename ${c.slug}`, [
    { name: 'to', label: 'New slug', value: c.slug }
  ], {
    okLabel: 'Rename',
    body: `<p class="muted">Rewrites <b>${c.channels}</b> channel(s)` +
      (childCount ? ` and moves <b>${childCount}</b> child categor${childCount === 1 ? 'y' : 'ies'} with it` : '') +
      '.</p><p class="muted">If this rail comes from a <b>source</b>, the next sync reasserts the source\'s category — rename it on the Sources tab instead.</p>'
  })
  if (!v || !v.to.trim() || v.to.trim() === c.slug) return
  act(async () => {
    const r = await api('PATCH', '/api/categories', { from: c.slug, to: v.to.trim() })
    toast(`renamed → "${r.to}" (${r.channels} channel(s))`)
  })
}

async function mergeCategoryDlg (c) {
  const others = categories.filter((x) => x.slug !== c.slug).map((x) => x.slug)
  if (!others.length) return toast('nothing to merge into', true)
  const v = await dialog(`Merge ${c.slug} into…`, [
    { name: 'to', label: 'Target category', type: 'select', options: others, value: others[0] }
  ], { okLabel: 'Merge', body: `<p class="muted">Every channel tagged <b>${esc(c.slug)}</b> is retagged to the target, and this category's presentation entry is dropped. Channels already carrying both end up with one tag, not two.</p>` })
  if (!v) return
  act(async () => {
    const r = await api('PATCH', '/api/categories', { op: 'merge', from: [c.slug], to: v.to })
    toast(`merged into "${r.to}" (${r.channels} channel(s))`)
  })
}

async function forgetCategory (c) {
  const v = await dialog(`Forget "${c.slug}"?`, [], {
    okLabel: 'Forget',
    body: `<p class="muted">Drops the presentation entry (label / order / hidden). The <b>${c.channels}</b> channel(s) keep the category — this never untags content. Use rename or merge to move channels.</p>`
  })
  if (!v) return
  act(() => api('DELETE', '/api/categories', { slug: c.slug }), `"${c.slug}" forgotten`)
}

// "Every" column: minutes are the operator-facing unit (the edit dialog's input);
// whole hours/days render compact.
function fmtInterval (ms) {
  const m = Math.round((ms || 86400000) / 60000)
  if (m % 1440 === 0) return (m / 1440) + 'd'
  if (m % 60 === 0) return (m / 60) + 'h'
  return m + 'm'
}

function renderSources () {
  const tbody = $('#sources-table tbody')
  tbody.innerHTML = ''
  $('#source-count').textContent = channelSources.length
    ? `${channelSources.length} source${channelSources.length === 1 ? '' : 's'} · ${channelSources.reduce((n, s) => n + s.channels, 0)} channels`
    : ''
  const rows = sortRows('sources-table', channelSources, {
    name: (s) => s.name,
    category: (s) => s.category,
    channels: (s) => s.channels,
    interval: (s) => s.intervalMs || 86400000,
    lastSync: (s) => s.lastSync || null, // never synced sinks to the bottom
    state: (s) => (s.enabled === false ? 'paused' : 'enabled')
  })
  for (const s of rows) {
    const disabled = s.enabled === false
    const rep = s.lastReport
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><b>${esc(s.name)}</b><br><span class="mono muted" title="${esc(s.url)}">${esc(s.url.length > 46 ? s.url.slice(0, 46) + '…' : s.url)}</span></td>
      <td><span class="chip">${esc(s.category)}</span></td>
      <td>${s.channels}</td>
      <td class="muted">${fmtInterval(s.intervalMs)}</td>
      <td class="muted">${s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'}${rep
        ? `<br><button class="mono rep-link" title="full report of the last sync">+${rep.added} ~${rep.updated} −${rep.removed}${rep.notModified ? ' · not modified' : ''}${rep.skipped ? ` · ${rep.skipped} skipped` : ''}${rep.conflicts ? ` · ${rep.conflicts} conflicts` : ''}${rep.truncated ? ` · <span class="warn-text">${rep.truncated} over cap</span>` : ''}</button>`
        : ''}</td>
      <td>${s.lastError
        ? `<button class="badge disabled err-badge" title="${esc(s.lastError)}">ERROR</button> `
        : ''}<span class="badge ${disabled ? 'disabled' : 'active'}">${disabled ? 'paused' : 'enabled'}</span> ${s.autoGrant === false ? '<span class="chip" title="imported channels are NOT auto-granted — grant per user by hand">no auto-grant</span>' : ''}${(s.exclude || []).length ? `<span class="chip" title="deselected in the channels dialog — skipped on every sync until re-checked">${s.exclude.length} excluded</span>` : ''}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="sync">sync now</button>
        <button class="btn small" data-act="channels">channels</button>
        <button class="btn small" data-act="edit">edit</button>
        <button class="btn small" data-act="toggle">${disabled ? 'enable' : 'pause'}</button>
        <button class="btn small danger" data-act="remove">remove</button>
      </div></td>`
    const repBtn = tr.querySelector('.rep-link')
    if (repBtn) repBtn.addEventListener('click', () => showSyncReport(s))
    const errBtn = tr.querySelector('.err-badge')
    if (errBtn) errBtn.addEventListener('click', () => showSourceError(s))
    tr.querySelector('[data-act=sync]').addEventListener('click', () => syncSourceNow(s.name))
    tr.querySelector('[data-act=channels]').addEventListener('click', () => openSourceChannels(s))
    tr.querySelector('[data-act=edit]').addEventListener('click', () => editSource(s))
    tr.querySelector('[data-act=toggle]').addEventListener('click', () => act(
      () => api('PATCH', `/api/sources/${s.name}`, { enabled: disabled }),
      `source "${s.name}" ${disabled ? 're-enabled' : 'paused (its channels stay; scheduled syncs stop)'}`))
    tr.querySelector('[data-act=remove]').addEventListener('click', () => removeSourceEntry(s))
    tbody.appendChild(tr)
  }
  if (channelSources.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">no sources yet — use ＋ Add source to pull a provider feed. Its channels then appear as a category.</td></tr>'
  }
}

// External VOD provider (S53): ONE replicated record (svcmeta/vod) the APPS read at
// login and then call the provider with, directly — the panel is only the switch and
// the coordinates. Nothing shown here is a secret (no viewer credential is stored for
// it), so the fields render as-is. `null` = never configured, which viewers experience
// exactly like disabled.
function kvString (obj) {
  return Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join(',')
}

// "hm=1,hs=2" -> { hm: '1', hs: '2' } ('' -> {}). Values may contain '=' (split once).
function parseKeyVals (s) {
  const out = {}
  for (const pair of String(s || '').split(',')) {
    const t = pair.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i < 1) throw new Error(`bad extra param "${t}" — expected key=value`)
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

function renderVodConfig () {
  const v = vodConfig || {}
  $('#vod-api-base').value = v.apiBase || ''
  $('#vod-service').value = v.service || ''
  $('#vod-movies-source').value = (v.sources && v.sources.movies) || ''
  $('#vod-series-source').value = (v.sources && v.sources.series) || ''
  $('#vod-params').value = kvString(v.params)
  $('#vod-enabled').checked = !!v.enabled
  const badge = $('#vod-badge')
  const state = !vodConfig ? 'not configured' : v.enabled ? 'enabled' : 'disabled'
  badge.className = 'badge ' + (v.enabled ? 'active' : 'disabled')
  badge.innerHTML = esc(state)
}

$('#vod-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const enabled = $('#vod-enabled').checked
  const movies = $('#vod-movies-source').value.trim()
  const series = $('#vod-series-source').value.trim()
  let params
  try { params = parseKeyVals($('#vod-params').value) } catch (err) { toast(err.message, true); return }
  act(async () => {
    // Always a full patch: the form shows every field, so what is on screen IS the
    // intended record (sources/params are whole-map replacements server-side).
    await api('PATCH', '/api/vod-config', {
      enabled,
      apiBase: $('#vod-api-base').value.trim(),
      service: $('#vod-service').value.trim(),
      sources: { ...(movies ? { movies } : {}), ...(series ? { series } : {}) },
      params
    })
  }, `VOD provider ${enabled ? 'enabled' : 'disabled'} — viewers pick it up at their next login`)
})

// Channel packages / bouquets (S44): named bundles materialized into sealed
// per-user grants. The resolved arrays fetched here also feed the Users-tab
// provenance chips (package vs manual vs auto).
function renderPackages () {
  const tbody = $('#packages-table tbody')
  tbody.innerHTML = ''
  $('#package-count').textContent = channelPackages.length
    ? `${channelPackages.length} package${channelPackages.length === 1 ? '' : 's'}`
    : ''
  const rows = sortRows('packages-table', channelPackages, {
    name: (p) => p.name,
    resolved: (p) => p.resolved.length,
    holders: (p) => p.holders,
    default: (p) => (p.default ? 0 : 1)
  })
  for (const p of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><b>${esc(p.name)}</b>${p.label !== p.name ? `<br><span class="muted">${esc(p.label)}</span>` : ''}</td>
      <td>${p.members.length ? p.members.map((m) => `<span class="chip mono">${esc(m)}</span>`).join(' ') : '<span class="muted" title="no members — the package grants nothing yet">—</span>'}</td>
      <td><button class="btn small" data-act="resolved" title="the channels the members resolve to right now">${p.resolved.length} channel${p.resolved.length === 1 ? '' : 's'}</button></td>
      <td>${p.holders}</td>
      <td>${p.default ? '<span class="badge active" title="assigned to every NEW user at creation (existing users are not touched)">DEFAULT</span>' : '<span class="muted">—</span>'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="edit">edit</button>
        <button class="btn small danger" data-act="remove">remove</button>
      </div></td>`
    tr.querySelector('[data-act=resolved]').addEventListener('click', () => showPackageResolved(p))
    tr.querySelector('[data-act=edit]').addEventListener('click', () => editPackage(p))
    tr.querySelector('[data-act=remove]').addEventListener('click', () => removePackageEntry(p))
    tbody.appendChild(tr)
  }
  if (channelPackages.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no packages yet — use ＋ Add package to define a bouquet, then assign it on the Users tab</td></tr>'
  }
}

function renderAdmins () {
  const tbody = $('#admins-table tbody')
  tbody.innerHTML = ''
  $('#admin-count').textContent = admins.length
    ? `${admins.length} admin${admins.length === 1 ? '' : 's'}`
    : ''
  const rows = sortRows('admins-table', admins, {
    name: (a) => a.name,
    status: (a) => a.status,
    created: (a) => a.createdAt || null
  })
  for (const a of rows) {
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

// Render an art reference: remote https URLs go straight into <img src> (hybrid art —
// the browser fetches them like any viewer would); drive paths are fetched with the
// auth token and rendered as a blob URL (plain <img src> can't carry the
// Authorization header).
async function loadArt (el, ref) {
  try {
    if (/^https?:\/\//i.test(ref)) { el.innerHTML = `<img src="${esc(ref)}" alt="">`; return }
    let url = artCache.get(ref)
    if (!url) {
      const res = await fetch('/api/' + ref, { headers: { authorization: 'Bearer ' + token } })
      if (!res.ok) return
      url = URL.createObjectURL(await res.blob())
      artCache.set(ref, url)
    }
    el.innerHTML = `<img src="${url}" alt="">`
  } catch {}
}

// ---------------------------------------------------------------- dialog helper

// fields: [{name, label, type='text', value, options?, placeholder?, min?, max?, step?}] → values object or null.
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
      if (f.min != null) input.min = f.min
      if (f.max != null) input.max = f.max
      if (f.step != null) input.step = f.step
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
  // Packages first (S44): granting a bouquet is the common case once they exist.
  const pkgOptions = channelPackages.filter((p) => !(u.packages || []).includes(p.name))
    .map((p) => `package: ${p.name} (${p.resolved.length} ch)`)
  const streamOptions = streams.map((s) => s.id).filter((id) => !u.grants.includes(id))
  const options = [...pkgOptions, ...streamOptions]
  if (options.length === 0) return toast('nothing left to grant (add a stream or define a package first)', true)
  const v = await dialog(`Grant ${u.username} access to`, [{ name: 'what', label: 'Package or stream', type: 'select', options }], {
    okLabel: 'Grant',
    body: channelPackages.length ? '<p class="muted">Granting a <b>package</b> assigns the whole bouquet — the user follows its member list from then on. Single streams become <b>manual</b> grants.</p>' : ''
  })
  if (!v) return
  const m = v.what.match(/^package: (\S+) /)
  if (m) {
    return act(() => api('POST', `/api/users/${u.username}/packages`, { packages: [...(u.packages || []), m[1]] }),
      `package "${m[1]}" assigned to "${u.username}"`)
  }
  act(() => api('POST', `/api/users/${u.username}/grants`, { streamId: v.what }), `granted "${v.what}" to "${u.username}"`)
}

async function removeUserPackage (u, name) {
  const p = channelPackages.find((x) => x.name === name)
  const v = await dialog(`Remove package "${name}" from ${u.username}?`, [], {
    okLabel: 'Remove', danger: true,
    body: `<p class="muted">Removes the sealed keys of the <b>${p ? p.resolved.length : 0} channel(s)</b> only this package covers —
           manual grants and auto-granted source channels stay. A client that already unsealed a key needs a
           stream-key rotation for a hard lockout.</p>`
  })
  if (!v) return
  act(() => api('POST', `/api/users/${u.username}/packages`, { packages: (u.packages || []).filter((n) => n !== name) }),
    `package "${name}" removed from "${u.username}"`)
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

$('#admin-add-btn').addEventListener('click', () => addAdminDlg())

async function addAdminDlg () {
  const v = await dialog('Add admin', [
    { name: 'username', label: 'Name (letters, digits, . _ -)', placeholder: 'operator' },
    { name: 'password', label: 'Password (min 8 chars)', type: 'password' }
  ], {
    okLabel: 'Add',
    body: '<p class="muted">Every admin has full rights, and can remove other admins. Accounts live in the panel-private <span class="mono">secrets/admins.json</span>.</p>'
  })
  if (!v) return
  const username = v.username.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) return toast('name must start alphanumeric and use only letters, digits, . _ -', true)
  if ((v.password || '').length < 8) return toast('password must be at least 8 characters', true)
  act(() => api('POST', '/api/admins', { username, password: v.password }), `created admin "${username}"`)
}

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

// ---------------------------------------------------------------- publisher actions

$('#publisher-add-btn').addEventListener('click', () => enrollPublisherDlg())

async function enrollPublisherDlg () {
  const v = await dialog('Enroll publisher', [
    { name: 'name', label: 'Site name (letters, digits, . _ -)', placeholder: 'east' },
    { name: 'scopes', label: 'Channel scopes — streamId globs, comma-separated (blank = none yet)', placeholder: 'east-*,sports-1' }
  ], {
    okLabel: 'Enroll',
    body: '<p class="muted">The site gets its own registration key. The key is valid only for the channel ids its scopes match. The panel shows the secret <b>once</b>, immediately after this step.</p>'
  })
  if (!v) return
  const name = v.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return toast('name must start alphanumeric and use only letters, digits, . _ -', true)
  const scopes = v.scopes.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const p = await api('POST', '/api/publishers', { name, scopes })
    await refresh()
    await dialog(`Publisher "${p.name}" enrolled`, [], {
      okLabel: 'Done',
      body: `<p>Put BOTH lines in <b>that site's</b> broadcaster <span class="mono">.env</span>, then restart it.
             <b>The secret is shown only once</b> — the panel keeps just the public key:</p>
             <div class="keybox mono">PUBLISHER_NAME=${esc(p.name)}<br>PUBLISHER_KEY=${esc(p.secretKey)}</div>
             <p class="muted">Scopes: ${p.scopes.length ? esc(p.scopes.join(', ')) : 'none — the site cannot register anything until you add some'}.
             Registrations outside the scopes are rejected with <span class="mono">out-of-scope</span>.</p>`
    })
  } catch (err) { toast(err.message, true) }
}

async function editPublisherScopes (p) {
  const v = await dialog(`Channel scopes — ${p.name}`, [
    { name: 'scopes', label: 'streamId globs, comma-separated (* matches any run; * alone = every channel)', value: p.scopes.join(', '), placeholder: 'east-*,sports-1' }
  ], {
    okLabel: 'Save',
    body: '<p class="muted">The site can only register / take live / update channel ids matching a scope. Applies from its next registration (including the 5-minute heartbeat).</p>'
  })
  if (!v) return
  const scopes = v.scopes.split(',').map((s) => s.trim()).filter(Boolean)
  act(() => api('POST', `/api/publishers/${p.name}/scopes`, { scopes }),
    scopes.length ? `scopes for "${p.name}" = ${scopes.join(', ')}` : `all scopes removed from "${p.name}" — it cannot register anything`)
}

async function togglePublisher (p) {
  const revoked = p.status !== 'active'
  if (!revoked) {
    const v = await dialog(`Revoke publisher ${p.name}?`, [], {
      okLabel: 'Revoke', danger: true,
      body: `<p class="warn-text">Every registration signed with "${esc(p.name)}"'s key is rejected from now on —
             its running channels stop being re-asserted (they keep their last catalog state until an admin edits it).</p>
             <p class="muted">Reversible: activate the entry again to re-accept the same key. The site's encoder/box is untouched.</p>`
    })
    if (!v) return
  }
  act(() => api('POST', `/api/publishers/${p.name}/status`, { status: revoked ? 'active' : 'revoked' }),
    `publisher "${p.name}" is now ${revoked ? 'active' : 'revoked'}`)
}

async function removePublisherEntry (name) {
  const v = await dialog(`Remove publisher ${name}?`, [], {
    okLabel: 'Remove', danger: true,
    body: `<p class="warn-text">Hard-deletes the enrollment — its key stops working immediately
           (<span class="mono">unknown-publisher</span>).</p>
           <p class="muted">Prefer <b>revoke</b>: it keeps the name and enrollment date for the audit trail.
           Re-enrolling "${esc(name)}" later mints a fresh keypair.</p>`
  })
  if (!v) return
  act(() => api('DELETE', `/api/publishers/${name}`), `removed publisher "${name}"`)
}

// ---------------------------------------------------------------- source actions

// Upsert: the same dialog creates a presentation entry for a category already in use on
// channels, or edits one that exists. There is no "create a category" as such — a
// category exists because a channel carries it.
$('#category-add-btn').addEventListener('click', () => addCategoryDlg())
$('#category-search').addEventListener('input', renderCategories)

async function addCategoryDlg () {
  const v = await dialog('Add category', [
    { name: 'slug', label: 'Slug — the value channels carry (Parent/Child = a two-level rail)', placeholder: 'Nacional/Norte' },
    { name: 'label', label: 'Display label (blank = the slug)' },
    { name: 'order', label: 'Order (0-9999, blank = unset)', type: 'number', min: 0, max: 9999 },
    { name: 'hidden', label: 'Hidden', type: 'checkbox', value: false }
  ], {
    okLabel: 'Save',
    body: `<p class="muted">This writes the <b>presentation</b> entry: label, order and visibility. A channel joins a category
           because it carries the slug, so a new slug shows <b>0 channels</b> until a channel or a source uses it.</p>
           <p class="muted">The same dialog also saves over an entry that exists — give it the same slug.</p>`
  })
  if (!v) return
  const slug = v.slug.trim()
  if (!slug) return toast('a slug is required', true)
  act(() => api('POST', '/api/categories', {
    slug,
    label: v.label.trim() || undefined,
    order: v.order === '' ? null : Number(v.order),
    hidden: v.hidden
  }), `category "${slug}" saved`)
}

// What the panel accepts at the feed URL. mapFeed() in panel/src/sources.js is the
// authority — keep this in step with it. Shown in the add dialog and behind the
// toolbar's "feed format…" button, because an operator pasting a URL is exactly the
// person who needs to know what the file must contain.
const FEED_FORMAT_HTML = `
  <p class="muted footnote">Publish <span class="mono">{"channels":[…]}</span> or a bare array at the URL. One object is one channel:</p>
  <pre class="codebox mono">{
  "channels": [
    {
      "id":   "moon-cat",
      "url":  "https://cdn.example/live/moon.m3u8",
      "name": "Moon Cat",
      "logo": "https://cdn.example/art/moon.png",
      "description": "Cartoons, all day."
    }
  ]
}</pre>
  <ul class="muted footnote spec-list">
    <li><b>id</b> — required. The panel builds the channel id as <span class="mono">&lt;prefix&gt;&lt;id&gt;</span>; the prefix
      defaults to the source name and a dot. The result must keep to letters, digits, <span class="mono">_ . -</span> and
      64 characters. The panel skips an entry with no id, a bad id, or an id it already used.</li>
    <li><b>url</b> — required. This is the address viewers play. Start it with <span class="mono">https://</span>. A query
      string is correct — the panel asks for no file extension. The panel skips an entry with no url or a plain http url.</li>
    <li><b>name</b> — optional. This becomes the title, cut at 200 characters. Without a name the panel uses the id.</li>
    <li><b>logo</b> — optional. Use an <span class="mono">https://</span> address. A bad logo costs the art only: the channel
      still imports.</li>
    <li><b>description</b> — optional, and the panel writes it <b>once</b>, at the first import. Your own synopsis stays
      after that. Later syncs never write over it.</li>
    <li><b>Order comes from the position in the array.</b> The first entry sorts first. The panel ignores an
      <span class="mono">order</span> field.</li>
    <li><b>The category is yours, not the feed's.</b> Every entry joins the category you set on this source. The panel
      ignores category strings in the file.</li>
    <li>The panel ignores all other fields. Keep a schedule (<span class="mono">epg</span>) in the file: the apps read it
      from this same URL, and the panel stores none of it.</li>
    <li>Limits per feed: <b>500 channels</b> and <b>5 MB</b> by default, and 30 seconds to answer. The panel imports the
      first 500 entries and reports the rest as over cap.</li>
    <li>Serve the file over <b>https</b>. Send an <span class="mono">ETag</span> if you can — the panel then does no work
      on an unchanged feed.</li>
    <li><b>An entry that leaves the feed is deleted</b>, together with its key and every grant for it. Keep an entry in the
      file for as long as you want the channel.</li>
    <li>The panel never touches a manual channel or another source's channel. It reports a clash as a conflict and skips it.</li>
  </ul>`

$('#source-add-btn').addEventListener('click', () => addSourceDlg())
$('#source-format-btn').addEventListener('click', () => dialog('Source feed format', [], { okLabel: 'Close', body: FEED_FORMAT_HTML }))

async function addSourceDlg () {
  const v = await dialog('Add source', [
    { name: 'name', label: 'Name — permanent id (letters, digits, . _ -)', placeholder: 'anime' },
    { name: 'url', label: 'Feed URL (https://)', placeholder: 'https://provider.example/channels.json' },
    { name: 'category', label: 'Category label (the rail viewers see)', placeholder: 'Anime' }
  ], {
    okLabel: 'Add',
    body: `<p class="muted">The panel pulls the feed immediately and materializes it as a category of <b>redirect channels</b>.</p>
           <p class="muted">The sync interval, the channel id prefix and auto-grant keep their defaults. Change them with
           <b>edit</b> on the row.</p>
           <details class="footnote"><summary>What the feed JSON must contain</summary>${FEED_FORMAT_HTML}</details>`
  })
  if (!v) return
  const name = v.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return toast('name must start alphanumeric and use only letters, digits, . _ -', true)
  try {
    await api('POST', '/api/sources', { name, url: v.url.trim(), category: v.category.trim() })
    toast(`source "${name}" added — pulling the feed…`)
    await syncSourceNow(name)
  } catch (err) { toast(err.message, true) }
}

async function syncSourceNow (name) {
  toast(`syncing "${name}"…`)
  try {
    const r = await api('POST', `/api/sources/${name}/sync`)
    toast(r.notModified
      ? `"${name}": feed not modified · ${r.granted} grant(s) sealed`
      : `"${name}": +${r.added} added, ~${r.updated} updated, −${r.removed} removed, ${r.granted} grant(s) sealed` +
        (r.skippedCount ? ` · ${r.skippedCount} skipped` : '') + (r.conflicts.length ? ` · ${r.conflicts.length} conflicts` : '') +
        (r.truncated ? ` · ${r.truncated} over the channel cap — dropped` : ''))
    await refresh()
  } catch (err) { toast(err.message, true); await refresh().catch(() => {}) }
}

// Full last-sync report (opened from the row's report line). The registry keeps a
// capped detail list (skip reasons, conflicting ids) precisely for this dialog —
// the toast only ever shows counts.
function showSyncReport (s) {
  const rep = s.lastReport
  if (!rep) return
  const skipDet = rep.skippedDetail || []
  const conflictIds = rep.conflictIds || []
  let body = `<div class="muted">${new Date(rep.at).toLocaleString()}${rep.notModified ? ' · feed not modified (ETag) — nothing re-applied' : ''}</div>
    <div><span class="mono">+${rep.added} added · ~${rep.updated} updated · −${rep.removed} removed</span> · ${rep.granted} grant(s) sealed</div>`
  if (rep.truncated) {
    body += `<p class="warn-text"><b>${rep.truncated} feed entr${rep.truncated === 1 ? 'y' : 'ies'} over the channel cap were dropped.</b>
      The feed is larger than this panel imports — raise <span class="mono">sources.maxChannels</span> in the panel config to take more.</p>`
  }
  if (rep.skipped) {
    body += `<p class="muted">Skipped (invalid entries — the rest of the feed still imported)${rep.skipped > skipDet.length ? ` — first ${skipDet.length} of ${rep.skipped}` : ''}:</p>`
    body += skipDet.length
      ? `<ul class="report-list mono">${skipDet.map((e) => `<li>${esc(e.id)} — ${esc(e.reason)}</li>`).join('')}</ul>`
      : '<p class="muted">(reasons are recorded from the next sync)</p>'
  }
  if (rep.conflicts) {
    body += `<p class="muted">Conflicts (id already taken by a manual channel or another source — never touched)${rep.conflicts > conflictIds.length ? ` — first ${conflictIds.length} of ${rep.conflicts}` : ''}:</p>`
    body += conflictIds.length
      ? `<ul class="report-list mono">${conflictIds.map((id) => `<li>${esc(id)}</li>`).join('')}</ul>`
      : '<p class="muted">(ids are recorded from the next sync)</p>'
  }
  if (rep.excluded) body += `<p class="muted">${rep.excluded} excluded by you (channels dialog).</p>`
  dialog(`Last sync — ${s.name}`, [], { okLabel: 'Close', body })
}

// Full error text + when it happened (the row badge only has a hover title, which
// touch and keyboard users can't reach).
function showSourceError (s) {
  dialog(`Sync error — ${s.name}`, [], {
    okLabel: 'Close',
    body: `<div class="keybox mono">${esc(s.lastError)}</div>
      <div class="muted">failed ${s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleString() : '(unknown time)'} ·
      ${s.lastSync ? 'last good sync ' + new Date(s.lastSync).toLocaleString() : 'never synced successfully'}</div>
      <div class="muted">The last imported state stays live. ${s.enabled === false
        ? 'This source is paused — scheduled retries are off; use “sync now” to retry.'
        : 'The scheduler retries on its next tick; “sync now” retries immediately.'}</div>`
  })
}

// Channels dialog: one checkbox per feed entry — imported ones checked, excluded
// ones unchecked (with the label captured at exclusion time). Saving replaces the
// source's exclude list and syncs, so deselections take effect immediately.
// Feeds run to hundreds of entries, so the list is filterable and all/none act on
// the filtered rows; checkbox state lives in `checked` (indexed like `channels`),
// kept current by change listeners, so the result never depends on dialog DOM
// surviving close.
async function openSourceChannels (s) {
  try {
    const { channels } = await api('GET', `/api/sources/${s.name}/channels`)
    if (!channels.length) return toast('no channels imported yet — sync the source first', true)
    const checked = channels.map((c) => !c.excluded)
    const rows = channels.map((c, i) =>
      `<label class="inline ch-row"><input type="checkbox" data-i="${i}"${c.excluded ? '' : ' checked'}>
         <span>${esc(c.title)}</span> <span class="mono muted">${esc(c.feedId)}</span></label>`).join('')
    const p = dialog(`Channels — ${s.name} (${channels.length})`, [], {
      okLabel: 'Save + sync',
      body: `<div class="dlg-tools">
               <input id="ch-filter" placeholder="filter by name or feed id…">
               <button type="button" class="btn small" id="ch-all">all</button>
               <button type="button" class="btn small" id="ch-none">none</button>
             </div>
             <div class="ch-list" id="ch-list">${rows}</div>
             <p class="muted">Unchecked = <b>excluded</b>: removed from the catalog (grants included) and skipped on every sync until you re-check it. The feed cannot re-add an excluded channel. <b>all</b>/<b>none</b> apply to the filtered rows only.</p>`
    })
    // dialog() has already put the body in the DOM — wire it up (same pattern as showDevices)
    const list = $('#ch-list')
    for (const box of list.querySelectorAll('input[type=checkbox]')) {
      box.addEventListener('change', () => { checked[+box.dataset.i] = box.checked })
    }
    const filter = $('#ch-filter')
    filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault() }) // Enter filters, never submits
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase()
      for (const row of list.querySelectorAll('.ch-row')) {
        const c = channels[+row.querySelector('input').dataset.i]
        row.hidden = q !== '' && !(c.title + ' ' + c.feedId).toLowerCase().includes(q)
      }
    })
    const bulk = (on) => {
      for (const row of list.querySelectorAll('.ch-row')) {
        if (row.hidden) continue
        const box = row.querySelector('input')
        box.checked = on
        checked[+box.dataset.i] = on
      }
    }
    $('#ch-all').addEventListener('click', () => bulk(true))
    $('#ch-none').addEventListener('click', () => bulk(false))
    filter.focus()
    const v = await p
    if (!v) return
    const exclude = channels.filter((c, i) => !checked[i]).map((c) => ({ id: c.feedId, title: c.title }))
    await api('PATCH', `/api/sources/${s.name}`, { exclude })
    await syncSourceNow(s.name)
  } catch (err) { toast(err.message, true) }
}

async function editSource (s) {
  const v = await dialog(`Edit source ${s.name}`, [
    { name: 'url', label: 'Feed URL (https://)', value: s.url },
    { name: 'category', label: 'Category label (the rail viewers see)', value: s.category },
    { name: 'prefix', label: 'Channel id prefix', value: s.prefix },
    { name: 'minutes', label: 'Sync every (minutes)', type: 'number', value: Math.round((s.intervalMs || 86400000) / 60000), min: 1, max: 43200, step: 1 },
    { name: 'autoGrant', label: 'auto-grant imported channels to every user', type: 'checkbox', value: s.autoGrant !== false }
  ], {
    body: `<p class="muted">The feed overwrites its mapped fields (title, url, logo, order, category) on every sync — manual edits to those don't stick on imported channels.</p>
      <p class="muted">Changing the <b>prefix</b> re-creates every entry under new ids on the next sync: the old ids are purged <b>including every user's grants</b>. With auto-grant off nothing re-grants the new ids — you re-grant by hand.</p>`
  })
  if (!v) return
  // Validate here, in the field's own unit — the API's error talks milliseconds.
  const minutes = Math.round(parseFloat(v.minutes))
  if (!Number.isFinite(minutes) || minutes < 1) return toast('sync interval must be at least 1 minute', true)
  if (minutes > 43200) return toast('sync interval must be at most 30 days (43200 minutes)', true)
  act(() => api('PATCH', `/api/sources/${s.name}`, {
    url: v.url.trim(),
    category: v.category.trim(),
    prefix: v.prefix.trim(),
    intervalMs: minutes * 60000,
    autoGrant: v.autoGrant
  }), `source "${s.name}" updated — applies on its next sync`)
}

async function removeSourceEntry (s) {
  const v = await dialog(`Remove source ${s.name}?`, [
    { name: 'keep', label: `keep its ${s.channels} channel(s) as manual redirect channels (detach instead of purge)`, type: 'checkbox', value: false }
  ], {
    okLabel: 'Remove', danger: true,
    body: `<p class="warn-text">Without "keep", its <b>${s.channels} channel(s) are purged</b> — catalog records, keys, every user's grants, and art.</p>
           <p class="muted">Re-adding the source later re-imports the feed from scratch. Detached channels stop syncing and behave like hand-made redirect channels.</p>`
  })
  if (!v) return
  act(() => api('DELETE', `/api/sources/${s.name}` + (v.keep ? '?keepChannels=1' : '')),
    v.keep ? `source "${s.name}" removed — channels detached` : `source "${s.name}" removed — channels purged`)
}

// ---------------------------------------------------------------- package actions

// Package add/edit dialog with a channel PICKER: one checkbox per catalog
// channel (filterable), so members are ticked instead of typed from memory.
// Globs and category:/source: selectors keep a text box — they can't be a
// checkbox, they resolve against future channels too. Checkbox state lives in
// `picked`, kept current by change listeners, so the result never depends on
// dialog DOM surviving close (same pattern as openSourceChannels).
async function packageDlg ({ title, okLabel, isNew = false, name = '', label = '', members = [], isDefault = false, holders = 0 }) {
  const idSet = new Set(streams.map((s) => s.id))
  const memberSet = new Set(members)
  const advanced = members.filter((m) => !idSet.has(m)) // globs, selectors, ids not in the catalog (yet)
  const sorted = [...streams].sort((a, b) => a.id.localeCompare(b.id))
  const picked = new Map(sorted.map((s) => [s.id, memberSet.has(s.id)]))
  const rows = sorted.map((s) =>
    `<label class="inline ch-row"><input type="checkbox" data-id="${esc(s.id)}"${memberSet.has(s.id) ? ' checked' : ''}>
       <span>${esc(s.title)}</span> <span class="mono muted">${esc(s.id)}</span></label>`).join('')
  const fields = []
  if (isNew) fields.push({ name: 'name', label: 'Name — permanent id (letters, digits, . _ -)', value: name, placeholder: 'basic' })
  fields.push({ name: 'label', label: 'Display label (blank = the name)', value: label })
  fields.push({ name: 'advanced', label: 'Extra members — id globs / selectors, comma-separated (sports-*, category:News, source:anime)', value: advanced.join(', ') })
  fields.push({ name: 'default', label: 'default for new users (existing users are not touched)', type: 'checkbox', value: isDefault })
  const p = dialog(title, fields, {
    okLabel,
    body: (isNew ? '' : `<p class="muted">Member edits materialize immediately for the <b>${holders} holder(s)</b>: missing keys are sealed, keys only this package covered are removed.</p>`) +
      `<div class="dlg-tools">
         <input id="pk-filter" placeholder="filter channels…">
         <span id="pk-count" class="muted"></span>
       </div>
       <div class="ch-list" id="pk-list">${rows || '<p class="muted">no channels in the catalog yet — extra members below still work</p>'}</div>`
  })
  // dialog() has already put the body in the DOM — wire it up
  const list = $('#pk-list')
  const count = $('#pk-count')
  const showCount = () => { count.textContent = `${[...picked.values()].filter(Boolean).length} selected` }
  showCount()
  for (const box of list.querySelectorAll('input[type=checkbox]')) {
    box.addEventListener('change', () => { picked.set(box.dataset.id, box.checked); showCount() })
  }
  const filter = $('#pk-filter')
  filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault() }) // Enter filters, never submits
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase()
    for (const row of list.querySelectorAll('.ch-row')) {
      const s = row.textContent.toLowerCase()
      row.hidden = q !== '' && !s.includes(q)
    }
  })
  const v = await p
  if (!v) return null
  const chosen = sorted.filter((s) => picked.get(s.id)).map((s) => s.id)
  const adv = v.advanced.split(',').map((x) => x.trim()).filter(Boolean)
  return {
    name: isNew ? v.name.trim() : undefined,
    label: v.label.trim(),
    members: chosen.concat(adv).join(', '),
    default: v.default
  }
}

$('#package-add-btn').addEventListener('click', async () => {
  const v = await packageDlg({ title: 'Add package', okLabel: 'Add', isNew: true })
  if (!v) return
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.name)) return toast('name must start alphanumeric and use only letters, digits, . _ -', true)
  act(() => api('POST', '/api/packages', {
    name: v.name,
    label: v.label || undefined,
    members: v.members,
    default: v.default
  }), `package "${v.name}" created — assign it on the Users tab`)
})

function showPackageResolved (p) {
  dialog(`${p.name} — resolves to ${p.resolved.length} channel(s)`, [], {
    okLabel: 'Close',
    body: (p.resolved.length
      ? `<ul class="report-list mono">${p.resolved.map((id) => `<li>${esc(id)}</li>`).join('')}</ul>`
      : '<p class="muted">No channel matches the members right now — selectors resolve as soon as matching channels exist (a newly imported/tagged channel joins by itself).</p>') +
      `<p class="muted">Members: ${p.members.length ? p.members.map((m) => esc(m)).join(', ') : '(none)'}</p>`
  })
}

async function editPackage (p) {
  const v = await packageDlg({
    title: `Edit package ${p.name}`,
    okLabel: 'Save',
    label: p.label,
    members: p.members,
    isDefault: !!p.default,
    holders: p.holders
  })
  if (!v) return
  act(async () => {
    const r = await api('PATCH', `/api/packages/${p.name}`, { label: v.label, members: v.members, default: v.default })
    toast(`"${p.name}" updated — sealed ${r.reconciled.sealed}, removed ${r.reconciled.removed} grant(s)`)
  })
}

async function removePackageEntry (p) {
  const v = await dialog(`Remove package ${p.name}?`, [], {
    okLabel: 'Remove', danger: true,
    body: `<p class="warn-text">Unassigns it from its <b>${p.holders} holder(s)</b> and removes the sealed keys only it covered.</p>
           <p class="muted">Manual grants and auto-granted source channels survive. Viewers that already unsealed a key keep it
           until a stream-key rotation.</p>`
  })
  if (!v) return
  act(() => api('DELETE', `/api/packages/${p.name}`), `package "${p.name}" removed`)
}

// ---------------------------------------------------------------- stream actions

async function addStreamDlg () {
  const v = await dialog('Add stream', [
    { name: 'id', label: 'ID — permanent identifier (letters, digits, . _ -)', placeholder: 'news-24' },
    { name: 'title', label: 'Title (blank = the id)' },
    { name: 'category', label: 'Category' },
    { name: 'feedKey', label: 'Feed key (hex, optional — usually set when the broadcaster registers)' },
    { name: 'url', label: 'Redirect URL (https://…, optional — CDN redirect channel, no P2P feed)', placeholder: 'https://cdn.example.com/ch/index.m3u8' }
  ], { okLabel: 'Add' })
  if (!v) return
  const id = v.id.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return toast('id must start alphanumeric and use only letters, digits, . _ -', true)
  const body = {
    id,
    title: v.title.trim() || undefined,
    category: v.category.trim() || undefined,
    feedKey: v.feedKey.trim() || undefined,
    url: v.url.trim() || undefined // makes it a redirect channel (S23)
  }
  try {
    const r = await api('POST', '/api/streams', body)
    await refresh()
    if (r.encryptionKey) {
      await dialog(`Stream "${r.id}" registered`, [], {
        okLabel: 'Done',
        body: `<p>Encryption key — give it to the broadcaster. <b>It is shown only once:</b></p>
               <div class="keybox mono">${esc(r.encryptionKey)}</div>
               <p>The key is kept panel-private; viewers receive it sealed per-user at login.</p>`
      })
    } else toast(`stream "${r.id}" registered`)
  } catch (err) { toast(err.message, true) }
}
$('#stream-add-btn').addEventListener('click', () => addStreamDlg())
$('#stream-cat-manage').addEventListener('click', () => document.querySelector('[data-tab=categories]').click())
$('#stream-pp').addEventListener('change', () => {
  streamView.per = parseInt($('#stream-pp').value, 10) || 0
  streamView.page = 0
  renderStreams()
})

async function editMeta (s) {
  const v = await dialog(`Edit ${s.id}`, [
    { name: 'title', label: 'Title', value: s.title },
    { name: 'description', label: 'Description', type: 'textarea', value: s.description },
    { name: 'category', label: 'Category (comma-separated)', value: (s.category || []).join(', ') },
    { name: 'feedKey', label: 'Feed key (hex)', value: s.feedKey || '', placeholder: 'set when the broadcaster registers' },
    { name: 'url', label: 'Redirect URL (https:// — plays this instead of a P2P feed; empty = none)', value: s.url || '', placeholder: 'https://cdn.example.com/ch/index.m3u8' },
    { name: 'epgUrl', label: 'EPG feed URL (https:// program guide the app fetches; empty = none)', value: s.epgUrl || '', placeholder: 'https://provider.example/anime.json' },
    { name: 'epgId', label: 'EPG channel id (this channel\'s id inside that feed)', value: s.epgId || '', placeholder: 'demotv.es.629a06…' },
    { name: 'status', label: 'Status', type: 'select', options: ['idle', 'live', 'offline'], value: s.status },
    { name: 'isLive', label: 'Live now', type: 'checkbox', value: s.isLive },
    { name: 'restricted', label: 'access controlled — players require the parental PIN before playing', type: 'checkbox', value: !!s.restricted }
  ])
  if (!v) return
  const body = {
    title: v.title,
    description: v.description,
    category: v.category.split(',').map((x) => x.trim()).filter(Boolean),
    status: v.status,
    isLive: v.isLive,
    restricted: v.restricted,
    url: v.url.trim(), // always sent: empty clears the redirect (explicit status/isLive above win over defaulting)
    epgUrl: v.epgUrl.trim(), // always sent: empty clears the program-guide pointer
    epgId: v.epgId.trim()
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

// Hybrid art: point the field at an operator-hosted https image instead of an upload.
// Clients render remote URLs directly (no P2P replication); https is required —
// Android blocks cleartext off-loopback, so the panel rejects http://.
async function setArtUrl (s, kind) {
  const cur = /^https?:\/\//i.test(s[kind] || '') ? s[kind] : ''
  const v = await dialog(`Remote ${kind} URL — ${s.id}`, [
    { name: 'url', label: 'https:// image URL (leave empty to clear)', value: cur, placeholder: 'https://cdn.example.com/poster.jpg' }
  ], {
    okLabel: 'Save',
    body: '<p class="muted">Viewers fetch remote art directly from this URL; uploaded art replicates peer-to-peer instead. https:// only.</p>'
  })
  if (!v) return
  const url = v.url.trim()
  act(() => api('PATCH', `/api/streams/${s.id}`, { [kind]: url }),
    url ? `${kind} URL set for "${s.id}"` : `${kind} cleared for "${s.id}"`)
}

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

// ---------------------------------------------------------------- analytics (S48)
// Aggregate-only rollups (GET /api/analytics) rendered with hand-rolled inline
// SVG — no chart dependency. Every number is a count; peer-derived figures are a
// LOWER BOUND on audience (viewers serve each other), so they render with "≥".

// Vertical bar chart: series = [{ label, values: [..] }] stacked per slot.
// colors[] maps series index → CSS color. Missing slots render as gaps.
function barsSvg (slots, series, colors, { h = 84 } = {}) {
  const n = slots.length
  if (!n) return '<p class="muted">no data yet</p>'
  const bw = 100 / n
  let max = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const s of series) sum += s.values[i] || 0
    if (sum > max) max = sum
  }
  if (max === 0) max = 1
  let rects = ''
  for (let i = 0; i < n; i++) {
    let y = h - 12
    let total = 0
    for (let si = 0; si < series.length; si++) {
      const v = series[si].values[i] || 0
      total += v
      if (!v) continue
      const bh = Math.max(1, (v / max) * (h - 16))
      y -= bh
      rects += `<rect x="${(i * bw + bw * 0.12).toFixed(2)}%" y="${y.toFixed(1)}" width="${(bw * 0.76).toFixed(2)}%" height="${bh.toFixed(1)}" rx="1" fill="${colors[si]}"></rect>`
    }
    rects += `<rect x="${(i * bw).toFixed(2)}%" y="0" width="${bw.toFixed(2)}%" height="${h - 12}" fill="transparent"><title>${esc(slots[i])} — ${series.map((s) => `${s.label} ${s.values[i] || 0}`).join(', ')} (total ${total})</title></rect>`
  }
  // Sparse hour labels: first, last, and every 12th slot. They live OUTSIDE the
  // svg — preserveAspectRatio="none" stretches the svg to the card width, which
  // turns in-svg <text> into giant horizontally-smeared garble.
  let labels = ''
  for (let i = 0; i < n; i++) {
    if (i !== 0 && i !== n - 1 && i % 12 !== 0) continue
    const pos = i === 0 ? 'left:0' : i === n - 1 ? 'right:0' : `left:${(i * bw + bw / 2).toFixed(2)}%;transform:translateX(-50%)`
    labels += `<span style="${pos}">${esc(slots[i].slice(-3))}</span>`
  }
  return `<svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" role="img">` +
    `<line x1="0" y1="${h - 12}" x2="100%" y2="${h - 12}" stroke="var(--border)" stroke-width="1"></line>` +
    rects + `</svg><div class="an-x">${labels}</div>`
}

// Flatten the API's day rollups into the last `hoursBack` hour slots (UTC),
// including the in-progress hour from `current`. pick(hourEntry) → number.
function hourSeries (a, hoursBack, pick) {
  const byKey = new Map() // 'YYYY-MM-DD H' -> hour entry
  for (const d of a.days) for (const [h, e] of Object.entries(d.hours || {})) byKey.set(d.date + ' ' + h, e)
  if (a.current) byKey.set(a.current.date + ' ' + a.current.hour, a.current)
  const slots = []
  const values = []
  const end = a.current ? Date.parse(a.current.date + 'T00:00:00Z') + a.current.hour * 3600000 : Date.now()
  for (let i = hoursBack - 1; i >= 0; i--) {
    const t = end - i * 3600000
    const date = new Date(t).toISOString().slice(0, 10)
    const hr = new Date(t).getUTCHours()
    slots.push(date.slice(5) + ' ' + String(hr).padStart(2, '0') + 'h')
    const e = byKey.get(date + ' ' + hr)
    values.push(e ? pick(e) : 0)
  }
  return { slots, values }
}

function renderAnalytics (a) {
  $('#an-retention').textContent = a.retentionDays || 0
  if (!a.enabled) {
    $('#an-chips').innerHTML = '<span class="chip">analytics <b>disabled</b> — ANALYTICS_RETENTION_DAYS=0, nothing is collected</span>'
    $('#an-logins').innerHTML = ''
    $('#an-online').innerHTML = ''
    $('#an-days-table tbody').innerHTML = ''
    return
  }
  const today = a.days.find((d) => d.date === (a.current && a.current.date))
  const sumHours = (d, pick) => Object.values(d?.hours || {}).reduce((n, e) => n + pick(e), 0)
  const ok = sumHours(today, (e) => e.logins?.ok || 0) + (a.current?.logins?.ok || 0)
  const failed = sumHours(today, (e) => e.logins?.failed || 0) + (a.current?.logins?.failed || 0)
  const sessions = sumHours(today, (e) => e.sessions || 0) + (a.current?.sessions || 0)
  const uniques = Math.max(today?.day?.uniqueViewers || 0, a.current?.uniqueViewersToday || 0)
  const now = a.current?.onlineAppsNow
  const cat = a.current?.catalog
  $('#an-chips').innerHTML =
    `<span class="chip">logins ok <b>${ok}</b></span>` +
    `<span class="chip">failed <b>${failed}</b></span>` +
    `<span class="chip">sessions <b>${sessions}</b></span>` +
    `<span class="chip" title="unique usernames with a verified session today — a count reduced from an in-memory set, never stored">unique viewers <b>${uniques}</b></span>` +
    `<span class="chip" title="panel swarm connections (last 5-min sample) — includes non-viewer peers such as repeaters; audience is at least this">apps online <b>${now == null ? '—' : '≥ ' + now}</b></span>` +
    (cat ? `<span class="chip">catalog <b>${cat.live}</b> live · <b>${cat.redirect}</b> redirect · <b>${cat.vod}</b> vod</span>` : '')

  const okS = hourSeries(a, 48, (e) => e.logins?.ok || 0)
  const failS = hourSeries(a, 48, (e) => e.logins?.failed || 0)
  $('#an-logins').innerHTML = barsSvg(okS.slots, [
    { label: 'ok', values: okS.values },
    { label: 'failed', values: failS.values }
  ], ['var(--accent)', 'var(--danger)'])

  const onS = hourSeries(a, 48, (e) => e.onlineApps?.mean ?? 0)
  $('#an-online').innerHTML = barsSvg(onS.slots, [{ label: 'mean apps', values: onS.values }], ['var(--ok)'])

  const tbody = $('#an-days-table tbody')
  tbody.innerHTML = ''
  for (const d of [...a.days].reverse()) {
    const isToday = d.date === (a.current && a.current.date)
    const tr = document.createElement('tr')
    tr.innerHTML = `<td class="mono">${esc(d.date)}${isToday ? ' <span class="muted">(so far)</span>' : ''}</td>` +
      `<td>${sumHours(d, (e) => e.logins?.ok || 0) + (isToday ? a.current?.logins?.ok || 0 : 0)}</td>` +
      `<td>${sumHours(d, (e) => e.logins?.failed || 0) + (isToday ? a.current?.logins?.failed || 0 : 0)}</td>` +
      `<td>${sumHours(d, (e) => e.sessions || 0) + (isToday ? a.current?.sessions || 0 : 0)}</td>` +
      `<td>${isToday ? uniques : (d.day?.uniqueViewers ?? '—')}</td>` +
      `<td>≥ ${Math.max(...Object.values(d.hours || {}).map((e) => e.onlineApps?.max || 0), isToday ? (a.current?.onlineApps?.max || 0) : 0)}</td>`
    tbody.appendChild(tr)
  }
  if (!tbody.children.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">no data yet — counts appear as viewers log in</td></tr>'
}

async function loadAnalytics () {
  renderAnalytics(await api('GET', '/api/analytics?days=14'))
}

function startAnalyticsPoll () {
  stopAnalyticsPoll()
  loadAnalytics().catch((err) => toast(err.message, true))
  anTimer = setInterval(() => loadAnalytics().catch(() => {}), 60000)
}

function stopAnalyticsPoll () {
  if (anTimer) { clearInterval(anTimer); anTimer = null }
}

// ---------------------------------------------------------------- reports (S50)
// Viewer problem reports + correlation alerts. EVERYTHING rendered here is either
// panel-generated or VIEWER-AUTHORED free text, so every single interpolation goes
// through esc() — a report is the one surface a hostile client can push arbitrary
// text into. The CSP forbids inline handlers, so actions are delegated clicks that
// read data-* attributes.

let reportsEnabled = true

const RP_CATEGORY_LABEL = {
  'no-audio': 'no audio',
  'black-screen': 'black screen',
  'visual-artifacts': 'visual artifacts',
  buffering: 'buffering',
  'wrong-content': 'wrong content',
  login: 'login',
  other: 'other'
}
const rpTime = (t) => (t ? new Date(t).toLocaleString() : '—')

// The badge counts OPEN alerts (not reports): an alert is the thing that wants an
// operator right now. It rides every refresh, so it is visible from any tab.
async function loadReportsBadge () {
  const s = await api('GET', '/api/reports/summary')
  reportsEnabled = !!s.enabled
  const badge = $('#rp-badge')
  badge.textContent = s.openAlerts || ''
  badge.hidden = !s.openAlerts
  return s
}

function rpFilters () {
  const q = new URLSearchParams({ limit: 300 })
  const status = $('#rp-status').value
  const category = $('#rp-category').value
  const channel = $('#rp-channel').value.trim()
  if (status) q.set('status', status)
  if (category) q.set('category', category)
  if (channel) q.set('channel', channel)
  return q
}

async function loadReports () {
  const [summary, list, alerts] = await Promise.all([
    loadReportsBadge(),
    api('GET', '/api/reports?' + rpFilters()),
    api('GET', '/api/alerts')
  ])
  renderReportsSummary(summary)
  renderAlerts(alerts.alerts || [])
  renderReportList(list.reports || [])
}

function renderReportsSummary (s) {
  if (!s.enabled) {
    $('#rp-chips').innerHTML = '<span class="chip">viewer reports <b>disabled</b> — REPORTS_RETENTION_DAYS=0, the report RPC method is not served</span>'
    $('#rp-chart').innerHTML = ''
    return
  }
  const cats = Object.entries(s.byCategory || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
  $('#rp-chips').innerHTML =
    `<span class="chip">new <b>${s.new || 0}</b></span>` +
    `<span class="chip">acknowledged <b>${s.ack || 0}</b></span>` +
    `<span class="chip">resolved <b>${s.resolved || 0}</b></span>` +
    `<span class="chip">open alerts <b>${s.openAlerts || 0}</b></span>` +
    `<span class="chip" title="reports acknowledged and dropped by the panel-wide breaker (REPORTS_GLOBAL_PER_MIN) since this panel started">shed <b>${s.shed || 0}</b></span>` +
    `<span class="chip" title="reports folded onto an open alert instead of being stored in full (storm collapse)">collapsed <b>${s.collapsed || 0}</b></span>` +
    cats.map(([c, n]) => `<span class="chip">${esc(RP_CATEGORY_LABEL[c] || c)} <b>${n}</b></span>`).join('') +
    `<span class="chip">retention <b>${s.retentionDays || 0}</b> d</span>`

  const hours = s.byHour || []
  const slots = []
  const now = Date.now()
  for (let i = hours.length - 1; i >= 0; i--) {
    const d = new Date(now - i * 3600000)
    slots.push(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}h`)
  }
  $('#rp-chart').innerHTML = barsSvg(slots, [{ label: 'reports', values: hours }], ['var(--accent)'])
}

function renderAlerts (alerts) {
  const el = $('#rp-alerts')
  const open = alerts.filter((a) => a.status !== 'resolved')
  if (!open.length) {
    el.innerHTML = alerts.length
      ? '<p class="muted">No open alerts. ' + alerts.length + ' resolved alert(s) in the retention window.</p>'
      : '<p class="muted">No alerts. One opens when several distinct viewers report the same channel inside the correlation window.</p>'
    return
  }
  el.innerHTML = open.map((a) => {
    const cats = Object.entries(a.categories || {}).sort((x, y) => y[1] - x[1])
      .map(([c, n]) => `<span class="chip">${esc(RP_CATEGORY_LABEL[c] || c)} <b>${n}</b></span>`).join('')
    const who = `${a.reportersCapped ? '≥ ' : ''}${a.reporters || 0}`
    return `<div class="alert-row ${a.status === 'ack' ? 'acked' : ''}">
      <div class="alert-head">
        <span class="badge ${a.status === 'ack' ? 'idle' : 'live'}">${esc(a.status)}</span>
        <strong>${a.kind === 'login' ? 'login problems (panel-wide)' : esc(a.channel || '(no channel)')}</strong>
        <span class="muted" title="distinct reporter pseudonyms — a lower bound once the per-alert set cap is hit">${who} distinct reporter${a.reporters === 1 ? '' : 's'}</span>
        <span class="spacer"></span>
        <button class="btn small" data-alert="${esc(a.id)}" data-act="ack">Ack</button>
        <button class="btn small" data-alert="${esc(a.id)}" data-act="resolve">Resolve</button>
      </div>
      <div class="chips">${cats}${a.shedCount ? `<span class="chip" title="reports the breaker shed while this alert was open">shed <b>${a.shedCount}</b></span>` : ''}<span class="chip">sampled <b>${a.sampled || 0}</b></span></div>
      <div class="muted mono">opened ${esc(rpTime(a.openedAt))} · last ${esc(rpTime(a.lastAt))} · id ${esc(a.id)}</div>
    </div>`
  }).join('')
}

function renderReportList (list) {
  const el = $('#rp-list')
  if (!reportsEnabled) { el.innerHTML = ''; return }
  if (!list.length) {
    el.innerHTML = '<div class="card"><p class="muted">No reports match this filter.</p></div>'
    return
  }
  // Grouped by channel: an operator reads "what is broken", not a flat log.
  const groups = new Map()
  for (const r of list) {
    const k = r.channel || '(no channel)'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  el.innerHTML = ordered.map(([channel, rows]) => {
    const tally = {}
    let occurrences = 0
    for (const r of rows) { tally[r.category] = (tally[r.category] || 0) + (r.count || 1); occurrences += r.count || 1 }
    const chips = Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `<span class="chip">${esc(RP_CATEGORY_LABEL[c] || c)} <b>${n}</b></span>`).join('')
    return `<div class="card">
      <div class="rp-group-head">
        <strong>${esc(channel)}</strong>
        <span class="muted">${rows.length} report${rows.length === 1 ? '' : 's'} · ${occurrences} occurrence${occurrences === 1 ? '' : 's'}</span>
        <span class="spacer"></span>
        <div class="chips">${chips}</div>
      </div>
      ${rows.map(reportRow).join('')}
    </div>`
  }).join('')
}

function reportRow (r) {
  const events = (r.events || []).map((e) =>
    `<li><span class="mono muted">${esc(e.type)}</span> ${esc(e.detail || '')}</li>`).join('')
  return `<details class="rp-item">
    <summary>
      <span class="badge ${r.status === 'resolved' ? 'active' : r.status === 'ack' ? 'idle' : 'live'}">${esc(r.status)}</span>
      <span class="rp-cat">${esc(RP_CATEGORY_LABEL[r.category] || r.category)}</span>
      ${r.count > 1 ? `<span class="chip">×${r.count}</span>` : ''}
      <span class="rp-text">${esc(r.text || '(no description)')}</span>
      <span class="spacer"></span>
      <span class="muted mono">${esc(rpTime(r.lastAt || r.at))}</span>
    </summary>
    <div class="rp-detail">
      <div class="chips">
        <span class="chip" title="pseudonym — HMAC of the session identity, never a username or device id">reporter <b class="mono">${esc(r.reporter || '—')}</b></span>
        <span class="chip">app <b>${esc(r.appVersion || '—')}</b></span>
        <span class="chip">platform <b>${esc(r.platform || '—')}</b></span>
        <span class="chip" title="peers the viewer's player saw — a lower bound">peers <b>${r.peers == null ? '—' : '≥ ' + r.peers}</b></span>
        <span class="chip">first seen <b>${esc(rpTime(r.at))}</b></span>
      </div>
      ${events ? `<p class="muted rp-sub">Recent player events (viewer-reported):</p><ul class="report-list">${events}</ul>` : '<p class="muted rp-sub">No player events attached.</p>'}
      ${r.note ? `<p class="rp-sub"><b>Note:</b> ${esc(r.note)}</p>` : ''}
      <div class="rp-actions">
        <button class="btn small" data-report="${esc(r.id)}" data-act="ack"${r.status === 'new' ? '' : ' disabled'}>Ack</button>
        <button class="btn small" data-report="${esc(r.id)}" data-act="resolve"${r.status === 'resolved' ? ' disabled' : ''}>Resolve…</button>
        <span class="muted mono">id ${esc(r.id)}</span>
      </div>
    </div>
  </details>`
}

// Delegated actions (CSP: no inline handlers anywhere in this dashboard).
$('#rp-alerts').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-alert]')
  if (!btn) return
  try {
    await api('POST', `/api/alerts/${encodeURIComponent(btn.dataset.alert)}/${btn.dataset.act}`)
    toast(`alert ${btn.dataset.act === 'ack' ? 'acknowledged' : 'resolved'}`)
    await loadReports()
  } catch (err) { toast(err.message, true) }
})

$('#rp-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-report]')
  if (!btn) return
  const id = btn.dataset.report
  try {
    if (btn.dataset.act === 'resolve') {
      const v = await dialog('Resolve report', [{ name: 'note', label: 'Note (optional — what fixed it)', type: 'textarea' }], { okLabel: 'Resolve' })
      if (!v) return
      await api('POST', `/api/reports/${encodeURIComponent(id)}/resolve`, { note: v.note })
      toast('report resolved')
    } else {
      await api('POST', `/api/reports/${encodeURIComponent(id)}/ack`)
      toast('report acknowledged')
    }
    await loadReports()
  } catch (err) { toast(err.message, true) }
})

$('#rp-test-notify').addEventListener('click', async () => {
  try {
    const out = await api('POST', '/api/reports/test-notify')
    if (!out.enabled) return toast('no notification targets configured (REPORTS_WEBHOOK_URL / REPORTS_TELEGRAM_*)', true)
    const bad = (out.results || []).filter((r) => !r.ok)
    if (bad.length) toast(bad.map((r) => `${r.target}: ${r.error}`).join(' · '), true)
    else toast(`test notification sent to ${(out.targets || []).join(', ')}`)
  } catch (err) { toast(err.message, true) }
})

let rpFilterTimer = null
for (const sel of ['#rp-status', '#rp-category']) {
  $(sel).addEventListener('change', () => loadReports().catch((err) => toast(err.message, true)))
}
$('#rp-channel').addEventListener('input', () => {
  clearTimeout(rpFilterTimer)
  rpFilterTimer = setTimeout(() => loadReports().catch((err) => toast(err.message, true)), 300)
})

function startReportsPoll () {
  stopReportsPoll()
  loadReports().catch((err) => toast(err.message, true))
  rpTimer = setInterval(() => loadReports().catch(() => {}), 30000)
}

function stopReportsPoll () {
  if (rpTimer) { clearInterval(rpTimer); rpTimer = null }
}

// ---------------------------------------------------------------- boot

;(async () => {
  if (!token) return show('login')
  try { await enterApp() } catch { logout() }
})()
