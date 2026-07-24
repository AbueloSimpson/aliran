# Content Management

## Catalog & metadata

Streams live in the panel's signed catalog (`catalog/<streamId>`). Metadata is written
only by the panel (via `admin-cli`), appended and signed; clients see changes live via
`bee.watch()`.

- Slow-changing fields (title, description, category, art, order) → durable catalog.
- Volatile fields (`viewerCount`, `isLive`) → derived/gossiped (peer counts / a
  low-frequency status flag), **not** written every few seconds (avoids log bloat).

```bash
admin-cli set-meta news --title "News 24" --description "..." --category news --featured
admin-cli set-meta news --order 10          # rail position 0-9999; --order null clears
admin-cli upload-art news poster ./poster.jpg      # into the assets Hyperdrive
```

**The panel owns what viewers see; the broadcaster is just the stream.** A broadcaster
re-registering its stream updates only the **feed** (`feedKey`) and **liveness**
(`isLive`). Everything descriptive is **admin-owned** — `title`, `description`,
`category`, art (`poster`/`backdrop`/`logo`), the program guide (`epgUrl`/`epgId`),
curation (`order`/`featured`), and the redirect class (`url`). The broadcaster **seeds**
`title`/`description`/`category` **once, when it first creates a channel**; after that a
re-register never changes them. So to rename or recategorize a P2P channel, **edit it in
the panel** — it sticks (changing the broadcaster's config no longer propagates those
fields). Client UIs sort rails by `order` and prefer `featured` live streams for the
hero slot.

**Deleting a stream** (`delete-stream` / `DELETE /api/streams/:id`) is a full purge:
catalog record, panel-private key, every user's sealed grant, and its art. Clients
that already unsealed the key may have it cached — full revocation of live content is
a key rotation — and re-adding the id mints a fresh key.

## Assets (posters/backdrops/logos)

Art fields (`poster`, `backdrop`, `logo`) accept **two forms** — hybrid art:

