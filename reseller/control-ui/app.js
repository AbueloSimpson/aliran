/* Aliran reseller panel UI — no framework, no build. Talks only to this service's
   /api (which fronts the panel admin API server-side); the token lives in
   sessionStorage and any 401 drops back to the login view. Sections are shown/
   hidden by the signed-in principal's role. */

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of [].concat(kids)) if (k != null) n.append(k)
  return n
}
const fmtDays = (d) => d == null ? '—' : d < 0 ? `${-d}d ago` : d === 0 ? 'today' : `${d}d`
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
  $('#who').innerHTML = `<b>${me.name}</b> · ${me.role}`
  $('#bal').innerHTML = `balance <b>${me.balance}</b>`
  $$('.nav-item[data-cap="manage"]').forEach((n) => { n.hidden = !CAN_MANAGE.has(me.role) })
  $('#mint-panel').hidden = !IS_ADMIN(me.role)
  $('#ops-card').hidden = !IS_ADMIN(me.role)
  $('#acct-hint').textContent = me.prefix
    ? `Accounts are created as ${globalName('')}<name>.`
    : 'Accounts are created directly under the global prefix.'
  setupPrincipalForm()
  showView('overview')
}

// global.<prefix>. preview needs the global prefix — /api/me doesn't carry it, so
// derive it lazily from the first account we see, else fall back to a placeholder.
let GLOBAL_PREFIX = null
function globalName (name) {
  const g = GLOBAL_PREFIX || 'rs'
  return me.prefix ? `${g}.${me.prefix}.${name}` : `${g}.${name}`
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
  const chip = $('#panel-chip')
  if (s.panel) {
    const up = s.panel.reachable
    chip.className = 'chip ' + (up === false ? 'err' : up ? 'ok' : '')
    chip.innerHTML = `panel <b>${up === false ? 'unreachable' : up ? 'reachable' : 'unknown'}</b>`
  } else chip.textContent = ''
  const rc = $('#reconcile-card')
  if (s.reconcile) {
    rc.hidden = false
    const r = s.reconcile
    $('#reconcile-summary').textContent =
      `${new Date(r.ts).toLocaleString()} — checked ${r.checked}, orphans ${r.orphanPanel}, missing ${r.missingPanel}, status fixed ${r.statusFixed}, errors ${r.errors}`
  } else rc.hidden = true
}

// ---- accounts ----
let accountRows = []
let acctFilter = 'all'
let acctSort = { k: 'account', dir: 1 }

