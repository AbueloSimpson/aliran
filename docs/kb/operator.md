# Operating the panel & broadcaster

Operational lore for running the demo/dev stack. The full reference is the
[Operator guide](../operator-guide.md) and [Content management](../content-management.md).

## Broadcaster env for ingesting an external origin

Run `node src/index.js` from `broadcaster/` with:

- `INPUT=<hls/rtsp url or file>` — the origin to ingest (ffmpeg must be on PATH)
- `STREAM_ID=<catalog id>`
- `PANEL_PUBKEY=<panel public key>`
- `PUBLISHER_KEY=<secretKey from the panel's DATA_DIR/keys/publisher.json>`
  (written by `admin-cli init`; registration is refused without it)

## Re-registering a stream silently clobbers its curated title/category

- **Cause:** the `register` RPC merges the catalog record, but the broadcaster always
  sends a title and a category array — leaving `TITLE`/`CATEGORY` unset overwrites
  curated values (title falls back to the stream id, category to `[]`).
- **Fix:** **always set `TITLE` and `CATEGORY`** when re-registering an existing
  stream. Poster/backdrop/logo art *is* preserved by register.

## Users "have access" but can't decrypt after attaching a broadcaster

- **Cause:** user grants seal the stream's encryption key. A **fresh broadcaster
  generates a NEW key** and registers it — silently invalidating every existing grant.
- **Fix:** when attaching a broadcaster to a stream created via `admin-cli
  add-stream`, copy the stream secret from the panel's private
  `DATA_DIR/secrets/streams.json` into the broadcaster's `data/feed.key` **before
  first start**. (Alternative: re-run `admin-cli grant` for every user afterwards.)

## `ELOCKED: File is locked` starting the panel or admin-cli

- **admin-cli and the panel cannot run concurrently** (same Corestore): stop the
  panel, run admin-cli, restart the panel. Registration, by contrast, *requires* the
  running panel.
- Right after killing a panel process, a restart can still hit `ELOCKED` for a few
  seconds until the dead process's file locks release — retry, don't debug.

## Dev processes rot

Long-running dev panel/broadcaster processes wedge silently:

- An hours-old **panel** can stop answering DHT connects while looking alive in the
  process list. Health check: a small hyperswarm read of `catalog/*` from another
  machine (seconds when healthy). Restarting the panel is always safe.
- The broadcaster's **ffmpeg can die without a log line** while the broadcaster keeps
  "seeding" a frozen playlist. Health check: is ffmpeg running, and is the HLS temp
  dir's mtime advancing? Restarting the broadcaster is always safe (feed identity
  persists in its data dir — grants stay valid *if* `feed.key` is present).
- Clients that were connected when the panel bounced may need an app restart to shed
  stale swarm state (see the login-stall entry in [playback](playback.md)).

## Every channel shows `registered:false` after a panel restart

- **Symptom:** the panel and broadcaster restarted around the same time (e.g. `docker
  compose up -d --build`, host reboot); streams keep playing, but every channel sits
  at `registered:false` and the panel catalog stops tracking liveness. Current builds
  say why — `registerError: "no panel connection for Ns"`; older builds showed a
  silent `registerError: null`.
- **Cause:** the panel's swarm identity is ephemeral — a restarted panel announces
  the registration topic under a brand-new keypair. A broadcaster that resolved the
  topic just before (or during) the restart holds a dead peer record, and hyperswarm
  re-queries a client-mode topic only every ~10 minutes on its own.
- **Fix:** none needed on current builds. While registrations are stranded with no
  panel socket, the broadcaster forces fresh topic lookups (5 s → 60 s backoff) and
  re-registers as soon as the new announce lands — typically well under a minute.
  If `registered` stays false for several minutes anyway (or you run a pre-hardening
  build), restart the broadcaster. Either way playback is unaffected: running feeds
  keep streaming; only catalog liveness/registration lags.

## Identifying which process is which

The panel and broadcaster both run as `node src/index.js` — the command line alone
won't tell them apart. Distinguish by working directory / parent process, or when
hunting a stuck ffmpeg, match its command line by the HLS output directory it writes.

## Latency expectations (healthy system)

- First DHT connect from a fresh client store: **30–90 s**; subsequent logins ~10 s.
- After play: a few seconds of playlist 404s while the live edge replicates.
- `1 peer` means the broadcaster only; more viewers = more seeders.
- **Time-to-play jumps back to 40–55 s after every broadcaster restart?** You're on
  `FEED_BUFFER=ram` — each restart mints a new feed identity, so viewers re-pay a cold
  DHT discovery. Switch to the default `FEED_BUFFER=disk` for a stable, warm topic.
  See [P2P feed buffer & tuning](feed-buffer.md).
