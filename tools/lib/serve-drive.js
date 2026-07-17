// HTTP handler that serves files from a Hyperdrive with Range support.
//
// Thin wrapper over the SDK's shared progressive serving core (sdk/serve.js) —
// one implementation for the desktop viewer (tools/viewer.js), the e2e harnesses,
// and the client's Bare worklet (via sdk/player.js). The core adds the zap-latency
// behaviors: block-progressive bodies (bytes stream as they replicate), a bounded
// availability wait before 404ing a not-yet-replicated media path, and live-edge
// read-ahead when a playlist is served. See sdk/serve.js for the full story.

import { createDriveHandler } from '../../sdk/serve.js'

// Returns an (req, res) handler bound to `drive`. Optionally maps a URL prefix (e.g.
// '/assets') to a second drive via `mounts` (mounted paths are ancillary content —
// a miss 404s immediately instead of holding the request open). Extra opts
// (waitMs, pollMs, readAhead) pass through to the serving core.
export function driveHandler (drive, { mounts = {}, ...opts } = {}) {
  return createDriveHandler((urlPath) => {
    for (const [prefix, d] of Object.entries(mounts)) {
      if (urlPath.startsWith(prefix)) return { drive: d, path: urlPath.slice(prefix.length) || '/', media: false }
    }
    return { drive, path: urlPath, media: true }
  }, opts)
}
