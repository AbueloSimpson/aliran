// @aliran/player-sdk — Node entry: wires node:http/node:fs/node:os into the
// runtime-agnostic core. Bare hosts (the app's worklet) import './player.js' directly and
// inject bare-http1/bare-fs/bare-os instead — this file must never enter a Bare bundle
// graph.

import http from 'http'
import fs from 'fs'
import os from 'os'
import { AliranPlayer } from './player.js'

export { AliranPlayer }
export { panelClient, login, checkSession, sessionLive } from './login.js'
export { isCorruptionError, withRecovery } from './recover.js'
// Pairing codes: turn the 12 characters a viewer typed into the operator's panel key.
export { resolvePairingCode, PairingError, PAIRING_ERRORS } from './pairing.js'
// Problem-report vocabulary for host UIs (categories, labels, the consent line, caps).
export { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, REPORT_TEXT_MAX, REPORT_EVENT_LIMIT, REPORT_EVENT_DETAIL_MAX, REPORT_COOLDOWN_MS, isReportCategory, reportCategoryLabel } from './report.js'

export function createPlayer (opts = {}) {
  // os is only read by startCast() (this device's LAN address) — see AliranPlayer.
  return new AliranPlayer({ http, fs, os, ...opts })
}
