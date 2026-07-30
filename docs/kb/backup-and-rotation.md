# Backup, restore & key rotation

These are the operational safety runbooks: what to back up (and what not to
bother with), how to restore it, how to keep a warm standby, and how to
rotate every credential in the system — including the honest list of what
*cannot* be rotated.

One mental model up front. Every byte an Aliran deployment holds is one of
three things:

- **Identity** — the panel's signing keypair and OPRF key
  (`DATA_DIR/keys/`). Losing them ends the deployment, because every client
  pins the public key. Leaking them re-enables offline password
  brute-force. They cannot be rotated in place.
- **Data** — things with real replacement cost: the panel's account/catalog
  store, the reseller's credit ledger, the library's ingested titles, admin
  credential files.
- **Cache** — things that rebuild themselves: broadcaster feed stores (a
  lost feed re-mints and viewers follow via the catalog), the repeater's
  entire store, client-side replicas. These are never worth backing up.

## What to back up

| Service | Back up | Why / notes |
|---|---|---|
| **Panel** | The whole `DATA_DIR` (volume `panel-data`) | `keys/` (signing, OPRF, shared publisher — the crown jewels), `secrets/admins.json`, the signed account/catalog corestore, assets drive, sources/publishers registries. Small (MBs–tens of MBs) — back it up often |
| **Panel identity** | `keys/` **alone**, encrypted, stored somewhere else | A separate one-time job — see *Get the identity off the box* below. The archive above holds these keys too, but it sits on the box you are insuring against |
| **Reseller** | The whole `DATA_DIR` (volume `reseller-data`) | Business records: `ledger/ledger.jsonl` (append-only credit ledger), principals, managed-account map |
| **Library** | The whole `DATA_DIR` (volume `library-data`) | The ingested VOD titles ARE the served artifact (re-ingest needs the original files); plus `secrets/admins.json` |
| **Broadcaster** | Only `.env` + `DATA_DIR/channels.json` | The channel registry + config are seconds to restore; the feed stores are **cache** — a restored broadcaster with empty stores re-mints feeds and every viewer follows via the catalog (cost: one cold DHT topic per channel, like any rotation) |
| **Repeater** | Nothing | The store is a disposable ciphertext cache by design |
| **All** | The `.env` files (and any branding/theme files they reference) | They live in the repo checkout on the host, *outside* the volumes — a volume backup does not include them |

## Get the identity off the box (key escrow)

Do this once, before you do anything else here.

`deploy/backup.sh` puts `keys/` into an archive. That archive stays on the box
you are insuring against. So a box that burns takes the archive with it. Key
escrow is the supported way to move the identity somewhere else.

**Why the identity is a separate job.** Everything else in a deployment
survives a total loss. Broadcasters repopulate channels and per-stream secrets
when they re-register. Users, grants and packages come back from a panel
archive. The keys do not come back from anything, because every installed app
pins the panel public key and the pairing code comes from that same key. Lose
them and you cannot recover the service under its own identity at all.

An escrow file holds `DATA_DIR/keys/` and nothing else. It is not a panel
backup. Take both.

### Export

Two routes produce the same file. Use the one that fits your access.

**From the box** (always available — it needs shell access, so it gives an
attacker nothing new):

```sh
docker compose exec panel node src/admin-cli.js export-escrow
```

**From the dashboard** (Overview → Key escrow). This route is **off** until you
set `ESCROW_EXPORT=1` in `panel/.env`. Read *The trade you are making* below
before you turn it on.

Both routes ask for a passphrase of 16 characters or more. Five or six random
words beat one clever word. The passphrase is the only protection on the file.
The panel does not store it. Nobody can open the file without it, and that
includes you.

The panel encrypts the file **before** it writes it or answers with it:
Argon2id derives the file key from your passphrase, and XChaCha20-Poly1305
seals the key material. No key material crosses the network in the clear, even
behind TLS or an SSH tunnel. The panel then decrypts its own output and checks
it, so a file that cannot be opened never reaches you.

Now move the file off the box. A copy that stays there protects you from
nothing. Put the passphrase somewhere else again — a file and its passphrase in
one place is one theft, not two.

### Identify a file years later

The file starts with a **cleartext fingerprint**. You read it with a text
editor and no passphrase:

```json
"fingerprint": {
  "panelPublicKey": "a3f1…",
  "pairingCode": "VNEY-GN8R-3S9W",
  "serviceName": "Example TV",
  "files": [{ "name": "oprf.key", "bytes": 64 }, …]
}
```

