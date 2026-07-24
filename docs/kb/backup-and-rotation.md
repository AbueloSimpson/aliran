# Backup, restore & key rotation

The operational safety runbooks: what to back up (and what not to bother with),
how to restore it, how to keep a warm standby, and how to rotate every credential
in the system — including the honest list of what *cannot* be rotated.

One mental model up front. Every byte an Aliran deployment holds is one of three
things:

- **Identity** — the panel's signing keypair and OPRF key (`DATA_DIR/keys/`).
  Losing them ends the deployment (every client pins the public key); leaking
  them re-enables offline password brute-force. They cannot be rotated in place.
- **Data** — things with real replacement cost: the panel's account/catalog
  store, the reseller's credit ledger, the library's ingested titles, admin
  credential files.
- **Cache** — things that rebuild themselves: broadcaster feed stores (a lost
  feed re-mints and viewers follow via the catalog), the repeater's entire store,
  client-side replicas. Never worth backing up.

## What to back up

| Service | Back up | Why / notes |
|---|---|---|
| **Panel** | The whole `DATA_DIR` (volume `panel-data`) | `keys/` (signing, OPRF, shared publisher — the crown jewels), `secrets/admins.json`, the signed account/catalog corestore, assets drive, sources/publishers registries. Small (MBs–tens of MBs) — back it up often |
| **Reseller** | The whole `DATA_DIR` (volume `reseller-data`) | Business records: `ledger/ledger.jsonl` (append-only credit ledger), principals, managed-account map |
| **Library** | The whole `DATA_DIR` (volume `library-data`) | The ingested VOD titles ARE the served artifact (re-ingest needs the original files); plus `secrets/admins.json` |
| **Broadcaster** | Only `.env` + `DATA_DIR/channels.json` | The channel registry + config are seconds to restore; the feed stores are **cache** — a restored broadcaster with empty stores re-mints feeds and every viewer follows via the catalog (cost: one cold DHT topic per channel, like any rotation) |
| **Repeater** | Nothing | The store is a disposable ciphertext cache by design |
| **All** | The `.env` files (and any branding/theme files they reference) | They live in the repo checkout on the host, *outside* the volumes — a volume backup does not include them |

## Cold backup (the only safe kind)

Corestores must not be copied while their service is writing — a mid-write copy
can capture a torn tree. Stop, copy, start. The windows are short and cheap:

