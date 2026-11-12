#!/usr/bin/env bash
# SomaliStream / Aliran — one-shot bootstrap for a fresh FREE Ubuntu VM.
#
# Targets the genuinely-free always-on tiers that can host the P2P services
# (they need inbound UDP + a long-lived process + a persistent identity, which
# PaaS free tiers cannot give):
#
#   * Oracle Cloud "Always Free" — Ampere A1 (ARM, up to 4 OCPU / 24 GB) or the
#     2x AMD micro. The most generous free VM that exists.
#   * Google Cloud e2-micro free tier (us-central1/us-west1/us-east1).
#   * Any other Ubuntu 22.04/24.04 box (Hetzner, a home server, ...).
#
# It installs Docker, restores the panel IDENTITY (so the panel key and pairing
# code survive — the apps keep working), seeds the admins, and brings up the
# panel + broadcaster.
#
# Usage (as root or a sudoer):
#
#   export ALIRAN_PANEL_DATA_B64="$(cat panel-data.tgz.b64)"   # from GitHub secrets
#   export PANEL_ADMIN_PASSWORD='...'
#   export CONTROL_ADMIN_PASSWORD='...'
#   export PUBLIC_HOST='panel.example.com'   # optional: enables Caddy TLS
#   bash bootstrap.sh
#
# If ALIRAN_PANEL_DATA_B64 is unset the panel mints a NEW identity (new key +
# pairing code) — every shipped app then needs a rebuild. Prefer restoring.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tokexperiment090-arch/aliran.git}"
BRANCH="${BRANCH:-somalistream-selfhost}"
APP_DIR="${APP_DIR:-/opt/aliran}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-aliran}"
DATA_VOLUME="${COMPOSE_PROJECT}_panel-data"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || SUDO=sudo

log "Installing prerequisites (git, curl, docker)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO systemctl enable --now docker

log "Fetching the repository into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  $SUDO git -C "$APP_DIR" fetch --all --quiet
  $SUDO git -C "$APP_DIR" checkout "$BRANCH" --quiet
  $SUDO git -C "$APP_DIR" pull --ff-only --quiet || true
else
  $SUDO mkdir -p "$APP_DIR"
  $SUDO git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

log "Pinning the compose project name to '$COMPOSE_PROJECT'"
# A stable project name means a stable volume name, so the restore below lands
# in the same volume `docker compose up` will use.
export COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT"

docker info >/dev/null 2>&1 || DOCKER="sudo docker"
DOCKER="${DOCKER:-docker}"

log "Restoring the panel identity into volume $DATA_VOLUME"
$DOCKER volume create "$DATA_VOLUME" >/dev/null
if [ -n "${ALIRAN_PANEL_DATA_B64:-}" ]; then
  printf '%s' "$ALIRAN_PANEL_DATA_B64" | base64 -d > /tmp/panel-data.tgz
  $DOCKER run --rm -v "$DATA_VOLUME":/data -v /tmp/panel-data.tgz:/in.tgz:ro \
    alpine sh -c 'cd /data && tar xzf /in.tgz && chmod -R 700 keys 2>/dev/null || true'
  rm -f /tmp/panel-data.tgz
  log "Identity restored. The panel key and pairing code are unchanged."
else
  log "No ALIRAN_PANEL_DATA_B64 given — the panel will mint a NEW identity."
  $DOCKER compose build panel >/dev/null
  $DOCKER compose run --rm panel node src/admin-cli.js init | tee /tmp/init.out
  log "SAVE THIS NOW — it is the only copy of the new key:"
  cat /tmp/init.out
fi

log "Seeding the admins"
$DOCKER compose build panel broadcaster >/dev/null
if [ -n "${PANEL_ADMIN_PASSWORD:-}" ]; then
  printf '%s\n' "$PANEL_ADMIN_PASSWORD" | \
    $DOCKER compose run -T --rm panel node src/admin-cli.js add-admin admin >/dev/null
  log "  panel admin 'admin' created"
fi
if [ -n "${CONTROL_ADMIN_PASSWORD:-}" ]; then
  printf '%s\n' "$CONTROL_ADMIN_PASSWORD" | \
    $DOCKER compose run -T --rm broadcaster node src/control-cli.js add-admin admin >/dev/null
  log "  broadcaster control admin 'admin' created"
fi

log "Binding the dashboards for remote access"
# Keep the API on 0.0.0.0 so Caddy (or a tunnel) can reach it; the firewall, not
# the bind, is what keeps it private. See deploy/Caddyfile.example.
$SUDO sed -i 's/^ADMIN_HOST=.*/ADMIN_HOST=0.0.0.0/' panel/.env
$SUDO sed -i 's/^CONTROL_HOST=.*/CONTROL_HOST=0.0.0.0/' broadcaster/.env

log "Starting the stack"
$DOCKER compose up -d panel broadcaster
sleep 6
$DOCKER compose ps

log "Panel identity on this host"
$DOCKER logs project-panel-1 2>/dev/null | grep -E "Panel public key|Service pairing code" | tail -2 || true

if [ -n "${PUBLIC_HOST:-}" ]; then
  log "Installing Caddy for automatic TLS on $PUBLIC_HOST"
  $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
    $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | \
    $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq caddy >/dev/null
  $SUDO tee /etc/caddy/Caddyfile >/dev/null <<EOF
$PUBLIC_HOST {
    encode zstd gzip
    reverse_proxy 127.0.0.1:12000
}
EOF
  $SUDO systemctl reload caddy || $SUDO systemctl restart caddy
  log "Dashboard: https://$PUBLIC_HOST"
else
  log "No PUBLIC_HOST set — dashboards are on 127.0.0.1:12000 (panel) / :12001 (control)."
  log "Reach them with an SSH tunnel:"
  log "  ssh -N -L 12000:127.0.0.1:12000 -L 12001:127.0.0.1:12001 user@this-host"
fi

log "Done. Open UDP 40000-41000 + TCP 443 in the VM's firewall/security list,"
log "and apply deploy/sysctl/install.sh for the swarm UDP buffers."