- **P2P (default):** upload via `admin-cli upload-art` / `POST /api/streams/:id/art/:kind`
  (or the dashboard's per-kind upload button). Stored in a **panel-seeded assets
  Hyperdrive**, replicated by clients and served from the app's localhost server
  (`/assets/…`). Content-addressed → automatic cache-bust. No web host needed.
- **Remote URL passthrough:** set the field to an absolute **`https://` URL**
  (`set-meta` / `PATCH /api/streams/:id` / the dashboard's "url" button). The SDK
  passes it through to clients **unchanged** — viewers fetch it directly from your web
  host or CDN, nothing replicates P2P. **https is required**: Android blocks cleartext
  HTTP off-loopback, so an `http://` poster would fail silently on devices — the panel
  rejects it. Cache-busting is on you (version the URL when the image changes).

An empty string clears an art field. The two forms mix freely per stream and per kind
(e.g. P2P poster + remote backdrop).

## Redirect channels (CDN link)

A stream can be a **redirect channel**: instead of a P2P feed it carries an absolute
**`https://` playback URL** (HLS) that viewers play **directly** — the app hands the
link to its player, nothing replicates P2P and no broadcaster is involved.

```bash
# dashboard: fill "Redirect URL" in Add stream / Edit metadata (empty clears)
POST  /api/streams        {"id":"promo","title":"Promo","url":"https://cdn.example.com/promo/index.m3u8"}
PATCH /api/streams/promo  {"url":"https://cdn.example.com/promo/v2/index.m3u8"}  # reaches viewers on their next tune
PATCH /api/streams/promo  {"url":""}                                             # clears the class
```

- Setting a non-empty `url` marks the record `redirect: true`; an empty string clears
  both — the pair can never disagree. **`https://` is required** (same Android
  cleartext rule as remote art), max 2048 chars; query strings (CDN tokens) pass
  through verbatim and there is no file-extension requirement.
- A redirect channel **cannot have a `feedKey`** (and vice versa) — it is a different
  class of entry, and the panel rejects mixing them. A broadcaster re-register never
  erases the class (same admin-owned protection as curation/art).
- **Liveness is admin-managed**: with no broadcaster heartbeat, setting a url defaults
  the record to `isLive: true` / `status: 'live'` (explicit values in the same request
  win); clearing it defaults back to idle. There is no automatic URL health probe — a
  dead link plays nothing until you fix it.
- Grants gate the channel like any other (it only appears for entitled users), but the
  **URL itself is public**: it rides the replicated catalog exactly like remote art
  URLs. Use your CDN's tokenized/signed URLs if the link must not be shareable.

## Remote channel sources (provider feeds)

A **source** pulls a provider-prepared JSON of channels from a URL on a schedule and
materializes it as a **category of [redirect channels](#redirect-channels-cdn-link)** —
one admin action turns a curated list (say, an anime lineup) into a rail of playable
channels, kept in sync daily. P2P channels tagged with the same `category` share the
rail; the category field is ordinary catalog metadata either way.

```bash
# dashboard: Sources tab → Add (name, feed URL, category label) — the add auto-syncs
POST  /api/sources               {"name":"anime","url":"https://provider.example/anime.json","category":"Anime"}
POST  /api/sources/anime/sync    # pull + diff + grant NOW (also: dashboard "Sync now")
PATCH /api/sources/anime         {"intervalMs": 43200000}         # any field; enabled:false pauses the schedule
DELETE /api/sources/anime        # purges its channels; ?keepChannels=1 detaches them instead
```

**Feed format** — `{"channels": [...]}` (or a bare array), one object per channel:

```jsonc
{ "id": "plutotv.es.629a06…",              // → stream id "<prefix><id>" (prefix defaults to "<source>.")
  "name": "Detective Conan",               // → title
  "logo": "https://…/logo.png",            // → logo art (https; invalid/http logos degrade to no art)
  "url":  "https://…/index.m3u8",          // → the redirect playback URL (https required — entry skipped otherwise)
  "provider": "plutotv",                   // → description "via plutotv" (optional)
  "epg": [ { "title": "…", "start": "…", "stop": "…" } ] }   // NOT imported — see EPG below
```

Feed position becomes the curation `order`; the **category label is yours**, set on the
source — the feed's own category strings are ignored (a provider never names your rails).

**Sync policy:**

- **The feed wins on the fields it maps** (title, description, url, logo, order,
  category) — manual edits to those on an imported channel are overwritten on the next
  sync. Curation fields it does not map (`featured`, an explicit `isLive` flip) stick.
- **A channel that leaves the feed is removed** — full purge, grants included.
  Removing the whole source purges everything it owns, unless you detach with
  *keep channels*.
- **Auto-grant** (default on): every user is granted every imported channel, reconciled
  on **every** sync — and immediately at user creation — so accounts created between
  pulls converge. As with any grant, a device picks new channels up at its next login
  (app restart). Turn it off per source to gate the category: either grant by hand, or
  put a `source:<name>` member in a **[channel package](user-management.md#channel-packages-bouquets)**
  so only package holders get the lineup (and follow it as the feed drifts). With
  auto-grant off, formerly-auto grants that no package or manual grant covers are
  removed on the next package reconcile — turning it off actually converges access
  instead of leaving permanent stragglers.
- **Deselect channels you don't want**: the Sources tab's **channels** button opens a
  checkbox list of every feed entry — unchecking one **excludes** it (removed
  immediately, grants included, and skipped on every future sync; the feed cannot
  re-add it). Re-check to re-import. Also: `set-source <name> --exclude "id1,id2"`
  (feed ids, `""` re-includes all) or `PATCH /api/sources/:name {exclude:[{id,title}]}`.
  Exclusions survive feed updates and ETag 304s.
- Syncs are frugal: an unchanged feed (or an HTTP 304 off the stored ETag) writes
  **nothing** to the replicated catalog.
- A failed pull (network, oversized, invalid JSON) keeps the **last good state** and
  surfaces the error in the Sources tab; the next tick retries.

**Trust boundary:** the feed is third-party **data, never instructions**. Every entry
passes the same validators as admin input (https playback URL, art rules, id charset),
entry count and byte size are capped (`SOURCES_MAX_CHANNELS` / `SOURCES_MAX_BYTES`),
and ownership is explicit — imported records carry `source: <name>`, and a sync can
only create/update/delete records stamped with **its** name. A colliding id that
belongs to a manual channel or another source is skipped and reported as a conflict.

**EPG (program guide):** provider feeds often carry a schedule per channel (an `epg`
array of `{title, start, stop}` with ISO times). It is deliberately **not** imported
into the catalog — the replicated Hyperbee is append-only, so a day of schedule per
category would grow every client's store forever. Instead each imported record carries
two pointers, `epgUrl` (the same feed URL) and `epgId` (the channel's id inside it),
and **the app fetches the guide directly over https, on demand**:

- Opening a channel's **Info panel** shows a live **Now / Up next** guide (current
  program with an elapsed bar, then the next few) built from the feed. Channels with
  no EPG keep an honest "No program information" placeholder — never fabricated data.
- **One fetch serves a whole category** — every channel in a source shares the URL, so
  the client caches per-URL and revalidates with ETag (a refresh that finds nothing new
  is a 304). Cost is a handful of ~tens-of-KB fetches per active viewer per day; **zero
  panel storage, zero replication, zero VPS bandwidth**. Playback never depends on it —
  an unreachable or malformed feed just yields the placeholder.
- Same public-https trust stance as remote art and redirect URLs: the viewer's device
  fetches the JSON from the provider's host directly.

This works for **any** channel, not just imported ones: set `epgUrl` + `epgId` on a P2P
channel (via `set-meta`/`PATCH /api/streams`) pointing at a compatible JSON, and the
same guide lights up. Leave them unset for the placeholder.

## Channel ingest & transcode

How a channel's media gets IN (test / file / pull URL / RTMP / SRT / UDP-TS push)
and how it's encoded (copy passthrough, x264, GPU) is **broadcaster** configuration —
manage it in the broadcaster control dashboard (kind + transcode under Edit, push URL
on the card, ffmpeg logs behind the Logs button). See the
[operator guide](operator-guide.md#e-broadcaster-input) and
[reference](reference.md#broadcaster-control-api-ui-control_enabled1). The panel
only learns the resulting feed identity through the register RPC.

## Live vs VOD

Two record classes share the catalog, the grant machinery, and the P2P transport:

- **Live** (`type:'live'`, the default): a rolling HLS window in a Hyperdrive, fed
  by the **broadcaster**. Carries `isLive`; segments rotate out and are reclaimed.
- **VOD** (`type:'vod'`): an on-demand **title** served by the standalone
  **[library](vod-library.md) service** — a finished HLS VOD rendition
  (`#EXT-X-PLAYLIST-TYPE:VOD`, **all** segments kept) in its own encrypted
  Hyperdrive. The record carries `durationSec` and **no `isLive` at all** (liveness
  is not a property a title has); `status` is `'available'` while the library seeds
  it, `'unavailable'` after the library deletes it. Seek works via HTTP Range — any
  peer serves any range. Viewers need nothing new: a granted title unseals exactly
  like a channel.

The split is deliberate: ingest for VOD is a one-shot transcode burst and then a
static seed, so it runs in a separate service on whatever box has the disk and CPU —
never inside the live pipeline. Registering a title happens in the **library control
UI/API** (id, input file/URL, seed metadata); after creation the descriptive metadata
(title/description/category/art) is **panel-authoritative**, same as channels: edit
it in the panel dashboard. Grant/revoke, categories/rails, curation and art all work
identically for both classes. To retire a title: delete it in the library (stops
seeding + purges its data), then remove the catalog record and grants in the panel.

*Not built yet (v1 candidates): auto-record live → VOD catch-up, series/episode
metadata, repeater mirroring of titles, multipart upload through the control API
(v1 ingests a path/URL the library box can reach).*

## Content protection

There is no DRM and no geo-restriction — deliberately. Access control is encrypted
feeds + per-user sealed keys + stream-key rotation; the
[security model](security-model.md#no-drm-no-geo-locking-deliberately) states
exactly what that defends against and what it doesn't.