async function loadAccounts () {
  accountRows = await api('GET', '/accounts?limit=500')
  if (accountRows[0]) {
    // Learn the global prefix from a real account name (…prefix injected server-side).
    const parts = accountRows[0].account.split('.')
    if (parts.length >= 2) GLOBAL_PREFIX = parts[0]
  }
  renderAccounts()
  updatePreview()
}
function renderAccounts () {
  const q = $('#acct-search').value.trim().toLowerCase()
  const now7 = 7
  let rows = accountRows.filter((r) => {
    if (acctFilter === 'active') return r.status === 'active'
    if (acctFilter === 'disabled') return r.status === 'disabled'
    if (acctFilter === 'trial') return r.kind === 'trial'
    if (acctFilter === 'expiring') return r.status === 'active' && r.expiresInDays <= now7
    return true
  })
  if (q) rows = rows.filter((r) => r.account.toLowerCase().includes(q) || r.owner.toLowerCase().includes(q))
  rows.sort((a, b) => (a[acctSort.k] > b[acctSort.k] ? 1 : -1) * acctSort.dir)
  const tb = $('#acct-table tbody')
  tb.replaceChildren(...rows.map(accountRow))
  $('#acct-empty').hidden = rows.length > 0
  $$('#acct-table th[data-col="owner"]').forEach((th) => { th.style.display = IS_ADMIN(me.role) || me.role === 'super' ? '' : 'none' })
}
function accountRow (r) {
  const statusBadge = r.status === 'active'
    ? el('span', { className: 'badge ok', textContent: r.expiresInDays <= 7 ? 'expiring' : 'active' })
    : el('span', { className: 'badge err', textContent: r.status })
  const kindBadge = r.kind === 'trial' ? el('span', { className: 'badge trial', textContent: 'trial' }) : null
  const actions = el('div', { className: 'row-actions' }, [
    btn('Renew', () => renewDialog(r)),
    r.status === 'active'
      ? btn('Suspend', guard(() => accountStatus(r, 'disabled')))
      : (r.expiresInDays > 0 ? btn('Resume', guard(() => accountStatus(r, 'active'))) : null),
    btn('Devices', () => devicesDialog(r)),
    btn('Password', () => passwordDialog(r)),
    btn('Delete', () => deleteAccountDialog(r), 'danger')
  ])
  return el('tr', {}, [
    el('td', {}, el('div', { className: 'cell-name' }, [
      el('span', { className: 't mono', textContent: r.account }),
      el('span', { className: 'muted', style: 'font-size:11px', textContent: r.owner })
    ])),
    tdCol('owner', r.owner),
    el('td', {}, el('span', { className: 'chips' }, [statusBadge, kindBadge].filter(Boolean))),
    el('td', { className: 'num', textContent: fmtDays(r.expiresInDays) }),
    el('td', { className: 'num', textContent: r.maxDevices }),
    el('td', {}, actions)
  ])
}
function tdCol (col, text) {
  const td = el('td', { textContent: text })
  if (col === 'owner' && !(IS_ADMIN(me.role) || me.role === 'super')) td.style.display = 'none'
  return td
}
const btn = (label, onClick, cls = '') => el('button', { className: 'btn small' + (cls ? ' ' + cls : ''), textContent: label, onclick: onClick })

$('#acct-search').oninput = renderAccounts
$('#acct-refresh').onclick = guard(loadAccounts)
$$('#acct-filter button').forEach((b) => { b.onclick = () => { acctFilter = b.dataset.f; $$('#acct-filter button').forEach((x) => x.classList.toggle('active', x === b)); renderAccounts() } })
$$('#acct-table th.sortable').forEach((th) => { th.onclick = () => { const k = th.dataset.k; acctSort = { k, dir: acctSort.k === k ? -acctSort.dir : 1 }; $$('#acct-table th').forEach((x) => x.classList.remove('sorted-asc', 'sorted-desc')); th.classList.add(acctSort.dir === 1 ? 'sorted-asc' : 'sorted-desc'); renderAccounts() } })

function updatePreview () { $('#acct-preview').textContent = globalName($('#acct-name').value || '<name>') }
$('#acct-name').oninput = updatePreview

$('#account-form').onsubmit = guard(async (e) => {
  e.preventDefault()
  const body = {
    name: $('#acct-name').value,
    password: $('#acct-pass').value,
    months: +$('#acct-months').value,
    maxDevices: +$('#acct-devices').value
  }
  const r = await api('POST', '/accounts', body)
  toast(`Activated ${r.account} (${r.expiresInDays}d)`)
  $('#account-form').reset(); updatePreview()
  await Promise.all([loadAccounts(), refreshBalance()])
})
$('#acct-trial-btn').onclick = guard(async () => {
  const name = $('#acct-name').value
  if (!name) return toast('Enter a name first', true)
  const r = await api('POST', '/trials', { name, password: $('#acct-pass').value || 'trial-' + Math.random().toString(36).slice(2, 10), maxDevices: +$('#acct-devices').value })
  toast(`Trial ${r.account} started`)
  $('#account-form').reset(); updatePreview()
  await loadAccounts()
})

