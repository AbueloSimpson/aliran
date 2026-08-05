// EPG xmltv-provider unit tests — pure logic, no network, no DHT: XMLTV date
// parsing, entity decoding, the tolerant programme parser, gzip + revalidation
// in providerXmltv (stubbed fetch), and the scheduler's prefix/override
// resolution. The end-to-end drive flow lives in tools/e2e-epg-p2p-test.mjs.
import zlib from 'zlib'
import { parseXmltvDate, parseXmltv, providerXmltv, buildProvider, IngestScheduler } from '../epg/src/ingest.js'

let failures = 0
const ok = (cond, msg) => { if (cond) { console.log('  ok  ', msg) } else { console.error('  FAIL', msg); failures++ } }

// Fixture clock: all windowing below is relative to this instant.
const NOW = Date.parse('2026-08-05T12:00:00Z')

// ---- A. XMLTV dates ----
console.log('A. parseXmltvDate')
{
  ok(parseXmltvDate('20260804040000 -0500') === Date.parse('2026-08-04T09:00:00Z'), 'negative offset shifts to UTC')
  ok(parseXmltvDate('20260804040000 +0230') === Date.parse('2026-08-04T01:30:00Z'), 'positive offset shifts to UTC')
  ok(parseXmltvDate('20260804040000') === Date.parse('2026-08-04T04:00:00Z'), 'no offset = UTC')
  ok(parseXmltvDate('202608040400') === Date.parse('2026-08-04T04:00:00Z'), 'short form (no seconds) accepted')
  ok(Number.isNaN(parseXmltvDate('yesterday')) && Number.isNaN(parseXmltvDate('')) && Number.isNaN(parseXmltvDate(null)), 'garbage is NaN, never a throw')
}

// ---- B. programme parsing ----
console.log('B. parseXmltv')
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="none">
  <channel id="Canal.A&amp;E.(Panamá).pa"><display-name>A&amp;E</display-name></channel>
  <programme start="20260805080000 -0500" stop="20260805100000 -0500" channel="Canal.A&amp;E.(Panamá).pa">
    <title lang="es">Cine &amp; Series</title>
    <desc lang="es">Una película &#233;pica</desc>
  </programme>
  <programme start="20260805100000 -0500" stop="20260805110000 -0500" channel="Canal.A&amp;E.(Panamá).pa">
    <title lang="es">Segundo programa</title>
  </programme>
  <programme start="20260805110000 -0500" channel="Canal.A&amp;E.(Panamá).pa">
    <title>sin stop — se descarta</title>
  </programme>
  <programme start="20260805120000 -0500" stop="20260805130000 -0500" channel="Otro.Canal.pa"></programme>
  <programme start="20200101000000 +0000" stop="20200101010000 +0000" channel="Otro.Canal.pa">
    <title>fuera de ventana</title>
  </programme>
</tv>`
  const guide = parseXmltv(xml, { now: NOW, guideDays: 7 })
  ok(guide.size === 1, 'channels with no valid programme are absent')
  const days = guide.get('Canal.A&E.(Panamá).pa')
  ok(!!days, 'channel id is entity-decoded')
  const progs = days?.get('2026-08-05') || []
  ok(progs.length === 2, 'valid programmes bucketed, stop-less programme dropped')
  ok(progs[0]?.title === 'Cine & Series', 'title entity-decoded')
  ok(progs[0]?.desc === 'Una película épica', 'desc kept, numeric entity decoded')
  ok(progs[0]?.start === '2026-08-05T13:00:00.000Z', 'start normalized to UTC ISO')
  ok(progs[1] && !('desc' in progs[1]), 'desc omitted when absent')
}

// ---- C. providerXmltv: gzip + revalidation ----
console.log('C. providerXmltv')
{
  const xml = `<tv><programme start="20260805080000 +0000" stop="20260805090000 +0000" channel="ch1"><title>t</title></programme></tv>`
  const gz = zlib.gzipSync(Buffer.from(xml))
  const calls = []
  const fetchImpl = async (url, { headers }) => {
    calls.push(headers)
    if (calls.length === 1) {
      return { ok: true, status: 200, headers: new Map([['etag', 'W/"abc"'], ['last-modified', 'Tue, 04 Aug 2026 20:00:00 GMT']]), arrayBuffer: async () => gz }
    }
    return { ok: false, status: 304, headers: new Map() }
  }
  const p = buildProvider({ id: 'pa', type: 'xmltv', url: 'https://example.com/pa.xml.gz', prefix: 'pa:', headers: { 'x-proxy-secret': 's3cret' } })
  const g1 = await p.fetch({ guideDays: 7, fetchImpl })
  ok(g1.size === 1 && g1.has('ch1'), 'gzipped body sniffed and parsed')
  const g2 = await p.fetch({ guideDays: 7, fetchImpl })
  ok(g2.size === 0, '304 yields an empty guide (nothing to write)')
  ok(calls[1]['if-none-match'] === 'W/"abc"' && calls[1]['if-modified-since'] === 'Tue, 04 Aug 2026 20:00:00 GMT', 'revalidation headers sent on refresh')
  ok(calls[0]['x-proxy-secret'] === 's3cret' && calls[1]['x-proxy-secret'] === 's3cret', 'spec.headers sent on every request')

  const plain = await buildProvider({ id: 'pa2', type: 'xmltv', url: 'x' }).fetch({
    guideDays: 7,
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from(xml) })
  })
  ok(plain.size === 1, 'plain (non-gzip) body parsed too')
}

// ---- D. scheduler: prefix + overrides resolution ----
console.log('D. prefix/override resolution')
{
  const puts = []
  const unmatched = []
  const guideStub = {
    config: { guideDays: 7 },
    resolveStreamId: (id) => (id === 'pa:known' ? 'stream-known' : null),
    noteUnmatched: (id, n) => unmatched.push(id),
    putDay: async (streamId, day, programs) => { puts.push(streamId); return 'put' }
  }
  const day = new Map([['2026-08-05', [{ title: 't', start: '2026-08-05T08:00:00.000Z', stop: '2026-08-05T09:00:00.000Z' }]]])
  const provider = {
    id: 'pa',
    prefix: 'pa:',
    overrides: { forced: 'stream-forced' },
    fetch: async () => new Map([['known', day], ['forced', day], ['mystery', day]])
  }
  const sched = new IngestScheduler(guideStub, [provider])
  const run = await sched.runProvider(provider)
  ok(run.ok && run.puts === 2 && run.unmatched === 1, 'two matched, one unmatched')
  ok(puts.includes('stream-known'), 'catalog match uses the prefixed id')
  ok(puts.includes('stream-forced'), 'override matches the raw source id')
  ok(unmatched[0] === 'pa:mystery', 'unmatched reported with prefix (copy-paste ready for epgId)')
  sched.close()
}

console.log(failures ? `\nRESULT: FAIL ❌  (${failures} failing checks)` : '\nRESULT: PASS ✅  (xmltv dates → parser tolerance → gzip/304 → prefix resolution)')
process.exit(failures ? 1 : 0)
