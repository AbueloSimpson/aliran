// Read-only index of the disaster-recovery archives on the box, plus the exact commands
// that make and apply them.
//
// Server-side only; import by path (same rule as atomic-write.js / config-snapshot.js):
//   import { indexBackups } from '@aliran/core/backup-index.js'
//
// WHY THIS ONLY READS
//
// deploy/backup.sh is a COLD backup: stop the service, tar the volume, start it again.
// deploy/restore.sh is stop, replace the volume, start. Neither can run inside the service
// it operates on — stopping the service kills the HTTP request that asked for it, so the
// operator would never learn whether the job finished. The alternatives were weighed and
// declined: mounting the Docker socket into a service makes any panel RCE into host root,
// and a host-side agent is a whole new component to install and keep alive for a
// convenience feature.
//
// So the dashboards LIST and EXPLAIN, and the operator runs the command. This module is
// the listing half. It never shells out, never writes, and needs nothing but a readable
// directory — mount the backups dir into the service read-only and that is the whole
// privilege requirement.
//
// STALENESS IS THE POINT, NOT DECORATION
//
// The panel's store is an append-only signed log, so restoring a snapshot REWINDS it, and
// everything written after the restore re-uses sequence numbers newer replicas may already
// have seen with different content. A client that replicated past the snapshot point
// refuses the forked history and its catalog stops updating until its local app storage is
// cleared. That is worse than downtime, and it is caused by restoring a STALE archive.
//
// The runbook rule is therefore "restore the newest backup you have, always". This module
// makes that mechanical: every entry knows whether it is the newest of its service, and how
// old it is against the hourly cadence the runbook recommends. A UI that shows these fields
// cannot accidentally present a six-week-old archive as an equal choice.

import fs from 'fs'
import path from 'path'

const SERVICES = ['panel', 'broadcaster', 'library', 'reseller']

// Two naming forms exist in the wild:
//   <service>-<YYYYMMDD>-<HHMMSS>.tar.gz     what deploy/backup.sh writes today
//   <service>-pre-<commit>-<YYYYMMDD>-<HHMM>.tar.gz
//     an older hand-rolled form still sitting on production boxes. It is parsed rather
//     than ignored, because an archive the dashboard cannot see is an archive the operator
//     forgets they have — but it is flagged `legacyName`, since restore.sh matches on the
//     `<service>-` prefix and will accept it while the stamp it carries is a different
//     shape. Nothing here renames anything: rewriting an operator's archive filenames from
//     a read-only lister would be a surprising thing for a listing to do.
const STD_RE = /^([a-z]+)-(\d{8})-(\d{6})\.(tar\.gz|tgz)$/
const LEGACY_RE = /^([a-z]+)-pre-([0-9a-f]{7,40})-(\d{8})-(\d{4,6})\.(tar\.gz|tgz)$/

// Freshness bands, in hours. The runbook recommends an hourly cron for the panel, so more
// than a few hours without one usually means the cron is not running rather than that the
// operator chose a slower cadence. Callers can override; the defaults are what the UI ships.
export const DEFAULT_FRESHNESS = { freshHours: 6, agingHours: 48 }

// Returned by EVERY answer this module produces, including the ones that list nothing.
// Exported so the "no directory mounted" branch in config-routes.js uses the same string:
// when the shapes diverged, /api/backups carried the .env warning only while a directory
// was visible — the case where the operator has the least to go on and needs it most.
export const ENV_NOTE = 'These archives hold the data volume only. The .env files live outside the volumes and are in no archive here — keep a copy of them separately.'

// The answer when there is no directory to read. A normal reply, not an error: an operator
// may legitimately keep archives somewhere this service cannot see.
export function noBackupDir (reason, dir = null) {
  return { available: false, dir, reason, archives: [], newest: null, note: ENV_NOTE }
}

function parseStamp (date, time) {
  const y = +date.slice(0, 4)
  const mo = +date.slice(4, 6)
  const d = +date.slice(6, 8)
  const h = +time.slice(0, 2)
  const mi = +time.slice(2, 4)
  const s = time.length >= 6 ? +time.slice(4, 6) : 0
  const dt = new Date(y, mo - 1, d, h, mi, s)
  return Number.isNaN(dt.getTime()) ? null : dt
}