function renewDialog (r) {
  const months = inputEl({ type: 'number', min: '1', max: '120', value: '1' })
  dialog(`Renew ${r.account}`, [
    field('Months (1 credit each)', months),
    el('p', { className: 'dlg-note', textContent: r.kind === 'trial' ? 'This converts the trial to a paid account.' : '' })
  ], async () => {
    const out = await api('POST', `/accounts/${encodeURIComponent(r.account)}/renew`, { months: +months.value })
    toast(`Renewed to ${out.expiresInDays}d`)
    await Promise.all([loadAccounts(), refreshBalance()])
  }, { okLabel: 'Renew' })
}
async function accountStatus (r, status) {
  await api('POST', `/accounts/${encodeURIComponent(r.account)}/status`, { status })
  toast(`${r.account} ${status === 'disabled' ? 'suspended' : 'resumed'}`)
  await loadAccounts()
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
    ? list.map((d) => el('div', { className: 'chips' }, [
        el('span', { className: 'chip', innerHTML: `<b>${d.label || d.deviceId.slice(0, 8)}</b>${d.expired ? ' (expired)' : ''}` }),
        btn('Revoke', guard(async () => { await api('DELETE', `/accounts/${encodeURIComponent(r.account)}/devices/${encodeURIComponent(d.deviceId)}`); toast('Device revoked'); }), 'danger')
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
    await Promise.all([loadAccounts(), refreshBalance()])
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
  const syncPrefix = () => { const needs = roleSel.value === 'super' || roleSel.value === 'reseller'; $('#p-prefix-label').hidden = !needs; $('#p-prefix').required = needs }
  roleSel.onchange = syncPrefix
  syncPrefix()
}
async function loadPrincipals () {
  const list = await api('GET', '/principals')
  const tb = $('#p-table tbody')
  const q = $('#p-search').value.trim().toLowerCase()
  const rows = list.filter((p) => !q || p.name.toLowerCase().includes(q))
  tb.replaceChildren(...rows.map(principalRow))
}
function principalRow (p) {
  const actions = el('div', { className: 'row-actions' }, [
    CAN_MANAGE.has(me.role) && can('credits:transfer') ? btn('Fund', () => transferDialog(p)) : null,
    can('credits:transfer') ? btn('Reclaim', () => reclaimDialog(p)) : null,
    btn('Limits', () => limitsDialog(p)),
    btn(p.status === 'active' ? 'Suspend' : 'Resume', () => suspendDialog(p)),
    btn('Password', () => principalPasswordDialog(p)),
    btn('Delete', () => deletePrincipalDialog(p), 'danger')
  ].filter(Boolean))
  return el('tr', {}, [
    el('td', {}, el('div', { className: 'cell-name' }, [
      el('span', { className: 't', textContent: p.name }),
      p.prefix ? el('span', { className: 'muted mono', style: 'font-size:11px', textContent: p.prefix }) : null
    ])),
    el('td', {}, el('span', { className: 'badge role', textContent: p.role })),
    el('td', { textContent: p.parent || '—' }),
    el('td', { className: 'num', textContent: p.balance }),
    el('td', { className: 'num', textContent: p.accounts }),
    el('td', {}, el('span', { className: 'badge ' + (p.status === 'active' ? 'ok' : 'err'), textContent: p.status })),
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
  if ($('#p-prefix').required) body.prefix = $('#p-prefix').value
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
  const dev = inputEl({ type: 'number', min: '1', value: p.maxDevicesLimit })
  const trial = inputEl({ type: 'number', min: '0', value: p.trialDailyCap })
  dialog(`Limits — ${p.name}`, [field('Max devices per account', dev), field('Trials per day', trial)], async () => {
    await api('POST', `/principals/${encodeURIComponent(p.name)}/limits`, { maxDevicesLimit: +dev.value, trialDailyCap: +trial.value })
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
    el('td', { className: 'num', textContent: delta > 0 ? '+' + delta : (delta || '') , style: delta > 0 ? 'color:var(--ok)' : delta < 0 ? 'color:var(--danger)' : '' }),
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
  $('#bal').innerHTML = `balance <b>${me.balance}</b>`
}

// ---- start ----
if (token) boot().catch(() => showLogin())
else showLogin()
