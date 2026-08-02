# EPG service

The EPG service publishes a program guide over P2P. It is a separate
service. It does not run inside the panel.

## What it does

- It reads schedules from one or more sources ("providers").
- It writes one JSON file for each channel and each day into a public
  Hyperdrive.
- It tells the panel the drive key. The panel stores the key in one
  catalog record (`meta/epgKey`).
- Viewer apps read that record. They fetch only the files they show.
  They do not download the full guide.
- Viewers that hold guide files also serve them to other viewers.

Playback does not depend on the guide. If the guide is not available,
the apps fall back to the `epgUrl` https fetch, or they show no guide.

## Why a separate drive

The panel's catalog log grows with every write and is never compacted.
A guide changes every day. That churn must not land in the catalog.
The EPG service rotates its drive on an epoch (default: 30 days). A
rotation costs the panel **one** record. The old drive is kept for a
grace time (default: 48 hours), then deleted.

## Set up

1. Enroll a publisher for the service in the panel. Give it the scope
   `epg`:

   ```bash
   node src/panel-cli.js add-publisher epg1 --scopes epg
   ```

   Keep the secret key. The panel shows it only once.

2. Copy `epg/.env.example` to `epg/.env`. Set `PANEL_PUBKEY`,
   `PUBLISHER_KEY`, and `PUBLISHER_NAME`.

3. Copy `epg/providers.example.json` to `epg/providers.json`. Add your
   sources. Two types are available:
   - `provider-json`: an https URL with the provider feed shape
     (`{channels:[{id, epg:[{title,start,stop}]}]}`).
   - `manual`: a local JSON file in the same shape.

4. Start the service:

   ```bash
   docker compose --profile epg up -d epg
   ```

## How channels are matched

The service reads the panel catalog. A catalog record's `epgId` field
names that channel's id in the provider feed. Set `epgId` on a stream in
the panel to attach a guide to it. Provider channels with no match are
listed in the service status. You can also map them in
`providers.json` with `overrides`.

## Serve the guide when the panel is down

A repeater can mirror and announce the guide and the catalog. Set these
values in the repeater's `.env`:

```
EPG=1
ANNOUNCE=1
```

With `ANNOUNCE=1`, a new viewer can load the channel list and the guide
from the repeater while the panel is offline. The data is signed by the
panel key, so the repeater cannot change it.

## Status

Set `STATUS_ENABLED=1` to serve `GET /healthz` and `GET /status` on
`127.0.0.1:3340`. The status shows the epoch, the mapped channel count,
the unmatched provider ids, and the panel pointer state.
