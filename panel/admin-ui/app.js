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

const TAB_NAMES = ['streams', 'users', 'packages', 'admins', 'publishers', 'sources', 'categories', 'overview']
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
  const [status, s, a, p, src, cats, pkgs] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/streams'), api('GET', '/api/admins'), api('GET', '/api/publishers'), api('GET', '/api/sources'), api('GET', '/api/categories'), api('GET', '/api/packages')])
  streams = s
  categories = cats
  admins = a
  publishers = p
  channelSources = src
  channelPackages = pkgs
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
    const manual = new Set(u.manualGrants || [])
    for (const g of u.grants) {
      if (pkgIds.has(g) && !manual.has(g)) continue // folded into the package chip
      const auto = !manual.has(g)
      const chip = document.createElement('span')
      chip.className = 'chip' + (auto ? ' auto' : '')
      if (auto) chip.title = 'auto-granted by a channel source (auto-grant) — a revoke lasts only until that source\'s next sync'
      chip.innerHTML = `${esc(g)} <button class="x" title="revoke">✕</button>`
      chip.querySelector('.x').addEventListener('click', () => revokeGrant(u.username, g))
      grants.appendChild(chip)
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
          ${s.redirect ? '<span class="badge redirect" title="CDN redirect channel — viewers play the URL, not a P2P feed">⇢ REDIRECT</span>' : ''}
          ${s.origin ? `<span class="chip" title="registered by enrolled publisher &quot;${esc(s.origin)}&quot; (last register)">⇡ ${esc(s.origin)}</span>` : ''}
          ${s.source ? `<span class="chip" title="imported from channel source &quot;${esc(s.source)}&quot; — the feed overwrites mapped fields on every sync">⇣ ${esc(s.source)}</span>` : ''}
          ${s.featured ? '<span class="badge featured">★ FEATURED</span>' : ''}
          ${(s.category || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}
        </div>
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
    list.appendChild(card)
  }
  if (streams.length === 0) list.innerHTML = '<div class="card muted">No streams yet — add one above.</div>'
}

// Enrolled broadcaster identities (S26): per-site keys + channel scopes.
function renderPublishers () {
  const tbody = $('#publishers-table tbody')
  tbody.innerHTML = ''
  for (const p of publishers) {
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
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no publishers enrolled — broadcasters are using the shared legacy key. Enroll each site above to give it its own scoped key.</td></tr>'
  }
}

