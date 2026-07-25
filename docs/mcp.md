# MCP server — AI-operable install, config & support

Aliran is self-hostable, but self-hosting assumes a level of server literacy the
target operator often lacks. The **`@aliran/mcp`** package is a
[Model Context Protocol](https://modelcontextprotocol.io) **server** that closes that
gap: point any MCP-capable AI client (Claude Desktop, Claude Code, …) at it and the
operator can **install** Aliran on a fresh box, **configure** it, **maintain** it, and
get **usage help** — without ever opening a terminal.

It works because every Aliran admin operation already rides a clean, authenticated
HTTP API and the deploy path is a documented `docker compose` sequence. The MCP server
is a thin, credentialed adapter over those, plus an SSH executor for the box itself.

!!! tip "First time? Take the walkthrough"
    The **[MCP quickstart](mcp-quickstart.md)** is the hands-on onboarding path:
    clone → config → the built-in **`--doctor`** self-check → Claude Desktop wiring →
    first prompts, with a troubleshooting table and screenshot capture points.

!!! note "It is the *server* side of MCP"
    This exposes tools/resources **to** an AI client; it does **not** call the Claude
    API. Its only dependency is `@modelcontextprotocol/sdk` (+ `zod`). Transport is
    local **stdio** — one entry in the client's config launches it.

## What it exposes

| Group | Backs onto | Examples |
|---|---|---|
| **`panel_*`** | panel admin API `:3210` | users, grants, **channel packages** (bouquets), streams, **stream art** (from the operator's disk), remote sources (incl. per-channel **exclusion**), **categories** (presentation + rename/merge), publishers, status/observability, [analytics](analytics.md), dashboard admins |
| **`broadcaster_*`** | broadcaster control API `:3310` | channels (create/start/stop/rotate), ffmpeg logs, capability probe, incidents, health, [analytics](analytics.md), control admins |
| **`reseller_*`** *(optional)* | reseller control API `:3330` | operator oversight: principals (enroll/limits/suspend), **credit mints** (echoing the ledger line), ledger audit, accounts/trials views, sweep status — see [below](#reseller-library-oversight-optional) |
| **`library_*`** *(optional)* | library control API `:3320` | VOD titles list/get/add (one-shot ingest), operational patches, re-ingest, ingest logs, delete |
| **`server_*`** | **SSH executor** | `preflight`, `install`, `update`, `status`, `logs`, `disk`, `set_env` (validate-then-apply), `restart`, `backup`, `list_backups`, `restore`, `sysctl` |
| **`diagnose_*`** | the above + KB | `/healthz` sweep across every configured service, symptom → knowledge-base router |
| **`docs_search`** + `mcp://aliran/*` resources | the shipped docs | full-text search + every doc as a resource |

Read tools carry the MCP `readOnlyHint` annotation; purges/deletes/revokes/restarts
carry `destructiveHint`, so a well-behaved client confirms before running them. See the
[full tool catalog in the reference](reference.md#mcp-server-tool-catalog).

## The secrets-stay-local guarantee

The **config file is the only place secrets live** — the panel/broadcaster admin
passwords and the path to the SSH private key. The AI model driving the server sees
only tool **results**, never the config. Two consequences:

- **Secrets move server-side, never through the model.** `server_install` runs
  `admin-cli init` on the box and writes the freshly-minted `PUBLISHER_KEY` straight
  into the box's `broadcaster/.env`; only the panel **public** key comes back.
  Enrolling a publisher (`panel_add_publisher`) works the same way.
- **The SSH key is used, not read.** The key at `ssh.keyPath` is handed to the `ssh`
  client by path; the MCP process never reads its bytes.

Keep the config `0600` — the server warns on startup if it is group/other-readable.

## Configure

```bash
cd mcp
cp config.example.json config.json
chmod 600 config.json
$EDITOR config.json
```

```jsonc
{
  "panel":       { "url": "https://panel.example.com", "user": "admin", "pass": "…" },
  "broadcaster": { "url": "https://broadcaster.example.com", "user": "admin", "pass": "…" },
  "reseller":    { "user": "root-admin", "pass": "…" },   // optional — no url → tunneled to :3330
  "library":     { "user": "admin", "pass": "…" },        // optional — no url → tunneled to :3320
  "ssh":         { "host": "203.0.113.10", "user": "root", "keyPath": "~/.ssh/aliran_deploy", "port": 22 },
  "install":     { "repoDir": "/opt/aliran", "composeProfiles": [] }
}
```

**Reachability.** Every service API [binds loopback on the box](operator-guide.md).
Give each an explicit `url` (a [Caddy TLS endpoint](kb/public-dashboards.md)), **or**
omit `url` and the MCP opens an **SSH local-forward tunnel** to its loopback port
(`:3210` panel / `:3310` broadcaster / `:3330` reseller / `:3320` library) with the
same key — no public dashboard needed. `user`/`pass` are the **dashboard admin**
logins (created by `add-admin`, or by `server_install`, and reused as the credentials
`server_install` provisions); the reseller login should be the **root admin
principal** (the operator-oversight identity).

Any of `panel`, `broadcaster`, `reseller`, `library`, `ssh` may be omitted; only the
tools whose backend is configured are registered.

## Run it from your AI client — any MCP client

The server has **no client coupling**: any MCP client that can launch a local stdio
server works — Claude Desktop, Claude Code, **Codex CLI**, Cursor, VS Code (Copilot
agent mode), Windsurf, Cline, Gemini CLI, … They all launch it the same way
(`command: node`, `args: [entry, --config, path]`), each in its own config format.
The Claude Desktop / Cursor / Windsurf / Cline / Gemini shape:

```jsonc
{
  "mcpServers": {
    "aliran": {
      "command": "node",
      "args": ["/path/to/aliran/mcp/src/index.js", "--config", "/path/to/config.json"]
    }
  }
}
```

Per-client wiring (Codex TOML, VS Code `mcp.json`, the `claude mcp add` /
`codex mcp add` one-liners, config-file locations) is in the
[quickstart, Step 4](mcp-quickstart.md) — and `--doctor` prints every snippet with
your absolute paths filled in. One caveat when choosing a client: the
`destructiveHint` confirmations are **advisory** in the MCP spec — verify your
client prompts before destructive tools (Claude clients do; some others ignore
hints). The secrets guarantee is client-independent (enforced server-side).

Run it from a **repo checkout** so the `docs/` corpus (the resources + `docs_search`)
resolves; set `docsDir` in the config to point elsewhere.

## The install happy-path (`server_install`)

`server_install` orchestrates [operator-guide §A](operator-guide.md):

1. `git clone` into `install.repoDir` (idempotent).
2. Copy `panel/.env.example` / `broadcaster/.env.example` to `.env` (never clobbering).
3. `docker compose build`.
4. `admin-cli init` — mints the panel signing/OPRF keys; captures the panel **public**
   key + the `PUBLISHER_KEY`.
5. `add-admin` for the panel **and** the broadcaster (using the config credentials, so
   the `panel_*`/`broadcaster_*` tools can log in afterwards).
6. Write `PANEL_PUBKEY` / `PUBLISHER_KEY` / `ADMIN_ENABLED=1` / `CONTROL_ENABLED=1` /
   `INPUT` into the box `.env` files (the publisher secret stays on the box).
7. `docker compose up -d`, then verify.

It returns the panel **public** key (for client builds) and a redacted summary — never
the publisher secret.

Updating is `server_update`: `git pull` → `COMPOSE_BAKE=false docker compose build` →
plain `docker compose up -d` (never `--force-recreate`, per the
[§3B recipe](kb/operator.md)).

## Tuning, restarts and disaster recovery

The full deployment lifecycle stays inside the MCP:

- **`server_set_env {service, pairs}`** upserts documented env knobs
  (`MAX_DEVICES_DEFAULT`, `HLS_LIST_SIZE`, `ANALYTICS_RETENTION_DAYS`, …) in the
  service's `.env` on the box — **validated before applied**. Both configs
  [fail fast](configuration.md) at boot, so the tool dry-runs the new `.env`
  through `node src/config.js --check` **in the built image** first; on a failure
  the `.env` is **reverted** and the exact problem list comes back, so a typo can
  never leave a service down. On success it applies by recreating that one service
  with plain `docker compose up -d <service>` — a compose `restart` does **not**
  re-read env files. Secret keys (`PUBLISHER_KEY`, `PANEL_PUBKEY`, …) are refused:
  they have dedicated flows that keep them server-side.
- **`server_restart {services?}`** is the plain `docker compose restart` — the
  follow-up `server_sysctl` asks for (swarms re-request their socket buffers on
  boot). It deliberately does **not** apply `.env` changes (see above).
- **`server_backup` / `server_list_backups` / `server_restore`** close the
  disaster-recovery loop over `deploy/backup.sh` + `deploy/restore.sh`: cold
  stop → tar → start one way, verify → stop → **replace** the volume contents →
  start the other. A restore **refuses** a non-empty volume or a name-mismatched
  archive unless forced, and its result states exactly what was overwritten and
  from which archive. See the
  [backup & restore runbook](kb/backup-and-rotation.md).
- **Admin accounts** (`panel_*_admin`, `broadcaster_*_admin`) cover co-operator
  onboarding/offboarding and password rotation (generated passwords are returned
  so you can hand them over). Rotating or removing **the account the MCP itself
  logs in with** requires updating the operator's local mcp config
  (`mcp/config.json`) right afterwards — the tools re-login with the configured
  password.

## Content curation

Beyond stream CRUD, the catalog-presentation jobs the dashboard does are wrapped
too:

- **Categories** — `panel_set_category` owns presentation (label / rail order /
  hidden); `panel_rename_category` and `panel_merge_categories` rewrite the tag
  across every channel record (that is what they are for — membership lives on
  the records); `panel_delete_category` drops **only** the registry entry and
  keeps membership. One honest coupling to know: a package member like
  `category:Movies` is a **string** re-resolved after any move, so renaming
  `Movies` strips that bouquet's holders until the member is updated to the new
  slug — the rename tool's description says so, and
  [`panel_set_package`](reference.md#mcp-server-tool-catalog) is the fix.
- **Source curation** — `panel_source_channels` lists everything a
  [remote source](operator-guide.md) knows about (imported + excluded), and
  `panel_set_source`'s `exclude` field replaces the deselect list. An exclusion
  change resets the source's ETag so the next sync re-pulls the full feed and
  applies it.
- **Stream art** — `panel_set_stream_art {id, kind, path}` reads the image from
  the **operator's machine** (where the MCP server runs) and POSTs the raw bytes
  (≤ 10 MiB; `.png .jpg .jpeg .webp .gif`). Image data never transits the model
  as base64 — the tool result is just the stored asset ref.

## Reseller & library oversight (optional)

Deployments running the [reseller panel](reseller-panel.md) or the VOD library
can add the two config blocks and get their control APIs wrapped:

- **`reseller_*`** covers the **operator's** oversight jobs: enroll principals
  (`reseller_add_principal` — generated passwords returned), tune limits, suspend
  (optionally with the whole customer base, `mode:"with-accounts"`), **mint
  credits** (`reseller_grant_credits` — the result echoes the exact ledger line:
  seq, actor, principal, amount, new balance), audit the ledger, and observe
  accounts, trials and the sweeps. **Reseller daily driving — activating,
  renewing, extending accounts — is deliberately not wrapped:** those are the
  resellers' own jobs, in [their own panel](reseller-panel.md), under their own
  audit trail. Configure the **root admin principal** as the login.
- **`library_*`** covers VOD titles end to end: add (`library_add_title` queues a
  one-shot ingest; `input` is a path **on the library box**, not your machine),
  poll progress, patch the operational fields (`input`/`mode`/`hlsTime` — the
  descriptive metadata is panel-owned after creation), re-ingest, read the ffmpeg
  log ring, delete. A delete purges the library box but only marks the panel
  record `unavailable` — the catalog record and grants are admin-owned, so the
  tool result says exactly that and points at `panel_delete_stream`.

Both services join `diagnose_healthz` and the `--doctor` probes automatically
once configured.

## Scope (v1)

Panel admin + broadcaster control + reseller/library oversight + install/maintain
+ docs. The **repeater** stays unwrapped by design for now — it has no admin API
(healthz/metrics only), so reaching it is multi-host SSH work (planned; its
box-level plumbing — `server_logs` / `server_set_env` / `server_backup` /
`server_restore` — already accepts the `library` / `reseller` service names on
the one configured box). Remote (HTTP) transport is not offered — local stdio
only.