Nothing in that block is secret. The panel public key and the pairing code go
to every viewer already. The block is there so you can tell which deployment a
file belongs to, and which of several files is the current one.

The fingerprint is also the seal's *additional data*. If somebody edits the
recorded public key, the file stops decrypting. Nobody can re-label one
deployment's file as another's.

The dashboard shows the same two values on **Overview → Service identity**.
Write them down and keep them off the box. They are public, and a record of
them is itself recovery information.

### Verify the copy

An escrow copy nobody has tested is not a backup. Verify the copy where it
lives, not the original on the box:

```sh
node panel/src/admin-cli.js verify-escrow aliran-escrow-VNEY-GN8R-3S9W-20260729-1412.json
```

The command prints the fingerprint, asks for the passphrase, and then checks
that the sealed keys are well-formed and are the identity the header names: the
signing keypair signs and verifies, the OPRF key is 32 bytes, and the pairing
code re-derives from the sealed key. It exits non-zero if any check fails.

This command needs no panel, no `DATA_DIR`, and no swarm. Run it on a laptop.
That is deliberate: a verify that started a panel could become a **second
writer** for one identity, which the rule below makes strictly worse than
downtime.

Verify each copy when you make it. Verify again at each quarterly drill.

### Recover from a copy

You need the keys as files again:

```sh
node panel/src/admin-cli.js verify-escrow <file> --restore-to ./recovered-keys
```

The command refuses a directory that is not empty. It writes the key files with
mode `0600`.

**Stop there and confirm one thing: the old panel is down and cannot restart.**
Only then move the files into that deployment's `DATA_DIR/keys/`. Two panels
that share an identity both sign appends under it, and that fork is permanent.
See *Warm standby & failover* below.

### The trade you are making

`ESCROW_EXPORT=1` lowers the bar for stealing the identity. Today it is "shell
access on the box". With the dashboard route on it becomes "an admin session
plus that admin's password". That is a real change, so the panel answers it
with four barriers:

| Barrier | What it does |
|---|---|
| The flag | The route does not exist while `ESCROW_EXPORT` is off. It answers 404, like any unknown path |
| Re-authentication | The caller re-types their own password. A stolen dashboard token is not sufficient |
| Rate limit | 3 attempts per hour per admin. A real operator does this about once |
| Activity ring | Every attempt lands in **Overview → Recent activity** as a red `security` event. Refusals too — a blocked attempt matters more than a successful one |

The CLI route stays available whether the flag is on or off. So you can leave
the flag off and lose nothing except dashboard convenience.

There is no MCP tool for this, on purpose. MCP results travel into an
assistant's transcript, and the passphrase would travel as a tool parameter.

`npm run test:escrow` proves the mechanics on every CI push: the exported bytes
hold no key material, the fingerprint matches the live panel key, and a wrong
passphrase, a corrupted file and an edited fingerprint are all refused.

### The broadcaster does not need this

A broadcaster holds no identity you cannot replace, so there is no broadcaster
escrow and none is planned:

- Its per-channel `feed.key` files are **cache** (see the table above). A lost
  feed re-mints, and viewers follow it through the catalog.
- Its `PUBLISHER_KEY` lives in `.env`, which the table above already tells you
  to back up. It is also **rotatable**: enroll a new publisher on the panel, put
  the new key in that site's `.env`, restart it, and revoke the old one. Viewers
  see nothing. The rotation matrix below has the steps.

Back up the broadcaster `.env` and `channels.json`. That is the whole job.

## Cold backup (the only safe kind)

Corestores must not be copied while their service is writing — a mid-write
copy can capture a torn tree. Stop, copy, start. The windows are short and
cheap:

