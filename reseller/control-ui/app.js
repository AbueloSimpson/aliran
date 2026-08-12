/* Aliran reseller panel UI — no framework, no build. Talks only to this service's
   /api (which fronts the panel admin API server-side); the token lives in
   sessionStorage and any 401 drops back to the login view. Sections are shown/
   hidden by the signed-in principal's role. Row actions follow the business-tool
   pattern: one quick action (the everyday op) + a kebab menu for the rest.

   Every user-facing string comes from t() / tOr() / tNodes(), defined by i18n.js
   (loaded first). Text that is DATA — account and principal names, ledger notes,
   channel titles, API error messages — is echoed as it arrives and never looked up. */

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of [].concat(kids)) if (k != null) n.append(k)
  return n
}
// Dates and numbers follow the chosen language too, not just the words around them.
const fmtDays = (d) => d == null ? '—' : d < 0 ? t('fmt.daysAgo', { n: -d }) : d === 0 ? t('fmt.today') : t('fmt.days', { n: d })
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString(i18n.locale) : '—'
const fmtDateTime = (ts) => new Date(ts).toLocaleString(i18n.locale)
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
const fmtAgo = (ts) => ts == null ? t('common.never') : t('fmt.ago', { d: fmtDur((Date.now() - ts) / 1000) })
// A status or ledger type is a server-side enum: translate the ones we ship, echo
// anything newer rather than showing a missing-key string.
const statusText = (s) => tOr('status.' + s, s)
const ledgerTypeText = (ty) => tOr('ledger.type.' + ty, ty)
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
function dialog (title, rows, onOk, { okLabel = t('common.ok'), danger = false } = {}) {
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
  if (dlg.open) dlg.close() // a dialog may swap to another (Channels → Manage packages)
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
    // Login backdrop: an image (with a bg-tinted scrim keeping the card
    // readable) beats a pattern; the style name is server-validated.
    const lv = $('#login-view')
    if (b.loginBg) {
      lv.classList.add('login-has-bg')
      lv.style.backgroundImage =
        'linear-gradient(color-mix(in srgb, var(--bg) 55%, transparent), color-mix(in srgb, var(--bg) 82%, transparent)), url("branding/login-bg")'
    } else if (b.loginStyle && b.loginStyle !== 'glow') {
      lv.classList.add('login-style-' + b.loginStyle)
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
let currentView = 'overview'
function showView (name) {
  closeRowMenu(false)
  clearInterval(sysTimer) // the system poller runs only while Overview is open
  currentView = name
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name))
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name })
  $('#view-title').textContent = t('nav.' + name)
  $('#app-view').classList.remove('side-open')
  const loaders = { overview: loadOverview, accounts: loadAccounts, resellers: loadPrincipals, ledger: () => loadLedger(true), settings: () => { if (me && IS_ADMIN(me.role)) loadBackup().catch((e) => toast(e.message, true)) } }
  if (loaders[name]) loaders[name]()
}
$$('.nav-item').forEach((n) => { n.onclick = () => showView(n.dataset.view) })
$('#side-toggle').onclick = () => $('#app-view').classList.toggle('side-open')

// A language change re-renders everything the catalog touches. i18n.js has already
// re-applied the static markup; this redraws what app.js built. Signed out, there is
// nothing but the login card, and that is static.
i18n.onChange(() => {
  if (!me) return
  $('#acct-devices-note').textContent = t('accounts.devicesNote', { n: me.maxDevicesLimit })
  showView(currentView)
})

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
  $('#bk-card').hidden = !IS_ADMIN(me.role)
  // Device policy: admin-set + inherited. Admins get the field (prefilled with
  // the policy); everyone else sees the read-only value their accounts receive.
  $('#acct-devices-label').hidden = !IS_ADMIN(me.role)
  $('#acct-devices-note').hidden = IS_ADMIN(me.role)
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  else $('#acct-devices-note').textContent = t('accounts.devicesNote', { n: me.maxDevicesLimit })
  setupPrincipalForm()
  showView('overview')
}

