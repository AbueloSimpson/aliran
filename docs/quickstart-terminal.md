# Quickstart — terminal

From nothing to **a running Aliran service with one channel playing**, using
Docker Compose and a terminal. Budget 15 minutes, most of it waiting on the
image build.

Prefer to have an AI assistant do this for you? The
**[AI quickstart](mcp-quickstart.md)** covers the same ground through the MCP
server. Both end in the same place — pick one.

!!! info "What you're building"
    A **panel** (the origin of truth: accounts, entitlements, catalog) and a
    **broadcaster** (pulls a source, packages it, seeds it to viewers over
    P2P). Viewers find the service by its **public key** over the DHT — there
    is no URL to configure and no inbound port to open for playback.

## Before you start

- A Linux box — Ubuntu 24.04 LTS is what we test on. A cheap VPS or a spare
  machine is fine; 2 vCPU / 2 GB is plenty for this walkthrough.
- Docker and the Compose plugin:
  ```bash
  sudo apt-get install -y docker.io docker-compose-v2
  ```
- Nothing else. No domain, no TLS certificate, no open ports.

## Step 1 — Get the code and build

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
cp panel/.env.example panel/.env
cp broadcaster/.env.example broadcaster/.env
docker compose build
```

The build pins the two things that actually break streaming deployments: the
ffmpeg build (SRT and encoder availability) and the Node version.

## Step 2 — Generate the panel's identity

```bash
docker compose run --rm panel node src/admin-cli.js init
```

This prints two keys.

!!! danger "Both keys matter, and this is the only time the publisher key is shown"
    Back up `DATA_DIR/keys` before you go further. The panel signing and OPRF
    keys are your service's **identity**, not rotatable credentials. Lose the
    OPRF key and every viewer account is locked out permanently — there is no
    recovery path. See
    [backup, restore & key rotation](kb/backup-and-rotation.md).

| Key | What it is | Where it goes |
|---|---|---|
| **Panel public key** | Your service's address on the P2P network | Into every viewer app (Connect screen or a branded build) |
| **Publisher key** | Lets a broadcaster register channels with your panel | Into `broadcaster/.env` as `PUBLISHER_KEY` |

## Step 3 — Create your dashboard logins

Two separate services, two separate admin accounts. Passwords must be 8+
characters.

```bash
docker compose run --rm panel node src/admin-cli.js add-admin admin
docker compose run --rm broadcaster node src/control-cli.js add-admin admin
```

## Step 4 — Wire the two services together

Edit `broadcaster/.env` and set the two values from Step 2:

```bash
PANEL_PUBKEY=<the panel public key>
PUBLISHER_KEY=<the publisher key>
CONTROL_ENABLED=1
```

Then edit `panel/.env` and turn its dashboard on:

```bash
ADMIN_ENABLED=1
```

Both dashboards bind to `127.0.0.1` and speak plain HTTP. That is
deliberate — **never expose them raw**; Step 7 covers reaching them safely.

## Step 5 — Start it

```bash
docker compose up -d
docker compose logs -f      # ctrl-C when both report ready
```

Confirm both services are alive:

```bash
curl -s localhost:3210/healthz     # panel
curl -s localhost:3310/healthz     # broadcaster
```

Each returns JSON with `"up": true`. These endpoints are unauthenticated and
cheap — point your uptime monitoring at them.

## Step 6 — Create a viewer and a channel

```bash
# A viewer account
docker compose run --rm panel node src/admin-cli.js create-user alice

# A channel, using the broadcaster's built-in test pattern
docker compose run --rm panel node src/admin-cli.js add-stream demo \
  --title "Demo Channel" --category "General"

# Let alice watch it
docker compose run --rm panel node src/admin-cli.js grant alice demo
```

Entitlements are **sealed keys**, not a permissions flag: granting wraps the
channel's encryption key to that account. Revoking removes it. A viewer
without a grant cannot decrypt the stream even holding the bytes.

## Step 7 — Reach the dashboards

No domain needed — tunnel from your workstation:

```bash
ssh -N -L 3210:127.0.0.1:3210 -L 3310:127.0.0.1:3310 user@your-server
```

Now open **<http://127.0.0.1:3210>** (panel: users, grants, catalog) and
**<http://127.0.0.1:3310>** (broadcaster: channels, ingest, live health) and
sign in with the accounts from Step 3.

Running this permanently with a domain instead? Use
[deploy/Caddyfile.example](https://github.com/AbueloSimpson/aliran/blob/main/deploy/Caddyfile.example)
for automatic HTTPS — the walkthrough is in
[publishing the dashboards](kb/public-dashboards.md).

## Step 8 — Put the channel on air

In the broadcaster dashboard, find your `demo` channel and press **Start**. It
spawns ffmpeg, mints the feed, and registers with the panel. Within a few
seconds the card shows **ON AIR** with a peer count.

A started channel **auto-resumes** after a restart — its desired state is
persisted, and a watchdog keeps ffmpeg alive across source hiccups.

Swap the test pattern for something real by editing the channel's input:

- **Pull** — an HLS/RTSP/RTMP/SRT/UDP URL, or a file path on the box (looped)
- **Push** — an RTMP, SRT, or MPEG-TS listener your encoder connects *to*

See [broadcaster input](operator-guide.md#e-broadcaster-input) for the full
matrix.

## Step 9 — Watch it

Install a viewer from the
[releases page](https://github.com/AbueloSimpson/aliran/releases/latest) —
Windows, macOS, or one Android APK covering phone and TV. On first run each
app shows a **Connect screen**. Enter three things:

1. Your **panel public key** (from Step 2)
2. The username — `alice`
3. Alice's password

The app finds your service over the DHT and `demo` appears in her catalog. No
URL, no port forwarding, no DNS.

## You now have a working service

Where to go next:

| I want to… | Go to |
|---|---|
| Understand what I just built | [Architecture](architecture.md) · [Concepts](concepts.md) |
| Run this properly in production | [Operator guide](operator-guide.md) — firewall, tuning, sizing, HA |
| Know what's protected and what isn't | [Security model](security-model.md) |
| Add real channels in bulk | [Content management](content-management.md) |
| Brand the apps with my own key and logo | [Operator build walkthrough](operator-build-walkthrough.md) |
| Sell access through resellers | [Reseller panel](reseller-panel.md) |
| Hand the ops work to an AI assistant | [AI quickstart](mcp-quickstart.md) |
| Fix something that went wrong | [FAQ & troubleshooting](faq.md) · [Knowledge base](kb/index.md) |

!!! warning "Before you stream anything real"
    You are responsible for having the rights to everything you distribute.
    Aliran is neutral infrastructure and ships no content. See
    [Legal & compliance](legal-compliance.md).
