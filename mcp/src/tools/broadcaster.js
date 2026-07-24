// broadcaster_* tools — thin wrappers over the broadcaster control API
// (broadcaster/src/control-server.js). Registered only when the config has a
// `broadcaster` block. The control API is OFF unless CONTROL_ENABLED=1; when it is
// off the broadcaster is not listening on :3310 and calls fail 'unreachable' — the
// error wrapper surfaces that plainly (server_install sets CONTROL_ENABLED=1).
//
// GETs carry readOnlyHint. remove/stop/rotate carry destructiveHint (they take a
// channel off air or restart its feed generation); start is a normal action.

import { z } from 'zod'

const q = (v) => encodeURIComponent(String(v))

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

  // ---- create / mutate ----
  def('broadcaster_add_channel', {
    title: 'Add a channel',
    description: 'Add a channel to the broadcaster registry. input: "test" (built-in pattern), a file path, a pull object {kind:"pull",url}, or a push listener {kind:"rtmp"|"srt"|"udp",port?}. transcode: {encoder:"copy"|"libx264"|...}. buffer: "disk" (default) | "ram".',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), input: z.any().optional(), transcode: z.any().optional(), buffer: z.enum(['disk', 'ram']).optional() }
  }, async (a) => ok(await b.post('/api/channels', a)))

  def('broadcaster_update_channel', {
    title: 'Edit a channel',
    description: 'Patch a channel\'s meta/input/transcode (applied on the next start; a source change rotates the feed identity).',
    inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), input: z.any().optional(), transcode: z.any().optional() }
  }, async ({ id, ...body }) => ok(await b.patch('/api/channels/' + q(id), body)))

  def('broadcaster_start_channel', { title: 'Start a channel', description: 'Start a channel (spawns ffmpeg, mints/reuses the feed, registers with the panel).', inputSchema: { id: z.string() } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/start', {})))

  // ---- destructive (destructiveHint) ----
  def('broadcaster_stop_channel', { title: 'Stop a channel', description: 'Stop a channel (ffmpeg down; the panel catalog flips it to isLive:false). Takes it off air.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/stop', {})))

  def('broadcaster_rotate_channel', { title: 'Rotate a channel feed', description: 'Disk mode: mint a fresh feed generation now (bounds merkle-tree growth). ffmpeg keeps running; watching viewers follow the new feedKey.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.post('/api/channels/' + q(id) + '/rotate', {})))

  def('broadcaster_remove_channel', { title: 'Remove a channel', description: 'Remove a STOPPED channel from the registry (its feed data is kept on disk).', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => ok(await b.del('/api/channels/' + q(id))))
}
