# @aliran/panel

The **origin of truth** for an Aliran deployment: a single-writer, panel-signed
Hyperbee holding the account DB + stream catalog, an assets Hyperdrive, and the
throttled **OPRF login** service.

## Run

```bash
cp .env.example .env         # edit as needed
npm install
node src/admin-cli.js init   # generate signing + OPRF keys (prints the panel public key)
node src/admin-cli.js create-user alice
node src/index.js            # start the panel node
```

## Layout

```
src/config.js      env-driven config
src/keys.js        panel signing key + OPRF key (init/load); stored in DATA_DIR/keys
src/index.js       panel node: DB + assets + DHT announce + replication + OPRF RPC
src/admin-cli.js   admin commands (users, streams, devices, art)
```

## Status / TODO

- [x] Key generation (`init`), config loader, DB open, DHT announce + replication wiring
- [ ] **OPRF login RPC** (blinded eval, PoW, throttling/lockout) — *security-critical*
- [ ] Argon2id verifier + per-user key wrapping (`create-user`, `grant`)
- [ ] Session/entitlement token signing + `tokenVersion` revocation
- [ ] Device-limit enforcement
- [ ] Catalog/metadata + assets commands (`set-meta`, `upload-art`)
- [ ] HA / threshold OPRF across replicas
- [ ] Optional geo (GeoIP) + DRM entitlement endpoints

See [`../docs/security-model.md`](../docs/security-model.md). Prefer vetted crypto
libraries over hand-rolled primitives.
