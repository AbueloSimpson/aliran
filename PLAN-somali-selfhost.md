# Aliran — self-host + branding + Somali localization: analysis

Working notes from reading the repo at `AbueloSimpson/aliran` (MIT, `main`, clone dated 2026-11-10).
Nothing here changes code yet — it is the map, plus the decisions I need from you.

---

## 1. What Aliran actually is

A **self-hostable, peer-to-peer OTT streaming platform** on the Holepunch/Pear stack
(Hyperswarm DHT + Hyperdrive). Viewers re-seed live channels to each other, so delivery
scales with the audience instead of central media servers. No public IP, no open inbound
port for playback — peers find each other by **public key over the DHT**.

Components (all cooperate, all serverless in transport):

| Component | Required? | Runs on | Role |
|---|---|---|---|
| `panel/` | **yes** | Linux | Origin of truth: signed account DB, stream catalog, OPRF login, entitlement tokens, admin dashboard |
| `broadcaster/` | **yes** | Linux (headless) | Ingests OBS/RTSP/HLS/RTMP/SRT/file → encrypted P2P feed; control dashboard |
| `repeater/` | optional | Linux | Keyless regional super-peer (mirrors + serves feeds it cannot watch) |
| `library/` | optional | Linux | VOD service (encrypted, P2P-seeded on-demand titles) |
| `reseller/` | optional | Linux | Reseller panel: role hierarchy + credit ledger over the panel admin API |
| `client/` | viewer app | Android phone + TV | React Native (react-native-tvos) app, embeds Bare worklet, plays **and re-seeds** |
| `desktop/` | viewer app | Windows + macOS | Electron player, same OTT UI + P2P engine |
| `core/`, `sdk/`, `i18n/`, `mcp/`, `tools/` | libs/tools | — | shared crypto, player SDK, i18n runtime, MCP server, e2e suites |

**Architecture in one line:** panel holds identity + catalog; broadcaster feeds the swarm;
viewers log in via P2P RPC, get sealed keys, play, and re-seed; optional repeaters absorb fan-out.

---

## 2. Self-hosting

Supported path is **Docker Compose** (`docker-compose.yml` at root). It pins ffmpeg + Node,
uses `network_mode: host` deliberately (Hyperswarm UDP hole-punching), binds admin dashboards
to `127.0.0.1`, and caps container logs.

Minimum viable deployment (from `docs/quickstart-terminal.md`, ~15 min):

```bash
git clone https://github.com/AbueloSimpson/aliran && cd aliran
cp panel/.env.example panel/.env
cp broadcaster/.env.example broadcaster/.env
docker compose build
docker compose run --rm panel node src/admin-cli.js init        # prints PANEL PUBKEY + PUBLISHER KEY
docker compose run --rm panel node src/admin-cli.js add-admin admin
docker compose run --rm broadcaster node src/control-cli.js add-admin admin
# wire PANEL_PUBKEY + PUBLISHER_KEY into broadcaster/.env; set ADMIN_ENABLED=1 / CONTROL_ENABLED=1
docker compose up -d
```

Facts that matter for you:

- **Host:** Linux, Ubuntu 24.04 tested; 2 vCPU / 2 GB is enough to start. Docker + Compose plugin.
- **No domain, no TLS cert, no open ports** needed for playback. Dashboards are reached via SSH
  tunnel, or published with `deploy/Caddyfile.example` (automatic HTTPS) — see `docs/kb/public-dashboards.md`.
- **Backups are critical.** `DATA_DIR/keys` is the service *identity*, not rotatable. Lose the OPRF
  key → every viewer account is locked out permanently. Use `deploy/backup.sh` / `restore.sh`,
  plus the encrypted escrow export. See `docs/kb/backup-and-rotation.md`.
- **Firewall/kernel tuning:** `deploy/sysctl/install.sh` raises UDP socket buffers; without it the
  kernel silently clamps them and throughput caps out with no error.
- Optional extras: `deploy/docker-compose.repeater.yml`, `deploy/gpu/` (VAAPI transcode),
  `deploy/systemd/` units (bare-metal), `deploy/cloudflared.compose.example.yml`.
- Service display name before sign-in is `SERVICE_NAME` in `panel/.env` (public display text only).

---

## 3. Branding / white-label

