# App updates over P2P (OTA)

You can send app updates to installed viewer apps. You do not need an
app store or a file server. The panel stores the update files. The apps
find them, download them over P2P, and ask the viewer to install them.
This page tells you how to publish an update, and what the apps do
with it.

## What it does

- The panel keeps the update files in a public Hyperdrive (the
  "updates" drive). The panel catalog holds the drive key in one signed
  record (`meta/updatesKey`).
- You upload an APK to the panel. The panel adds it to a manifest,
  under the app's `applicationId` and `versionCode`.
- Viewer apps read the manifest through the panel record. Each app
  looks only for its own `applicationId`.
- When a newer version is available, the app shows a banner. The
  viewer starts the download. The file comes over P2P.
- The app makes sure the file is correct (sha256) after the download.
  Then Android shows the system install dialog. The install never
  starts without the viewer's confirmation.

The app looks for updates when it starts, and when the viewer returns
to the app. It does this not more than one time each 6 hours. A viewer
can also check immediately: **Settings → Check for updates…**. On a
metered network (for example, mobile data)
the app does not start the download by itself. It tells the viewer and
offers a "Download anyway" button.

Playback does not depend on updates. If the panel or the drive is not
available, the apps play as before.

## Before you start

Three conditions must be true. If one is false, the update cannot
install.

1. **The installed app must contain the update client.** Apps built
   from an OTA-capable SDK contain it. Older installed builds do not.
   They need one manual install first — see
   [One-time bootstrap](#one-time-bootstrap).
2. **The update must have the same signature as the installed app.**
   Android refuses an update from a different signer. Sign every
   release of an app with the same private key. See
   [Shipping to production](white-label.md#shipping-to-production).
3. **The update must have a higher `versionCode`.** Increase
   `versionCode` for every release. An app never offers an update with
   an equal or lower `versionCode`.

## Publish an update

### Step 1 — build the release APK

Build the brand APK with a version and the brand's signing
configuration:

```bash
export ALIRAN_STORE_PASSWORD='...'
export ALIRAN_KEY_PASSWORD='...'
node tools/brand.mjs ../acme --version-code 5 --version-name 1.1.0
```

[White-label branding](white-label.md#shipping-to-production) tells
you how to set up `signing.json` and the keystore. At the end, the
builder prints the `applicationId`, the `versionCode`, and the
`versionName`. You need these values for the upload.

### Step 2 — upload the APK to the panel

In the admin dashboard, open the **App updates** tab. Fill in the
`applicationId`, the `versionCode`, and the `versionName` from the
build output. Then click **Choose file and publish…**. Select the APK.

Or use the admin API. The request body is the raw file:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  --data-binary @app-acme-release.apk \
  "http://localhost:3210/api/updates/com.aliranclient.acme?platform=android&versionCode=5&versionName=1.1.0"
```

| Parameter | Meaning |
|---|---|
| `platform` | `android` or `windows`. The panel accepts `windows` files as a base for a later release. The desktop app does not use them yet. |
| `versionCode` | Required integer. It must be higher than the published one. `force=1` overrides this check. |
| `versionName` | Required. The version text the viewer sees, for example `1.1.0`. |
| `minVersionCode` | Optional. Installed builds below this value see a [mandatory update](#mandatory-updates). |
| `notes` | Optional release notes text. |

The panel computes the file's size and sha256 itself. The default size
limit is 512 MB. For each app, the panel keeps the current file and
one older file. It removes older files automatically.

`GET /api/updates` lists the published manifest.
`DELETE /api/updates/<applicationId>` removes an app's entry and its
files.

### Step 3 — wait for the devices

Devices see the new version at their next app start, or when the
viewer returns to the app. A viewer can check immediately in
**Settings**. The viewer then downloads, and confirms the install in
the Android dialog.

## The public (keyless) app

The stock keyless app updates through your panel too. GitHub releases
stay the official source. The flow:

1. Download the official APK from the project's GitHub releases page.
2. Upload it to your panel with the app id `com.aliranclient` and the
   release's `versionCode`.
3. Keyless devices that are paired with your panel then update over
   P2P.

If you do not upload it, nothing breaks. Viewers update by hand from
GitHub, as before. You cannot serve a changed public APK: official
public builds must be release-signed, and a device refuses an update
from a different signer.

## Mandatory updates

Set `minVersionCode` to make an update mandatory. An installed build
below that value shows a persistent banner. The viewer cannot dismiss
it. Playback continues — a mandatory update never blocks the stream.

## Rules and warnings

- **Never upload an internal or development build.** The updates drive
  is public. Each viewer, and each person with the panel key, can
  download every file on it. A build with baked-in credentials or
  auto-login must never go there.
- **Keep the keystore and its passwords out of git.** Keep real brand
  directories outside the repository.
- **Do not lose the keystore.** Without it, no future build can update
  the installed apps. Each device then needs a manual reinstall.
- **`platform=windows` is only a base.** The panel stores Windows
  files, but the desktop app does not download updates yet.

## One-time bootstrap

Devices with a build from before the update client cannot update over
P2P. They do not know how. Install one OTA-capable build on them
manually (sideload), one time. From then on, they update over P2P.

## Troubleshooting

| Symptom | Possible cause | Action |
|---|---|---|
| The update never appears on a device | The manifest `applicationId` is not the installed app's id | Compare the id in the **App updates** tab with the builder's output. Upload under the exact id. |
| The update never appears on a device | The uploaded `versionCode` is not higher than the installed one | Check the installed version in **Settings**. Publish a higher `versionCode`. |
| The update never appears on a device | The device is a keyless build that is not paired with your panel | Pair the device first. An unpaired app has no update source. |
| The install fails at the Android dialog | The update's signature is not the installed app's signature | Sign with the same keystore as the installed build. A debug-signed install can never update to a release-signed build — reinstall once. |
| The install fails at the Android dialog | The viewer did not permit "install unknown apps" for the app | The app opens the permission screen itself. Tell the viewer to allow it and try again. |
| The download stops or does not start | The device is on a metered network | This is the default protection. The viewer can tap "Download anyway". |
| The download stops or does not start | No reachable peers hold the file | Make sure the panel is up and reachable. The panel always serves its own drive. |
