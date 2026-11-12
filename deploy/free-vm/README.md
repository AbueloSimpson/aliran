# Free always-on host for the P2P backend

The panel, broadcaster, repeater, library and EPG are **Hyperswarm/HyperDHT
services over UDP**. They need inbound UDP, a long-lived process, and a
persistent identity. No PaaS free tier (Render, Vercel, Railway, Fly's free
allowance) provides that — those give HTTP in and out only. So the free path is
a **free VM**, not a free PaaS.

This kit stands the whole stack up on a free VM in one command, and — the part
that matters — **restores the panel identity**, so the panel key and pairing code
survive and every shipped app keeps working.

## Free VM options that actually work

| Provider | Free tier | Notes |
|---|---|---|
| **Oracle Cloud Always Free** | Ampere A1 ARM: up to 4 OCPU / 24 GB RAM, always on | The most generous free VM available. Pick an Ubuntu 22.04/24.04 ARM image. |
| **Google Cloud free tier** | `e2-micro` in `us-central1` / `us-west1` / `us-east1` | Small (1 GB RAM) — fine for a panel + one broadcaster. |
| **Home server / old PC** | Free | Best if you already have one; full control, real UDP. |

Open these in the VM's firewall / cloud security list:

- **UDP 40000–41000** — Hyperswarm hole-punching and P2P replication.
- **TCP 443** — only if you enable Caddy for HTTPS on the dashboard.

## The one command

On a fresh Ubuntu VM:

```bash
# 1. Get the script (or scp it over).
curl -fsSL -o bootstrap.sh \
  https://raw.githubusercontent.com/tokexperiment090-arch/aliran/somalistream-selfhost/deploy/free-vm/bootstrap.sh

# 2. Provide the panel IDENTITY and the admin passwords.
#    ALIRAN_PANEL_DATA_B64 is the base64 of the /data tar; it is stored as an
#    encrypted GitHub Actions secret (see "Where the identity lives").
export ALIRAN_PANEL_DATA_B64='<base64-of-panel-data.tgz>'
export PANEL_ADMIN_PASSWORD='SomaliStream-Admin-2026!'
export CONTROL_ADMIN_PASSWORD='SomaliStream-Control-2026!'
export PUBLIC_HOST='panel.example.com'      # optional: turns on Caddy TLS

# 3. Run it.
sudo -E bash bootstrap.sh
```

It installs Docker, clones the branch, restores the identity, seeds the admins,
and brings up the panel + broadcaster. If `PUBLIC_HOST` is set it also installs
Caddy and serves the dashboard over HTTPS with an automatic Let's Encrypt cert.

Without `ALIRAN_PANEL_DATA_B64` the panel mints a **new** identity — the script
prints the new key and pairing code and you must rebuild the apps.

## Where the identity lives

The panel's private keypair is the identity every app pins. It is small
(`/data/keys/{signing.json,oprf.key,publisher.json}`) and must never be lost.
Three copies are kept:

1. **The live VM** — `panel-data` volume (`docker volume`), owned by the panel.
2. **GitHub Actions secrets** on the fork — encrypted at rest:
   - `ALIRAN_PANEL_DATA_B64` — base64 of `tar czf - .` from `/data`.
   - `PANEL_PUBLIC_KEY`, `PANEL_PAIRING_CODE` — for reference.
   - `PANEL_ADMIN_PASSWORD`, `CONTROL_ADMIN_PASSWORD`, `VIEWER_PASSWORD`.
3. **Your own offline copy** — `./deploy/backup.sh -o /safe/place panel`.

Restore is idempotent: re-running `bootstrap.sh` with the same
`ALIRAN_PANEL_DATA_B64` onto a fresh host reproduces the identical panel key.

### Making a fresh identity backup

```bash
# On the host running the panel:
docker run --rm -v aliran_panel-data:/data alpine sh -c 'cd /data && tar czf - .' \
  | base64 -w0 > panel-data.tgz.b64
# Then store it as the ALIRAN_PANEL_DATA_B64 secret (see push-identity.sh).
```

## Verified

The restore path was tested, not assumed: a fresh empty volume, restored from
`ALIRAN_PANEL_DATA_B64`, booted a panel that printed the **same** key
(`5cd99321…`) and pairing code (`10ZJ-Y4DK-ZP17`) as the live host. See the
`## Verification` section of `SOMALISTREAM.md`.
