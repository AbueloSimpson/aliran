/* Aliran reseller panel UI — no framework, no build. Talks only to this service's
   /api (which fronts the panel admin API server-side); the token lives in
   sessionStorage and any 401 drops back to the login view. Sections are shown/
   hidden by the signed-in principal's role. Row actions follow the business-tool
   pattern: one quick action (the everyday op) + a kebab menu for the rest. */

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of [].concat(kids)) if (k != null) n.append(k)
  return n
}
const fmtDays = (d) => d == null ? '—' : d < 0 ? `${-d}d ago` : d === 0 ? 'today' : `${d}d`
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString() : '—'
const fmtBytes = (n) => {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}
const fmtDur = (s) => {
  if (s == null) return '—'
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}
const fmtAgo = (ts) => ts == null ? 'never' : fmtDur((Date.now() - ts) / 1000) + ' ago'
const CAN_MANAGE = new Set(['admin', 'co-admin', 'super'])
const IS_ADMIN = (r) => r === 'admin' || r === 'co-admin'

let token = sessionStorage.getItem('rsl-token') || null
let me = null

// ---- API ----
async function api (method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body != null ? JSON.stringify(body) : undefined
  })
  let json = null
  try { json = await res.json() } catch {}
  if (res.status === 401 && me) return logout()
  if (!res.ok) throw Object.assign(new Error((json && json.error) || res.statusText), { status: res.status })
  return json
}

// ---- toast ----
let toastTimer
function toast (msg, isErr) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.toggle('err', !!isErr)
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, isErr ? 5000 : 2600)
}
const guard = (fn) => async (...a) => { try { return await fn(...a) } catch (e) { toast(e.message, true) } }

// ---- dialog ----
function dialog (title, rows, onOk, { okLabel = 'OK', danger = false } = {}) {
  $('#dlg-title').textContent = title
  const body = $('#dlg-body')
  body.replaceChildren(...rows)
  const ok = $('#dlg-ok')
  ok.textContent = okLabel
  ok.classList.toggle('danger', danger)
  ok.classList.toggle('primary', !danger)
  const dlg = $('#dlg')
  const close = () => { dlg.close(); ok.onclick = null }
  $('#dlg-cancel').onclick = close
  ok.onclick = guard(async () => { if (await onOk() !== false) close() })
  dlg.showModal()
}
const field = (label, input) => el('label', {}, [label, input])
const inputEl = (props) => el('input', props)

// ---- row menu (kebab): one floating singleton, keyboard-complete ----
// Opens below its anchor (flips up near the viewport edge), closes on outside
// press / scroll / resize / Escape, and arrow keys walk the items.
let menuEl = null
let menuAnchor = null
function closeRowMenu (refocus) {
  if (!menuEl) return
  menuEl.remove()
  menuEl = null
  document.removeEventListener('pointerdown', onMenuOutside, true)
  window.removeEventListener('scroll', onMenuScroll, true)
  window.removeEventListener('resize', onMenuAway)
  if (refocus && menuAnchor) menuAnchor.focus()
  menuAnchor = null
}
const onMenuOutside = (e) => { if (menuEl && !menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeRowMenu(false) }
const onMenuScroll = (e) => { if (menuEl && !menuEl.contains(e.target)) closeRowMenu(false) }
const onMenuAway = () => closeRowMenu(false)
function onMenuKeys (e) {
  const items = $$('.menu-item', menuEl)
  const i = items.indexOf(document.activeElement)
  if (e.key === 'Escape') { e.preventDefault(); closeRowMenu(true) } else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus() } else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus() } else if (e.key === 'Home') { e.preventDefault(); items[0].focus() } else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus() } else if (e.key === 'Tab') { closeRowMenu(false) }
}
function openRowMenu (anchor, items) {
  if (menuEl && menuAnchor === anchor) return closeRowMenu(false) // second press toggles
  closeRowMenu(false)
  menuAnchor = anchor
  menuEl = el('div', { className: 'menu', onkeydown: onMenuKeys })
  menuEl.setAttribute('role', 'menu')
  for (const it of items) {
    if (it === '-') { menuEl.append(el('div', { className: 'menu-sep' })); continue }
    const item = el('button', {
      className: 'menu-item' + (it.danger ? ' danger' : ''),
      type: 'button',
      textContent: it.label,
      onclick: () => { closeRowMenu(false); it.onClick() }
    })
    item.setAttribute('role', 'menuitem')
    menuEl.append(item)
  }
  document.body.append(menuEl)
  const a = anchor.getBoundingClientRect()
  const m = menuEl.getBoundingClientRect()
  const x = Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8))
  let y = a.bottom + 4
  if (y + m.height > window.innerHeight - 8) y = Math.max(8, a.top - m.height - 4)
  menuEl.style.left = x + 'px'
  menuEl.style.top = y + 'px'
  document.addEventListener('pointerdown', onMenuOutside, true)
  window.addEventListener('scroll', onMenuScroll, true)
  window.addEventListener('resize', onMenuAway)
  const first = $('.menu-item', menuEl)
  if (first) first.focus()
}
function kebabBtn (label, items) {
  const b = el('button', { className: 'btn icon', type: 'button', textContent: '⋯', title: label, onclick: () => openRowMenu(b, items) })
  b.setAttribute('aria-haspopup', 'menu')
  b.setAttribute('aria-label', label)
  return b
}

