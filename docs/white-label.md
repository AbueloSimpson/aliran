# White-label branding

One codebase, any number of branded apps. A **brand directory** (a service
descriptor plus a handful of images) turns into a release APK with its own:

- Android **applicationId** — `com.aliranclient.<id>`, so branded apps
  **co-install** side by side (and beside the vanilla dev build)
- launcher **icon** + app **name**
- **splash logo** (baked into the APK — it shows before any network I/O)
- menu-hub **wallpaper** fallback and Android TV **banner**
- full **color theme** (every token the UI uses; see the descriptor reference)

Screens contain no hardcoded brand: everything flows from the bundled service
descriptor through `makeTheme()`. Packaging a brand never edits source — the
builder swaps the bundled descriptor for one build and restores it afterwards.

The repo ships one **fictional** example brand, `client/brands/sunburst/`. Real
operator brands are private directories **outside the repo** with the same layout.

## Quick start

```bash
# 1) copy the example brand somewhere private and make it yours
cp -r client/brands/sunburst ../acme && $EDITOR ../acme/service.json

# 2) build a branded release APK (same toolchain as a normal client build)
node tools/brand.mjs ../acme            # or: npm run brand -- ../acme

# 3) install it (or pass --install)
adb install -r client/android/app/build/outputs/apk/acme/release/app-acme-release.apk
```

Prerequisites are exactly those of a normal Android release build (JDK 17 +
Android SDK; see [Client build](client-build.md)).

## The brand directory

```
<brand dir>/                 dir name = brand id: 1-24 lowercase letters/digits
                             (it becomes the applicationId suffix; --id overrides)
  service.json    required   the service descriptor baked into the APK — same
                             schema as client/config/service.example.json
  icon.png        required   launcher-icon FOREGROUND: square PNG, transparent
                             background, glyph within the middle ~60% (adaptive-
                             icon safe zone). The background layer is a flat fill
                             of branding.colors.primary.
  logo.png        optional   splash wordmark (transparent background; rendered on
                             branding.colors.brandSurface). Without it the splash
                             shows the service name as text.
  wallpaper.png   optional   menu-hub wallpaper when no featured stream provides
                             a backdrop (panel curation still wins when it does)
  banner.png      optional   Android TV launcher banner, 320x180
  res/            optional   escape hatch: a full Android res tree copied verbatim
                             over the generated overlay (e.g. hand-tuned
                             per-density mipmaps replacing the adaptive icon)
```

`brand.mjs` wires the images up automatically: when `logo.png` / `wallpaper.png`
exist and the descriptor doesn't already set `branding.logo` /
`branding.wallpaper`, the baked drawables are used. (Those fields also accept
`https://` URLs — but only baked art shows before the network is up.)

## Building

```
node tools/brand.mjs <brand> [options]

  <brand>      brand id under client/brands/<id>, or a path to a brand dir
  --dev        borrow panelPubKey / bootstrap / hybrid / dev login from the local
               gitignored client/config/service.json (demo + local testing only)
  --id <id>    override the brand id (default: the dir's basename)
  --variant    release (default) or debug
  --install    adb install -r the APK after a successful build
  --no-build   validate + generate the res overlay, then stop
```

What a build does:

1. **Validates** the brand dir — descriptor sanity, required art, and a hard
   **refusal of any `dev` credentials block** (brand dirs must stay shippable).
2. **Generates an Android res overlay** under
   `client/android/app/build/aliranBrand/<id>/res` — app name, adaptive launcher
   icon (your `icon.png` inset 18% over a `branding.colors.primary` background),
   splash logo / wallpaper / TV-banner drawables.
3. **Swaps** `client/config/service.json` for the brand descriptor (your dev
   config is backed up and **always restored**, even when the build fails) and
   forces a fresh JS bundle — the React Native bundle task doesn't track the
   descriptor as an input.
4. Runs the **property-gated gradle flavor**
   (`-PaliranBrandId=<id> -PaliranBrandRes=<overlay>` →
   `:app:assemble<Id>Release`). Without those properties `build.gradle` declares
   no flavors at all, so plain dev/release builds are completely unaffected.

The APK lands in
`client/android/app/build/outputs/apk/<id>/<variant>/app-<id>-<variant>.apk`.

## Keys and credentials

- **`panelPubKey` is public** — it ships inside every APK, like the branding. Set
  your panel's key in the brand descriptor for real builds.
- **Credentials are not brand data.** `brand.mjs` rejects a descriptor carrying a
  `dev` login block. For a local demo build against your own panel, `--dev`
  merges the missing deploy-time values (including the dev auto-login) from your
  gitignored `client/config/service.json` at build time — nothing lands in the
  brand dir.

## Shipping to production

- **Signing:** like the stock client, branded release builds sign with the
  **public RN debug keystore** — fine for demos, **not shippable**. Generate a
  per-brand keystore and wire it into `client/android/app/build.gradle`
  (`signingConfigs`) before distributing anything
  (see the [React Native signed-APK guide](https://reactnative.dev/docs/signed-apk-android)).
- **Versioning:** `versionCode` / `versionName` are shared app defaults today —
  bump them in `client/android/app/build.gradle` per release train.
- **One generic APK instead:** the descriptor can also be delivered at runtime
  (QR / deep link) if you prefer a single unbranded binary — see
  [Client build](client-build.md). Brand packaging exists for the opposite goal:
  a store listing that *is* the operator's product.
