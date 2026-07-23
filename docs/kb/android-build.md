# Android & React Native builds

Hard-won lessons from building the client on Windows. Companion to
[Client build](../client-build.md).

## Toolchain

- **Use JDK 17.** If an older JDK wins on PATH, `sdkmanager`, `gradlew`, and Metro
  tooling grab it and crash with class-version errors — set `JAVA_HOME` explicitly in
  the same shell you build from (persisted env vars don't reach already-open shells).
- React Native pins exact SDK bits in `android/build.gradle` (build-tools, NDK,
  platform) — install those versions; don't rely on whatever newer ones are present.
- `sdkmanager --licenses` under Windows only accepts all licenses via cmd file
  redirection (`cmd /c "sdkmanager.bat --licenses < yes.txt"` where `yes.txt` is many
  `y` lines) — a PowerShell pipe answers only the first prompt.

## Windows shell traps

- `cd` in PowerShell does **not** change the cwd that `cmd /c` children inherit —
  always `cd /d` *inside* the cmd string: `cmd /c "cd /d <dir> && gradlew.bat …"`.
- RN CLI `run-android` can fail with `'gradlew.bat' is not recognized` — skip it and
  drive the wrapper directly (`gradlew.bat :app:installDebug`), then start Metro and
  launch the app yourself.
- Long paths: set `git config core.longpaths true` and scaffold under a short path.
- PowerShell `>` redirection corrupts **binary** output (UTF-16 re-encode) — e.g.
  `adb exec-out screencap -p > x.png` writes an invalid PNG. Route binary redirects
  through cmd: `cmd /c "adb exec-out screencap -p > x.png"`.

## Dependencies must pin to your RN minor

Latest majors of common native deps often require a newer RN and blow up
`npm install` (ERESOLVE) or the autolinked native build. Pin per-RN-version (e.g.
`react-native-screens` 4.25.x for RN 0.83). With a **prerelease** RN (like
react-native-tvos `0.8x.0-0`), strict peer ranges fail even when factually
compatible — install with `--legacy-peer-deps`.

## Metro + Gradle running concurrently = ENOENT crash

Metro watching `android/build/generated/**` while Gradle rewrites it crashes Metro on
Windows. Start Metro **after** the build finishes.

## Emulator: video playback hard-crashes with `FATAL | Uninitialized YcbcrSamplerPool`

- **Cause:** gfxstream Vulkan bug in hardware GPU mode (`-gpu auto`) when ExoPlayer
  allocates YCbCr video textures. Not an app bug.
- **Fix:** launch the emulator with `-gpu swiftshader_indirect` for anything that
  plays video. Warning: the hardware-GPU crash can corrupt the app's local store
  (see [OPLOG_CORRUPT](playback.md#playback-fails-with-oplog_corrupt-oplog-file-appears-corrupt-or-out-of-date)).

## Emulator networking rots mid-session

- DNS can die entirely (`adb shell ping host` → `unknown host` for everything) while
  NAT'd TCP to the host still works — external URLs then never load in the app with
  no app-side error. Host-run dev servers stay reachable as `http://10.0.2.2:<port>`
  (host loopback alias). A full emulator reboot is the only DNS fix.
- adb itself wedges under load: wrap calls in a timeout, recover with
  `adb kill-server && adb start-server`; a wedged adb silently drops `input text`
  keystrokes.

## Changed a bundled config/JSON but the release APK behaves like the old one

- **Cause:** the RN JS-bundle Gradle task can report `UP-TO-DATE` even though a
  JSON file imported by your JS changed (seen with the app's bundled service
  descriptor) — the APK keeps the **old** embedded content.
- **Fix:** delete `android/app/build/generated/assets` before `assembleRelease`
  (or run Gradle with `--rerun-tasks`).

## Release vs dev builds

- Release builds embed the JS (no Metro) and are signed with the debug keystore in
  dev — the reliable way to verify on-device when Metro's dev-server download to the
  emulator is flaky.
- Cleartext HTTP is blocked in release builds (API 28+) — loopback exceptions come
  from the app's `network_security_config.xml`
  (see [playback](playback.md#posters-and-video-silently-fail-to-load-blank-tiles-no-error-anywhere)).
- `run-as` doesn't work on release builds (not debuggable) — verify via on-screen
  state and IPC logs, not the filesystem.

## Device floor: Android 10+ — the Bare runtime needs ELF TLS

- **Symptom:** installing on an Android 9 device fails with
  `INSTALL_FAILED_OLDER_SDK … Requires newer sdk version #29`.
- **Why it is NOT an overridable pin:** `libbare-kit.so` carries a **GLOBAL**
  undefined import of `__tls_get_addr@LIBC_Q` — native ELF thread-local storage,
  added to Android's libc in **Android 10 (API 29)**. On Android 9 the dynamic
  linker cannot resolve it, so the whole P2P engine fails to load. Lowering
  `minSdkVersion` + `tools:overrideLibrary` would only move the failure from
  install time to a `dlopen` crash.
- **How to verify a floor like this yourself** (works for any native dep): dump the
  undefined dynamic symbols with the NDK's readelf and look for versioned libc
  symbols newer than your target —
  `llvm-readelf --dyn-syms libfoo.so | grep -E "LIBC_(Q|R|S|T|U)"`
  (`LIBC_Q`=29, `R`=30, …). Zero hits = the manifest pin is conservative and may be
  overridable; a GLOBAL hit = hard floor.
- **Fire TV consequence:** Fire OS 7 devices (Android 9 — every 2018–2021 stick,
  incl. Fire TV Stick 4K Max 1st gen) **cannot run the engine**. Fire OS 8 devices
  (Android 11 — 2023 4K/4K Max, Cube 3rd gen, Omni/4-Series TVs) work. Most sticks
  are **32-bit** (`armeabi-v7a` only) — probe with
  `adb shell getprop ro.product.cpu.abilist` and build with
  `-PreactNativeArchitectures=armeabi-v7a` (bare-kit ships armv7 prebuilds).
- **Legacy flavor (`ALIRAN_LEGACY=1`) — the app below the floor, engine silent:**
  building with that env var set excludes `react-native-bare-kit` from
  autolinking (`client/react-native.config.js`) and drops `minSdkVersion` to 24,
  so the APK installs on Android 7–9 with the SDK **silently inactive**
  (`AliranBackend.isSupported()` → false; the app shows its unsupported notice
  instead of the eternal splash). Exclusion is what makes this safe: bare-kit is
  statically linked into `libappmodules.so`, so lowering minSdk while still
  linking it crashes at React init, before any JS. `client/android/settings.gradle`
  dirties the autolinking cache when the mode flips (the cache keys on lock-file
  hashes, NOT env — without that, flipping the env silently reuses the other
  mode's module set). After building, sanity-check the flavor:
  `unzip -l app-release.apk | grep bare` must be EMPTY for legacy, and
  `aapt dump badging app-release.apk | grep sdkVer` must say 24.
- **Why 24, not lower: React Native's own floor, enforced at build time.**
  Attempting minSdk 23 fails `:app:configureCMakeRelWithDebInfo` with prefab's
  `NoMatchingLibraryException: … User has minSdkVersion 23 but library was
  built for 24 [//ReactAndroid/hermestooling]` — RN 0.76+ ships all Android
  prebuilds built for API 24. So **Android 6 (API 23) cannot run any app on a
  current RN generation**, with or without the engine. The only path that could
  ever bring P2P itself below API 29 is upstream: Holepunch shipping
  pre-Android-10 bare-kit prebuilds without the ELF-TLS dependency.

## Debug builds on a physical device: point Metro over the LAN, skip `adb reverse`

- **Symptom:** debug build red-screens "Unable to load script" / "Could not connect
  to development server" even though `adb reverse tcp:8081 tcp:8081` succeeded.
- **Cause:** the reverse tunnel rides the adb transport; on a flaky link (wireless
  adb, USB that suspends) it dies in the seconds between app cold-start and the
  bundle fetch — you lose the race every time.
- **Fix — serve Metro over the LAN, no tunnel:**
  1. Debug builds ship a debug-only `src/debug/res/xml/network_security_config.xml`
     permitting cleartext (release keeps loopback-only) — the main config would
     block a LAN Metro with `CLEARTEXT communication … not permitted`.
  2. Point the app at your machine (debug builds are debuggable, so `run-as` works):
     write `<string name="debug_http_host">YOUR_PC_IP:8081</string>` into the app's
     default shared prefs via
     `adb shell run-as <appId> sh -c 'printf … > shared_prefs/<appId>_preferences.xml'`.
  3. Sanity-check reachability from the device first:
     `adb shell curl -s -m4 http://YOUR_PC_IP:8081/status` → expect HTTP 200.
- **Gotcha:** debug builds do **not** log `console.log` to logcat — `ReactNativeJS`
  is empty (output goes to Metro/DevTools). Use screenshots and on-screen state for
  verification; release builds still log to logcat.

## Installing a big APK over a flaky adb link

- Streamed `adb install` can die mid-push or return blank exit-255 on some devices
  (seen on Samsung); large pushes also silently TRUNCATE — `adb push` may print
  "1 file pushed" while the on-device file is short. Always verify with
  `adb shell stat -c %s`.
- The reliable recipe: build **single-ABI** first
  (`-PreactNativeArchitectures=arm64-v8a` — a universal RN debug APK ~425 MB drops
  to ~100-130 MB), then `split -b 20m app.apk chunk_`, push each chunk with a
  size-verify + retry loop, reassemble on-device
  (`cat /data/local/tmp/chunk_* > /data/local/tmp/x.apk`), verify the total, and
  `adb shell pm install -r /data/local/tmp/x.apk`.
- A blank exit-255 from `pm install` on a full, valid APK is often the link dropping
  before adb reads the status — the install may have SUCCEEDED; check
  `adb shell pm path <appId>` before retrying.
