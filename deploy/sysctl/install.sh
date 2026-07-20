#!/bin/sh
# OPTIONAL host network tuning for Aliran. See 99-aliran.conf for what it sets and why,
# and docs/kb/network-tuning.md for the full background.
#
#   sudo deploy/sysctl/install.sh
#
# Nothing in the normal deploy calls this script — Aliran runs without it. It matters once
# a box carries real viewer load: the swarm's UDP socket buffers are capped by host sysctls
# that ship far too small, and the kernel enforces that cap by dropping packets silently.
# Equally fine to apply the same two values by hand or via your own config management.
#
# Idempotent — safe to re-run. Worth re-running after a host rebuild or migration: these
# are HOST settings, so a fresh image drops them while the Aliran install still looks fine.
#
# This cannot be done from Docker. The services run with `network_mode: host`, and Docker
# rejects `sysctls:` for net.* under host networking (the container shares the host's
# network namespace, so there is nothing separate to set). Bare-metal/systemd installs
# need it just the same.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)/99-aliran.conf"
DEST=/etc/sysctl.d/99-aliran.conf
WANT=8388608

[ "$(id -u)" = 0 ] || { echo "error: must run as root (try: sudo $0)" >&2; exit 1; }
[ -f "$SRC" ] || { echo "error: not found: $SRC" >&2; exit 1; }

cp "$SRC" "$DEST"
sysctl --system >/dev/null

# Verify rather than assume: another drop-in later in the load order, a container runtime,
# or a cloud-image default can override us, and the failure mode this guards against is
# silent (the kernel clamps socket buffers without error).
rc=0
for key in net.core.rmem_max net.core.wmem_max; do
  got=$(sysctl -n "$key" 2>/dev/null || echo 0)
  if [ "$got" -lt "$WANT" ]; then
    echo "WARNING: $key is $got, expected >= $WANT." >&2
    echo "         Something else on this host overrides $DEST — check /etc/sysctl.d/ load order." >&2
    rc=1
  else
    echo "ok: $key = $got"
  fi
done

echo "Installed $DEST — re-applied on every boot by systemd-sysctl."
echo "Restart the services so they re-request their buffers: docker compose restart"
exit $rc
