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
