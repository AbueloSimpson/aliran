# Operator Guide (self-hosting)

Run your own Aliran service. Everything is configuration. You never change code.

**The supported deployment is Docker Compose.** The images pin the two things that
actually break deployments: the ffmpeg build (SRT and encoder availability) and the
Node version. The compose file also pre-solves host networking, data volumes, and
auto-restart. Production and CI exercise this path continuously. A bare-metal +
systemd alternative exists for environments that cannot run Docker, or that need
direct GPU access (section B, advanced — less exercised).

Networking headline: **the P2P layer needs no inbound ports.** Clients find the
panel by its public key over the DHT (outbound UDP hole-punching), and viewers
re-seed each other. A $5 VPS behind a strict firewall works.

## Prerequisites

- A Linux box — Ubuntu 24.04 LTS is what we test on (a cheap VPS or a home machine).
- Docker + Docker Compose plugin (`apt-get install docker.io docker-compose-v2`),
  **or** Node.js 20+ and `ffmpeg` for the bare-metal path.
- (Optional) two DNS A-records pointing at the box, for HTTPS dashboards via Caddy.

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

The compose file uses `network_mode: host` on purpose. Hyperswarm's hole-punching
works without Docker's bridge NAT stacked on the host's. The dashboards keep their
safe `127.0.0.1` binding, and future push-ingest ports need no compose edits. If you
must use a bridge network (for example, rootless Docker), drop `network_mode: host`,
add `ports:` for anything you expose, and expect somewhat slower peer connectivity.

Data lives in the named volumes `panel-data` / `broadcaster-data` (`DATA_DIR=/data`
inside the containers).

## B. Alternative: bare metal + systemd (advanced)

!!! note "Use Docker (section A) unless you have a reason not to"
    This path exists for environments where Docker is unavailable or disallowed,
    and for hosts that need **direct GPU access** for hardware transcode. NVENC,
    VAAPI, and QSV all need vendor drivers on the host; the stock compose file
    does no GPU device passthrough. This is the less-exercised path — the Docker
    route is what production and CI run. A dedicated, separately-packaged
    **GPU transcode pack** (bare metal + NVIDIA driver stack) is planned; see the
    [Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md).
    You also inherit your distro's ffmpeg. Verify protocols and encoders with the
    dashboard's capability probe before you rely on SRT or a GPU encoder.

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

Use the **admin dashboard** (below), or the CLI. The examples show the bare-metal
form; prefix each command with `docker compose run --rm panel` under Docker.

!!! note "Store-writing CLI commands need the panel stopped"
    The dashboard does not have this restriction.

```bash
node src/admin-cli.js create-user alice
node src/admin-cli.js add-stream news --title "News 24" --category news
node src/admin-cli.js upload-art news poster ./art/news-poster.jpg
node src/admin-cli.js grant alice news
```

A **redirect channel** plays an operator CDN/HLS URL directly. It has no broadcaster
and no P2P feed behind it. It takes one field: dashboard → Add stream → "Redirect
URL", or `POST /api/streams {"id":"promo","url":"https://cdn.example.com/promo/index.m3u8"}`.
See [content-management.md](content-management.md).

**Running more than one broadcaster?** Don't share the `init` publisher key across
sites. Enroll each one instead (dashboard → Publishers, or the CLI; this is file-based
and the panel can stay running):

```bash
node src/admin-cli.js add-publisher east --scopes "east-*,sports-1"
```

Put the printed `PUBLISHER_NAME` + `PUBLISHER_KEY` pair in **that site's**
broadcaster `.env` and restart it. The secret is shown once. Each site's key now
only registers the channel ids its scopes match. The catalog shows which site owns
each channel (`origin` chip). Revoking a site — a lost box, a leaked `.env`,
offboarding — is one click instead of re-keying everyone. Once every site is
enrolled, set `LEGACY_PUBLISHER=0` on the panel to retire the shared key. Details:
[security-model.md](security-model.md).

## D. The dashboards (admin + broadcaster control)

Set `ADMIN_ENABLED=1` (panel, port 3210) and `CONTROL_ENABLED=1` (broadcaster,
port 3310). Both bind `127.0.0.1` and speak plain HTTP.

