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

**Curation** (`order` 0–9999 or null, `featured` bool) is admin-owned: a broadcaster
re-registering its stream updates title/feedKey/liveness but **never** erases
curation or art. Client UIs sort rails by `order` and prefer `featured` live streams
for the hero slot.

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

## Live vs VOD

- **Live** (default): rolling HLS window in a Hyperdrive.
- **VOD** (optional): store finished media (complete HLS or MP4), `type:'vod'`, with
  duration/series/episode metadata. Seek works via HTTP Range; any peer serves any
  range (great fan-out). Optionally auto-record live → VOD for catch-up.

## DRM (optional)

Package as **CENC/CMAF** using a multi-DRM packager (Nimble Streamer, Unified
Streaming, shaka-packager) with vendor CPIX keys. Set `protection:'drm'` on the stream.
Distribution stays P2P; the license request goes to the vendor with a panel-issued
entitlement JWT. Android target: **DASH+Widevine** (or CMAF HLS+Widevine).

## Geo-locking (optional)

Set `allowedRegions`/`blockedRegions` on a stream. Enforced at entitlement time (panel
GeoIP) and/or by the DRM vendor's license geo policy. IP GeoIP is VPN-defeatable —
document expectations.
