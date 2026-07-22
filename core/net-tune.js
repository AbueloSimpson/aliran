// Swarm UDP socket tuning — the Node-side entry.
//
// NOT re-exported from index.js on purpose: this module binds node:fs (for the /proc
// ceiling read) and is what the SERVER components import by path:
//   import { tuneSwarm, logSwarmTuning } from '@aliran/core/net-tune.js'
//
// All the logic — and the full design rationale (udx multiplexing, the silent
// setsockopt clamp, the Linux read-back doubling trap) — lives in `net-tune-core.js`,
// which has no imports at all so the viewer engine (sdk/player.js) can bundle it into
// the Bare worklet and pass its injected fs instead. This file only adds the node:fs
// default; keep any future fs-free logic in the core file.

import fs from 'fs'
import {
  readKernelCeilings as readKernelCeilingsCore,
  tuneSwarm as tuneSwarmCore
} from './net-tune-core.js'

export {
  DEFAULT_BUFFER_BYTES, SYSCTL_KEYS,
  evaluateBuffer, tuneSocket, tuningMessages, logSwarmTuning, _resetTuningLog
} from './net-tune-core.js'

const readProc = (p) => fs.readFileSync(p, 'utf8')

export function readKernelCeilings (readFile = readProc) {
  return readKernelCeilingsCore(readFile)
}

export function tuneSwarm (swarm, opts = {}) {
  return tuneSwarmCore(swarm, { readFile: readProc, ...opts })
}
