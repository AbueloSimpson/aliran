# Recovery walkthroughs

This page holds the step-by-step procedures. The
[backup, restore & key rotation runbook](backup-and-rotation.md) explains the
rules behind each step — read it once before you need this page. Do the
[quarterly drill](backup-and-rotation.md#drill-it) so the first walkthrough you
run is not the one that matters.

Four procedures:

1. [Undo a bad change with a config snapshot](#1-undo-a-bad-change-with-a-config-snapshot)
2. [The panel box is lost — rebuild on a new box](#2-the-panel-box-is-lost-rebuild-on-a-new-box)
3. [Roll a service back to a recovery archive](#3-roll-a-service-back-to-a-recovery-archive)
4. [Seed a second site from a config template](#4-seed-a-second-site-from-a-config-template)

## 1. Undo a bad change with a config snapshot

Use this when you deleted a channel by mistake, broke the lineup, or want a
config change gone. It is a dashboard operation. The example is the panel; the
broadcaster and library pages work the same way.

1. Open the dashboard and go to **Backup**.
2. Find your rollback point in **Config snapshots**. The service takes one by
   itself before each channel delete and before every restore or import — the
   note column tells you why each snapshot exists.
3. Click **Restore…** on that row.
4. Read the plan. It lists what a restore adds, changes, removes, leaves alone
   and skips. Nothing has changed yet.
5. Read the warnings. Two matter often: a channel owned by a remote source is
   skipped (run that source's sync instead), and a per-stream key is put back
   only where none exists now.
6. Click **Restore**.
7. Read the result. "No change" means the config already matches the snapshot.
8. Verify the lineup on the Streams (or Channels) page.

Good to know:

- The restore is **additive**. Entries the snapshot does not name are left
  alone, so it never removes channels you added after the snapshot. Removal is
  a separate checkbox on the confirmation.
- A restored channel comes back **with its original key**, so existing grants
  and encoders keep working.
- The service snapshots the current config first, so you can undo the restore
  itself the same way.
- On the broadcaster, an input change to a running channel applies at that
  channel's next restart. The plan says so per channel.

## 2. The panel box is lost — rebuild on a new box

You need, in order of preference:

- your newest **off-box recovery archive** (it holds the keys, the accounts and
  the catalog), or
- your **escrow file** and its passphrase (identity only — accounts are gone
  without an archive), and
- your saved `.env` files, if you kept copies. No archive contains them.

**Step 0 — the rule that outranks every step below.** Confirm the old box is
dead. If it can come back, wipe its panel data or disable the service before
you start here. Two panels with one identity fork the store permanently — see
[never-two-writers](backup-and-rotation.md#warm-standby-failover).

### 2a. With a recovery archive (the better case)

1. On the new box: install Docker and Compose, then clone the repo.
2. Restore your saved `.env` files, or copy the examples and fill them in.
3. Build the images:

   ```sh
   docker compose build
   ```

4. Create the containers and volumes without starting anything:

   ```sh
   docker compose create
   ```

5. Copy the archive onto the box, into `./backups/`.
6. Restore it. The volume is empty, so no `--force` is needed:

   ```sh
   ./deploy/restore.sh panel backups/panel-<newest-stamp>.tar.gz
   ```

7. Start everything:

   ```sh
   docker compose up -d
   ```

8. Check `curl 127.0.0.1:3210/healthz`, sign in to the dashboard, and confirm
   **Overview** shows your known pairing code. That code is derived from the
   signing key — if it matches, the identity is back.
9. Restart every broadcaster site (`docker compose restart broadcaster`) so all
   channels register again.
10. Apps that replicated past the archive's moment can refuse the rewound
    history. Those viewers clear the app storage once — see
    [restore freshness](backup-and-rotation.md#restore).

A broadcaster on the same box needs only its `.env` and `channels.json` back
(from your copies, or from a broadcaster config snapshot inside a
broadcaster archive). Its feed stores are cache and rebuild themselves.

### 2b. With the escrow file only

Everything identity-shaped survives; accounts do not. Broadcasters refill the
catalog with every channel and per-stream key when they re-register. Users,
grants and packages must be created again — a saved
[config template](#4-seed-a-second-site-from-a-config-template) puts back the
packages, categories and sources part.

1. Steps 1–4 from 2a (clone, `.env`, build, create). Two `.env` values come out
   of the escrow file if you lost your copies: `PANEL_PUBKEY` is printed by
   `verify-escrow` without the passphrase, and the shared publisher secret is
   inside the restored `publisher.json`.
2. Put the escrow file on the box (say `/root/`), then restore the keys
   straight into the empty panel volume:

   ```sh
   docker compose run --rm -v /root:/escrow panel node src/admin-cli.js verify-escrow /escrow/<file>.json --restore-to /data/keys
   ```

   It asks for the passphrase, verifies the identity, and writes the key files
   `0600` into a `0700` directory. It refuses a non-empty target.
3. Create a dashboard admin:

   ```sh
   docker compose run --rm panel node src/admin-cli.js add-admin <name>
   ```

4. `docker compose up -d`, then confirm the pairing code on **Overview**
   matches your known code.
5. Restart every broadcaster site. Watch the catalog refill.
6. Recreate users and grants (or import your template first, then grant).
7. Installed apps connect without changes — they find the panel by its key. An
   app that held an old catalog replica can need one app-storage clear.

## 3. Roll a service back to a recovery archive

Use this on a box that is alive but whose data volume is corrupt or must be
rewound. This is the **last resort** for a panel — prefer a
[config snapshot](#1-undo-a-bad-change-with-a-config-snapshot) for config
mistakes, because an archive restore rewinds accounts and sessions too.

1. Open the dashboard **Backup** page and find the archive marked
   **newest — restore this one**. Restore the newest you have, always —
   [staleness strands viewers](backup-and-rotation.md#restore).
2. Copy the restore command from the page and run it on the box.
3. The script refuses a volume that holds data. That refusal is the safety
   design working. Re-run with `--force` only when replacing the live data is
   exactly what you intend — `--force` deletes the volume contents first.
4. After a panel restore: restart every broadcaster site, check
   `curl 127.0.0.1:3210/healthz`, sign in, and spot-check one user and one
   channel.

## 4. Seed a second site from a config template

A template carries structure and no secrets, so a new site starts from your
lineup without your keys.

On the existing site:

1. **Backup → Download the template.** The file is safe to move around — the
   export refuses to serve anything that holds a secret, and the test suite
   proves no secret survives into it.

On the new site:

1. Install per the [operator guide](../operator-guide.md) — init, admins,
   broadcaster enrollment. The new site mints its own identity and keys.
2. Open its dashboard, go to **Backup → Import a template…**, and pick the
   file.
3. Read the plan. Expect these warnings: push channels get **new** stream keys,
   imported channels arrive **stopped**, and source URLs lost their user name,
   password and query parameters.
4. Import.
5. Re-enter the source credentials on the Sources page, then enable each
   source.
6. Give out the new push stream keys to the encoders that feed this site.
7. Grant access — packages or per-user grants. A template carries no
   entitlements, so until you grant, nobody can watch.
8. Start the channels.

The reseller has no import — a principal is a login, and a template holds no
credentials. Rebuild the hierarchy with `reseller-cli`, using the exported
template as the reference for names, roles and parents.
