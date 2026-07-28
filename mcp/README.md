# @aliran/mcp — Aliran MCP server

An [MCP](https://modelcontextprotocol.io) **server** that lets an AI client
(Claude Desktop, Claude Code, …) **install, configure, maintain, and support**
an Aliran deployment — so a non-server-literate operator never needs a terminal.

It exposes Aliran's existing admin surfaces as MCP **tools** and the shipped docs
as MCP **resources**:

- **`panel_*`** — the panel admin API (`:3210`): viewer accounts, grants, channel
  packages (bouquets), streams, stream art (uploaded from the operator's disk —
  never base64 through the model), remote sources incl. per-channel exclusion,
  categories (presentation + catalog-wide rename/merge), publishers,
  status/observability, aggregate-only analytics, viewer problem reports +
  correlation alerts (reporters are pseudonyms; report text is viewer-typed,
  untrusted content), dashboard admins, and the external VOD provider config —
  the switch plus the coordinates the viewer apps call the provider with
  directly (no viewer credential is stored panel-side for it).
- **`broadcaster_*`** — the broadcaster control API (`:3310`): channels
  (create/start/stop/rotate), ffmpeg logs, the capability probe, incidents,
  health, aggregate-only analytics, control admins.
- **`reseller_*`** *(optional)* — the reseller control API (`:3330`): the
  operator's oversight jobs — principals (enroll/limits/suspend), credit mints
  (the result echoes the ledger line), ledger audit, accounts/trials views,
  sweep status. Reseller daily driving (activate/renew) deliberately stays in
  the resellers' own panel.
- **`library_*`** *(optional)* — the VOD library control API (`:3320`): titles
  list/get/add (one-shot ingest from a path ON the library box), operational
  patches, re-ingest, ffmpeg logs, delete (the panel record only gets marked
  unavailable — purging it is a panel job).
- **`server_*`** — an **SSH executor**: `preflight`, `install`, `update` (with a
  `dryRun` preview of what would deploy), `status`, `logs`, `disk`, `set_env`
  (env knobs, validated in-image via `config.js --check` and **reverted** on
  failure before anything restarts), `restart`, `backup`, `list_backups`,
  `restore` (refuses a non-empty volume without `force`), `sysctl`.
  **Multi-host:** name extra boxes (repeaters, scale-out broadcasters) in
  `ssh.hosts`, and every tool takes `host:"<name>"` — `panel_add_publisher
  {host}` writes the minted site key into the RIGHT box's
  `broadcaster/.env`.
- **`repeater_status`** — SSH-shaped status for a repeater appliance (the
  repeater has NO admin API by design): compose state, logs, and the opt-in
  loopback `/metrics` when the box enables `STATUS_PORT` — honestly reported
  when it doesn't.
- **`diagnose_*`** — a `/healthz` sweep and a symptom → knowledge-base router.
- **`docs_search`** + the `mcp://aliran/*` resources — the shipped documentation.
- **6 MCP prompts** — guided runbooks (`new-site-install`, `onboard-a-reseller`,
  `migrate-a-channel-source`, `monthly-maintenance`, `incident-triage`,
  `expose-dashboards`) naming the exact tools per step.

There are **109 tools** in total (only the configured groups register).

> This is the **server** side of MCP. It exposes tools/resources to an AI client;
> it does **not** call the Claude API. Its only runtime dependency is
> `@modelcontextprotocol/sdk` (+ `zod` for tool schemas). Transport is local
> **stdio**.

## Security model

The **config file is the only place secrets live** — the panel/broadcaster admin
passwords and the path to the SSH private key. The AI model driving this server
sees only tool **results**, never the config. Two rules follow:

- **Secrets move server-side, never through the model.** `server_install` runs
  `admin-cli init` on the box and writes the minted `PUBLISHER_KEY` straight into
  the box's `broadcaster/.env`; only the panel **public** key comes back.
  Enrolling a publisher works the same way.
- **Keep the config `0600`.** It holds credentials, and the server warns on
  startup if it is group- or other-readable.

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
  "reseller":    { "user": "root-admin", "pass": "…" },   // optional — no url → tunneled to :3330
  "library":     { "user": "admin", "pass": "…" },        // optional — no url → tunneled to :3320
  "ssh":         { "host": "203.0.113.10", "user": "root", "keyPath": "~/.ssh/aliran_deploy", "port": 22 },
  "install":     { "repoDir": "/opt/aliran", "composeProfiles": [] }
}
```

**Reachability.** Every service API binds loopback on the box. Give each an
explicit `url` (a [Caddy TLS endpoint](../docs/kb/public-dashboards.md)), **or**
omit `url` and this server opens an **SSH local-forward tunnel** to its loopback
port (`:3210` panel / `:3310` broadcaster / `:3330` reseller / `:3320` library)
using the same key — no public dashboard required. `user`/`pass` are the
**dashboard admin** logins (created by `add-admin`, or by `server_install`); the
reseller login should be the **root admin principal**.

You can omit any of `panel`, `broadcaster`, `reseller`, `library`, `ssh` — only
the tools whose backend is configured get registered.

**Multi-host.** More than one box? Grow `ssh` with named hosts —
`"hosts": { "edge-1": { "host": "…", "user": "root", "keyPath": "…", "repoDir": "/opt/aliran" } }`
— and pass `host:"edge-1"` on any `server_*` tool / `repeater_status` /
`panel_add_publisher` (omitted = the default box; a single-host config is
unchanged). Per-entry `keyPath`/`port`/`repoDir` are optional; a hosts-only
shape takes `"default": "<name>"`. The doctor probes every named host.

## Check your setup (`--doctor`)

This is the onboarding self-check. It validates the config (and its file mode),
probes SSH and the panel/broadcaster `/healthz` (add `--login` to also verify
credentials with ONE real login — the default never spends a login attempt, so
a debugging loop cannot trip the 10-per-15-min lockout), lists the tool groups
the AI client will get, and prints the paste-ready
`claude_desktop_config.json` snippet:

```bash
node src/index.js --doctor --config ./config.json
```

Exit codes: `0` all good · `1` a configured backend failed a probe · `2` the
config is unusable. For the full walkthrough — sample output, Claude Desktop
wiring per OS, first prompts, troubleshooting — see
[docs/mcp-quickstart.md](../docs/mcp-quickstart.md).

## Run

```bash
node src/index.js --config ./config.json      # or set ALIRAN_MCP_CONFIG
```

**Any MCP client works** — the server is client-agnostic. Here is the
`mcpServers` JSON shape (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI):

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

Codex CLI takes the same two facts in `~/.codex/config.toml`
(`[mcp_servers.aliran]`), VS Code agent mode uses `.vscode/mcp.json`, and Claude
Code / Codex support one-liners via `claude mcp add` / `codex mcp add`.
`--doctor` prints every snippet with your absolute paths filled in, and
[docs/mcp-quickstart.md](../docs/mcp-quickstart.md) has the per-client
walkthrough.
⚠ Destructive-tool confirmations (`destructiveHint`) are advisory per the MCP
spec — verify your client prompts before purge/stop/update tools.

Run it from a **repo checkout**, or straight from
**[npm](https://www.npmjs.com/package/@aliran/mcp)** with no checkout needed:
`npx @aliran/mcp --config <path>`, or
`command: "npx", args: ["-y", "@aliran/mcp", "--config", …]` in the client
config. `npm pack` / `npm publish` bundle the docs corpus into `docs-bundle/`
(the `prepack` script), and the server falls back to it exactly when a repo
checkout's live `docs/` is absent. Set `docsDir` in the config to override the
docs location either way.

## Test

`npm run test:mcp` (from the repo root) boots an in-process panel + broadcaster,
a REAL reseller service pointed at that panel, and a library control server
(fake TitleManager — call shapes, no transcode), launches this server over a
stdio pipe, and drives it as an MCP client — tools, resources, a write chain,
destructive-annotation presence, docs search, the re-login-on-401 path, the SSH
executor against a command stub (which runs the REAL `config.js --check` for
the `server_set_env` validate-then-revert path, and covers the
`server_restore` refusal), category/source/art curation, the reseller
oversight set (the credit mint asserted against the real ledger), and the
library title lifecycle. On top of that: a SECOND fake box through the same stub
(multi-host routing, per-host repoDir, the publisher key landing on the named
box), `repeater_status` in all three status-server states, the list filters +
grant-summary compaction, hls bounds + the feedKey/`key` redaction, the prompt
runbooks with a tool-name drift guard, `server_update {dryRun}`, and an
`npm pack` probe that runs the doctor from the unpacked tarball (docs resolving
from `docs-bundle/`). The suite also covers the reports surface against a REAL reports
store + notifier stub (filters, `sinceHours`, event-ring compaction,
ack/resolve, alerts, `test_notify`), the `REPORTS_*` allowlist/refusal split,
and a category-enum drift guard against `panel/src/reports.js`. It runs in the
required CI lane (deterministic, no DHT).
