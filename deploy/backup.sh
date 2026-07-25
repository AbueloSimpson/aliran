#!/bin/sh
# Cold backup of Aliran data volumes: stop service -> tar volume -> start service.
# See docs/kb/backup-and-rotation.md for the full runbook (what to back up and why,
# restore, standby/failover, rotation).
#
#   ./deploy/backup.sh [-o OUTDIR] [-p PROJECT] [service ...]
#
# Defaults: OUTDIR=./backups, services="panel". PROJECT is the compose project name
# (volume prefix) — defaults to $COMPOSE_PROJECT_NAME or the current dir name.
#
#   ./deploy/backup.sh                                 # panel -> ./backups/
#   ./deploy/backup.sh -o /srv/backups panel reseller  # both, to /srv/backups
#
# Cold on purpose: a corestore copied mid-write can capture a torn tree. The stop
# window is short — a stopped panel only pauses NEW logins (viewers keep playing).
# ENCRYPT the archives at rest: a panel backup contains the signing + OPRF keys.
set -eu

OUT=./backups
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
while getopts o:p: flag; do
  case "$flag" in
    o) OUT=$OPTARG ;;
    p) PROJECT=$OPTARG ;;
    *) echo "usage: $0 [-o OUTDIR] [-p PROJECT] [service ...]" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
SERVICES="${*:-panel}"

[ -f docker-compose.yml ] || { echo "error: run from the repo root (docker-compose.yml not found)" >&2; exit 1; }
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S)

for svc in $SERVICES; do
  case "$svc" in
    panel|broadcaster|library|reseller) ;;
    *) echo "error: unknown service '$svc' (panel|broadcaster|library|reseller)" >&2; exit 1 ;;
  esac
  vol="${PROJECT}_${svc}-data"
  docker volume inspect "$vol" >/dev/null 2>&1 || { echo "error: volume $vol not found (wrong -p PROJECT?)" >&2; exit 1; }
  echo "== $svc: stopping"
  docker compose stop "$svc"
  file="$svc-$STAMP.tar.gz"
  echo "== $svc: archiving $vol -> $OUT/$file"
  docker run --rm -v "$vol":/data -v "$(cd "$OUT" && pwd)":/backup alpine \
    tar czf "/backup/$file" -C /data .
  echo "== $svc: starting"
  docker compose start "$svc"
  ls -lh "$OUT/$file" | awk '{print "== done:", $NF, "("$5")"}'
done

echo "Reminder: .env files live OUTSIDE the volumes — back up the repo dir's .env files too."
