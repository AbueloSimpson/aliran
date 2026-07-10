# Reference

## admin-cli commands

| Command | Description |
|---------|-------------|
| `init` | Generate panel signing key + OPRF key (gitignored data dir) |
| `create-user <u>` / `set-password <u>` | Create/rotate a user (Argon2id verifier) |
| `grant <u> <stream>` / `revoke <u>` | Entitle / disable a user for a stream |
| `add-stream <id> [--title --category --featured]` | Register a stream + gen encryption key |
| `set-meta <id> …` | Update catalog metadata |
| `upload-art <id> <poster\|backdrop\|logo> <file>` | Add art to the assets drive |
| `set-max-devices <u> <n>` | Concurrent device limit |
| `list-devices <u>` / `logout-device <u> <id>` / `logout-all <u>` | Device/session management |
| `unlock <u>` | Clear brute-force lockout |
| `list` | List users and streams |

## Panel RPC (over Hyperswarm)

- `login(blindedPassword, username, pow)` → OPRF evaluation (throttled; never returns
  account secrets).
- `refresh(deviceToken)` → new session token (sliding window; device-key auth).
- `entitlement(username, streamId, sessionToken)` → signed JWT for DRM/geo (when enabled).

## Schemas

### Catalog record (`catalog/<streamId>`)
```jsonc
{
  "title": "News 24",
  "description": "...",
  "category": ["news"],
  "type": "live",              // live | vod
  "protection": "self",        // self | drm
  "allowedRegions": null,      // or ["US","CA"]
  "isLive": true,
  "viewerCount": null,         // derived, not durable
  "order": 0,
  "poster": "assets/<hash>.jpg",
  "backdrop": "assets/<hash>.jpg",
  "logo": "assets/<hash>.png",
  "feedKey": "<hex>",
  "encryptionKey": "<hex|null>",
  "drm": null,                 // or { scheme, licenseServerRef }
  "status": "live"
}
```

### User record (`user/<username>`)
```jsonc
{
  "salt": "<hex>",
  "verifier": "<hex>",         // Argon2id(OPRF output, salt)
  "wrapped": { "<streamId>": "<ciphertext>" },
  "devices": [ { "deviceId": "<pubkey>", "label": "Pixel 8", "expiresAt": 0, "tokenVersion": 1, "status": "active" } ],
  "tokenVersion": 1,
  "status": "active"
}
```
