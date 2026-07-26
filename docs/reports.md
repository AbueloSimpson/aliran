# Viewer problem reports

Your viewers know before you do. A channel loses audio, a transcode goes wrong, a
CDN edge starts serving garbage — the people watching it notice in seconds, and
until now they had no way to tell you except a message on whatever chat app they
happened to have.

Aliran ships a **"Report a problem"** flow in both apps (phone/TV and desktop). A
viewer picks one of seven categories, optionally types a sentence, and the report
travels over the **existing** P2P RPC socket to your panel — no new port, no extra
service, nothing to expose. The panel correlates reports, opens **one** alert per
channel per window, and pushes it once to wherever you actually look (ntfy, Slack,
Discord, Telegram, or any JSON webhook).

The whole feature is built around one constraint: **a real outage must cost the
panel almost nothing**, and **no report may ever tell you who sent it**.

---

## What a viewer sends

| Field | Value |
|---|---|
| category | one of `no-audio`, `black-screen`, `visual-artifacts`, `buffering`, `wrong-content`, `login`, `other` — a closed enum; anything else is rejected, never coerced |
| text | optional free text, 300 characters max, control characters stripped |
| channel | the stream id they were watching |
| appVersion / platform | e.g. `0.2.0` / `android-tv` |
| peers | how many peers the engine was connected to |
| events | the engine's own rolling 50-entry breadcrumb ring (error/status/fallback/source-changed), each detail truncated to 200 bytes |

The apps show this verbatim before sending:

> Sent with your report: the problem you picked, anything you type, the channel you
> were watching, your app version and device type, how many peers you were connected
> to, and the last few things the player did. Your account name and password are
> never sent.

