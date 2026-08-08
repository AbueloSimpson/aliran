# Brand directories (white-label packaging)

One directory per brand. `tools/brand.mjs` turns a brand dir into a branded release
APK with its own Android application id (`com.aliranclient.<id>`), launcher icon,
app name, splash logo, and theme — so any number of brands co-install from one
codebase. Full operator guide: [docs/white-label.md](../../docs/white-label.md).

```
client/brands/<id>/          <id> = lowercase letters/digits (becomes the appId suffix)
  service.json               the service descriptor baked into the APK (see
                             client/config/service.example.json for the schema)
  icon.png       required    launcher-icon FOREGROUND: square, transparent
                             background, glyph in the middle ~60% (adaptive-icon
                             safe zone). Background fill = branding.colors.primary.
  logo.png       optional    splash wordmark image (transparent background; shown
                             on branding.colors.brandSurface instead of the name text)
  wallpaper.png  optional    menu-hub wallpaper fallback (when no featured stream
                             has a backdrop)
  banner.png     optional    Android TV launcher banner, 320x180 (default builds
                             keep the stock banner)
  res/           optional    escape hatch: an Android res tree copied verbatim over
                             the generated overlay (e.g. hand-tuned per-density mipmaps)
  signing.json   optional    release signing: { "keystore": "<file in this dir>",
                             "keyAlias": "<alias>" }. The keystore file sits next to
                             it. Passwords are NOT stored here — set the
                             ALIRAN_STORE_PASSWORD and ALIRAN_KEY_PASSWORD env vars
                             at build time. Without signing.json, release APKs are
                             debug-signed (demo-only; OTA updates will not install).
  build.json     optional    version defaults: { "versionCode": 5, "versionName":
                             "1.1.0" }. The --version-code / --version-name flags
                             win over this file.
```

Rules:

- **Never put credentials in a brand descriptor** — no `dev` block; `brand.mjs`
  refuses to build one. For local demo builds, `--dev` borrows `panelPubKey` /
  `bootstrap` / `hybrid` / `dev` from the gitignored `client/config/service.json`.
- **The same rule covers `signing.json`** — keystore filename + key alias only.
  `brand.mjs` refuses a `signing.json` that carries password fields; the two
  passwords come from the environment at build time.
- **Keep real brand dirs out of git once they hold a keystore.** Losing the
  keystore strands the installed fleet (no update can ever install); leaking it
  lets anyone sign updates for your app. Back it up privately.
- **Only the fictional example brand (`sunburst/`) lives in the repo.** Real
  operator brands are separate private dirs — pass the path:
  `node tools/brand.mjs /path/to/acme`.
