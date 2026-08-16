# Content Management

## Catalog & metadata

Streams live in the panel's signed catalog (`catalog/<streamId>`). Only the panel
writes metadata (via `admin-cli`), and it appends and signs every change. Clients
see changes live via `bee.watch()`.

- Slow-changing fields (title, description, category, art, order) go to the
  durable catalog.
- Volatile fields (`viewerCount`, `isLive`) are derived or gossiped — peer counts,
  or a low-frequency status flag — **not** written every few seconds. This avoids
  log bloat.

```bash
admin-cli set-meta news --title "News 24" --description "..." --category news --featured
admin-cli set-meta news --order 10          # rail position 0-9999; --order null clears
admin-cli upload-art news poster ./poster.jpg      # into the assets Hyperdrive
```

**The panel owns what viewers see; the broadcaster is just the stream.** A
broadcaster re-registering its stream updates only the **feed** (`feedKey`) and
**liveness** (`isLive`). Everything descriptive is **admin-owned**: `title`,
`description`, `category`, art (`poster`/`backdrop`/`logo`), the program guide
(`epgUrl`/`epgId`), curation (`order`/`featured`), and the redirect class (`url`).
The broadcaster **seeds** `title`/`description`/`category` **once, when it first
creates a channel**. After that, a re-register never changes them. So to rename or
recategorize a P2P channel, **edit it in the panel** — the change sticks, and
changing the broadcaster's config no longer propagates those fields. Client UIs
sort rails by `order` and prefer `featured` live streams for the hero slot.

**Deleting a stream** (`delete-stream` / `DELETE /api/streams/:id`) is a full
purge: the catalog record, the panel-private key, every user's sealed grant, and
its art all go. Clients that already unsealed the key may have it cached — full
revocation of live content needs a key rotation — and re-adding the id mints a
fresh key.

## Assets (posters/backdrops/logos)

Art fields (`poster`, `backdrop`, `logo`) accept **two forms** — hybrid art:

