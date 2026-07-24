// Docs as MCP resources. Every markdown file under docs/ + docs/kb/ becomes a
// resource (URI mcp://aliran/docs/<relpath>), so "help me operate this" answers come
// from the SHIPPED documentation, not model memory. A `docs_search` tool ranks the
// corpus by a query, and a top-level mcp://aliran/guide summarizes the tool catalog +
// the install happy-path.

import fs from 'fs'
import path from 'path'
import { z } from 'zod'

const DOC_SCHEME = 'mcp://aliran/docs/'
export const GUIDE_URI = 'mcp://aliran/guide'

// Read every *.md under docsDir (recursive). Missing dir → empty corpus (resources
// simply aren't registered; docs_search says so). Titles come from the first H1.
export function buildDocsIndex (docsDir) {
  const docs = []
  let names = []
  try { names = fs.readdirSync(docsDir, { recursive: true }) } catch { return { docsDir, docs, byUri: new Map() } }
  for (const rel of names) {
    const relPath = String(rel).split(path.sep).join('/')
    if (!relPath.endsWith('.md')) continue
    const abs = path.join(docsDir, rel)
    let text
    try {
      if (!fs.statSync(abs).isFile()) continue
      text = fs.readFileSync(abs, 'utf8')
    } catch { continue }
    docs.push({ relPath, uri: DOC_SCHEME + relPath, title: firstHeading(text) || relPath, text })
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath))
  const byUri = new Map(docs.map((d) => [d.uri, d]))
  return { docsDir, docs, byUri }
}

function firstHeading (text) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

// Common words that would just pull in every doc — dropped so the distinctive
// query terms decide the ranking.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'with', 'my', 'how', 'do', 'i', 'it', 'this', 'that'])

// Rank docs by query terms: title hits weigh 8×, the file path 5×, body 1×. Returns
// [{ uri, title, score, snippet }] for the top `limit`.
export function searchDocs (index, query, limit = 8) {
  let terms = String(query).toLowerCase().split(/\s+/).filter((t) => t && !STOP.has(t))
  if (!terms.length) terms = String(query).toLowerCase().split(/\s+/).filter(Boolean) // query was all stop-words
  if (!terms.length) return []
  const scored = []
  for (const d of index.docs) {
    const title = d.title.toLowerCase()
    const rel = d.relPath.toLowerCase()
    const body = d.text.toLowerCase()
    let score = 0
    for (const t of terms) {
      score += occurrences(title, t) * 8
      score += occurrences(rel, t) * 5
      score += occurrences(body, t)
    }
    if (score > 0) scored.push({ uri: d.uri, title: d.title, score, snippet: snippetFor(d.text, terms) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

function occurrences (hay, needle) {
  if (!needle) return 0
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length) }
  return n
}

function snippetFor (text, terms) {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i }
  if (at === -1) at = 0
  const start = Math.max(0, at - 60)
  return text.slice(start, start + 220).replace(/\s+/g, ' ').trim()
}

// The top-level guide: how the pieces fit + the install happy-path. Kept in sync
// with the tool catalog by construction (it names the groups, not every tool).
function guideMarkdown (index) {
  return `# Aliran MCP server — operator guide

This MCP server lets an AI client install, configure, maintain and support an Aliran
deployment. Secrets (panel/broadcaster admin passwords, the SSH key) live only in the
operator's local config file; you (the model) see only tool RESULTS.

## Tool catalog

- **panel_*** — the panel admin API (:3210): users, grants, channel packages
  (bouquets), streams, remote sources, categories, publishers, status/observability.
- **broadcaster_*** — the broadcaster control API (:3310): channels (create / start /
  stop / rotate), logs, capabilities probe, incidents, health. The control API is OFF
  unless CONTROL_ENABLED=1 — a tool that can't reach it says so.
- **server_*** — the SSH executor: preflight, install (the whole compose sequence),
  update (git pull → rebuild → up -d), status, logs, disk, backup, sysctl. Secrets
  minted during install are written into the box's .env server-side and are never
  returned to you.
- **diagnose_*** — a /healthz sweep across the configured services and a symptom → KB
  lookup.
- **docs_search** + the mcp://aliran/docs/* resources — the shipped documentation
  (${index.docs.length} files). Prefer these over memory for usage questions.

## Install happy-path (server_install)

1. \`git clone\` the repo into the box's install dir.
2. Copy \`panel/.env.example\` and \`broadcaster/.env.example\` to \`.env\`.
3. \`docker compose build\`.
4. \`admin-cli init\` — mints the panel signing/OPRF keys and prints the panel PUBLIC
   key + the PUBLISHER key (the publisher secret is written straight into the box's
   broadcaster .env; only the public key comes back to you).
5. \`add-admin\` for the panel AND the broadcaster (dashboard logins).
6. Write \`PANEL_PUBKEY\` / \`PUBLISHER_KEY\` / \`ADMIN_ENABLED=1\` / \`CONTROL_ENABLED=1\` /
   \`INPUT\` into the box's \`.env\` files.
7. \`docker compose up -d\`, then verify the logs.

## Updating (server_update)

\`git pull\` → \`nohup COMPOSE_BAKE=false docker compose build\` → plain
\`docker compose up -d\`. Never \`--force-recreate\` (it wedges the host-networked
broadcaster).
`
}

// Register the guide, every doc, and the docs_search tool on the McpServer.
export function registerDocs (server, index, { ok }) {
  server.registerResource(
    'aliran-guide',
    GUIDE_URI,
    { title: 'Aliran MCP guide', description: 'Tool catalog + the install happy-path.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guideMarkdown(index) }] })
  )

  for (const d of index.docs) {
    server.registerResource(
      'doc:' + d.relPath,
      d.uri,
      { title: d.title, description: `Aliran documentation: ${d.relPath}`, mimeType: 'text/markdown' },
      async (uri) => {
        const doc = index.byUri.get(uri.href) || d
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.text }] }
      }
    )
  }

  server.registerTool(
    'docs_search',
    {
      title: 'Search the Aliran docs',
      description: 'Full-text search across the shipped documentation (docs/ + docs/kb/). Returns the best-matching resource URIs with snippets; read a match with the resource for the full text.',
      inputSchema: { query: z.string().describe('what to look for, e.g. "publish the dashboards" or "feed rotation"'), limit: z.number().int().min(1).max(25).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ query, limit }) => {
      if (!index.docs.length) return ok({ query, matches: [], note: `no docs found at ${index.docsDir} — run the MCP server from a repo checkout, or set docsDir in the config` })
      const matches = searchDocs(index, query, limit || 8)
      return ok({ query, count: matches.length, matches })
    }
  )
}
