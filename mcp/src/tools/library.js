// library_* tools — thin wrappers over the VOD library control API
// (library/src/control-server.js, :3320). Registered only when the config has a
// `library` block. The library turns a source file/URL into an encrypted,
// P2P-seeded VOD title with a ONE-SHOT ingest (ffmpeg on the library box), and
// registers it with the panel; descriptive metadata (title/description/category)
// is panel-owned after creation — edit it with panel_set_stream_meta, not here.
//
// Library dashboard-admin CRUD is deliberately NOT wrapped yet (S49 gap doc).

import { z } from 'zod'

const q = (v) => encodeURIComponent(String(v))

export function registerLibraryTools (ctx, h) {
  const { def, ok } = h
  const l = ctx.library

  // ---- read (readOnlyHint) ----
  def('library_status', { title: 'Library status', description: 'VOD library summary: title counts by state (ready/ingesting/queued/error) and the panel-link health.', annotations: { readOnlyHint: true } },
    async () => ok(await l.get('/api/status')))

  def('library_list_titles', { title: 'List VOD titles', description: 'Every VOD title with state, ingest progress, peers, and whether the panel registration landed.', annotations: { readOnlyHint: true } },
    async () => ok(await l.get('/api/titles')))

  def('library_get_title', { title: 'Get a VOD title', description: 'One title\'s registry view including the LIVE ingest phase/percent while a (re-)ingest runs — poll this after library_add_title / library_reingest_title.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ok(await l.get('/api/titles/' + q(id))))

  def('library_title_logs', { title: 'VOD ingest logs', description: 'The ffmpeg/ingest log ring for one title (newest last) plus its current state — the first stop when an ingest errors.', inputSchema: { id: z.string(), lines: z.number().int().min(1).max(400).optional() }, annotations: { readOnlyHint: true } },
    async ({ id, lines }) => ok(await l.get('/api/titles/' + q(id) + '/logs' + (lines ? '?lines=' + q(lines) : ''))))

  // ---- create / mutate ----
  def('library_add_title', {
    title: 'Add a VOD title',
    description: 'Create a VOD title and QUEUE its one-shot ingest. `input` is a media file path ON THE LIBRARY BOX (or any URL its ffmpeg can read) — not a path on your machine. mode: auto (copy when compatible, else transcode) | copy | transcode. Returns immediately with state "queued"; poll library_get_title for phase/percent. Descriptive fields (title/description/category) seed the panel record once — afterwards edit them in the panel.',
    inputSchema: { id: z.string(), input: z.string().describe('media path on the LIBRARY box, or a URL ffmpeg can read'), title: z.string().optional(), description: z.string().optional(), category: z.union([z.string(), z.array(z.string())]).optional(), mode: z.enum(['auto', 'copy', 'transcode']).optional(), hlsTime: z.number().int().min(1).max(30).optional() }
  }, async (a) => ok(await l.post('/api/titles', a)))

  def('library_set_title', {
    title: 'Edit a VOD title (operational fields)',
    description: 'Patch a title\'s OPERATIONAL fields only: input (source path/URL on the library box), mode, hlsTime — they apply on the next (re-)ingest. Descriptive metadata (title/description/category) is panel-owned after creation: use panel_set_stream_meta for that.',
    inputSchema: { id: z.string(), input: z.string().optional(), mode: z.enum(['auto', 'copy', 'transcode']).optional(), hlsTime: z.number().int().min(1).max(30).optional() }
  }, async ({ id, ...body }) => ok(await l.patch('/api/titles/' + q(id), body)))

  def('library_reingest_title', {
    title: 'Re-ingest a VOD title',
    description: 'Re-run a title\'s ingest (optionally from a new input): mints the NEXT feed generation — fresh feedKey, viewers follow via the catalog — and purges the old one, so the title is briefly unavailable while the ingest runs. Refused while an ingest is already queued/running.',
    inputSchema: { id: z.string(), input: z.string().optional() },
    annotations: { destructiveHint: true }
  }, async ({ id, ...body }) => ok(await l.post('/api/titles/' + q(id) + '/ingest', body)))

  // ---- destructive ----
  def('library_delete_title', {
    title: 'Delete a VOD title',
    description: 'Stop seeding a title and PURGE it from the library box (cores + encryption key + registry entry). Refused mid-ingest. The PANEL side is only marked: the catalog record flips to status "unavailable" — the record itself and any viewer grants survive panel-side (they are admin-owned); purge those with panel_delete_stream if the title should vanish entirely.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true }
  }, async ({ id }) => {
    const out = await l.del('/api/titles/' + q(id))
    return ok({ ...out, panelRecord: 'marked status:"unavailable" — the catalog record + grants survive panel-side; use panel_delete_stream to purge them' })
  })
}