// ---- white-label branding (public endpoint; silent fallback to defaults) ----
// A logo file replaces the text brand outright; otherwise the first word
// renders bold and the rest in the accent tone — "Acme TV" reads like
// "Aliran reseller" does. The favicon is the operator's file when set, else a
// dot in the (possibly overridden) accent token. Manual: docs/white-label.md.
async function applyBranding () {
  try {
    const b = await (await fetch('branding.json')).json()
    if (!b || !b.name) return
    document.title = b.name
    $$('.brand').forEach((h) => {
      if (b.logo) {
        h.replaceChildren(el('img', { className: 'brand-logo', src: 'branding/logo', alt: b.name }))
        return
      }
      const parts = b.name.split(' ')
      const kids = [parts[0] + (parts.length > 1 ? ' ' : '')]
      if (parts.length > 1) kids.push(el('span', { textContent: parts.slice(1).join(' ') }))
      h.replaceChildren(...kids)
    })
    if (b.favicon) {
      $('link[rel="icon"]').href = 'branding/favicon'
    } else if (b.accent && /^#[0-9a-fA-F]{6}$/.test(b.accent)) {
      $('link[rel="icon"]').href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23${b.accent.slice(1)}'/%3E%3C/svg%3E`
    }
  } catch {}
}
applyBranding()

// ---- auth ----
function showLogin () {
  $('#app-view').hidden = true
  $('#login-view').hidden = false
}
function logout () {
  token = null; me = null
  sessionStorage.removeItem('rsl-token')
  showLogin()
}
$('#logout-btn').onclick = logout

$('#login-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  const r = await api('POST', '/login', { username: $('#login-user').value, password: $('#login-pass').value })
  token = r.token
  sessionStorage.setItem('rsl-token', token)
  $('#login-error').hidden = true
  await boot()
})

// ---- navigation ----
function showView (name) {
  closeRowMenu(false)
  clearInterval(sysTimer) // the system poller runs only while Overview is open
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name))
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name })
  $('#view-title').textContent = { overview: 'Overview', accounts: 'Accounts', resellers: 'Resellers', ledger: 'Ledger', settings: 'Settings' }[name]
  $('#app-view').classList.remove('side-open')
  const loaders = { overview: loadOverview, accounts: loadAccounts, resellers: loadPrincipals, ledger: () => loadLedger(true) }
  if (loaders[name]) loaders[name]()
}
$$('.nav-item').forEach((n) => { n.onclick = () => showView(n.dataset.view) })
$('#side-toggle').onclick = () => $('#app-view').classList.toggle('side-open')

// ---- boot ----
async function boot () {
  me = await api('GET', '/me')
  $('#login-view').hidden = true
  $('#app-view').hidden = false
  $('#who-name').textContent = me.name
  $('#who-role').textContent = me.role
  $('#who-avatar').textContent = (me.name[0] || '?').toUpperCase()
  $('#bal').textContent = me.balance
  $$('.nav-item[data-cap="manage"]').forEach((n) => { n.hidden = !CAN_MANAGE.has(me.role) })
  $('#sys-block').hidden = !IS_ADMIN(me.role)
  $('#mint-panel').hidden = !IS_ADMIN(me.role)
  $('#ops-card').hidden = !IS_ADMIN(me.role)
  // Device policy: admin-set + inherited. Admins get the field (prefilled with
  // the policy); everyone else sees the read-only value their accounts receive.
  $('#acct-devices-label').hidden = !IS_ADMIN(me.role)
  $('#acct-devices-note').hidden = IS_ADMIN(me.role)
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  else $('#acct-devices-note').textContent = `devices per account: ${me.maxDevicesLimit} (set by your admin)`
  setupPrincipalForm()
  showView('overview')
}

