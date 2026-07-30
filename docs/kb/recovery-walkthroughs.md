# Backup & recovery walkthroughs

This page holds the numbered procedures. The
[backup, restore & key rotation runbook](backup-and-rotation.md) explains the
rules behind each step. Read the runbook once before you need this page.

Backups first, recovery after:

1. [Make the escrow file — once](#1-make-the-escrow-file-once)
2. [Set up recovery archives — once, then automatic](#2-set-up-recovery-archives-once-then-automatic)
3. [Use config snapshots and the template](#3-use-config-snapshots-and-the-template)
4. [Undo a bad change with a config snapshot](#4-undo-a-bad-change-with-a-config-snapshot)
5. [The panel box is lost — rebuild on a new box](#5-the-panel-box-is-lost-rebuild-on-a-new-box)
6. [Roll a service back to a recovery archive](#6-roll-a-service-back-to-a-recovery-archive)
7. [Seed a second site from a config template](#7-seed-a-second-site-from-a-config-template)

Practice procedures 4–6 in the
[quarterly drill](backup-and-rotation.md#drill-it). An incident is the wrong
time to run a procedure for the first time.

## 1. Make the escrow file — once

The escrow file holds the panel identity, encrypted. With it, you can rebuild
the service after a total loss, and no client needs a change. Do this once,
after install. Details:
[key escrow](backup-and-rotation.md#get-the-identity-off-the-box-key-escrow).

1. Connect to the box over SSH.
2. Export the keys into one sealed file:

   ```sh
   cd /opt/aliran
   docker compose exec panel node src/admin-cli.js export-escrow --out /data/escrow-out.json
   ```

3. Type a passphrase two times. Use five or six random words. The passphrase
   is the only protection on the file. The minimum is 16 characters.
4. Read the output. Each check must show `✓`. The pairing code in the output
   must match your known code.
5. Move the file out of the container, then remove the original:

   ```sh
   docker compose cp panel:/data/escrow-out.json /root/aliran-escrow.json
   docker compose exec panel rm /data/escrow-out.json
   ```

6. Copy the file off the box, for example with `scp`, to your own computer.
7. Prove the copy at its destination:

   ```sh
   node panel/src/admin-cli.js verify-escrow aliran-escrow.json
   ```

8. Put the passphrase in your password manager. Do not store it next to the
   file.
9. Store the file in two places away from the box. The file is ciphertext, so
   a cloud drive and a USB stick are both acceptable.
10. Run `verify-escrow` on a stored copy every quarter. The check takes
    seconds. It is the only way to learn that the copy and the passphrase
    still work.

## 2. Set up recovery archives — once, then automatic

A recovery archive is a cold copy of a service's data volume. It holds the
accounts, the catalog and the keys. Make one every hour, and keep copies away
from the box.

1. On the box, add one line to `crontab -e`:

   ```sh
   0 * * * * cd /opt/aliran && ./deploy/backup.sh panel
   ```

   Add the other services you run to the same line, for example
   `./deploy/backup.sh panel reseller`. The broadcaster does not need an
   archive — back up its `.env` and `channels.json` instead.
2. Copy the archives off the box on a schedule. For example, pull them from a
   second machine each night:

   ```sh
   scp <your-box>:/opt/aliran/backups/panel-*.tar.gz ./aliran-backups/
   ```

   `rclone` to object storage also works.
3. Protect the copies. A panel archive holds the panel keys. Encrypt the
   destination, or restrict who can read it.
4. Save a copy of every `.env` file each time you change one. No archive
   holds them.
5. Open the dashboard **Backup** page once a month. The newest archive must
   show **fresh**. A **stale** newest archive means the cron job stopped.

## 3. Use config snapshots and the template

A config snapshot is this service's exact config, secrets included. It stays
on the box. A config template is the same structure with every secret removed.
You can download it. The
[runbook](backup-and-rotation.md#four-files-four-jobs) compares all four
artifact types.

1. The service takes a snapshot by itself before each channel delete, and
   before every restore or import. You do not have to do anything for these.
2. Before a large lineup edit, take one by hand: open **Backup**, click
   **Take a snapshot now**, and write a short note. The note tells you later
   why the snapshot exists.
3. The service keeps the newest 20 snapshots
   ([`CONFIG_SNAPSHOT_KEEP`](../configuration.md)). It removes the oldest
   ones.
4. To keep a record of your lineup, click **Download the template**. The file
   holds no secrets. Store it with your notes, or compare two of them to see
   what changed.

## 4. Undo a bad change with a config snapshot

Use this walkthrough after a mistake: a deleted channel, a broken lineup, or a
config change you must remove. It is a dashboard operation. The example is the
panel. The broadcaster and library pages work the same way.

1. Open the dashboard and go to **Backup**.
2. Find your rollback point in **Config snapshots**. The note column tells
   you why each snapshot exists.
3. Click **Restore…** on that row.
4. Read the plan. It lists what a restore adds, changes, removes, leaves
   alone and skips. Nothing has changed yet.
5. Read the warnings. Two are frequent. The restore skips a channel that a
   remote source owns — run that source's sync instead. The restore installs
   a per-stream key only where no key exists now.
6. Click **Restore**.
7. Read the result. "No change" means the config already matches the
   snapshot.
8. Verify the lineup on the Streams page (Channels page on the broadcaster).

Notes:

- The restore is additive. It does not touch entries the snapshot does not
  name. It reports them instead. Removal is a separate choice on the
  confirmation.
- A restored channel returns with its original key. Existing grants and
  encoders keep working.
- The service snapshots the current config first. You can undo the restore
  itself the same way.
- On the broadcaster, an input change to a running channel applies at that
  channel's next restart. The plan says so for each channel.

## 5. The panel box is lost — rebuild on a new box

You need:

- your newest off-box recovery archive — it holds the keys, the accounts and
  the catalog; or
- your escrow file and its passphrase — identity only; and
- your saved `.env` files, if you kept copies.

**Step 0 — do this first.** Confirm the old box is dead. If it can return,
wipe its panel data or disable its panel service now. Two panels with one
identity fork the store permanently. See
[never-two-writers](backup-and-rotation.md#warm-standby-failover).

### 5a. With a recovery archive — the better case

1. On the new box: install Docker and Compose, then clone the repo.
2. Restore your saved `.env` files, or copy the examples and fill them in.
3. Build the images:

   ```sh
   docker compose build
   ```

4. Create the containers and volumes. Start nothing:

   ```sh
   docker compose create
   ```

5. Copy the archive onto the box, into `./backups/`.
6. Restore it. The volume is empty, so `--force` is not needed:

   ```sh
   ./deploy/restore.sh panel backups/panel-<newest-stamp>.tar.gz
   ```

7. Start the services:

   ```sh
   docker compose up -d
   ```

8. Check `curl 127.0.0.1:3210/healthz`, then sign in to the dashboard. Open
   **Overview** and compare the pairing code with your known code. The panel
   derives the code from the signing key. A match proves the identity is
   back.
9. Restart every broadcaster site with `docker compose restart broadcaster`.
   Each channel registers again.
10. An app that replicated past the archive's moment can refuse the rewound
    history. That viewer clears the app storage one time. See
    [restore freshness](backup-and-rotation.md#restore).

A broadcaster on the same box needs only its `.env` and `channels.json`.
Restore them from your copies. Its feed stores are cache and rebuild
themselves.

### 5b. With the escrow file only

The identity survives. The accounts do not. Broadcasters fill the catalog
again with every channel and per-stream key when they register. You create
users, grants and packages again. A saved
[config template](#7-seed-a-second-site-from-a-config-template) puts back the
packages, categories and sources.

1. Do steps 1–4 from 5a: clone, `.env` files, build, create. If you lost the
   `.env` copies, the escrow supplies two values. `verify-escrow` prints
   `PANEL_PUBKEY` without the passphrase. The restored `publisher.json` holds
   the shared publisher secret.
2. Put the escrow file on the box, for example in `/root/`. Restore the keys
   into the empty panel volume:

   ```sh
   docker compose run --rm -v /root:/escrow panel node src/admin-cli.js verify-escrow /escrow/aliran-escrow.json --restore-to /data/keys
   ```

   The command asks for the passphrase and verifies the identity. It writes
   the key files with mode `0600` into a `0700` directory. It refuses a
   target directory that is not empty.
3. Create a dashboard admin:

   ```sh
   docker compose run --rm panel node src/admin-cli.js add-admin <name>
   ```

4. Start the services with `docker compose up -d`. Compare the pairing code
   on **Overview** with your known code.
5. Restart every broadcaster site. Watch the catalog fill.
6. Create users and grants again. Import your template first if you have
   one, then grant.
7. Installed apps connect without changes. They find the panel by its key.
   An app that held an old catalog replica may need to clear its app storage
   one time.

## 6. Roll a service back to a recovery archive

Use this on a live box when the data volume is corrupt, or when you must
rewind it. For a panel this is the last resort — prefer a
[config snapshot](#4-undo-a-bad-change-with-a-config-snapshot) for config
mistakes, because an archive restore also rewinds accounts and sessions.

1. Open the dashboard **Backup** page. Find the archive marked
   **newest — restore this one**. Restore the newest archive you have,
   always. An older archive
   [strands more viewers](backup-and-rotation.md#restore).
2. Copy the restore command from the page and run it on the box.
3. The script refuses a volume that holds data. The refusal is correct — it
   protects live data. Run again with `--force` only when you intend to
   replace that data. `--force` deletes the volume contents first.
4. After a panel restore: restart every broadcaster site, check
   `curl 127.0.0.1:3210/healthz`, sign in, and spot-check one user and one
   channel.

## 7. Seed a second site from a config template

A template carries structure and no secrets. A new site starts from your
lineup without your keys.

On the existing site:

1. Open **Backup** and click **Download the template**. The export refuses to
   serve any artifact that holds a secret. The test suite proves that no
   secret survives into a template.

On the new site:

1. Install per the [operator guide](../operator-guide.md): init, admins,
   broadcaster enrollment. The new site mints its own identity and keys.
2. Open its dashboard, go to **Backup**, and click **Import a template…**.
   Pick the file.
3. Read the plan. Expect three warnings: push channels get new stream keys,
   imported channels arrive stopped, and source URLs lost their user name,
   password and query parameters.
4. Click **Import**.
5. Enter the source credentials again on the Sources page. Then enable each
   source.
6. Give the new push stream keys to the encoders that feed this site.
7. Grant access with packages or per-user grants. A template carries no
   entitlements. Until you grant, nobody can watch.
8. Start the channels.

The reseller has no import. A principal is a login, and a template holds no
credentials. Rebuild the hierarchy with `reseller-cli`. Use the exported
template as the reference for names, roles and parents.
