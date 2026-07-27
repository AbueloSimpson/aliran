# Bare worklet & bundling

This page covers how the client's embedded P2P node (a
[Bare](https://github.com/holepunchto/bare) worklet via
`react-native-bare-kit`) is bundled and debugged. Companion to
[Client build](../client-build.md).

## bare-pack essentials

- Bundle with `bare-pack --preset android` (linked addons + all Android
  hosts), plus `--builtins` / `--imports` / `--encoding base64 --out
  backend/app.bundle.js`. The bundle is a build artifact — regenerate it
  whenever backend/SDK code changes, **before** the next APK build, or the
  app runs stale engine code.
- The backend package needs its **own `node_modules`** (it is not an npm
  workspace of the app) — run `npm install` there before bundling, and run
  the bundling itself from the main checkout so every `file:` dep
  resolves.
- **`--imports` is a global import-override map** — it remaps arbitrary
  specifiers. This is how `node:crypto` is redirected to a sodium-backed
  WebCrypto shim. Don't put node core names in `--builtins` for the
  worklet: the 0.13.x worklet runtime has **no builtins table**, and any
  `builtin:` reference aborts the worklet at load.

## Worklet runtime gotchas

- **Missing globals:** there is no `TextEncoder`/`TextDecoder`/
  `globalThis.crypto` — polyfill them in a module that is the *first
  import* of your entrypoint (crypto libraries hit `TextEncoder` at
  module-evaluation time).
- **cwd is `/` on Android** (no HOME/env either) — relative store paths
  `ENOENT`. Derive the app sandbox (from `/proc/self/cmdline` → package
  name → `/data/data/<pkg>/files`, for example) and **create** the dir —
  after a data clear it doesn't exist, and a bare probe strands you on a
  relative path.
- **Any uncaught exception SIGABRTs the whole app process.** Install an
  `uncaughtException` guard that reports over IPC as the last resort, and
  treat every HTTP response your code writes as abortable (players cancel
  requests constantly) — an unhandled "write after close" stream error
  was exactly such a crash.
- **Debug loop:** worklet errors reach logcat as `E <package>: Uncaught …`
  with a `bare:/worklet.bundle/...` stack, then the abort. App-level
  errors after boot come back over IPC as `{type:'error'}`.

## Native addons

- The Holepunch stack's native addons ship Android prebuilds in their npm
  packages. The bare-kit Gradle link task collects every addon **reachable
  from the app's package.json dependency graph** into the APK (versioned
  `.so` names, so two majors of the same addon coexist). If an addon is
  only reachable through a `file:` dep, make sure that dep is declared
  from the app side.
- To audit a bundle: decode the base64 export — the header is
  `«length»\n«JSON»` — and compare its `linked:` addon references against
  the `.so` files the APK ships.

## Hyper-stack API traps (health probes, discovery)

- **`hyperdrive.get(path)` blocks indefinitely** waiting for blob blocks
  when peers exist but data hasn't replicated — never use it in a
  poll/health probe. Use **`drive.entry(path)`** (metadata-only, returns
  fast); the entry's bee `seq` bumps on every rewrite, which doubles as a
  "live playlist is advancing" signal.
- **A peer that announces a topic *after* you joined it** is only
  discovered on hyperswarm's slow periodic refresh (this can exceed a
  minute). If you're waiting for a seeder to appear (a broadcaster
  restart, or a CDN→P2P auto-return), keep the `PeerDiscovery` object from
  `swarm.join()` and call **`.refresh()`** on your poll interval —
  discovery then lands in seconds.
- If the panel socket drops, **clear your RPC binding on `close`** so the
  next swarm connection re-arms it — otherwise every later call fails
  `CHANNEL_CLOSED` forever.