// ---- overview ----
async function loadOverview () {
  const s = await api('GET', '/status')
  const tiles = [
    ['Balance', s.balance, ''],
    ['Active accounts', s.accountsActive ?? 0, ''],
    ['Expiring ≤ 7d', s.accountsExpiring7d ?? 0, s.accountsExpiring7d ? 'warn' : ''],
    ['Trials active', s.trialsActive ?? 0, ''],
    ['Disabled', s.accountsDisabled ?? 0, '']
  ]
  if (IS_ADMIN(me.role)) {
    tiles.push(['Principals', s.principals ?? 0, ''])
    tiles.push(['Outstanding credits', s.outstandingCredits ?? 0, ''])
  }
  $('#tiles').replaceChildren(...tiles.map(([k, v, cls]) =>
    el('div', { className: 'tile' + (cls ? ' ' + cls : '') }, [
      el('div', { className: 'k', textContent: k }),
      el('div', { className: 'v', textContent: v })
    ])))
  // The topbar banner (broadcaster idiom): one colored status line under the
  // title — panel link state for admins, a personal summary for resellers.
  const banner = $('#banner')
  if (s.panel) {
    const up = s.panel.reachable
    banner.className = 'banner ' + (up === false ? 'err' : up ? 'ok' : '')
    banner.textContent = up === false ? 'panel unreachable' : up ? 'panel reachable' : 'panel state unknown'
    if (s.reconcile) banner.textContent += ` · last reconcile: ${s.reconcile.orphanPanel + s.reconcile.missingPanel + s.reconcile.statusFixed} finding(s), ${s.reconcile.errors} error(s)`
  } else {
    banner.className = 'banner'
    banner.textContent = `${s.accountsActive ?? 0} active account(s) · ${s.accountsExpiring7d ?? 0} expiring ≤ 7d · balance ${s.balance}`
  }
  const rc = $('#reconcile-card')
  if (s.reconcile) {
    rc.hidden = false
    const r = s.reconcile
    $('#reconcile-summary').textContent =
      `${new Date(r.ts).toLocaleString()} — checked ${r.checked}, orphans ${r.orphanPanel}, missing ${r.missingPanel}, status fixed ${r.statusFixed}, errors ${r.errors}`
  } else rc.hidden = true
  // Admin tiers get the system diagnostics on the same landing view — one ops
  // dashboard on login. (Non-admins never call /api/system: it would 403.)
  if (IS_ADMIN(me.role)) startSystem()
}

// ---- accounts (server-driven: search/filter/sort/paging all happen in the API,
// so the table works the same at 10 accounts or 10,000) ----
const PAGE = 50
let acctRows = []
let acctTotal = 0
let acctQuery = { q: '', filter: '', owner: '', sort: 'name', dir: 'asc', page: 0 }
let acctDebounce

function acctParams () {
  const p = new URLSearchParams({ limit: String(PAGE), offset: String(acctQuery.page * PAGE), sort: acctQuery.sort, dir: acctQuery.dir })
  if (acctQuery.q) p.set('q', acctQuery.q)
  if (acctQuery.filter) p.set('filter', acctQuery.filter)
  if (acctQuery.owner) p.set('owner', acctQuery.owner)
  return p
}

// Latest-wins: every call gets a token, and only the newest response renders —
// so rapid clicks (page, sort, filter) never drop a user action or let a slow
// response clobber a newer one. A NULL gotoPage means "reload the current page"
// (post-mutation refresh); a number navigates.
let acctSeq = 0
async function loadAccounts (gotoPage = 0) {
  const seq = ++acctSeq
  acctQuery.page = gotoPage == null ? acctQuery.page : Math.max(0, gotoPage)
  let r = await api('GET', '/accounts?' + acctParams())
  // A deletion can leave the current page past the end — snap back once.
  const pages = Math.max(1, Math.ceil(r.total / PAGE))
  if (acctQuery.page >= pages && r.total > 0) {
    acctQuery.page = pages - 1
    r = await api('GET', '/accounts?' + acctParams())
  }
  if (seq !== acctSeq) return // a newer request superseded this one
  acctRows = r.items
  acctTotal = r.total
  renderAccounts()
}

function renderAccounts () {
  closeRowMenu(false)
  const tb = $('#acct-table tbody')
  tb.replaceChildren(...acctRows.map(accountRow))
  const filtered = !!(acctQuery.q || acctQuery.filter || acctQuery.owner)
  $('#acct-empty').textContent = filtered ? 'No matches.' : 'No accounts yet.'
  $('#acct-empty').hidden = acctRows.length > 0

  const start = acctQuery.page * PAGE
  $('#acct-count').textContent = acctTotal ? `${start + 1}–${start + acctRows.length} of ${acctTotal}` : ''
  $('#acct-count').hidden = acctTotal === 0

  // Pager: prev/next + a jump-to-page combo (rebuilt when the page count moves).
  const pages = Math.max(1, Math.ceil(acctTotal / PAGE))
  $('#acct-pager').hidden = pages <= 1
  $('#acct-prev').disabled = acctQuery.page === 0
  $('#acct-next').disabled = acctQuery.page >= pages - 1
  $('#acct-pages').textContent = pages
  const sel = $('#acct-page')
  if (sel.options.length !== pages) {
    sel.replaceChildren(...Array.from({ length: pages }, (_, i) => el('option', { value: i, textContent: i + 1 })))
  }
  sel.value = String(acctQuery.page)

  // Keep the toolbar sort combo and the header arrows in agreement.
  $('#acct-sort').value = `${acctQuery.sort}:${acctQuery.dir}`
  $$('#acct-table th').forEach((x) => x.classList.remove('sorted-asc', 'sorted-desc'))
  const th = $(`#acct-table th[data-k="${acctQuery.sort}"]`)
  if (th) th.classList.add(acctQuery.dir === 'asc' ? 'sorted-asc' : 'sorted-desc')

  const chip = $('#acct-owner-chip')
  chip.hidden = !acctQuery.owner
  if (acctQuery.owner) chip.innerHTML = `owner <b>${acctQuery.owner}</b> ✕`
  $$('#acct-table th[data-col="owner"]').forEach((h) => { h.style.display = IS_ADMIN(me.role) || me.role === 'super' ? '' : 'none' })
}

