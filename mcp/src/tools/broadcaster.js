// broadcaster_* tools — thin wrappers over the broadcaster control API
// (broadcaster/src/control-server.js). Registered only when the config has a
// `broadcaster` block. The control API is OFF unless CONTROL_ENABLED=1; when it is
// off the broadcaster is not listening on :3310 and calls fail 'unreachable' — the
// error wrapper surfaces that plainly (server_install sets CONTROL_ENABLED=1).
//
// GETs carry readOnlyHint. remove/stop/rotate carry destructiveHint (they take a
// channel off air or restart its feed generation); start is a normal action.
//
// `input` / `transcode` are TYPED (they used to be `z.any()`, which serializes to an
// empty JSON Schema `{}`): with no type information for a parameter, a client hands
// objects over as JSON STRINGS. The broadcaster's normalizeInput() then saw a string,
// failed the url-scheme test, and fell through to its catch-all — storing the whole
// blob as `{kind:'file', path:'{"kind":"pull",…}'}`. HTTP 200, normal-looking body,
// sourceCount 0, channel dead. That silently cost four production channels their
// source on 2026-07-24. Two layers stop it now: the schemas below publish the real
// shapes, and jsonish() re-parses a stringified object before it is forwarded.
//
// The shapes MIRROR broadcaster/src/channel.js (normalizeInput/normalizeTranscode),
// deliberately duplicated rather than imported: @aliran/mcp ships standalone against a
// possibly remote broadcaster and depends on the MCP SDK + zod only. The broadcaster
// stays the authority — it re-validates everything — and test:mcp round-trips these
// tools through the REAL normalizeInput so the two cannot drift apart silently.

import { z } from 'zod'
import { genPassword } from './panel.js'

const q = (v) => encodeURIComponent(String(v))

// --- typed channel input / transcode -----------------------------------------

const PULL_URL = z.string().min(1).max(512)
  .regex(/^(https?|rtsp|rtmps?|srt|udp):\/\//i, 'url scheme must be http(s), rtsp, rtmp(s), srt or udp')
const PORT = z.number().int().min(1024).max(65535)

const CHANNEL_INPUT_OBJECT = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test') })
    .describe('the built-in test pattern (colour bars + tone)'),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1).max(512) })
    .describe('a local media file on the broadcaster host, looped'),
  z.strictObject({ kind: z.literal('pull'), url: PULL_URL, fallbacks: z.array(PULL_URL).max(4).optional() })
    .describe('pull from a remote url, with up to 4 backup urls tried in order'),
  z.strictObject({ kind: z.literal('rtmp'), port: PORT.optional(), streamKey: z.string().regex(/^[A-Za-z0-9]{8,64}$/, 'streamKey must be 8-64 letters/digits').optional() })
    .describe('push: an RTMP listener for an OBS-style encoder (port auto-allocated when omitted)'),
  z.strictObject({ kind: z.literal('srt'), port: PORT.optional(), latencyMs: z.number().int().min(20).max(5000).optional(), passphrase: z.string().regex(/^[A-Za-z0-9._-]{10,79}$/, 'passphrase must be 10-79 chars of A-Z a-z 0-9 . _ -').nullable().optional() })
    .describe('push: an SRT listener (passphrase = real encryption/auth)'),
  z.strictObject({ kind: z.literal('udp'), port: PORT.optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() })
    .describe('push: raw MPEG-TS over UDP')
])

// The string branch is the documented shorthand — "test", "rtmp", a pull url, or a
// file path (normalizeInput upgrades those to the typed form). It is ALSO where a
// client that stringifies objects lands; jsonish() tells the two apart before the
// value can reach the API, so a brace-leading string is never taken for a path.
const CHANNEL_INPUT = z.union([z.string().min(1), CHANNEL_INPUT_OBJECT])

