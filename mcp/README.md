# @aliran/mcp — Aliran MCP server

An [MCP](https://modelcontextprotocol.io) **server** that lets an AI client (Claude
Desktop, Claude Code, …) **install, configure, maintain and support** an Aliran
deployment — so a non-server-literate operator never needs a terminal.

It exposes Aliran's existing admin surfaces as MCP **tools** and the shipped docs as
MCP **resources**:

- **`panel_*`** — the panel admin API (`:3210`): viewer accounts, grants, channel
  packages (bouquets), streams, remote sources, categories, publishers,
  status/observability.
- **`broadcaster_*`** — the broadcaster control API (`:3310`): channels
  (create/start/stop/rotate), ffmpeg logs, the capability probe, incidents, health.
- **`server_*`** — an **SSH executor**: `preflight`, `install`, `update`, `status`,
  `logs`, `disk`, `backup`, `sysctl`.
- **`diagnose_*`** — a `/healthz` sweep and a symptom → knowledge-base router.
- **`docs_search`** + the `mcp://aliran/*` resources — the shipped documentation.

> This is the **server** side of MCP. It exposes tools/resources to an AI client; it
> does **not** call the Claude API. Its only runtime dependency is
> `@modelcontextprotocol/sdk` (+ `zod` for tool schemas). Transport is local **stdio**.

## Security model

The **config file is the only place secrets live** — the panel/broadcaster admin
passwords and the path to the SSH private key. The AI model driving this server sees
only tool **results**, never the config. Two rules follow:

- **Secrets move server-side, never through the model.** `server_install` runs
  `admin-cli init` on the box and writes the minted `PUBLISHER_KEY` straight into the
  box's `broadcaster/.env`; only the panel **public** key is returned. Enrolling a
  publisher works the same way.
- **Keep the config `0600`.** It holds credentials; the server warns on startup if it
  is group/other-readable.

## Configure

```bash
cp config.example.json config.json
chmod 600 config.json          # it holds credentials
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

**Reachability.** The panel and broadcaster admin APIs bind loopback on the box. Give
each an explicit `url` (a [Caddy TLS endpoint](../docs/kb/public-dashboards.md)), **or**
omit `url` and this server opens an **SSH local-forward tunnel** to `127.0.0.1:3210` /
`:3310` using the same key — no public dashboard required. `user`/`pass` are the
**dashboard admin** logins (created by `add-admin`, or by `server_install`).

Any of `panel`, `broadcaster`, `ssh` may be omitted; only the tools whose backend is
configured are registered.

## Check your setup (`--doctor`)

The onboarding self-check: validates the config (and its file mode), probes SSH and
the panel/broadcaster `/healthz` (add `--login` to also verify credentials with ONE
real login — the default never spends a login attempt, so a debugging loop cannot
trip the 10-per-15-min lockout), lists the tool groups the AI client will get, and
prints the paste-ready `claude_desktop_config.json` snippet:

```bash
node src/index.js --doctor --config ./config.json
```

Exit codes: `0` all good · `1` a configured backend failed a probe · `2` the config
is unusable. The full walkthrough (with sample output, Claude Desktop wiring per OS,
first prompts, troubleshooting): [docs/mcp-quickstart.md](../docs/mcp-quickstart.md).

## Run

```bash
node src/index.js --config ./config.json      # or set ALIRAN_MCP_CONFIG
```

Claude Desktop (`claude_desktop_config.json`):

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

Run it from a **repo checkout** so the `docs/` corpus (the resources + `docs_search`)
resolves; set `docsDir` in the config to point elsewhere.

## Test

`npm run test:mcp` (from the repo root) boots an in-process panel + broadcaster,
launches this server over a stdio pipe, and drives it as an MCP client — tools,
resources, a write chain, destructive-annotation presence, docs search, the
re-login-on-401 path, and the SSH executor against a command stub. It is in the
required CI lane (deterministic, no DHT).