const canDrillOwner = () => IS_ADMIN(me.role) || me.role === 'super'
function drillOwner (owner) {
  if (!canDrillOwner()) return
  acctQuery.owner = owner
  guard(loadAccounts)()
}
const statusEl = (cls, text) => el('span', { className: 'status ' + cls, title: text }, [el('span', { className: 'dot' }), text])
function accountRow (r) {
  const status = r.status === 'active'
    ? (r.expiresInDays <= 7 ? statusEl('warn', 'expiring') : statusEl('ok', 'active'))
    : statusEl('err', r.status)
  const kindBadge = r.kind === 'trial' ? el('span', { className: 'badge trial', textContent: 'trial' }) : null
  // One quick action (Renew — the everyday op on a subscription clock) + the
  // rest behind a kebab. Suspend/Resume stays contextual to the row's state.
  const menuItems = [
    r.status === 'active'
      ? { label: 'Suspend', onClick: guard(() => accountStatus(r, 'disabled')) }
      : (r.expiresInDays > 0 ? { label: 'Resume', onClick: guard(() => accountStatus(r, 'active')) } : null),
    { label: 'Devices…', onClick: guard(() => devicesDialog(r)) },
    { label: 'Change password…', onClick: () => passwordDialog(r) },
    '-',
    { label: 'Delete…', danger: true, onClick: () => deleteAccountDialog(r) }
  ].filter(Boolean)
  const actions = el('div', { className: 'row-actions' }, [
    btn('Renew', () => renewDialog(r)),
    kebabBtn(`More actions — ${r.account}`, menuItems)
  ])
  const ownerLink = (cls) => el('span', {
    className: cls + (canDrillOwner() ? ' owner-link' : ''),
    textContent: r.owner,
    onclick: canDrillOwner() ? () => drillOwner(r.owner) : null,
    title: canDrillOwner() ? `Show only ${r.owner}'s accounts` : ''
  })
  // data-l labels surface as "expires: 31d" prefixes in the phone card layout,
  // where the column headers are hidden.
  const tdExpires = el('td', { className: 'num', textContent: fmtDays(r.expiresInDays) })
  tdExpires.dataset.l = 'expires'
  const tdCreated = el('td', { className: 'num hide-mobile', textContent: fmtDate(r.createdAt) })
  const tdDevices = el('td', { className: 'num', textContent: r.maxDevices })
  tdDevices.dataset.l = 'devices'
  return el('tr', {}, [
    el('td', { className: 'cell-main' }, el('div', { className: 'cell-name' }, [
      el('span', { className: 't mono', textContent: r.account }),
      ownerLink('muted owner-sub')
    ])),
    tdColOwner(ownerLink('')),
    el('td', { className: 'cell-status' }, el('span', { className: 'chips' }, [status, kindBadge].filter(Boolean))),
    tdExpires,
    tdCreated,
    tdDevices,
    el('td', { className: 'cell-actions' }, actions)
  ])
}
function tdColOwner (child) {
  // Hidden on phones too (the owner already shows under the account name).
  const td = el('td', { className: 'hide-mobile' }, child)
  if (!canDrillOwner()) td.style.display = 'none'
  return td
}
const btn = (label, onClick, cls = '') => el('button', { className: 'btn small' + (cls ? ' ' + cls : ''), textContent: label, onclick: onClick })

$('#acct-search').oninput = () => {
  clearTimeout(acctDebounce)
  acctDebounce = setTimeout(guard(() => { acctQuery.q = $('#acct-search').value.trim(); return loadAccounts(0) }), 250)
}
$('#acct-refresh').onclick = guard(() => loadAccounts(acctQuery.page))
$('#acct-owner-chip').onclick = () => { acctQuery.owner = ''; guard(() => loadAccounts(0))() }
$('#acct-prev').onclick = guard(() => loadAccounts(acctQuery.page - 1))
$('#acct-next').onclick = guard(() => loadAccounts(acctQuery.page + 1))
$('#acct-page').onchange = () => guard(() => loadAccounts(parseInt($('#acct-page').value, 10) || 0))()
$('#acct-sort').onchange = () => {
  const [sort, dir] = $('#acct-sort').value.split(':')
  acctQuery.sort = sort
  acctQuery.dir = dir
  guard(() => loadAccounts(0))()
}
$$('#acct-filter button').forEach((b) => {
  b.onclick = () => {
    acctQuery.filter = b.dataset.f === 'all' ? '' : b.dataset.f
    $$('#acct-filter button').forEach((x) => x.classList.toggle('active', x === b))
    guard(() => loadAccounts(0))()
  }
})
$$('#acct-table th.sortable').forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.k
    acctQuery.dir = acctQuery.sort === k && acctQuery.dir === 'asc' ? 'desc' : 'asc'
    acctQuery.sort = k
    guard(() => loadAccounts(0))()
  }
})

