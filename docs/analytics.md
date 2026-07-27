# Privacy-preserving analytics

Aliran ships analytics that are **aggregate-only, server-side only**. There is no
per-user tracking. This is not a policy you have to trust — it is an
architectural fact you can verify in the code and on the wire.

## Why the operator cannot see who watches what

In a conventional OTT stack, the CDN logs every request. "Who watched what, when,
from where" exists by default, so privacy becomes a promise about what the
operator does with those logs. Aliran's data path makes that record impossible to
produce:

- **Viewers replicate peer-to-peer.** A client fetches stream blocks from
  whichever peers hold them — other viewers, a [repeater](repeater.md), or the
  origin — and never tells the panel what it is watching. There is no playback
  request to log, because there is no media server to request from.
- **The panel sees logins, not viewing.** It serves the OPRF login and session
  RPC, and replicates the (public) catalog. It learns *that* an account signed
  in — never what that account plays.
- **The broadcaster sees anonymous swarm links.** A connection is an ephemeral
  Noise keypair, not an account. The broadcaster cannot map a peer to a user: the
  panel knows accounts but not peers, the broadcaster knows peers but not
  accounts, and nothing joins the two.

Analytics is therefore defined as: **aggregate what the operator's own nodes
already observe as a side effect of serving.** Nothing new is collected from
clients, no wire message was added, and the client privacy story is unchanged.

## The invariant

> Identity-carrying inputs (usernames, hex keys, IPs, device ids) may exist only
> in ephemeral in-memory structures inside the current hour or day. They are
> reduced to **counts** at rollup, and the raw value is never written to any
> analytics file, `/api/analytics` response, or `/metrics` line.

This is not just a design note. `npm run test:analytics` (in the required CI
lane) drives distinctive needle usernames, keys, device ids, and IPs through
every path, then scans every rollup file, API response, and metrics body for
them, asserting **zero hits**. The one place an identity is touched at all is the
panel's unique-viewers count: usernames of *verified* sessions go into an
in-memory `Set`, and its `.size` becomes the day's `uniqueViewers` count. The set
dies at day rollover (or process exit) and is never serialized. Failed login
attempts are counted with **no argument at all** — an attacker-controlled
username from a failed attempt never enters any structure.

## What is collected

All series are UTC hour buckets, rolled into per-day JSON files under each
service's `DATA_DIR/analytics/` (atomic tmp+rename writes; nothing goes in the
replicated catalog, which is public and append-only).

**Panel** (`panel/src/analytics.js`):

| Series | Source | Notes |
|--------|--------|-------|
| Logins ok / failed per hour | The session RPC — the panel's only honest ok/failed signal (the OPRF stage is oblivious: a wrong password fails on the *client*) | Counts only |
| Sessions issued per hour | Same site as the ok count | |
| Unique viewers per day | In-memory day-scoped `Set` → count | Verified sessions only; undercounts across a restart (by design — better than persisting names) |
| Apps online (min/mean/max per hour) | Panel swarm connection count, sampled every 5 min | Every open app holds the catalog connection. **Approximate**: also counts non-viewer peers (repeaters, broadcaster links) |
| Catalog composition (live/redirect/vod) | A slow (30 min) catalog scan | A snapshot, not an event count |

**Broadcaster** (`broadcaster/src/analytics.js`):

| Series | Source | Notes |
|--------|--------|-------|
| Peer links per channel (min/mean/max per hour) | Each channel's swarm connection count, sampled every 5 min | A **lower bound (≥)** on audience — see below |
| Egress bytes per channel per hour | UDX per-connection byte counters: closed connections accumulate on `close`, live ones are added at sample time (so closed connections' bytes don't vanish) | Bytes, not who received them |
| Respawns per channel per hour | The existing watchdog restart counter (delta per tick, reset-aware) | |
| Incidents per hour | The existing correlated incident ring | Count of ring events |

**Repeater**: `/metrics` only — `aliran_repeater_served_bytes_total{stream_id,core}`
beside the existing `held_blocks`/`core_peers`. **No rollup files**: the repeater
stays a zero-state keyless cache, and its opt-in `STATUS_PORT`
(default off, zero listening sockets) is unchanged.

**Reseller**: out of scope — its credit ledger already is the business analytics.

## What is NOT collected

- No per-user watch history — impossible, see above.
- No IP addresses, no geolocation, no device fingerprints.
- No client-side beacon, telemetry, or SDK calls of any kind — zero client/SDK
  changes, zero new wire messages.
- No per-peer records: peer keys are never stored, and byte counts are summed
  before anything touches disk.
- Nothing in the replicated Hyperbee (it is public and append-only — an
  analytics write there would be broadcast to every client, forever).

## The honesty rule: peer counts are a lower bound

Origin-side peer counts **understate** the audience, because viewers serve each
other: a channel with 40 origin connections may have hundreds of watchers
downstream of those peers (a repeater measurably absorbs about half of origin
egress). Every Aliran surface therefore labels peer-derived figures as
**"≥ N"** and never presents them as a viewer count. Read these numbers the same
way. (Related: the broadcaster's "peer links" tile also counts a single browsing
viewer several times while zap-prefetch holds neighbouring channels — links, not
people, in both directions.)

## Surfaces

| Surface | Where |
|---------|-------|
| Panel **Analytics tab** | Admin dashboard — today's counts, 48 h login/apps-online charts (inline SVG, no dependencies), daily totals table |
| `GET /api/analytics?days=N` (panel) | Admin Bearer — day rollups + the in-progress hour ([reference](reference.md#admin-http-api-dashboard-admin_enabled1)) |
| `GET /api/analytics?days=N` (broadcaster) | Control Bearer — per-channel day rollups ([reference](reference.md#broadcaster-control-api-ui-control_enabled1)) |
| Broadcaster dashboard **24 h column** | Peak peers (≥) + egress per channel on the channels table |
| `/metrics` (panel) | `aliran_panel_logins_{ok,failed}_total`, `aliran_panel_sessions_issued_total`, `aliran_panel_catalog_channels{class}` |
| `/metrics` (broadcaster) | `aliran_broadcaster_channel_peers{stream_id}`, `aliran_broadcaster_channel_egress_bytes_total{stream_id}` |
| `/metrics` (repeater, opt-in) | `aliran_repeater_served_bytes_total{stream_id,core}` |

## Retention, durability, and the off switch

- **One knob**: `ANALYTICS_RETENTION_DAYS` (panel and broadcaster; default `90`).
  Rollup files older than this are pruned at boot and at every day rollover.
- **`ANALYTICS_RETENTION_DAYS=0` disables collection entirely** — no counters,
  no timers, and no files or directories are ever created. `/api/analytics`
  answers `{enabled:false}`, and the per-channel metrics extension disappears.
  The pre-existing health gauges stay.
- **Crash semantics**: the in-progress hour lives only in memory and is lost on
  any exit (crash *or* clean shutdown). Completed hours are on disk. This is a
  deliberate trade — no partial-hour merge logic, at the cost of at most one
  hour of counts.
- Rollup files are plain JSON (`DATA_DIR/analytics/YYYY-MM-DD.json`, UTC days).
  Inspect them yourself — that inspection is the point.

## What about real audience measurement?

An accurate concurrent-viewer count would require clients to announce
themselves (a presence beacon). That would change the client privacy story, so
it is **deliberately not part of this feature** — it is parked as a separate,
explicit decision an operator community can make with its eyes open. Until
then: honest lower bounds, clearly labeled.
