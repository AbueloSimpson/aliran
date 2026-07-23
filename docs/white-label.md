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

## Desktop player (Windows)

The same descriptor brands the [desktop player](desktop-player.md) — its
screens also render entirely from `branding` (colors become the UI's CSS
variables; the splash logo, menu wallpaper and service name come from the same
fields), so a brand's `service.json` carries over unchanged:

1. Copy the brand's `service.json` to `desktop/config/service.json`.
2. Package: `cd desktop && npm run dist` — the descriptor is baked as a
   resource, and the build boots with your panel key and theme
   (see [Desktop player §4](desktop-player.md)).

Two desktop-specific notes:

- **No `brand.mjs` equivalent yet:** the installer/exe **icon** and **product
  name** are set by hand in `desktop/electron-builder.yml` (they stay "Aliran"
  otherwise). Everything *inside* the app is branded with no edits.
- The PNG files in a brand dir are Android packaging inputs. For the desktop,
  point `branding.logo` / `branding.wallpaper` at **https URLs** in the
  descriptor — baked Android drawable references don't exist there.

## Reseller panel dashboard

The [reseller panel](reseller-panel.md)'s web dashboard white-labels **at
runtime, entirely from environment variables** — no build step, no source
edits, and changes apply on the next page load. This is the surface your
third-party resellers see, so it is usually the first thing to rebrand.

### Variables

| Env var | What it does | Served at |
|---|---|---|
| `BRAND_NAME` | Brand text in the login card, the sidebar and the browser-tab title. Without a logo it renders like the stock brand: **first word bold**, the rest in the accent tone ("Acme TV" ⇒ **Acme** `TV`). | `/branding.json` |
| `BRAND_LOGO_FILE` | Path to a logo image. When set, it **replaces the brand text** in the sidebar and on the login card (the name still titles the tab and is the image's alt text). | `/branding/logo` |
| `BRAND_FAVICON_FILE` | Path to a favicon image for the browser tab. Without it the tab shows a dot in the accent colour (which follows your theme override automatically). | `/branding/favicon` |
| `BRAND_THEME_FILE` | Path to a JSON file overriding any of the **11 colour tokens** (next section). | `/branding.css` |

All four are optional and independent — set only what you need. A typical
Docker deployment mounts one read-only brand directory:

```yaml
services:
  reseller:
    volumes:
      - ./acme-brand:/brand:ro
    environment:
      BRAND_NAME: "Acme TV"
      BRAND_LOGO_FILE: /brand/logo.svg
      BRAND_FAVICON_FILE: /brand/favicon.png
      BRAND_THEME_FILE: /brand/theme.json
```

### Images — formats and sizes

Accepted formats (by file extension): **SVG, PNG, JPEG, WebP, ICO**. Any other
extension is refused. SVG is the recommendation for the logo — it stays crisp
at every zoom level; if you use a raster, supply it at **2× the rendered size**.

| Image | Rendered box (max) | Supply |
|---|---|---|
| Logo — sidebar | **30 px tall × 176 px wide** | SVG, or PNG ≥ 60 px tall. **Transparent background** (it sits on the `panel` colour). Wide wordmarks work best; the image scales down proportionally to fit the box. |
| Logo — login card | **44 px tall × 250 px wide** | Same file — the login card just allows it larger. |
| Favicon | browser tab (16–32 px) | 32×32 PNG or ICO, or an SVG. |

There is one logo slot; the same file is used everywhere it appears. Files are
read per request (`cache-control: no-cache`), so replacing the file on disk
rebrands on the next reload — no restart.

### Colours — the 11 theme tokens

`BRAND_THEME_FILE` is a JSON object using any subset of the 11 token names,
**6-digit hex only** (`#RRGGBB`). Unknown keys and malformed values are
silently ignored, and an unreadable file simply means "no overrides" — a typo
can never take the dashboard down.

```json
{
  "bg": "#0B1220",
  "panel": "#111A2E",
  "panel-2": "#18243C",
  "border": "#24314D",
  "text": "#E5EEF7",
  "muted": "#93A4BF",
  "accent": "#F59E0B",
  "accent-dim": "#B45309",
  "danger": "#F87171",
  "ok": "#34D399",
  "warn": "#FBBF24"
}
```

What each token paints (every other colour in the UI is *derived* from these
via `color-mix`, so overriding a token carries all of its tints with it):

| Token | Paints |
|---|---|
| `bg` | The page background. |
| `panel` | Sidebar, topbar, cards, table surface, dialogs, popover menus. |
| `panel-2` | One step up: inputs, buttons, hovers, chips, segmented controls. |
| `border` | Card and input borders; table hairlines derive from it at 55%. |
| `text` | Primary text. |
| `muted` | Secondary text: labels, table headers, kv labels, hints, nav idle. |
| `accent` | The brand: accent word/logo tone, active nav bar, links, trial badge, avatar, sort arrows, focus tints, the default favicon dot. |
| `accent-dim` | Fills behind light text: primary buttons, focus outlines. |
| `danger` | Destructive: delete actions, error dots/badges/toasts, negative ledger deltas. |
| `ok` | Healthy: active dots, reachable state, positive ledger deltas. |
| `warn` | Attention: expiring accounts, threshold-crossing System tiles. |

Practical rules:

- **Start with `accent` + `accent-dim`** — for most brands that is the whole
  job (the demo rebrand in the repo history changed exactly those two).
- Keep `text` vs `bg`/`panel` at **≥ 4.5:1 contrast** (WCAG AA), and `muted`
  legible on `panel`.
- **Leave `danger`/`ok`/`warn` semantic** — red/green/amber must keep meaning
  the same thing under every brand (the shared-theme contract). Adjust their
  shade, not their hue.
- The dashboard is designed dark. A light theme is possible (all 11 tokens are
  yours), but check row hover, dialogs and the segmented control after — the
  derived tints assume a dark base.

### How it works, and scope

The overrides are served as `/branding.css`, layered **after** the
stylesheet's built-in shared theme block — that block stays byte-identical
across the panel/broadcaster/reseller dashboards (`npm run test:theme`), so
white-labelling never forks the source. This wires up the S19 seam for the
reseller dashboard specifically; the panel and broadcaster dashboards are
operator-internal and keep the stock brand (rebrand them in source if you must
— the same 11 tokens, same block, edit all three sheets or none).

To read as **one product with your client apps**, align the five core tokens
with your brand descriptor's `branding.colors` (see the top of this page):
`bg` ↔ `background`, `panel` ↔ `surface`, `text` ↔ `text`, `muted` ↔
`textDim`, `accent` ↔ `accent` — the same correspondence the repo's theme test
enforces between the stock dashboard and the stock app.

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
- **One generic APK instead:** the public keyless flavor takes the descriptor at
  runtime — first run shows a **Connect screen** where the viewer enters your
  panel key + account — if you prefer a single unbranded binary; see
  [Client build](client-build.md). Brand packaging exists for the opposite goal:
  a store listing that *is* the operator's product.