There are **three independent branding surfaces**. All are "one codebase, any number of brands".

### 3a. Viewer apps — a *brand directory* (build-time, baked in)

`docs/white-label.md` + `client/brands/README.md`. The mechanism:

```
<brand dir>/            dir name = brand id (1–24 lowercase letters/digits) → appId suffix
  service.json   req.   service descriptor (panelPubKey, name, branding, sections, defaultLocale)
  icon.png       req.   launcher icon foreground (square, transparent, glyph in middle ~60%)
  logo.png       opt.   splash wordmark (transparent)
  wallpaper.png  opt.   menu-hub wallpaper fallback
  banner.png     opt.   Android TV launcher banner, 320x180
  res/           opt.   escape hatch: full Android res tree copied verbatim
  signing.json   opt.   { "keystore": "...", "keyAlias": "..." } — NO passwords inside
  build.json     opt.   { "versionCode": 5, "versionName": "1.1.0" }
```

Android: `node tools/brand.mjs <brand-dir> [--install --variant ...]` → APK at
`client/android/app/build/outputs/apk/<id>/release/app-<id>-release.apk`,
applicationId `com.aliranclient.<id>`, co-installs beside other brands. Branded builds get their own
icon, app name, splash logo, wallpaper, TV banner and full color theme via `makeTheme()`.
The example brand is `client/brands/sunburst/` (fictional). **Real brands live outside the repo**,
especially once they hold a keystore.

Desktop: copy the brand's `service.json` to `desktop/config/service.json`, then `cd desktop && npm run dist`
(Windows) / `npm run dist:mac`. Note: **no `brand.mjs` equivalent yet** — installer/exe icon and product
name are set by hand in `desktop/electron-builder.yml` (currently `productName: Aliran`). Everything
*inside* the app brands from the descriptor with no edits. Builds are unsigned → SmartScreen/Gatekeeper
warnings (documented in `docs/desktop-player.md`).

Full color theme = the `branding.colors` token set in `service.json`
(primary, background, surface, accent, text, textDim, live, focus, onPrimary, videoBackground, overlay,
overlayStrong, focusFill, focusFillText, brandSurface, brandText).

### 3b. Reseller dashboard — *runtime* white-label, env only (no build, no source edit)

`BRAND_NAME`, `BRAND_LOGO_FILE`, `BRAND_FAVICON_FILE`, `BRAND_LOGIN_BG_FILE`, `BRAND_LOGIN_STYLE`,
`BRAND_THEME_FILE` (11 hex tokens: bg, panel, panel-2, border, text, muted, accent, accent-dim,
danger, ok, warn). Served as `/branding.json`, `/branding.css`, `/branding/logo`, etc. Changes apply
on reload. Typical: mount a read-only brand dir into the container.

### 3c. Panel + broadcaster dashboards — **stock brand, not white-labelled**

Per `docs/white-label.md`, these operator-internal dashboards keep the stock brand on purpose.
Rebranding them means editing the shared theme block **in all three sheets or none** (the theme
test `npm run test:theme` enforces they stay byte-identical). This is a real gap for full
"my brand everywhere" — I'll need to know if you want it.

---

## 4. Somali localization — what it takes

The viewer i18n lives in `i18n/` (`@aliran/i18n`), zero-dependency, **no build step**, consumed
directly as TypeScript source by both `client/` (Metro) and `desktop/` (esbuild). Operator surfaces
(`panel/`, `broadcaster/`, `reseller/`, `library/`) are **English by design** and must not depend on it.

Current locales (14): `en es pt fr nl de it ru tr hi ja zh-Hans ko th` — **no Somali (`so`)**.
`en` is the source catalog, **377 keys**, already ASD-STE100 reviewed.

Adding `so` means touching exactly these places (the guard `npm run test:i18n` checks all of them):

1. `i18n/locales/so.json` — new catalog, all 377 keys, no empty values, identical `{name}`
   placeholder sets per key. **Never translate operator/provider content** (channel/category/EPG/VOD
   titles, `service.name`) or engine/SDK error prose.
2. `i18n/src/index.ts`:
   - add `'so'` to the `Locale` union,
   - add `{ code: 'so', nativeName: 'Soomaali' }` to `SUPPORTED_LOCALES`,
   - add `so: ['one', 'other']` to `PLURAL_FORMS`,
   - `pluralForm()`: Somali falls in the default `n === 1 ? 'one' : 'other'` branch (CLDR `one`/`other`) — no new case needed,
   - import the catalog and register it in `CATALOGS`.
