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