- **P2P (default):** upload via `admin-cli upload-art` /
  `POST /api/streams/:id/art/:kind` (or the dashboard's per-kind upload button).
  This stores the asset in a **panel-seeded assets Hyperdrive**, replicated by
  clients and served from the app's localhost server (`/assets/…`). Storage is
  content-addressed, so cache-busting is automatic. No web host is needed.
- **Remote URL passthrough:** set the field to an absolute **`https://` URL**
  (`set-meta` / `PATCH /api/streams/:id` / the dashboard's "url" button). The SDK
  passes it through to clients **unchanged** — viewers fetch it directly from your
  web host or CDN, and nothing replicates P2P. **https is required and the panel
  rejects an `http://` art URL outright.** Art has no per-source cleartext
  exemption — the one that exists is for stream URLs only — and a build whose
  network security config blocks cleartext fails an `http://` poster *silently*,
  with no error anywhere. Cache-busting is on you — version the URL when the
  image changes.

An empty string clears an art field. The two forms mix freely per stream and per
kind — for example, a P2P poster with a remote backdrop.

## Redirect channels (CDN link)

A stream can be a **redirect channel**: instead of a P2P feed, it carries an
absolute **`https://` playback URL** (HLS) that viewers play **directly**. The app
hands the link to its player. Nothing replicates P2P, and no broadcaster is
involved.

```bash
# dashboard: fill "Redirect URL" in Add stream / Edit metadata (empty clears)
POST  /api/streams        {"id":"promo","title":"Promo","url":"https://cdn.example.com/promo/index.m3u8"}
PATCH /api/streams/promo  {"url":"https://cdn.example.com/promo/v2/index.m3u8"}  # reaches viewers on their next tune
PATCH /api/streams/promo  {"url":""}                                             # clears the class
```

- Setting a non-empty `url` marks the record `redirect: true`. An empty string
  clears both, so the pair can never disagree. **`https://` is required** (the
  same Android cleartext rule as remote art), with a max of 2048 characters.
  Query strings (CDN tokens) pass through verbatim, and there is no
  file-extension requirement.
- A redirect channel **cannot have a `feedKey`** (and vice versa) — it is a
  different class of entry, and the panel rejects mixing them. A broadcaster
  re-register never erases the class (the same admin-owned protection as
  curation and art).
- **Liveness is admin-managed.** With no broadcaster heartbeat, setting a url
  defaults the record to `isLive: true` / `status: 'live'` (explicit values in
  the same request win). Clearing it defaults back to idle. There is no
  automatic URL health probe — a dead link plays nothing until you fix it.
- Grants gate the channel like any other, so it only appears for entitled users.
  But the **URL itself is public** — it rides the replicated catalog exactly like
  remote art URLs. Use your CDN's tokenized or signed URLs if the link must not
  be shareable.

### Playback headers (hotlink-protected URLs)

Some providers protect a direct URL against hotlinking. They serve it only when
the player sends a matching **Referer**, **Origin**, or **User-Agent**. A redirect
channel can carry these as playback `headers`, and the player sends them with every
request for the URL.

```bash
PATCH /api/streams/event-1 {"url":"https://provider.example/e1.m3u8","headers":{"referer":"https://provider.example/","user-agent":"Mozilla/5.0"}}
```

- Only three keys are allowed: `referer`, `origin`, and `user-agent` (the `referrer`
  spelling is accepted and folded onto `referer`). These are exactly the "forbidden"
  headers a player cannot set for itself, which is why the catalog carries them. Any
  other key is refused, so no `Authorization` or `Cookie` can be smuggled to every
  viewer's player.
- Keys are stored in lower case. Each value is at most 1024 characters and must not
  contain line breaks or other control characters.
- **Headers need a url.** A record with headers but no url is refused, and clearing
  the url clears the headers. The dashboard's Add stream / Edit metadata dialogs hold
  the three header fields; leave a field blank to leave that header unset.
- **Playback support.** The desktop app sets these headers in its main process (the
  browser engine cannot set them from the page), and patches the response so the
  cross-origin fetch is allowed. The phone app hands them to its player. The
  `aliran-kit` Kotlin binding sends them too. See
  [the SDK reference](sdk.md#redirect-channel-headers).

## Remote channel sources (provider feeds)

A **source** pulls a provider channel list from a URL on a schedule and
materializes it as a **category of [redirect channels](#redirect-channels-cdn-link)**.
One admin action turns a curated list — say, an anime lineup — into a rail of
playable channels, kept in sync on the source's schedule. P2P channels tagged with
the same `category` share the rail; the category field is ordinary catalog metadata
either way.

A source has a **`format`**: `json` (the default, below) or `m3u` (a standard
playlist — see [Playlist (M3U) sources](#playlist-m3u-sources)).

```bash
# dashboard: Sources tab → Add (name, feed URL, category label) — the add auto-syncs
POST  /api/sources               {"name":"anime","url":"https://provider.example/anime.json","category":"Anime"}
POST  /api/sources/anime/sync    # pull + diff + grant NOW (also: dashboard "Sync now")
PATCH /api/sources/anime         {"intervalMs": 43200000}         # any field; enabled:false pauses the schedule
DELETE /api/sources/anime        # purges its channels; ?keepChannels=1 detaches them instead
```

The scheduler scans due sources every 5 minutes (`SOURCES_TICK_MS` — a cheap
due-check, not a fetch), so a sub-hour `intervalMs` works with no extra tuning. The
default per source is daily; set `intervalMs` per source (for example, 30 minutes for
a token-rotating event playlist). A rotated URL reaches a viewer on the next tune,
with no re-login.

**Feed format** — `{"channels": [...]}` (or a bare array), one object per channel.
[`docs/demo/channels.json`](demo/channels.json) is a complete example. The
dashboard holds the same reference: click **feed format…** on the Sources tab, or
open the collapsed block inside **Add source**.

```jsonc
{ "id": "demotv.es.629a06…",               // REQUIRED → stream id "<prefix><id>" (prefix defaults to "<source>.")
  "url":  "https://…/index.m3u8",          // REQUIRED → the redirect playback URL (https; entry skipped otherwise)
  "name": "Moon Cat",                      // → title, cut at 200 chars (absent → the id becomes the title)
  "logo": "https://…/logo.png",            // → logo art (https; an invalid logo costs the art, not the channel)
  "description": "Cartoons, all day.",     // → seeded on the FIRST import only, then yours (see sync policy)
  "epg": [ { "title": "…", "start": "…", "stop": "…" } ] }   // NOT imported — see EPG below
```

The panel adds the prefix to the id. The result must contain only letters,
digits, `_ . -`, and 64 characters at most. The panel **skips** an entry with no
id, a bad id, or an id it already used, and it gives a reason for each one. It
imports the rest of the feed.

The position in the array sets the curation `order`, and the panel ignores an
`order` field in the entry. **You own the category label**, which you set on the
source. The panel ignores category strings in the feed, so a provider never names
your rails. The panel also ignores all other fields.

### Playlist (M3U) sources

Set `format: 'm3u'` (dashboard source dialog, `--format m3u` on the CLI, or `format`
in the API/MCP) to import a standard `#EXTM3U` playlist — the shape almost every IPTV
provider hands out. Each entry becomes a redirect channel, the same as a JSON source,
with these differences:

```bash
POST /api/sources {"name":"events","url":"https://provider.example/live.m3u8","format":"m3u","category":"Live Events","groups":["Live Events"]}
```

- **Playback headers.** `#EXTVLCOPT:http-referrer`, `http-origin`, and
  `http-user-agent` lines import as the channel's playback
  [`headers`](#playback-headers-hotlink-protected-urls). One bad header line drops
  that one header, never the channel.
- **Channel ids are name-slugs.** Playlist `tvg-id`s are routinely dummy values, so
  the id is a slug of the display name (prefix + slug, 64 characters at most, with
  `-2`/`-3` on a clash). A retitled event becomes a new id — this is normal for
  live-event lists, and the prune-and-grant machinery handles the churn.
- **Group filter.** `groups` selects which `group-title`s this source takes. It is a
  list (or a comma-separated string), matched case-insensitive and exact. Leave it
  empty (or unset) to take every group. Filtered entries are not errors — the sync
  report counts them separately as `filtered`.
- **Name filters.** `titleInclude` / `titleExclude` select one level below the group,
  on the entry's **display name** — the field a provider actually uses when a single
  group carries the whole day (`[MLB] Boston Red Sox at Toronto Blue Jays | TOR Feed`).
  Both are lists (or comma-separated strings) of case-insensitive **substrings**, never
  regular expressions. `titleInclude` takes an entry only if its name contains at least
  one of them; `titleExclude` drops an entry whose name contains one of them and **wins**
  over `titleInclude`, so "take the MLB games, but never the dead `(WEBCAST)` feeds"
  reads exactly as written. Each rule is 2–64 characters and may not contain a comma —
  the comma separates rules, and every surface that shows the list joins it with commas.
  Leave both empty for no name filtering; their leftovers land in the same `filtered`
  count as the group filter's. To make a rail per sport *without* naming the sports, see
  `autoSubcategory` below. A filter that matches **nothing** correctly prunes the
  whole rail (the feed *is* the membership), so the report flags that one shape as
  `emptiedByFilter` — check the rule against the playlist before assuming the provider
  went dark.
- **Program guide (opt-in, `epg`).** A playlist *does* name its guide: the `#EXTM3U`
  header carries `url-tvg="…"` (also spelled `x-tvg-url` / `tvg-url`), and each entry's
  `tvg-id` is that guide's channel id. Set `epg: true` on the source (dashboard
  **Program guide**, `--epg`, or the API/MCP field) and the panel keeps each entry's
  `tvg-id` as the channel's **`epgId`** — the field the [EPG service](epg-service.md)
  matches on to deliver the schedule over P2P. The default is **off**, and both guide
  fields are m3u-only (a JSON source refuses them: its own entry ids are already its
  guide ids).
    - **The header address is reported, never stored.** The panel reads `url-tvg` and
      shows it in the sync report as the guide the playlist declares, but puts it on
      **no** channel: it points at an XMLTV document, while the `epgUrl` an app fetches
      must be the provider-JSON shape described under **EPG** below. Register that
      address in your EPG service instead.
    - **`epgUrl` on the source** is the separate, operator-set pointer that *is* written
      to every imported channel. Set it only if you publish a compatible JSON guide
      (https required — the viewer's device fetches it). `""` clears it, and turning
      `epg` off clears it too.
    - **Leave `epg` off for an event playlist.** Those write one placeholder `tvg-id`
      across the whole day (`Soccer.Dummy.us` on every match, with filler programmes
      behind it), and the EPG service takes the **first** match on a duplicate — a
      shared id would collapse a hundred events onto one guide entry. As a guard the
      panel refuses any `tvg-id` it finds on more than one imported entry, or on a
      channel outside this source (another source, or one you made by hand): the
      incumbent keeps the id, the newcomer gets none, and the sync report counts them
      as `epgSkipped`. A mistaken opt-in therefore shows up as **no** guide, never a
      wrong one.

**Mixed playlists (one URL, many categories).** A provider list often mixes event
entries with regular channels that belong in different rails. Add **one source per
group set, all over the same playlist URL**, each with its own `groups`, `category`,
and `prefix`:

```bash
POST /api/sources {"name":"events","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Live Events"],"category":"Live Events","prefix":"ev."}
POST /api/sources {"name":"sports","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Sports"],"category":"Sports","prefix":"sp."}
```

Ids stay disjoint by prefix, so the sources never collide; each one syncs and prunes
on its own; and the shared ETag keeps the extra fetches cheap.

**One group, a rail per sport (child rails).** When the provider puts the whole day
inside *one* group and writes the sport into the **name**, the group filter cannot
reach it — split with disjoint `titleInclude` instead, same one-URL shape, and give
each source a two-level category (`Parent/Child` is already a child rail in the apps,
so no client change is needed):

```bash
POST /api/sources {"name":"mlb","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Live Events"],"titleInclude":["[MLB]"],"category":"Live Events/MLB","prefix":"mlb."}
POST /api/sources {"name":"nfl","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Live Events"],"titleInclude":["[NFL]"],"category":"Live Events/NFL","prefix":"nfl."}
POST /api/sources {"name":"events","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Live Events"],"titleExclude":["[MLB]","[NFL]"],"category":"Live Events","prefix":"ev."}
```

Keep the rules **disjoint**: an entry that two sources both take becomes two channels
(the prefixes keep the ids apart, so they never fight — you simply get it twice). Add
dead provider tags such as `(WEBCAST)` to `titleExclude` to drop entries that never
play.

**A rail per sport, without a list of sports (`autoSubcategory`).** The recipe above
names every sport in advance, and a live-event list does not hold still: it refreshes
every few minutes, and the sports in it change through the day. A source for a sport
the provider stopped carrying imports nothing, and a sport you did not plan for has no
rail at all. `autoSubcategory` reads the sport from the entry instead — **one** source,
no sport configured anywhere:

```bash
POST /api/sources {"name":"events","url":"https://provider.example/all.m3u8","format":"m3u","groups":["Live Events"],"category":"Live Events","autoSubcategory":true,"prefix":"ev."}
```

The panel takes the name in square brackets at the **start** of each entry and makes
the child rail from it, so `[MLB] Boston Red Sox at Toronto Blue Jays` goes to
`Live Events/MLB` and `[NFL] Chicago Bears at Green Bay Packers` to `Live Events/NFL`.
A sport that starts at 19:00 has its rail at 19:00, and a sport that ends leaves with
its channels. The sync report lists the rails it made in `subcats`.

Rules to know:

- **Give a category with one level.** The panel adds the second level. It refuses
  `autoSubcategory` on a `Parent/Child` category, because the apps show two levels.
- **Only the first name in brackets counts.** `[MLB] [HD] …` gives the rail `MLB`.
- **An entry with no name in brackets keeps your category** (`Live Events` here), and
  so does one whose brackets hold more than 32 characters — that is a description, not
  a label. No entry is ever lost: the worst result is your own rail.
- **Upper and lower case are the same rail.** `[MLB]` and `[mlb]` are one sport.
- **There is no list of known sports**, on purpose: a fixed list goes out of date the
  same way a list of sources does. Any name in brackets makes a rail.
- **At most 50 rails per sync.** Entries after that keep your category and are counted
  in the report as `subcatOverflow`.
- The setting is **off** unless you ask for it, it works only on `format:"m3u"`, and it
  is not compatible with the name-filter recipe above — use one or the other.

Turning it on moves the channels you already have; it does not replace them, so grants
stay. Turning it off puts them all back on your category. Either change makes the next
sync read the whole playlist again.

**Sync policy:**

- **The feed wins on the fields it maps** (title, url, logo, order, category).
  Manual edits to those on an imported channel are overwritten on the next sync.
  Curation fields it does not map (`featured`, the parental-control `restricted`
  flag, an explicit `isLive` flip) stick.
- **You own the description after the first import.** The panel copies a
  `description` from the feed when it creates the channel. No later sync writes
  over it, so a synopsis you write in the dashboard stays.
- **A channel that leaves the feed is removed** — a full purge, including grants.
  Removing the whole source purges everything it owns, unless you detach it with
  *keep channels*.
- **Auto-grant** (default on): every user is granted every imported channel,
  reconciled on **every** sync and immediately at user creation, so accounts
  created between pulls converge. As with any grant, a device picks new channels
  up at its next login (app restart). Turn it off per source to gate the
  category: either grant by hand, or put a `source:<name>` member in a
  **[channel package](user-management.md#channel-packages-bouquets)** so only
  package holders get the lineup, and they follow it as the feed drifts. With
  auto-grant off, formerly-auto grants that no package or manual grant covers are
  removed on the next package reconcile — turning it off actually converges
  access instead of leaving permanent stragglers.
- **Deselect channels you don't want**: the Sources tab's **channels** button
  opens a checkbox list of every feed entry. Unchecking one **excludes** it —
  removed immediately, grants included, and skipped on every future sync (the
  feed cannot re-add it). Re-check to re-import. Also: `set-source <name>
  --exclude "id1,id2"` (feed ids, `""` re-includes all), or `PATCH
  /api/sources/:name {exclude:[{id,title}]}`. Exclusions survive feed updates and
  ETag 304s.
- Syncs are frugal: an unchanged feed (or an HTTP 304 off the stored ETag) writes
  **nothing** to the replicated catalog.
- A failed pull (network, oversized, invalid JSON) keeps the **last good state**
  and surfaces the error in the Sources tab. The next tick retries.

**Trust boundary:** the feed is third-party **data, never instructions**. Every
entry passes the same validators as admin input (https playback URL, art rules,
id charset). Entry count and byte size are capped
(`SOURCES_MAX_CHANNELS` / `SOURCES_MAX_BYTES`), and ownership is explicit —
imported records carry `source: <name>`, and a sync can only create, update, or
delete records stamped with **its** name. A colliding id that belongs to a manual
channel or another source is skipped and reported as a conflict.

**EPG (program guide):** provider feeds often carry a schedule per channel (an
`epg` array of `{title, start, stop}` with ISO times). It is deliberately **not**
imported into the catalog. The replicated Hyperbee is append-only, so a day of
schedule per category would grow every client's store forever. Instead, each record
imported **from a JSON feed** carries two pointers, `epgUrl` (the same feed URL) and
`epgId` (the channel's id inside it), and **the app fetches the guide directly over
https, on demand**. (A playlist source carries pointers only when you opt in — see
**Program guide** under [Playlist (M3U) sources](#playlist-m3u-sources) — and its
`epgId` is the half that matters, because the guide reaches viewers over P2P.)

- Opening a channel's **Info panel** shows a live **Now / Up next** guide (the
  current program with an elapsed bar, then the next few) built from the feed.
  Channels with no EPG keep an honest "No program information" placeholder —
  never fabricated data.
- **One fetch serves a whole category** — every channel in a source shares the
  URL, so the client caches per URL and revalidates with ETag (a refresh that
  finds nothing new is a 304). Cost is a handful of tens-of-KB fetches per active
  viewer per day; **zero panel storage, zero replication, zero VPS bandwidth**.
  Playback never depends on it — an unreachable or malformed feed just yields the
  placeholder.
- Same public-https trust stance as remote art and redirect URLs: the viewer's
  device fetches the JSON from the provider's host directly.

This works for **any** channel, not just imported ones: set `epgUrl` + `epgId` on
a P2P channel (via `set-meta`/`PATCH /api/streams`) pointing at a compatible JSON,
and the same guide lights up. Leave them unset for the placeholder.

**Guide over P2P (optional):** the standalone EPG service can publish the same
schedules into a replicated guide drive, and apps then fetch the guide
peer-to-peer FIRST and use the https path as the fallback. The `epgId` field
above is also what maps a provider channel to its stream there — which is why a
playlist source with `epg: true` gets a real guide from its `tvg-id`s alone, with
no `epgUrl` on the channels at all. Register the guide document the playlist
declares (the sync report shows the address) as a provider in the service. See
[epg-service.md](epg-service.md).

## Channel ingest & transcode

How a channel's media gets IN (test / file / pull URL / RTMP / SRT / UDP-TS push)
and how it's encoded (copy passthrough, x264, GPU) is **broadcaster**
configuration. Manage it in the broadcaster control dashboard (kind and transcode
under Edit, push URL on the card, ffmpeg logs behind the Logs button). See the
[operator guide](operator-guide.md#e-broadcaster-input) and
[reference](reference.md#broadcaster-control-api-ui-control_enabled1). The panel
only learns the resulting feed identity through the register RPC.

## Live vs VOD

Two record classes share the catalog, the grant machinery, and the P2P transport:

- **Live** (`type:'live'`, the default): a rolling HLS window in a Hyperdrive, fed
  by the **broadcaster**. It carries `isLive`, and segments rotate out and are
  reclaimed.
- **VOD** (`type:'vod'`): an on-demand **title** served by the standalone
  **[library](vod-library.md) service** — a finished HLS VOD rendition
  (`#EXT-X-PLAYLIST-TYPE:VOD`, with **all** segments kept) in its own encrypted
  Hyperdrive. The record carries `durationSec` and **no `isLive` at all** —
  liveness is not a property a title has. `status` is `'available'` while the
  library seeds it, and `'unavailable'` after the library deletes it. Seek works
  via HTTP Range — any peer serves any range. Viewers need nothing new: a
  granted title unseals exactly like a channel.

The split is deliberate: ingest for VOD is a one-shot transcode burst and then a
static seed, so it runs in a separate service on whatever box has the disk and
CPU — never inside the live pipeline. Registering a title happens in the
**library control UI/API** (id, input file/URL, seed metadata). After creation,
the descriptive metadata (title/description/category/art) is
**panel-authoritative**, same as channels — edit it in the panel dashboard. Grant
and revoke, categories and rails, curation, and art all work identically for both
classes. To retire a title: delete it in the library (this stops seeding and
purges its data), then remove the catalog record and grants in the panel.

*Not built yet (v1 candidates): auto-record live → VOD catch-up, series/episode
metadata, repeater mirroring of titles, multipart upload through the control API
(v1 ingests a path/URL the library box can reach).*

## Content protection

There is no DRM and no geo-restriction — deliberately. Access control comes from
encrypted feeds, per-user sealed keys, and stream-key rotation. The
[security model](security-model.md#no-drm-no-geo-locking-deliberately) states
exactly what that defends against and what it doesn't.