3. `client/backend/backend.mjs` — the `LANGUAGES` array (line ~488) is a **runtime-boundary duplicate**
   of the locale codes (the Bare worklet can't import the TS runtime). Add `'so'` or the picker offers a
   language the worklet silently refuses to persist (guard check 4b).
4. Possibly `client/src/lang.ts` + `desktop/renderer/src/lang.ts` (mirrored static language-name tables
   for audio/subtitle track menus) — add `so: 'Somali'` / `som: 'Somali'` if you want track labels named.
   These two files are hand-mirrored and the guard pins them.
5. Optional: `defaultLocale: "so"` in your brand's `service.json` — this is the operator's preferred
   language for viewers with no supported language of their own (`client/src/config.ts`, `ServiceDescriptor.defaultLocale`).

**RTL is not a problem.** Somali is left-to-right, so the repo's "no RTL handling anywhere" note is fine.

**Also English-only today:** the reseller dashboard carries its **own** catalog
(`reseller/control-ui/i18n.js`, `LOCALES` = en + es only) because it has no bundler. And the
panel/broadcaster dashboards aren't translated at all. If "Somali everywhere" includes the operator
UI, that is separate work I should scope with you.

---

## 5. What I need from you

**A. Brand identity**
1. Service / brand name (shown in-app and to viewers).
2. Brand id (lowercase letters/digits, ≤24) → Android applicationId `com.aliranclient.<id>`.
3. Colors — at minimum `primary`, `background`, `accent`; ideally the full token set.
4. Artwork: launcher `icon.png` (required), and optional `logo.png`, `wallpaper.png`, `banner.png` (320x180).
   For the reseller dashboard: `logo.svg` (or PNG ≥60px tall), `favicon.png`, optional login backdrop.
5. For desktop: desired product name + `.ico` (Windows) / `.icns` (macOS) if you have them.

**B. Deployment**
6. Target host: your own VPS / bare-metal / a cloud VM? OS + specs? A domain (for Caddy HTTPS on the dashboards)?
7. Which components: minimum (panel + broadcaster), or also repeater / library / reseller?
8. Are you building on a fork of the repo (your own GitHub repo) or keeping brand dirs private?
9. Do you want me to actually run the Docker Compose stack here to verify, or just produce the build/deploy
   configuration and commands for your server? (This sandbox has Docker + Node, but **no JDK/Android SDK**,
   so I can't build the APK here without installing a large toolchain — tell me if you want that.)

**C. Somali**
10. Full UI translation of all 377 viewer keys — do you have a translator, or should I draft Somali and
    you review? (I can produce a complete `so.json`, but native review is strongly recommended.)
11. Should Somali be the **default** language of your branded build (`defaultLocale: "so"`)?
12. Scope: viewer apps only, or also the reseller dashboard, or also the panel/broadcaster dashboards?

**D. Build / ship**
13. Targets: Android APK (phone/TV, which ABIs: arm64-v8a / armeabi-v7a?), Windows desktop, macOS desktop?
14. Do you have (or want me to set up) an Android **release keystore** per brand? Without one, releases are
    debug-signed and can never receive P2P OTA updates.

---

## 6. My proposed work plan (once you answer)

1. Fork/clone to your repo; create the brand directory (id, `service.json`, artwork, theme tokens).
2. Add Somali: `i18n/locales/so.json` + register in `i18n/src/index.ts` + worklet `LANGUAGES`; run `npm run test:i18n`.
3. Verify branding + i18n locally with `npm run test:theme`, `npm run test:i18n`, and a dev viewer build
   (`npm run viewer` / desktop `npm start`).
4. Produce the self-host deployment: tuned `panel/.env` / `broadcaster/.env`, `docker-compose.yml` (+ optional
   Caddy TLS, repeater/library/reseller, sysctl, backups), and a step-by-step runbook.
5. Build and sign the branded Android APK (`node tools/brand.mjs`) and desktop installers
   (`cd desktop && npm run dist`), with the keystore set up correctly.
6. Optional: white-label the panel/broadcaster dashboards, reseller dashboard env branding, Somali there too.
