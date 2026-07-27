# Aliran desktop player (Windows)

The Windows sibling of the Android app: one Electron application that logs in over
the DHT, browses the S18 interface (menu hub, category rail, numbered channel list,
detail panel with the program guide), plays live P2P and redirect channels, and
re-seeds to other viewers.

- The **main process runs [`@aliran/player-sdk`](../sdk/)** directly — same engine,
  same native-module prebuilds as the Node e2e suites. All engine access stays in
  main; the sandboxed React renderer plays the engine's localhost HLS with hls.js
  behind a narrow IPC bridge (the worklet message protocol).
- Saved credentials are wrapped with Electron `safeStorage` (DPAPI); the password
  never returns to the renderer.
- **Two flavors from one codebase**: package with `config/service.json` present
  for an **operator build** (panel key baked in), or without it for the **public
  build** — first run shows a Connect screen where the viewer enters their
  operator's panel public key + account, and it persists (*Settings → Change
  service…* forgets it).
- Test/dev descriptors may carry `"dev": { "username", "password" }` — Login
  prefill + first-boot auto-login. Never in anything handed to viewers.
- **Movies & Series** (S53) appears only while the operator's panel has an external
  VOD provider enabled: the login payload carries the provider's coordinates and the
  app calls that provider ITSELF, authenticating with the viewer's own account. The
  requests run in main (`main/vod-provider.js`) — the renderer is `file://`, so CORS
  forbids them there, and the credential is the viewer's password. A dev build may
  override the account with `"vod": { "dev": { "username", "token" } }`; like the
  `dev` block above, it must never ship.
- Private package — never published to npm.

Quick start (from the repo root):

```sh
npm install
cd desktop
cp config/service.example.json config/service.json   # set your panelPubKey
npm run start                                        # build renderer + launch
```

Package (NSIS installer + portable exe; bakes `config/service.json` in):

```sh
npm run dist
```

Full guide — architecture, keyboard map, packaging, the unsigned/SmartScreen
reality, and the codec (HEVC) story: [docs/desktop-player.md](../docs/desktop-player.md).
End-user documentation for the public build (hand it to viewers):
[docs/desktop-viewer-guide.md](../docs/desktop-viewer-guide.md).
