# @aliran/client

The Aliran app — **React Native (`react-native-tvos`)** targeting **Android phone +
TV** from one codebase. Embeds the P2P backend (Bare) via `react-native-bare-kit` and
plays with `react-native-video`.

> This folder is a **source skeleton** (`src/`, `backend/`, `config/`). The native
> Android project is generated once with the RN CLI, then these are copied in. Full
> steps: [`../docs/client-build.md`](../docs/client-build.md).

## Layout

```
src/App.tsx              navigation: Login -> Home (rails) -> Player
src/worklet.ts           boots the Bare backend + typed IPC
src/config.ts            loads the operator service descriptor (panel key + branding)
src/theme.ts             brandable theme; phone vs TV sizing
src/screens/             LoginScreen, HomeScreen, PlayerScreen
backend/backend.mjs      Bare worklet: OPRF login + Hyperdrive replica + localhost server
config/service.example.json  copy to service.json and set your panel public key
brands/                  white-label brand dirs -> branded APKs via tools/brand.mjs
                         (ships the fictional "sunburst" example; docs/white-label.md)
```

## Get started

```bash
# 1. Native project (once): scaffold a react-native-tvos app, copy src/ backend/ config/ in.
npm install

# 2. Pick the flavor (config/service.json decides it):
cp config/service.example.json config/service.json   # OPERATOR flavor: set panelPubKey
#   — or —
cp config/service.public.json config/service.json    # PUBLIC flavor: keyless, viewers
#                                                      enter their operator's panel key
#                                                      on a first-run Connect screen

# 3. Bundle the Bare backend
npm run bundle-backend        # -> backend/app.bundle

# 4. Run
npm run android               # phone or Android TV emulator/device
```

**Flavors** (S36, mirrors the desktop player): a BAKED `panelPubKey` ships in the APK,
boots directly, and is never changeable at runtime. The committed keyless
`config/service.public.json` (`panelPubKey: ""`) instead routes first run to a
**Connect screen** (panel key + username + password, persisted on-device after a
successful sign-in) and adds Settings → **"Change service…"**. Precedence:
baked → persisted runtime service → Connect. When rebuilding after swapping
`config/service.json`, delete `android/app/build/generated/assets/react` first — the
gradle JS-bundle task does not track config JSON as an input (see docs/client-build.md).

## Requirements

Real native build (NOT Expo Go): JDK 17, Android Studio + SDK 34 + NDK + CMake. Test on
a **phone** and an **Android TV** target. See [`../docs/client-build.md`](../docs/client-build.md).

## Status / TODO

- [x] App navigation, IPC wrapper, theme, Login/Home/Player screens, backend worklet skeleton
- [x] Native project init — `react-native-tvos` (RN 0.83.0-0 / React 19); `android/` builds & runs
  the empty app on the emulator (New Arch / Fabric, Hermes). Entry is the scaffold `App.tsx`;
  `src/` is present but not yet wired.
- [ ] `react-native-bare-kit`/`react-native-video`/navigation linking
- [ ] Implement OPRF login + session sealing (Android Keystore/StrongBox) in the worklet
- [ ] Localhost Range server mapping to the decrypting Hyperdrive + `/assets`
- [ ] Live catalog `bee.watch()` → stream list; peer-count status
- [ ] Dual phone+TV manifest (leanback + touchscreen-optional), cleartext localhost
- [x] Runtime service descriptor (S36): one generic keyless APK connects to any
      operator via the first-run Connect screen (panel key + credentials, persisted;
      Settings → "Change service…") — the Android analogue of the desktop player's
      public flavor. A QR/deep-link shortcut for the key stays a possible future nicety.
