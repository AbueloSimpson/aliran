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
admin-cli upload-art news poster ./poster.jpg      # into the assets Hyperdrive
```

## Assets (posters/backdrops/logos)

Stored in a **panel-seeded assets Hyperdrive**, replicated by clients and served from
the app's localhost server (`/assets/<hash>`). Content-addressed → automatic cache-bust.

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
