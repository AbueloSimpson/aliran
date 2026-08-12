/* Reseller panel UI translations — no framework, no build, no dependency.
 *
 * This is deliberately NOT @aliran/i18n. That package ships TypeScript source for the
 * two VIEWER apps, which consume it through Metro / esbuild; this dashboard has no
 * bundler at all, and control-server.js serves a flat whitelist of .html/.js/.css from
 * one directory (a locales/es.json could not even be fetched). Its 370 keys are player,
 * guide and PIN copy with no overlap with accounts, credits and the ledger. So the
 * catalog lives here, and only the CONVENTIONS are shared: flat dot-namespaced keys,
 * {name} placeholders, English is the source, every other locale mirrors its key set.
 * tools/i18n-test.mjs section 6 is the guard.
 *
 * The choice of language is per BROWSER (localStorage), not per principal. The sign-in
 * screen has to be translated too, and there is no identity to key a preference to
 * before sign-in — a server-side setting would leave the login card stuck in one
 * language. It also means no API route, no store write and no schema change.
 *
 * Adding a locale: append it to LOCALES, copy the `en` block, translate the values.
 * Nothing else in the dashboard needs to change.
 *
 * Static markup is translated by attribute:
 *   data-i18n         textContent — or, when the element wraps a control
 *                     (<label>Name <input></label>), only its first text node
 *   data-i18n-rich    same, but the value may carry **bold** and [[monospace]]
 *   data-i18n-ph      placeholder
 *   data-i18n-title   title
 *   data-i18n-aria    aria-label
 * Everything app.js builds at runtime goes through t() / tOr() / tNodes().
 *
 * NOT translated, on purpose: the brand (white-label — docs/white-label.md owns it),
 * data echoed from the panel or the ledger (account names, notes, channel titles), and
 * text the SERVER composes (API errors, the backup card's `why`/`assumes` lines from
 * @aliran/core/config-routes.js — shared by four services, so translating it there is
 * its own job).
 */
