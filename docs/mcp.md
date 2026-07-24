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
| **`panel_*`** | panel admin API `:3210` | users, grants, **channel packages** (bouquets), streams, remote sources, categories, publishers, status/observability |
| **`broadcaster_*`** | broadcaster control API `:3310` | channels (create/start/stop/rotate), ffmpeg logs, capability probe, incidents, health |
| **`server_*`** | **SSH executor** | `preflight`, `install`, `update`, `status`, `logs`, `disk`, `backup`, `sysctl` |
| **`diagnose_*`** | the above + KB | `/healthz` sweep, symptom → knowledge-base router |
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
  "ssh":         { "host": "203.0.113.10", "user": "root", "keyPath": "~/.ssh/aliran_deploy", "port": 22 },
  "install":     { "repoDir": "/opt/aliran", "composeProfiles": [] }
}
```

**Reachability.** The panel and broadcaster admin APIs
[bind loopback on the box](operator-guide.md).
Give each an explicit `url` (a [Caddy TLS endpoint](kb/public-dashboards.md)), **or**
omit `url` and the MCP opens an **SSH local-forward tunnel** to `127.0.0.1:3210` /
`:3310` with the same key — no public dashboard needed. `user`/`pass` are the
**dashboard admin** logins (created by `add-admin`, or by `server_install`, and reused
as the credentials `server_install` provisions).

Any of `panel`, `broadcaster`, `ssh` may be omitted; only the tools whose backend is
configured are registered.

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

## Scope (v1)

Panel admin + broadcaster control + install/maintain + docs. The reseller, VOD library
and repeater services are **not** wrapped in v1. Remote (HTTP) transport is not offered
— local stdio only.
