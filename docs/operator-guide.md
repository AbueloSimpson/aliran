# Operator Guide (self-hosting)

Run your own Aliran service. Everything is configuration — no code changes needed.

Two supported deployments, same result:

- **Docker Compose (recommended):** one command, images bundle Node + ffmpeg,
  auto-restart built in.
- **Bare metal + systemd:** plain Node processes under systemd; easier to poke at
  with standard tools.

Networking headline: **the P2P layer needs no inbound ports.** Clients find the
panel by its public key over the DHT (outbound UDP hole-punching), and viewers
re-seed each other. A $5 VPS behind a strict firewall works.

## Prerequisites

- A Linux box — Ubuntu 24.04 LTS is what we test on (a cheap VPS or a home machine).
- Docker + Docker Compose plugin (`apt-get install docker.io docker-compose-v2`),
  **or** Node.js 20+ and `ffmpeg` for the bare-metal path.
- (Optional) two DNS A-records pointing at the box, for HTTPS dashboards via Caddy.
- (Optional, DRM) an account with a multi-DRM vendor (BuyDRM/KeyOS, EZDRM, Axinom…).
- (Optional, geo) a MaxMind GeoLite2 database file.

## A. Docker Compose (recommended)

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
cp panel/.env.example panel/.env
cp broadcaster/.env.example broadcaster/.env

docker compose build

# One-time: generate the panel keys (prints the panel PUBLIC key for clients and
# the PUBLISHER key for the broadcaster .env — back both up, see Operations).
docker compose run --rm panel node src/admin-cli.js init

# One-time: create dashboard admin accounts (min 8-char passwords).
docker compose run --rm panel node src/admin-cli.js add-admin admin
docker compose run --rm broadcaster node src/control-cli.js add-admin admin

# Fill in the .env files: broadcaster needs PANEL_PUBKEY + PUBLISHER_KEY from init;
# set ADMIN_ENABLED=1 / CONTROL_ENABLED=1 to serve the dashboards.
docker compose up -d
docker compose logs -f     # watch both come up
```

The compose file uses `network_mode: host` on purpose: Hyperswarm's hole-punching
works without Docker's bridge NAT stacked on the host's, the dashboards keep their
safe `127.0.0.1` binding, and future push-ingest ports need no compose edits. If you
must use a bridge network (e.g. rootless Docker), drop `network_mode: host`, add
`ports:` for anything you expose, and expect somewhat slower peer connectivity.

Data lives in the named volumes `panel-data` / `broadcaster-data` (`DATA_DIR=/data`
inside the containers).

## B. Bare metal + systemd

```bash
sudo apt-get install -y nodejs npm ffmpeg     # or NodeSource for Node 24
sudo useradd -r -m -d /var/lib/aliran -s /usr/sbin/nologin aliran
sudo git clone https://github.com/AbueloSimpson/aliran /opt/aliran
sudo chown -R aliran: /opt/aliran
cd /opt/aliran && sudo -u aliran npm install --omit=dev --workspaces

# Keys + admin accounts (same commands, no Docker wrapper):
cd panel && sudo -u aliran cp .env.example .env
sudo -u aliran node src/admin-cli.js init
sudo -u aliran node src/admin-cli.js add-admin admin
cd ../broadcaster && sudo -u aliran cp .env.example .env
sudo -u aliran node src/control-cli.js add-admin admin

sudo cp /opt/aliran/deploy/systemd/aliran-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aliran-panel aliran-broadcaster
journalctl -u aliran-panel -f
```

The unit files
([deploy/systemd/](https://github.com/AbueloSimpson/aliran/tree/main/deploy/systemd))
restart on crash and are sandboxed to their data dirs.

## C. Create accounts & streams

Via the **admin dashboard** (below), or the CLI (bare metal shown; prefix with
`docker compose run --rm panel` under Docker — note store-writing CLI commands need
the panel *stopped*, the dashboard does not):

```bash
node src/admin-cli.js create-user alice
node src/admin-cli.js add-stream news --title "News 24" --category news
node src/admin-cli.js upload-art news poster ./art/news-poster.jpg
node src/admin-cli.js grant alice news
```

## D. The dashboards (admin + broadcaster control)

Set `ADMIN_ENABLED=1` (panel, port 3210) and `CONTROL_ENABLED=1` (broadcaster,
port 3310). Both bind `127.0.0.1` and speak plain HTTP — **never expose them raw.**

> Note (current behavior): after a broadcaster restart, channels stay stopped until
> you press Start again (dashboard or API). Auto-resume + a crash watchdog are on the
> roadmap.

- **With a domain:** install Caddy and use
  [deploy/Caddyfile.example](https://github.com/AbueloSimpson/aliran/blob/main/deploy/Caddyfile.example)
  — automatic HTTPS, the plain-HTTP APIs never leave loopback.
- **Without a domain:** SSH tunnel from your workstation, no server changes at all:

  ```bash
  ssh -N -L 3210:127.0.0.1:3210 -L 3310:127.0.0.1:3310 user@your-vps
  ```

  then browse `http://127.0.0.1:3210` (panel) and `http://127.0.0.1:3310`
  (broadcaster control).

## E. Broadcaster input

`INPUT` in `broadcaster/.env` (or per-channel via the control dashboard) currently
supports: `test` (built-in test pattern), a **file path** (looped), or a **pull
URL** (`rtsp://`, `http(s)://` HLS, etc.). Push ingest — RTMP for OBS, SRT with
passphrase, MPEG-TS over UDP — plus per-channel transcode/GPU settings are the next
roadmap items (see [ROADMAP.md](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md));
they will require opening their listen ports in the firewall.

## F. Point the client at your panel

Build/brand the client with your **panel public key** (build-time config) or generate
a **service-descriptor QR** for runtime pairing. See [client-build.md](client-build.md).
Nothing else is needed — clients reach the panel through the DHT, not an IP/domain.

## Firewall

| Purpose | Direction | Ports |
|---|---|---|
| P2P (DHT, replication, viewers) | outbound only | UDP, any |
| Dashboards via Caddy | inbound | 80 + 443 TCP |
| Dashboards via SSH tunnel | inbound | 22 TCP only |
| Push ingest (when it lands) | inbound | the channel's listen port, restricted: `ufw allow from <encoder-ip> to any port <port>` |

`RELAY_ONLY=1` on the panel hides the origin IP behind DHT relays (slower, more
private).

## Sizing

Verified on a 1 vCPU / 1 GB VPS: two concurrent test channels encode fine (load ≈1.5).
On boxes with ≤2 GB RAM, add swap and lower the login KDF memory in `panel/.env` —
`ARGON2_MEM_KIB=65536` (64 MiB per login instead of the 256 MiB default; the
parameters are stored per user record, so changing them later only affects new
enrollments/password rotations). Each running channel costs one ffmpeg encode —
budget roughly one vCPU per two test-pattern channels until per-channel transcode
controls land.

## Operations

- **Backups:** the data dirs (keys + cores). `DATA_DIR/keys` and
  `DATA_DIR/secrets` are the critical, unrecoverable parts; losing the OPRF key
  locks everyone out.
- **Updates:** `git pull && docker compose up -d --build` (Compose) or
  `git pull && npm install --omit=dev --workspaces && systemctl restart aliran-panel aliran-broadcaster`.
- **Key rotation:** rotating the OPRF key requires user re-enrollment; document a
  runbook before you need it.
- **Monitoring:** watch panel login RPC, peer counts, lockouts; the dashboards show
  live channel health (ffmpeg, peers, registration).
- **HA:** for availability run a replica set (threshold OPRF) — see
  [configuration.md](configuration.md); still on the roadmap.
