// Pairing-code resolution — runtime-agnostic (runs in Bare and in Node).
//
// A viewer types 'A3K7-9QF2-M4XR' instead of 64 hex characters. This turns that code
// into the operator's panel public key, which the caller then uses exactly as if the
// key itself had been typed (see sdk/player.js connect()).
//
// THE FLOW
//   1. Derive the rendezvous topic from the code alone — no panel call, no registry.
//   2. Join it and ask whoever answers to `describe` itself.
//   3. VERIFY BY RECOMPUTING: derive the code from the panel key in the answer and
//      require it to equal what the viewer typed.
//
// Step 3 is the whole security of this. The topic is public and unauthenticated, so
// anyone may answer on it — including an attacker who wants the viewer's app to adopt
// THEIR panel key and phish the credentials the viewer types next. An answer that
// does not re-derive the typed code is discarded and the search continues; it never
// falls through to "well, use the key anyway". An attacker therefore has to grind a
// keypair whose Argon2id-derived code collides with the operator's 60-bit code, which
// is what the memory-hard KDF prices out (see core/pairing.js).
//
// The panel key stays the verification root either way: after this returns, the client
// opens the panel's Hyperbee BY KEY, so a wrong key reaches a different service
// entirely rather than a tampered view of the right one.

import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import b4a from 'b4a'
import { normalizePairingCode, formatPairingCode, pairingTopic, pairingCodeMatches } from '@aliran/core'

// How long to look before giving up. Generous: a cold DHT lookup from a TV box on a
// slow link is the normal case here, and the viewer has already typed the code.
const DEFAULT_TIMEOUT_MS = 30000
// Force a fresh lookup on this cadence while nobody has answered. One lookup round can
// legitimately come back empty — a panel that announced a moment ago is not on every
// node yet — and pairing is a ONE-SHOT the viewer judges the product by: "no service
// answered" when the service is there is the worst outcome this code can produce.
// Same self-heal the player uses for the panel topic (sdk/player.js).
const RELOOKUP_MS = 5000
// A `describe` answer is a small JSON object. Anything larger is not one.
const MAX_DESCRIPTOR_BYTES = 8192
const SERVICE_NAME_MAX = 64

export class PairingError extends Error {
  constructor (code, message) { super(message); this.name = 'PairingError'; this.code = code }
}

// Reasons a caller may want to tell apart. `unverified` is the interesting one: a peer
// DID answer, and its key does not own the code.
export const PAIRING_ERRORS = {
  malformed: 'malformed', // not a pairing code at all — nothing was sent anywhere
  timeout: 'timeout', // nobody answered: wrong code, or the service is unreachable
  unverified: 'unverified' // someone answered with a key that does not own the code
}

/**
 * Resolve a pairing code to an operator service descriptor.
 *
 * @param {string} code            what the viewer typed ('a3k7 9qf2 m4xr' is fine)
 * @param {object} [opts]
 * @param {object} [opts.swarm]    an existing Hyperswarm to borrow (left joined to
 *                                 nothing extra on return); one is created otherwise
 * @param {string[]} [opts.bootstrap]  custom DHT bootstrap nodes (tests, private DHTs)
 * @param {number} [opts.timeoutMs]    default 30 s
 * @returns {Promise<{panelPubKey: string, name: string|null, branding: object|null, code: string}>}
 * @throws {PairingError} code 'malformed' | 'timeout' | 'unverified'
 */