!!! danger "Never expose the dashboards raw"
    Put TLS in front of them (below) before you expose either port beyond loopback.

!!! note "A channel needs one manual Start after the first upgrade to this build"
    A channel you have **started** auto-resumes after a broadcaster restart — its
    desired state is persisted — and a crash **watchdog** keeps its ffmpeg alive
    across source hiccups. Stopping a channel flips its catalog entry to
    `isLive:false`, so viewers stop seeing it as live. The one exception is the
    **first** boot after upgrading to this build: channels created before the
    upgrade have no persisted desired state yet, so press Start once (dashboard or
    API). From then on they resume on their own.

!!! note "Offline slate"
    If a source stays dead past a few retries, the channel loops a
    "SOURCE OFFLINE" slate instead of going blank, and returns to the source
    automatically when it recovers. A slated channel still shows **ON AIR**
    (bars are flowing), so check `slate.slated` in the status API to tell it apart
    from a live source. Configure it via `SLATE_*` ([configuration](configuration.md));
    see [kb/offline-slate.md](kb/offline-slate.md).

- **With a domain:** install Caddy and use
  [deploy/Caddyfile.example](https://github.com/AbueloSimpson/aliran/blob/main/deploy/Caddyfile.example).
  This gives automatic HTTPS, and the plain-HTTP APIs never leave loopback. The full
  walkthrough — credential setup, firewall rules, and verification steps — is at
  **[kb/public-dashboards.md](kb/public-dashboards.md)**.

    !!! warning "Basic auth must exclude `/api/*`"
        If you add `basic_auth`, it **must not cover `/api/*`** — use the
        `@ui not path /api/*` matcher from the example. HTTP has one `Authorization`
        header, and the dashboard needs it for its own Bearer token. Guarding the
        API with basic auth makes the browser re-prompt for a password on every
        single request.

- **Without a domain:** SSH tunnel from your workstation. This needs no server
  changes at all:

  ```bash
  ssh -N -L 3210:127.0.0.1:3210 -L 3310:127.0.0.1:3310 user@your-vps
  ```

  Then browse `http://127.0.0.1:3210` (panel) and `http://127.0.0.1:3310`
  (broadcaster control).

## E. Broadcaster input

Each channel has a typed input. Set it per-channel in the **control dashboard**
(the ingest selector only offers what the host ffmpeg supports) or via `INPUT` in
`broadcaster/.env` for the env channel:

- **Pull**: `test` (built-in pattern), a **file path** (looped), or a **pull URL**
  (`rtsp://`, `http(s)://` HLS, `rtmp://`, `srt://`, `udp://`).
- **Push** (your encoder connects IN): **RTMP** (OBS et al.), **SRT**, or raw
  **MPEG-TS over UDP**. For SRT, a passphrase is enforced by the SRT handshake — this
  is the only one of the three that is an authenticated push; RTMP stream keys give
  only obscurity. Ports are unique per channel, auto-allocated from
  `INGEST_PORT_BASE`–`INGEST_PORT_MAX` (5000–5999) when omitted. Set `PUBLIC_HOST`
  in `broadcaster/.env` so the dashboard's copy-paste **push URL** carries your real
  hostname. **Open the listen port in the firewall** (below), and point your encoder
  at the URL on the channel card. An idle push channel shows **WAITING FOR
  PUBLISHER** — that's normal; it flips to **ON AIR** when the encoder connects. In
  OBS, set the keyframe interval to `HLS_TIME` seconds (2 by default), especially
  with `copy`.

Per-channel **transcode** (Edit dialog): `copy` passthrough (cheapest), `libx264`,
or GPU encoders (`h264_nvenc`/`h264_qsv`/`h264_vaapi`/`h264_amf`). An unusable
encoder is disabled with its probe error shown — there is no silent fallback.

!!! note "GPU encoders need vendor drivers and, under Docker, GPU passthrough"
    The stock compose file does not wire up GPU device passthrough, so today
    this effectively means the bare-metal path (section B). A dedicated GPU
    transcode pack is planned (Roadmap).

When a source misbehaves, the channel card's **Logs** dialog shows the live ffmpeg
stderr ring. The last line is usually the diagnosis.

## F. Point the client at your panel

Build or brand the client with your **panel public key** (build-time config), or
generate a **service-descriptor QR** for runtime pairing. See
[client-build.md](client-build.md). Nothing else is needed — clients reach the
panel through the DHT, not an IP or domain.

## G. The VOD library (optional)

On-demand titles come from the **[library](vod-library.md)** — a separate
service on purpose. Ingest is a one-shot transcode burst (0.5–1 core) plus a static
seed, so it belongs on whatever box has the disk and spare CPU. A production
broadcaster near its CPU ceiling must never absorb a transcode. The library can
share the compose file on a small setup (behind the `vod` profile), or run on
entirely different hardware — it only needs outbound UDP and the panel's public key.

```sh
# 1. Enroll the library as its OWN publisher on the PANEL (never reuse the live key).
#    Title ids must match the scopes. Prints the matching PUBLISHER_KEY once.
docker compose run --rm panel node src/admin-cli.js add-publisher library1 --scopes 'vod-*'

# 2. Configure + start (single-box compose; else copy library/ to its own box)
cp library/.env.example library/.env     # PANEL_PUBKEY + PUBLISHER_NAME/KEY + CONTROL_ENABLED=1
docker compose --profile vod build library
docker compose --profile vod run --rm library node src/library-cli.js add-admin op
docker compose --profile vod up -d library

# 3. Add a title (control UI at 127.0.0.1:3320, or the API). input = a file path
#    on the library box (mount your media into the container) or a URL ffmpeg reads.
#    Compatible codecs (h264/hevc + aac/mp3/ac3) are remuxed with -c copy — no
#    transcode CPU at all; anything else transcodes to h264/aac, one job at a time.

# 4. Grant it like any channel, on the panel:
docker compose run --rm panel node src/admin-cli.js grant alice vod-movie-1
```

The title appears in granted viewers' catalogs as `type:'vod'` with full seek. Disk
use on the library box equals the sum of title sizes — there is no rolling reclaim;
only deleting a title frees the space it used. Sizing: ingest at `-c copy` is
I/O-bound and quick; a transcode runs about 0.5–1 core for roughly the title's
runtime divided by the encode speed. Serving is the same seeder economics as the
repeater (bandwidth, not CPU) — raise `SWARM_SNDBUF_MB` and the host's `wmem_max`
under real fan-out ([network tuning](kb/network-tuning.md)).

## Firewall

| Purpose | Direction | Ports |
|---|---|---|
| P2P (DHT, replication, viewers) | outbound, **plus inbound if you run a firewall** | UDP `32768:60999` — see below |
| Dashboards via Caddy | inbound | 80 + 443 TCP |
| Dashboards via SSH tunnel | inbound | 22 TCP only |
| Push ingest (RTMP = TCP; SRT/UDP-TS = UDP) | inbound | the channel's listen port, restricted: `ufw allow from <encoder-ip> to any port <port>` |

!!! warning "P2P is not \"outbound only\" once a firewall is in front of it"
    A broadcaster binds roughly **two UDP sockets per channel** (about 140 at 69
    channels) to `0.0.0.0` on **random ephemeral ports that change on every
    restart**, so no static per-port rule can name them. A default-deny firewall
    drops unsolicited inbound UDP to all of them. Hole-punched flows mostly
    survive via conntrack, which is why this is easy to miss — but a VPS has a
    public IP and **no NAT**, so peers address it directly, and that first
    inbound packet is the one that gets dropped. The symptom is degraded seeding
    with nothing logged. Allow the ephemeral range (`ufw allow 32768:60999/udp`,
    matching `net.ipv4.ip_local_port_range`) and verify inbound `/proc/net/snmp`
    `Udp:` counters climb in step with outbound. Details:
    [kb/public-dashboards.md](kb/public-dashboards.md).

`RELAY_ONLY=1` on the panel hides the origin IP behind DHT relays. This is slower,
but more private.

## Host network tuning (optional)

**Aliran runs fine without this.** It matters once you put real viewer load on a
box. Before that you will not notice the difference. After that you will notice
it as something that looks like a bug rather than a limit.

**What the problem is.** Hyperswarm's transport is UDX, which carries *every* peer
stream of a swarm over a single pair of UDP sockets. Viewer fan-out concentrates on
one socket instead of spreading across per-viewer connections, and the kernel's
socket buffer is what runs out first. When it does, the kernel **discards the
packets silently** — no error, no log line — and playback just stalls and degrades
as more viewers join.

Aliran already asks the kernel for bigger buffers at startup (2 MiB, or 4 MiB on a
repeater; see `SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB` in
[Configuration](configuration.md)). The catch is that `setsockopt` is **silently
clamped** to `net.core.rmem_max` / `net.core.wmem_max`, which ship at 212992 bytes
(208 KiB) on stock Linux. The request succeeds, and the socket just stays small.

**The optional helper.** [`deploy/sysctl/install.sh`](https://github.com/AbueloSimpson/aliran/tree/main/deploy/sysctl)
raises those ceilings for you. It is a standalone script — nothing in the normal
`docker compose up` / systemd flow calls it, and you can equally do it by hand or
through whatever configuration management you already run:

```bash
sudo deploy/sysctl/install.sh          # copies the drop-in, applies it, verifies it took
docker compose restart                 # services re-request their buffers at startup
```

It installs `/etc/sysctl.d/99-aliran.conf` (8 MiB ceilings), so it is a **one-time**
action per host — `systemd-sysctl` re-applies it on every boot. Re-run it after a
host rebuild or migration, since these are host settings that a fresh image will
not carry over.

**Why it is not automatic.** The services run with `network_mode: host`, and Docker
refuses `sysctls:` for `net.*` there — the container shares the host's network
namespace, so there is nothing separate to set. Doing it from a container would
mean shipping a **privileged** container that writes to host config, which is a
worse trade than one `sudo` you can read first. Bare-metal and systemd installs need
the same thing for the same reason.

**If you skip it**, the services say so at startup, naming the exact sysctl:

```
[net] WARNING: swarm send buffer clamped to 208 KiB — asked for 2 MiB … Fix: sysctl -w
net.core.wmem_max=2097152 — persist it in /etc/sysctl.d/99-aliran.conf
```

Full background, plus the conntrack and file-descriptor limits that matter at the
same scale: [Network tuning KB](kb/network-tuning.md).

## Sizing

Verified on a 1 vCPU / 1 GB VPS: two concurrent **copy** (passthrough) channels run
at about 1.6% CPU each in a 165 MB container. What sets the ceiling depends on the
encoder **and the box shape** — which wall you hit first flips with the
RAM-to-core ratio:

- **`copy` channels (pull + re-mux, the common case):** about 40 MB per channel, and
  **about 0.04 core per channel** with real, flaky sources — the demux, remux,
  HLS-mux, mirror pipeline plus watchdog churn. On a RAM-tight box (a 1 GB VPS holds
  about 14 channels) **RAM is the first wall**. On a core-light, RAM-rich box, CPU
  is the wall instead: a **4 vCPU / 8 GB box runs about 80 copy channels at the
  ≤80% CPU policy**, where RAM alone could hold several times that. So per-channel
  CPU is small but **not negligible at scale** — measured at 90 channels at about
  76% of 4 cores. See [Scaling](kb/scaling.md) for the capacity formula and the
  hardware table.
- **Transcoding channels (libx264, etc.):** **CPU-bound**, far more so. Budget about
  0.5–1 core per SD channel (a test-pattern source *encodes*, so "about two per
  vCPU" applies to those, not to `copy`).

On boxes with 2 GB RAM or less, add swap and lower the login KDF memory in
`panel/.env` — `ARGON2_MEM_KIB=65536` (64 MiB per login instead of the 256 MiB
default). The parameters are stored per user record, so changing them later only
affects new enrollments and password rotations.

**Running many channels, or on a Pi / SD-card host?** The wall becomes **disk
IOPS**, not space. Enable the scale profile (`HLS_WORK_DIR` on tmpfs +
`FEED_BUFFER=ram`) and see [Scaling & capacity planning](kb/scaling.md) for the
per-channel numbers, a hardware table, the `tools/scale-bench.mjs` measurement
tool, and the arm64 Raspberry Pi build.

## Monitoring

Every HTTP surface serves two **unauthenticated** endpoints with one contract:
cheap and synchronous, so they answer as long as the event loop turns, even while
the authenticated API is busy.

- `GET /healthz` — JSON liveness with the service's own vitals: the broadcaster
  reports boot-resume progress ("up, resuming 45/83" vs "dead"), the library its
  title states, the reseller its ledger invariant, the panel its swarm connections.
- `GET /metrics` — Prometheus text exposition: `aliran_up`, uptime, RSS/heap, plus
  per-service gauges (channel counts, title states, principals/accounts, …).

They live on the existing control/admin ports — panel `:3210`, broadcaster `:3310`,
library `:3320`, reseller `:3330` — which bind loopback by default. Scrape them
locally, or expose them deliberately (see [publishing the
dashboards](kb/public-dashboards.md)). The repeater stays **port-free by default**;
setting `STATUS_PORT` gives it the same two endpoints.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: aliran
    static_configs:
      - targets: ['127.0.0.1:3210', '127.0.0.1:3310', '127.0.0.1:3320', '127.0.0.1:3330']
```

Two related knobs are shared by every service: `LOG_FORMAT=json` switches the logs
to one `{ts, level, svc, msg}` JSON object per line for log shippers (the default
output is unchanged), and configuration is **validated at boot** — a typo'd env
var is a startup error naming the exact variable, so a service that exits
immediately after a config change is telling you which line to fix.

### Log growth is bounded (check yours is)

The services log to stdout only — there are no in-app log files, and the in-app
diagnostic rings (ffmpeg log ring, incidents, activity) are fixed-size and
in-memory. What CAN grow forever is whatever captures that stdout:

- **Docker**: the default `json-file` driver has **no size limit** — on a box
  nobody tends, container logs eventually eat the disk. The shipped compose files
  cap every service (`json-file`, `max-size: 20m` × `max-file: 5`, about 100 MB per
  service, rotated by Docker itself). The cap applies when a container is
  **created**, so after pulling the updated compose run `docker compose up -d`
  (this recreates only what changed). If you run your own compose or daemon, set
  the same `logging:` options, or set them globally in `/etc/docker/daemon.json`
  (`log-driver`, `log-opts`).
- **systemd / bare metal**: journald rotates by default (`SystemMaxUse` caps it —
  check `journalctl --disk-usage`). There is nothing to do unless you redirected
  stdout to a file yourself; if you did, put it under `logrotate`.
- `LOG_FORMAT=json` does not change any of this — it changes the line format, not
  where lines go or how much is kept.

## Operations

- **Backups:** the data dirs (keys + cores). `DATA_DIR/keys` and
  `DATA_DIR/secrets` are the critical, unrecoverable parts; losing the OPRF key
  locks everyone out.
- **Updates:** `git pull && docker compose up -d --build` (Compose) or
  `git pull && npm install --omit=dev --workspaces && systemctl restart aliran-panel aliran-broadcaster`.
- **Backups & key rotation:** covered end to end by the
  [backup, restore & key rotation runbooks](kb/backup-and-rotation.md) — what to
  back up (`deploy/backup.sh` does the cold stop→tar→start), the restore procedure
  and its freshness caveat, and the rotation matrix for every credential. The
  panel signing/OPRF keys are *identity*, not rotatable — protect and back them up.
- **Monitoring:** watch panel login RPC, peer counts, lockouts; the dashboards show
  live channel health (ffmpeg, peers, registration). See [Monitoring](#monitoring)
  for `/healthz` + `/metrics`.
- **HA / failover:** a warm standby carrying the latest cold snapshot, with the
  **never-two-writers** discipline — the exact runbook is in
  [backup & rotation](kb/backup-and-rotation.md). Clients find a moved panel by
  its key on the DHT; there is no DNS to flip.