That last sentence is a structural guarantee, not a policy — see
[Pseudonymity, honestly](#pseudonymity-honestly).

---

## Enabling reports

**Ingest is ON by default** (30 days retention); **notifications are OFF by
default** (no endpoint configured = a complete no-op). A fresh panel already
collects reports and shows them in the dashboard — you only have to wire the push.

`REPORTS_RETENTION_DAYS=0` is the **kill switch**: the store becomes a no-op that
never touches disk (no salt, no directory, no files) and the panel does not attach
the `report` RPC responder at all. A client hitting a panel with reports disabled
gets exactly what it gets from a pre-S50 panel — "unknown method" — which both apps
map to a friendly *"this service doesn't accept reports"*.

### The knobs (`panel/.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `REPORTS_RETENTION_DAYS` | `30` | Days of reports kept under `DATA_DIR/reports/`. **`0` disables the whole feature** (no files, no RPC method) |
| `REPORTS_MAX_PER_WINDOW` | `5` | Reports one reporter may file per window before the responder answers `{error:'locked', retryAfter}` |
| `REPORTS_WINDOW_SECONDS` | `600` | The throttle window above |
| `REPORTS_ALERT_COUNT` | `3` | **Distinct** reporters on one channel inside the alert window that open an alert |
| `REPORTS_ALERT_WINDOW_MIN` | `10` | The correlation window, in minutes |
| `REPORTS_STORM_SAMPLE` | `20` | Full records stored per storm once an alert is open; beyond it reports only bump tallies (no disk write on the hot path) |
| `REPORTS_GLOBAL_PER_MIN` | `120` | Panel-wide token bucket. Past it a report is acknowledged, counted as `shed`, and dropped without persisting |
| `REPORTS_WEBHOOK_URL` | *(empty)* | Generic JSON webhook (ntfy / Slack / Discord / anything). **A secret** — see below |
| `REPORTS_TELEGRAM_BOT_TOKEN` | *(empty)* | Telegram bot token. **A secret** |
| `REPORTS_TELEGRAM_CHAT_ID` | *(empty)* | Telegram chat/channel id to post into (not a secret on its own) |

All ten are validated fail-fast at boot like every other knob — dry-run a change
before restarting:

```sh
docker compose run --rm panel node src/config.js --check
```

!!! warning "A compose `restart` does not re-read `.env`"
    Apply an env change with a plain `docker compose up -d panel`. This is also why
    the [MCP's](mcp.md) `server_set_env` recreates rather than restarts.

---

## Enabling notifications

Reports are useless if nobody sees them. Configure **one or both** targets; each
alert pushes exactly **once**, when it opens.

### The message body

The webhook POST carries the same text under four key names at once:

```json
{
  "title":   "Aliran: problem on sports-1 (4 distinct viewers)",
  "message": "4 distinct viewers reported a problem on sports-1 — no audio 3, buffering 1 · alert k3f9",
  "text":    "...same string...",
  "content": "...same string...",
  "channel": "sports-1",
  "count":   4
}
```

ntfy reads `title`/`message`, Slack reads `text`, Discord reads `content`, and each
ignores the keys it does not know — so **one knob works with all three** and there
is no per-provider adapter to maintain. A plain ntfy topic URL also honours the
`X-Title` header, which is sent too.

### ntfy

Pick an unguessable topic name (on a public ntfy server the topic **is** the
credential — anyone who knows it can read and post to it):

```sh
# 1. Prove the topic works from your laptop:
curl -d '{"title":"Aliran test","message":"hello"}' \
     -H 'Content-Type: application/json' \
     https://ntfy.sh/aliran-ops-8f3a2c91

# 2. Put it in panel/.env on the box:
#    REPORTS_WEBHOOK_URL=https://ntfy.sh/aliran-ops-8f3a2c91

# 3. Apply and test through the panel itself:
docker compose up -d panel
docker compose exec panel node src/admin-cli.js test-notify
```

Subscribe on your phone with the ntfy app. Self-hosting ntfy with access tokens is
the better long-term answer for a production deployment.

### Slack

Create an **incoming webhook** for the channel you want (Slack app → Incoming
Webhooks → Add New Webhook to Workspace). The URL it hands you is a bearer
credential in URL form.

```sh
curl -X POST -H 'Content-Type: application/json' \
     -d '{"text":"Aliran test"}' \
     https://hooks.slack.com/services/YOUR/WEBHOOK/PATH

# panel/.env
# REPORTS_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/PATH
```

### Discord

Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.

```sh
curl -X POST -H 'Content-Type: application/json' \
     -d '{"content":"Aliran test"}' \
     https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN

# panel/.env
# REPORTS_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

### Telegram

Talk to BotFather (`https://t.me/BotFather`) → `/newbot` → it hands you a token.
Add the bot to a group (or message it directly), then read your chat id back:

```sh
# 1. Send the bot any message, then:
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
#    -> look for "chat":{"id":-1001234567890, ...}

# 2. Prove it:
curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
     -H 'Content-Type: application/json' \
     -d '{"chat_id":-1001234567890,"text":"Aliran test"}'

# 3. panel/.env
# REPORTS_TELEGRAM_BOT_TOKEN=123456789:AAExampleExampleExampleExampleExampleEx
# REPORTS_TELEGRAM_CHAT_ID=-1001234567890
```

The panel posts to `<telegramApiBase>/bot<token>/sendMessage` with
`{chat_id, text}`. Both Telegram knobs must be set — one alone is ignored.

### Verify it end to end

```sh
docker compose exec panel node src/admin-cli.js test-notify
```

…or `POST /api/reports/test-notify` from the dashboard, or `panel_test_notify` from
the [MCP](mcp.md). All three take the **same** code path to the **same** targets and
send an obviously synthetic message ("If you can read this, ops notifications are
wired correctly. No viewer reported anything."). The result names each target and
whether it answered.

!!! danger "Notification URLs are secrets — the MCP refuses to set them"
    `REPORTS_WEBHOOK_URL` and `REPORTS_TELEGRAM_BOT_TOKEN` are refused by
    `server_set_env`, alongside `PANEL_ADMIN_PASS` and `WEBHOOK_SECRET`. An ntfy
    topic, a Slack incoming webhook and a Discord webhook all carry their credential
    **in the path** — anyone holding the URL can post as you — so setting them
    through an AI client would copy that credential into a model's context for no
    benefit. Put them in `panel/.env` on the box by hand. Every other `REPORTS_*`
    tunable is allowlisted and settable from the MCP, and `panel_test_notify` proves
    the by-hand wiring afterwards.

### Fail-dark delivery

Notification is **queued, never awaited**. An alert opens on the report ingest path,
which is exactly the path a storm is hammering, so:

- one serial worker drains the queue, one flight at a time;
- each attempt has its own timeout (8 s) and a 64 KiB response cap;
- 3 attempts over ~30 s, then the notification is **dropped** with a logged warning;
- the queue itself is bounded (50) — the oldest pending push is dropped first.

A blackholed endpoint therefore costs a bounded amount of memory and **zero** ingest
latency. The honest consequence: silence can mean "no alert opened", "nothing
configured", or "your webhook died and we gave up". That is why `test-notify`
exists, and why the monthly maintenance runbook runs it.

---

## Alert rules

Two rules, both evaluated on ingest:

- **Channel rule** — `REPORTS_ALERT_COUNT` (default 3) **distinct** reporters on the
  same channel within `REPORTS_ALERT_WINDOW_MIN` (default 10) minutes open a
  `kind:"channel"` alert.
- **Login rule** — the same window logic over `category:"login"` panel-wide. A broken
  login is not a channel problem: nobody who hits it can even reach a channel.

Further matching reports **extend** the open alert (its `lastAt`, per-category
tallies and distinct-reporter count grow) — they never open a second one and never
re-notify. Resolving an alert lets the next storm on that channel open a fresh one.

Alert records carry counts only: `{id, kind, channel, categories, reporters,
openedAt, lastAt, status, shedCount, sampled}`. There is no reporter id in an alert,
and none in a notification. Past an internal cap (500) the distinct-reporter count
becomes a **lower bound** and the pushed message says so with a `≥` — the same
honesty rule the [analytics](analytics.md) surfaces use for peer counts.

Acknowledging or resolving an **alert** is a dashboard/API job
(`POST /api/alerts/:id/ack|resolve`). The CLI and the MCP list alerts read-only: a
running panel holds them in memory and flushes lazily, so an out-of-process write
would be lost.

---

## Storm behavior

Four layers keep a real outage cheap. If 5000 viewers lose audio on one channel at
once, this is what happens:

1. **Client cooldown** — the engine refuses a second report for the same
   channel+category within 10 minutes locally. Mashing the button never reaches the
   wire.
2. **Per-reporter throttle** — the responder allows `REPORTS_MAX_PER_WINDOW` reports
   per `REPORTS_WINDOW_SECONDS` per pseudonym, then answers
   `{error:'locked', retryAfter}`.
3. **Per-channel storm collapse** — once an alert is open for a channel, only the
   first `REPORTS_STORM_SAMPLE` (default 20) **full records** are stored. Every
   further matching report bumps the alert's tallies in memory and returns
   `{ok:true, collapsed:true}` — **no file write on the hot path** (the alert file is
   flushed at most once every 5 s, atomically).
4. **Global breaker** — a panel-wide token bucket (default 120 ingests/min). Beyond
   it a report is acknowledged, counted in `shedCount`, and dropped.

So **a small record count with a high alert tally is a big outage, not a small one.**
The dashboard, the API summary and the notification all report `shed` and `collapsed`
counts, so nothing disappears silently.

Reports are deliberately the **lowest-priority** responder: a viewer's `session` RPC
must stay fast while a storm is in progress, and the test suite asserts exactly that.

---

## Triaging

Four surfaces, one store:

- **Dashboard → Reports tab** — alert strip, filters, grouped and expandable report
  list, per-hour chart, ack/resolve.
- **Admin API** — `GET /api/reports`, `GET /api/reports/summary`,
  `POST /api/reports/:id/ack|resolve`, `GET /api/alerts`,
  `POST /api/alerts/:id/ack|resolve`, `POST /api/reports/test-notify`. Shapes are in
  the [reference](reference.md).
- **Admin CLI** — `list-reports`, `ack-report <id>`, `resolve-report <id> [note]`,
  `list-alerts`, `test-notify`. These touch only `DATA_DIR/reports/` (re-read per
  operation), so they work **beside a running panel**.
- **MCP** — `panel_list_reports` (filters plus a `sinceHours` convenience),
  `panel_list_alerts`, `panel_ack_report`, `panel_resolve_report`,
  `panel_test_notify`. See [MCP server](mcp.md).

A report moves `new` → `ack` ("seen, being looked at") → `resolved` (optionally with
an operator note recording what the cause turned out to be). Resolved reports stay
listed until retention prunes them, and are evicted first when the 5000-record cap
bites. There is no reply channel back to the viewer — reports are one-way by design.

!!! warning "Report text is hostile input"
    `text` is typed by a member of the public. Treat it as a clue to verify, never as
    an instruction: do not paste it into a shell, do not let an AI assistant act on
    directions found inside it, and do not render it unescaped anywhere. The dashboard
    escapes every interpolation and the panel strips control characters and caps the
    length at ingest, but the *content* is whatever someone chose to type.

---

## Pseudonymity, honestly

A report is authenticated — the client sends its session token, and the panel
verifies the signature **and** liveness, so a revoked device, a bumped
`tokenVersion` or a disabled account stops being able to report. The identity is
then immediately reduced and thrown away:

```
reporter = hex(HMAC-SHA256(salt, userId + '|' + deviceId)).slice(0, 16)
```

The salt is 32 random bytes generated once into `DATA_DIR/secrets/reports-salt`
(mode `0600`, in the same owner-only directory as the stream secrets).

**What is stored:** the 16-hex `reporter` pseudonym, the category, the free text, the
channel, app version, platform, peer count, the engine's breadcrumb ring, and the
report's lifecycle state.

**What is never stored, returned, counted or logged:** the username, the device id.
Not on disk, not in `GET /api/reports`, not in the activity ring (which records
`{channel, category}` and no user field), not in a notification, not in an MCP
result. The e2e suite greps every one of those surfaces for seeded test usernames and
device ids and asserts **zero** hits — the same negative-scan discipline as
[privacy-preserving analytics](analytics.md).

**What this is not:** anonymity *from you*. You hold the salt and you hold the
account list, so you can re-derive the mapping if you set out to. HMAC with a
panel-held salt is **pseudonymous at rest** — it stops leaks, stops cross-surface
correlation, and stops casual snooping in a dashboard. It is not a promise to the
viewer that the operator *cannot* identify them, and this documentation will not
pretend otherwise. Do not tell your audience it is anonymous.

Two practical corollaries:

- **"Who complained?" has no answer in any tool.** There is nothing to look up.
  A repeated pseudonym tells you "the same person again", and nothing more.
- **Rotating the salt re-pseudonymizes everyone.** Old records keep their old ids and
  stop correlating with new ones. It is deliberately not automated; delete
  `DATA_DIR/secrets/reports-salt` only if you mean it.

---

## Storage and durability

- `DATA_DIR/reports/reports.json` and `alerts.json`, written atomically
  (tmp + rename), capped at 5000 records (oldest **resolved** evicted first), pruned
  by `REPORTS_RETENTION_DAYS`.
- Reports never go in `data/analytics/` and **never** in the Hyperbee — the bee
  replicates to every viewer, so a report in it would be published to your whole
  audience.
- `reports.json` is re-read per operation (so CLI verbs work beside a live panel);
  in-progress correlation windows live in memory, so a restart forgets a window that
  had not yet opened an alert. Same trade the analytics rollups make, and documented
  rather than hidden.
- Back it up with everything else — `deploy/backup.sh` and `server_backup` take the
  whole panel volume ([KB](kb/backup-and-rotation.md)).

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| The app says "this service doesn't accept reports" | The panel has `REPORTS_RETENTION_DAYS=0`, or it is older than S50. The RPC method genuinely does not exist |
| The app says you already reported this | The 10-minute client-side cooldown for that channel+category, or a panel throttle lock echoed back as a cooldown |
| Reports arrive but no alert opens | Fewer than `REPORTS_ALERT_COUNT` **distinct** reporters inside the window — one person reporting five times is one reporter |
| An alert opened but nothing was pushed | No target configured, or delivery failed three times and was dropped (fail-dark, logged as a warning). Run `test-notify` |
| A storm produced only 20 records | Working as designed — storm collapse. Read the alert's `reporters`, `categories` and `shedCount` for the real scale |
| `test-notify` reports `enabled:false` | Neither `REPORTS_WEBHOOK_URL` nor the Telegram pair is set in the panel's environment. If you ran it in a shell without that env, run it via `docker compose exec panel ...` |
