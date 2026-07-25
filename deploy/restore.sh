#!/bin/sh
# Restore an Aliran data volume from a deploy/backup.sh archive: verify archive ->
# stop service -> replace the volume contents -> start service. The counterpart of
# backup.sh; see docs/kb/backup-and-rotation.md for the full runbook.
#
#   ./deploy/restore.sh [-p PROJECT] [--force] <service> <archive.tar.gz>
#
# PROJECT is the compose project name (volume prefix) — defaults to
# $COMPOSE_PROJECT_NAME or the current dir name, exactly like backup.sh.
# The archive path is tried as given, then under ./backups/.
#
# Refused WITHOUT --force:
#   - an archive whose name does not match the service (a panel volume only takes
#     panel-<stamp>.tar.gz — restoring the wrong service's data is unrecoverable)
#   - a NON-EMPTY target volume (restoring over live data is the destructive case)
#
# --force REPLACES the volume contents: existing files are deleted first, so the
# volume ends up exactly equal to the archive. Never untar-over-merge — mixing two
# corestore generations in one store is itself a corruption.
#
# Restoring a PANEL backup rolls users/grants/keys back to that archive's moment.
# .env files live OUTSIDE the volumes and are not touched here.
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -p) [ $# -ge 2 ] || { echo "error: -p needs a value" >&2; exit 2; }; PROJECT=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    -*) echo "usage: $0 [-p PROJECT] [--force] <service> <archive.tar.gz>" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || { echo "usage: $0 [-p PROJECT] [--force] <service> <archive.tar.gz>" >&2; exit 2; }
SVC=$1
ARCHIVE=$2

case "$SVC" in
  panel|broadcaster|library|reseller) ;;
  *) echo "error: unknown service '$SVC' (panel|broadcaster|library|reseller)" >&2; exit 1 ;;
esac
[ -f docker-compose.yml ] || { echo "error: run from the repo root (docker-compose.yml not found)" >&2; exit 1; }
if [ ! -f "$ARCHIVE" ]; then
  if [ -f "./backups/$ARCHIVE" ]; then ARCHIVE="./backups/$ARCHIVE"
  else echo "error: archive not found: $ARCHIVE (also tried ./backups/)" >&2; exit 1
  fi
fi
BASE=$(basename "$ARCHIVE")

case "$BASE" in
  "$SVC"-*.tar.gz|"$SVC"-*.tgz) ;;
  *) if [ "$FORCE" -ne 1 ]; then
       echo "refusing: archive '$BASE' does not look like a $SVC backup ($SVC-<stamp>.tar.gz) — pass --force only if you are sure it holds $SVC data" >&2
       exit 3
     fi ;;
esac

vol="${PROJECT}_${SVC}-data"
docker volume inspect "$vol" >/dev/null 2>&1 || { echo "error: volume $vol not found (wrong -p PROJECT?)" >&2; exit 1; }
BDIR=$(cd "$(dirname "$ARCHIVE")" && pwd)

# Verify the archive BEFORE touching anything — a corrupt tarball must not cost a
# service stop, let alone the volume.
echo "== $SVC: verifying archive $BASE"
docker run --rm -v "$BDIR":/backup:ro alpine tar tzf "/backup/$BASE" >/dev/null

prev=$(docker run --rm -v "$vol":/data alpine sh -c 'find /data -mindepth 1 | wc -l' | tr -d '[:space:]')
prev_size=$(docker run --rm -v "$vol":/data alpine sh -c 'du -sh /data 2>/dev/null | cut -f1' | tr -d '[:space:]')
if [ "$prev" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "refusing: volume $vol is NOT empty ($prev files, $prev_size) — restoring would overwrite it. Re-run with --force to replace its contents." >&2
  exit 3
fi

echo "== $SVC: stopping"
docker compose stop "$SVC"
if [ "$prev" -gt 0 ]; then
  echo "== $SVC: clearing $vol ($prev files, $prev_size)"
  docker run --rm -v "$vol":/data alpine sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
fi
echo "== $SVC: restoring $BASE -> $vol"
docker run --rm -v "$vol":/data -v "$BDIR":/backup:ro alpine tar xzf "/backup/$BASE" -C /data
now=$(docker run --rm -v "$vol":/data alpine sh -c 'find /data -mindepth 1 | wc -l' | tr -d '[:space:]')
echo "== $SVC: starting"
docker compose start "$SVC"
echo "== done: restored $vol from $BASE ($now files; replaced $prev previous files, $prev_size)"
echo "Reminder: .env files live OUTSIDE the volumes — if the box was rebuilt, restore/verify those separately."
