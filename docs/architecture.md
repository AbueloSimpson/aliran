# Architecture

Aliran has **three peer-to-peer components**. Transport, discovery, and replication
are fully serverless (Hyperswarm DHT); the panel is the *logical* authority for
accounts + catalog, and is the only online dependency (for new logins only).

```mermaid
flowchart LR
  subgraph Origin
    OBS[OBS / RTSP / HLS / file]
  end
  OBS -->|ingest| B[broadcaster<br/>Linux, headless]
  B -->|encrypted feed<br/>Hyperdrive| SW((Hyperswarm DHT))
  B -->|register stream| P[panel<br/>accounts + catalog + OPRF]
  P <-->|login / catalog / entitlement| C1[client APK]
  P <-->|login / catalog / entitlement| C2[client APK]
  SW <-->|replicate + re-seed| C1
  SW <-->|replicate + re-seed| C2
  C1 <-->|mesh re-seed| C2
```

## Components

### Broadcaster (Linux)
Ingests an existing stream (OBS RTMP push, or pull from RTSP/HLS/file), transcodes to
**live HLS** (or CENC/CMAF for DRM), writes the encrypted segments into a
**Hyperdrive**, and seeds it over Hyperswarm. Registers the stream + metadata with the
panel. Playback "live" is handled by HLS semantics; the P2P layer just moves bytes.

### Client (Android phone + TV)
A React Native (`react-native-tvos`) app embedding **Bare** via `react-native-bare-kit`.
Inside Bare: Hyperswarm + Hyperdrive replica + a **localhost HTTP server** with Range
support. `react-native-video` plays `http://127.0.0.1:<port>/index.m3u8`. The client
**both downloads and re-seeds** — distribution scales with viewers.

### Panel (Linux/desktop, HA)
A single-writer, **panel-signed** Hyperbee holding the **account DB** and **stream
catalog**, plus an **assets Hyperdrive** (posters/art). Serves an **OPRF login** RPC
(brute-force choke point) and issues session/entitlement tokens. Runs as a replica set
(threshold OPRF) for availability.

## Key data flows

- **Login:** client → panel OPRF RPC (blinded password, PoW) → derives key → verifies
  against the signed DB → unwraps stream keys. See
  [security-model.md](security-model.md).
- **Catalog:** panel appends signed metadata; clients `bee.watch()` for live updates.
- **Stream join:** client takes `feedKey` from the catalog and the `encryptionKey` it
  unsealed at login (not from the catalog) → joins the feed swarm
  → replicates (decrypting) → serves locally → plays.
- **DRM (optional):** encrypted CENC bytes flow P2P; the license request goes to the
  DRM vendor with a panel-issued entitlement JWT.

## Sequence diagrams

### Login (OPRF — brute-force resistant)

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Panel (OPRF + throttle)
  participant DB as Signed account DB (replicated)
  C->>C: solve proof-of-work, then blind(password)
  C->>P: login(username, blindedPassword, pow)
  P->>P: verify PoW, check lockout(username, peerKey)
  P-->>C: OPRF(oprfKey, blindedPassword)
  Note over P: never sees password or result
  C->>C: rwd = unblind(...), wrapKey = Argon2id(rwd, salt)
  C->>DB: read signed user/<username>
  C->>C: verify against record, unwrap stream keys
  C->>C: seal session in Keystore (long TTL)
```

### Stream join & playback

```mermaid
sequenceDiagram
  participant U as UI (RN)
  participant B as Bare backend
  participant SW as Hyperswarm
  participant V as react-native-video
  U->>B: play(streamId)
  B->>B: feedKey from catalog + encryptionKey unsealed at login
  B->>SW: join(feed topic) — server+client (re-seed)
  SW-->>B: replicate encrypted segments (from broadcaster + peers)
  B->>B: start localhost HTTP server (Range) over decrypting drive
  B-->>U: { port }
  U->>V: source = http://127.0.0.1:port/index.m3u8
  V->>B: GET /index.m3u8, /segN.m4s (Range)
  B-->>V: decrypted HLS bytes → live playback
```

### DRM license (optional)

```mermaid
sequenceDiagram
  participant C as Client (ExoPlayer/Widevine)
  participant P as Panel
  participant L as DRM license server (vendor)
  C->>P: entitlement(username, streamId, sessionToken)
  P->>P: check authorization (+ geo, if enabled)
  P-->>C: signed entitlement JWT
  C->>L: license request (CDM challenge) + JWT header
  L-->>C: license (content key) — decrypt in secure path
  Note over C: encrypted CENC media still arrives via P2P
```
