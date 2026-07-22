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

# 2. Configure the operator panel key
cp config/service.example.json config/service.json   # set panelPubKey

# 3. Bundle the Bare backend
npm run bundle-backend        # -> backend/app.bundle

# 4. Run
npm run android               # phone or Android TV emulator/device
```

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
- [ ] Optional: runtime service-descriptor QR (one generic APK connects to any
      operator — the desktop player already ships this as its Connect screen)
