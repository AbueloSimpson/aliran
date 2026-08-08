# Aliran

**Self-hostable, open-source, peer-to-peer OTT streaming.** Run your own live TV
service on hardware you control. Viewers re-seed each other. There are no central
media servers, so bandwidth cost stays near zero as your audience grows.

Aliran is built on the [Holepunch/Pear](https://pears.com) stack. It is pre-1.0 and
actively developed, and it already runs in production on real infrastructure.

!!! note "About these docs"
    These docs follow the STE (Simplified Technical English) writing rules: one
    instruction per sentence, active voice, present tense, short sentences, and one
    approved term for each concept. This project does not use the full licensed
    ASD-STE100 dictionary or a certified checker. It applies the writing rules by
    hand, plus a project word list, to keep every page consistent.

---

## Start here

<div class="grid cards" markdown>

- 💻 **[Quickstart — terminal](quickstart-terminal.md)**

    Go from nothing to a live channel in 15 minutes with Docker Compose.

- 🤖 **[Quickstart — AI assistant](mcp-quickstart.md)**

    Get the same result. An AI client drives it through the MCP server.

- 📺 **[I just want to watch](android-viewer-guide.md)**

    Someone gave you a key and a login. Install an app and connect.

- 💡 **[How does this work?](concepts.md)**

    Learn how P2P streaming works: what replaces the CDN, and what that costs you.

</div>

---

## Pick your path

### I'm an operator — I want to run a service

Follow the core journey, roughly in this order:

1. **[Quickstart — terminal](quickstart-terminal.md)** or
   **[Quickstart — AI assistant](mcp-quickstart.md)** — get something live.
2. **[Operator guide](operator-guide.md)** — run a real deployment: firewall
   rules, host tuning, sizing, backups, HA.
3. **[Content management](content-management.md)** — manage your catalog,
   metadata, artwork, redirect channels, and program guide.
4. **[User management](user-management.md)** — manage accounts, passwords,
   devices, sessions, and channel packages.
5. **[Configuration](configuration.md)** — find every environment variable, per
   service.
6. **[Security model](security-model.md)** — learn what's protected, what isn't,
   and why Aliran has no DRM. **Read this before you sell access.**

Add these optional services later:

| Service | What it's for |
|---|---|
| [Repeater appliance](repeater.md) | A keyless regional super-peer that absorbs viewer load |
| [VOD library](vod-library.md) | On-demand titles alongside your live channels |
| [Reseller panel](reseller-panel.md) | A role hierarchy and credit ledger so resellers manage their own customers |
| [MCP server](mcp.md) | Operate the whole deployment through an AI assistant |
| [Analytics](analytics.md) | Aggregate-only usage counts — no per-viewer tracking, by design |
| [Viewer problem reports](reports.md) | "Report a problem" from the apps, correlation alerts, ops notifications — pseudonymous by construction |

### I'm building or branding the apps

- **[Operator build walkthrough](operator-build-walkthrough.md)** — go from your
  key and branding to a custom APK and Windows executable
- **[White-label branding](white-label.md)** — set names, colours, logos, splash
- **[Client build](client-build.md)** — build the Android phone and TV app
- **[Desktop player](desktop-player.md)** — the Electron player for Windows and macOS
- **[App updates over P2P](app-updates.md)** — ship APK updates to installed apps, no store needed

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

- **[FAQ & troubleshooting](faq.md)** — the common questions, answered
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
- **[Development log](devlog.md)** — the full chronological build history,
  including how each piece was verified
- **[Architecture decision records](adr/0001-record-architecture-decisions.md)** —
  why things are the way they are

!!! warning "Content rights are your responsibility"
    Aliran is neutral infrastructure and ships no content. If you operate a
    service, you hold the rights to everything you distribute. See
    [Legal & compliance](legal-compliance.md).
