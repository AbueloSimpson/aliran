# Aliran

**Self-hostable, open-source, peer-to-peer OTT streaming.** Run your own live TV
service on hardware you control. Viewers re-seed each other, so there are no central
media servers and bandwidth cost stays near zero as your audience grows.

Built on the [Holepunch/Pear](https://pears.com) stack. Pre-1.0 and actively
developed — and running in production on real infrastructure.

---

## Start here

<div class="grid cards" markdown>

- 💻 **[Quickstart — terminal](quickstart-terminal.md)**

    From nothing to a live channel in 15 minutes with Docker Compose.

- 🤖 **[Quickstart — AI assistant](mcp-quickstart.md)**

    The same result, driven by an AI client through the MCP server.

- 📺 **[I just want to watch](android-viewer-guide.md)**

    Someone gave you a key and a login. Install an app and connect.

- 💡 **[How does this work?](concepts.md)**

    P2P streaming explained — what replaces the CDN, and what that costs you.

</div>

---

## Pick your path

### I'm an operator — I want to run a service

The core journey, roughly in order:

1. **[Quickstart — terminal](quickstart-terminal.md)** or
   **[Quickstart — AI assistant](mcp-quickstart.md)** — get something live.
2. **[Operator guide](operator-guide.md)** — the real deployment: firewall rules,
   host tuning, sizing, backups, HA.
3. **[Content management](content-management.md)** — catalog, metadata, artwork,
   redirect channels, program guide.
4. **[User management](user-management.md)** — accounts, passwords, devices,
   sessions, channel packages.
5. **[Configuration](configuration.md)** — every environment variable, per service.
6. **[Security model](security-model.md)** — what's protected, what isn't, and the
   deliberate no-DRM stance. **Read this before you sell access.**

Optional services you can add later:

| Service | What it's for |
|---|---|
| [Repeater appliance](repeater.md) | A keyless regional super-peer that absorbs viewer load |
| [VOD library](vod-library.md) | On-demand titles alongside your live channels |
| [Reseller panel](reseller-panel.md) | A role hierarchy + credit ledger so resellers manage their own customers |
| [MCP server](mcp.md) | Operate the whole deployment through an AI assistant |
| [Analytics](analytics.md) | Aggregate-only usage counts — no per-viewer tracking, by design |

### I'm building or branding the apps

- **[Operator build walkthrough](operator-build-walkthrough.md)** — end to end: your
  key and branding → a custom APK and Windows executable
- **[White-label branding](white-label.md)** — names, colours, logos, splash
- **[Client build](client-build.md)** — build the Android phone + TV app
- **[Desktop player](desktop-player.md)** — the Electron player for Windows and macOS

### I'm integrating the player SDK

- **[Player SDK](sdk.md)** — what it does and how it fits
- **[SDK installation & configuration](sdk-guide.md)** — get it into your app
- **[Kotlin SDK walkthrough](kotlin-sdk-walkthrough.md)** — native Android
- **[Operator APIs & the SDK](ops-sdk-integration.md)** — wire your own billing or
  provisioning to the panel

### I'm a viewer

- **[Android viewer guide](android-viewer-guide.md)** — phone and Android TV
- **[Desktop viewer guide](desktop-viewer-guide.md)** — Windows and macOS

---

## When something breaks

- **[FAQ & troubleshooting](faq.md)** — the common ones, answered
- **[Knowledge base](kb/index.md)** — field-tested symptom → cause → fix entries
  from real deployments
- **[Reference](reference.md)** — admin CLI, HTTP APIs, RPC, schemas, MCP tool
  catalog

---

## Contributing & project artifacts

- **[Developer tour](getting-started.md)** — run the stack locally from the npm
  workspaces, without Docker
- **[Architecture](architecture.md)** — the five components, data flows, sequence
  diagrams
- **[Legal & compliance](legal-compliance.md)** — content rights, licensing,
  regional rules
- **[Roadmap](https://github.com/AbueloSimpson/aliran/blob/main/ROADMAP.md)** —
  what's done, what's next
- **[Changelog](https://github.com/AbueloSimpson/aliran/blob/main/CHANGELOG.md)** —
  the shipped-feature summary
- **[Development log](devlog.md)** — the full chronological build history, including
  how each piece was verified
- **[Architecture decision records](adr/0001-record-architecture-decisions.md)** —
  why things are the way they are

!!! warning "Content rights are your responsibility"
    Aliran is neutral infrastructure and ships no content. Operating a service means
    holding the rights to everything you distribute. See
    [Legal & compliance](legal-compliance.md).