$('#account-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  const body = {
    name: $('#acct-name').value,
    password: $('#acct-pass').value,
    months: +$('#acct-months').value,
    // Non-admins omit maxDevices — the account receives the inherited policy.
    ...(IS_ADMIN(me.role) ? { maxDevices: +$('#acct-devices').value } : {})
  }
  const r = await api('POST', '/accounts', body)
  toast(`Activated ${r.account} (${r.expiresInDays}d)`)
  $('#account-form').reset()
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
})
$('#acct-trial-btn').onclick = guard(async () => {
  const name = $('#acct-name').value
  if (!name) return toast('Enter a name first', true)
  const r = await api('POST', '/trials', {
    name,
    password: $('#acct-pass').value || 'trial-' + Math.random().toString(36).slice(2, 10),
    ...(IS_ADMIN(me.role) ? { maxDevices: +$('#acct-devices').value } : {})
  })
  toast(`Trial ${r.account} started`)
  $('#account-form').reset()
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  await loadAccounts(acctQuery.page)
})

function renewDialog (r) {
  const months = inputEl({ type: 'number', min: '1', max: '120', value: '1' })
  dialog(`Renew ${r.account}`, [
    field('Months (1 credit each)', months),
    el('p', { className: 'dlg-note', textContent: r.kind === 'trial' ? 'This converts the trial to a paid account.' : '' })
  ], async () => {
    const out = await api('POST', `/accounts/${encodeURIComponent(r.account)}/renew`, { months: +months.value })
    toast(`Renewed to ${out.expiresInDays}d`)
    await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
  }, { okLabel: 'Renew' })
}
async function accountStatus (r, status) {
  await api('POST', `/accounts/${encodeURIComponent(r.account)}/status`, { status })
  toast(`${r.account} ${status === 'disabled' ? 'suspended' : 'resumed'}`)
  await loadAccounts(acctQuery.page)
}
function passwordDialog (r) {
  const pw = inputEl({ type: 'password', minLength: 8 })
  dialog(`Password for ${r.account}`, [field('New password', pw)], async () => {
    await api('POST', `/accounts/${encodeURIComponent(r.account)}/password`, { password: pw.value })
    toast('Password changed')
  }, { okLabel: 'Change' })
}
async function devicesDialog (r) {
  const list = await api('GET', `/accounts/${encodeURIComponent(r.account)}/devices`)
  const rows = list.length
    ? list.map((d) => el('div', { className: 'dlg-list-row' }, [
        el('span', { className: 'meta' }, [
          el('b', { textContent: d.label || d.deviceId.slice(0, 8) }),
          d.expired ? el('span', { className: 'muted', textContent: ' (expired)' }) : null
        ].filter(Boolean)),
        btn('Revoke', guard(async () => { await api('DELETE', `/accounts/${encodeURIComponent(r.account)}/devices/${encodeURIComponent(d.deviceId)}`); toast('Device revoked') }), 'danger')
      ]))
    : [el('p', { className: 'muted', textContent: 'No devices enrolled.' })]
  dialog(`Devices — ${r.account}`, rows, () => {}, { okLabel: 'Done' })
}
function deleteAccountDialog (r) {
  const confirm = inputEl({ placeholder: r.account })
  const refund = IS_ADMIN(me.role) ? 0 : Math.max(0, Math.floor(r.expiresInDays / 31))
  dialog(`Delete ${r.account}`, [
    el('p', { className: 'dlg-note warn', textContent: IS_ADMIN(me.role) ? 'Admin deletes refund nothing.' : `Refund on delete: ~${refund} credit(s).` }),
    field('Type the account name to confirm', confirm)
  ], async () => {
    if (confirm.value !== r.account) { toast('Name does not match', true); return false }
    const out = await api('DELETE', `/accounts/${encodeURIComponent(r.account)}`)
    toast(`Deleted (refunded ${out.refunded})`)
    await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
  }, { okLabel: 'Delete', danger: true })
}

