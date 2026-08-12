# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the **concise summary**. The full chronological build history — every
milestone with its verification narrative — lives in
[docs/devlog.md](docs/devlog.md).

## [Unreleased]

The cumulative pre-1.0 state (no version has been cut yet). Every item below is
implemented and covered by an e2e or unit suite, and — with the exception noted on
the first three items — everything that touches the runtime is verified on real
infrastructure (a VPS over the public DHT, a physical Android phone + Android TV,
and the Windows desktop player). **"Send to TV", "play on my TV" and casting have
not been on a television yet**; each says so where it is described.

### Added

- **A rail per sport, derived from the playlist (`autoSubcategory`).** A provider
  puts every sport of the day inside ONE `group-title` and writes the sport into the
  entry NAME — `[MLB] Boston Red Sox at Toronto Blue Jays | TOR Feed`. Until now the
  only way to get a rail per sport was to point SEVERAL m3u sources at the same URL,
  each with its own `titleInclude "[MLB]"`, its own two-level `category`, its own
  prefix, plus a catch-all on `titleExclude`. That works and it goes STALE: the list
  refreshes every few minutes and the sports in it change through the day, so a
  hand-written source-per-sport list stops covering what the provider carries — a
  source for a finished sport imports nothing, and a sport nobody planned for gets no
  rail at all.

  `autoSubcategory` (m3u only, default OFF) reads the sport off each entry instead:
  ONE source, no sport configured anywhere, and `[MLB] …` lands in `Live Events/MLB`
  the moment the provider first carries it. Only the LEADING tag is read, and casing
  folds so `[MLB]` and `[mlb]` are one rail rather than two. There is deliberately NO
  allowlist of known sports — a fixed list would go out of date exactly the way the
  source list does — so any leading tag becomes a rail.

  Because the tags are third-party text, they are bounded rather than trusted: `/` is
  stripped (it would forge a third level out of a channel name), control characters
  and whitespace runs are normalised, a tag over 32 characters is read as a
  description rather than a label, and at most 50 distinct rails are derived per sync.
  Every one of those cases keeps the entry on the source's own category, which is also
  where an untagged entry goes, so the feature can never cost a channel — the worst
  outcome is the rail the operator configured. The sync report names the rails it
  derived (`subcats`) and counts what the cap pushed back up (`subcatOverflow`).

  The flag ADDS the second level, so it is refused on a `Parent/Child` category —
  including on the edit that leaves the flag alone and makes the CATEGORY two-level,
  since three levels would render in the apps as a rail literally named "MLB/NFL".
  Turning it on re-stamps existing channels in place (same ids, so grants survive)
  rather than replacing them. No client change was needed: two-level categories were
  already drill-in sub-rails, and a `category:Live Events` package selector already
  covers every child of that rail. Covered by `npm run test:sources` (section L5).

- **Sign in a television from a phone ("send to TV").** A set shows a
  12-character code, the viewer types it on a phone that is already signed in,
  and the phone hands the account over the connection the two devices share. The
  password never crosses; the operator key does, so one action both sets the
  service and signs in — nothing 64 characters long is ever typed on a remote.
  The television then runs a **full login of its own**: its own `deviceId`, its
  own panel-signed token, so `maxDevices`, the device list, per-device revoke and
  the activity feed keep working per device. Two viewer checks gate the payload
  and they catch **different** attackers — four **compared digits** (a relay holds
  two connections with two handshake hashes, so its two sets disagree) and an
  **entered PIN** typed on the set (a code shown with no real television behind it
  has nowhere to receive it) — with commit–reveal nonces so neither side, and no
  relay, can choose its half after seeing the other's. A relay's chance is a flat
  1 in 10 000 per pairing, every failure spends the code, and the PIN gets one
  attempt. **It is not phishing-proof**: an attacker present in real time defeats
  both checks, as does a viewer who approves without comparing, and the docs say
  so. A set with no operator yet shows the account, the key and that key's printed
  pairing code and waits for a person; a set that already has one refuses a
  different one without asking. New: `startSignInPairing()`, `sendSignIn()`,
  `submitSignInPin()`, `confirmSignInMatch()`, `confirmSignInService()`,
  `signInWithKeys()`, and a `signin-pair` event stream. Lanes:
  `test:signin-pair`, `test:remote-core`.

  **A handed-over television survives a restart.** With `remote: { keepSignIn }`
  — off unless asked for **by name** — the engine emits the account keys once, and
  the app seals them in the Bare worklet under a fresh key per write, wrapped by
  an AES-256-GCM key in the **Android Keystore**. The set erases what it holds
  **only on proof** that it can never work (the key store refusing, a record
  failing its own check, an operator it has left, or a panel verdict on the
  account); a key store that did not answer, a swarm still dialling and an account
  record that has not replicated yet all keep and retry. Retries are budgeted in
  **panel logins** rather than seconds, so a set can never lock its own account —
  or the sign-in screen a viewer is standing at — out of the panel. **The
  credential that crosses is permanent, not a session: only a password reset
  re-keys it**, and that is now written down where an operator will find it.
  Lanes: `test:signin-vault`, `test:signin-resume`.

- **"Play on my TV" — handoff between two devices of one account.** They meet on
  a rendezvous derived from the account key: no code, no viewer action, a
  once-a-day roll, and a controller that looks up without ever announcing, so a
  phone publishes no address and two televisions never meet. Membership is proved
  with a MAC over the connection's handshake hash, and nothing about a device is
  sent until the other side's proof verifies. A phone tells a set what to play and
  the set pulls P2P itself, so **no video crosses between them**. The engine
  checks entitlement and then deliberately **does not tune**: it hands the command
  to the host with `restricted` on it, so a parental PIN stays in front of a
  restricted channel — and where it cannot read the channel's record it
  **refuses** rather than guessing at the flag. A television can refuse the whole
  arrangement — Settings → "Play on this TV" → *Let my devices change this TV* —
  and that preference is **persisted** beside the parental PIN and applied inside
  the join, because a switch that forgot itself at the next boot would be a
  mitigation that lies about itself. It is also the one toggle in the app that
  never paints optimistically: the set reports what a reboot would restore. A
  television publishes what only a host can know — a pause and the playhead of a
  title — and retracts a pause when the viewer zaps away from it. New:
  `startRemote()`, `listRemotes()`, `remotePlay()`, `remoteStop()`,
  `setRemoteAccept()`, `updateRemoteStatus()`, `stopRemote()`, plus `remotes` and
  `remote` events. Lanes: `test:remote-control`, and the client suites
  `AcceptRemoteToggle` / `RemoteStatusHost`.

