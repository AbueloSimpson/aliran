# Operator build walkthrough

One page, start to finish: from a clean checkout to **your own builds** of the
Android app and the Windows desktop player — your panel key baked in, your
colors and logos on screen. Each step links the reference page that explains it
in depth ([Client build](client-build.md), [White-label branding](white-label.md),
[Desktop player](desktop-player.md)).

> Building your own artifacts is for operators who want a branded product.
> If a generic app is fine, skip all of this: the keyless **public builds** on
> the [releases page](https://github.com/AbueloSimpson/aliran/releases/latest)
> connect to any panel — viewers just enter your panel key and account on the
> Connect screen.

## 0. What you need

- **Your panel public key** — printed by `admin-cli init` when you set up the
  panel (see the [operator guide](operator-guide.md)). It's public; it ships
  inside the build.
- **Node.js 24** and **git** (both platforms' builds).
- **For the APK:** JDK 17 and the Android SDK (build-tools, NDK, CMake) — the
  exact versions and environment variables are in
  [Client build](client-build.md). Windows, macOS, and Linux all work.
- **For the Windows exe:** nothing extra — Electron and the packager come from
  npm.

## 1. One-time setup

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
npm install                                  # repo root (also covers desktop/)

cd client
npm install                                  # app dependencies
cd backend && npm install && cd ..           # P2P engine worklet dependencies
npm run bundle-backend                       # pack the engine -> backend/app.bundle.js
cd ..
```

`bundle-backend` must be re-run whenever you update the repo (the packed engine
is a build artifact, not committed).

## 2. Your service descriptor

Everything brandable lives in one JSON file — the **service descriptor**
(schema: `client/config/service.example.json`):

```json
{
  "panelPubKey": "your 64-hex panel public key",
  "name": "Acme TV",
  "branding": {
    "logo": "https://acme.example/logo.png",
    "wallpaper": "https://acme.example/wall.jpg",
    "colors": { "primary": "#E11D48", "background": "#0B0B10", "accent": "#F59E0B" }
  }
}
```

`branding.colors` accepts the full token set (surface, text, focus, live, …) —
see the descriptor reference in [Client build](client-build.md). Omitted tokens
fall back to the stock theme. Never put credentials in a descriptor you ship.

## 3. Custom Android APK

Two routes, depending on how far you want to go:

**Route A — baked key, stock look.** Fastest path to "our APK":

```bash
cd client
cp config/service.example.json config/service.json    # edit: your key + branding
rm -rf android/app/build/generated/assets/react       # descriptor changes aren't tracked by gradle
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
# -> client/android/app/build/outputs/apk/release/app-release.apk
```

**Route B — fully branded** (own launcher icon, app name, splash logo, TV
banner, co-installable `applicationId`): make a **brand directory** and let the
builder do the swapping:

```bash
cp -r client/brands/sunburst ../acme     # copy the example brand, keep it private
$EDITOR ../acme/service.json             # your key, name, colors
# replace icon.png (+ optional logo.png / wallpaper.png / banner.png)

node tools/brand.mjs ../acme
# -> client/android/app/build/outputs/apk/acme/release/app-acme-release.apk
```

The brand-directory contract, image sizes, and everything `brand.mjs` does are
on [White-label branding](white-label.md).

**Before distributing:** release builds sign with the public React Native debug
keystore by default — generate your own keystore and wire it into
`client/android/app/build.gradle` first
([signing guide](https://reactnative.dev/docs/signed-apk-android)). One APK
covers phones **and** Android TV, and installs from **Android 7** — the P2P
engine activates on Android 10+ and stays silent below (the app shows an
"engine unavailable" notice there; see the
[client build guide](client-build.md)).

## 4. Custom Windows exe

```bash
cd desktop
cp config/service.example.json config/service.json    # same descriptor contract
npm run build                                         # renderer bundle
npm run dist
# -> desktop/dist/Aliran Setup <v>.exe  +  Aliran-<v>-portable.exe
```

- Your colors, name, logo, and wallpaper apply from the descriptor at runtime —
  no source edits. A brand directory's `service.json` drops in unchanged (use
  https URLs for logo/wallpaper; Android drawable references don't exist here).
- The **installer icon and product name** are the one manual step: set them in
  `desktop/electron-builder.yml`.
- Builds are unsigned unless you countersign with your own certificate —
  [Desktop player §4](desktop-player.md) covers the SmartScreen reality and
  `win.signtoolOptions`.

## 5. Verify what you built

Install the APK (or run the exe) on a clean device/profile:

1. It must boot **straight to your branded splash and sign-in** — an operator
   build never shows the Connect screen.
2. Sign in with a viewer account from your panel; the lineup should appear and
   a channel should play.
3. Settings should show your service name and panel key (read-only — a baked
   key is not changeable at runtime).

If you see the Connect screen instead, the build was packaged without
`config/service.json` (that's the public flavor).
