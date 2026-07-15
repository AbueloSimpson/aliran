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

## The on-device store is a disposable cache

The worklet keeps its Corestore at `/data/data/<pkg>/files/aliran-store`. It holds
**only replicas** (panel DB, assets drive, feed drives) — every byte re-replicates from
peers, and nothing user-owned lives there. If the app process dies mid-write (crash,
task kill), hypercore can refuse to reopen a core (`OPLOG_CORRUPT` and friends); the
backend detects this, **wipes the store automatically and retries once**
(`client/backend/recover.mjs`), so playback recovers without user action. Deleting the
directory by hand (or `adb shell pm clear <pkg>`) is always safe — it only costs a
re-replication. Verified by `npm run test:corrupt` (repo root).

## App structure (since the GUI redesign)

```
Splash (boot + auto-auth: "Authorizing device…")
  ├─ Login       only when there are no saved credentials, or they stopped working
  └─ Menu        icon-bar hub over the featured stream's wallpaper (sections are
     │           descriptor-driven; Exit is TV-only by default)
     ├─ Live        ONE fullscreen video surface; browsing happens in overlay panels
     │              (category rail + channel list, and a channel-detail panel) — the
     │              video keeps playing while you browse; selecting a row switches
     │              the stream in place; D-pad up/down zaps when fullscreen
     ├─ Favorites   device-local ★ channels
     ├─ Search      client-side filter (title/description/category)
     └─ Settings    account / service / diagnostics / sign out
```

- **Auto-login ("remember me"):** after a successful sign-in the app saves the
  credentials to the **app-private files dir** (`aliran-prefs.json`, beside — not
  inside — the disposable store, so corruption recovery never wipes them). This is
  plaintext-at-rest inside the Android app sandbox — the normal tradeoff for this app
  class; sign-out deletes it. Favorites live in the same file.
- **White-label contract:** screens/components contain **no** brand names, colors, or
  section lists. Everything flows from `config/service.json` (the service descriptor)
  through `theme.ts makeTheme()` — swap the descriptor, ship a different brand.
  Channel numbers are derived from the panel's curation (`order`, then title) — never
  stored. No EPG data exists yet, so the channel-detail panel shows an honest
  "No program information" placeholder instead of a fake guide.

## Configure the panel key

- **Build-time:** put the operator `panelPubKey` + branding in `client/config`.
- **Runtime:** accept a **service-descriptor QR/deep link** so one generic APK works
  for any operator.

> **Gradle gotcha:** the release JS-bundling task does not track `client/config/*.json`
> as an input — after editing `service.json`, delete
> `android/app/build/generated/assets/react` (or run the bundle task with
> `--rerun-tasks`) so the descriptor change actually lands in the APK.

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
