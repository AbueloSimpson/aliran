# SDK installation & configuration

The complete setup and configuration reference for building a viewer on the Aliran
SDK. The [Player SDK overview](sdk.md) explains what the packages are. New to the
SDK? Start with [Build a player](build-a-player.md) — a complete walkthrough from
panel key to playing video, with runnable examples. This page is the working
manual: every install path, every option, every event, and the runtime controls.
For how *operator* actions flow into what your app sees, read
[Operator APIs & the SDK](ops-sdk-integration.md).

All packages are live on npm under the `@aliran` scope (MIT): `@aliran/core`,
`@aliran/player-sdk`, `@aliran/react-native`.

---

## 1. Installation

### Node (headless host)

```sh
npm install @aliran/player-sdk
```

- **Node ≥ 20.** The package is ESM (`"type": "module"`).
- **Host platforms with prebuilt natives:** Linux (x64, arm64), Windows 10+
  (x64, arm64), macOS 13+ (Apple silicon + Intel). `npm install` never
  compiles. The native stack (libsodium, the UDP transport, …) lands as
  prebuilds. If your platform/arch isn't in that list, there is no
  prebuild, and the engine won't load. For example, a Raspberry Pi 4/5 on
  a 64-bit OS is `linux-arm64` and works; the same board on a 32-bit OS
  does not.
- TypeScript definitions ship in the package (`index.d.ts`) — no `@types` needed.
- Nothing else is required to *serve* video. To *watch* it, point any
  HLS-capable player — ffplay, VLC, mpv, hls.js, ExoPlayer — at the
  localhost URL the SDK returns.

Smoke test (prints usage, proves the install resolves):

```sh
node -e "import('@aliran/player-sdk').then(m => console.log(Object.keys(m)))"
```