// ---- overview ----
async function loadOverview () {
  const s = await api('GET', '/status')
  const tiles = [
    [t('overview.tile.balance'), s.balance, ''],
    [t('overview.tile.activeAccounts'), s.accountsActive ?? 0, ''],
    [t('overview.tile.expiring7d'), s.accountsExpiring7d ?? 0, s.accountsExpiring7d ? 'warn' : ''],
    [t('overview.tile.trialsActive'), s.trialsActive ?? 0, ''],
    [t('overview.tile.disabled'), s.accountsDisabled ?? 0, '']
  ]
  if (IS_ADMIN(me.role)) {
    tiles.push([t('overview.tile.principals'), s.principals ?? 0, ''])
    tiles.push([t('overview.tile.outstanding'), s.outstandingCredits ?? 0, ''])
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
    banner.textContent = up === false ? t('overview.panelUnreachable') : up ? t('overview.panelReachable') : t('overview.panelUnknown')
    if (s.reconcile) {
      banner.textContent += t('overview.reconcileLine', {
        findings: s.reconcile.orphanPanel + s.reconcile.missingPanel + s.reconcile.statusFixed + (s.reconcile.packagesFixed || 0),
        errors: s.reconcile.errors
      })
    }
  } else {
    banner.className = 'banner'
    banner.textContent = t('overview.resellerBanner', {
      active: s.accountsActive ?? 0,
      expiring: s.accountsExpiring7d ?? 0,
      balance: s.balance
    })
  }
  const rc = $('#reconcile-card')
  if (s.reconcile) {
    rc.hidden = false
    const r = s.reconcile
    $('#reconcile-summary').textContent = t('overview.reconcileSummary', {
      when: fmtDateTime(r.ts),
      checked: r.checked,
      orphans: r.orphanPanel,
      missing: r.missingPanel,
      status: r.statusFixed,
      packages: r.packagesFixed ?? 0,
      errors: r.errors
    })
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
  $('#acct-empty').textContent = filtered ? t('accounts.noMatches') : t('accounts.empty')
  $('#acct-empty').hidden = acctRows.length > 0

  const start = acctQuery.page * PAGE
  $('#acct-count').textContent = acctTotal
    ? t('accounts.countRange', { from: start + 1, to: start + acctRows.length, total: acctTotal })
    : ''
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
  // Built as nodes, not innerHTML: the owner name is panel data, not a repo constant.
  if (acctQuery.owner) chip.replaceChildren(...tNodes('accounts.ownerChip', { owner: acctQuery.owner }))
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
    ? (r.expiresInDays <= 7 ? statusEl('warn', t('status.expiring')) : statusEl('ok', t('status.active')))
    : statusEl('err', statusText(r.status))
  const kindBadge = r.kind === 'trial' ? el('span', { className: 'badge trial', textContent: t('accounts.trialBadge') }) : null
  // One quick action (Renew — the everyday op on a subscription clock) + the
  // rest behind a kebab. Suspend/Resume stays contextual to the row's state.
  const menuItems = [
    r.status === 'active'
      ? { label: t('accounts.menu.suspend'), onClick: guard(() => accountStatus(r, 'disabled')) }
      : (r.expiresInDays > 0 ? { label: t('accounts.menu.resume'), onClick: guard(() => accountStatus(r, 'active')) } : null),
    { label: t('accounts.menu.channels'), onClick: guard(() => channelsDialog(r)) },
    { label: t('accounts.menu.packages'), onClick: guard(() => managePackagesDialog(r)) },
    { label: t('accounts.menu.devices'), onClick: guard(() => devicesDialog(r)) },
    { label: t('accounts.menu.logoutAll'), onClick: guard(async () => { await api('POST', `/accounts/${encodeURIComponent(r.account)}/logout-all`); toast(t('accounts.toast.logoutAll', { account: r.account })) }) },
    { label: t('common.menu.changePassword'), onClick: () => passwordDialog(r) },
    '-',
    { label: t('common.menu.delete'), danger: true, onClick: () => deleteAccountDialog(r) }
  ].filter(Boolean)
  const actions = el('div', { className: 'row-actions' }, [
    btn(t('accounts.renew'), () => renewDialog(r)),
    kebabBtn(t('common.moreActions', { name: r.account }), menuItems)
  ])
  const ownerLink = (cls) => el('span', {
    className: cls + (canDrillOwner() ? ' owner-link' : ''),
    textContent: r.owner,
    onclick: canDrillOwner() ? () => drillOwner(r.owner) : null,
    title: canDrillOwner() ? t('accounts.showOnlyOwner', { owner: r.owner }) : ''
  })
  // data-l labels surface as "expires: 31d" prefixes in the phone card layout,
  // where the column headers are hidden.
  const tdExpires = el('td', { className: 'num', textContent: fmtDays(r.expiresInDays) })
  tdExpires.dataset.l = t('accounts.mobile.expires')
  const tdCreated = el('td', { className: 'num hide-mobile', textContent: fmtDate(r.createdAt) })
  const tdDevices = el('td', { className: 'num', textContent: r.maxDevices })
  tdDevices.dataset.l = t('accounts.mobile.devices')
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

// ---- catalog passthroughs (packages + streams; the server caches 60 s, this
// session cache just avoids refetching per keystroke/dialog) ----
let pkgCatalog = null
let streamCatalog = null
const getPackagesList = async (fresh) => {
  if (fresh || !pkgCatalog) pkgCatalog = await api('GET', '/packages')
  return pkgCatalog
}
const getStreamsList = async () => {
  if (!streamCatalog) streamCatalog = await api('GET', '/streams')
  return streamCatalog
}
const streamTitle = (id) => {
  const s = (streamCatalog || []).find((x) => x.id === id)
  return s && s.title ? s.title : id
}
// The packages that cover a stream id, out of a package-name list.
const coveringPackages = (names, id) =>
  (names || []).filter((n) => {
    const p = (pkgCatalog || []).find((x) => x.name === n)
    return p && Array.isArray(p.resolved) && p.resolved.includes(id)
  })
const pkgBadge = (name) => el('span', { className: 'badge pkg', textContent: '▣ ' + name, title: t('accounts.chan.pkgTitle', { name }) })
// "<name> · 12 ch", plus "· default" when the panel marks the package a default.
const pkgSub = (p) => t(p.default ? 'accounts.pkgSubDefault' : 'accounts.pkgSub', { name: p.name, count: (p.resolved || []).length })

// One checkbox row (shared by the activate pickers and the manage dialog).
function pickRow ({ value, checked, main, sub }) {
  const cb = el('input', { type: 'checkbox', value, checked: !!checked })
  return el('label', { className: 'pick-row' }, [
    cb,
    el('span', { className: 'pick-main', textContent: main }),
    sub ? el('span', { className: 'muted sub', textContent: sub }) : null
  ])
}
const pickedValues = (root) => $$('input[type=checkbox]', root).filter((c) => c.checked).map((c) => c.value)

// Activate-form pickers: packages (defaults pre-checked — untick to opt out)
// and the per-channel one-offs. Loaded when the Add panel first opens; a panel
// outage degrades to a note, never blocks the form.
async function loadAcctPickers () {
  const pkgBox = $('#acct-packages')
  const exBox = $('#acct-extra')
  try {
    const [pkgs] = await Promise.all([getPackagesList(true), getStreamsList()])
    pkgBox.replaceChildren(...(pkgs.length
      ? pkgs.map((p) => pickRow({
          value: p.name,
          checked: p.default === true,
          main: p.label || p.name,
          sub: pkgSub(p)
        }))
      : [el('span', { className: 'muted', textContent: t('accounts.noPackages') })]))
    const streams = streamCatalog || []
    exBox.replaceChildren(...(streams.length
      ? streams.map((s) => pickRow({ value: s.id, main: s.title || s.id, sub: s.id }))
      : [el('span', { className: 'muted', textContent: t('accounts.noChannels') })]))
  } catch (e) {
    const note = () => el('span', { className: 'muted', textContent: t('common.unavailable', { error: e.message }) })
    pkgBox.replaceChildren(note())
    exBox.replaceChildren(note())
  }
}
$('#acct-add-panel').addEventListener('toggle', () => { if ($('#acct-add-panel').open) guard(loadAcctPickers)() })
$('#acct-extra-filter').oninput = () => {
  const q = $('#acct-extra-filter').value.trim().toLowerCase()
  $$('#acct-extra .pick-row').forEach((row) => {
    row.hidden = !!q && !row.textContent.toLowerCase().includes(q)
  })
}

$('#account-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  const packages = pickedValues($('#acct-packages'))
  const grants = pickedValues($('#acct-extra'))
  const body = {
    name: $('#acct-name').value,
    password: $('#acct-pass').value,
    months: +$('#acct-months').value,
    // Sent only when picked: an empty packages list means the panel's own
    // default packages apply, and this keeps that path explicit server-side.
    ...(packages.length ? { packages } : {}),
    ...(grants.length ? { grants } : {}),
    // Non-admins omit maxDevices — the account receives the inherited policy.
    ...(IS_ADMIN(me.role) ? { maxDevices: +$('#acct-devices').value } : {})
  }
  const r = await api('POST', '/accounts', body)
  toast(r.packages && r.packages.length
    ? t('accounts.toast.activatedWithPackages', { account: r.account, days: r.expiresInDays, packages: r.packages.join(', ') })
    : t('accounts.toast.activated', { account: r.account, days: r.expiresInDays }))
  $('#account-form').reset()
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  guard(loadAcctPickers)() // reset unchecked everything — restore the default pre-checks
  await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
})
$('#acct-trial-btn').onclick = guard(async () => {
  const name = $('#acct-name').value
  if (!name) return toast(t('accounts.toast.nameFirst'), true)
  const r = await api('POST', '/trials', {
    name,
    password: $('#acct-pass').value || 'trial-' + Math.random().toString(36).slice(2, 10),
    ...(IS_ADMIN(me.role) ? { maxDevices: +$('#acct-devices').value } : {})
  })
  toast(t('accounts.toast.trialStarted', { account: r.account }))
  $('#account-form').reset()
  if (IS_ADMIN(me.role)) $('#acct-devices').value = me.maxDevicesLimit
  await loadAccounts(acctQuery.page)
})

function renewDialog (r) {
  const months = inputEl({ type: 'number', min: '1', max: '120', value: '1' })
  dialog(t('accounts.renewTitle', { account: r.account }), [
    field(t('accounts.monthsField'), months),
    el('p', { className: 'dlg-note', textContent: r.kind === 'trial' ? t('accounts.trialConvertNote') : '' })
  ], async () => {
    const out = await api('POST', `/accounts/${encodeURIComponent(r.account)}/renew`, { months: +months.value })
    toast(t('accounts.toast.renewed', { days: out.expiresInDays }))
    await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
  }, { okLabel: t('accounts.renew') })
}
async function accountStatus (r, status) {
  await api('POST', `/accounts/${encodeURIComponent(r.account)}/status`, { status })
  toast(t(status === 'disabled' ? 'accounts.toast.suspended' : 'accounts.toast.resumed', { account: r.account }))
  await loadAccounts(acctQuery.page)
}
function passwordDialog (r) {
  const pw = inputEl({ type: 'password', minLength: 8 })
  dialog(t('accounts.passwordTitle', { account: r.account }), [field(t('common.newPassword'), pw)], async () => {
    await api('POST', `/accounts/${encodeURIComponent(r.account)}/password`, { password: pw.value })
    toast(t('common.toast.passwordChanged'))
  }, { okLabel: t('common.change') })
}
// Devices are SELF-ENROLLED: the viewer app registers itself at sign-in (id +
// label), the panel stamps the dates and enforces the slot cap there. So this
// dialog reads as slots + sign-in freshness, and is honest about what Revoke
// does (cooperative: frees the slot; the app drops to login on its next check).
async function devicesDialog (r) {
  const list = await api('GET', `/accounts/${encodeURIComponent(r.account)}/devices`)
  const active = () => list.filter((d) => !d.revoked && !d.expired).length
  const slotText = () => t('accounts.devices.slots', { active: active(), max: r.maxDevices })
  const slots = el('p', { className: 'dlg-note', textContent: slotText() })
  const rows = [slots]
  if (!list.length) {
    rows.push(el('p', { className: 'muted', textContent: t('accounts.devices.none') }))
  } else {
    for (const d of list) {
      const sub = t(d.expired ? 'accounts.devices.subExpired' : 'accounts.devices.subLive', {
        enrolled: fmtDate(d.issuedAt),
        expires: fmtDate(d.expiresAt)
      })
      const row = el('div', { className: 'dlg-list-row' }, [
        el('div', { className: 'meta' }, [
          el('div', { className: 'dev-top' }, [
            statusEl(d.expired ? '' : 'ok', d.label || t('accounts.devices.unnamed')),
            el('span', { className: 'mono muted dev-id', textContent: d.deviceId.slice(0, 12) + (d.deviceId.length > 12 ? '…' : ''), title: d.deviceId })
          ]),
          el('div', { className: 'muted dev-sub', textContent: sub })
        ]),
        btn(t('common.revoke'), guard(async () => {
          await api('DELETE', `/accounts/${encodeURIComponent(r.account)}/devices/${encodeURIComponent(d.deviceId)}`)
          d.revoked = true
          row.remove()
          slots.textContent = slotText() // re-rendered, not patched: the count is not always first
          toast(t('accounts.devices.toastRevoked'))
        }), 'danger')
      ])
      rows.push(row)
    }
    rows.push(el('p', { className: 'dlg-note', textContent: t('accounts.devices.note') }))
  }
  dialog(t('accounts.devices.title', { account: r.account }), rows, () => {}, { okLabel: t('common.done') })
}
// The account's entitlement view: package chips, then every live channel with
// its provenance (▣ package / one-off / dashed auto), a Revoke on the rows the
// reseller can meaningfully act on, and the one-off Add. All state is LIVE from
// the panel via the account GET — the registry alone can't see panel defaults.
async function channelsDialog (r) {
  const body = el('div', { className: 'chan-dlg' })
  const render = async () => {
    const [acct] = await Promise.all([
      api('GET', `/accounts/${encodeURIComponent(r.account)}`),
      getPackagesList().catch(() => null),
      getStreamsList().catch(() => null)
    ])
    const live = acct.live
    if (!live) {
      body.replaceChildren(
        el('p', { className: 'dlg-note warn', textContent: t('accounts.chan.panelDown') }),
        el('p', {
          className: 'muted',
          textContent: t('accounts.chan.localOnly', {
            packages: (acct.packages || []).join(', ') || t('common.none'),
            oneOffs: (acct.extraGrants || []).join(', ') || t('common.none')
          })
        })
      )
      return
    }
    const rows = []
    // -- packages --
    rows.push(el('div', { className: 'dlg-sect' }, [
      el('span', { className: 'dlg-sect-title', textContent: t('accounts.chan.packages') }),
      btn(t('accounts.chan.manage'), () => managePackagesDialog(r, { back: true }))
    ]))
    rows.push(el('div', { className: 'chips' },
      live.packages && live.packages.length
        ? live.packages.map(pkgBadge)
        : [el('span', { className: 'muted', textContent: t('accounts.chan.noPackages') })]))
    // -- channels --
    rows.push(el('div', { className: 'dlg-sect' }, [
      el('span', { className: 'dlg-sect-title', textContent: t('accounts.chan.channels', { count: (live.grants || []).length }) })
    ]))
    const manual = new Set(live.manualGrants || [])
    for (const id of (live.grants || [])) {
      const covering = coveringPackages(live.packages, id)
      const tags = [
        ...covering.map(pkgBadge),
        manual.has(id) ? el('span', { className: 'badge dim', textContent: t('accounts.chan.oneOff') }) : null,
        !covering.length && !manual.has(id) ? el('span', { className: 'badge auto', textContent: t('accounts.chan.auto') }) : null
      ].filter(Boolean)
      // Pure-auto grants come from the panel's autoGrant sources ("everyone
      // gets this") — a revoke here would flap back on the next source sync,
      // so the action is only offered where it sticks.
      const revocable = manual.has(id) || covering.length > 0
      rows.push(el('div', { className: 'dlg-list-row' }, [
        el('div', { className: 'meta' }, [
          el('div', { className: 'dev-top' }, [
            el('span', { className: 't', textContent: streamTitle(id) }),
            el('span', { className: 'mono muted dev-id', textContent: id, title: id })
          ]),
          el('div', { className: 'chips chan-tags' }, tags)
        ]),
        revocable
          ? btn(t('common.revoke'), guard(async () => {
              const out = await api('DELETE', `/accounts/${encodeURIComponent(r.account)}/grants/${encodeURIComponent(id)}`)
              if (out.stillGranted) {
                const via = coveringPackages(live.packages, id)
                toast(t('accounts.chan.toastStillGranted', { packages: via.join(', ') || t('accounts.chan.bouquet') }))
              } else {
                toast(t('accounts.chan.toastRevoked', { channel: streamTitle(id) }))
              }
              await render()
            }), 'danger')
          : null
      ]))
    }
    // -- add a one-off --
    const options = ((streamCatalog || []).filter((s) => !(live.grants || []).includes(s.id)))
    if (options.length) {
      const sel = el('select', { className: 'chan-add-sel' },
        options.map((s) => el('option', { value: s.id, textContent: (s.title || s.id) + ` (${s.id})` })))
      rows.push(el('div', { className: 'dlg-sect' }, [
        el('span', { className: 'dlg-sect-title', textContent: t('accounts.chan.addTitle') })
      ]))
      rows.push(el('div', { className: 'chan-add' }, [
        sel,
        btn(t('common.add'), guard(async () => {
          await api('POST', `/accounts/${encodeURIComponent(r.account)}/grants`, { streamId: sel.value })
          toast(t('accounts.chan.toastGranted', { channel: streamTitle(sel.value) }))
          await render()
        }))
      ]))
    }
    body.replaceChildren(...rows)
  }
  await render()
  dialog(t('accounts.chan.title', { account: r.account }), [body], () => {}, { okLabel: t('common.done') })
}

// Replace the account's bouquets: every package the panel knows, current ones
// pre-checked. Packages carry no credit price — assignment is free by design.
async function managePackagesDialog (r, { back = false } = {}) {
  const [acct, pkgs] = await Promise.all([
    api('GET', `/accounts/${encodeURIComponent(r.account)}`),
    getPackagesList(true)
  ])
  const current = new Set((acct.live && acct.live.packages) || acct.packages || [])
  if (!pkgs.length) {
    dialog(t('accounts.pkg.title', { account: r.account }), [
      el('p', { className: 'muted', textContent: t('accounts.pkg.none') })
    ], () => {}, { okLabel: t('common.done') })
    return
  }
  const box = el('div', { className: 'picker dlg-picker' },
    pkgs.map((p) => pickRow({
      value: p.name,
      checked: current.has(p.name),
      main: p.label || p.name,
      sub: pkgSub(p)
    })))
  dialog(t('accounts.pkg.title', { account: r.account }), [
    box,
    el('p', { className: 'dlg-note', textContent: t('accounts.pkg.note') })
  ], async () => {
    const out = await api('POST', `/accounts/${encodeURIComponent(r.account)}/packages`, { packages: pickedValues(box) })
    toast(t('accounts.pkg.toastSet', { packages: out.packages.length ? out.packages.join(', ') : t('common.none') }))
    pkgCatalog = null // holder counts moved
    if (back) setTimeout(() => guard(channelsDialog)(r), 0)
  }, { okLabel: t('common.save') })
}

function deleteAccountDialog (r) {
  const confirm = inputEl({ placeholder: r.account })
  const refund = IS_ADMIN(me.role) ? 0 : Math.max(0, Math.floor(r.expiresInDays / 31))
  dialog(t('accounts.delete.title', { account: r.account }), [
    el('p', { className: 'dlg-note warn', textContent: IS_ADMIN(me.role) ? t('accounts.delete.adminNote') : t('accounts.delete.refundNote', { n: refund }) }),
    field(t('accounts.delete.confirmField'), confirm)
  ], async () => {
    if (confirm.value !== r.account) { toast(t('accounts.delete.mismatch'), true); return false }
    const out = await api('DELETE', `/accounts/${encodeURIComponent(r.account)}`)
    toast(t('accounts.delete.toast', { n: out.refunded }))
    await Promise.all([loadAccounts(acctQuery.page), refreshBalance()])
  }, { okLabel: t('common.delete'), danger: true })
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
    can('credits:transfer') ? { label: t('resellers.menu.reclaim'), onClick: () => reclaimDialog(p) } : null,
    { label: t('resellers.menu.limits'), onClick: () => limitsDialog(p) },
    { label: t(p.status === 'active' ? 'resellers.menu.suspend' : 'resellers.menu.resume'), onClick: () => suspendDialog(p) },
    { label: t('common.menu.changePassword'), onClick: () => principalPasswordDialog(p) },
    '-',
    { label: t('common.menu.delete'), danger: true, onClick: () => deletePrincipalDialog(p) }
  ].filter(Boolean)
  const actions = el('div', { className: 'row-actions' }, [
    CAN_MANAGE.has(me.role) && can('credits:transfer') ? btn(t('resellers.fund'), () => transferDialog(p)) : null,
    kebabBtn(t('common.moreActions', { name: p.name }), menuItems)
  ].filter(Boolean))
  return el('tr', {}, [
    el('td', {}, el('div', { className: 'cell-name' }, [
      el('span', { className: 't', textContent: p.name })
    ])),
    el('td', {}, el('span', { className: 'badge role', textContent: p.role })),
    el('td', { textContent: p.parent || '—' }),
    el('td', { className: 'num', textContent: p.balance }),
    el('td', { className: 'num', textContent: p.accounts }),
    el('td', {}, statusEl(p.status === 'active' ? 'ok' : 'err', statusText(p.status))),
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
  toast(t('resellers.toast.created', { name: body.username }))
  $('#principal-form').reset(); setupPrincipalForm()
  await loadPrincipals()
})
function transferDialog (p) {
  const amt = inputEl({ type: 'number', min: '1', value: '1' })
  dialog(t('resellers.fund.title', { name: p.name }), [field(t('resellers.fund.field', { balance: me.balance }), amt)], async () => {
    await api('POST', '/credits/transfer', { to: p.name, amount: +amt.value })
    toast(t('resellers.fund.toast', { amount: amt.value, name: p.name })); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: t('common.send') })
}
function reclaimDialog (p) {
  const amt = inputEl({ type: 'number', min: '1', value: '1' })
  dialog(t('resellers.reclaim.title', { name: p.name }), [field(t('resellers.reclaim.field', { balance: p.balance }), amt)], async () => {
    const out = await api('POST', '/credits/reclaim', { from: p.name, amount: +amt.value })
    toast(t('resellers.reclaim.toast', { amount: out.amount })); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: t('resellers.reclaim.ok') })
}
function limitsDialog (p) {
  const trial = inputEl({ type: 'number', min: '0', value: p.trialDailyCap })
  // The device policy is admin-set + inherited: supers see it read-only and can
  // only tune the trial cap; admins set an explicit value or blank = inherit.
  if (!IS_ADMIN(me.role)) {
    dialog(t('resellers.limits.title', { name: p.name }), [
      el('p', {
        className: 'dlg-note',
        textContent: t(p.maxDevicesLimitInherited ? 'resellers.limits.readOnlyInherited' : 'resellers.limits.readOnly', { n: p.maxDevicesLimit })
      }),
      field(t('resellers.limits.trialsPerDay'), trial)
    ], async () => {
      await api('POST', `/principals/${encodeURIComponent(p.name)}/limits`, { trialDailyCap: +trial.value })
      toast(t('resellers.limits.toast')); await loadPrincipals()
    }, { okLabel: t('common.save') })
    return
  }
  const dev = inputEl({
    type: 'number',
    min: '1',
    value: p.maxDevicesLimitInherited ? '' : p.maxDevicesLimit,
    placeholder: t('resellers.limits.inheritPlaceholder', { n: p.maxDevicesLimitIfInherited })
  })
  dialog(t('resellers.limits.title', { name: p.name }), [
    field(p.parent ? t('resellers.limits.devicesFieldFrom', { parent: p.parent }) : t('resellers.limits.devicesField'), dev),
    el('p', { className: 'dlg-note', textContent: t('resellers.limits.note') }),
    field(t('resellers.limits.trialsPerDay'), trial)
  ], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/limits`, {
      maxDevicesLimit: dev.value === '' ? null : +dev.value,
      trialDailyCap: +trial.value
    })
    toast(t('resellers.limits.toast')); await loadPrincipals()
  }, { okLabel: t('common.save') })
}
function suspendDialog (p) {
  const next = p.status === 'active' ? 'suspended' : 'active'
  const off = next === 'suspended'
  const withAccts = inputEl({ type: 'checkbox' })
  dialog(t(off ? 'resellers.suspend.title' : 'resellers.resume.title', { name: p.name }), [
    el('label', { className: 'radio-row' }, [withAccts, t(off ? 'resellers.suspend.alsoDisable' : 'resellers.suspend.alsoEnable')])
  ], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/status`, { status: next, mode: withAccts.checked ? 'with-accounts' : 'panel-only' })
    toast(t(off ? 'resellers.suspend.toast' : 'resellers.resume.toast', { name: p.name })); await loadPrincipals()
  }, { okLabel: t(off ? 'common.suspend' : 'common.resume'), danger: off })
}
function principalPasswordDialog (p) {
  const pw = inputEl({ type: 'password', minLength: 8 })
  dialog(t('resellers.password.title', { name: p.name }), [field(t('common.newPassword'), pw)], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/password`, { password: pw.value })
    toast(t('resellers.password.toast'))
  }, { okLabel: t('common.change') })
}
function deletePrincipalDialog (p) {
  dialog(t('resellers.delete.title', { name: p.name }), [
    el('p', { className: 'dlg-note', textContent: t('resellers.delete.note') })
  ], async () => {
    await api('DELETE', `/principals/${encodeURIComponent(p.name)}`)
    toast(t('resellers.delete.toast', { name: p.name })); await Promise.all([loadPrincipals(), refreshBalance()])
  }, { okLabel: t('common.delete'), danger: true })
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
    el('td', { textContent: fmtDateTime(tx.ts) }),
    el('td', {}, el('span', { className: 'badge dim', textContent: ledgerTypeText(tx.type), title: tx.type })),
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
  toast(t('ledger.toast.minted')); $('#mint-form').reset(); await Promise.all([loadLedger(true), refreshBalance()])
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
    [t('system.tile.panelLink'),
      p ? (p.reachable === false ? t('system.down') : p.latencyMs != null ? `${p.latencyMs} ms` : '—') : t('system.na'),
      p && p.reachable === false ? t('system.unreachable') : t('system.roundTrip'),
      p ? (p.reachable === false ? 'err' : p.latencyMs != null ? 'ok' : '') : ''],
    [t('system.tile.hostMemory'), fmtBytes(memUsed), t('system.of', { total: fmtBytes(h.totalMemBytes) }),
      memUsed / h.totalMemBytes > 0.9 ? 'warn' : ''],
    [t('system.tile.load1m'), hasLoad ? h.loadavg[0].toFixed(2) : '—', t('system.cores', { n: h.cpuCount }),
      hasLoad && h.loadavg[0] > h.cpuCount ? 'warn' : ''],
    [t('system.tile.diskFree'), disk ? fmtBytes(disk.freeBytes) : '—', disk ? t('system.of', { total: fmtBytes(disk.totalBytes) }) : t('system.unavailable'),
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
        [t('system.state'), statusEl(p.reachable === false ? 'err' : p.reachable ? 'ok' : '', p.reachable === false ? t('system.unreachable') : p.reachable ? t('system.reachable') : t('system.unknown'))],
        ['URL', p.url, { mono: true }],
        [t('system.latency'), p.latencyMs != null ? `${p.latencyMs} ms` : '—'],
        [t('system.lastOk'), fmtAgo(p.lastOkAt)],
        [t('system.lastError'), p.lastError || p.error || '—', { title: p.lastError || p.error || '' }],
        ...(p.stats
          ? [
              [t('system.viewerUsers'), p.stats.users],
              [t('system.streams'), t('system.streamsValue', { total: p.stats.streams, live: p.stats.live })],
              [t('system.panelAdmins'), p.stats.admins],
              [t('system.panelKey'), `${String(p.stats.panelKey).slice(0, 16)}…`, { mono: true, title: p.stats.panelKey }]
            ]
          : [])
      ]
    : [[t('system.state'), t('system.noPanel')]]
  $('#sys-panel').replaceChildren(...kvRows(panelRows))

  const sv = s.service
  $('#sys-service').replaceChildren(...kvRows([
    ['Node', sv.node],
    ['PID', sv.pid],
    [t('system.uptime'), fmtDur(sv.uptimeSec)],
    [t('system.memRss'), fmtBytes(sv.rssBytes)],
    [t('system.heapUsed'), fmtBytes(sv.heapUsedBytes)],
    [t('system.dataDir'), sv.dataDir, { mono: true }],
    ...(sv.ledger ? [[t('system.ledger'), statusEl(sv.ledger.invariantOk ? 'ok' : 'err', t('system.ledgerValue', { seq: sv.ledger.seq, state: t(sv.ledger.invariantOk ? 'system.consistent' : 'system.invariantBroken') }))]] : []),
    ...(sv.sweeps ? [[t('system.lastSweep'), fmtAgo(sv.sweeps.lastRunAt)]] : []),
    ...(sv.webhook ? [[t('system.webhook'), t(sv.webhook.enabled ? 'system.enabled' : 'system.disabled')]] : [])
  ]))

  $('#sys-host').replaceChildren(...kvRows([
    [t('system.hostname'), h.hostname],
    ['OS', `${h.platform} ${h.release} (${h.arch})`],
    ['CPU', `${h.cpuModel} × ${h.cpuCount}`],
    [t('system.loadAvg'), hasLoad ? h.loadavg.map((x) => x.toFixed(2)).join(' / ') : '—'],
    [t('system.memory'), `${fmtBytes(memUsed)} / ${fmtBytes(h.totalMemBytes)}`],
    [t('system.disk'), disk ? `${fmtBytes(disk.totalBytes - disk.freeBytes)} / ${fmtBytes(disk.totalBytes)}` : '—'],
    [t('system.uptime'), fmtDur(h.uptimeSec)]
  ]))

  $('#sys-updated').textContent = t('system.updated', { time: new Date(s.now).toLocaleTimeString(i18n.locale) })
}

// ---- settings ----
$('#pw-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  await api('POST', '/me/password', { password: $('#pw-new').value })
  toast(t('settings.toast.passwordChanged'))
  setTimeout(logout, 900)
})
$('#op-sweep').onclick = guard(async () => { const r = await api('POST', '/ops/sweep'); toast(t('settings.toast.sweep', { disabled: r.disabled, errors: r.errors.length })) })
$('#op-reconcile').onclick = guard(async () => {
  const r = await api('POST', '/ops/reconcile')
  dialog(t('settings.reconcileReport'), [el('pre', { className: 'report-box', textContent: JSON.stringify(r, null, 2) })], () => {}, { okLabel: t('common.close') })
})

async function refreshBalance () {
  me = await api('GET', '/me')
  $('#bal').textContent = me.balance
}

// ---- start ----
if (token) boot().catch(() => showLogin())
else showLogin()

// ---- backup & restore (admin tier only) ----
//
// The reseller is EXPORT-ONLY, and that is a decision rather than a gap. Its two sections
// are a credential file whose tokenVersion must never move backwards, and an account map
// whose balances live in the credit ledger that no config artifact carries. See
// reseller/src/config-snapshot.js. So this card offers a snapshot, a template and the
// archive listing — and says plainly that a rebuild is a volume restore.
//
// The routes are gated server-side on the config:snapshot capability (admin + co-admin);
// hiding the card is presentation, not the control.

const bkEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// fmtBytes is the one this dashboard already defines — same job, so it is reused.

function bkAge (h) {
  if (h == null) return '—'
  if (h < 1) return t('backup.minutes', { n: Math.round(h * 60) })
  if (h < 48) return t('backup.hours', { n: h.toFixed(1) })
  return t('backup.days', { n: Math.round(h / 24) })
}

function bkCmd (label, cmd, danger) {
  if (!cmd) return ''
  return '<div class="cmd-block"><label>' + bkEsc(label) + '</label><div class="cmd-row' +
    (danger ? ' force' : '') + '"><code>' + bkEsc(cmd) + '</code>' +
    '<button class="btn small" data-copy="' + bkEsc(cmd) + '">' + bkEsc(t('common.copy')) + '</button></div></div>'
}

async function loadBackup () {
  const [caps, snaps, arch] = await Promise.all([
    api('GET', '/config'), api('GET', '/config/snapshots'), api('GET', '/backups')
  ])
  $('#bk-snap-dir').textContent = t('backup.snapDir', { dir: caps.snapshotDir })

  const tb = $('#bk-snap-table tbody')
  tb.innerHTML = snaps.snapshots.length
    ? snaps.snapshots.map((s) => {
      // A damaged snapshot is shown, never hidden: an operator must not believe they hold
      // a reference copy that cannot be read.
      if (s.unreadable) {
        return '<tr><td class="mono">' + bkEsc(s.id) + '</td><td colspan="3">' + bkEsc(t('backup.damaged', { reason: s.unreadable })) + '</td>' +
          '<td><button class="btn small danger" data-bkdel="' + bkEsc(s.id) + '">' + bkEsc(t('common.delete')) + '</button></td></tr>'
      }
      const m = s.meta || {}
      return '<tr><td>' + bkEsc(fmtDateTime(s.createdAt)) + '<div class="muted mono">' + bkEsc(s.id) + '</div></td>' +
        '<td>' + bkEsc(s.note || '—') + '</td>' +
        '<td class="muted">' + bkEsc(t('backup.contents', { principals: m.principals || 0, accounts: m.accounts || 0 })) + '</td>' +
        '<td class="muted">' + fmtBytes(s.bytes) + '</td>' +
        '<td><button class="btn small danger" data-bkdel="' + bkEsc(s.id) + '">' + bkEsc(t('common.delete')) + '</button></td></tr>'
    }).join('')
    : '<tr><td colspan="5" class="muted">' + bkEsc(t('backup.noSnapshot')) + '</td></tr>'

  const ab = $('#bk-arch-table tbody')
  // arch.why and c.assumes are composed by the SERVER (@aliran/core/config-routes.js,
  // shared by four services) and stay in English — translating them belongs with core.
  $('#bk-arch-note').textContent = arch.available
    ? t('backup.archFound', { dir: arch.dir })
    : t('backup.archUnavailable', { reason: arch.reason })
  $('#bk-arch-why').textContent = arch.why || ''
  ab.innerHTML = (arch.available && arch.archives.length)
    ? arch.archives.map((a) =>
      '<tr><td class="mono">' + bkEsc(a.name) + (a.legacyName ? ' <span class="muted">' + bkEsc(t('backup.oldNameFormat')) + '</span>' : '') + '</td>' +
      '<td>' + bkEsc(bkAge(a.ageHours)) + '</td><td class="muted">' + fmtBytes(a.bytes) + '</td>' +
      '<td>' + (a.newest ? '<span class="freshness newest">' + bkEsc(t('backup.newest')) + '</span> ' : '') +
      '<span class="freshness ' + bkEsc(a.freshness) + '">' + bkEsc(tOr('backup.freshness.' + a.freshness, a.freshness)) + '</span></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">' + bkEsc(t(arch.available ? 'backup.noArchive' : 'backup.nothingToShow')) + '</td></tr>'

  const c = arch.commands || {}
  $('#bk-arch-cmds').innerHTML =
    (c.assumes ? '<p class="hint muted">' + bkEsc(c.assumes) + '</p>' : '') +
    bkCmd(t('backup.cmd.backup'), c.backup) +
    bkCmd(t('backup.cmd.cron'), c.cron) +
    bkCmd(t('backup.cmd.restore'), c.restore) +
    bkCmd(t('backup.cmd.restoreForce'), c.restoreForce, true)

  $$('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('backup.toast.copied')) } catch { toast(t('backup.toast.copyFailed'), true) }
    }
  })
  $$('[data-bkdel]').forEach((b) => { b.onclick = () => bkDelete(b.dataset.bkdel) })
}

function bkDelete (id) {
  dialog(t('backup.delete.title'), [
    el('p', { className: 'mono', textContent: id }),
    el('p', { className: 'hint muted', textContent: t('backup.delete.note') })
  ], async () => {
    await api('DELETE', '/config/snapshots/' + encodeURIComponent(id))
    toast(t('backup.delete.toast'))
    await loadBackup()
  }, { okLabel: t('common.delete'), danger: true })
}

$('#bk-snap-take').onclick = () => {
  const note = inputEl({ placeholder: t('backup.take.placeholder'), maxLength: 200 })
  dialog(t('backup.take.title'), [field(t('backup.take.field'), note)], async () => {
    const r = await api('POST', '/config/snapshots', { note: note.value })
    toast(t('backup.take.toast', { id: r.id, size: fmtBytes(r.bytes) }))
    await loadBackup()
  }, { okLabel: t('backup.take.ok') })
}

$('#bk-tpl-download').onclick = guard(async () => {
  const tpl = await api('GET', '/config/template')
  // Belt and braces on the client too: never write a file that says it holds secrets.
  if (tpl.contains !== 'no-secrets') { toast(t('backup.tpl.refused'), true); return }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' }))
  a.download = 'reseller-template-' + stamp + '.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  toast(t('backup.tpl.toast'))
})