export async function resolvePairingCode (code, opts = {}) {
  const canonical = normalizePairingCode(code)
  if (!canonical) throw new PairingError(PAIRING_ERRORS.malformed, 'that is not a pairing code — it is 12 characters, like A3K7-9QF2-M4XR')

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const swarm = opts.swarm || new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {})
  const ownSwarm = !opts.swarm
  const topic = pairingTopic(canonical)

  let onConnection = null
  let discovery = null
  let timer = null
  let relookup = null
  // Set only when a peer returned a WELL-FORMED descriptor whose panel key does not own
  // the code. Reported instead of a plain timeout, so "someone is squatting this code"
  // never reads as "no service". A peer that simply does not speak `describe` — the
  // topic is public, so that happens — must NOT set this: telling a viewer their
  // operator failed to prove itself, when nothing relevant answered at all, is the one
  // wrong thing to say here.
  let sawImpostor = false

  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }

      timer = setTimeout(() => {
        done(reject, sawImpostor
          ? new PairingError(PAIRING_ERRORS.unverified, 'a service answered that code, but it could not prove it owns it — re-check the code with your operator')
          : new PairingError(PAIRING_ERRORS.timeout, 'no service answered that code — re-check it, and check your connection'))
      }, timeoutMs)

      onConnection = (socket) => {
        if (settled) return
        // Every peer on this topic is a candidate and none is trusted. Ask, verify,
        // and on any failure just wait for the next one — a peer that answers wrongly
        // (or not at all) must not be able to deny the real panel its turn.
        askPeer(socket, canonical)
          .then((r) => { if (r.service) done(resolve, r.service); else if (r.impostor) sawImpostor = true })
          .catch(() => {})
      }
      swarm.on('connection', onConnection)
      discovery = swarm.join(topic, { client: true, server: false })
      // Not awaited: flush() resolves only once the lookup round completes, and the
      // first peer often answers well before that.
      swarm.flush().catch(() => {})
      // Keep asking. Measured on a freshly announced panel: the first round found
      // nothing and the join sat idle until the timeout, while a second lookup a few
      // seconds later connected in 3 s.
      relookup = setInterval(() => {
        if (settled) return
        // refresh() is async and rejects once the discovery is destroyed, so the catch
        // has to be on the PROMISE — a try/catch around it would never see that.
        try { discovery.refresh().catch(() => {}) } catch {}
      }, RELOOKUP_MS)
      if (typeof relookup.unref === 'function') relookup.unref()
    })
  } finally {
    clearTimeout(timer)
    clearInterval(relookup)
    if (onConnection) swarm.off('connection', onConnection)
    // Leave the rendezvous behind either way — pairing is a one-shot, and the engine
    // that boots next joins the panel's own topic, not this one.
    try { if (discovery) await discovery.destroy() } catch {}
    if (ownSwarm) { try { await swarm.destroy() } catch {} }
  }
}

// One candidate peer: request the descriptor, then re-derive the code from the key it
// sent. Three outcomes, and the difference between the last two is what the viewer is
// told:
//   { service }         the key owns the code — done
//   { impostor: true }  a real descriptor whose key does NOT own the code
//   {}                  nothing usable (no `describe`, junk, or a malformed key) —
//                       an ordinary stranger on a public topic, not an accusation
async function askPeer (socket, canonical) {
  const rpc = new ProtomuxRPC(socket)
  let res
  try { res = await rpc.request('describe', b4a.alloc(0)) } catch { return {} }
  if (!res || typeof res.length !== 'number' || res.length > MAX_DESCRIPTOR_BYTES) return {}

  let body
  try { body = JSON.parse(b4a.toString(res)) } catch { return {} }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}

  const panelPubKey = typeof body.panelPubKey === 'string' ? body.panelPubKey.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(panelPubKey)) return {}
  // The verification. ~70 ms of Argon2id, once per candidate.
  if (!pairingCodeMatches(panelPubKey, canonical)) return { impostor: true }

  return {
    service: {
      panelPubKey,
      // Everything below is UNSIGNED display text from a peer that has now proved it
      // holds the right key — trusted exactly as far as the panel itself is, and
      // capped so a hostile answer cannot push a wall of text into a Connect screen.
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, SERVICE_NAME_MAX) : null,
      branding: body.branding && typeof body.branding === 'object' && !Array.isArray(body.branding) ? body.branding : null,
      code: formatPairingCode(canonical)
    }
  }
}
