# Operator Guide (self-hosting)

Run your own Aliran service. Everything is configuration — no code changes needed.

**The supported deployment is Docker Compose.** The images pin the two things that
actually break deployments — the ffmpeg build (SRT + encoder availability) and the
Node version — and the compose file pre-solves host networking, data volumes, and
auto-restart. It is also the path that is continuously exercised in production and
by CI. A bare-metal + systemd alternative exists for environments that cannot run
Docker or that need direct GPU access (section B, advanced — less exercised).

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

## B. Alternative: bare metal + systemd (advanced)

> **Use Docker (section A) unless you have a reason not to.** This path exists for
> environments where Docker is unavailable/disallowed, and for hosts that need
> **direct GPU access** for hardware transcode (NVENC/VAAPI/QSV need vendor drivers
> on the host; the stock compose file does no GPU device passthrough). It is the
> less-exercised path — the Docker route is what production and CI run — and a
> dedicated, separately-packaged **GPU transcode pack** (bare metal + NVIDIA driver
> stack) is planned; see the [Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md).
> You also inherit your distro's ffmpeg — verify protocols/encoders with the
> dashboard's capability probe before relying on SRT or a GPU encoder.

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

A **redirect channel** — plays an operator CDN/HLS URL directly, no broadcaster or
P2P feed behind it — is one field: dashboard → Add stream → "Redirect URL", or
`POST /api/streams {"id":"promo","url":"https://cdn.example.com/promo/index.m3u8"}`.
See [content-management.md](content-management.md).

## D. The dashboards (admin + broadcaster control)

Set `ADMIN_ENABLED=1` (panel, port 3210) and `CONTROL_ENABLED=1` (broadcaster,
port 3310). Both bind `127.0.0.1` and speak plain HTTP — **never expose them raw.**

> Note: a channel you have **started** auto-resumes after a broadcaster restart (its
> desired state is persisted), and a crash **watchdog** keeps its ffmpeg alive across
> source hiccups. Stopping a channel flips its catalog entry to `isLive:false` so viewers
> stop seeing it as live. The one-time exception is the **first** boot after upgrading to
> this build: channels created before the upgrade have no persisted desired state yet, so
> press Start once (dashboard or API) — from then on they resume on their own.

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

Each channel has a typed input — set it per-channel in the **control dashboard**
(the ingest selector only offers what the host ffmpeg supports) or via `INPUT` in
`broadcaster/.env` for the env channel:

- **Pull**: `test` (built-in pattern), a **file path** (looped), or a **pull URL**
  (`rtsp://`, `http(s)://` HLS, `rtmp://`, `srt://`, `udp://`).
- **Push** (your encoder connects IN): **RTMP** (OBS et al.), **SRT** (a passphrase
  is enforced by the SRT handshake — the authenticated push; RTMP stream keys are
  only obscurity), or raw **MPEG-TS over UDP**. Ports are unique per channel,
  auto-allocated from `INGEST_PORT_BASE`–`INGEST_PORT_MAX` (5000–5999) when omitted.
  Set `PUBLIC_HOST` in `broadcaster/.env` so the dashboard's copy-paste **push URL**
  carries your real hostname, **open the listen port in the firewall** (below), and
  point your encoder at the URL on the channel card. An idle push channel shows
  **WAITING FOR PUBLISHER** — that's normal; it flips **ON AIR** when the encoder
  connects. In OBS set the keyframe interval to `HLS_TIME` seconds (2 by default),
  especially with `copy`.

Per-channel **transcode** (Edit dialog): `copy` passthrough (cheapest), `libx264`,
or GPU encoders (`h264_nvenc`/`h264_qsv`/`h264_vaapi`/`h264_amf`) — unusable ones are
disabled with the probe error shown; there is no silent fallback. **GPU encoders
need vendor drivers on the host and, under Docker, GPU device passthrough that the
stock compose file does not wire up** — today that effectively means the bare-metal
path (section B); a dedicated GPU transcode pack is planned (Roadmap). When a source
misbehaves, the channel card's **Logs** dialog shows the live ffmpeg stderr ring —
the last line is usually the diagnosis.

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
| Push ingest (RTMP = TCP; SRT/UDP-TS = UDP) | inbound | the channel's listen port, restricted: `ufw allow from <encoder-ip> to any port <port>` |

`RELAY_ONLY=1` on the panel hides the origin IP behind DHT relays (slower, more
private).

## Sizing

Verified on a 1 vCPU / 1 GB VPS: two concurrent **copy** (passthrough) channels run at ~1.6%
CPU each in a 165 MB container. What sets the ceiling depends on the encoder:

- **`copy` channels (pull + re-mux, the common case):** **RAM-bound**, ~40 MB/channel — a 1 GB
  box does ~14, a 4 GB box ~60. CPU is negligible.
- **Transcoding channels (libx264 etc.):** **CPU-bound** — budget ~0.5–1 core per SD channel
  (a test-pattern source *encodes*, so "~two per vCPU" applies to those, not to `copy`).

On boxes with ≤2 GB RAM, add swap and lower the login KDF memory in `panel/.env` —
`ARGON2_MEM_KIB=65536` (64 MiB per login instead of the 256 MiB default; the parameters are
stored per user record, so changing them later only affects new enrollments/password rotations).

**Running many channels, or on a Pi / SD-card host?** The wall becomes **disk IOPS**, not space
— enable the scale profile (`HLS_WORK_DIR` on tmpfs + `FEED_BUFFER=ram`) and see
[Scaling & capacity planning](kb/scaling.md) for the per-channel numbers, a hardware table, the
`tools/scale-bench.mjs` measurement tool, and the arm64 Raspberry Pi build.

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