export function parseArchiveName (name) {
  const std = STD_RE.exec(name)
  if (std) {
    return { service: std[1], at: parseStamp(std[2], std[3]), legacyName: false }
  }
  const leg = LEGACY_RE.exec(name)
  if (leg) {
    return { service: leg[1], at: parseStamp(leg[3], leg[4].padEnd(6, '0')), legacyName: true, commit: leg[2] }
  }
  return null
}

// The commands the dashboard shows. Rendered here rather than in each UI so the four
// dashboards cannot drift from each other or from the scripts.
//
// THESE COMMANDS RUN ON THE HOST, NOT IN THE SERVICE.
//
// So they deliberately carry NO `-o` directory, and use the scripts' own default of
// `./backups` relative to the repo root. The path this module reads is the path the
// SERVICE sees — `/backups` under the shipped compose file, which is a bind mount of the
// host's `./backups`. Pasting the service-side path into a host command would point it at
// a directory that usually does not exist there, and the operator would get an archive
// somewhere they are not looking, or an error, depending on the box. There is no reliable
// way for a container to learn its own bind-mount source, so the commands state the
// assumption instead of guessing: see `assumes` in the returned object.
//
// The restore command is the PLAIN one. restore.sh refuses a non-empty target volume and a
// name-mismatched archive without --force, and those two refusals are the whole safety
// design — a UI that pre-fills --force has disarmed them on the operator's behalf. The
// forcing variant is returned separately and labelled, so it is always a second,
// deliberate copy rather than the thing already on the clipboard.
export function renderCommands ({ service, archive } = {}) {
  const svc = SERVICES.includes(service) ? service : 'panel'
  const cmds = {
    backup: `./deploy/backup.sh ${svc}`,
    // The cadence the runbook recommends, ready to paste into crontab -e.
    cron: `0 * * * * cd /opt/aliran && ./deploy/backup.sh ${svc}`,
    assumes: 'Run these from the repository root on the box. They use its ./backups directory, which is the default for both scripts.'
  }
  if (archive) {
    cmds.restore = `./deploy/restore.sh ${svc} ${shellQuote(archive)}`
    cmds.restoreForce = `./deploy/restore.sh --force ${svc} ${shellQuote(archive)}`
  }
  return cmds
}

// Single-quote for /bin/sh. Archive names come off disk, so they are not assumed safe.
function shellQuote (s) {
  const v = String(s)
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : "'" + v.replace(/'/g, `'\\''`) + "'"
}

// Index one directory.
//
//   dir       — where the archives are. Read-only is enough.
//   service   — filter to one service (the dashboard only ever shows its own).
//   now       — injectable clock, so tests can assert the freshness bands.
//
// Returns { available, dir, archives, newest, note }. `available:false` with a reason is a
// normal answer, not an error: the directory legitimately is not mounted on a box whose
// operator keeps archives elsewhere, and the UI should say that rather than show an empty
// list that implies "you have no backups".
export function indexBackups (dir, { service, now = Date.now(), freshness = DEFAULT_FRESHNESS } = {}) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return noBackupDir(err.code === 'ENOENT'
      ? 'the backup directory is not visible to this service'
      : `the backup directory could not be read (${err.code || err.message})`, dir)
  }

  const archives = []
  for (const name of names) {
    const parsed = parseArchiveName(name)
    if (!parsed || !parsed.at) continue
    if (service && parsed.service !== service) continue
    let st
    try { st = fs.statSync(path.join(dir, name)) } catch { continue }
    if (!st.isFile()) continue
    const ageHours = Math.max(0, (now - parsed.at.getTime()) / 3600000)
    archives.push({
      name,
      service: parsed.service,
      at: parsed.at.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      bytes: st.size,
      legacyName: parsed.legacyName,
      ...(parsed.commit ? { commit: parsed.commit } : {}),
      freshness: ageHours <= freshness.freshHours ? 'fresh' : ageHours <= freshness.agingHours ? 'aging' : 'stale'
    })
  }

  archives.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  // `newest` is not decoration either — it is the only archive the runbook wants restored.
  // Marking every other entry lets the UI make that visible per row instead of relying on
  // the operator noticing the sort order.
  for (let i = 0; i < archives.length; i++) archives[i].newest = i === 0

  return {
    available: true,
    dir,
    archives,
    newest: archives[0] || null,
    // Surfaced verbatim by all four dashboards. .env files live on the host outside the
    // volumes, so no archive in this list contains one — an operator rebuilding a box from
    // these alone gets a service that will not boot, and finding that out during an outage
    // is exactly the wrong time.
    note: ENV_NOTE
  }
}
