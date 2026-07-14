# Playback & client runtime

Issues seen in the Android app / player SDK at runtime. For build-time problems see
[Android & React Native builds](android-build.md).

## Posters and video silently fail to load (blank tiles, no error anywhere)

- **Cause:** Android API 28+ blocks cleartext HTTP by default, and the app serves
  media and art from `http://127.0.0.1:<port>` (the embedded P2P node). Image loaders
  and ExoPlayer fail *silently*.
- **Fix:** a `network_security_config.xml` permitting cleartext **only to loopback**
  (plus the emulator host aliases for Metro in dev), referenced from the manifest.
  The app ships this — see [Client build](../client-build.md).
- **Diagnostic that isolates it:** `adb forward tcp:<x> tcp:<port>` + `curl` from the
  host returns 200 while the app shows nothing.

## Playback fails with `OPLOG_CORRUPT: Oplog file appears corrupt or out of date`

- **Cause:** the app process died mid-write (crash, force-kill) and corrupted the
  local Corestore replica cache. Without recovery this is permanent until app data is
  wiped.
- **Fix (shipped):** the engine detects corruption codes (`OPLOG_CORRUPT`,
  `INVALID_CHECKSUM`, …) on open *and* read, purges the whole store, and retries once
  (`sdk/recover.js`, exercised by `npm run test:corrupt`). The store is a **disposable
  replica cache** — everything re-replicates from peers and the in-memory session
  survives, so no re-login is needed.
- **Manual fallback (always safe):** clear the app's data/storage — same reasoning.

## Login spins forever on "not connected to panel" / "Cannot reach the service"

In likelihood order:

1. **The panel is wedged or down.** Verify from another machine with a small
   hyperswarm read of `catalog/*` *before* blaming the client. A wedged panel can
   look alive in the process list while answering nothing — restart it (see
   [Operating the panel & broadcaster](operator.md)).
2. **First DHT dial after a fresh install legitimately takes 30–90 s.** The login
   screen retries for about a minute, then gives up — pressing Sign in again restarts
   the retry loop.
3. **Stale swarm state on the device** after the panel restarted or the app's data
   was cleared mid-session: force-stop and relaunch the app (retrying inside the app
   is not enough — the embedded node needs a fresh swarm).
4. Device network says connected but isn't validated
   (`adb shell dumpsys connectivity | grep -i validated`).

## Player shows black + spinner right after opening a channel

- **Normal for a few seconds:** the playlist 404s until the live edge replicates from
  peers; the player auto-retries every 2.5 s.
- **Persistent spinner >30 s with `0 peers`:** no seeder is reachable — the
  broadcaster is down, or its ffmpeg ingest died while the process kept "seeding" a
  frozen playlist. See [operator health checks](operator.md#dev-processes-rot).
- With the **hybrid CDN↔P2P** policy configured, this case instead triggers a
  `fallback` to the CDN URL (and auto-returns later) — see the
  [player SDK README](https://github.com/AbueloSimpson/aliran/tree/main/sdk).

## App dies the moment the player seeks / switches source / closes (worklet SIGABRT)

- **Symptom:** the whole app exits; logcat shows
  `Uncaught StreamError: Writable stream closed` and an abort inside the Bare runtime.
- **Cause:** video players routinely abort in-flight HTTP requests. Writing into the
  closed response was an unhandled stream error — and *any* uncaught exception in the
  embedded worklet aborts the entire app process.
- **Fix (shipped):** the media server tolerates client aborts on every path, and the
  worklet installs a last-resort `uncaughtException` guard that reports the error
  over IPC instead of crashing. If you embed the SDK in your own runtime, keep both.

## Reading the app's own diagnostics (dev builds)

Every backend→UI IPC message is logged: `adb logcat -s ReactNativeJS` shows
`[backend] {"type": ...}` lines, including `feed:open` / `feed:ready` breadcrumbs,
peer-count ticks, `fallback` / `source-changed` events, and `store:reset` (corruption
recovery). Read these before guessing from the screen.