(function () {
  'use strict'

  // Autonyms: a language always names itself in its own language.
  const LOCALES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' }
  ]

  const CATALOG = {}

  // ---- English (the source catalog) ------------------------------------------------
  CATALOG.en = {
    // -- shared --
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.done': 'Done',
    'common.add': 'Add',
    'common.create': 'Create',
    'common.change': 'Change',
    'common.update': 'Update',
    'common.delete': 'Delete',
    'common.revoke': 'Revoke',
    'common.send': 'Send',
    'common.refresh': 'Refresh',
    'common.suspend': 'Suspend',
    'common.resume': 'Resume',
    'common.copy': 'Copy',
    'common.all': 'All',
    'common.none': 'none',
    'common.never': 'never',
    'common.loading': 'Loading…',
    'common.optional': 'optional',
    'common.sort': 'Sort',
    'common.username': 'Username',
    'common.password': 'Password',
    'common.newPassword': 'New password',
    'common.loadMore': 'Load more',
    'common.prev': '‹ Prev',
    'common.next': 'Next ›',
    'common.page': 'Page',
    'common.pageOf': 'of',
    'common.moreActions': 'More actions — {name}',
    'common.menu.changePassword': 'Change password…',
    'common.menu.delete': 'Delete…',
    'common.unavailable': 'Unavailable ({error})',
    'common.toast.passwordChanged': 'Password changed',

    // -- durations / dates --
    'fmt.today': 'today',
    'fmt.days': '{n}d',
    'fmt.daysAgo': '{n}d ago',
    'fmt.ago': '{d} ago',

    // -- record status --
    'status.active': 'active',
    'status.expiring': 'expiring',
    'status.disabled': 'disabled',
    'status.expired': 'expired',
    'status.suspended': 'suspended',
    'status.deleted': 'deleted',

    // -- sign in --
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',

    // -- language switch --
    'lang.title': 'Language',
    'lang.label': 'Language',
    'lang.hint': 'This changes the dashboard text only. Account names, notes and channel titles come from your panel.',

    // -- navigation / sidebar --
    'nav.overview': 'Overview',
    'nav.accounts': 'Accounts',
    'nav.resellers': 'Resellers',
    'nav.ledger': 'Ledger',
    'nav.settings': 'Settings',
    'side.credits': 'Credits',
    'side.signOut': 'Sign out',
    'side.toggleNav': 'Toggle navigation',

    // -- overview --
    'overview.system': 'System',
    'overview.lastReconcile': 'Last reconcile',
    'overview.tile.balance': 'Balance',
    'overview.tile.activeAccounts': 'Active accounts',
    'overview.tile.expiring7d': 'Expiring ≤ 7d',
    'overview.tile.trialsActive': 'Trials active',
    'overview.tile.disabled': 'Disabled',
    'overview.tile.principals': 'Principals',
    'overview.tile.outstanding': 'Outstanding credits',
    'overview.panelReachable': 'panel reachable',
    'overview.panelUnreachable': 'panel unreachable',
    'overview.panelUnknown': 'panel state unknown',
    'overview.reconcileLine': ' · last reconcile: {findings} finding(s), {errors} error(s)',
    'overview.resellerBanner': '{active} active account(s) · {expiring} expiring ≤ 7d · balance {balance}',
    'overview.reconcileSummary': '{when} — checked {checked}, orphans {orphans}, missing {missing}, status fixed {status}, packages fixed {packages}, errors {errors}',

    // -- accounts: the add panel --
    'accounts.add': 'Add account',
    'accounts.name': 'Name',
    'accounts.months': 'Months',
    'accounts.maxDevices': 'Max devices',
    'accounts.packages': 'Packages',
    'accounts.packagesNote': 'What the account gets — months set for how long. Packages don\'t change the price.',
    'accounts.extraChannels': 'Extra channels (one-offs)',
    'accounts.filterChannels': 'Filter channels…',
    'accounts.activate': 'Activate',
    'accounts.startTrial': 'Start trial',
    'accounts.devicesNote': 'devices per account: {n} (set by your admin)',
    'accounts.noPackages': 'No packages on the panel yet.',
    'accounts.noChannels': 'No channels on the panel yet.',
    'accounts.pkgSub': '{name} · {count} ch',
    'accounts.pkgSubDefault': '{name} · {count} ch · default',

    // -- accounts: the table --
    'accounts.search': 'Search name or owner…',
    'accounts.filter.active': 'Active',
    'accounts.filter.expiring': 'Expiring',
    'accounts.filter.disabled': 'Disabled',
    'accounts.filter.trial': 'Trials',
    'accounts.clearOwnerFilter': 'Clear owner filter',
    'accounts.ownerChip': 'owner **{owner}** ✕',
    'accounts.sort.nameAsc': 'Name A→Z',
    'accounts.sort.nameDesc': 'Name Z→A',
    'accounts.sort.expiresAsc': 'Expiring soonest',
    'accounts.sort.expiresDesc': 'Expiring latest',
    'accounts.sort.createdDesc': 'Newest created',
    'accounts.sort.createdAsc': 'Oldest created',
    'accounts.sort.statusAsc': 'Active first',
    'accounts.sort.statusDesc': 'Inactive first',
    'accounts.col.account': 'Account',
    'accounts.col.owner': 'Owner',
    'accounts.col.status': 'Status',
    'accounts.col.expires': 'Expires',
    'accounts.col.created': 'Created',
    'accounts.col.devices': 'Devices',
    'accounts.mobile.expires': 'expires',
    'accounts.mobile.devices': 'devices',
    'accounts.empty': 'No accounts yet.',
    'accounts.noMatches': 'No matches.',
    'accounts.countRange': '{from}–{to} of {total}',
    'accounts.showOnlyOwner': 'Show only {owner}\'s accounts',
    'accounts.trialBadge': 'trial',

    // -- accounts: row actions --
    'accounts.renew': 'Renew',
    'accounts.menu.suspend': 'Suspend',
    'accounts.menu.resume': 'Resume',
    'accounts.menu.channels': 'Channels & packages…',
    'accounts.menu.packages': 'Manage packages…',
    'accounts.menu.devices': 'Devices…',
    'accounts.menu.logoutAll': 'Log out all devices',
    'accounts.toast.logoutAll': '{account}: every session token revoked',
    'accounts.toast.activated': 'Activated {account} ({days}d)',
    'accounts.toast.activatedWithPackages': 'Activated {account} ({days}d · {packages})',
    'accounts.toast.nameFirst': 'Enter a name first',
    'accounts.toast.trialStarted': 'Trial {account} started',
    'accounts.toast.suspended': '{account} suspended',
    'accounts.toast.resumed': '{account} resumed',

    // -- accounts: renew / password --
    'accounts.renewTitle': 'Renew {account}',
    'accounts.monthsField': 'Months (1 credit each)',
    'accounts.trialConvertNote': 'This converts the trial to a paid account.',
    'accounts.toast.renewed': 'Renewed to {days}d',
    'accounts.passwordTitle': 'Password for {account}',

    // -- accounts: devices --
    'accounts.devices.title': 'Devices — {account}',
    'accounts.devices.slots': '{active} of {max} device slot(s) in use — devices enroll themselves when the viewer signs in; a new device past the cap evicts the oldest.',
    'accounts.devices.none': 'No devices enrolled — nobody has signed in to this account yet.',
    'accounts.devices.unnamed': 'unnamed device',
    'accounts.devices.subExpired': 'enrolled {enrolled} · session expired {expires} — not signed in since',
    'accounts.devices.subLive': 'enrolled {enrolled} · session live until {expires} (renews at sign-in)',
    'accounts.devices.toastRevoked': 'Device revoked — the slot is free; the app signs out on its next check',
    'accounts.devices.note': 'Revoke is cooperative — it frees the slot and a well-behaved app drops to login. To cut access hard, use Log out all devices (kills every session token) or suspend the account.',

    // -- accounts: channels & packages --
    'accounts.chan.title': 'Channels — {account}',
    'accounts.chan.panelDown': 'Panel unreachable — live channel state unavailable. Showing the local registry only.',
    'accounts.chan.localOnly': 'Assigned packages: {packages} · one-offs: {oneOffs}',
    'accounts.chan.packages': 'Packages',
    'accounts.chan.manage': 'Manage…',
    'accounts.chan.noPackages': 'No packages assigned.',
    'accounts.chan.channels': 'Channels ({count})',
    'accounts.chan.pkgTitle': 'package {name}',
    'accounts.chan.oneOff': 'one-off',
    'accounts.chan.auto': 'auto',
    'accounts.chan.addTitle': 'Add extra channel (one-off)',
    'accounts.chan.bouquet': '(bouquet)',
    'accounts.chan.toastStillGranted': 'Removed the one-off — still granted via package {packages}',
    'accounts.chan.toastRevoked': '{channel} revoked',
    'accounts.chan.toastGranted': '{channel} granted',
    'accounts.pkg.title': 'Packages — {account}',
    'accounts.pkg.none': 'No packages defined on the panel yet — the operator creates them in the panel dashboard.',
    'accounts.pkg.note': 'Sets WHAT the account gets — the subscription clock (credits) is unchanged. One-off channels stay as they are.',
    'accounts.pkg.toastSet': 'Packages set: {packages}',

    // -- accounts: delete --
    'accounts.delete.title': 'Delete {account}',
    'accounts.delete.adminNote': 'Admin deletes refund nothing.',
    'accounts.delete.refundNote': 'Refund on delete: ~{n} credit(s).',
    'accounts.delete.confirmField': 'Type the account name to confirm',
    'accounts.delete.mismatch': 'Name does not match',
    'accounts.delete.toast': 'Deleted (refunded {n})',

    // -- resellers --
    'resellers.create': 'Create reseller',
    'resellers.role': 'Role',
    'resellers.filter': 'Filter principals…',
    'resellers.col.name': 'Name',
    'resellers.col.role': 'Role',
    'resellers.col.parent': 'Parent',
    'resellers.col.balance': 'Balance',
    'resellers.col.accounts': 'Accounts',
    'resellers.col.status': 'Status',
    'resellers.fund': 'Fund',
    'resellers.menu.reclaim': 'Reclaim credits…',
    'resellers.menu.limits': 'Limits…',
    'resellers.menu.suspend': 'Suspend…',
    'resellers.menu.resume': 'Resume…',
    'resellers.toast.created': 'Created {name}',
    'resellers.fund.title': 'Fund {name}',
    'resellers.fund.field': 'Credits (you have {balance})',
    'resellers.fund.toast': 'Sent {amount} to {name}',
    'resellers.reclaim.title': 'Reclaim from {name}',
    'resellers.reclaim.field': 'Credits (they hold {balance})',
    'resellers.reclaim.ok': 'Reclaim',
    'resellers.reclaim.toast': 'Reclaimed {amount}',
    'resellers.limits.title': 'Limits — {name}',
    'resellers.limits.readOnly': 'Devices per account: {n} — set by the admin.',
    'resellers.limits.readOnlyInherited': 'Devices per account: {n} (inherited) — set by the admin.',
    'resellers.limits.devicesField': 'Devices per account — blank = inherit',
    'resellers.limits.devicesFieldFrom': 'Devices per account — blank = inherit from {parent}',
    'resellers.limits.inheritPlaceholder': 'inherit ({n})',
    'resellers.limits.note': 'Inherited by every principal under this one; their new accounts receive this device count.',
    'resellers.limits.trialsPerDay': 'Trials per day',
    'resellers.limits.toast': 'Limits updated',
    'resellers.suspend.title': 'Suspend {name}',
    'resellers.resume.title': 'Resume {name}',
    'resellers.suspend.alsoDisable': 'Also disable their viewer accounts on the panel',
    'resellers.suspend.alsoEnable': 'Also enable their viewer accounts on the panel',
    'resellers.suspend.toast': '{name} suspended',
    'resellers.resume.toast': '{name} active',
    'resellers.password.title': 'Password for {name}',
    'resellers.password.toast': 'Password changed (their sessions revoked)',
    'resellers.delete.title': 'Delete {name}',
    'resellers.delete.note': 'Blocked while they have child principals or accounts. Any remaining balance is reclaimed to you.',
    'resellers.delete.toast': 'Deleted {name}',

    // -- ledger --
    'ledger.mintPanel': 'Mint / adjust credits',
    'ledger.to': 'To',
    'ledger.toPlaceholder': 'principal (default: you)',
    'ledger.amount': 'Amount',
    'ledger.note': 'Note',
    'ledger.mint': 'Mint',
    'ledger.transactions': 'Transactions',
    'ledger.type.MINT': 'Mint',
    'ledger.type.TRANSFER': 'Transfer',
    'ledger.type.ACTIVATE': 'Activate',
    'ledger.type.RENEW': 'Renew',
    'ledger.type.REFUND': 'Refund',
    'ledger.type.TRIAL': 'Trial',
    'ledger.type.RECLAIM': 'Reclaim',
    'ledger.type.ADJUST': 'Adjust',
    'ledger.col.when': 'When',
    'ledger.col.type': 'Type',
    'ledger.col.counterparty': 'Counterparty',
    'ledger.col.account': 'Account',
    'ledger.col.note': 'Note',
    'ledger.toast.minted': 'Minted',

    // -- settings --
    'settings.changePassword': 'Change your password',
    'settings.operations': 'Operations',
    'settings.runSweep': 'Run expiry sweep now',
    'settings.runReconcile': 'Run reconcile now',
    'settings.opsHint': 'The expiry sweep disables lapsed accounts on the panel. Reconcile diffs the panel against local records (repairs apply only when [[RECONCILE_REPAIR=1]]).',
    'settings.toast.passwordChanged': 'Password changed — sign in again',
    'settings.toast.sweep': 'Sweep: {disabled} disabled, {errors} errors',
    'settings.reconcileReport': 'Reconcile report',

    // -- system diagnostics --
    'system.panelConnection': 'Panel connection',
    'system.serviceProcess': 'Service process',
    'system.hostMachine': 'Host machine',
    'system.refreshNote': '· refreshes every 5 s while open',
    'system.refreshNow': 'Refresh now',
    'system.updated': 'updated {time}',
    'system.tile.panelLink': 'Panel link',
    'system.tile.hostMemory': 'Host memory',
    'system.tile.load1m': 'Load (1m)',
    'system.tile.diskFree': 'Disk free',
    'system.roundTrip': 'round-trip',
    'system.of': 'of {total}',
    'system.cores': '{n} core(s)',
    'system.down': 'down',
    'system.na': 'n/a',
    'system.reachable': 'reachable',
    'system.unreachable': 'unreachable',
    'system.unknown': 'unknown',
    'system.unavailable': 'unavailable',
    'system.state': 'State',
    'system.latency': 'Latency',
    'system.lastOk': 'Last OK',
    'system.lastError': 'Last error',
    'system.viewerUsers': 'Viewer users',
    'system.streams': 'Streams',
    'system.streamsValue': '{total} ({live} live)',
    'system.panelAdmins': 'Panel admins',
    'system.panelKey': 'Panel key',
    'system.noPanel': 'no panel configured',
    'system.uptime': 'Uptime',
    'system.memRss': 'Memory (RSS)',
    'system.heapUsed': 'Heap used',
    'system.dataDir': 'Data dir',
    'system.ledger': 'Ledger',
    'system.ledgerValue': 'seq {seq} · {state}',
    'system.consistent': 'consistent',
    'system.invariantBroken': 'INVARIANT BROKEN',
    'system.lastSweep': 'Last sweep',
    'system.webhook': 'Top-up webhook',
    'system.enabled': 'enabled',
    'system.disabled': 'disabled',
    'system.hostname': 'Hostname',
    'system.loadAvg': 'Load avg',
    'system.memory': 'Memory',
    'system.disk': 'Disk',

    // -- backup & restore --
    'backup.title': 'Backup & restore',
    'backup.warnLine': '**You put a reseller back with a volume restore, not a config restore.** The credit ledger is the record of record, and no config file holds it. This card gives you a snapshot for reference and a template for a second site. It cannot write either one back.',
    'backup.whyHint': 'Two reasons, and they are different. A principal record carries the session counter that a password change increases. To write an old copy back would give revoked sessions their access again. And an account balance comes from the ledger, so an account map that moves back in time disagrees with the ledger that funds it.',
    'backup.snapshotsHead': 'Config snapshots',
    'backup.snapshotsHeadSub': '(principals and accounts, on the box)',
    'backup.takeSnapshot': 'Take a snapshot now',
    'backup.downloadTemplate': 'Download the template',
    'backup.snapDir': 'Snapshots are stored in {dir} on the box.',
    'backup.snapCol.taken': 'Taken',
    'backup.snapCol.note': 'Note',
    'backup.snapCol.contents': 'Contents',
    'backup.snapCol.size': 'Size',
    'backup.templateHint': 'The template holds the shape of the hierarchy: each name, role and parent. It holds no password material, and no customer accounts. Use it to build the same structure on a second site with [[reseller-cli]].',
    'backup.archivesHead': 'Recovery archives',
    'backup.archivesHeadSub': '(the whole data volume)',
    'backup.archCol.archive': 'Archive',
    'backup.archCol.age': 'Age',
    'backup.archCol.size': 'Size',
    'backup.archCol.state': 'State',
    'backup.restoreHint': '**Always restore the newest archive you have.** The restore command refuses to write over a volume that holds data. It also refuses an archive whose name does not match the service. Do not add [[--force]] to get past these two refusals unless you know what the volume holds. No archive holds a [[.env]] file — those live on the host, outside the volumes.',
    'backup.damaged': 'damaged — {reason}',
    'backup.contents': '{principals} principals · {accounts} accounts',
    'backup.noSnapshot': 'No snapshot yet.',
    'backup.archFound': 'Found in {dir} on the box.',
    'backup.archUnavailable': 'The reseller cannot see the archive directory: {reason}. Your archives can still exist. This dashboard cannot read them.',
    'backup.oldNameFormat': '(old name format)',
    'backup.newest': 'newest — restore this one',
    // The three age bands core/backup-index.js can report.
    'backup.freshness.fresh': 'fresh',
    'backup.freshness.aging': 'aging',
    'backup.freshness.stale': 'stale',
    'backup.noArchive': 'No archive found. Run the backup command below.',
    'backup.nothingToShow': 'Nothing to show.',
    'backup.minutes': '{n} min',
    'backup.hours': '{n} h',
    'backup.days': '{n} days',
    'backup.cmd.backup': 'Make an archive now (on the box)',
    'backup.cmd.cron': 'Make one every hour (crontab -e)',
    'backup.cmd.restore': 'Restore the newest archive',
    'backup.cmd.restoreForce': 'Only if the volume already holds data — this DELETES the contents first',
    'backup.toast.copied': 'command copied',
    'backup.toast.copyFailed': 'copy failed — select the text instead',
    'backup.delete.title': 'Delete this snapshot?',
    'backup.delete.note': 'You cannot undo this. It is the only copy of the config at that moment.',
    'backup.delete.toast': 'snapshot deleted',
    'backup.take.title': 'Take a snapshot',
    'backup.take.field': 'Note (optional)',
    'backup.take.placeholder': 'why you took this one',
    'backup.take.ok': 'Take snapshot',
    'backup.take.toast': 'snapshot {id} taken ({size})',
    'backup.tpl.refused': 'refused: this file is not a secret-free template',
    'backup.tpl.toast': 'template downloaded — it holds no password material'
  }

  // ---- Spanish -----------------------------------------------------------------------
  // Register matches i18n/locales/es.json: informal "tú", short sentences, a colon where
  // English uses a dash. "Cuenta" is a viewer account; a principal is a "usuario del
  // panel" — the two must never read the same.
  CATALOG.es = {
    // -- shared --
    'common.ok': 'Aceptar',
    'common.cancel': 'Cancelar',
    'common.close': 'Cerrar',
    'common.save': 'Guardar',
    'common.done': 'Listo',
    'common.add': 'Añadir',
    'common.create': 'Crear',
    'common.change': 'Cambiar',
    'common.update': 'Actualizar',
    'common.delete': 'Eliminar',
    'common.revoke': 'Revocar',
    'common.send': 'Enviar',
    'common.refresh': 'Actualizar',
    'common.suspend': 'Suspender',
    'common.resume': 'Reanudar',
    'common.copy': 'Copiar',
    'common.all': 'Todas',
    'common.none': 'ninguno',
    'common.never': 'nunca',
    'common.loading': 'Cargando…',
    'common.optional': 'opcional',
    'common.sort': 'Ordenar',
    'common.username': 'Usuario',
    'common.password': 'Contraseña',
    'common.newPassword': 'Contraseña nueva',
    'common.loadMore': 'Cargar más',
    'common.prev': '‹ Anterior',
    'common.next': 'Siguiente ›',
    'common.page': 'Página',
    'common.pageOf': 'de',
    'common.moreActions': 'Más acciones: {name}',
    'common.menu.changePassword': 'Cambiar la contraseña…',
    'common.menu.delete': 'Eliminar…',
    'common.unavailable': 'No disponible ({error})',
    'common.toast.passwordChanged': 'Contraseña cambiada',

    // -- durations / dates --
    'fmt.today': 'hoy',
    'fmt.days': '{n} d',
    'fmt.daysAgo': 'hace {n} d',
    'fmt.ago': 'hace {d}',

    // -- record status --
    'status.active': 'activa',
    'status.expiring': 'por vencer',
    'status.disabled': 'desactivada',
    'status.expired': 'vencida',
    'status.suspended': 'suspendida',
    'status.deleted': 'eliminada',

    // -- sign in --
    'login.username': 'Usuario',
    'login.password': 'Contraseña',
    'login.submit': 'Iniciar sesión',

    // -- language switch --
    'lang.title': 'Idioma',
    'lang.label': 'Idioma',
    'lang.hint': 'Esto cambia solo el texto del panel. Los nombres de cuentas, las notas y los títulos de canales vienen de tu panel.',

    // -- navigation / sidebar --
    'nav.overview': 'Resumen',
    'nav.accounts': 'Cuentas',
    'nav.resellers': 'Revendedores',
    'nav.ledger': 'Movimientos',
    'nav.settings': 'Ajustes',
    'side.credits': 'Créditos',
    'side.signOut': 'Cerrar sesión',
    'side.toggleNav': 'Mostrar u ocultar el menú',

    // -- overview --
    'overview.system': 'Sistema',
    'overview.lastReconcile': 'Última conciliación',
    'overview.tile.balance': 'Saldo',
    'overview.tile.activeAccounts': 'Cuentas activas',
    'overview.tile.expiring7d': 'Vencen en ≤ 7 d',
    'overview.tile.trialsActive': 'Pruebas activas',
    'overview.tile.disabled': 'Desactivadas',
    'overview.tile.principals': 'Usuarios del panel',
    'overview.tile.outstanding': 'Créditos en circulación',
    'overview.panelReachable': 'panel accesible',
    'overview.panelUnreachable': 'panel inaccesible',
    'overview.panelUnknown': 'estado del panel desconocido',
    'overview.reconcileLine': ' · última conciliación: {findings} hallazgo(s), {errors} error(es)',
    'overview.resellerBanner': '{active} cuenta(s) activa(s) · {expiring} vencen en ≤ 7 d · saldo {balance}',
    'overview.reconcileSummary': '{when} — revisadas {checked}, huérfanas {orphans}, ausentes {missing}, estado corregido {status}, paquetes corregidos {packages}, errores {errors}',

    // -- accounts: the add panel --
    'accounts.add': 'Añadir una cuenta',
    'accounts.name': 'Nombre',
    'accounts.months': 'Meses',
    'accounts.maxDevices': 'Dispositivos máx.',
    'accounts.packages': 'Paquetes',
    'accounts.packagesNote': 'Lo que recibe la cuenta. Los meses fijan por cuánto tiempo. Los paquetes no cambian el precio.',
    'accounts.extraChannels': 'Canales extra (sueltos)',
    'accounts.filterChannels': 'Filtrar canales…',
    'accounts.activate': 'Activar',
    'accounts.startTrial': 'Iniciar una prueba',
    'accounts.devicesNote': 'dispositivos por cuenta: {n} (los fija tu administrador)',
    'accounts.noPackages': 'Todavía no hay paquetes en el panel.',
    'accounts.noChannels': 'Todavía no hay canales en el panel.',
    'accounts.pkgSub': '{name} · {count} can.',
    'accounts.pkgSubDefault': '{name} · {count} can. · por defecto',

    // -- accounts: the table --
    'accounts.search': 'Busca por nombre o propietario…',
    'accounts.filter.active': 'Activas',
    'accounts.filter.expiring': 'Por vencer',
    'accounts.filter.disabled': 'Desactivadas',
    'accounts.filter.trial': 'Pruebas',
    'accounts.clearOwnerFilter': 'Quitar el filtro de propietario',
    'accounts.ownerChip': 'propietario **{owner}** ✕',
    'accounts.sort.nameAsc': 'Nombre A→Z',
    'accounts.sort.nameDesc': 'Nombre Z→A',
    'accounts.sort.expiresAsc': 'Vencen antes',
    'accounts.sort.expiresDesc': 'Vencen después',
    'accounts.sort.createdDesc': 'Creadas hace menos',
    'accounts.sort.createdAsc': 'Creadas hace más',
    'accounts.sort.statusAsc': 'Activas primero',
    'accounts.sort.statusDesc': 'Inactivas primero',
    'accounts.col.account': 'Cuenta',
    'accounts.col.owner': 'Propietario',
    'accounts.col.status': 'Estado',
    'accounts.col.expires': 'Vence',
    'accounts.col.created': 'Creada',
    'accounts.col.devices': 'Dispositivos',
    'accounts.mobile.expires': 'vence',
    'accounts.mobile.devices': 'dispositivos',
    'accounts.empty': 'Todavía no hay cuentas.',
    'accounts.noMatches': 'Sin resultados.',
    'accounts.countRange': '{from}–{to} de {total}',
    'accounts.showOnlyOwner': 'Mostrar solo las cuentas de {owner}',
    'accounts.trialBadge': 'prueba',

    // -- accounts: row actions --
    'accounts.renew': 'Renovar',
    'accounts.menu.suspend': 'Suspender',
    'accounts.menu.resume': 'Reanudar',
    'accounts.menu.channels': 'Canales y paquetes…',
    'accounts.menu.packages': 'Gestionar los paquetes…',
    'accounts.menu.devices': 'Dispositivos…',
    'accounts.menu.logoutAll': 'Cerrar la sesión en todos los dispositivos',
    'accounts.toast.logoutAll': '{account}: se revocó cada token de sesión',
    'accounts.toast.activated': 'Se activó {account} ({days} d)',
    'accounts.toast.activatedWithPackages': 'Se activó {account} ({days} d · {packages})',
    'accounts.toast.nameFirst': 'Escribe primero un nombre',
    'accounts.toast.trialStarted': 'Prueba {account} iniciada',
    'accounts.toast.suspended': '{account} suspendida',
    'accounts.toast.resumed': '{account} reanudada',

    // -- accounts: renew / password --
    'accounts.renewTitle': 'Renovar {account}',
    'accounts.monthsField': 'Meses (1 crédito cada uno)',
    'accounts.trialConvertNote': 'Esto convierte la prueba en una cuenta de pago.',
    'accounts.toast.renewed': 'Renovada a {days} d',
    'accounts.passwordTitle': 'Contraseña de {account}',

    // -- accounts: devices --
    'accounts.devices.title': 'Dispositivos: {account}',
    'accounts.devices.slots': '{active} de {max} espacio(s) de dispositivo en uso. Los dispositivos se registran solos cuando el espectador inicia sesión; uno nuevo por encima del límite expulsa al más antiguo.',
    'accounts.devices.none': 'No hay dispositivos registrados: nadie inició sesión todavía en esta cuenta.',
    'accounts.devices.unnamed': 'dispositivo sin nombre',
    'accounts.devices.subExpired': 'registrado el {enrolled} · sesión vencida el {expires}, sin iniciar sesión desde entonces',
    'accounts.devices.subLive': 'registrado el {enrolled} · sesión activa hasta el {expires} (se renueva al iniciar sesión)',
    'accounts.devices.toastRevoked': 'Dispositivo revocado: el espacio está libre; la app cierra la sesión en su próxima comprobación',
    'accounts.devices.note': 'Revocar es cooperativo: libera el espacio y una app correcta vuelve al inicio de sesión. Para cortar el acceso de golpe, usa Cerrar la sesión en todos los dispositivos (destruye cada token de sesión) o suspende la cuenta.',

    // -- accounts: channels & packages --
    'accounts.chan.title': 'Canales: {account}',
    'accounts.chan.panelDown': 'Panel inaccesible: no hay estado de canales en vivo. Se muestra solo el registro local.',
    'accounts.chan.localOnly': 'Paquetes asignados: {packages} · sueltos: {oneOffs}',
    'accounts.chan.packages': 'Paquetes',
    'accounts.chan.manage': 'Gestionar…',
    'accounts.chan.noPackages': 'No hay paquetes asignados.',
    'accounts.chan.channels': 'Canales ({count})',
    'accounts.chan.pkgTitle': 'paquete {name}',
    'accounts.chan.oneOff': 'suelto',
    'accounts.chan.auto': 'automático',
    'accounts.chan.addTitle': 'Añadir un canal extra (suelto)',
    'accounts.chan.bouquet': '(paquete)',
    'accounts.chan.toastStillGranted': 'Se quitó el canal suelto. Sigue concedido por el paquete {packages}',
    'accounts.chan.toastRevoked': '{channel} revocado',
    'accounts.chan.toastGranted': '{channel} concedido',
    'accounts.pkg.title': 'Paquetes: {account}',
    'accounts.pkg.none': 'Todavía no hay paquetes en el panel. El operador los crea en el panel de administración.',
    'accounts.pkg.note': 'Fija QUÉ recibe la cuenta. El reloj de la suscripción (los créditos) no cambia. Los canales sueltos se quedan como están.',
    'accounts.pkg.toastSet': 'Paquetes fijados: {packages}',

    // -- accounts: delete --
    'accounts.delete.title': 'Eliminar {account}',
    'accounts.delete.adminNote': 'Las eliminaciones de un administrador no devuelven nada.',
    'accounts.delete.refundNote': 'Devolución al eliminar: ~{n} crédito(s).',
    'accounts.delete.confirmField': 'Escribe el nombre de la cuenta para confirmar',
    'accounts.delete.mismatch': 'El nombre no coincide',
    'accounts.delete.toast': 'Eliminada (se devolvieron {n})',

    // -- resellers --
    'resellers.create': 'Crear un revendedor',
    'resellers.role': 'Rol',
    'resellers.filter': 'Filtrar usuarios del panel…',
    'resellers.col.name': 'Nombre',
    'resellers.col.role': 'Rol',
    'resellers.col.parent': 'Superior',
    'resellers.col.balance': 'Saldo',
    'resellers.col.accounts': 'Cuentas',
    'resellers.col.status': 'Estado',
    'resellers.fund': 'Financiar',
    'resellers.menu.reclaim': 'Recuperar créditos…',
    'resellers.menu.limits': 'Límites…',
    'resellers.menu.suspend': 'Suspender…',
    'resellers.menu.resume': 'Reanudar…',
    'resellers.toast.created': 'Se creó {name}',
    'resellers.fund.title': 'Financiar a {name}',
    'resellers.fund.field': 'Créditos (tú tienes {balance})',
    'resellers.fund.toast': 'Se enviaron {amount} a {name}',
    'resellers.reclaim.title': 'Recuperar de {name}',
    'resellers.reclaim.field': 'Créditos (tiene {balance})',
    'resellers.reclaim.ok': 'Recuperar',
    'resellers.reclaim.toast': 'Se recuperaron {amount}',
    'resellers.limits.title': 'Límites: {name}',
    'resellers.limits.readOnly': 'Dispositivos por cuenta: {n}. Los fija el administrador.',
    'resellers.limits.readOnlyInherited': 'Dispositivos por cuenta: {n} (heredado). Los fija el administrador.',
    'resellers.limits.devicesField': 'Dispositivos por cuenta — en blanco = heredar',
    'resellers.limits.devicesFieldFrom': 'Dispositivos por cuenta — en blanco = heredar de {parent}',
    'resellers.limits.inheritPlaceholder': 'heredar ({n})',
    'resellers.limits.note': 'Lo hereda cada usuario del panel por debajo de este; sus cuentas nuevas reciben este número de dispositivos.',
    'resellers.limits.trialsPerDay': 'Pruebas por día',
    'resellers.limits.toast': 'Límites actualizados',
    'resellers.suspend.title': 'Suspender a {name}',
    'resellers.resume.title': 'Reanudar a {name}',
    'resellers.suspend.alsoDisable': 'Desactivar también sus cuentas de espectador en el panel',
    'resellers.suspend.alsoEnable': 'Activar también sus cuentas de espectador en el panel',
    'resellers.suspend.toast': '{name} suspendido',
    'resellers.resume.toast': '{name} activo',
    'resellers.password.title': 'Contraseña de {name}',
    'resellers.password.toast': 'Contraseña cambiada (sus sesiones se revocaron)',
    'resellers.delete.title': 'Eliminar a {name}',
    'resellers.delete.note': 'Bloqueado mientras tenga usuarios del panel subordinados o cuentas. El saldo que quede se recupera para ti.',
    'resellers.delete.toast': 'Se eliminó a {name}',

    // -- ledger --
    'ledger.mintPanel': 'Emitir o ajustar créditos',
    'ledger.to': 'Para',
    'ledger.toPlaceholder': 'usuario del panel (por defecto: tú)',
    'ledger.amount': 'Cantidad',
    'ledger.note': 'Nota',
    'ledger.mint': 'Emitir',
    'ledger.transactions': 'Transacciones',
    'ledger.type.MINT': 'Emisión',
    'ledger.type.TRANSFER': 'Transferencia',
    'ledger.type.ACTIVATE': 'Activación',
    'ledger.type.RENEW': 'Renovación',
    'ledger.type.REFUND': 'Devolución',
    'ledger.type.TRIAL': 'Prueba',
    'ledger.type.RECLAIM': 'Recuperación',
    'ledger.type.ADJUST': 'Ajuste',
    'ledger.col.when': 'Cuándo',
    'ledger.col.type': 'Tipo',
    'ledger.col.counterparty': 'Contraparte',
    'ledger.col.account': 'Cuenta',
    'ledger.col.note': 'Nota',
    'ledger.toast.minted': 'Emitidos',

    // -- settings --
    'settings.changePassword': 'Cambia tu contraseña',
    'settings.operations': 'Operaciones',
    'settings.runSweep': 'Ejecutar ahora el barrido de vencimientos',
    'settings.runReconcile': 'Ejecutar ahora la conciliación',
    'settings.opsHint': 'El barrido de vencimientos desactiva en el panel las cuentas caducadas. La conciliación compara el panel con los registros locales (las reparaciones se aplican solo cuando [[RECONCILE_REPAIR=1]]).',
    'settings.toast.passwordChanged': 'Contraseña cambiada. Inicia sesión otra vez',
    'settings.toast.sweep': 'Barrido: {disabled} desactivadas, {errors} errores',
    'settings.reconcileReport': 'Informe de conciliación',

    // -- system diagnostics --
    'system.panelConnection': 'Conexión con el panel',
    'system.serviceProcess': 'Proceso del servicio',
    'system.hostMachine': 'Máquina anfitriona',
    'system.refreshNote': '· se actualiza cada 5 s mientras está abierto',
    'system.refreshNow': 'Actualizar ahora',
    'system.updated': 'actualizado a las {time}',
    'system.tile.panelLink': 'Enlace con el panel',
    'system.tile.hostMemory': 'Memoria del anfitrión',
    'system.tile.load1m': 'Carga (1 min)',
    'system.tile.diskFree': 'Disco libre',
    'system.roundTrip': 'ida y vuelta',
    'system.of': 'de {total}',
    'system.cores': '{n} núcleo(s)',
    'system.down': 'caído',
    'system.na': 'n/d',
    'system.reachable': 'accesible',
    'system.unreachable': 'inaccesible',
    'system.unknown': 'desconocido',
    'system.unavailable': 'no disponible',
    'system.state': 'Estado',
    'system.latency': 'Latencia',
    'system.lastOk': 'Último OK',
    'system.lastError': 'Último error',
    'system.viewerUsers': 'Espectadores',
    'system.streams': 'Canales',
    'system.streamsValue': '{total} ({live} en vivo)',
    'system.panelAdmins': 'Administradores del panel',
    'system.panelKey': 'Clave del panel',
    'system.noPanel': 'no hay panel configurado',
    'system.uptime': 'Tiempo activo',
    'system.memRss': 'Memoria (RSS)',
    'system.heapUsed': 'Heap usado',
    'system.dataDir': 'Directorio de datos',
    'system.ledger': 'Libro de créditos',
    'system.ledgerValue': 'seq {seq} · {state}',
    'system.consistent': 'consistente',
    'system.invariantBroken': 'INVARIANTE ROTA',
    'system.lastSweep': 'Último barrido',
    'system.webhook': 'Webhook de recarga',
    'system.enabled': 'activado',
    'system.disabled': 'desactivado',
    'system.hostname': 'Nombre del anfitrión',
    'system.loadAvg': 'Carga media',
    'system.memory': 'Memoria',
    'system.disk': 'Disco',

    // -- backup & restore --
    'backup.title': 'Copia de seguridad y restauración',
    'backup.warnLine': '**Un revendedor se restaura con una restauración de volumen, no con una restauración de configuración.** El libro de créditos es el registro válido, y ningún fichero de configuración lo contiene. Esta tarjeta te da una instantánea de referencia y una plantilla para un segundo sitio. No puede escribir ninguna de las dos de vuelta.',
    'backup.whyHint': 'Hay dos razones, y son distintas. Un registro de usuario del panel lleva el contador de sesión que sube con cada cambio de contraseña. Escribir una copia antigua de vuelta daría acceso otra vez a las sesiones revocadas. Y el saldo de una cuenta viene del libro de créditos, así que un mapa de cuentas que retrocede en el tiempo no concuerda con el libro que lo financia.',
    'backup.snapshotsHead': 'Instantáneas de configuración',
    'backup.snapshotsHeadSub': '(usuarios del panel y cuentas, en la máquina)',
    'backup.takeSnapshot': 'Tomar una instantánea ahora',
    'backup.downloadTemplate': 'Descargar la plantilla',
    'backup.snapDir': 'Las instantáneas se guardan en {dir} en la máquina.',
    'backup.snapCol.taken': 'Tomada',
    'backup.snapCol.note': 'Nota',
    'backup.snapCol.contents': 'Contenido',
    'backup.snapCol.size': 'Tamaño',
    'backup.templateHint': 'La plantilla contiene la forma de la jerarquía: cada nombre, rol y superior. No contiene material de contraseñas ni cuentas de clientes. Úsala para construir la misma estructura en un segundo sitio con [[reseller-cli]].',
    'backup.archivesHead': 'Archivos de recuperación',
    'backup.archivesHeadSub': '(todo el volumen de datos)',
    'backup.archCol.archive': 'Archivo',
    'backup.archCol.age': 'Antigüedad',
    'backup.archCol.size': 'Tamaño',
    'backup.archCol.state': 'Estado',
    'backup.restoreHint': '**Restaura siempre el archivo más nuevo que tengas.** La orden de restauración se niega a escribir sobre un volumen que contiene datos. También rechaza un archivo cuyo nombre no coincide con el servicio. No añadas [[--force]] para saltarte estas dos negativas si no sabes qué contiene el volumen. Ningún archivo contiene un fichero [[.env]]: esos viven en el anfitrión, fuera de los volúmenes.',
    'backup.damaged': 'dañada — {reason}',
    'backup.contents': '{principals} usuarios del panel · {accounts} cuentas',
    'backup.noSnapshot': 'Todavía no hay ninguna instantánea.',
    'backup.archFound': 'Encontrados en {dir} en la máquina.',
    'backup.archUnavailable': 'El revendedor no puede ver el directorio de archivos: {reason}. Tus archivos pueden existir igualmente. Este panel no puede leerlos.',
    'backup.oldNameFormat': '(formato de nombre antiguo)',
    'backup.newest': 'el más nuevo — restaura este',
    'backup.freshness.fresh': 'reciente',
    'backup.freshness.aging': 'envejeciendo',
    'backup.freshness.stale': 'antiguo',
    'backup.noArchive': 'No se encontró ningún archivo. Ejecuta la orden de copia de seguridad de abajo.',
    'backup.nothingToShow': 'Nada que mostrar.',
    'backup.minutes': '{n} min',
    'backup.hours': '{n} h',
    'backup.days': '{n} días',
    'backup.cmd.backup': 'Hacer un archivo ahora (en la máquina)',
    'backup.cmd.cron': 'Hacer uno cada hora (crontab -e)',
    'backup.cmd.restore': 'Restaurar el archivo más nuevo',
    'backup.cmd.restoreForce': 'Solo si el volumen ya contiene datos: esto BORRA el contenido primero',
    'backup.toast.copied': 'orden copiada',
    'backup.toast.copyFailed': 'no se pudo copiar: selecciona el texto',
    'backup.delete.title': '¿Eliminar esta instantánea?',
    'backup.delete.note': 'No puedes deshacer esto. Es la única copia de la configuración de ese momento.',
    'backup.delete.toast': 'instantánea eliminada',
    'backup.take.title': 'Tomar una instantánea',
    'backup.take.field': 'Nota (opcional)',
    'backup.take.placeholder': 'por qué tomaste esta',
    'backup.take.ok': 'Tomar la instantánea',
    'backup.take.toast': 'instantánea {id} tomada ({size})',
    'backup.tpl.refused': 'rechazado: este fichero no es una plantilla sin secretos',
    'backup.tpl.toast': 'plantilla descargada: no contiene material de contraseñas'
  }

  // ---- runtime -----------------------------------------------------------------------

  const STORE_KEY = 'rsl-lang'
  const CODES = LOCALES.map((l) => l.code)
  const DEFAULT = 'en'

  function stored () {
    try { return localStorage.getItem(STORE_KEY) } catch { return null } // private mode
  }

  // Stored choice wins; otherwise follow the browser, but only into a locale we ship.
  function initialLocale () {
    const saved = stored()
    if (saved && CODES.includes(saved)) return saved
    for (const tag of (navigator.languages || [navigator.language || ''])) {
      const base = String(tag).toLowerCase().split('-')[0]
      if (CODES.includes(base)) return base
    }
    return DEFAULT
  }

  let locale = initialLocale()
  const listeners = []

  const fill = (s, vars) => vars
    ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
    : String(s)

  // English is the fallback for a key a locale has not translated yet. The guard makes
  // that impossible in the repo — it stays as the safety net for a hand-edited box.
  function raw (key) {
    const cat = CATALOG[locale]
    const v = cat && cat[key]
    if (typeof v === 'string') return v
    const fb = CATALOG[DEFAULT][key]
    return typeof fb === 'string' ? fb : null
  }

  function t (key, vars) {
    const v = raw(key)
    return v === null ? key : fill(v, vars)
  }

  // For values that come from the server as an enum (a ledger type, an account status):
  // translate it when we know it, echo it when we don't. A new server-side type shows
  // through rather than turning into a missing-key string.
  function tOr (key, fallback) {
    const v = raw(key)
    return v === null ? String(fallback) : v
  }

  // Rich values carry **bold** and [[monospace]]. The catalog is a repo constant, but
  // the interpolated vars are not, so build DOM nodes instead of assigning innerHTML.
  const RICH = /\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]/g
  function tNodes (key, vars) {
    const s = t(key, vars)
    const out = []
    let at = 0
    for (const m of s.matchAll(RICH)) {
      if (m.index > at) out.push(document.createTextNode(s.slice(at, m.index)))
      const bold = m[1] !== undefined
      const node = document.createElement(bold ? 'b' : 'span')
      if (!bold) node.className = 'mono'
      node.textContent = bold ? m[1] : m[2]
      out.push(node)
      at = m.index + m[0].length
    }
    if (at < s.length) out.push(document.createTextNode(s.slice(at)))
    return out
  }

  // A <label> wraps its control, so replacing textContent would delete the input.
  // Replace only the first non-blank text node when the element has element children.
  function setText (node, text) {
    if (node.children.length) {
      const first = [...node.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim())
      if (first) { first.textContent = text; return }
    }
    node.textContent = text
  }

  function applyStatic (root) {
    const r = root || document
    for (const n of r.querySelectorAll('[data-i18n]')) setText(n, t(n.dataset.i18n))
    for (const n of r.querySelectorAll('[data-i18n-rich]')) n.replaceChildren(...tNodes(n.dataset.i18nRich))
    for (const n of r.querySelectorAll('[data-i18n-ph]')) n.placeholder = t(n.dataset.i18nPh)
    for (const n of r.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle)
    for (const n of r.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria))
    document.documentElement.lang = locale
  }

  // Every .lang-select is one control on the same setting — the login card has one and
  // Settings has another, and they must never disagree.
  function mountSelects () {
    for (const sel of document.querySelectorAll('.lang-select')) {
      if (!sel.options.length) {
        for (const l of LOCALES) sel.append(Object.assign(document.createElement('option'), { value: l.code, textContent: l.name }))
        sel.onchange = () => setLocale(sel.value)
      }
      sel.value = locale
    }
  }

  function setLocale (code) {
    if (!CODES.includes(code) || code === locale) return
    locale = code
    try { localStorage.setItem(STORE_KEY, code) } catch {}
    applyStatic()
    mountSelects()
    for (const fn of listeners) { try { fn(code) } catch (e) { console.error(e) } }
  }

  window.t = t
  window.tOr = tOr
  window.tNodes = tNodes
  window.i18n = {
    LOCALES,
    CATALOG,
    get locale () { return locale },
    setLocale,
    applyStatic,
    onChange: (fn) => listeners.push(fn)
  }

  applyStatic()
  mountSelects()
})()
