# Concepts

## Why peer-to-peer

Aliran has no central media servers. Viewers replicate the stream and **re-seed** it to
each other, so distribution capacity grows with the audience instead of costing more.

## The Holepunch/Pear stack

- **Bare** — a small, embeddable JavaScript runtime (what Pear is built on). Runs on
  desktop and mobile. In Aliran it runs *inside* the Android app via
  `react-native-bare-kit`.
- **Hyperswarm** — peer discovery + encrypted connections over a DHT, with NAT
  hole-punching (works behind firewalls).
- **Hypercore** — append-only, signed log. The basis for everything below.
- **Hyperbee** — a B-tree (key/value store) on a Hypercore. Used for the account DB +
  catalog.
- **Hyperdrive** — a filesystem on Hypercores. Used for stream segments + assets.
- **Corestore** — manages many Hypercores.

> Note: **Pear the runtime cannot be packaged as an Android APK.** Aliran ships the
> Holepunch *stack* inside a React Native app (the way Keet does), not Pear itself.

## Glossary

| Term | Meaning |
|------|---------|
| **Panel** | Origin of truth: signed account DB + catalog + OPRF login |
| **Broadcaster** | Node that ingests a source and seeds the encrypted feed |
| **Client** | The Android app; plays and re-seeds |
| **Feed** | The encrypted Hyperdrive carrying a stream's HLS segments |
| **OPRF** | Oblivious PRF — makes password login brute-force-resistant |
| **Session token** | Panel-signed token from login — device limits, cooperative revocation |
| **Service descriptor** | Config bundle (panel pubkey + branding) a client connects to |

## How peers find each other

Discovery is fully serverless: there is no tracker, no STUN/TURN service you
host, and no Aliran-run directory. Everything below rides the **global
Hyperswarm DHT** — the same Kademlia-style network other Holepunch applications
(Keet, Pear apps) participate in.

### Two rendezvous, one mechanism

Every lookup in Aliran is a Hyperswarm **topic** — a 32-byte value peers
announce under and query for:

1. **Finding the service.** The panel joins the topic
   `BLAKE2b-256(panel public key)` in server mode
   (`swarm.join(topic, { server: true })`); every client derives the same topic
   from the key in its service descriptor and joins in client mode. The DHT
   brokers the introduction, and the first connection a client completes is the
   panel link that carries login RPC + catalog replication. The panel key is a
   *name*, not an address — the panel can change IPs, sit behind NAT, or move
   hosts without any client-side change.
2. **Finding a channel's swarm.** Each feed (and the assets drive) is a
   Hypercore-backed Hyperdrive; peers join its **discovery key** — a one-way
   BLAKE2b keyed hash of the feed key. The broadcaster (and any repeater) joins
   as server + client; viewers join as client **and** server, because they
   re-seed — unless the upload policy is `client-only` (metered/cellular), in
   which case they join client-only and contribute no upload. Zapping to a
   channel = joining its discovery-key topic and requesting the live window's
   blocks from whoever answers.

### The DHT itself

HyperDHT is a Kademlia-style routing overlay over UDP: each node has an ID,
keeps a routing table of nodes "near" it in ID space, and a topic's
announce/lookup records live on the nodes nearest that topic. A query walks a
few hops and returns candidate peers. Long-lived, publicly reachable nodes
(your panel, broadcaster, repeaters on a VPS) become useful routing nodes;
short-lived NATed clients stay ephemeral and store nothing. No component of
Aliran is special inside the DHT — the network survives any of them
disappearing.

### Bootstrap

Joining the DHT needs one known first contact. By default that is the
Holepunch-operated public bootstrap set baked into `hyperdht`; after the first
hop a node learns real routing-table entries and no longer depends on the
bootstrap hosts. Two override surfaces exist:

- Servers (`panel/`, `broadcaster/`, `repeater/`): `BOOTSTRAP` env,
  comma-separated `host:port` list.
- SDK/clients: `createPlayer({ swarm: { bootstrap: [{ host, port }] } })`.

Point both at your own `hyperdht` nodes and you have a **fully private DHT** —
this is exactly how the e2e suites run deterministic local testnets.

### NAT traversal

Direct connectivity is UDP hole-punching, coordinated through a DHT node both
sides already exchange traffic with: the coordinator synchronizes both peers
sending to each other so each side's NAT sees an outbound-initiated flow and
admits the replies. No port forwarding, no listening ports — every socket is
outbound UDP from an ephemeral port. Consumer NATs almost always punch;
symmetric/double NAT (CGNAT + hotel/corp gateways) can defeat it, in which case
`hyperdht` falls back to **relaying through a blind relay** — the relay forwards
Noise-encrypted UDX packets it cannot read, at a latency cost. Networks that
block outbound UDP entirely get no P2P at all; redirect (CDN) channels still
play, since they are plain HTTPS.

### What discovery reveals — and what it doesn't

Every peer connection is Noise-encrypted end-to-end with per-peer keypairs; the
DHT sees only *"this node is interested in this 32-byte topic."* But note the
flip side, spelled out in the [security model](security-model.md): the catalog
replicates keylessly, so **feed keys — and therefore discovery topics — are
public knowledge.** Anyone can join a channel's swarm and replicate ciphertext
(that is precisely what repeaters do); confidentiality comes from the feed
encryption key, delivered sealed per user at login — never from hiding the
rendezvous.

### Operator implications

- **Nothing inbound is required** for the P2P path: panel, broadcaster, and
  viewers all work behind NAT/firewalls. Only push ingest (RTMP/SRT) and the
  optional public dashboards need real inbound rules — see the
  [operator guide's firewall section](operator-guide.md).
- On hosts with a default-deny **inbound** firewall (`ufw` etc.), allow the
  ephemeral UDP range so punched flows keep working across restarts — the
  operator guide gives the exact rule.
- Fan-out is capped per topic swarm (default 64 peers): raise it on big origin
  boxes with `SWARM_MAX_PEERS` (broadcaster) / `swarm.maxPeers` (SDK,
  repeaters run in the hundreds).
- Under real fan-out the kernel's UDP socket buffers overflow before anything
  else — see [network tuning](kb/network-tuning.md) for the socket sizing the
  servers request and the host sysctl helper.