const CHANNEL_TRANSCODE = z.strictObject({
  encoder: z.enum(['copy', 'libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_amf']).optional(),
  resolution: z.enum(['source', '1080p', '720p', '480p', '360p']).optional(),
  fps: z.union([z.literal('source'), z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
  videoBitrateKbps: z.number().int().min(100).max(20000).nullable().optional(),
  audioBitrateKbps: z.number().int().min(64).max(320).optional(),
  preset: z.enum(['fast', 'balanced', 'quality']).optional()
})
// null clears a channel's transcode settings; the string branch is, again, only the
// carrier for a stringified object (there is no transcode shorthand).
const TRANSCODE_ARG = z.union([CHANNEL_TRANSCODE, z.null(), z.string().min(1)])

const INPUT_HINT = 'accepted: "test" | "rtmp" | a pull url | a file path | {kind:"test"} | {kind:"file",path} | {kind:"pull",url,fallbacks?} | {kind:"rtmp"|"srt"|"udp",port?,…}'
const TRANSCODE_HINT = 'accepted: null (clear) | {encoder?,resolution?,fps?,videoBitrateKbps?,audioBitrateKbps?,preset?}'

// Per-channel HLS window (G12) — bounds mirror channel.js normalizeMeta (the
// broadcaster re-validates; test:mcp round-trips both so they cannot drift).
const HLS_TIME = z.number().int().min(1).max(30)
  .describe('HLS segment length in seconds, 1-30 (default: the broadcaster env HLS_TIME, normally 2)')
const HLS_LIST_SIZE = z.number().int().min(2).max(64)
  .describe('segments kept in the live window, 2-64 (default: the broadcaster env HLS_LIST_SIZE, normally 8 — reference deploys use 12)')

// An object that arrived as a STRING. A leading `{` is the tell: no shorthand, url or
// file path starts with a brace. Parse it — or fail LOUDLY. The one thing this must
// never do is hand a JSON blob onwards to be stored as a file path.
function jsonish (value, label) {
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return value
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (err) {
    throw new Error(`${label} looks like JSON but did not parse (${err.message}) — pass ${label} as an object, not as a quoted JSON string`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be an object — got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`)
  return parsed
}

// Validate against the mirrored schema after the string-carrier rescue. Throws a
// readable message (the def() wrapper turns it into an isError tool result).
function typed (schema, value, label, hint) {
  const r = schema.safeParse(jsonish(value, label))
  if (r.success) return r.data
  const seen = new Set()
  for (const issue of flattenIssues(r.error.issues)) {
    seen.add(issue.path && issue.path.length ? `${label}.${issue.path.join('.')}: ${issue.message}` : `${label}: ${issue.message}`)
  }
  throw new Error(`invalid ${label} — ${[...seen].join('; ')} (${hint})`)
}

// Union failures nest the per-branch issues one level down; surface those instead of
// a bare "invalid input", so the operator sees WHICH field was wrong.
function flattenIssues (issues, depth = 0) {
  const out = []
  for (const issue of issues || []) {
    const nested = issue.errors || issue.unionErrors
    if (nested && depth < 3) {
      for (const branch of nested) out.push(...flattenIssues(Array.isArray(branch) ? branch : branch.issues, depth + 1))
    } else out.push(issue)
  }
  return out
}

// Coerce+validate the two footgun fields out of a tool's arguments.
function channelBody ({ input, transcode, ...rest }) {
  const body = { ...rest }
  if (input !== undefined) body.input = typed(CHANNEL_INPUT, input, 'input', INPUT_HINT)
  if (transcode !== undefined) {
    body.transcode = typed(TRANSCODE_ARG, transcode, 'transcode', TRANSCODE_HINT)
    // A string that survived jsonish() is not a stringified object — and unlike
    // `input`, transcode has no string shorthand at all.
    if (typeof body.transcode === 'string') throw new Error(`invalid transcode — there is no string shorthand (${TRANSCODE_HINT})`)
  }
  return body
}

export function registerBroadcasterTools (ctx, h) {
  const { def, ok } = h
  const b = ctx.broadcaster

  // ---- read (readOnlyHint) ----
  def('broadcaster_health', { title: 'Broadcaster health', description: 'Unauthenticated /healthz: up + boot-resume progress (resuming N/total). Point liveness checks here.', annotations: { readOnlyHint: true } },
    async () => ok(await b.healthz()))

  def('broadcaster_status', { title: 'Broadcaster status', description: 'Control-plane status summary across all channels.', annotations: { readOnlyHint: true } },
    async () => ok(await b.get('/api/status')))

  def('broadcaster_capabilities', { title: 'Broadcaster capabilities', description: 'ffmpeg probe: available push/pull protocols and deep-verified encoders. Use it before choosing a transcode encoder or push protocol.', annotations: { readOnlyHint: true } },
    async () => ok(await b.get('/api/capabilities')))

  def('broadcaster_list_channels', { title: 'List channels', description: 'All channels with live status (state/ffmpeg/peers/registered/ingest).', annotations: { readOnlyHint: true } },
    async () => ok(await b.get('/api/channels')))

  def('broadcaster_get_channel', { title: 'Get a channel', description: 'One channel\'s full live status.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ok(await b.get('/api/channels/' + q(id))))

  def('broadcaster_channel_logs', { title: 'Channel ffmpeg logs', description: 'The per-channel ffmpeg stderr ring — usually the last line is why a source will not play.', inputSchema: { id: z.string(), lines: z.number().int().min(1).max(400).optional() }, annotations: { readOnlyHint: true } },
    async ({ id, lines }) => ok(await b.get('/api/channels/' + q(id) + '/logs' + (lines ? '?lines=' + q(lines) : ''))))

  def('broadcaster_incidents', { title: 'Broadcaster incidents', description: 'Correlated incidents (fleet-wide respawn bursts, source failovers), newest first. Ephemeral — cleared on a broadcaster restart.', annotations: { readOnlyHint: true } },
    async () => ok(await b.get('/api/incidents')))

  def('broadcaster_analytics', {
    title: 'Broadcaster analytics',
    description: 'Aggregate-only per-channel rollups (S48): peer-link min/mean/max, egress bytes, respawns + incidents per hour/UTC day. days = how many days back (default 7). Peer counts are lower bounds ("≥ N" — viewers also serve each other); labels are public stream ids, never identities.',
    inputSchema: { days: z.number().int().min(1).max(3650).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ days }) => ok(await b.get('/api/analytics' + (days ? '?days=' + q(days) : ''))))

  def('broadcaster_list_admins', {
    title: 'List control admins',
    description: 'Broadcaster control-dashboard admin accounts (name/status/createdAt — never password material). Separate from the panel\'s admins.',
    annotations: { readOnlyHint: true }
  }, async () => ok(await b.get('/api/admins')))

  // ---- create / mutate ----
  def('broadcaster_add_channel', {
    title: 'Add a channel',
    description: 'Add a channel to the broadcaster registry. input: "test" (built-in pattern), a file path, a pull url, or the object form — {kind:"pull",url,fallbacks?} / {kind:"file",path} / a push listener {kind:"rtmp"|"srt"|"udp",port?}. transcode: {encoder:"copy"|"libx264"|...}. buffer: "disk" (default) | "ram". hlsTime/hlsListSize override the per-channel HLS window (1-30 s segments / 2-64 kept; reference deploys use 12). thumb: live-thumbnail tri-state — true (on), false (off), null (follow the fleet default: on for transcoding channels, OFF for copy channels, where the thumbnail forces the decoder on at ~0.9% of a core each). Send input/transcode as real objects, NOT as quoted JSON strings.',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), input: CHANNEL_INPUT.optional(), transcode: TRANSCODE_ARG.optional(), buffer: z.enum(['disk', 'ram']).optional(), hlsTime: HLS_TIME.optional(), hlsListSize: HLS_LIST_SIZE.optional(), thumb: z.union([z.boolean(), z.null()]).optional() }
  }, async (a) => ok(await b.post('/api/channels', channelBody(a))))

  def('broadcaster_update_channel', {
    title: 'Edit a channel',
    description: 'Patch a channel\'s meta/input/transcode/HLS window (applied on the next start; a source change rotates the feed identity). Same input/transcode shapes as broadcaster_add_channel — objects, not quoted JSON strings. hlsTime (1-30) / hlsListSize (2-64) tune the per-channel HLS window. thumb: live-thumbnail tri-state — true (on), false (off), null (follow the fleet default: on for transcoding, OFF for copy channels — a thumbnail forces the decoder on, ~0.9% of a core each; a stop→start applies it). Omitted fields keep their stored value; transcode:null clears it. Verify afterwards that the channel reports the source you intended.',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), input: CHANNEL_INPUT.optional(), transcode: TRANSCODE_ARG.optional(), hlsTime: HLS_TIME.optional(), hlsListSize: HLS_LIST_SIZE.optional(), thumb: z.union([z.boolean(), z.null()]).optional() }
  }, async ({ id, ...fields }) => ok(await b.patch('/api/channels/' + q(id), channelBody(fields))))

  def('broadcaster_start_channel', { title: 'Start a channel', description: 'Start a channel (spawns ffmpeg, mints/reuses the feed, registers with the panel).', inputSchema: { id: z.string() } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/start', {})))

  // ---- control-dashboard admins (S49a) ----
  def('broadcaster_add_admin', {
    title: 'Add a control admin',
    description: 'Create a broadcaster control-dashboard admin account. If password is omitted a strong one is generated and returned so you can hand it over.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await b.post('/api/admins', { username, password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  def('broadcaster_set_admin_password', {
    title: 'Set a control admin password',
    description: 'Rotate a broadcaster control-admin password (bumps tokenVersion: every live session for that admin dies). Omit password to generate + return one. CAUTION: if this is the account this MCP itself logs in with (config "broadcaster.user"/"pass"), update the operator\'s local mcp config (mcp/config.json) right afterwards — the broadcaster_* tools re-login with the configured password and will fail auth until it matches.',
    inputSchema: { username: z.string(), password: z.string().min(8).optional() }
  }, async ({ username, password }) => {
    const pw = password || genPassword()
    const out = await b.post('/api/admins/' + q(username) + '/password', { password: pw })
    return ok({ ...out, generatedPassword: password ? undefined : pw })
  })

  // ---- destructive (destructiveHint) ----
  def('broadcaster_stop_channel', { title: 'Stop a channel', description: 'Stop a channel (ffmpeg down; the panel catalog flips it to isLive:false). Takes it off air.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/stop', {})))

  def('broadcaster_rotate_channel', { title: 'Rotate a channel feed', description: 'Disk mode: mint a fresh feed generation now (bounds merkle-tree growth). ffmpeg keeps running; watching viewers follow the new feedKey.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/rotate', {})))

  def('broadcaster_remove_channel', { title: 'Remove a channel', description: 'Remove a STOPPED channel from the registry (its feed data is kept on disk).', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.del('/api/channels/' + q(id))))

  def('broadcaster_remove_admin', {
    title: 'Remove a control admin',
    description: 'Delete a broadcaster control-admin account. CAUTION: removing the account this MCP logs in with (config "broadcaster.user") locks the broadcaster_* tools out; removing the LAST admin locks the control dashboard — recover on the box with `docker compose run --rm broadcaster node src/control-cli.js add-admin <name>`.',
    inputSchema: { username: z.string() },
    annotations: { destructiveHint: true }
  }, async ({ username }) => ok(await b.del('/api/admins/' + q(username))))
}