- **Panel stopped** = new logins pause. Existing viewers keep playing (catalog
  replicas + P2P serving don't involve the panel), broadcasters keep streaming.
- **Reseller stopped** = the dashboard is briefly down; nothing else notices.
- **Library stopped** = VOD titles pause serving for the window.

With the shipped compose file, `deploy/backup.sh` does stop → tar → start per
service and writes timestamped archives:

```sh
./deploy/backup.sh                       # panel only (the default), to ./backups/
./deploy/backup.sh -o /srv/backups panel reseller library
```

The same by hand (or for bare-metal, where it's just `tar` on `DATA_DIR`):

```sh
docker compose stop panel
docker run --rm -v aliran_panel-data:/data -v "$PWD/backups":/backup alpine \
  tar czf "/backup/panel-$(date +%Y%m%d-%H%M%S).tar.gz" -C /data .
docker compose start panel
```

**Cadence**: the panel store is small — cron it hourly and keep a few days
(`0 * * * * cd /opt/aliran && ./deploy/backup.sh -o /srv/backups panel reseller`).
Copy archives **off the box** (scp/rclone/object storage). **Encrypt them at
rest** — a panel backup contains the OPRF key and signing secret; treat the
archive with the same care as `DATA_DIR/keys/` itself.

`npm run test:backup` proves mechanically that a cold copy of the panel
`DATA_DIR` is *complete* — a panel reopened from the copy serves the same
catalog, verifies the same admins, and signs with the same identity.

## Restore

```sh
docker compose stop panel
docker run --rm -v aliran_panel-data:/data alpine sh -c 'rm -rf /data/* /data/..?* /data/.[!.]*'
docker run --rm -v aliran_panel-data:/data -v "$PWD/backups":/backup alpine \
  tar xzf /backup/panel-<stamp>.tar.gz -C /data
docker compose start panel
curl -s 127.0.0.1:3210/healthz     # up + swarm connections climbing
```

Then log in to the dashboard and spot-check a user and a stream.

**The sharp edge — restore freshness.** The panel's store is an *append-only,
signed* log. Restoring a snapshot rewinds it; everything the panel writes after
the restore re-uses sequence numbers that newer replicas may have already seen
with different content. A client that replicated past your snapshot point will
refuse the forked history and its catalog stops updating until its local app
storage is cleared (desktop: delete the store dir; Android: clear app data —
login state is re-derived, nothing of value lives on the client). Broadcasters
re-register on their next start, which re-fills catalog records that post-date
the snapshot. So:

- **Restore the newest backup you have**, always — freshness directly limits how
  many clients can be stranded. Hourly backups make this a non-event.
- Treat restore as the *last* resort; the standby flow below avoids most
  restores entirely.
- After any restore, restart the broadcasters (`docker compose restart
  broadcaster` per site) so every channel re-registers.

## Warm standby & failover

Availability without any protocol machinery: keep a second box that always holds
the latest cold snapshot (rsync the backup archives, or the untarred `DATA_DIR`),
with the repo cloned and `.env` in place.

**The one hard rule: never run two panels with the same keys at the same
time.** Both would sign appends independently under one identity — a permanent
fork, strictly worse than downtime. The failover discipline is therefore:

1. Confirm the primary is actually dead (or stop it yourself:
   `docker compose stop panel` — a reachable primary must be stopped first).
2. Start the panel on the standby from the latest snapshot.
3. Done. There is no DNS, no IP, no load balancer: clients and broadcasters find
   the panel by its public key on the DHT, wherever it announces from. The
   restore-freshness caveat above applies identically — your recovery point is
   the last snapshot sync.
4. When the old primary box comes back, **wipe its panel data before it ever
   starts** (or keep the service disabled) — it must not announce with stale
   state.

The broadcaster needs no failover choreography: run it wherever, restore
`channels.json` + `.env`, start, and it re-registers everything it carries.

## Rotation matrix

What rotates, how, and what it costs. Everything here is wire-compatible — no
player or SDK updates are ever involved.

| Credential | How to rotate | Blast radius |
|---|---|---|
| Panel admin password | `POST /api/admins/:name/password` (dashboard: Admins) — bumps `tokenVersion` | That admin re-logs-in. Instant revocation lever for a leaked admin token |
| Broadcaster / library control admin | Same endpoint on `:3310` / `:3320`; or the CLI (`add-admin` replaces) | That admin re-logs-in |
| Reseller principal password | `POST /api/principals/:name/password` (or `reseller-cli`) | That principal re-logs-in |
| Reseller→panel service account | On the panel: rotate `reseller-svc`'s password; update `PANEL_ADMIN_PASS` in `reseller/.env`; restart the reseller | Reseller API pauses for the restart |
| Publisher key (per broadcaster site) | Panel: `add-publisher <name2> --scopes …` → put the new `PUBLISHER_KEY`/`PUBLISHER_NAME` in that broadcaster's `.env` → restart it → `POST /api/publishers/<old>/status {status:'revoked'}` | Zero viewer impact; the old key stops registering the moment it's revoked. This is the response to a leaked broadcaster box |
| Viewer password | `POST /api/users/:u/password` (dashboard: user page) | That user re-logs-in on their devices |
| Webhook secret (`WEBHOOK_SECRET`) | Set the new value in `reseller/.env` and in the payment sender, restart the reseller | Top-ups fail during the mismatch window — coordinate the two updates |
| SRT passphrase / push-ingest credentials | Edit the channel's input config in the control UI; restart the channel | One channel blips (watchdog-grade) |
| `feedKey` (a channel's swarm identity) | Happens by itself on source change / `FEED_ROTATE_HOURS` / any `ram`-mode restart; force one with a channel restart | None — viewers follow the catalog live |
| Admin/control session tokens | Rotating the owning password bumps `tokenVersion` = logout-all for that principal | That principal |
| **Panel signing key + OPRF key** | **Not rotatable.** They *are* the deployment's identity: every shipped config pins the public key, and OPRF evaluations feed every stored verifier | Compromise = migration: init a fresh panel, re-create accounts (users re-enroll — verifiers can't be transformed), repoint broadcasters/resellers, ship the new key to clients (Connect screen / new config). This is why `keys/` is 0600, why backups must be encrypted, and why the box running the panel should be the most locked-down thing you operate |

## Drill it

A backup you have never restored is a hope, not a plan.

- `npm run test:backup` runs the automated completeness drill on every CI push.
- Quarterly, do the real thing: restore the latest panel archive onto a scratch
  box (or the standby) and log in to the dashboard. **Point the drill panel at a
  black-hole bootstrap** (`BOOTSTRAP=127.0.0.1:9` in its `.env`) so it never
  announces on the public DHT next to the live one — the never-two-writers rule
  applies to drills too. Total cost is about five minutes — the first time you
  discover a broken backup must not be during an outage.