// ---- principals ----
function setupPrincipalForm () {
  const roleSel = $('#p-role')
  const opts = []
  if (me.root) opts.push('co-admin')
  if (IS_ADMIN(me.role)) opts.push('super')
  if (CAN_MANAGE.has(me.role)) opts.push('reseller')
  roleSel.replaceChildren(...opts.map((r) => el('option', { value: r, textContent: r })))
}
async function loadPrincipals () {
  const list = await api('GET', '/principals')
  closeRowMenu(false)
  const tb = $('#p-table tbody')
  const q = $('#p-search').value.trim().toLowerCase()
  const rows = list.filter((p) => !q || p.name.toLowerCase().includes(q))
  tb.replaceChildren(...rows.map(principalRow))
}
function principalRow (p) {
  const menuItems = [
    can('credits:transfer') ? { label: 'Reclaim credits…', onClick: () => reclaimDialog(p) } : null,
    { label: 'Limits…', onClick: () => limitsDialog(p) },
    { label: p.status === 'active' ? 'Suspend…' : 'Resume…', onClick: () => suspendDialog(p) },
    { label: 'Change password…', onClick: () => principalPasswordDialog(p) },
    '-',
    { label: 'Delete…', danger: true, onClick: () => deletePrincipalDialog(p) }
  ].filter(Boolean)
  const actions = el('div', { className: 'row-actions' }, [
    CAN_MANAGE.has(me.role) && can('credits:transfer') ? btn('Fund', () => transferDialog(p)) : null,
    kebabBtn(`More actions — ${p.name}`, menuItems)
  ].filter(Boolean))
  return el('tr', {}, [
    el('td', {}, el('div', { className: 'cell-name' }, [
      el('span', { className: 't', textContent: p.name })
    ])),
    el('td', {}, el('span', { className: 'badge role', textContent: p.role })),
    el('td', { textContent: p.parent || '—' }),
    el('td', { className: 'num', textContent: p.balance }),
    el('td', { className: 'num', textContent: p.accounts }),
    el('td', {}, statusEl(p.status === 'active' ? 'ok' : 'err', p.status)),
    el('td', {}, actions)
  ])
}
const can = (cap) => {
  const map = { 'credits:transfer': ['admin', 'co-admin', 'super'], 'credits:mint': ['admin', 'co-admin'] }
  return (map[cap] || []).includes(me.role)
}
$('#p-search').oninput = loadPrincipals
$('#p-refresh').onclick = guard(loadPrincipals)
$('#principal-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  const body = { username: $('#p-name').value, password: $('#p-pass').value, role: $('#p-role').value }
  await api('POST', '/principals', body)
  toast(`Created ${body.username}`)
  $('#principal-form').reset(); setupPrincipalForm()
  await loadPrincipals()
})
function transferDialog (p) {
  const amt = inputEl({ type: 'number', min: '1', value: '1' })
  dialog(`Fund ${p.name}`, [field(`Credits (you have ${me.balance})`, amt)], async () => {
    await api('POST', '/credits/transfer', { to: p.name, amount: +amt.value })
    toast(`Sent ${amt.value} to ${p.name}`); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: 'Send' })
}
function reclaimDialog (p) {
  const amt = inputEl({ type: 'number', min: '1', value: '1' })
  dialog(`Reclaim from ${p.name}`, [field(`Credits (they hold ${p.balance})`, amt)], async () => {
    const out = await api('POST', '/credits/reclaim', { from: p.name, amount: +amt.value })
    toast(`Reclaimed ${out.amount}`); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: 'Reclaim' })
}
function limitsDialog (p) {
  const trial = inputEl({ type: 'number', min: '0', value: p.trialDailyCap })
  // The device policy is admin-set + inherited: supers see it read-only and can
  // only tune the trial cap; admins set an explicit value or blank = inherit.
  if (!IS_ADMIN(me.role)) {
    dialog(`Limits — ${p.name}`, [
      el('p', { className: 'dlg-note', textContent: `Devices per account: ${p.maxDevicesLimit}${p.maxDevicesLimitInherited ? ' (inherited)' : ''} — set by the admin.` }),
      field('Trials per day', trial)
    ], async () => {
      await api('POST', `/principals/${encodeURIComponent(p.name)}/limits`, { trialDailyCap: +trial.value })
      toast('Limits updated'); await loadPrincipals()
    }, { okLabel: 'Save' })
    return
  }
  const dev = inputEl({
    type: 'number',
    min: '1',
    value: p.maxDevicesLimitInherited ? '' : p.maxDevicesLimit,
    placeholder: `inherit (${p.maxDevicesLimitIfInherited})`
  })
  dialog(`Limits — ${p.name}`, [
    field('Devices per account — blank = inherit' + (p.parent ? ` from ${p.parent}` : ''), dev),
    el('p', { className: 'dlg-note', textContent: 'Inherited by every principal under this one; their new accounts receive this device count.' }),
    field('Trials per day', trial)
  ], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/limits`, {
      maxDevicesLimit: dev.value === '' ? null : +dev.value,
      trialDailyCap: +trial.value
    })
    toast('Limits updated'); await loadPrincipals()
  }, { okLabel: 'Save' })
}
function suspendDialog (p) {
  const next = p.status === 'active' ? 'suspended' : 'active'
  const withAccts = inputEl({ type: 'checkbox' })
  dialog(`${next === 'suspended' ? 'Suspend' : 'Resume'} ${p.name}`, [
    el('label', { className: 'radio-row' }, [withAccts, 'Also ' + (next === 'suspended' ? 'disable' : 'enable') + ' their viewer accounts on the panel'])
  ], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/status`, { status: next, mode: withAccts.checked ? 'with-accounts' : 'panel-only' })
    toast(`${p.name} ${next}`); await loadPrincipals()
  }, { okLabel: next === 'suspended' ? 'Suspend' : 'Resume', danger: next === 'suspended' })
}
function principalPasswordDialog (p) {
  const pw = inputEl({ type: 'password', minLength: 8 })
  dialog(`Password for ${p.name}`, [field('New password', pw)], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/password`, { password: pw.value })
    toast('Password changed (their sessions revoked)')
  }, { okLabel: 'Change' })
}
function deletePrincipalDialog (p) {
  dialog(`Delete ${p.name}`, [
    el('p', { className: 'dlg-note', textContent: 'Blocked while they have child principals or accounts. Any remaining balance is reclaimed to you.' })
  ], async () => {
    await api('DELETE', `/principals/${encodeURIComponent(p.name)}`)
    toast(`Deleted ${p.name}`); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: 'Delete', danger: true })
}

// ---- ledger ----
let ledgerType = ''
let ledgerCursor = null
async function loadLedger (reset) {
  if (reset) { ledgerCursor = null; $('#ledger-table tbody').replaceChildren() }
  const q = new URLSearchParams({ limit: '50' })
  if (ledgerType) q.set('type', ledgerType)
  if (ledgerCursor) q.set('before', ledgerCursor)
  const rows = await api('GET', '/ledger?' + q)
  const tb = $('#ledger-table tbody')
  for (const tx of rows) tb.append(ledgerRow(tx))
  if (rows.length) ledgerCursor = rows[rows.length - 1].seq
  $('#ledger-more').disabled = rows.length < 50
}
function ledgerRow (tx) {
  const mine = tx.entries.find((e) => e.principal === me.name)
  const delta = mine ? mine.delta : (tx.entries[0] ? tx.entries[0].delta : 0)
  const other = tx.entries.map((e) => e.principal).filter((n) => n !== me.name).join(', ') || tx.actor
  return el('tr', {}, [
    el('td', { className: 'num muted', textContent: tx.seq }),
    el('td', { textContent: new Date(tx.ts).toLocaleString() }),
    el('td', {}, el('span', { className: 'badge dim', textContent: tx.type })),
    el('td', { className: 'num' }, el('span', {
      className: 'delta' + (delta > 0 ? ' pos' : delta < 0 ? ' neg' : ''),
      textContent: delta > 0 ? '+' + delta : (delta || '')
    })),
    el('td', { textContent: other }),
    el('td', { className: 'mono', textContent: tx.account || '' }),
    el('td', { className: 'muted', textContent: tx.note || '' })
  ])
}
$$('#ledger-filter button').forEach((b) => { b.onclick = () => { ledgerType = b.dataset.t; $$('#ledger-filter button').forEach((x) => x.classList.toggle('active', x === b)); loadLedger(true) } })
$('#ledger-more').onclick = guard(() => loadLedger(false))
$('#mint-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  await api('POST', '/credits/mint', { to: $('#mint-to').value || undefined, amount: +$('#mint-amount').value, note: $('#mint-note').value })
  toast('Minted'); $('#mint-form').reset(); await Promise.all([loadLedger(true), refreshBalance()])
})

// ---- system diagnostics (admin tiers) — the Overview's System section: panel
// link + service process + host machine. Polled every 5 s while Overview is
// open; the poller dies on first error so a dropped session can't drum the
// toast. ----
let sysTimer
function startSystem () {
  guard(loadSystem)()
  clearInterval(sysTimer)
  sysTimer = setInterval(async () => {
    try { await loadSystem() } catch (e) { clearInterval(sysTimer); toast(e.message, true) }
  }, 5000)
}
$('#sys-refresh').onclick = guard(loadSystem)

// kv accepts a string or a prebuilt node; strings get a hover title so
// ellipsized values (paths, keys, CPU models) stay readable.
const kvRows = (pairs) => pairs.flatMap(([label, val, opts = {}]) => [
  el('div', { className: 'k', textContent: label }),
  val instanceof Node
    ? el('div', { className: 'v' }, val)
    : el('div', { className: 'v' + (opts.mono ? ' mono' : ''), textContent: val, title: opts.title ?? String(val) })
])

async function loadSystem () {
  const s = await api('GET', '/system')
  const h = s.host
  const p = s.panel
  const memUsed = h.totalMemBytes - h.freeMemBytes
  const hasLoad = Array.isArray(h.loadavg) && h.loadavg.some((x) => x > 0)
  const disk = h.disk

  const tiles = [
    ['Panel link',
      p ? (p.reachable === false ? 'down' : p.latencyMs != null ? `${p.latencyMs} ms` : '—') : 'n/a',
      p && p.reachable === false ? 'unreachable' : 'round-trip',
      p ? (p.reachable === false ? 'err' : p.latencyMs != null ? 'ok' : '') : ''],
    ['Host memory', fmtBytes(memUsed), `of ${fmtBytes(h.totalMemBytes)}`,
      memUsed / h.totalMemBytes > 0.9 ? 'warn' : ''],
    ['Load (1m)', hasLoad ? h.loadavg[0].toFixed(2) : '—', `${h.cpuCount} core${h.cpuCount === 1 ? '' : 's'}`,
      hasLoad && h.loadavg[0] > h.cpuCount ? 'warn' : ''],
    ['Disk free', disk ? fmtBytes(disk.freeBytes) : '—', disk ? `of ${fmtBytes(disk.totalBytes)}` : 'unavailable',
      disk && disk.freeBytes / disk.totalBytes < 0.1 ? 'warn' : '']
  ]
  $('#sys-tiles').replaceChildren(...tiles.map(([k, v, sub, cls]) =>
    el('div', { className: 'tile' + (cls ? ' ' + cls : '') }, [
      el('div', { className: 'k', textContent: k }),
      el('div', { className: 'v', textContent: v }),
      el('div', { className: 's', textContent: sub })
    ])))

  const panelRows = p
    ? [
        ['State', statusEl(p.reachable === false ? 'err' : p.reachable ? 'ok' : '', p.reachable === false ? 'unreachable' : p.reachable ? 'reachable' : 'unknown')],
        ['URL', p.url, { mono: true }],
        ['Latency', p.latencyMs != null ? `${p.latencyMs} ms` : '—'],
        ['Last OK', fmtAgo(p.lastOkAt)],
        ['Last error', p.lastError || p.error || '—', { title: p.lastError || p.error || '' }],
        ...(p.stats
          ? [
              ['Viewer users', p.stats.users],
              ['Streams', `${p.stats.streams} (${p.stats.live} live)`],
              ['Panel admins', p.stats.admins],
              ['Panel key', `${String(p.stats.panelKey).slice(0, 16)}…`, { mono: true, title: p.stats.panelKey }]
            ]
          : [])
      ]
    : [['State', 'no panel configured']]
  $('#sys-panel').replaceChildren(...kvRows(panelRows))

  const sv = s.service
  $('#sys-service').replaceChildren(...kvRows([
    ['Node', sv.node],
    ['PID', sv.pid],
    ['Uptime', fmtDur(sv.uptimeSec)],
    ['Memory (RSS)', fmtBytes(sv.rssBytes)],
    ['Heap used', fmtBytes(sv.heapUsedBytes)],
    ['Data dir', sv.dataDir, { mono: true }],
    ...(sv.ledger ? [['Ledger', statusEl(sv.ledger.invariantOk ? 'ok' : 'err', `seq ${sv.ledger.seq} · ${sv.ledger.invariantOk ? 'consistent' : 'INVARIANT BROKEN'}`)]] : []),
    ...(sv.sweeps ? [['Last sweep', fmtAgo(sv.sweeps.lastRunAt)]] : []),
    ...(sv.webhook ? [['Top-up webhook', sv.webhook.enabled ? 'enabled' : 'disabled']] : [])
  ]))

  $('#sys-host').replaceChildren(...kvRows([
    ['Hostname', h.hostname],
    ['OS', `${h.platform} ${h.release} (${h.arch})`],
    ['CPU', `${h.cpuModel} × ${h.cpuCount}`],
    ['Load avg', hasLoad ? h.loadavg.map((x) => x.toFixed(2)).join(' / ') : '—'],
    ['Memory', `${fmtBytes(memUsed)} / ${fmtBytes(h.totalMemBytes)}`],
    ['Disk', disk ? `${fmtBytes(disk.totalBytes - disk.freeBytes)} / ${fmtBytes(disk.totalBytes)}` : '—'],
    ['Uptime', fmtDur(h.uptimeSec)]
  ]))

  $('#sys-updated').textContent = `updated ${new Date(s.now).toLocaleTimeString()}`
}

// ---- settings ----
$('#pw-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  await api('POST', '/me/password', { password: $('#pw-new').value })
  toast('Password changed — sign in again')
  setTimeout(logout, 900)
})
$('#op-sweep').onclick = guard(async () => { const r = await api('POST', '/ops/sweep'); toast(`Sweep: ${r.disabled} disabled, ${r.errors.length} errors`) })
$('#op-reconcile').onclick = guard(async () => {
  const r = await api('POST', '/ops/reconcile')
  dialog('Reconcile report', [el('pre', { className: 'report-box', textContent: JSON.stringify(r, null, 2) })], () => {}, { okLabel: 'Close' })
})

async function refreshBalance () {
  me = await api('GET', '/me')
  $('#bal').textContent = me.balance
}

// ---- start ----
if (token) boot().catch(() => showLogin())
else showLogin()
