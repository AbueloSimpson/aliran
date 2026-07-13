# Client Build (Android phone + TV)

The client is a **React Native** app using **`react-native-tvos`** so one codebase
targets phone/tablet and Android TV. It embeds **Bare** via `react-native-bare-kit`
and will **not** run in Expo Go — it needs a real native build.

## Prerequisites (the main hurdle)

Install in order:

1. **Node LTS**, **Git**
2. **JDK 17** (Temurin)
3. **Android Studio** → SDK Platform 34, Platform-Tools, **NDK**, **CMake**
4. Set `ANDROID_HOME`; add `platform-tools` to `PATH`
5. An emulator (phone AVD **and** an Android TV AVD) or physical devices
6. Verify: `npx react-native doctor`

Windows is fully supported for Android builds (no Mac needed).

## Install dependencies

The native `android/` project is checked in (react-native-tvos 0.83, New Architecture).

```bash
cd client
npm install            # app deps (also links backend/ via @aliran/client-backend)
cd backend && npm install && cd ..   # backend worklet deps (@aliran/core + hyper stack)
```

## Bundle the Bare backend

```bash
npm run bundle-backend   # bare-pack --preset android → backend/app.bundle.js (base64)
```

Notes:
- `backend/imports.json` remaps `node:crypto` to `@aliran/bare-node-crypto` (a small
  sodium-backed WebCrypto shim) because the bare-kit worklet runtime has no node-style
  builtins; `backend/globals.mjs` polyfills TextEncoder/TextDecoder/`globalThis.crypto`.
- Native addons (sodium-native ×2 majors, udx-native, quickbit/rabin/simdle/crc,
  fs-native-extensions) ship as npm prebuilds and are packaged per-ABI automatically by
  `react-native-bare-kit`'s gradle `link` task (`bare-link`), which walks the app's
  dependency graph — that is why `client/package.json` depends on
  `@aliran/client-backend`.

## Configure the panel key

- **Build-time:** put the operator `panelPubKey` + branding in `client/config`.
- **Runtime:** accept a **service-descriptor QR/deep link** so one generic APK works
  for any operator.

## Build & install

```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Test on a **phone** and an **Android TV** target (drive the TV build with a remote /
D-pad).

## Manifest notes (dual phone + TV)

Declare both `LAUNCHER` and `LEANBACK_LAUNCHER` intents; `android.software.leanback`
**not required**; `android.hardware.touchscreen` `required=false`. Allow `127.0.0.1`
cleartext in the network security config; add the `INTERNET` permission.