- **Panel stopped** = new logins pause. Existing viewers keep playing
  (catalog replicas + P2P serving don't involve the panel), and
  broadcasters keep streaming.
- **Reseller stopped** = the dashboard is briefly down; nothing else
  notices.
- **Library stopped** = VOD titles pause serving for the window.

With the shipped compose file, `deploy/backup.sh` does stop → tar → start
per service and writes timestamped archives:

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
(`0 * * * * cd /opt/aliran && ./deploy/backup.sh -o /srv/backups panel
reseller`). Copy archives **off the box** (scp/rclone/object storage).
**Encrypt them at rest** — a panel backup contains the OPRF key and
signing secret, so treat the archive with the same care as
`DATA_DIR/keys/` itself.

`npm run test:backup` proves mechanically that a cold copy of the panel
`DATA_DIR` is *complete* — a panel reopened from the copy serves the same
catalog, verifies the same admins, and signs with the same identity.

## Restore

`deploy/restore.sh` is the scripted counterpart of `backup.sh` (verify the
archive → stop → **replace** the volume contents → start). It refuses a
non-empty volume or an archive whose name doesn't match the service unless
you pass `--force` — restoring over live data is deliberately the loud
path:

```sh
./deploy/restore.sh panel backups/panel-<stamp>.tar.gz            # empty volume
./deploy/restore.sh --force panel backups/panel-<stamp>.tar.gz    # replace live data
```

(The [MCP server](../mcp.md) wraps the same script as `server_restore`,
with `server_list_backups` to find the archive.) By hand it is:

```sh
docker compose stop panel
docker run --rm -v aliran_panel-data:/data alpine sh -c 'rm -rf /data/* /data/..?* /data/.[!.]*'
docker run --rm -v aliran_panel-data:/data -v "$PWD/backups":/backup alpine \
  tar xzf /backup/panel-<stamp>.tar.gz -C /data
docker compose start panel
curl -s 127.0.0.1:3210/healthz     # up + swarm connections climbing
```

Then log in to the dashboard and spot-check a user and a stream.

**The sharp edge — restore freshness.** The panel's store is an
*append-only, signed* log. Restoring a snapshot rewinds it. Everything the
panel writes after the restore re-uses sequence numbers that newer
replicas may have already seen with different content. A client that
replicated past your snapshot point refuses the forked history, and its
catalog stops updating until its local app storage is cleared (desktop:
delete the store dir; Android: clear app data — login state is re-derived,
nothing of value lives on the client). Broadcasters re-register on their
next start, which re-fills catalog records that post-date the snapshot.
So:

- **Restore the newest backup you have**, always — freshness directly
  limits how many clients can be stranded. Hourly backups make this a
  non-event.
- Treat restore as the *last* resort; the standby flow below avoids most
  restores entirely.
- After any restore, restart the broadcasters (`docker compose restart
  broadcaster` per site) so every channel re-registers.

## Warm standby & failover

You can get availability without any protocol machinery: keep a second box
that always holds the latest cold snapshot (rsync the backup archives, or
the untarred `DATA_DIR`), with the repo cloned and `.env` in place.

**The one hard rule: never run two panels with the same keys at the same
time.** Both would sign appends independently under one identity — a
permanent fork, strictly worse than downtime. The failover discipline is
therefore:

1. Confirm the primary is actually dead (or stop it yourself:
   `docker compose stop panel` — a reachable primary must be stopped
   first).
2. Start the panel on the standby from the latest snapshot.
3. Done. There is no DNS, no IP, no load balancer: clients and
   broadcasters find the panel by its public key on the DHT, wherever it
   announces from. The restore-freshness caveat above applies identically
   — your recovery point is the last snapshot sync.
4. When the old primary box comes back, **wipe its panel data before it
   ever starts** (or keep the service disabled) — it must not announce
   with stale state.

The broadcaster needs no failover choreography: run it wherever, restore
`channels.json` + `.env`, start, and it re-registers everything it
carries.

## Rotation matrix

This shows what rotates, how, and what it costs. Everything here is
wire-compatible — no player or SDK updates are ever involved.

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
| **Panel signing key + OPRF key** | **Not rotatable.** They *are* the deployment's identity: every shipped config pins the public key, and OPRF evaluations feed every stored verifier | Compromise = migration: init a fresh panel, re-create accounts (users re-enroll — verifiers can't be transformed), repoint broadcasters/resellers, ship the new key to clients (Connect screen / new config). This is why `keys/` is 0600, why backups must be encrypted, and why the box running the panel should be the most locked-down thing you operate. **Loss** is the other half of the same coin, and it is the one you can prepare for — see *Get the identity off the box* |

## Drill it

A backup you have never restored is a hope, not a plan.

- `npm run test:backup` runs the automated completeness drill on every CI
  push. `npm run test:escrow` does the same for key escrow.
- Quarterly, verify your escrow copy where it is stored:
  `node panel/src/admin-cli.js verify-escrow <file>`. It takes seconds, it needs
  no panel, and it is the only way to learn that you still have the passphrase.
- Quarterly, do the real thing: restore the latest panel archive onto a
  scratch box (or the standby) and log in to the dashboard. **Point the
  drill panel at a black-hole bootstrap** (`BOOTSTRAP=127.0.0.1:9` in its
  `.env`) so it never announces on the public DHT next to the live one —
  the never-two-writers rule applies to drills too. Total cost is about
  five minutes — the first time you discover a broken backup should not be
  during an outage.