// Remote channel sources (S27): provider feeds materialized as redirect-channel categories.
// Categories are rendered as a shallow tree: a parent row, then its children indented
// beneath it. The hierarchy is encoded in the slug ('Parent/Child'), so there is nothing
// to join — sorting the slugs already groups them.
function renderCategories () {
  const tbody = $('#categories-table tbody')
  tbody.innerHTML = ''
  if (!categories.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no categories yet — they appear as soon as a channel carries one</td></tr>'
    return
  }
  const roots = categories.filter((c) => !c.parent)
  const kids = (p) => categories.filter((c) => c.parent === p)
  const orphans = categories.filter((c) => c.parent && !roots.some((r) => r.slug === c.parent))
  const ordered = []
  for (const r of roots) { ordered.push([r, 0]); for (const k of kids(r.slug)) ordered.push([k, 1]) }
  for (const o of orphans) ordered.push([o, 1]) // parent slug never registered/in use
  for (const [c, depth] of ordered) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${depth ? '<span class="muted">└ </span>' : ''}<b>${esc(c.slug.split('/').pop())}</b>${depth ? '' : ''}<br><span class="mono muted">${esc(c.slug)}</span></td>
      <td>${c.label !== c.slug ? esc(c.label) : '<span class="muted">—</span>'}</td>
      <td>${c.channels}</td>
      <td class="muted">${c.order != null ? c.order : '—'}</td>
      <td>${c.hidden ? '<span class="badge disabled">hidden</span> ' : ''}${c.registered ? '' : '<span class="chip" title="in use on channels but has no presentation entry yet">unregistered</span>'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="edit">edit</button>
        <button class="btn small" data-act="rename">rename</button>
        <button class="btn small" data-act="merge">merge</button>
        <button class="btn small danger" data-act="forget"${c.registered ? '' : ' disabled'}>forget</button>
      </div></td>`
    tr.querySelector('[data-act=edit]').addEventListener('click', () => editCategory(c))
    tr.querySelector('[data-act=rename]').addEventListener('click', () => renameCategoryDlg(c))
    tr.querySelector('[data-act=merge]').addEventListener('click', () => mergeCategoryDlg(c))
    const forget = tr.querySelector('[data-act=forget]')
    if (c.registered) forget.addEventListener('click', () => forgetCategory(c))
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
  for (const s of channelSources) {
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
    tbody.innerHTML = '<tr><td colspan="7" class="muted">no sources yet — add a provider feed above and its channels appear as a category</td></tr>'
  }
}

// Channel packages / bouquets (S44): named bundles materialized into sealed
// per-user grants. The resolved arrays fetched here also feed the Users-tab
// provenance chips (package vs manual vs auto).
function renderPackages () {
  const tbody = $('#packages-table tbody')
  tbody.innerHTML = ''
  for (const p of channelPackages) {
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
    tbody.innerHTML = '<tr><td colspan="6" class="muted">no packages yet — define a bouquet above, then assign it to users</td></tr>'
  }
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

// ---------------------------------------------------------------- publisher actions

$('#add-publisher-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('#np-name').value.trim()
  const scopes = $('#np-scopes').value.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const p = await api('POST', '/api/publishers', { name, scopes })
    e.target.reset()
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
})

async function editPublisherScopes (p) {
  const v = await dialog(`Channel scopes — ${p.name}`, [
    { name: 'scopes', label: 'streamId globs, comma-separated (* matches any run; * alone = every channel)', value: p.scopes.join(', '), placeholder: 'east-*,espn2' }
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

// Upsert: the same form creates a presentation entry for a category already in use on
// channels, or edits one that exists. There is no "create a category" as such — a
// category exists because a channel carries it.
$('#add-category-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const order = $('#ncat-order').value
  act(async () => {
    await api('POST', '/api/categories', {
      slug: $('#ncat-slug').value.trim(),
      label: $('#ncat-label').value.trim() || undefined,
      order: order === '' ? null : Number(order),
      hidden: $('#ncat-hidden').checked
    })
    e.target.reset()
  }, 'category saved')
})

$('#add-source-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('#nsrc-name').value.trim()
  const body = { name, url: $('#nsrc-url').value.trim(), category: $('#nsrc-category').value.trim() }
  try {
    await api('POST', '/api/sources', body)
    e.target.reset()
    toast(`source "${name}" added — pulling the feed…`)
    await syncSourceNow(name)
  } catch (err) { toast(err.message, true) }
})

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

$('#add-package-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const name = $('#npk-name').value.trim()
  act(async () => {
    await api('POST', '/api/packages', {
      name,
      label: $('#npk-label').value.trim() || undefined,
      members: $('#npk-members').value,
      default: $('#npk-default').checked
    })
    e.target.reset()
  }, `package "${name}" created — assign it on the Users tab`)
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
  const v = await dialog(`Edit package ${p.name}`, [
    { name: 'label', label: 'Display label', value: p.label },
    { name: 'members', label: 'Members (comma-separated: ids, id globs, category:<slug>, source:<name>)', type: 'textarea', value: p.members.join(', ') },
    { name: 'default', label: 'default for new users (existing users are not touched)', type: 'checkbox', value: !!p.default }
  ], {
    body: `<p class="muted">Member edits materialize immediately for the <b>${p.holders} holder(s)</b>: missing keys are sealed, keys only this package covered are removed.</p>`
  })
  if (!v) return
  act(async () => {
    const r = await api('PATCH', `/api/packages/${p.name}`, { label: v.label.trim(), members: v.members, default: v.default })
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

$('#add-stream-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const body = {
    id: $('#ns-id').value.trim(),
    title: $('#ns-title').value.trim() || undefined,
    category: $('#ns-category').value.trim() || undefined,
    feedKey: $('#ns-feed').value.trim() || undefined,
    url: $('#ns-url').value.trim() || undefined // makes it a redirect channel (S23)
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
    { name: 'url', label: 'Redirect URL (https:// — plays this instead of a P2P feed; empty = none)', value: s.url || '', placeholder: 'https://cdn.example.com/ch/index.m3u8' },
    { name: 'epgUrl', label: 'EPG feed URL (https:// program guide the app fetches; empty = none)', value: s.epgUrl || '', placeholder: 'https://provider.example/anime.json' },
    { name: 'epgId', label: 'EPG channel id (this channel\'s id inside that feed)', value: s.epgId || '', placeholder: 'plutotv.es.629a06…' },
    { name: 'status', label: 'Status', type: 'select', options: ['idle', 'live', 'offline'], value: s.status },
    { name: 'isLive', label: 'Live now', type: 'checkbox', value: s.isLive }
  ])
  if (!v) return
  const body = {
    title: v.title,
    description: v.description,
    category: v.category.split(',').map((x) => x.trim()).filter(Boolean),
    status: v.status,
    isLive: v.isLive,
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

// ---------------------------------------------------------------- boot

;(async () => {
  if (!token) return show('login')
  try { await enterApp() } catch { logout() }
})()