A complete runnable starting point is
[`examples/headless-player.mjs`](https://github.com/AbueloSimpson/aliran/tree/main/examples).

### React Native (phone + TV apps)

```sh
npm install @aliran/react-native react-native-video react-native-bare-kit b4a
```

Peer requirements and platform notes:

| Peer | Range | Notes |
|---|---|---|
| `react` | ≥ 18 | |
| `react-native` | `*` | Deliberately unpinned. TV apps install it as an npm **alias of `react-native-tvos`**, whose prerelease versions fail any strict semver range. With those, install with `--legacy-peer-deps`. |
| `react-native-video` | ^6 | Renders the HLS. |
| `react-native-bare-kit` | ≥ 0.13.3 | Hosts the engine worklet. Stock package **requires `minSdkVersion` 29**. The [lazy-load patch](#older-android-79-one-apk-the-engine-gates-itself-at-runtime) lowers it to 24 for single-APK builds. |
| `b4a` | ^1.6.6 | Buffer shim shared with the engine. |

**Engine floor: Android 10 (API level 29), 64-bit.** `react-native-bare-kit`
sets `minSdkVersion 29`, and the engine worklet simply cannot load on
Android 9 or older. This is a hard floor of the native P2P stack, not a
preference — `libbare-kit.so` needs ELF TLS, a libc feature added in
Android 10 (the full forensics are in the
[Android build KB](kb/android-build.md)). It applies identically to
phones, tablets, Android TV, and Fire TV: Fire OS 8 devices (Android 11
base) work, and **Fire OS 7 sticks (Android 9 base) do not**. The shipped
prebuilds cover `arm64-v8a` and `x86_64` (emulators) plus 32-bit ABIs for
custom builds, but the public APKs are 64-bit. The binding is exercised
on Android (phone + TV); iOS is not currently a supported target of the
shipped stack. The **SDK itself** runs below that floor — silently
inactive — see the next section.

#### Older Android (7–9): one APK, the engine gates itself at runtime

Fleets still run Android 7–9 set-top boxes. On those devices **no P2P
data is reachable at all**: swarm, catalog, and login all live inside the
native runtime that cannot load there (its ELF-TLS floor). So the SDK's
contract is *silent inactivity*, and your app supplies its own content
path — its "legacy mode", for example plain CDN/HLS URLs you deliver
outside this SDK.

**A single APK covers Android 7 → current.** Out of the box that is
impossible. `react-native-bare-kit` is a C++ TurboModule statically
linked into your app's `libappmodules.so`, so `libbare-kit.so` is
resolved **at React init on every device**. An APK that merely lowers
`minSdkVersion` crashes on Android 9 and older before any JS runs. Two
pieces fix it:

1. **Apply the bare-kit lazy-load patch** (patch-package):
   [`client/patches/react-native-bare-kit+0.13.3.patch`](https://github.com/AbueloSimpson/aliran/blob/main/client/patches/react-native-bare-kit+0.13.3.patch)
   — copy it into your app's `patches/` and add the standard
   `patch-package` postinstall. It rewrites the module's 22 `bare_*`
   calls to go through a `dlopen("libbare-kit.so")`/`dlsym` table,
   resolved lazily and **only on API 29+**, so no `DT_NEEDED` survives
   into `libappmodules.so`, and it drops the package's `minSdk` to 24.
   The engine still ships in the APK (`jniLibs` are untouched); below
   Android 10 it is simply never loaded, and a stray `init` throws a
   clean JS error instead of a native crash. Set your app's
   `minSdkVersion` to 24. (Until this behavior lands upstream in
   `react-native-bare-kit`, the patch is version-pinned — regenerate it
   when you bump the package.)

2. **Gate on `AliranBackend.isSupported()`.** On any Android below 10 it
   returns `false` by OS version alone. The SDK never consults,
   constructs, or loads the native module there, and the whole backend is
   inert: `start()` and every other method are safe no-ops, nothing
   throws, nothing queues, and no `onMessage` listener ever fires. Branch
   there, and use the SDK's ready-made **`<EngineNotice>`** screen in the
   unsupported branch. It gives you brandable copy and colors, plus an
   optional action button that is *your* seam for offering the viewer an
   alternative method — your own CDN/HLS playback, a help page. The SDK
   ships the notice and the switch, never the delivery:

   Complete working example. This exact pattern — notice, button,
   plain-HLS fallback via ExoPlayer — is verified on a Fire OS 7 stick
   (Android 9):

   ```tsx
   import React, { useState } from 'react'
   import { AliranBackend, EngineNotice } from '@aliran/react-native'
   import Video from 'react-native-video'

   export default function App () {
     const [fallback, setFallback] = useState(false)

     if (!AliranBackend.isSupported()) {
       // Engine can't run here (Android 7-9): offer YOUR delivery instead —
       // e.g. plain HLS from your CDN. The SDK never provides the content.
       if (fallback) {
         return <Video source={{ uri: 'https://cdn.example.com/live/main.m3u8' }} style={{ flex: 1 }} />
       }
       return (
         <EngineNotice
           title="Acme TV"                                      // your brand
           colors={{ background: '#0B1220', accent: '#0EA5E9' }}
           actionLabel="Watch over the internet"
           onAction={() => setFallback(true)}                   // the seam
         />
       )
     }

     // Full P2P path (Android 10+): backend.start(bundle, { panelPubKey }), etc.
     return <YourNormalP2PApp />
   }
   ```

   Omit `actionLabel`/`onAction` and it's a plain informational screen —
   that's what the shipped app does, since it has no non-P2P delivery.
   The action `Pressable` is D-pad focusable for TV, and
   `message`/`children` let you replace or extend the copy per brand.

The shipped app is the working reference: `client/android/build.gradle`
(`minSdk 24`), the patch in `client/patches/`, and the `isSupported()` +
`<EngineNotice>` branch in `client/src/App.tsx`. Verified with one APK on
an Android 7 emulator (installs, runs, engine silent) and on a modern one
(engine boots to `ready` through the dlopen path).

**Optional lean flavor.** If you want a smaller APK for old-device-only
fleets — the engine libraries are ~55 MB per ABI — excluding
`react-native-bare-kit` from autolinking builds an engine-less APK at the
same floor. `client/react-native.config.js` (`ALIRAN_LEGACY=1`) shows
how, and `client/android/settings.gradle` dirties the autolinking cache
when the flavor flips (the cache keys on lock files, not env).

Practical floor: **Android 7 (API 24)** — that one is React Native's, not
ours. RN 0.76+ prebuilds, including the 0.83 the shipped app uses, are
built for API 24, and the build system rejects a lower `minSdkVersion`
outright (prefab: *"User has minSdkVersion 23 but library was built for
24"*). So **Android 6 devices cannot run any app on a current RN
generation**, engine or no engine — for those fleets, use the **native
Kotlin SDK below**, whose floor is Android 5.0. The only thing that could
ever bring *P2P itself* below Android 10 is Holepunch shipping
pre-API-29 `bare-kit` prebuilds — an upstream ask; this patch is the
app-side half of exactly that design.

### Native Android (Kotlin) — `aliran-kit`, one APK from Android 5.0

> **Step-by-step version:** the [Kotlin SDK walkthrough](kotlin-sdk-walkthrough.md)
> builds the whole host app: the incompatibility hook, the notice, the
> dev-side CDN switch with complete code, and the P2P path.

For apps that don't use React Native — or for fleets below RN's own
Android 7 floor — **`sdk/android/`** in the repo is a native Kotlin SDK
with the same engine and the same contracts, in one APK,
**minSdk 21 (Android 5.0)**:

- On **Android 10+** it hosts the full P2P engine via Holepunch's
  plain-Java BareKit API (`to.holepunch.bare.kit.Worklet`/`IPC` — no RN
  anywhere). It runs the *same* bare-pack engine bundle, and speaks the
  same line-JSON IPC protocol as the RN binding.
- Below Android 10 the engine never loads. BareKit's `System.loadLibrary`
  sits in the Worklet class's static initializer, and the SDK simply
  never touches that class below API 29, so **no native patch is needed
  at all**. `AliranBackend.isSupported()` is `false`, with every call a
  silent no-op.

The pieces mirror the RN surface: `AliranBackend` (worklet host +
protocol), `AliranPlayerView` (Media3/ExoPlayer with the `<AliranVideo>`
contracts — ~1 s zap buffer, engine-driven tune lifecycle,
frozen-live-edge resync ladder with `reconnect()` escalation,
feed-rotation rebuild, vod transport), and `EngineNotice` (the fallback
seam). Usage:

```kotlin
if (AliranBackend.isSupported()) {
  backend.start(context, StartOptions().apply { panelPubKey = SERVICE_KEY })
  backend.onMessage { m -> when (m) {
    is BackendMessage.Ready -> backend.login(user, pass) // retry on "not connected" — ready can precede the panel link
    is BackendMessage.Streams -> showChannels(m.streams)
    else -> {}
  } }
  // then: playerView.attach(backend, streamId) — video renders via ExoPlayer
} else {
  // Android 5-9: your own delivery (plain HLS plays on ExoPlayer down to 5.0)
  setContentView(EngineNotice(context, title = "Acme TV",
    actionLabel = "Watch over the internet", onAction = { mountYourFallback() }))
}
```

Build notes: the library vendors the engine from the RN package's
checkout (`client/node_modules/react-native-bare-kit` — run
`npm install` in `client/` first), plus `libc++_shared.so` from the NDK,
and packages the engine bundle from `client/backend/app.bundle.js`.
`sdk/android/demo/` is the working reference host (copy
`service.example.json` → `src/main/assets/service.json`). Verified with
one demo APK: an **Android 5.1 emulator** (installs, notice + plain-HLS
fallback plays) and a **modern emulator** (full P2P: OPRF login over the
DHT against a production panel, catalog, live channel playing).
Old-device TLS caveat for your fallback CDN: **Android < 7.1.1 doesn't
trust Let's Encrypt's root** — use a classic certificate chain there.

Three things the host app must provide:

1. **The worklet bundle.** The binding has no build-time coupling to an
   engine build. You supply the engine as a [bare-pack](client-build.md)
   bundle — a base64 string or raw bytes — to `AliranBackend.start()`.
   The reference recipe (packing `@aliran/player-sdk` +
   `bare-fs`/`bare-http1` wiring into `app.bundle`) is the
   [client build guide](client-build.md); the shipped app's
   `client/backend/` is the working example.
2. **Cleartext to loopback** (Android release builds). The engine serves
   HLS on `http://127.0.0.1:<port>`, so release builds need cleartext
   permitted for loopback in the network-security-config. That is all
   the engine itself needs; the shipped app permits more, for a
   different reason (`http://` provider streams). A network security
   config governs the app's **outbound** requests only, so it has no
   effect on the **inbound** LAN server a cast session stands up.
   Details are in the [client build guide](client-build.md).
3. **Metro visibility**, when the package lives outside your app root
   (monorepo / `file:` install). Add its path to `metro.config.js`
   `watchFolders`, and map the peers in `tsconfig.json` `paths`. The
   shipped app's `client/metro.config.js` + `client/tsconfig.json` are
   working references. The package ships TypeScript *source*, so Metro
   consumes `.ts/.tsx` directly — no build step.

**Codec reality check.** The SDK passes streams through untouched
(`copy` end to end), so the *device* must decode whatever the operator
broadcasts. A lineup with HEVC/1080p channels needs HEVC-capable
hardware — see [source compatibility](kb/source-compatibility.md).

### Bare / custom runtimes

The engine core is runtime-agnostic. `player.js` takes injected
`{ http, fs }` modules and never imports Node builtins:

```js
import { AliranPlayer } from '@aliran/player-sdk/player.js'
import http from 'bare-http1'
import fs from 'bare-fs'

const player = new AliranPlayer({ panelPubKey, storeDir, http, fs })
```

`index.js` (`createPlayer`) is exactly this with `node:http`/`node:fs` wired in.
The Android app's worklet (`client/backend/backend.mjs`) is the Bare reference.

---

## 2. What you need from your operator

The SDK talks to a deployment, so three artifacts come from whoever runs the
[panel](operator-guide.md):

| Artifact | Where it comes from | What the SDK does with it |
|---|---|---|
| **Panel public key** (hex) | Printed at panel `init`; also in the panel's `keys/` | `connect()` derives the DHT topic and verifies every catalog read. The entire control plane is signed by this key. |
| **An account** (username/password) | `admin-cli add-user` or `POST /api/users` | `login()` runs the OPRF protocol against it. The password never leaves your process in plaintext. |
| **Grants** | `admin-cli grant` or `POST /api/users/:u/grants` | Decide which streams appear in the display list and which sealed keys the login can unseal. |

No URLs, hostnames, or ports are needed: discovery is the DHT, and
identity is the key. A viewer app config is typically just
`{ panelPubKey }` plus your own branding.

---

## 3. `createPlayer(opts)` — full configuration reference

Every option is optional except that a panel key must arrive either here or in
`connect(panelPubKey)`.

### `panelPubKey: string`
Hex panel public key (§2).

### `storeDir: string` — default `'./aliran-store'`
The on-disk replica cache. Treat it as **disposable**. Corruption from
unclean exits is detected (`EPARTIALREAD`, `OPLOG_CORRUPT`, …); the store
is purged, and the operation retries once. Everything re-replicates from
peers, and in-memory entitlements survive (the `recovered` event fires).
Place it in platform cache storage — for the RN worklet, the app files
dir; for Node, any writable path. Deleting it while stopped is always
safe; you lose only warm replicas.

### `reclaimBudgetBytes: number` — default 512 MiB
The ceiling on the **watched** feed's replica **on disk**. The engine
measures real allocated size, not logical length. When the feed being
served passes the budget, the engine **rotates** it: the replica is
purged and the feed is opened again. Deleting the files is the one
reclaim that needs no hole punching, so it frees bytes on every platform
— including the 32-bit Android ABIs, where the addon that punches the
holes is not shipped (it aborts the engine at startup there) and
`clear()` therefore reports success and frees nothing.

Three things this option does **not** do, each of which has surprised
someone already:

- **Only the served feed is measured against it.** An idle cached
  replica is never rotated, however large it is. Idle feeds are bounded
  separately, and by **two** other things: the store cap below, and
  `metaBudgetBytes / 4` — past a quarter of the metadata budget an idle
  feed is evicted outright, whatever its blob size and whatever this
  option says.
- **It silently moves a second bound.** The warm-cache cap is four times
  this value (2 GiB by default). Lowering `reclaimBudgetBytes` for a
  small device also lowers the cap, and idle feeds start being deleted
  sooner. `0` disables **this** bound and leaves the cap at its default.
  That cap is **not a hard ceiling on the store**: it is applied to the
  bytes this pass can actually evict, after the protected feeds (active,
  cast-pinned, VOD) have taken their share, and the warm cache is never
  trimmed below one feed's budget. One held feed alone can therefore hold
  the store above the cap for as long as the pin lasts, by design — the
  alternative purges the whole warm cache every minute and still never
  gets under. Size the device for the cap **plus** the largest feed it
  may hold.
- **The Android app now forwards it; the desktop engine does not.**
  `client/backend/backend.mjs` passes **128 MiB** (deriving a 512 MiB
  store cap), unconditionally and on every platform — it needs no ABI
  test because the hole-punch probe already switches the budget off where
  punching works, so on a 64-bit phone the value is unreachable rather
  than merely unused. The reason is the TV boxes: a 32-bit ABI cannot
  punch, so nothing shrinks a replica in place, and those are the same
  devices that ship 4 GiB of flash in total. The desktop engine still
  omits it and uses the 512 MiB default.

Values are checked, and the check **throws** rather than clamps: a
non-number throws, and so does any value above `0` but below 64 MiB. A
32 MiB budget is refused at construction, not raised to 64 MiB — the
misconfiguration has to surface where you can see it, because a tiny
budget rotates the served feed on almost every reclaim pass, which looks
exactly like a broken stream. `0` is always accepted.

**`0` here is no longer "do not rotate".** It switches off the *blob*
bound, and `metaBudgetBytes` below rotates the same feed on a trigger of
its own — deliberately gated on neither this option nor the hole-punch
probe. Opting out of rotation **entirely** takes both
`reclaimBudgetBytes: 0` **and** `metaBudgetBytes: 0`. This is a change in
what `0` means for an option that already existed; if you set it to opt
out of rotation, set the second zero too.

Requests park during the swap instead of failing, so a rotation is
**designed** to be invisible — but it is not guaranteed, and it can cost
the viewer a gap in three ways:

- **The park expires.** It is bounded at 2.5 s; past that a parked
  request falls back to a 404. That is the same black gap as before this
  bound existed, **delayed by up to the length of the park** — any park
  that can end in a failure shifts the player's retry ladder by its own
  length, and only not parking would avoid it.
- **The rotation reports success and the viewer still ate a remount.**
  The delete draws on the park's budget first, and the re-open then keeps
  a 1 s floor whatever is left of it. So once the delete passes 1.5 s the
  re-open runs past the end of the park: the parked requests wake to a
  feed that is not open yet, take the 404, and the player remounts — and
  *then* the re-open succeeds. Nothing throws, no recovery arms, and the
  `feed:rotate` event that follows reports a normal rotation. It was
  normal, for the disk. On the hardware this budget exists for (32-bit
  Android on low-end flash, unlinking a several-hundred-MB replica) this
  is uncommon but routine over a multi-hour session, not a corner case.
- **The refill after a clean swap.** The re-opened replica is empty, so
  the live window re-replicates at about 1x real time while the player
  drains its ~10 s buffer — a thin race even when the swap itself was
  fast. Measured on a 32-bit TCL box (2026-08-14, swaps 150-662 ms, park
  never threatened): two of six rotations froze the picture for ~2.5 s
  with no error and no remount, four were invisible. `durationMs` on the
  `feed:rotate` event cannot see this case — it measures the swap, not
  the refill.

**This value is a floor, not the ceiling.** The ceiling actually applied
is `max(reclaimBudgetBytes, 3 x observed live window)`, where the window
is measured from the playlist the reclaim pass already parsed. A flat
ceiling was wrong: `hls_list_size` x `hls_time` reaches 1920 s, where one
**healthy** live window at 2 Mbit/s is 458 MiB — 90% of the 512 MiB
default — and any channel above ~2.24 Mbit/s passes that default
outright. A flat budget therefore rotated healthy replicas in a loop.
Rotation is also rate-limited to one per five minutes per engine.

**A viewer whose filesystem can punch holes never rotates on *this*
bound**, enforced rather than assumed. The guarantee is about that
capability, not about the ABI. Before the budget is applied the engine
probes the store: it writes a scratch file, punches its middle, and
re-measures allocated size. If the punch frees bytes this budget is
switched off for the life of the handler.

It does **not** make rotation unreachable, and the older wording here
that said so is corrected rather than dropped: `metaBudgetBytes` rotates
the same feed past a metadata ceiling the punch cannot help with, and it
is gated on neither this probe nor `reclaimBudgetBytes`. On hardware that
punches — 64-bit Android, desktop — that is now the only rotation trigger
there is, which is exactly what it was added for.

So a 64-bit viewer is not exempt for being 64-bit. On exFAT, FAT32 or a
network mount the punch does not silently no-op — it **rejects**
(`EOPNOTSUPP` / `ENOTSUP`), the reclaim pass catches and frees nothing,
and the probe measures that. The budget stays armed there and the device
rotates, which is correct: a clear frees no bytes on those filesystems
either. **Silent** failure is the *other* case — the 32-bit Android
build, where the missing addon makes the delete report success and free
zero bytes. The engine has to treat the two differently: a rejecting
punch is proof the filesystem cannot reclaim, so the budget is checked
even when the pass did not complete; where nothing is proved either way,
it withholds and retries. An inconclusive probe (a transient I/O error,
or an allocation that has not settled) leaves the budget armed and is
retried — only a measured verdict is permanent.
Measured disk behavior: [viewer bandwidth](kb/viewer-bandwidth.md#disk).

### `metaBudgetBytes: number` — default 64 MiB
The ceiling on the **watched** feed's **metadata store** — the database
half of a replica, the index that maps paths to media blocks. It is the
one part of a replica the punch guarantee above does not cover, and it
grows on **every** platform: a followed live channel writes to that
database about 1.5 times per second (segment put, expired-segment
delete, playlist rewrite), the viewer's replica follows it for as long
as the feed stays cached, and a hole punch cannot free any of it — the
database's current keys reference interior nodes that live in old
blocks, so the engine never clears the metadata store in place. The only
reset is the same purge-and-reopen the rotation already does.

Measured on an always-on TV with a **working** hole punch (10 h soak,
2026-08-15): ~2.7 MB/h on the watched channel's metadata, ~1.1-1.2 MB/h
per warm idle feed, +12-17 MB/h store-wide — about 0.3 GB/day, filling a
box with 4 GB free in roughly two weeks, while the blob bound held the
active feed flat at ~128 MB. That is why this bound exists and why the
capability probe does **not** gate it: the device that punches perfectly
is exactly the device where metadata is the growth that remains.

Two thresholds come from the one option:

- **The watched feed** rotates through the same path as
  `reclaimBudgetBytes` when its metadata passes the full value — at the
  measured rate, roughly once per day of continuous same-channel
  watching. Any natural teardown (app restart, a zap away and back, a
  catalog re-key) resets the metadata for free and pushes that rotation
  out; the threshold exists for the always-on session that never tears
  down. The `feed:rotate` event names which bound asked
  (`trigger: 'budget' | 'meta'`).
- **Idle cached feeds** are evicted outright at a **quarter** of the
  value (16 MiB at the default), during the same maintenance pass as the
  store cap. Nobody is watching an idle feed, so the eviction costs the
  viewer nothing at the time and one fresh dial on the next tune of that
  channel; the engine records a `meta-evict` breadcrumb naming the feed.
  **At most one feed per pass**, and the pass runs every 60 s: the
  session this half is for warms the same prewarm lineup all session, so
  every idle feed crosses the threshold within minutes of every other,
  and uncapped, one pass would purge the entire warm cache in a single
  tick on a box with free disk. Capped, a full 12-feed cache drains over
  ~12 minutes instead. Disk *pressure* is the store cap's job, and that
  one is deliberately not capped.

Values are checked the way `reclaimBudgetBytes` is checked: a non-number
throws, anything above `0` but below **8 MiB** throws (a smaller number
schedules rotation churn without saving meaningful disk), and `0` is the
documented off switch — it disables both halves. It disables the
*metadata* bound, not rotation: the blob budget still rotates wherever
the probe leaves it armed.

**Nobody forwards this option, and that is the decision rather than an
omission.** `client/backend/backend.mjs` passes `reclaimBudgetBytes` (128
MiB) and deliberately does not pass this one, so every host — Android,
Android TV, desktop — takes the 64 MiB default. It is the right number on
the 32-bit televisions too: a rotation there resets the metadata as a
side effect of the blob bound it already hits, and 64 MiB is proportionate
to the 128 MiB blob budget those boxes run. Forward it only if you have
measured a device that needs something else.

**The bound switches itself off if a store cannot free the metadata.**
The purge behind a rotation degrades to a plain close when the
filesystem refuses it, and a degraded purge frees nothing — the replica
re-opens over the same metadata store, so the ceiling is still crossed
and the next verdict lands five minutes later, forever, each one costing
a re-dial and possibly a ~2.5 s freeze. So after a `'meta'` rotation the
engine re-measures the replica, and it disarms only on **both** signals
together: the purge itself rejected, **and** the metadata core is still
over the budget. Both, because a number on its own cannot tell a refused
purge from a purge that worked and a reading that is high for some other
reason.

And on **two consecutive** rotations, not one. A refusal is usually a
property of the filesystem and occasionally a moment — an `EBUSY`
unlink, a namespace another session still holds open — and the two leave
identical evidence, so the only thing that separates them is whether it
happens again. The second ask costs one more rotation five minutes later
on a store that would otherwise have rotated for the whole session.

When it does disarm it leaves a `meta-rotate-off` breadcrumb naming the
numbers, and it disarms **both halves**: the idle eviction purges
through the same fallback and frees the same nothing, so on a
purge-refusing store it would otherwise re-evict every warm channel once
per warm cycle for ever, paying a hang-up and a cold dial each time and
freeing nothing. A rotation that worked never disarms the bound, an
accepted purge resets the count, and a replica that cannot be measured
leaves it armed. The blob bound is untouched either way.

### `feedLimit: number` — default 12
How many feeds may stay **open** at once. This bounds *handles* — open
drives and swarm topics — so browsing a 300-channel catalogue cannot
leave hundreds of both open. It is **not** a disk bound, and reading it
as one is the common mistake: `prewarm` opens *connections*, and it is
playback that fills a replica, so a prewarmed channel nobody watched
holds essentially nothing.

Lower it only where a cached replica is **not** nearly free. Where the
filesystem can hole-punch, an idle feed settles at about one live window
and 12 of them cost almost nothing. On the 32-bit Android ABIs nothing
shrinks a replica in place, so every byte a *zapped-through* feed
replicated survives until eviction unlinks it — and there, fewer slots
genuinely means less disk.

The cost is paid on zap-back. Eviction **purges**, and a purged replica
does not re-attach to an already-established protomux: it needs a full
hang-up and re-dial, not just a re-download. A small limit turns
"flip between two channels" into that round trip every time.

Values below **2** are refused at construction rather than clamped. Two
slots can never be evicted — the active feed and a cast-pinned one — so
`1` cannot hold both, and `0` would leave a tune's in-flight open
protected only by its cache-slot claim. `3` is the smallest value with
any room to spare, and is what `client/backend/backend.mjs` passes on a
32-bit ABI (where it also caps `prewarm` to 3).

### `prewarm: boolean | number` — default `false`
Open entitled feeds' DHT topics right after login, so the **first** zap
to a channel skips the cold lookup. `true` warms all entitled feeds; an
integer warms that many, lowest curated `order` first. This is
bandwidth-cheap, since it warms *connections*, not downloads. Also
callable later as `player.prewarm()`.

On a 32-bit ABI the Android app caps this to **3** (see `feedLimit`
above). Warming more than the cache can hold is self-defeating anyway:
the opens past the limit are trimmed straight back out.

### `tune: { timeoutMs?, relookupMinMs?, relookupMaxMs?, rescanMs? }` — defaults 30 000 / 5 000 / (backoff) / 10 000
The tune self-heal ladder's knobs. One tune attempt is bounded by
`timeoutMs`. The first expiry evicts the cached feed open and retries
once. The second tears down wedged peer connections (transport-alive but
replication-dead) and dials fresh. Only then does a friendly `error`
surface (≤ ~90 s with defaults). While a tune is incomplete, forced DHT
re-lookups are paced between `relookupMinMs` and `relookupMaxMs`. Raise
`timeoutMs` only for genuinely slow networks — the ladder usually beats
waiting. The engine also emits `feed:reconnect` outside this ladder. It does
so when you tune a channel whose data it deleted from disk earlier: that feed
only replicates again over a fresh connection, so the engine drops the old
one first (see `docs/kb/playback.md`).

`rescanMs` guards the play **after** a successful tune. A viewer can tune
off relay peers while its dials to the origin fail — the swarm then
forgets the origin, and if the relays later disappear, nothing would look
for a source again for ~10 minutes. When the active live feed holds zero
peers for `rescanMs`, the engine emits `status` `feed:rescan`, forces a
fresh DHT lookup and re-arms the tune ladder. Set `0` to disable.

### `zapPrefetch: boolean | object` — default off ("Smooth zapping")
While a stream plays, keep the **newest segment** of the adjacent
channels (curated zap order) replicated locally, so CH+/CH− starts from
warm bytes. **This costs standing bandwidth** — about each warmed
neighbor's bitrate. That's why it's off by default, and why it's
designed to be a *user-facing* choice, not a silent default.

`true` enables the adaptive defaults; an object tunes them:

| Key | Default | Meaning |
|---|---|---|
| `neighbors` | 1 | How many channels on each side to warm. |
| `intervalMs` | 4000 | Warm-loop tick. |
| `directional` | `true` | Once the surf direction is known (an adjacent-channel move), warm only that side. This halves the standing cost for CH+/CH+/CH+ patterns. A menu jump resets to both sides. |
| `stallMs` | 12 000 | Suspend when the **active** playlist stops advancing this long (your own stream is starving). |
| `resumeMs` | 60 000 | Clean-advance run required before a stall/thin suspension lifts. |
| `minHeadroom` | 3 | Neighbor segments must download ≥ this × realtime, else the pipe has no room and prefetch suspends. |

The engine **suspends itself** — dropping the standing downloads, but
keeping the tick alive to observe recovery — on: a metered network
(`setNetworkProfile`), an active stream stall, or a thin pipe. It reports
every transition as a `zap-prefetch` event
(`reason: 'metered' | 'stall' | 'thin'`). Runtime-switchable with
`setZapPrefetch()`.

### `uploadPolicy: 'reseed' | 'client-only'` — default `'reseed'`
`'reseed'` joins feed/assets topics announced: blocks this viewer already
replicated are served back to other viewers on request. This is the
opportunistic upload that makes the P2P model work. `'client-only'`
joins **unannounced**: the peer is undiscoverable on those topics, so
other viewers can never dial it. That gives practically zero
viewer-to-viewer upload by construction, at the swarm-wide cost of one
fewer re-seeder. The viewer's own playback is unaffected. Switchable
live with `setUploadPolicy()` — the standard pattern is wiring it to the
platform's metered-network signal. Measured numbers:
[viewer bandwidth](kb/viewer-bandwidth.md).

### `remote: { sendToTv?, control?, keepSignIn? }` — default all off
The three "send to TV" features. **Every one is off unless you name it**,
so a build that omits this object joins no rendezvous, holds no account
keys and keeps nothing on disk.

| Flag | What it turns on | Cost while on |
|---|---|---|
| `sendToTv` | `sendSignIn()` — the **phone** half of a phone→TV sign-in. | Every login keeps the account's two private keys **in memory** for the session. `sendSignIn()` cannot recover them later without it. |
| `control` | `startRemote()` and the rest of "play on my TV". | The login keeps the account rendezvous secret in memory. With the flag off, no rendezvous topic is ever joined. |
| `keepSignIn` | The **receiving** half: a `signin-keys` event, so a television can persist the handover and come back through `signInWithKeys()`. | The host is given account private keys to write to a key store. This is a property of the *build*, not of a session. |

`remote: true` is shorthand for **`sendToTv` and `control` only** — the two
that are about memory. `keepSignIn` is about a disk and has to be asked
for by name, because a host that wanted `sendSignIn()` on a phone should
not silently get account keys at rest on a device that has a keyboard and
a password.

On a television the first two are usually the wrong way round from a
phone's: `sendToTv` **off** (a set never holds an account it could pass
on) and `keepSignIn` **on**. Read
[Account keys at rest](security-model.md#account-keys-at-rest-televisions)
before you turn `keepSignIn` on.

Casting needs no flag. It needs an injected `os` module (`createPlayer()`
wires `node:os`; a Bare worklet passes `bare-os`), or an `advertiseHost`
on every `startCast()` call.

### `swarm: { maxPeers?, bootstrap? }`
Tuning for the engine's single Hyperswarm. Ordinary viewers omit the whole object.

- `maxPeers` — total-connection budget (hyperswarm default 64, plenty for
  a viewer). SDK-based **seed nodes** and repeater-style hosts raise it
  into the hundreds, to hold big fan-out while re-seeding
  ([scaling](kb/scaling.md)).
- `bootstrap: [{ host, port }, …]` — custom DHT bootstrap nodes, for local DHT
  testnets or private-DHT deployments. Omit for the public DHT.

### `hybrid` — leave unset
A config-driven CDN↔P2P failover engine that predates
[redirect channels](content-management.md). It survives as e2e-harness
infrastructure and is **not a product path**. The default, `p2p-only`,
is the shipped behavior. The product CDN mechanism is the redirect
channel class, which needs no client config at all.

---

## 4. Runtime control surface

| Method | What it does |
|---|---|
| `connect(panelPubKey?)` | Join the panel topic, replicate the signed DB. Emits `ready`. |
| `login(username, password)` | OPRF login → display list. Throws `not connected to panel` while the swarm is still dialing. **Retry on that message** (see the pattern below). |
| `listStreams()` | Last display list (also re-delivered via the `streams` event). |
| `resolve(streamId)` | Serve an entitled stream; see §5 for the contract. |
| `source()` | `{ streamId, source, url }` of the active stream, or `null`. |
| `serveFeed(feedKey, encKey)` | Low-level direct-play from raw keys, no login (dev/diagnostics). Returns the port. |
| `assetUrl(path)` | Catalog art path → localhost URL (absolute `http(s)` URLs pass through). |
| `prewarm()` | Warm entitled feeds' topics now. |
| `setZapPrefetch(v)` | Runtime Smooth-zapping switch; applies mid-play, echoed as `zap-prefetch {enabled}`. |
| `setNetworkProfile({ expensive })` | Host network hint: `expensive: true` suspends zap-prefetch until the network is cheap again. Wire it to NetInfo (`isConnectionExpensive` / cellular). |
| `setUploadPolicy(policy)` | Live upload-policy flip. Re-joins active topics with the new announce flag, and tears down standing reseed connections **without blipping playback**. Resolves `{ policy, changed, rejoined }`, echoed as an `upload-policy` event. |
| `reconnectActiveFeed()` | Tear down the active feed's peer connections and dial fresh — the wedged-transport escalation; the tune ladder calls it for you. |
| `checkUpdate({ appId, platform, versionCode })` | OTA: look the running build up in the operator's update manifest → `{ status, entry?, mandatory? }` (`unknown` while the drive is still cold). |
| `downloadUpdate()` | OTA: fetch + sha256-verify the update the last `available` check found — throttled `update-progress` events, then `update-ready { path, entry }`. Operator side: [App updates](app-updates.md). |
| `stop()` | Full teardown. Ends a cast session and leaves the rendezvous first. |

Sign a television in from a phone (§9). All of it reports through the
`signin-pair` event; three of those states are **questions that block**
until the host answers.

| Method | Role | What it does |
|---|---|---|
| `startSignInPairing({ ttlMs?, pinMs?, payloadMs? })` | TV | Mint a code, announce its rendezvous, and resolve at once with `{ code, expiresAt, done }` to put on screen. Needs no panel connection first — the handover carries the operator key. |
| `submitSignInPin(pin)` | TV | The four digits the viewer typed on the remote. **One attempt**; a well-formed wrong answer ends the sign-in with the code spent. |
| `confirmSignInService(ok)` | TV | Answer the `confirm-service` question: sign in as that account, and (when `adopting`) take that operator key. |
| `cancelSignInPairing()` | TV | Abandon the code on screen. It is spent either way. |
| `sendSignIn(code, opts?)` | Phone | Sign a TV in with the code it shows. Resolves `{ done }` once the rendezvous is joined. Needs a live session **and** `remote: { sendToTv: true }`. |
| `confirmSignInMatch(ok)` | Phone | Answer the `match` question: do the four digits on this phone appear on the TV? **This is the check that sees a relay** — never default it, and never let a dismissed dialog answer it. |
| `cancelSendSignIn()` | Phone | Abandon an in-flight send. |
| `signInWithKeys(username, { priv, authPriv })` | TV | The same session entered with the account keys instead of a password — the door a television comes back through after a restart. Read the rejection rules below before you call it. |

"Play on my TV" (§10). Needs a live session and `remote: { control: true }`.

| Method | What it does |
|---|---|
| `startRemote({ role?, label?, acceptPlay? })` | Join the rendezvous the account's own devices meet on. `'tv'` announces and accepts commands; `'controller'` looks up, never announces, and sends them. |
| `listRemotes()` | Devices of this account that have **proved** themselves. Build a picker from the ones whose `role` is `'tv'`. |
| `remotePlay(deviceId, streamId)` | Ask a television to play a channel. Resolves on **acceptance** — what happened arrives as a status push. |
| `remoteStop(deviceId)` | Ask that television to stop. |
| `setRemoteAccept(ok)` | TV: the take-over switch, for the RUNNING session. Off refuses `play` **and** `stop`. Persisting it is the host's job — pass it as `startRemote({ acceptPlay })` too, or it is on again at the next boot. |
| `updateRemoteStatus({ state?, position? })` | TV: the two things only a host knows. The engine already publishes the channel and whether it plays. |
| `stopRemote()` | Leave the rendezvous. Idempotent. |

Cast to a television on the LAN (§11).

| Method | What it does |
|---|---|
| `startCast(streamId, { advertiseHost?, receiverHost?, readIdleMs?, reclaim? })` | Stand up a second, LAN-scoped media server for one channel and resolve a `CastSession`. Rejects when this device has no private IPv4. |
| `stopCast()` | Close the socket, kill the token, unpin the feed, run one reclaim pass. On a 32-bit Android build that pass frees no bytes — the store shrinks when the replica rotates or is evicted (`reclaimBudgetBytes`, §3). |
| `castSession()` | The live session, or `null`. |

The login retry pattern every host should use:

```js
let streams
for (let i = 0; ; i++) {
  try { streams = await player.login(user, pass); break }
  catch (err) {
    if (i < 30 && /not connected to panel/.test(String(err.message))) {
      await new Promise(r => setTimeout(r, 1000)); continue
    }
    throw err
  }
}
```

---

## 5. The `resolve()` contract

```js
const r = await player.resolve(streamId)
// r = { url, source: 'p2p' | 'cdn', localUrl?, port?, feedKey, headers?, type: 'live' | 'vod', durationSec? }
```

- **P2P stream** → `source: 'p2p'`, `url` = `localUrl` =
  `http://127.0.0.1:<port>/index.m3u8`. The feed replicates and is served
  progressively: bytes reach the player as they arrive, playlist requests
  are held briefly instead of 404ing, and the live edge is read ahead.
- **VOD title** (a library title, `type:'vod'` in the catalog) → same
  localhost serving, but the playlist is a **finished** VOD rendition
  (`#EXT-X-PLAYLIST-TYPE:VOD`, every segment listed, `#EXT-X-ENDLIST`).
  You can seek freely — any byte of any segment is Range-served and
  demand-paged over P2P — and pause indefinitely. `type` is `'vod'`, and
  `durationSec` carries the runtime (`null` if the catalog lacks it).
  **None of the live machinery arms**: no tune watchdog, no zap
  prefetch, and no `feed-changed` follow (a re-ingest applies on the
  *next* `resolve()`), and no `status`/`error` self-heal events for it.
  A stalled download is the host player's to surface, with
  `reconnectActiveFeed()` as the manual redial. Build seek/pause UI off
  `type === 'vod'`, never off a URL shape.
- **Redirect channel** → `source: 'cdn'`, `url` is the operator's remote
  URL **verbatim**, `localUrl`/`port` are `undefined`, `feedKey` is
  `null`. There is no feed, no swarm join, and no watchdogs —
  remote-URL errors belong to the host player. A hotlink-protected channel
  also returns `headers` (a lower-cased subset of `referer` / `origin` /
  `user-agent`) that the host player **must** send with every request for
  `url`, or the provider answers `403`. `headers` is `undefined` on every
  other branch and on redirect channels that need none. The value is live:
  a source refresh that rotates the URL and its headers reaches the viewer
  on the next tune, with no re-login. The RN player, the desktop app and the
  `aliran-kit` Kotlin binding do this for you; any other custom host must
  forward them (see [the SDK reference](sdk.md#redirect-channel-headers)).
- **Not entitled** → throws `not entitled to <id>`.
- **Entitled but no broadcaster feeding it** (`feedKey` null in the
  catalog) → throws `channel is not broadcasting right now` (for vod:
  `title is not available right now`). Show it as a friendly state, not
  a crash.

One localhost URL serves *whatever feed is active*: zapping re-uses the
same server/port. That's why the RN binding identifies the playing
channel by the engine's confirmation, never by URL. Do the same in
custom hosts.

---

## 6. Events reference

`player.on(name, fn)`. The emitter never throws on unhandled `error`.

| Event | Payload | Host action |
|---|---|---|
| `ready` | — | `connect()` finished; safe to `login()`. |
| `streams` | `Stream[]` | Render the lineup. Fires at login **and live** on any panel catalog edit (title/art/isLive/order/categories) — no polling, no re-login. A newly *granted* stream still needs the next login. |
| `status` | `{ state: 'feed:open' \| 'feed:ready' \| 'feed:retune' \| 'feed:reconnect' \| 'feed:rescan' }` | Drive a tuning indicator: `open` means a cold tune started, `ready` means playable, and `retune`/`reconnect`/`rescan` mean self-heal in progress. Say "reconnecting…" — don't freeze a spinner at a fake percentage. |
| `status` | `{ state: 'feed:rotate', streamId, message, trigger?, bytes?, meta?, durationMs?, skipped?, failed? }` | The viewer-disk rotation (§3, `reclaimBudgetBytes` / `metaBudgetBytes`): the engine purged and re-opened the active replica to free disk. Three shapes, told apart by **`durationMs` / `skipped` / `failed`** — not by `bytes`. **Success**: `durationMs` set, and `bytes` set but possibly `null`. **Refused**: `skipped: 'cast-pinned'`, no rotation happened. **Failed**: `failed: true`, the re-open died; the engine retries immediately and falls back to the tune ladder only if that also fails, so it is recoverable but worth logging. `trigger` names which bound asked and is set on **all three** shapes, the failed one included — that is the shape you investigate, so it is the one that has to be attributable: `'budget'` is the blob bound (fires only where the filesystem cannot punch), `'meta'` is the metadata bound (fires on any platform — a `'meta'` rotation roughly daily on an always-on device is the design working, while frequent `'budget'` rotations on hardware that should punch are worth investigating). On success **do not show a spinner** — requests parked across the swap and it is emitted *after* the swap anyway, so it is telemetry, not a cue. `durationMs` times the **whole** rotation, and the drain (≤6 s) and the measurement (≤5 s) both run *before* the park is armed, so a value above 2500 is **necessary but not sufficient** evidence that the park expired: a 3 s drain plus a 200 ms swap reports ~3200 ms with nothing ever parked. Treat it as a reason to investigate, not as a count of viewer-visible gaps — and note that a rotation can cost the viewer a remount while still reporting success (§3). `bytes` is **not** bytes freed: it is the replica's measured size *before* the purge, taken up to one reclaim tick plus the drain earlier, and `null` where the platform could not measure. Read it as an approximation of what the replica held; the feed re-downloads a live window straight afterwards. `meta` is the metadata store's share of that same measurement. |
| `peers` | `number` | Peer count of the served feed, every 3 s while serving. |
| `feed-changed` | `{ streamId, feedKey, url }` | The watched stream's feedKey rotated (broadcaster restart/rotation). The engine already re-resolved and swapped the served feed behind the **same** `url`. Reload or remount the player to flush the stale playlist. No re-login, no `resolve()` call needed. |
| `zap-prefetch` | `{ enabled? }` or `{ state: 'suspended' \| 'resumed', reason: 'metered' \| 'stall' \| 'thin' }` | Reflect the Smooth-zapping toggle / adaptive gate in UI if you surface it. |
| `upload-policy` | `{ policy, rejoined }` | Confirmation of a live `setUploadPolicy()`. |
| `recovered` | `Error` | Corrupt store purged + retried automatically; informational. |
| `error` | `Error` | Friendly, surfaced failures (e.g. the tune-timeout message). Show, offer retry. |
| `signin-pair` | `{ role, state, code?, sas?, pin?, username?, panelPubKey?, pairingCode?, adopting?, reason?, message? }` | Progress of a phone→TV sign-in (§9). Three states are **questions and the exchange blocks on them**: `match` (phone → `confirmSignInMatch`), `pin-entry` (TV → `submitSignInPin`), `confirm-service` (TV → `confirmSignInService`). `code`, `sas` and `pin` are live secrets for the length of the exchange — put them on a screen and **never in a log**. |
| `signin-keys` | `{ username, priv, authPriv, panelPubKey }` | The account keys a **received** handover was given, emitted **once** so a television can persist them and come back through `signInWithKeys()`. Fires only on a build with `remote: { keepSignIn: true }`. `emit()` is synchronous, so any retry of your own write belongs on your side of the listener — there is no second delivery. |
| `remotes` | `RemotePeer[]` | The account's own other devices on the rendezvous; re-emitted on every change. `deviceId`/`label`/`role` are each device's **own claim** — a handle for a picker, not a credential. |
| `remote` | `{ role, state, streamId?, restricted?, title?, command?, reason?, from?, status? }` | Role `'tv'`: the commands this device was given. Role `'controller'`: what a television it points at is showing. **`state: 'play'` is a command, not a notification** — the engine checked entitlement and deliberately did not tune, so the host tunes it, and a `restricted` channel **must** go through the same parental-PIN gate a local zap goes through. |
| `cast` | `{ state: 'ended', streamId, reason }` | A cast session ended **on its own** — the pinned feed was purged, or a retune abandoned or failed. The server is closed and the token is dead; stop showing "Casting". `stopCast()` does **not** emit this. |
| `fallback`, `source-changed` | see `index.d.ts` | Internal hybrid mode only — production apps never receive them. |

---

## 7. React Native binding configuration

### `AliranBackend`

```ts
const backend = new AliranBackend()
backend.start(bundle, opts /* StartOptions */)
```

`StartOptions` = `{ panelPubKey, hybrid?, prewarm?, tune?, zapPrefetch?, swarm?, uploadPolicy?, remote?, appVersion?, platform?, debug? }`.
These are the same knobs as §3, with two differences: `hybrid.cdnUrl`
must be a **template string**, since functions can't cross the worklet
IPC, and `debug: true` logs every backend message
(`adb logcat -s ReactNativeJS`). The worklet owns `storeDir`. `remote` is
**boot-time**: by the time a runtime switch could be flipped, the login
has already happened and the material is either kept or unrecoverable.

Methods: `login(u,p)` · `play(streamId)` · `playRaw(feedKey, encKey)` ·
`reconnect()` · `setZapPrefetch(v)` · `setNetworkProfile(expensive, cellular?)` ·
`onMessage(fn)` (returns an unsubscribe) · prefs: `requestPrefs()` /
`saveCredentials(u,p)` / `clearCredentials()` / `toggleFavorite(id)` /
`isFavorite(id)`.

Phone→TV sign-in (§9): `startSignIn()` / `submitSignInPin(pin)` /
`confirmSignInService(ok)` / `cancelSignIn()` on the television, and
`sendSignIn(code)` / `confirmSignInMatch(ok)` / `cancelSendSignIn()` on
the phone. `resumeSignIn()` is the next-start door on a build with
`remote: { keepSignIn: true }`; it answers `{ ok, error?, retry? }`, and
**`retry` is what decides whether to keep the stored material** — see the
rejection rules in §9.

`debug: true` **ships in release builds of the reference app**, so the
logger is production code, not dev instrumentation. It excludes every
`signin-*` and `vault-*` message by **prefix**. If you add messages that
carry a code, a PIN, a cast token or key material, exclude them by prefix
too — not by exact name.

The package also exports `secureKeyStatus()` and `secureReset()` from the
Android Keystore half. `secureKeyStatus()` **reports rather than finds
out**: it will not create a key in order to describe one, so a device that
never kept a sign-in answers `keyPresent: false` with an *unknown*
security level rather than claiming there is no hardware key store.

Cached state for late-mounting screens — the one-shot replies may land
before your screen exists: `backend.streams`, `.port`, `.url`, `.source`,
`.activeStreamId` (the engine-confirmed playing channel — the thing to
trust, since one URL serves every channel), `.creds`, `.favorites`.

Messages arrive as the `BackendMessage` union (`streams`, `port`, `status`,
`error`, `login-error`, `fallback`, `source-changed`, `feed-changed`,
`zap-prefetch`, `prefs`, `signin-pair`, `signin-started`, `signin-sending`,
`signin-ack`, `signin-resumed`) — all typed in the package. The engine's
sign-in vocabulary grows and this build's copy of it does not, so check a
`reason` against `isSigninPairError()` before you switch on it, and always
keep one sentence for the codes you do not recognise.

### `<AliranVideo>`

Chrome-free video surface. Overlays belong to the host app via callbacks
(`client/src/screens/LiveScreen.tsx` is a complete dogfooded example).

| Prop | Purpose |
|---|---|
| `backend`, `streamId` | Required wiring. |
| `autoPlay`, `paused`, `controls`, `style`, `resizeMode` | Standard surface control. |
| `onTune(e)` | **Drive your tuning indicator from this**, not raw player events. After a zap, the *previous* channel keeps playing under the same URL until the engine flips the feed. Phases per monotonic tune `id`: `start` → (`retune` or `reconnect` — self-heal, show "reconnecting") → `playing` — the first real playback of *this* tune, dismiss the indicator here. The friendly tune-timeout arrives via `onError` and ends the tune. |
| `onPeers`, `onBuffering`, `onSource`, `onError` | Status surface. |
| `onFeedChanged` | Informational — the component already remounts itself on feed rotation. |
| `onStall` | Fired when the frozen-live-edge self-heal kicks in: the playhead is still for `stallTimeoutMs` while "playing", which triggers a resync remount at the live edge, which escalates to `backend.reconnect()` if a resync mount doesn't play within another window. |
| `stallTimeoutMs` | Default 12 000 — the freeze detector above. |
| `bufferConfig` | Merged over the zap-tuned ExoPlayer defaults (playback starts at ~1 s buffered instead of ~2.5 s). Raise if your feeds need more headroom. |
| `selectedAudioTrack`, `selectedTextTrack`, `onAudioTracks`, `onTextTracks` | In-stream audio/subtitle track selection. |
| `videoProps` | Escape hatch: extra props onto the underlying `react-native-video`. |

### EPG (program guide)

Catalog entries may carry `epgUrl`/`epgId` pointers. Schedule data is
**never** in the replicated catalog. The binding ships the data layer:

```ts
import { useEpg } from '@aliran/react-native'
const { data, loaded } = useEpg(stream.epgUrl, stream.epgId) // { now, next[] }
```

`EpgService` (or the shared `epg` singleton) sits underneath: a per-URL
cache with ETag revalidation, so one fetch covers every channel sharing
the URL. Options (`EpgServiceOpts`): `maxBytes` (8 MiB), `minRefetchMs`
(5 min), `maxAgeMs` (3 h), `fetchTimeoutMs` (15 s), `nextCount` (4), plus
injectable `fetchImpl`/`now` for tests. Playback never depends on it — a
missing or unreachable feed just yields no guide.

### App updates (OTA)

The binding carries the whole in-app update path, so an SDK-based app
gets OTA with no native code of its own: `backend.checkUpdate(appInfo)`
and `backend.downloadUpdate()` drive the engine (subscribe with
`backend.onUpdate(fn)` for `update-status` / `update-progress` /
`update-ready` / `update-error`), and the package's native Android
module supplies `getAppInfo()` (the running build's identity),
`canRequestInstall()` / `openInstallSettings()` (the "install unknown
apps" gate), and `installApk(path)` (a PackageInstaller session; the
library manifest-merges `REQUEST_INSTALL_PACKAGES` into your app). The
operator flow is [App updates](app-updates.md);
`client/src/update.ts` + `UpdateBanner.tsx` are the dogfooded consumer.

---

## 8. Sessions, devices, and cooperative revocation

`login()` enrolls a device, subject to the account's `maxDevices` (the
oldest is evicted), and the panel signs a session token. Two helpers ship
for hosts that keep sessions across launches:

- `checkSession(panelPubKey, token)` — **offline**: signature + expiry → payload or
  `null`.
- `sessionLive(db, payload)` — **online**: checks that the device is
  still enrolled, with a matching `tokenVersion`, in the replicated user
  record. This is what notices an admin's per-device revoke — a
  well-behaved client drops to the login screen.

This is cooperative session hygiene, not content protection. Real access
revocation is grant removal plus stream-key rotation, on the operator
side ([details](ops-sdk-integration.md#8-what-revocation-really-means)).

**A device that holds a working credential signs itself back in.** That has
always been true of a saved password, and it is now also true of a television
that kept a handover (§9). Neither *revoke device* nor *log out all devices*
stops it. **Changing the password does**, because it re-keys the account. Read
[the residual-risk register](security-model.md#residual-risks-for-send-to-tv-play-on-my-tv-and-casting)
before you decide what your host app does with a refusal.

---

## 9. Sign a television in from a phone

A television has a remote control, not a keyboard. The set shows a
12-character code, the viewer types it on a phone that is already signed
in, and the phone hands the account over. The television registers **its
own device** and takes **its own panel-signed token**, so `maxDevices`,
the device list and per-device revoke keep working per device. The
password never crosses.

The operator key crosses with it, so one action both sets the service and
signs in — a set never types 64 hex characters, or the operator's own
pairing code, on a remote.

### The two halves

```js
// TELEVISION
const { code, expiresAt, done } = await tv.startSignInPairing()
showOnScreen(code)                       // 12 characters, ~3 minutes
done.then(streams => enterTheApp(streams)).catch(showFailure)

// PHONE (already signed in, built with remote: { sendToTv: true })
const { done } = await phone.sendSignIn(codeTheViewerTyped)
```

Everything else arrives on the `signin-pair` event. **Three states are
questions, and the exchange stops until you answer them.**

| State | Who sees it | What the host must do |
|---|---|---|
| `code` | TV | Show the 12 characters and the countdown. |
| `match` | **both**; answer on the **phone** | Show the four digits (`sas`). On the phone, ask "does the television show these same four digits?" and answer `confirmSignInMatch(ok)`. |
| `pin` | phone | Show the four digits (`pin`) for the viewer to type on the television. |
| `pin-entry` | TV | Ask for four digits and pass them to `submitSignInPin(pin)`. **One attempt.** |
| `confirm-service` | TV | Show `username`, `panelPubKey` and its printed `pairingCode`, say whether this set is `adopting` a new operator, and answer `confirmSignInService(ok)`. |
| `signed-in` / `failed` | either | Finish, or show `reason` and `message`. |

### Rules that are not optional

- **Never log `code`, `sas` or `pin`.** All three are live secrets for the
  length of the exchange. The React Native binding excludes every
  `signin-*` and `vault-*` message from its debug logger by **prefix** for
  this reason; if you add messages of your own, exclude by prefix too.
- **Never default the `match` answer, and never let a dismissed dialog
  answer it.** That comparison is the only check that sees a peer relaying
  between the two devices.
- **Do not describe this flow as phishing-proof, in your UI or your
  documentation.** The two checks remove a static lure and a silent relay.
  An attacker who is present in real time defeats both, and so does a
  viewer who approves without comparing. Say what the viewer must
  actually check.
- **Treat a mismatch as final.** Tell the viewer to stop, not to try
  again on the same network. Each attempt is an independent 1-in-10 000
  chance for a relay.
- Every failure **spends the code**. Mint a new one; do not retry with the
  old one.

### Keeping the sign-in across a restart

Set `remote: { keepSignIn: true }` **by name** and the engine emits
`signin-keys` **once** after a handover. Put those keys somewhere the
platform protects — the shipped app seals them under an Android Keystore
key — and come back through `signInWithKeys(username, keys)` on the next
start.

**Split the rejections, and let the default run toward keeping.** Erasing
is the one irreversible act here and it costs a viewer a walk to another
room for a phone.

| Keep and retry | Erase |
|---|---|
| `not connected to panel`, a closed channel, a swarm still dialling | `key handover does not match this account` (what a password rotation looks like from here) |
| A bare `unknown user` — the account record has not replicated to this device yet | A `session` verdict on the **account**: `account disabled`, `unknown user` |
| A key store that did not answer, or a host that did not answer in time | A stored record that fails its own integrity check |
| `device-limit` — the operator's slots are full, which frees itself | The operator this record names is no longer this device's operator |

**"Anything the panel said" is not the rule, and reading it that way
destroys credentials.** The same responder also answers `bad request`,
`no session challenge (login first)`, `missing deviceId`, `auth failed`,
`sessions unavailable` and `device-limit` — a malformed call, a lost
one-shot challenge, a panel missing its own signing key, an operator
whose device slots are full. None of those is a judgement on the keys.

**Bound your retries by panel logins, not by seconds.** Every attempt
that reaches the panel spends a `login` the panel's throttle counts, per
account and per peer. `not connected to panel` is thrown before anything
leaves the device, so those cost nothing. A loop that cannot tell the two
apart locks the account out of the panel it is trying to reach — and the
first thing it locks out is your own sign-in screen, seconds later, in
front of a viewer holding the correct password.

---

## 10. Play on my TV

Two devices of one account meet on a rendezvous derived from the account
key. There is no code and no viewer action. A television announces; a
controller looks up and never announces.

```js
await tv.startRemote({ role: 'tv', label: 'Living Room' })
await phone.startRemote({ role: 'controller', label: 'Ana’s phone' })

phone.on('remotes', peers => renderPicker(peers.filter(p => p.role === 'tv')))
await phone.remotePlay(deviceId, streamId)
```

**`state: 'play'` on the `remote` event is a command, not a
notification.** The engine checks the channel against the receiving
device's own entitlements and then deliberately **does not tune it**. Your
host tunes it — which is what keeps your own gates in front of it:

```js
tv.on('remote', async info => {
  if (info.role !== 'tv' || info.state !== 'play') return
  if (info.restricted && !(await yourParentalGate())) return   // NOT optional
  await tune(info.streamId)
})
```

**The parental-PIN gate is your obligation and the SDK cannot enforce
it.** An engine that tuned for the peer would make "play on my TV" the
documented way past that PIN. Where the engine cannot read the channel's
catalog record it refuses the play outright rather than guessing at the
flag, so it never reports a parental state it did not read — but where it
can read it, a host that ignores `restricted` has no parental control on
this path, and the engine cannot tell.

Two more things worth knowing before you build a picker:

- **`deviceId`, `label` and `role` are each device's own claim.** They are
  authenticated only as far as "some device of this account". The panel's
  device list is the authority on identity everywhere else.
- **The rendezvous cannot be revoked for one device.** Only "log out all
  devices", a password reset or disabling the account move the household
  to a new rendezvous. `setRemoteAccept(false)` is the per-set opt-out
  inside the protocol.
- **If you offer that opt-out, you own making it durable.** The engine has no
  prefs file, so `setRemoteAccept()` is session state: persist the viewer's
  choice yourself and pass it as `startRemote({ acceptPlay })`. Calling
  `setRemoteAccept(false)` *after* the join has resolved is too late — the set
  is announced and taking commands from the moment the join lands, so that
  spelling leaves a window on every boot. Call it for the running session and
  pass `acceptPlay` for the next one. The shipped apps do exactly this: the
  worklet keeps the preference beside the parental PIN and resolves it into
  its own `startRemote()`.

`remotePlay()` rejects with a `RemoteControlError`: `unknown` (not on the
list, or not a television), `unavailable` (it accepted and could not carry
the command out — a catch-all, most often a catalog record it could not
read, and **never** "nothing is broadcasting"), and `timeout`, which never
means the device declined.

---

## 11. Cast to a television

`startCast()` stands up a **second** HTTP server beside the loopback one.
It exists only while the session does, it binds **one private LAN
address**, and it serves only `/cast/<token>/…` from **one pinned feed
drive** — so the receiver keeps the channel it was given while the phone
zaps somewhere else.

```js
const s = await player.startCast(streamId, { receiverHost: '192.168.1.128' })
// s = { url, streamId, source, host, port, token, receiverHost, feedKey,
//       type, headers?, candidates? }
sendToReceiver(s.url)
player.on('cast', e => { if (e.state === 'ended') stopShowingCasting(e.reason) })
await player.stopCast()
```

A **redirect channel** casts for free: `source: 'cdn'`, `url` is the
operator's remote URL, and no local server is stood up. `headers` comes
with it when the provider checks them — a receiver that cannot send them
will get a `403`.

### What a host must get right

- **The token is a scope, not a secret the network keeps.** A receiver
  hands the whole media URL back to any unauthenticated peer that joins
  its session — measured on a real Google TV, where a process that had
  never seen the URL read it in full off port 8009. Pass `receiverHost`
  once you know which device you launched on: it makes the receiver's
  address part of the boundary. It is **off by default**, because the SDK
  does not speak the Cast protocol and cannot find that address. A
  multi-room **group** fetches from every member, so pass every member's
  address or leave the pin off for groups. An empty array **throws** — it
  is not a way to say "unpinned".
- **Treat "unpinned" as a state your UI acknowledges, not a default it
  inherits.**
- **Say what casting costs.** The phone becomes the origin server: it
  decrypts and serves while it does, it must stay awake and on the
  network, and disk grows by about the channel bitrate for the session
  (roughly 0.9 GB per hour at 2 Mbit/s), because block reclaim is off for
  a pinned feed. `stopCast()` reclaims; an app killed mid-cast does not.
  That is the same growth `reclaimBudgetBytes` bounds for an ordinary
  feed (§3), but a cast feed is pinned by design — so on a hole-punching
  filesystem `stopCast()` is the reclaim that ends it. **On 32-bit
  Android that pass frees nothing**, and a cast-pinned feed there has no
  disk bound at all while the pin lasts: rotation refuses a pinned feed
  and the store cap counts it as held. The bytes come back only after the
  pin is released and the replica is unlinked. Read
  [viewer bandwidth](kb/viewer-bandwidth.md#disk) before you ship casting
  on a 2-4 GB box.
- **Never log the token**, and never put it in an IPC message your debug
  logger prints.
- **Offer `candidates`.** `os.networkInterfaces()` cannot tell Wi-Fi from
  a Hyper-V, WSL or Docker bridge, so the advertised address is a guess.
  If a receiver never connects, offer another candidate and restart with
  `{ advertiseHost }`.
- **`advertiseHost` is the only thing that widens the bind.** An address
  this device does not own falls back to a bind on every interface, and
  nothing warns about it.

`startCast()` rejects when this device has no private IPv4 — it will not
advertise a public address. `readIdleMs` defaults to 12 000 ms here
(twice the loopback value, which is calibrated to ExoPlayer rather than to
a television); `0` disables the stalled-read abort.

The receiver application is Google's **stock Default Media Receiver**
(`CC1AD845`) — no registration, no fee, no hosted page. An operator who
wants a receiver with their own branding registers an application id of
their own and gives it to the sender; the bytes this SDK serves are the
same either way.

Full exposure analysis:
[the residual-risk register](security-model.md#residual-risks-for-send-to-tv-play-on-my-tv-and-casting).

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `login` throws `not connected to panel` | DHT still dialing — retry loop (§4). Persisting >30 s: wrong `panelPubKey`, or the panel is down/unreachable. |
| `channel is not broadcasting right now` | Catalog entry exists but no feedKey — the broadcaster hasn't fed it (or is stopped). Operator-side state; show it gracefully. |
| Tune-timeout errors on one channel | The channel may be unreachable or unseeded right now. The message suggests switching to it again — the ladder already evicted the poisoned open, so a re-zap retries fresh. |
| Black video, audio fine (or instant player error) on some channels | Device lacks the codec (HEVC lineup on an h264-only device) — [source compatibility](kb/source-compatibility.md). |
| Release APK can't play (dev build can) | Cleartext-to-loopback missing — [client build](client-build.md). |
| `recovered` events after crashes | Normal: the disposable store self-healed. Frequent recoveries = the host is killing the process uncleanly. |
| First zap slow, later zaps fast | Cold DHT lookup. Enable `prewarm`. |
| `sendSignIn` throws about a missing feature | The phone build was not constructed with `remote: { sendToTv: true }`. The flag is boot-time — restart the engine with it (§3). |
| No `signin-keys` event on the television | `remote: { keepSignIn: true }` must be asked for **by name**. `remote: true` is shorthand for the other two flags only (§3). |
| A television falls back to its sign-in screen on every start | Its stored keys are being erased, or the account is gone. Check your rejection classification against §9 first — treating any panel error as terminal destroys working credentials. A deleted account is kept, not erased, and re-creating the username evicts the set instead of restoring it. |
| `login failed: locked` on a television nobody is typing at | The restore loop spent the panel's login budget. Bound retries by **panel logins**, not by seconds (§9). Restarting the app clears it — the throttle's peer half is new for each process. |
| `startCast()` rejects with no private IPv4 | This device has only a public address, or no `os` module was injected. Pass `advertiseHost`. |
| The receiver plays nothing, or fetches the playlist and no segments | Cross-origin headers or the address. Check the receiver can reach `host`; if not, offer another entry from `candidates` and restart with `{ advertiseHost }`. |
| "Casting" stays on screen after the session died | Subscribe to the `cast` event: `{ state: 'ended' }` means the server is closed and the token is dead. `stopCast()` does not emit it. |

Deeper playback internals: [playback & client runtime](kb/playback.md) and the
[feed buffer & tuning](kb/feed-buffer.md) pages.