- **Cast a channel to a Chromecast or Google TV.** `startCast()` stands up a
  **second** media server that exists only while a session does, binds **one
  private LAN address** (a device whose only address is public is refused, by
  name), and serves only `/cast/<32-byte token>/…` from **one pinned feed drive**
  — so the receiver keeps the channel it was given while the phone zaps somewhere
  else. Everything else 404s, including `/assets/*`, `/epg/*` and
  `/feedthumb/*`. The loopback server of ordinary playback is unchanged and still
  refuses `/cast/*`; the one behaviour that did change is that both now answer
  **405** to methods other than GET and HEAD. Block reclaim is **off** for a
  pinned feed — a receiver that falls below the live window can only be served
  from this device's replica — and `stopCast()` runs one reclaim pass itself.
  Three findings came from real equipment rather than from reasoning: the stock
  **Default Media Receiver** (`CC1AD845`) plays an `http://` LAN URL, so no Google
  registration, fee or hosted page is needed; **cross-origin headers are
  required** (without them the receiver fetched the playlist and zero segments);
  and **the cast URL is readable off the television by any unauthenticated peer on
  the network**, which makes the token a session *scope* rather than an access
  boundary. `startCast({ receiverHost })` pins the session to the receiver's
  address and is the mitigation; it is off by default, because the SDK does not
  speak the Cast protocol and cannot discover that address. Redirect channels cast
  with no local server at all. New: `startCast()`, `stopCast()`, `castSession()`
  and a `cast` event. Lane: `test:cast`.

  ⚠ **None of these three has been seen on a television.** The engine work is
  covered by lanes that run on a desktop against a local panel or a local DHT, and
  the measurements above were taken with a laptop and one set, on firmware it has
  since replaced. Exposure, measurements and the operator levers are in
  [docs/security-model.md](docs/security-model.md#residual-risks-for-send-to-tv-play-on-my-tv-and-casting).

- **M3U playlist sources + redirect-channel playback headers — carry
  hotlink-protected, token-rotating provider lists (e.g. live-event playlists).**
  A remote source now takes a `format`: `json` (unchanged) or `m3u`, a standard
  playlist parsed dependency-free (`#EXTINF` attributes, `#EXTVLCOPT`
  referrer/origin/user-agent lines, `#EXTGRP`). M3U entries become redirect
  channels with name-slug ids (playlist `tvg-id`s are routinely dummies), no EPG
  pointers (a playlist is not a guide), and an optional `groups` filter
  (case-insensitive exact `group-title` match; the sync report counts `filtered`
  entries honestly). A mixed-category playlist is handled with no new code: add N
  sources over the same URL, each with disjoint `groups`, its own `category`, and
  its own `prefix`. Redirect channels — imported or manual — gain a `headers`
  field (strict `referer`/`origin`/`user-agent` allowlist, lower-cased, CR/LF
  refused, headers-without-url refused) that rides login → `resolve()` and reaches
  a viewer on the next tune, so a rotated token URL needs no re-login. The
  **React Native** player passes them to `react-native-video`; the **desktop** app
  injects them from its main process (hls.js cannot set forbidden headers) and
  patches `Access-Control-Allow-Origin`. The scheduler tick default drops to
  5 minutes so a sub-hour per-source `intervalMs` (a 30-minute event refresh) works
  out of the box. Surfaced across admin UI/CLI, `panel_add_source`/`panel_set_source`,
  and `panel_add_stream`/`panel_set_stream_meta`. **Known gap:** the
  `sdk/android/aliran-kit` Kotlin binding does not send redirect headers yet, so
  header-protected channels `403` there until a follow-up. See
  [content-management.md](docs/content-management.md#playlist-m3u-sources) and
  [sdk.md](docs/sdk.md#redirect-channel-headers).

- **Live channel thumbnails — a rolling preview frame in every channel's feed
  drive.** The broadcaster's ffmpeg writes a ~320px JPEG (`/thumb.jpg`) beside the
  segments every `THUMB_INTERVAL_SECONDS` (default 30); each refresh replaces the
  drive entry and frees the superseded blob, so disk stays flat (proven by the new
  `test:thumbs` lane). Viewers get `thumbBase` per stream and a `/feedthumb/<id>`
  loopback route that serves from already-warm feeds (never evicts, never opens
  drives on metered networks, never parks a request); channel lists in both apps
  show the live frame and fall back to poster/logo art on 404. Cost-aware
  defaults: `copy` channels are **opt-in per channel** (a thumbnail forces the
  decoder on, ~0.9 % of a core each even with `-skip_frame nokey`), transcoding
  channels get it ~free and follow the fleet default; `THUMBS=0` is the kill
  switch. GPU-decode channels download frames off the card before the software
  scaler; video-less (audio-only) sources are detected and never get the
  thumbnail output; the viewer-side disk reclaim knows to spare the thumbnail.

- **EPG over P2P — a standalone `epg/` service + epoch-rotated guide drive.** The
  program guide now replicates peer-to-peer: the new service ingests schedules
  (pluggable providers: the provider-JSON feed shape or a local file; XMLTV-ready
  contract), writes per-channel-per-day files into a public Hyperdrive, and
  publishes the drive key through the panel's new publisher-scoped `setEpgKey`
  RPC as ONE `meta/epgKey` record. Viewers sparse-fetch only the days they show
  (loopback `/epg/*` with drive-version ETags → 304 polls) and fall back to the
  https `epgUrl` path unchanged; the drive is epoch-rotated (~monthly, one bee
  block each) so guide churn never grows the catalog log. The repeater gains
  `EPG=1` (full raw guide mirror) and `ANNOUNCE=1` (advertise on the catalog
  topic), so cold viewers can bootstrap the channel list AND guide with the panel
  offline — proven by the `test:epg-p2p` lane (ingest → pointer → sparse serve →
  rotation → warm-offline → cold bootstrap via repeater). See
  [docs/epg-service.md](docs/epg-service.md).

- **A playing channel now finds a new source by itself when all of its peers
  disappear.** A viewer can tune a channel entirely off relay peers while its
  connections to the origin broadcaster fail — the networking layer then stops
  retrying the origin and forgets it, so when the relays later went away the
  viewer froze with no source, no error, and no new lookup for up to ten
  minutes (seen in the field on a phone). The player engine now watches the
  active channel's peer count after a successful tune: if it stays at zero for
  ten seconds, the engine emits a `feed:rescan` status, runs a fresh peer
  lookup, and re-arms the normal tune recovery ladder. In the reproduction
  harness a stock viewer never re-connected inside 75 seconds; the fixed
  viewer re-sources in about 12 seconds with no help from the app. New SDK
  option `tune.rescanMs` (default 10000; 0 turns it off) and a testnet-local
  regression lane, `npm run test:resource`.

- **The desktop parental controls now have automated tests.** A channel the
  operator marks as restricted is hidden from viewers by two small functions, and
  on the desktop side nothing was checking them — the phone app has had a test
  suite for this since the feature shipped, but the desktop copy had none, so a
  change there could have quietly un-hidden a channel. The new checks cover what
  a viewer actually experiences: a restricted channel does not appear at all
  until a PIN is set, it is listed but asks for the PIN once one exists, the hide
  toggle folds it away again, a single unlock covers the session, and the right
  PIN opens it while a wrong one does not. Two more are there for safety: the
  stored record never contains the PIN itself, and a damaged or unreadable
  settings record keeps restricted channels hidden rather than exposing them.
  The rule the phone and the desktop share is compared between the two copies, so
  the apps cannot drift apart on what a viewer is allowed to see.

### Fixed

- **The documented first-time bootstrap command reported success and created no
  admin.** `docker-compose.yml` and `docs/reseller-panel.md` documented
  `add-admin <name> <password>`, but every CLI takes the password as a **flag**.
  The positional argument was parsed and silently dropped, and the CLI fell through
  to its hidden prompt. With a terminal, the operator was asked for a password they
  believed they had already given, and the account ended up with whatever they
  typed — not the value in the command. With no terminal (a script, CI, or
  `docker compose run -T`), it was worse: `readline` with `terminal: true` on a
  non-TTY stdin never fires its question callback, so the promise never settled,
  the event loop drained, and node exited **0** having written nothing. A bootstrap
  line like `… add-admin bob "$PW" && echo ok` printed `ok` with no admin created.
  A silent false success, at first-time setup, on all four CLIs
  (`panel/admin-cli.js`, `broadcaster/control-cli.js`, `library/library-cli.js`,
  `reseller/reseller-cli.js`).

  The password verbs now refuse a stray positional argument and name the three real
  forms, and the refusal never echoes the stray value back — it is almost certainly
  the password, and stderr here lands in docker logs, CI logs and scrollback.
  `reseller mint <name> <amount>` still takes its two positionals, so the check
  lives in the password verbs rather than in the argument parser. A prompt with no
  terminal now fails loudly instead of exiting 0, and — so that automation is not
  pushed onto the flag, which puts the password in argv where `ps` and the shell
  history show it — a prompt with no terminal reads the secret from a **pipe**:
  `printf '%s\n' "$PW" | … add-admin bob`. Successive prompts consume successive
  lines, so `export-escrow`, which asks twice, is scriptable the same way for the
  first time. The docs now lead with the plain prompting form (`docker compose run`
  allocates a terminal by default) and give the pipe for scripts. New regression
  lane `npm run test:cli-password` pins the exit codes, not only the messages.

- **A crash mid-write could truncate a JSON registry, including the ones holding
  keys** — every registry write was a plain `writeFileSync` straight onto the live
  path, which truncates the file to zero before refilling it. An OOM kill, a
  segfault, a power cut, or a `docker stop` that outran the stop grace could leave
  the file half-written, and there was no recovery except restoring a backup. The
  worst cases were the broadcaster's `channels.json` — every channel's config plus
  its push stream keys, SRT passphrases and CENC keys — and the panel's
  `secrets/streams.json`, the per-stream keys that user grants are sealed against:
  losing it makes every existing grant worthless. The broadcaster made this quieter
  than it looked, because it treated an unreadable registry as an empty one and
  booted with no channels at all. Protection existed already, but only on the
  analytics rollups and the viewer problem reports — the most disposable data in
  the system. Every file of this kind now writes through one shared helper
  (`@aliran/core/atomic-write.js`) that writes a sibling temp file, flushes it to
  disk, and renames it over the target. A reader sees either the whole old file or
  the whole new one, never a mix, and a write that fails leaves the previous file
  in place. Secrets files get their `0600` mode when the temp file is created
  rather than after the rename, so the keys are never briefly readable by other
  local users — the trap in the old code, where the `mode` option was silently
  ignored on a file that already existed.

  The same treatment now covers the write-once files, where a torn write is worse
  than it sounds because a half-written key still *looks* valid: the panel signing,
  OPRF and publisher keys, the broadcaster and library control keypairs, a
  channel's `feed.key` (its feed identity — every grant is sealed to it), and the
  reporter pseudonym salt. It also covers the two escrow paths, so an interrupted
  export can no longer leave a backup that will not restore, and the reseller
  ledger's torn-tail repair, which rewrites the entire transaction history to drop
  one damaged line and could previously turn a one-line crash into a total one.

- **Owner-only data directories were never actually made owner-only** — the panel,
  broadcaster and library all ask for mode `0700` on the `keys/` and `secrets/`
  directories that hold their private key material. That mode only applies to a
  directory the code has to *create*, so on every deployment made before those
  lines landed the directories kept whatever they were installed with — typically
  `0755` — and no amount of asking again would change it. The files inside were
  always `0600`, so this exposed file *names* rather than contents, and not at all
  where the services run as a single user; it was a gap between what the code said
  and what was on disk. The mode is now applied to an existing directory as well
  as a new one, and repaired at start-up for the `keys/` directories, whose files
  are written once and would otherwise never be revisited. Permissions are only
  ever narrowed, never widened, so a stricter choice an operator made by hand
  survives. The library's own secrets directory, the one place still creating a
  world-listable directory on a *fresh* install, now matches the others.

- **A damaged `channels.json` silently emptied the fleet** — the broadcaster read
  its channel registry inside a `try`/`catch` that swallowed everything, so a
  corrupt file was indistinguishable from a first boot: the service started with
  zero channels, and the next save overwrote the damaged file with an empty
  registry, destroying the evidence and any chance of repairing it by hand. A
  missing registry is still a normal first boot; an unreadable one now stops the
  service with a message naming the file, which is the same thing the library
  already did for its own registry.

- **Desktop packaging: the build swept in the SDK's native-app source trees** —
  found while auditing an artifact. The desktop shell depends on
  `@aliran/player-sdk`, which in this repo is a workspace package: the dependency
  resolves through a symlink to the whole `sdk/` directory, so electron-builder
  packed `sdk/android/` and `sdk/react-native/` into `app.asar` alongside the JS
  engine the shell actually imports. Neither subtree is reachable from desktop
  code, and `sdk/android/` is where a developer's gitignored, local-only demo
  descriptor lives — so a build made on a working machine could bake local
  credentials into a shipped artifact. Until now the only defense was a manual
  "clear that directory before packaging" step, which is exactly the kind of step
  that gets skipped. The packaging config now excludes both subtrees, so the
  artifact no longer depends on the state of the developer's working tree.

- **Dashboard: hidden tabs leaked their content** — the Reports, Analytics and
  Overview sections rendered their content below every other tab (their layout
  rule overrode the browser's `[hidden]` handling). All three now hide
  correctly.

- **MCP: a dropped SSH tunnel disabled the panel tools until you restarted your
  AI client** — found live. Services bind loopback on the box, so the MCP reaches
  them through an SSH local-forward. That forward carried no keepalives, nothing
  watched the ssh process after it started, and nothing ever reopened it: when the
  connection went away, every `panel_*` call failed with "unreachable at
  `http://127.0.0.1:<random port>`" — a port the operator never chose — and the
  only way back was a full client restart. Now the forward runs with keepalives so a
  dead connection **exits** instead of hanging half-open, the handle notices, and the
  next tool call reopens it on the same local port and replays the request.
  Concurrent calls share one reconnect.

  Keepalives alone were not enough, and measuring the box showed why. Restarting a
  service does **not** drop the forward: the tunnel goes to the box, not into the
  container, so it rides a restart straight through. What strands a forward is the
  connection under it dying quietly — and that leaves the ssh process alive and
  listening until the keepalives run out, roughly three minutes in which every call
  fails against a tunnel that looks healthy. The MCP no longer trusts the process. A
  failed call is now the probe: it **rebuilds** the forward even when ssh still looks
  alive, on the same local port, then replays. A cooldown keeps a genuinely-down
  service from thrashing ssh. The error also stopped guessing — it separates "the
  forward rebuilt and reached the box, so the service is not answering"
  (`server_status` / `server_logs`) from "the forward could not be reopened, so SSH
  to the box is the fault", and it no longer claims a reopen that never happened. A
  new per-service `localPort` pins the local end, so a hand-repaired forward uses a
  port the operator already knows.

- **Dashboard: category rails with no parent entry dangled** — a two-level rail
  is written `Parent/Child`, but nothing has to carry the parent slug on its
  own. The Categories tab could only nest a child under a parent that existed
  as its own row, so every other child fell to the bottom of the table under a
  tree marker that pointed at nothing — on a production catalog, most of the
  list, including its two largest rails. A prefix that is in use without being
  a category now gets its own heading row, which counts the channels of the
  rails below it and offers the two actions that apply to it (edit, rename).

- **Docs: the source feed format described fields that do not exist** — the
  content-management guide documented a `provider` key that becomes a "via
  *provider*" description, and listed the description among the fields a sync
  overwrites. Neither is true: descriptions come from a `description` key, and
  the panel writes one only when it creates the channel, so an operator's
  synopsis survives every later sync.

- **Dashboard: unreadable chart hour labels** — the analytics and reports bar
  charts stretched their hour labels with the chart width, which smeared them
  into unreadable shapes at full-screen sizes. Labels now render outside the
  chart at a fixed size.

- **Panel RPC re-arm is validated** — found live: after a panel restart
  dropped the RPC socket, the engine re-armed the RPC on the **next** swarm
  connection to arrive, which mid-session is often a broadcaster feed peer
  (hyperswarm keeps one socket per peer across every topic). Login, session
  checks and problem reports then failed as "offline" **forever** — while
  playback kept working. Now a candidate socket must answer `hello` within a
  bounded probe before it may hold the RPC slot, the validated panel identity
  is remembered for instant re-arms, a hung probe can never starve the real
  panel connection, and `report()` kicks the panel topic's discovery and waits
  a bounded moment for the re-arm instead of failing instantly. Pinned by a
  new lane in `test:reports` (impostor never captures/starves the slot; a
  report lands after re-arm).

### Changed

- **Viewers now hold ~10 s of churn headroom** — a live viewer keeps enough
  media on the device to play through the loss of the peer it pulls from. Three
  parts, all defaults an operator or host can override:
  - The engine replicates the **whole live window** of the active stream to the
    device as the segments appear (before: only the newest 3 segments). What sits
    between the playhead and the live edge can no longer disappear when an
    upstream peer leaves. Steady-state bandwidth is unchanged; the cost is one
    window of data per zap, so on a metered network the engine keeps the old
    3-segment read-ahead.
  - The desktop player now sits 5 segments (~10 s) behind the live edge
    (before: 3).
  - Both Android players pin their live offset to the same ~10 s through
    ExoPlayer's live configuration (before: library default) — the React Native
    app via `bufferConfig.live`, and the native `aliran-kit` view directly. Zap
    speed does not change — playback still starts with ~1 s in hand and fills
    toward the edge.
  The trade is deliberate: every viewer watches ~10 s behind true live in
  exchange for riding out seconds-scale peer churn without a frozen picture. A
  window of 12 segments (`HLS_LIST_SIZE=12`, 24 s) is now the recommended
  broadcaster setting (and the `.env.example` default for new installs) to give
  the offset comfortable margin; the live read-ahead is capped at 32 concurrent
  segment downloads, and the per-channel `hlsListSize` bound was aligned to the
  env bound (2–64, was 2–60) across the broadcaster, the MCP tools, and the
  control UI.

### Added

- **The viewer's disk use is now bounded** — before, a viewer accumulated every
  segment it ever downloaded (~0.9 GB per watched hour at 2 Mbps) and a feed's
  local data survived forever, even after the channel rotated to a new feed key.
  Three mechanisms, mirroring what the repeater already did for its own storage:
  segment blocks are cleared automatically once they leave the live window (the
  broadcaster reclaimed them at the source already — no peer could fetch them);
  a feed evicted from the warm-feed cache is purged from disk, not just closed;
  and at login the engine sweeps away replicas of feed keys that are no longer
  in the catalog. Steady state is now about one live window per cached feed
  plus metadata. VOD titles are never cleared. Covered by the new
  `test:reclaim` lane.

- **Encrypted key escrow: a supported way to get the panel identity off the
  box** — `DATA_DIR/keys/` is the only thing in a deployment with no replacement
  cost, because it has no replacement: every installed app pins the panel public
  key, and the service pairing code is derived from it. Everything else survives
  a total loss — broadcasters repopulate channels and per-stream secrets when
  they re-register. Until now the only backup route put those keys in an archive
  that stayed on the box you were insuring against.

  `admin-cli export-escrow` (and, when enabled, **Overview → Key escrow** in the
  dashboard) writes the key directory as one small file, encrypted **before** it
  is written or answered: Argon2id derives the file key from an operator
  passphrase, XChaCha20-Poly1305 seals the payload. No key material crosses the
  network in the clear, even behind TLS or a tunnel. The export decrypts and
  checks its own output before releasing it, so no untested copy ever leaves.

  The file carries a **cleartext fingerprint** — panel public key, pairing code,
  service name, date — so an operator opening it in two years can tell which
  deployment it belongs to without the passphrase. That header is also the
  AEAD's additional data, so nobody can re-label one deployment's file as
  another's: editing the recorded key breaks decryption outright.

  `admin-cli verify-escrow <file>` proves a copy decrypts and holds the identity
  its fingerprint names — the signing keypair signs and verifies, the OPRF key
  is 32 bytes, the pairing code re-derives. It needs **no panel, no `DATA_DIR`
  and no swarm**, so it runs on a laptop and can never turn into a second writer
  for one identity. `--restore-to` extracts the keys into an empty directory
  only, with the never-two-writers rule printed next to them.

  **The trade is answered deliberately.** A dashboard export lowers identity
  theft from "shell access on the box" to "an authenticated admin session", so:
  the route does not exist unless `ESCROW_EXPORT=1`; it re-checks the caller's
  password (a stolen dashboard token is not enough); it allows 3 attempts per
  hour; and every attempt — including refusals — lands in the activity ring as a
  red `security` event. The CLI route needs shell access anyway and is always
  available, so leaving the flag off costs nothing but convenience. There is no
  MCP tool for this on purpose. The broadcaster needs no equivalent: its feed
  stores are cache, and its publisher key is both backed up with its `.env` and
  rotatable with zero viewer impact. Runbook in
  [the KB](docs/kb/backup-and-rotation.md); `npm run test:escrow` asserts the
  exported bytes hold no key material, that the fingerprint matches the live
  panel key, and that a wrong passphrase, a corrupted file and an edited
  fingerprint are all refused.

- **The dashboard shows the panel public key and pairing code in the open** —
  both are public by design, and a record of them kept off the box is itself
  recovery information. Overview → Service identity presents each with its own
  copy button, instead of leaving the key inside a disclosure triangle.

- **Backup and restore in the dashboards — three artifacts, not one** — backup
  and restore existed only as shell scripts (`deploy/backup.sh`,
  `deploy/restore.sh`) and MCP tools. An operator working in a web dashboard
  could do neither. All four dashboards (panel, broadcaster, library, reseller)
  now have a **Backup** page.

  It is three artifacts because "the box is gone", "I broke my lineup" and "seed
  a second site" want *opposite* things from the same data, and one file cannot
  serve all three without being wrong for two of them:

  1. **Recovery archive** — the whole `DATA_DIR`, identity and all. Unchanged;
     still `deploy/backup.sh`. The dashboards **list** them with age and a
     newest-first marker, and show the exact commands. They cannot run one, and
     the page says why: a cold backup stops the service, and a service cannot
     stop itself and still answer the request that asked it to. The alternatives
     were weighed and declined — mounting the Docker socket into a service turns
     any RCE into host root, and a host-side agent is a whole new component to
     install and keep alive for a convenience feature. Listing needs only a
     read-only bind mount, which the compose file now makes.
  2. **Config snapshot** — this box's config *with* its secrets, stored at 0600
     inside the volume and **never served over HTTP**. Taken automatically before
     a channel delete and before any restore/import, capped at 20. Restoring one
     is additive by default: entries the snapshot does not mention are left alone
     and reported, so recovering one channel never removes the ten added since.
  3. **Config template** — the same structure with every secret stripped, and the
     only one that downloads. The page is honest about the consequence: it
     recreates channels, categories, packages and sources but **not
     entitlements**, because grants seal the per-stream keys it deliberately
     omits.

  Keeping the secrets in (2) is the point, not an oversight. `channels.json`
  holds each push channel's stream key and SRT passphrase, so a stripped restore
  would recreate the channel with a *new* key and every encoder in the field
  would stop. `secrets/streams.json` holds the keys user grants seal against.
  Both are verified: a purged channel restores with its **original** key.

  Three sections are captured but never written back, because each carries a
  revocation lever and a restore moves levers backwards: admin files (rewinding
  `tokenVersion` revives sessions a password rotation killed), panel publishers
  (rewinding `status: revoked` re-enables a leaked broadcaster key), and an
  existing per-stream key (never overwritten — grants are sealed to the live
  one; the refusal is reported rather than silent). The reseller is
  **export-only** for the same class of reason, plus one of its own: account
  balances come from the credit ledger, which no config artifact carries.

  Two credential-bearing URL fields turned up that the code comments understated:
  `sources[].url` (the registry is described as holding nothing secret, but the
  validator accepts `user:pass@` and `?token=`) and broadcaster pull `input.url`.
  Templates keep their origin and path and drop the rest.

  The load-bearing test is a scan, not a rule list: real secrets are seeded
  through the real APIs, a template is exported, and CI fails if any of those
  bytes survives anywhere in it — so a new secret field nobody adds to a
  redaction rule fails the build instead of shipping. New suites
  `test:config-snapshot` and `test:config-api` (network-free), plus coverage in
  the existing panel and broadcaster e2e suites.

  This pairs with the key escrow above, and the KB now presents the four
  artifacts as one table: escrow moves the identity OFF the box, a recovery
  archive rebuilds a service ON it, a config snapshot undoes a change, and a
  config template seeds a second site.

- **Service pairing code: 12 characters instead of 64** — a viewer connecting a
  public (keyless) build no longer types a 64-hex panel key on a phone keyboard
  or a TV remote. The Connect screen now opens on a **pairing code** —
  `A3K7-9QF2-M4XR`, three groups of four that advance themselves as you type —
  and the 64-hex field is one press away for operators who hand out a key
  instead. Both routes reach the same service.

  The code is **derived** from the panel public key, not assigned: Argon2id over
  the key, truncated to 60 bits, written in Crockford base32 (no I/L/O/U, so
  nothing is misread off a TV screen). So there is no registry, nothing to mint
  and nothing to expire — every panel start computes the same code, and the
  reseller panel can compute a customer's code locally from the key it already
  holds. The panel announces on a swarm topic derived from the code and answers
  a `describe` request with its descriptor; the client derives the same topic
  from what the viewer typed, and then **verifies by recomputing** — it derives
  the code from the panel key it received and refuses the answer unless the two
  match. A squatter on the topic therefore cannot substitute its own panel,
  which is the attack the length is chosen against: grinding a colliding keypair
  to phish subscriber credentials costs ~2^60 memory-hard evaluations, not a
  lookup. The code carries **no credentials** — the viewer still signs in — so
  an operator can print it on a card, a receipt or a web page.

  Operators find the code on the dashboard **Overview** tab (with a Copy
  button); the panel prints it at every start, and `admin-cli init` prints it
  beside the new keys. `SERVICE_NAME` sets the service name the app shows while
  pairing, before sign-in. New `test:pairing` e2e proves a client holding *only*
  the code reaches the panel and logs in, and that an impostor answering on the
  topic is rejected rather than followed. A QR remains a later phone-only layer
  over the same descriptor — TV boxes have no camera, which is why the typed
  code comes first.

- **Parental controls: access-controlled channels + a device-local PIN** — an
  operator can mark a channel `restricted` (dashboard: a PIN badge, a toggle in
  the channel editor, and a status filter; CLI: `set-meta --restricted`). The
  flag is catalog metadata: it travels to the apps with the channel record, a
  broadcaster re-register keeps it, and a source sync keeps it. Entitlements do
  not change — the flag controls playback, not access. In both apps the rules
  are: (1) with no PIN on the device, restricted channels do not appear in any
  list; (2) after you set a PIN in Settings, they appear, and the app asks for
  the PIN before it plays one (one entry per app session); (3) a Settings
  toggle can hide them from the lists again. The PIN is saved only on the
  device as a salted digest — the panel never sees it. Set, change and remove
  the PIN in Settings; each change asks for the current PIN first. Pinned by
  SDK e2e passthrough asserts, panel e2e create/edit/re-register asserts, and
  new app unit tests for the visibility rules and the PIN message protocol.

- **Admin dashboard reorganization** — the panel dashboard gets a sidebar with
  icons and grouped sections (Content / People / Monitoring), a page title with
  a one-line description per tab, and a boxed channel table that scrolls inside
  its frame with a pinned header. The Streams tab gains text search, category /
  status / origin filters, a rows-per-page control, and a compact row layout —
  click a channel's name to open its editor inline. "Add stream" and "Add
  package" open as dialogs, and the package dialog now picks member channels
  from a filterable checkbox list instead of a typed id list. On the Users tab,
  channels granted through a source or one-by-one now fold into one chip each
  ("⇣ source · N" / "▤ N channels"), so a user's row stays one line at any
  catalog size. Long explainer paragraphs collapse behind one-line toggles.

  A second pass brings every remaining tab to the same shape: Sources,
  Categories, Publishers and Admins each get a toolbar with a row count and an
  "add" dialog in place of an inline form, and their tables scroll inside the
  same boxed frame. Categories gains a search box. **Every listing table now
  sorts by column** — one click ascending, a second descending, a third back to
  the table's natural order; blank cells stay at the bottom in both directions.

- **Dashboard: the source feed format, in the dashboard** — the Sources tab has
  a "feed format…" button, and "Add source" repeats the reference under its
  fields. It gives the required keys (`id`, `url`), the optional ones (`name`,
  `logo`, `description`), the id rules, the per-feed limits, and the fact that
  an entry which leaves the feed takes its channel and grants with it.
  [`docs/demo/channels.json`](docs/demo/channels.json) is a copyable example.

- **Movies & Series: the full browse experience + series playback** — the
  VOD section of both apps is rebuilt around a reference mockup set, and the
  provider config grows a second per-kind source: `sources.series` (CLI
  `vod-config-set --series-source`, the `/api/vod-config` `sources` map, a new
  dashboard field). One provider download now feeds movies, series **and** the
  genre names — enabling series adds no extra provider traffic — and series get
  the full path: grid → detail page (poster, star rating, date range, genres,
  plot, season tiles with episode-count badges) → episode list → playback, with
  episode URLs token-filled under the same HTTPS-only rule as movies. The browse
  structure in both apps: a left menu (Movies / Series / Search — search is its
  own view), tabs **Recommended · My List · Genres · All**, an always-visible
  "Sort by" chip over a five-option sort menu (Recently added / A-Z / Newest
  releases / Oldest releases / Recently watched), a scroll-synced A–Z jump rail
  on the alphabetical sort, genre cards built from the provider's own category
  names, and one-row Recently-added / Newest-releases rails with "SEE N MORE…".
  **My List and watch history are device-local by design** — stored only in the
  app's local preferences (worklet-owned on Android, main-process-owned on
  desktop), never sent to the panel or the provider; they power resume
  ("Start" continues a series at the right episode and position), the Recently
  watched sort, and the My List tab. Both VOD players gained the live players'
  audio/subtitle track selection (phone ⋮ button; desktop ⋮ button + `c`).
  Pinned by rebuilt jest suites (RN), new lanes in `test:desktop-vod` — incl. a
  byte-identity guard that keeps the two sort-module copies in lockstep — and
  the flipped e2e series-source assertions. A first-device-pass polish round
  followed: the Recommended tab scrolls vertically and each shelf is a real
  horizontal carousel (capped at 50 titles, "SEE N MORE…" right-aligned in the
  shelf head), the players' tracks button wears a more-options glyph (⋮)
  instead of "CC", and both track menus spell languages out in full
  ("Spanish", not "spa") — on desktop the live player's menu inherits the
  full names too. A second QA pass on real devices added: the VOD players'
  transport now fades over clean video exactly like the live bar (tap /
  mouse-move brings it back, pausing pins it) and gained a centered skip
  cluster under the progress bar (±30 s and ±10 s around play/pause);
  Recommended became the landing tab, led by a **Continue watching** row
  built from the device-local history (unfinished titles only, episodes
  crediting their series) so a backed-out film is one tap away; and the
  live channel list now opens directly ON the playing channel (exact
  fixed-row math instead of a visible virtualized scroll hunt). Both apps
  also gained an **in-app volume control** — a speaker mute toggle + level
  slider on the player bars (desktop persists it and adds an `m` mute key;
  on the phone it rides alongside the hardware volume keys; TV remotes keep
  owning volume as before).

- **Movies & Series in the apps** — both the phone/TV app and the desktop
  player grow a VOD section fed by the operator's external provider: a menu tile
  (present **only** while the panel-delivered `vod` payload says enabled, and a
  brand can still switch it off with `sections.vod:false`), a searchable
  poster-grid landing (Movies/Series switch; Series shows an honest empty state
  until a series source exists), and a dedicated player (react-native-video on the
  phone, hls.js/native `<video>` on desktop — the live P2P engine is never
  involved). The app **calls the provider directly** with the viewer's own
  account: username = app username, token = app **password** (the operator
  provisions matching accounts on both sides); a gitignored `vod.dev` block in
  `config/service.json` overrides the pair for dev builds, and the example file's
  placeholder words are recognized and ignored so a half-configured copy falls
  back to the real pass-off instead of leaking literals. Everything is
  HTTPS-only: a cleartext `apiBase` is refused before dialing, and the provider's
  playable URLs — which embed the account token via a literal `{token}`
  placeholder the client fills in — are refused the substitution on anything but
  https. The detail-response shape was **verified against the live provider**
  a flat object with the stream URL in `path`/`path_1080`/`path_720` and
  the runtime as `"hh:mm:ss"`, pinned by shared fixtures in the RN jest suite and
  `test:desktop-vod` (the two provider-client copies must change together).
  End-to-end validated against a real provider catalog (7k+ titles): grid,
  search, detail, playback.

- **External VOD provider — the panel-owned switch** — an operator can point
  the apps at a third-party movies/series catalog they already have an account
  with. One replicated record (`svcmeta/vod`) holds the enable bit plus the
  coordinates (`apiBase`, `service`, per-kind source values, extra query params);
  the **apps call that provider directly**, so the panel never proxies its calls or
  its media, and it stores **no viewer credential** for it. Manageable from the
  dashboard (a card on the Sources tab), the admin API
  (`GET`/`PATCH /api/vod-config`), the CLI (`vod-config` / `vod-config-set`) and the
  MCP server (`panel_vod_config` / `panel_set_vod_config` — 107 → **109 tools**).
  `apiBase` must be https with no query string and no embedded credentials, and
  `enabled:true` is refused while the coordinates are blank, so the section can
  never appear pointing nowhere. The login payload carries a `vod` field **only**
  while the operator has it enabled — absent means "no VOD section", with no
  version check on the client — and a change lands at each viewer's next login.
  The apps' VOD section itself ships next.

- **In-player problem reporting** — the "Report a problem" flow moved from
  Settings onto the **player itself**: a Report button on the now-playing bar
  (phone + desktop, plus the `r` key on desktop) and on the playing channel's
  info panel (TV/D-pad). Reports therefore always carry the **channel being
  watched**. The flow is select-a-symptom → Send: the free-text note is gone
  (the wire still accepts `text` from SDK hosts; reports from the shipped apps
  are `text: null`), and the `login` category is no longer offered by the apps —
  reaching a channel proves login worked (the panel's login alert rule still
  runs for SDK hosts that send it). The Settings entry was removed; the consent
  line no longer promises "anything you type".

- **Viewer problem reports (panel ingest core)** — viewers can report a problem
  ("no audio on channel X") over the **existing** P2P RPC socket: a new `report`
  responder beside `login`/`session`, no new port and no wire change for older
  clients (the method simply does not exist on an older panel). Reports are
  **pseudonymous by construction**: the panel verifies the session token, then
  immediately reduces the identity to `HMAC-SHA256(salt, userId|deviceId)` sliced
  to 16 hex — no username and no device id is ever stored, counted, returned or
  logged (negative-scanned by `test:reports`, the same discipline as the analytics
  suite). Reports live in `DATA_DIR/reports/` (atomic writes, 5000-record cap,
  retention prune) — never in the Hyperbee, which replicates to every viewer.
  Four layers of flood control keep a real outage cheap: a per-reporter throttle,
  per-channel storm collapse (once an alert is open only a bounded sample of full
  records is stored), a panel-wide token-bucket breaker, and correlation that
  opens **one** alert per channel per window and extends it rather than
  re-firing. `REPORTS_RETENTION_DAYS=0` is a complete kill switch.
  An opened alert pushes **once** to ops: a generic webhook whose body suits
  ntfy, Slack and Discord at the same time (`REPORTS_WEBHOOK_URL`) and/or a
  Telegram bot (`REPORTS_TELEGRAM_BOT_TOKEN` + `REPORTS_TELEGRAM_CHAT_ID`); both
  unset is a no-op. Delivery is **fail-dark** — queued and never awaited, one
  attempt at a time, dropped after three tries over ~30 s — so a dead endpoint can
  never slow report ingest down. Triage lives in the dashboard's new **Reports
  tab** (alert strip, filters, grouped and expandable report list, per-hour chart,
  ack/resolve), in `GET/POST /api/reports…` + `/api/alerts…`, and in the
  `list-reports` / `ack-report` / `resolve-report` / `list-alerts` /
  `test-notify` CLI verbs (which work beside a running panel).
- **"Report a problem" in both apps (client path)** — the viewer half of the
  reporting flow, in the phone/TV app and the desktop player. A Settings modal
  offers the seven categories as a vertical focusable list (a TV remote can file a
  report in four presses; the optional note is the last input and entirely
  skippable), shows a consent line naming exactly what is sent, and reports the
  outcome in plain language. Under it, `AliranPlayer.report({category, text})`
  attaches what the engine already knows — the active channel, peer count, app
  version/platform and a rolling 50-entry ring of the engine's own
  error/status/fallback breadcrumbs — and proves entitlement with the retained
  session token, never a username. It **never throws**: a local 10-minute
  cooldown per channel+category means mashing the button during a real outage
  never reaches the wire, and a panel without the responder (too old, or reports
  disabled) maps to a friendly "this service doesn't accept reports" rather than
  an error. The category enum is duplicated per runtime that cannot import
  another's copy (panel, engine, RN binding, desktop renderer) with an e2e drift
  guard asserting all four stay deep-equal.
- **Per-install device id** — both shells now mint 8 random bytes on first run,
  persist them beside their prefs and pass them at login. Until now neither shell
  passed one, so every install of an account collapsed onto a single derived
  fallback id and the panel's device list could not tell two machines apart.
  ⚠ **One-time churn on upgrade:** an existing install enrolls as a *new* device
  the first time it signs in on the new build, and the old derived entry ages out
  under the account's device policy. Accounts sitting at their device limit with
  `devicePolicy` other than `evict` may need one revoke. The id is device-local:
  it is never shown to the UI layer, and the panel folds it into the report
  pseudonym rather than storing it.
- **Privacy-preserving analytics** — aggregate-only, server-side-only usage
  rollups ([docs/analytics.md](docs/analytics.md)). Per-user watch tracking is
  architecturally impossible in Aliran (viewers replicate P2P; the panel sees
  only logins, the broadcaster only anonymous swarm links), so analytics =
  aggregating what the operator's own nodes already observe: **panel** — logins
  ok/failed + sessions per hour, unique viewers per day (an in-memory set
  reduced to a count, never stored), apps-online gauge, catalog composition;
  **broadcaster** — per-channel peer min/mean/max, egress bytes (UDX
  per-connection counters, accumulated on close so closed connections' bytes
  don't vanish), respawns + incidents; **repeater** — `/metrics`-only
  served-bytes per stream (no rollup files on the keyless cache box). Hourly
  buckets → per-day JSON under `DATA_DIR/analytics/` (UTC, atomic writes, boot
  reload; the in-progress hour is deliberately lost on exit). One knob:
  `ANALYTICS_RETENTION_DAYS` (default 90; **0 = collection off entirely**).
  Surfaces: a panel **Analytics** dashboard tab (hand-rolled inline-SVG charts),
  `GET /api/analytics` on the panel + broadcaster APIs, Prometheus `/metrics`
  extensions, and a 24 h peers/egress column on the broadcaster dashboard. Peer
  counts are labeled **"≥" lower bounds** everywhere (viewers serve each other).
  The invariant — no username/key/IP/device id ever reaches an analytics file,
  API response or metrics line — is enforced by a **negative identity scan** in
  the new required-lane `test:analytics`. Zero client/SDK/wire changes; no
  presence beacon (parked as a separate decision).
- **MCP server (`@aliran/mcp`)** — a [Model Context Protocol](https://modelcontextprotocol.io)
  **server** (local stdio) so an AI client (Claude Desktop, Claude Code) can install,
  configure, maintain and support an Aliran deployment for a non-server-literate
  operator. It is the *server* side of MCP (exposes tools/resources; does **not** call
  the Claude API — dependency is `@modelcontextprotocol/sdk` only). Tool groups:
  `panel_*` (users/grants/**packages**/streams/sources/categories/publishers/status),
  `broadcaster_*` (channels/start/stop/rotate/logs/capabilities/incidents/health),
  `server_*` (an **SSH executor**: preflight/install/update/status/logs/disk/backup/
  sysctl), `diagnose_*` (healthz sweep + symptom→KB), plus `docs_search` and every
  `docs/` file as an `mcp://aliran/*` resource. Reads carry `readOnlyHint`, purges/
  restarts carry `destructiveHint`. **Secrets stay local**: the panel/broadcaster admin
  passwords and the SSH key path live only in the operator's `0600` config; the model
  sees only tool results, and secrets minted server-side (the `PUBLISHER_KEY`) are
  written into the box `.env` and never returned. Panel/broadcaster loopback APIs are
  reached over an explicit TLS `url` or an SSH local-forward tunnel. New `test:mcp`
  suite (in-process panel + broadcaster, driven as an MCP client) in the required CI
  lane. v1 wraps panel + broadcaster + install/maintain + docs (reseller/library/
  repeater deferred; local stdio only). Onboarding: **`--doctor`** self-check
  (validates the config + file mode, probes SSH and the unauthenticated `/healthz`
  of each service — never spending a login attempt unless `--login` is passed —
  lists the enabled tool groups and prints **paste-ready wiring snippets for every
  major MCP client** — the server is client-agnostic, so operators are never locked
  to one vendor's app: the `mcpServers` JSON (Claude Desktop / Cursor / Windsurf /
  Cline / Gemini CLI), Codex CLI TOML, VS Code agent-mode `mcp.json`, and the
  `claude mcp add` / `codex mcp add` one-liners, all with absolute paths filled in;
  exit codes 0/1/2 for scripting) plus a step-by-step
  **[quickstart walkthrough](docs/mcp-quickstart.md)** (config → doctor →
  per-client wiring incl. an advisory-hints caveat → first prompts → fresh-server
  install, with diagrams and a troubleshooting table). See [docs/mcp.md](docs/mcp.md).
- **MCP ops completeness** — the four P0 gaps that still forced an operator
  out of the MCP, closed (59 → **73 tools**): **(1) env tuning + restart** —
  `server_set_env {service, pairs}` upserts documented, **allowlisted** env knobs
  (secrets like `PUBLISHER_KEY` refused — they have dedicated server-side flows)
  and, because every service config **fail-fasts at boot**, dry-runs the new
  `.env` through the new `node src/config.js --check` mode **in the built image
  first** — on failure the `.env` is **reverted** and the exact problem list
  surfaces; on success it applies via plain `docker compose up -d <service>`
  (compose `restart` does **not** re-read env files — `server_restart` exists for
  process bounces like the `server_sysctl` follow-up and says so). The `--check`
  dry-run mode itself landed in **all four** service configs
  (panel/broadcaster/library/reseller), probed by `test:config`. **(2) restore**
  — new `deploy/restore.sh` (verify → stop → **replace** volume contents →
  start; refuses a non-empty volume or a name-mismatched archive without
  `--force`) wrapped as `server_restore` + `server_list_backups`; the result
  echoes exactly what was overwritten and from which archive (`backup.sh` /
  `restore.sh` are also executable now and invoked via `sh` — the committed
  `backup.sh` mode bit had made `./deploy/backup.sh` fail on a fresh clone).
  **(3) analytics** — `panel_analytics` / `broadcaster_analytics {days?}` expose
  the aggregate-only analytics rollups (counts and "≥ N" lower bounds only — no new
  identity surface). **(4) admin accounts** — list/add/remove/set-password ×
  panel **and** broadcaster, with generated-and-returned passwords like
  `panel_create_user`, and an explicit caveat that rotating the account the MCP
  itself logs in with means updating the operator's local `mcp/config.json`.
  `test:mcp` grew sections **K–P** (analytics passthroughs; admins CRUD with the
  generated password **live-verified** against `/api/login`; the set_env
  validate-then-apply flow with the revert path driven by the REAL `--check`
  output through the ssh stub; newline-injection guard; restart; list/restore
  incl. the refusal path; and a whole-log assert that no tool ever used
  `--force-recreate`).
- **MCP content + business coverage** — the P1 gaps: content curation and
  the two previously-unwrapped services (73 → **101 tools**). **Categories**:
  `panel_set_category` (presentation: label/order/hidden),
  `panel_rename_category` / `panel_merge_categories` (rewrite the tag across
  every catalog record — and the honest coupling is documented + tested: a
  package `category:` member is a *string* re-resolved after the move, so a
  rename strips that bouquet's holders until the member is updated),
  `panel_delete_category` (registry entry only — membership kept). **Source
  curation**: `panel_source_channels` (imported + excluded, the channels-dialog
  view) and an `exclude` field on `panel_set_source` (replacing the deselect
  list resets the source ETag so the next sync re-diffs the full feed).
  **Stream art**: `panel_set_stream_art {id, kind, path}` reads the image from
  the *operator's* machine and POSTs raw bytes (≤ 10 MiB, image extensions
  whitelisted client-side) — image data never transits the model as base64.
  **Reseller oversight** (optional `reseller` config block, control API
  `:3330`): 14 `reseller_*` tools covering the OPERATOR's jobs — principals
  (enroll with generated-and-returned passwords / limits / suspend incl.
  `with-accounts`), **credit mints whose result echoes the appended ledger line**
  (seq/actor/principal/amount/new balance), ledger audit, accounts + trials
  views, sweeps status; reseller *daily driving* (activate/renew/extend) is
  deliberately not wrapped — that stays in the resellers' own panel. **VOD
  library** (optional `library` block, `:3320`): 8 `library_*` tools — titles
  list/get, add (one-shot ingest from a path **on the library box**), operational
  patches (descriptive metadata stays panel-owned), re-ingest, ffmpeg log ring,
  delete (purges the box; the result says the panel record is only marked
  `unavailable` and points at `panel_delete_stream`). Both services join
  `diagnose_healthz` and the `--doctor` probes once configured. `test:mcp` grew
  sections **Q–V** over an in-process REAL reseller service (pointed at the
  test's real panel; the mint is asserted against the actual ledger) and a
  fake-TitleManager library control server — no DHT, no ffmpeg.
- **Viewer reports through the MCP + the operator guide** — the reporting
  feature reaches the AI-operated path and the docs site (102 → **107 tools**).
  Five new panel tools: `panel_list_reports` (status/channel/category filters,
  raw epoch-ms `since` **plus** a `sinceHours` convenience, `limit`),
  `panel_list_alerts`, `panel_ack_report`, `panel_resolve_report {note}` and
  `panel_test_notify`. A report carries the engine's 50-entry breadcrumb ring, so
  long rings summarize to `{count, sample}` of the **last** three — the
  `compactUser` mechanism applied to a second shape, with `full:true` restoring
  everything. Alert ack/resolve stays deliberately unwrapped (a running panel
  holds alerts in memory). `server_set_env` gained the seven `REPORTS_*`
  **tunables** plus `REPORTS_TELEGRAM_CHAT_ID`, and **refuses**
  `REPORTS_TELEGRAM_BOT_TOKEN` *and* `REPORTS_WEBHOOK_URL`: an ntfy topic, a
  Slack incoming webhook and a Discord webhook all carry their credential in the
  URL path, so a notification endpoint is a secret and belongs in `panel/.env`
  on the box, not in a model's context. The `incident-triage` runbook now starts
  by asking what viewers reported, and `monthly-maintenance` closes the loop on
  stale reports and re-proves the notification wiring; `diagnose_symptom` routes
  report-storm and dead-notifier symptoms to the new page. New
  **[docs/reports.md](docs/reports.md)**: the ten knobs, curl-able
  ntfy/Slack/Discord/Telegram recipes, the alert rules, the four flood-control
  layers, and an honest pseudonymity section that states plainly what HMAC with a
  panel-held salt does and does **not** promise (pseudonymous at rest, *not*
  anonymous to the operator — do not tell your audience otherwise). `test:mcp`
  grew section **AD**, driving the tools against a real reports store + notifier
  stub, plus a category-enum drift guard against `panel/src/reports.js`.
- **MCP scale + DX** — the P2/P3 tail; completes the
  operator-coverage arc (101 → **102 tools** + 6 prompts). **Multi-host SSH**:
  the config's `ssh` block optionally names extra boxes
  (`hosts: {name: {host, user, keyPath?, port?, repoDir?}}` + `default`; the
  single-host shape is unchanged) — every `server_*` tool takes `host:"<name>"`,
  and `panel_add_publisher {host}` writes the minted site key into **that**
  box's `broadcaster/.env` (secrets still never transit the model). New
  **`repeater_status {host?}`**: the repeater deliberately has no admin API
  (zero listening sockets stock), so status is SSH-shaped — compose state +
  logs for the `deploy/docker-compose.repeater.yml` stack, plus the opt-in
  loopback `/metrics` when `STATUS_PORT` is set on the box, and an honest
  "not enabled" note when it is not. `--doctor` probes every named host.
  **List ergonomics**: `panel_list_streams` grew client-side
  `category`/`prefix`/`idsOnly`/`limit` filters (no-argument calls still return
  the raw catalog), and every user-shaped result summarizes grant lists longer
  than 12 ids to `{count, sample}` — `full:true` restores every id, and
  `panel_revoke_grant` now reports `stillGranted` when a package re-sealed the
  stream. **Schema gaps**: `broadcaster_add/update_channel` take `hlsTime`
  (1-30) / `hlsListSize` (2-60); `panel_add_stream` takes `feedKey` + `key` for
  pre-seeded feed flows — a **supplied** `key` is stored panel-side and
  **redacted** from the result (an omitted one is generated and returned once,
  as before); `panel_set_stream_meta` takes `feedKey`. **Prompts as runbooks**:
  six MCP prompts (`new-site-install`, `onboard-a-reseller`,
  `migrate-a-channel-source`, `monthly-maintenance`, `incident-triage` with an
  optional symptom argument, `expose-dashboards`) — numbered guidance naming
  the exact tools + their honesty caveats, sourced from the shipped docs; the
  TLS story stays **docs-first** (Caddy per the KB; DNS is out-of-band).
  **`server_update {dryRun:true}`** previews exactly what would deploy
  (fetch + commit list + changed files) without building or restarting.
  **npm publish**: `@aliran/mcp@0.1.0` is **live on the registry**
  (published 2026-07-25) — `prepack` bundles the docs corpus into
  `docs-bundle/` and the server falls back to it when no repo checkout is
  around, verified post-publish: `npx @aliran/mcp --doctor` from a scratch
  directory indexes all 45 bundled docs. `diagnose_symptom`
  learned the new lore (env changes need `up -d`, category-rename ×
  `category:` members, restore's non-empty refusal). `test:mcp` grew sections
  **W–AC**: a second fake box through the same ssh stub (multi-host routing +
  per-host repoDir), all three repeater status-server states, filter/compaction
  round-trips, hls bounds + the `key` redaction, a prompt drift guard (every
  tool name a prompt mentions must exist), a dry-run zero-build/up log sweep,
  and an `npm pack` probe that runs `--doctor` from the unpacked tarball.
- **Channel packages ("bouquets")** — named channel bundles an admin grants as one
  unit ("Basic", "Sports"), replacing chip-by-chip per-stream grants that stop
  scaling past a few dozen channels. Because a grant is a **sealed key** (not an
  ACL), packages cannot be a runtime check: every change is *materialized* into
  per-user sealed grants by a reconcile engine (`panel/src/packages.js`) — on
  package CRUD, user assignment, stream add/retag/delete, category rename/merge,
  every source sync, and panel boot. Members are explicit stream ids, id globs
  (`sports-*`), or selectors `category:<slug>` (parent covers `Parent/Child`) and
  `source:<name>`, resolved against the live catalog so newly tagged/imported
  channels join by themselves. User records gain **grant provenance**
  (`manualGrants` vs `packages`); revoking a stream now removes the *manual*
  entitlement (a covering package re-seals it in the same request), removing a
  package removes only what nothing else covers, and source auto-grants are
  never touched by package reconciles (with auto-grant OFF, a `source:` member
  hands that source to package governance). `default` packages are auto-assigned
  to newly created users beside the source auto-grant hook. Pre-package records
  migrate additively at first boot (existing grants adopted as manual, source
  auto-grants correctly left to the source engine — nothing is ever revoked by
  the upgrade). Ships with `/api/packages` CRUD + `/api/users/:u/packages`,
  admin-cli parity (`add-package`/`set-package`/`list-packages`/`show-package`/
  `remove-package`/`set-user-packages`), a dashboard **Packages** tab (members,
  resolved-channel preview, holder counts) and Users-tab provenance chips
  (package / manual / auto), plus a new required-CI e2e suite (`test:packages`,
  deterministic, DHT-free). **Zero wire/SDK/app impact** — clients receive
  `wrapped` keys at login exactly as before. Registry: `DATA_DIR/packages.json`.

- **Security hardening pass** over the shipped crypto/auth paths — wire-compatible
  (no protocol change; deployed players/SDKs/apps unaffected). Fixes: (1) malformed
  login-RPC hex fields now fail closed instead of crashing the panel — a non-string
  `powNonce`/`sig` made `b4a.from(x,'hex')` throw a `TypeError` that `safety-catch`
  rethrew into an uncaught crash, so `login {"powNonce":{}}` was an **unauthenticated
  remote panel kill**; (2) the fixed-window login throttle map is now bounded (was
  unbounded on attacker-chosen usernames/peers — a slow memory-exhaustion DoS), across
  the panel and all three control servers; (3) key/credential **directories**
  (`keys/`, `secrets/`) are now created `0700` (the files were already `0600`); (4) the
  panel warns at boot when `LEGACY_PUBLISHER=1` while named publishers are enrolled,
  nudging the shared-key sunset. New required-CI regression suite `test:rpc-hardening`
  (loopback, DHT-free) covers malformed payloads, register replay, throttle
  boundedness, the legacy predicate and file modes. The audit's verdicts, audited
  surfaces and an explicit **residual-risk register** are recorded in
  [`docs/security-model.md`](docs/security-model.md); the crypto dependency set carries
  no known advisories (the one `npm audit` high-sev is electron, the optional desktop
  player's build dep, not a shipped crypto path).

- **Backup, restore & key rotation runbooks**: `docs/kb/backup-and-rotation.md`
  — the identity/data/cache model (panel keys are identity and NOT rotatable;
  broadcaster feed stores are cache and not worth backing up), cold-backup and
  restore procedures incl. the append-only restore-freshness hazard and its
  client-side recovery, warm-standby failover under the never-two-writers rule,
  and a rotation matrix for every credential (admin/principal passwords,
  publisher keys, webhook secret, SRT passphrases, feedKeys). Plus
  `deploy/backup.sh` (cold stop→tar→start per compose volume) and an automated
  restore drill (`npm run test:backup`, required CI lane) proving a cold copy
  of the panel DATA_DIR restores identity, admins, accounts and catalog.
  Container logs are now bounded in every compose file (json-file 20m×5) — an
  untended box can no longer fill its disk with logs.

- **Observability & config hygiene**: every service fails fast on a typo'd env
  var — the boot error names the exact variable (no silent defaults, no NaN
  timeouts); opt-in structured logs (`LOG_FORMAT=json` emits one
  `{ts,level,svc,msg}` JSON object per line, default output unchanged);
  unauthenticated `GET /healthz` on every HTTP surface (now including the panel
  admin API) plus Prometheus-text `GET /metrics` everywhere (process stats +
  per-service gauges: channels/boot-resume/incidents, title states + panel-link,
  principals/accounts + ledger invariant, panel swarm connections); and an
  opt-in repeater status server (`STATUS_PORT`, default off — a stock repeater
  still opens no listening sockets). Covered by `npm run test:config` in the
  required CI lane + new assertions in the reseller/vod/repeater/broadcaster
  suites.

**Core crypto (`core/`, `@aliran/core`)**
- OPRF login (ristretto255) with Argon2id verifiers and proof-of-work + throttling —
  the panel never sees passwords; X25519 sealed per-user stream grants; per-user
  Ed25519 auth keys; panel-signed session tokens with device limits, eviction, and
  `tokenVersion` revocation.

**Panel (`panel/`)**
- Single-writer, panel-signed Hyperbee control plane (accounts + catalog) replicated
  to every client over the DHT, plus a panel-seeded assets Hyperdrive; catalog edits
  reach connected clients **live** (`bee.watch` push, no polling, no re-login).
- RPC over Hyperswarm: `hello` (PoW), `login` (blinded OPRF), `session` (device
  enrollment + token), `register` (broadcaster publisher-key auth).
- Admin surface with one shared ops layer behind CLI **and** HTTP API **and** a
  no-build web dashboard: users (create/password/disable/delete, prefix search +
  cursor paging, devices + cooperative per-device revoke), streams (add/meta/art,
  curation `order`/`featured`, full-purge delete), grants, admin accounts, and
  `GET /api/observability` (uptime/memory/swarm/storage + activity ring).
- **Hybrid art**: `poster`/`backdrop`/`logo` accept a P2P assets-drive path or an
  operator-hosted `https://` URL (validated; passed through to clients untouched).
- **Redirect channels**: a catalog record can be `{redirect: true, url}` — viewers
  play the operator's https HLS URL **directly**, no P2P feed behind it; `url`
  drives the class atomically (live-by-default, explicit fields win, feedKey
  mutually exclusive), and broadcaster re-registers never erase it.
- **`blobsKey` enrichment**: the panel opens each registered feed and publishes its
  blobs-core key so keyless repeaters/seed nodes can mirror ciphertext.
- **Per-publisher keys + channel scopes**: each broadcaster site can be enrolled
  with its **own** registration keypair and admin-assigned streamId-glob scopes
  (`add-publisher` CLI, `/api/publishers`, dashboard Publishers tab; registry in the
  panel-private `secrets/publishers.json`, public keys only). Named registrations
  verify against that site's key and are scope-checked **before any write**
  (rejects: `unknown-publisher` / `revoked` / `out-of-scope`, surfaced in the
  broadcaster control UI), and stamp `origin:<name>` on the catalog record +
  activity feed. Revocation is a per-site status flip; scope edits apply on the
  site's next register. Legacy shared-key registrations keep working until
  `LEGACY_PUBLISHER=0`. Broadcaster side: set `PUBLISHER_NAME` beside the enrolled
  `PUBLISHER_KEY`.
- **Remote channel sources**: pull a provider-prepared channel-list JSON on a
  schedule and materialize it as a **category of redirect channels**
  (`add-source` CLI, `/api/sources`, dashboard Sources tab; registry in
  `DATA_DIR/sources.json`). Feed entries are validated as pure data (https url
  required per entry, art/id rules, size + count caps), records are
  ownership-stamped (`source:<name>`) so a feed can only touch its own namespace,
  the feed wins on mapped fields while curation (`featured`, manual `isLive`)
  sticks, channels that leave the feed are purged, and `autoGrant` seals every
  imported channel to every user — reconciled on each sync and at user creation.
  Unchanged feeds (or ETag 304s) append **nothing** to the replicated catalog. EPG
  stays out of the bee; imported records carry `epgUrl`/`epgId` pointers the apps
  fetch on demand (the guide bullet below). P2P channels tagged with the same category share
  the rail — zero SDK/app changes. Individual entries can be **deselected** per
  source (dashboard channels-dialog checkboxes / `--exclude`): an excluded channel
  is purged and skipped on every sync — exclusion changes reset the ETag so a 304
  can never mask them — and re-checking re-imports and re-grants it. The dashboard
  surfaces the whole sync story: each row's report line opens the full last-sync
  report — skip reasons, conflicting ids, and **over-cap truncation** (the capped
  detail is persisted in the registry precisely for this) — sync errors open a
  dialog with the full text and timestamp instead of hiding in a hover title (and
  no longer mask the paused/enabled badge), the channels dialog is filterable with
  all/none over the filtered rows and shows feed ids, and the sync interval is
  edited in minutes with the field's own units in every validation message.
- **Program guide (EPG) — fetched on demand, never in the catalog**: imported (and
  any manually tagged) channels carry `epgUrl`/`epgId` pointers, and the app fetches
  the provider JSON over https to render a live **Now / Up next** guide in the Info
  panel (elapsed bar + upcoming programs). One ETag-revalidated fetch serves a whole
  category; the schedule never touches the replicated bee (no per-client growth) and
  playback never depends on it. Set `epgUrl`/`epgId` on any P2P channel (`set-meta`
  / `PATCH /api/streams` / dashboard Edit) to light up the same guide; leave unset
  for an honest "No program information" placeholder. SDK exposes the pointers on the
  display list (like art URLs); the schedule data stays client-side.

**Broadcaster (`broadcaster/`)**
- Multi-channel `ChannelManager`: each channel is ingest → ffmpeg → **encrypted
  Hyperdrive** → its own Hyperswarm, with a persisted registry and runtime
  start/stop; auto-registers with the panel (publisher key).
- Typed ingest: `test` / `file` / pull (RTSP/RTMP/SRT/UDP/HLS URLs, correct `-re`
  pacing) / **push listeners** — RTMP (stream key), SRT (passphrase = real auth),
  UDP-TS — with validated, auto-allocated ports and operator-facing push URLs.
- Per-channel transcode: `copy` passthrough or x264 / NVENC / QSV / VAAPI / AMF with
  segment-aligned keyframes; an ffmpeg **capability probe** deep-verifies hardware
  encoders (by encoding test frames) and gates `start()` with honest errors.
- **Ephemeral rolling feed buffer**: the live window is O(window) storage, not an
  archive (playlist-driven blob reclaim); `disk` default (stable feed identity, warm
  DHT topic) or `ram` (byte-flat disk; fresh session feedKey per start — grants
  survive, the catalog follows).
- **Bounded disk metadata + corruption self-heal**: blob reclaim keeps segment data
  O(window), and the append-only merkle tree is bounded by always-on **orphaned-
  generation GC** plus optional **periodic feed rotation** (`FEED_ROTATE_HOURS` /
  `FEED_ROTATE_TREE_MB`, or `POST /api/channels/:id/rotate`) — viewers follow the new
  feedKey live. A store corrupted by an unclean exit (`EPARTIALREAD` / `OPLOG_CORRUPT`)
  **self-heals** on start by rotating to a fresh generation (was: silent boot failure);
  boot-resume errors are now logged, and compose sets `stop_grace_period: 60s` so a
  clean shutdown has time to finish.
- Reliability: ffmpeg watchdog with exponential backoff + stalled-live-edge restart;
  **memory-cap recycle** of a running pull ffmpeg (`FFMPEG_MAX_RSS_MB` — bounds the slow
  demuxer-state accumulation some live-HLS upstreams cause; no feed rotation);
  **backup sources** (per-channel fallback URLs with fail-forward + opportunistic
  return-to-primary); **feed rotation on source change**; **auto-resume on boot**
  (`desiredRunning`); `isLive:false` on stop via one manager-owned, self-healing
  **PanelLink** (serialized registers, boot catch-up, heartbeat, forced DHT re-lookup
  after a panel restart); per-channel ffmpeg log ring; **correlated incident log** for
  fleet-wide events.
- **Offline slate**: when a source stays dead past `SLATE_AFTER` respawns, the channel
  loops a pre-rendered "SOURCE OFFLINE" slate (SMPTE bars + message) instead of going
  blank in backoff, and returns to the source automatically when it recovers. Remuxed
  with `-c copy` (~0 CPU; works on `copy` channels too), profile-matched to the channel's
  output, media rendered into the image at build time. `#EXT-X-DISCONTINUITY` is now
  emitted on every spawn, which also marks the timestamp reset an ordinary respawn
  already caused. See [kb/offline-slate.md](docs/kb/offline-slate.md).
- **Per-channel ingest/demuxer tuning** (`probesize`/`analyzeduration`/`thread_queue_size`/
  `discardcorrupt`) for difficult push encoders, editable in the control UI.
- **Fast, observable boot resume**: the control server starts before the auto-resume (not
  after), which runs bounded-concurrent (`RESUME_CONCURRENCY`, default 12) with adaptive
  event-loop back-pressure so it never starves the API. An unauthenticated `GET /healthz`
  reports `{up, resuming, resumed, total, …}` throughout — point uptime checks there. Measured
  on the live 83-channel box: full recovery 451 s → 40 s, with the API responsive the whole
  time (previously `/api` was dark for the entire ~7 min ramp).
- Control HTTP API + no-build web UI: add/edit/start/stop channels, ingest +
  transcode forms driven by the capability probe, push-URL copy, logs dialog, honest
  state badges (`ON AIR` / `WAITING FOR PUBLISHER` / `RETRYING`; a slated channel is
  `ON AIR` with a `slate` flag in the status API); admin accounts with the same
  hardening as the panel.
- `SWARM_MAX_PEERS`: per-channel swarm connection budget for scale-out; swarm UDP
  socket-buffer sizing (`SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB`).

**Player SDK (`sdk/`, `@aliran/player-sdk`)**
- Runtime-agnostic engine (same graph runs headless in Node and inside the app's
  Bare worklet): `connect` / `login` / `resolve` / events. Login unseals per-user
  stream keys; `resolve()` serves the encrypted feed on a localhost progressive HLS
  server and returns the play URL.
- Progressive serving core: availability wait (holds a request until the entry
  replicates), block-progressive bodies with Range, live-edge read-ahead, and a
  stalled-read abort so a read committed to a reclaimed blob re-resolves instead of
  hanging.
- Zap machinery: feed cache (re-zaps are warm), `prewarm` (open entitled feeds at
  login), optional `zapPrefetch` with an **adaptive gate** (suspends on metered
  networks, active-stream stalls, or a thin pipe) and **directional** warming;
  `uploadPolicy: 'client-only'` for viewers that must not re-seed.
- Self-heal ladder for tunes: forced DHT re-lookups on backoff → retune (evict +
  fresh open) → **wedged-connection teardown** → a friendly, surfaced error — with
  "tuned/healthy" verdicts requiring the playlist to be advancing **and servable**
  (metadata alone never stands the watchdog down).
- Live follow-ups without re-login: the active stream tracks catalog **feedKey
  rotation** (`feed-changed`) and redirect-channel **url edits** (next tune).
- **Redirect-channel passthrough** — the product CDN path: `resolve()` returns the
  catalog URL directly. (An internal, config-driven hybrid CDN↔P2P mode predates it
  and survives as e2e-harness infrastructure; **P2P channels have no CDN failover,
  by design**.)
- Bounded hyperbee caches across every store (long-uptime heap safety).
- **npm-ready packaging** for `@aliran/core` / `@aliran/player-sdk` /
  `@aliran/react-native` (0.1.0): registry-publishable metadata (`files`,
  `repository`, `publishConfig`, semver-ranged `@aliran/core` dep — the workspace
  and the app's `file:` graph still resolve it locally), hand-maintained TypeScript
  definitions (`sdk/index.d.ts`) for the whole engine surface, a `@aliran/core`
  README, a runnable headless example (`examples/headless-player.mjs`), and a
  Player SDK page on the docs site. **Published to the npm registry as `0.1.0`**
  (first release, 2026-07-22 UTC; cold-install verified). Two deep-dive docs pages
  followed: **SDK installation & configuration** (every install path, option,
  event, runtime control, and troubleshooting) and **Operator APIs & the SDK**
  (every admin/control/RPC endpoint mapped to the viewer-visible effect and its
  propagation latency — live-push vs next-tune vs next-login).

**React Native binding (`sdk/react-native/`, `@aliran/react-native`)**
- `AliranBackend` (worklet host, IPC protocol, prefs) + `<AliranVideo>`: tune
  lifecycle (`onTune` with tune ids + `streamId` echo — one localhost URL serves
  every channel), deterministic remounts on channel flips, live-edge stall resync
  ladder, ExoPlayer start-buffer tuning.

**Android app (`client/`)**
- react-native-tvos app (phone + TV, one codebase) running the SDK in a Bare worklet
  with the full Holepunch native stack; splash **auto-auth** with device-local
  "remember me", Menu hub, **fullscreen live TV** with overlay browsing (category
  rail, numbered channel list, detail panel), favorites + search + settings, tuning
  pill with honest self-heal labels, NowPlayingBar, resume-last-channel, D-pad zap
  with OSD, "Smooth zapping" toggle (persisted, applied live), store-corruption
  recovery, strict loopback-only cleartext.
- **White-label**: service-descriptor branding + `makeTheme` — zero hardcoded brand
  strings or colors in screens — plus per-brand APK packaging: a brand dir
  (`client/brands/<id>/` — descriptor, launcher icon, splash logo, wallpaper, TV
  banner; credentials rejected) builds through `tools/brand.mjs` into a
  co-installable APK (`applicationId com.aliranclient.<id>`) via a property-gated
  gradle flavor; the default no-flavor build is untouched. Ships the fictional
  `sunburst` example brand; operator guide: [docs/white-label.md](docs/white-label.md).
- **Public (keyless) flavor** — one generic APK, phone + TV, that connects to any
  operator's service at runtime (the Android analogue of the desktop player's
  public build): baking the committed keyless `config/service.public.json` routes
  first run to a **Connect screen** (panel public key + username + password — no
  URLs, discovery is the DHT); both persist on the device only after a successful
  sign-in, later launches auto-authorize, and *Settings → Change service…* forgets
  the service + sign-in and reconnects (the engine is swapped wholesale when a
  different panel key arrives). A baked operator key always wins and is never
  changeable at runtime. Viewer guide:
  [docs/android-viewer-guide.md](docs/android-viewer-guide.md).
- **One APK from Android 7 up — the engine gates itself at runtime.** A
  patch-package patch on `react-native-bare-kit` turns its link-time dependency
  on `libbare-kit.so` into a lazy `dlopen`/`dlsym` resolved only on API 29+
  (the engine's floor is physical: ELF TLS, added to Android's libc in 10), so
  the standard build is a single `minSdk 24` APK that installs on Android 7–9
  with the SDK **silently inactive** (`AliranBackend.isSupported()` → `false`,
  every call a safe no-op, a plain unsupported-device notice instead of an
  eternal splash) and boots the full P2P engine on Android 10+ — verified with
  the same APK on an Android 7 emulator (silent) and a modern one (engine
  `ready` through the dlopen path). SDK hosts get the same seam: apply the
  patch, gate on `isSupported()`, mount their own legacy/CDN mode below 10.
  An optional `ALIRAN_LEGACY=1` flavor still builds an engine-less lean APK
  for old-device-only fleets. Android 6 is unreachable on this RN generation —
  RN 0.76+ prebuilds are built for API 24 and the build rejects a lower
  minSdk. Recipe: [docs/sdk-guide.md](docs/sdk-guide.md).
- **`<EngineNotice>`** (`@aliran/react-native`) — ready-made, brandable
  "engine can't run here" screen for the `!isSupported()` branch: honest
  default copy about the Android 10+ floor, per-brand colors/copy/children,
  and an optional D-pad-focusable action button as the host app's seam for
  offering the viewer an alternative method (the SDK ships the notice and the
  switch, never the delivery). The shipped app dogfoods it on its
  unsupported-device screen.

**Native Android SDK (`sdk/android` — `aliran-kit`, Kotlin)**
- A React-Native-free twin of the RN binding for any Android app, **one APK
  from Android 5.0 (minSdk 21)**: `AliranBackend` hosts the same bare-pack
  engine bundle via BareKit's plain-Java `Worklet`/`IPC` API and speaks the
  identical line-JSON IPC protocol; `AliranPlayerView` (Media3/ExoPlayer)
  ports the `<AliranVideo>` playback contracts — 1 s zap buffer,
  engine-driven tune lifecycle, frozen-live-edge resync ladder with
  `reconnect()` escalation, feed-rotation rebuild, vod transport; and
  `EngineNotice` mirrors the RN component. On Android 10+ the engine runs in
  full; below, it is never even class-loaded (BareKit's `loadLibrary` lives
  in the Worklet static initializer, so the gate is plain Java class-loading
  — no native patch) and the SDK is silently inert. Covers fleets React
  Native itself cannot reach (Android 5/6 STBs, Fire OS 5 sticks). Verified
  with one demo APK on an Android 5.1 emulator (notice + plain-HLS fallback)
  and a modern emulator (full P2P: OPRF login over the DHT against the
  production panel, catalog, live playback). JVM-tested protocol layer;
  `sdk/android/demo/` is the reference host.

**Desktop player (`desktop/`)**
- Windows desktop player (Electron): the engine (`@aliran/player-sdk`) runs in the
  main process on the stock N-API prebuilds; the sandboxed React renderer plays the
  localhost/redirect HLS with hls.js behind a three-call IPC bridge speaking the
  worklet message protocol. Full parity with the Android app — splash auto-auth (credentials wrapped
  with `safeStorage`/DPAPI, password never re-enters the renderer), menu hub,
  fullscreen live TV with category rail + numbered list + detail panel, the live
  EPG now/next guide (the shared plain-TS data layer from `@aliran/react-native`),
  favorites/search/settings, "Smooth zapping" toggle, subtitle/audio selection
  (flat hls.js indexes), tuning pill, keyboard-first D-pad-style navigation, and a
  vod seek/pause transport. The `<AliranVideo>` playback contracts are
  reimplemented for hls.js: engine-confirmed tune completion, feed-rotation
  remounts, the frozen-live-edge resync ladder with `reconnectActiveFeed()`
  escalation, and a clean per-channel error for codecs the host GPU can't decode
  (HEVC support = platform hardware decode). electron-builder packaging: NSIS
  installer + portable exe on Windows, dmg + zip on macOS (`dist:mac` locally or
  the manual-dispatch `desktop-mac` GitHub Actions workflow — the engine's N-API
  modules all ship darwin prebuilds; unsigned — the SmartScreen/Gatekeeper
  reality is documented), in
  **two flavors from one codebase**: the operator build bakes `service.json` as a
  resource; the public build ships keyless and opens on a **Connect screen**
  (panel public key + account, persisted in the profile, with *Settings → Change
  service…* to forget it). Guide:
  [docs/desktop-player.md](docs/desktop-player.md).
- **Electron shell upgraded 37 → 43** (desktop 0.2.0) — clears the one `npm audit`
  high-severity advisory the hardening pass had left tracked (electron ≤39.8.4
  renderer-process CVEs; a build-time desktop dep, never a shipped crypto path).
  No API changes were needed — the shell's Electron surface (BrowserWindow,
  narrow IPC, `safeStorage`, single-instance lock) carried over unchanged; both
  flavors re-verified (baked boot → live screen against a real panel; keyless
  boot → Connect screen). Baked *test* descriptors may now carry a
  `dev: { username, password }` block that auto-signs-in on first boot (Login
  prefill already existed; saved credentials still win; public builds cannot
  carry one by construction).

**Repeater (`repeater/`)**
- Keyless regional super-peer (Open-Connect model): mirrors chosen channels' live
  windows **as ciphertext** at the block level (catalog `feedKey` + panel-published
  `blobsKey`), O(window) retention with sweep, follows feed rotations unattended,
  absorbs viewer fan-out off the origin. It holds no grants and cannot watch what it
  serves. Ships with its own deploy pack and testnet-proven e2e.

**Library (`library/`) — VOD**
- Standalone VOD service (deliberately NOT the broadcaster — no live-pipeline
  lifecycle applies to a static seed; runs on separate hardware so ingest bursts
  never touch a loaded live box): operator-registered video **files** become
  encrypted, P2P-seeded on-demand **titles**. One-shot ingest (ffprobe → `-c copy`
  remux for HLS-compatible codecs, else h264/aac transcode → finished
  `#EXT-X-PLAYLIST-TYPE:VOD` rendition, ALL segments kept) into a per-title
  encrypted Hyperdrive on one shared Corestore/Hyperswarm (repeater storage model);
  per-title encryption keys survive re-ingest so grants stay valid; re-ingest mints
  the next feed generation and purges the old; delete purges the title from disk.
  Registers over the existing `register` RPC as **`type:'vod'` + `durationSec`**
  under its own enrolled publisher. Own authed control API + minimal UI
  (`127.0.0.1:3320`: titles CRUD, ingest progress, logs, admins) + unauthenticated
  `/healthz`, Dockerfile + compose service behind the `vod` profile, `.env.example`.
- Panel: the catalog gains the **vod record class** — `durationSec`
  (payload-owned, like `feedKey`), **no `isLive`** (liveness is not a property a
  title has), status `'available'`/`'unavailable'` — additively beside `'live'`
  (byte-identical live records, so register idempotence is unaffected); grants/sealing,
  panel-authoritative metadata and blobsKey enrichment apply to titles unchanged.
- SDK: `resolve()` returns `type`/`durationSec` and for vod arms **none** of the
  live machinery (tune watchdog, zap-prefetch gate, hybrid probes, `feed-changed`
  follow — all key on the playlist ADVANCING, which a finished playlist never
  does); vod titles are never segment-warmed as zap neighbors; the localhost
  read-ahead prefetches a VOD playlist's **head** (a live one's tail); display list
  + RN mirror types carry `type`/`durationSec`/`status`. New required-lane
  **`test:vod`** e2e proves the whole chain on a local testnet, including that the
  watchdog provably does NOT arm for vod and DOES for live across zaps.
- **App VOD playback**: the worklet forwards the engine's
  `type`/`durationSec` as **`recordType`/`durationSec` on the `port` IPC reply**;
  `<AliranVideo>` disarms its live-edge stall-resync ladder while the served
  record is vod (a paused/seeking/finished playhead is by design — a resync would
  yank the title back to 0:00) and re-arms it on the next live serve, and gains an
  imperative **`seek()` handle** (`AliranVideoHandle`). In the app, titles ride
  the same surfaces as channels: a **Library rail** straight from the category
  machinery, rows/info showing a **runtime badge instead of LIVE** (no channel
  number — numbers and the CH+/CH- zap ring are live-only, so adding movies never
  renumbers the lineup), `status:'unavailable'` graying, no EPG slot, and the
  NowPlayingBar grows a phone **transport row** — play/pause, elapsed/runtime,
  tap-or-drag seek bar (pure JS, no native slider dep) that stays up while
  paused; end-of-title parks on ▶ and replays from the top. Zapping out of a
  title lands on channel 001 with every live behavior re-armed.

**Reseller panel (`reseller/`)**
- Standalone service that fronts the panel admin API with a **role hierarchy**
  and a **credit ledger**, so third-party resellers can activate and manage
  viewer accounts without holding real admin power. Deliberately a pure HTTP
  service (no P2P, no ffmpeg) that can run on the panel host or a different box;
  it authenticates to the panel as **one** dedicated admin. Two things it owns
  that the panel does not: the hierarchy (**admin → co-admin → super reseller →
  reseller**; the panel has no admin roles) and the **subscription clock** (the
  panel has no account expiry).
- **Credits are months** (1 credit = 1 month, flat; devices are not priced —
  the device count is an **admin-set policy inherited down the hierarchy**:
  accounts receive their creator's effective `maxDevicesLimit`, resolved live up
  the parent chain (`null` = inherit, root fallback = the env default); supers
  and resellers cannot set it, and only admin tiers hold a per-account
  override). Append-only JSONL ledger (the durable audit trail —
  the panel's activity feed is in-memory) with a global monotonic sequence and
  balances always **derived**, never stored: only admins/co-admins mint (even an
  admin's transfer debits their own balance), supers fund their resellers from
  their own balance, activation/renewal costs `months` credits, delete refunds
  `floor(remaining)` to the owner (admin ops are free + refundless).
- **Trials**: free time-boxed accounts (`TRIAL_HOURS`, per-reseller daily cap);
  renewing a trial converts it to paid with the same credentials.
- **Channel packages are the reseller's product unit**: the panel's bouquets
  define *what* an account gets, credits *for how long* — **packages carry no
  credit price and no per-reseller restriction layer** (any account-managing
  principal lists and assigns them all). A cached `GET /api/packages`
  passthrough feeds the pickers; `activate` takes `packages` (an explicit pick
  **replaces** the panel's `default` bouquets — package-less activations stay
  panel-driven); `POST /api/accounts/:acct/packages` replaces them later
  (panel-validated); the account view carries live provenance (`packages` +
  `manualGrants`); and the reconcile sweep re-asserts the chosen bouquets when
  the live panel record drifts (never stripping defaults off accounts that made
  no explicit choice). Covered revokes are honest end-to-end — `stillGranted:
  true` in the API when a package re-seals the channel, *"still granted via
  package …"* in the dashboard toast. The activate form gains the package
  multi-select (resolved-channel counts, defaults pre-checked) beside the
  per-stream picker labeled **extra channels (one-offs)**, and the row menu
  gains *Channels & packages…* (provenance chips: ▣ package / one-off / dashed
  auto) and *Manage packages…*.
- **Fail-closed** account ops (panel first, local ledger + registry only on OK —
  a rejected activation leaves nothing behind) run under one process mutex.
  Account names are **plain panel usernames** (first come, first served — a
  clash surfaces as the panel's own error); ownership lives in the registry,
  never in the name, and creates are bracketed by an **intent journal** so a
  crash between the panel create and the local commit is found later. The
  **expiry sweep** disables lapsed accounts on the panel (backs off while the
  panel is unreachable; the work list re-derives each tick), and a **reconcile
  sweep** checks every registered account (and stale intents) against the panel,
  reporting (and, with `RECONCILE_REPAIR=1`, repairing) divergences with the
  local clock winning — operator-created panel users stay invisible to it.
- Own worker-thread single-flight Argon2id login (the 2026-07-16 flood lesson),
  role never trusted from the token (the live record is re-read each request, so
  a suspension bites immediately), a no-build four-role dashboard on the shared
  theme, a bootstrap CLI, `.env.example`, Dockerfile + compose service behind
  the `reseller` profile, and the required-lane `test:reseller-unit` +
  `test:reseller` (the latter drives a real in-process panel admin server).
  Docs: [reseller panel guide](docs/reseller-panel.md) + reference API section.
- **Built for large account lists**: the accounts query runs server-side over
  the in-memory registry — case-insensitive search across name *and* owner,
  status filters (active/disabled/expiring/trial), sorting by name / expiry /
  created date / status / owner (asc or desc), offset paging with a `total`.
  The dashboard shows **50 per page** with prev/next + a jump-to-page selector
  and a sort dropdown, debounced search, click-an-owner drill-down for
  admins/supers, and **reflows into stacked cards on phones** (the wide table on
  desktop). Verified against a synthetic 5,000-account registry (unit) and a
  394-account live demo at both desktop and mobile widths (browser).
- **Ops dashboard on login**: the Overview shows the business KPIs and, for
  admin tiers, a **System** section fed by `GET /api/system` — host stats
  (cpu/load/memory/uptime + data-dir disk), the service process (node, memory,
  ledger/sweep health) and a **live timed probe** of the panel admin API
  relaying its user/stream/admin counts; polls every 5 s while the view is
  open, and a panel outage becomes data on screen instead of an error.
- **Cloudflare Tunnel deployment option** for boxes behind NAT/CGNAT or a
  closed firewall: `deploy/cloudflared.compose.example.yml` publishes the
  loopback-bound dashboard through Cloudflare's edge (their TLS/CDN/WAF,
  outbound-only — no inbound port), and `TRUST_PROXY_HEADER` (e.g.
  `cf-connecting-ip`, or `x-forwarded-for` behind Caddy/nginx) keys the login
  lockout on the proxied client IP instead of the proxy's shared socket — set
  only when the port is reachable exclusively through the proxy.
- **White-label**: `BRAND_NAME`, `BRAND_LOGO_FILE`, `BRAND_FAVICON_FILE`,
  `BRAND_LOGIN_BG_FILE` (full-viewport login backdrop with an automatic
  readability scrim), `BRAND_LOGIN_STYLE` (built-in token-derived login
  patterns: glow/plain/grid/dots/stripes) and `BRAND_THEME_FILE` (JSON
  overriding any of the 11 shared theme tokens) rebrand the dashboard with no
  source edits — served as public `/branding.json`/`.css` +
  `/branding/logo|favicon|login-bg`, layered after the byte-identical shared
  theme block (the theme seam, wired up); without a favicon file the tab dot
  follows the accent. Full manual (variables, image formats/sizes, what each
  token paints): docs/white-label.md.
- **English and Spanish dashboard.** A `Language` control on the login card and
  in Settings retranslates the whole surface live, dates and number formats
  included. The choice is per browser (`localStorage`), which is what lets the
  *sign-in card* be translated — before sign-in there is no principal to hold a
  preference — and it costs no API route, no store write and no env variable.
  With nothing stored it follows the browser and falls back to English. It is
  independent of white-labeling: brand headings, `/branding.json` and
  `/branding.css` are never touched. Data stays as it is (account and principal
  names, ledger notes, channel titles), as does text the service composes.
  The catalog is one dependency-free script, `reseller/control-ui/i18n.js` —
  **not** `@aliran/i18n`, which is TypeScript for a bundler this dashboard does
  not have. `test:i18n` grew a section for it: key and placeholder parity, the
  `[[code token]]`s held identical across locales, a usage scan of the two
  files that consume it, and the runtime itself executed under a stub DOM.
- **Automated credit top-ups**: `WEBHOOK_SECRET` enables
  `POST /api/webhooks/credits` — HMAC-SHA256-signed (`"<ts>.<raw body>"`,
  constant-time compare, ±300 s replay window), **idempotent by event id**
  (provider retries mint nothing), landing as a normal `MINT` ledger line with
  actor `webhook` so the audit trail stays complete; 404 without a secret.

**Networking (all components)**
- Swarm UDP socket buffers are sized at startup instead of inherited. UDX multiplexes
  every peer stream of a swarm onto one socket pair, so under viewer fan-out the socket
  buffer overflows first — and the kernel drops those packets **silently**, which
  presents as stalling playback rather than an error. udx raised only the receive side
  (1 MiB) and left the send side at the OS default (~208 KiB); both are now set
  (`SWARM_RCVBUF_MB` / `SWARM_SNDBUF_MB`).
- Because `setsockopt` is silently clamped to `net.core.{r,w}mem_max` — and Linux stores
  double what it grants, so a readback cannot detect a partial clamp — the ceiling is
  read from `/proc` and a clamped request logs a warning naming the exact sysctl, once
  per process. Raising the ceiling is a **host** action Docker cannot do for you (`net.*`
  sysctls belong to the host under `network_mode: host`), so it ships as an **optional
  standalone script** — `deploy/sysctl/install.sh` + its drop-in — that nothing in the
  normal deploy calls, documented under "Host network tuning" in the
  [operator guide](docs/operator-guide.md) and the
  [network-tuning KB page](docs/kb/network-tuning.md) (which also covers conntrack and fd
  limits); `test:nettune` in the required CI lane.
- The **viewer engine now tunes its swarm too** — asymmetrically: 2 MiB receive
  (a viewer's whole download funnels into one socket pair while the worklet thread is
  busy decrypting), send left at the OS/udx default (reseed upload is opportunistic).
  SDK option `swarm: { rcvbufMb, sndbufMb }` overrides, mirroring the server envs. The
  tuning logic split into runtime-agnostic `core/net-tune-core.js` (no `node:fs` in
  the Bare worklet bundle graph — the `/proc` ceiling read uses the engine's injected
  `fs` and degrades gracefully where `/proc` is unreadable, e.g. Android) with
  `core/net-tune.js` as the Node binding; outcome surfaces as a `status`/`net:tuned`
  event and a `[net] swarm sockets tuned: …` worklet log line. Packages bumped to
  0.1.1 (`@aliran/core` gains the new entry point; `@aliran/player-sdk` requires it).

**Deploy + CI + tooling**
- Deploy pack: root-context Dockerfiles, host-network Docker Compose, systemd units,
  Caddy TLS recipe, `sysctl` drop-in; CI runs the deterministic suites, best-effort DHT
  e2e, and docker-build smoke on every push.
- Publishing the dashboards, hardened by a real deployment: `deploy/Caddyfile.example`
  now ships the **scoped** `basic_auth` pattern (`@ui not path /api/*` — the dashboards
  send `Authorization: Bearer` to their own APIs and HTTP has one `Authorization`
  header, so an unscoped gate 401s every API call and the browser re-prompts on every
  click), states the resulting posture honestly (UI gets two gates, the API keeps its
  one rate-limited Bearer gate; a `remote_ip` allowlist is the real second layer), and
  links the full walkthrough `docs/kb/public-dashboards.md` — DNS-first ordering,
  credential hygiene, the verification that actually catches the header collision, and
  the ufw ephemeral-UDP rule without which a default-deny firewall silently degrades
  P2P seeding.
- e2e suites for every subsystem (`test:core`, `test:sdk`, `test:admin-api`,
  `test:broadcaster-api`, `test:register`, `test:repeater`, `test:serve`,
  `test:retention`, login-flood suites, …) plus `tools/acceptance-remote.mjs` — a
  remote viewer proof over the public DHT with per-channel deadlines and a direct
  https probe for redirect channels.

### Fixed (each proven by a regression test; details in [docs/devlog.md](docs/devlog.md))
- SDK: re-zap deadlock (feed cache), teardown race, media-server abort crash,
  stalled media reads on reclaimed blobs, tune watchdog standing down on stale or
  metadata-only playlists, wedged-connection reuse, hybrid probes trusting
  unservable feeds, tuning-pill lifecycle bleed, erroring-channel retry no-op,
  unbounded per-bee caches.
- Panel/broadcaster: **Argon2id admin verification moved off the event loop**
  (worker thread + single-flight 503 + verify timeout) on both admin APIs — a login
  flood can no longer freeze media or viewer logins; PanelLink re-finds a restarted
  panel (ephemeral swarm identity) instead of stranding registrations; broadcaster
  re-registers preserve admin-owned fields (curation, art, redirect class).
- Panel: **`register` is idempotent** — the rebuilt catalog record is compared against
  the stored one and an unchanged re-register is **not re-put**, the same bee-frugality
  rule the source sync already followed. The broadcaster re-asserts every *running*
  stream on a 5-minute heartbeat, and the signed bee is append-only with no compaction,
  so each of those used to cost a block forever: 43 channels = **12,384 redundant
  appends/day (~5.8 MiB/day measured, monotonic)**. Real changes still write — feedKey
  rotation, `isLive`/`status` flips, and a change of `origin` (a different publisher
  taking over a channel is an attribution change the audit trail must keep). The
  private secrets file is still written on the skipped path, and the `blobsKey`
  enricher is still nudged, because that heartbeat is its retry timer. No-op registers
  also stop flooding the 200-entry activity ring, which they otherwise evicted whole
  every ~20 minutes at 43 channels.
- Panel: the **`blobsKey` enricher no longer leaks a core per probed feed**. Its probe
  drives are keyed, so corestore filed them on the panel's own disk regardless of the
  probe namespace, and `close()` only ended the session — the cores stayed forever.
  Growth tracked *distinct feedKeys ever seen*, so periodic feed rotation made the
  control plane grow with rotations × channels, unbounded. Each probe now purges the
  cores it opened; `test:register` asserts the panel's core set is unchanged across
  repeated feedKey rotations.
- Panel: **stray cores from older builds are reclaimed at start**. Purging probes as they
  run bounds new growth but leaves whatever a pre-fix build already stranded, and hand-
  deleting it is not an option — the panel's bee is the single-writer origin of truth for
  accounts and the catalog, with no peer to re-replicate a wrongly deleted core from.
  `openStore()` now sweeps every core directory the panel cannot account for, reusing the
  broadcaster's retired-generation GC (lifted to `@aliran/core/store-gc.js`). It runs at
  open, before the enricher can start a probe, and refuses to delete anything unless all
  **three** of the panel's own cores resolve — plus everything the store holds open is kept
  regardless, so a future fourth core is safe by default. `test:register` plants strays
  (including an unopenable one), restarts, and asserts they are gone while accounts,
  catalog and assets survive — and that the next start reclaims nothing.
- MCP: **a channel source can no longer be corrupted silently**. `broadcaster_add_channel`
  / `broadcaster_update_channel` declared `input` and `transcode` as `z.any()`, which
  publishes an *empty* JSON Schema — a client with no type information for a parameter
  hands objects over as JSON strings, so `{kind:"pull",url}` reached `normalizeInput()`
  as a string, failed the url-scheme test, and landed in the catch-all that stores any
  other string as `{kind:"file", path}`: the whole JSON blob became a file path, behind
  an HTTP 200 and a normal-looking response body. Four production channels lost their
  source that way. Both fields are now **typed** (a discriminated union mirroring
  `normalizeInput`/`normalizeTranscode`, so clients get the real shapes), a stringified
  object is **parsed back** before it is forwarded, and a malformed one is a loud
  validation error. `normalizeInput` independently refuses a brace-leading string
  instead of taking it for a path (`400`, not a dead channel). `test:mcp` drives the
  server as an MCP client and asserts the published schema is non-empty, that object and
  stringified-object inputs both round-trip to `kind:"pull"`, and that every malformed
  form is rejected with the stored source left intact; `test:args` covers the
  broadcaster-side rejection.
- Ops: live feeds no longer grow unbounded (~1–2 GB/h/channel → O(window));
  orphan-pin disk reclaim; remote acceptance always ends with a verdict.

### Changed

- **Docs rewritten to Simplified Technical English** — every user-facing
  page under `docs/`, the top-level `README.md`, and every package `README.md`
  were rewritten for clarity: one instruction per sentence, active voice,
  present tense, short sentences, and one approved term per concept (panel,
  broadcaster, channel vs. stream, grant, package, …). This is a prose-clarity
  pass only — no command, config value, default, or fact changed. `docs/devlog.md`
  stays untouched, as historical record.

### To do (see [ROADMAP.md](ROADMAP.md) and per-package READMEs)
- GPU transcode pack — a separately-packaged bare-metal deploy pack (NVIDIA
  drivers + NVENC; VAAPI/QSV variants) for hardware-encode hosts.
- Panel HA replica set; the pre-1.0 hardening/security-review pass.
- (DRM and geo-locking were dropped from the roadmap in 2026-07 — deliberately
  not built; see the security model's no-DRM stance.)
