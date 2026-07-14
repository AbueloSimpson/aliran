# @aliran/panel

The **origin of truth** for an Aliran deployment: a single-writer, panel-signed
Hyperbee holding the account DB + stream catalog, an assets Hyperdrive, the
throttled **OPRF login** service, and an optional **admin HTTP API**.

## Run

```bash
cp .env.example .env         # edit as needed
npm install
node src/admin-cli.js init   # generate signing + OPRF keys (prints the panel public key)
node src/admin-cli.js create-user alice
node src/index.js            # start the panel node
```

To manage the panel from a browser, create an admin and enable the admin API +
dashboard — they run inside the panel process (the store is single-writer):

```bash
node src/admin-cli.js add-admin root   # prompts for a password (min 8 chars)
ADMIN_ENABLED=1 node src/index.js      # dashboard at http://127.0.0.1:3210
```

## Layout

```
src/config.js        env-driven config
src/keys.js          panel signing + OPRF + publisher keys (init/load); in DATA_DIR/keys
src/store.js         signed Hyperbee (accounts+catalog) + assets drive + private secrets
src/rpc.js           login RPC: PoW + throttle + OPRF eval + sessions + register
src/ops.js           shared admin operations (single implementation for CLI + API)
src/admin-cli.js     admin commands (users, streams, devices, art, admins)
src/admin-server.js  authed admin HTTP+JSON API + static dashboard (ADMIN_ENABLED=1)
src/index.js         panel node: DB + assets + DHT announce + replication + RPC + admin API
admin-ui/            the dashboard (plain HTML/JS/CSS, no build step)
```

## Status

- [x] Key generation (`init`), config loader, DB open, DHT announce + replication wiring
- [x] Argon2id verifier + OPRF enrollment + per-user key sealing (`create-user`, `grant`)
- [x] OPRF login RPC (blinded eval, PoW, throttling/lockout) — see `docs/security-model.md`
- [x] Session token signing + `tokenVersion` revocation + device-limit enforcement
- [x] Assets Hyperdrive + `upload-art`
- [x] Broadcaster auto-registration (publisher-signed `register` RPC)
- [x] Admin HTTP API over shared ops + web dashboard (`npm run test:admin-api`)
- [x] Admin completeness: admins CRUD + password rotation, stream purge / user delete,
      user prefix-search + cursor paging, observability (`/api/observability` + activity
      ring), curation (`order`/`featured`, register-safe), cooperative per-device revoke
- [ ] HA / threshold OPRF across replicas
- [ ] Optional geo (GeoIP) + DRM entitlement endpoints

See [`../docs/security-model.md`](../docs/security-model.md). Prefer vetted crypto
libraries over hand-rolled primitives.
