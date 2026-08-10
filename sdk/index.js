// @aliran/player-sdk — Node entry: wires node:http/node:fs into the runtime-agnostic
// core. Bare hosts (the app's worklet) import './player.js' directly and inject
// bare-http1/bare-fs instead — this file must never enter a Bare bundle graph.

import http from 'http'
import fs from 'fs'
import { AliranPlayer } from './player.js'

export { AliranPlayer }
export { panelClient, login, loginWithKeys, checkSession, sessionLive } from './login.js'
export { isCorruptionError, withRecovery } from './recover.js'
// Pairing codes: turn the 12 characters a viewer typed into the operator's panel key.
export { resolvePairingCode, PairingError, PAIRING_ERRORS } from './pairing.js'
// Phone -> TV sign-in handover. The engine methods (startSignInPairing / sendSignIn) are
// the ordinary way in; these are for hosts driving the protocol themselves.
export { receiveSignIn, sendSignIn, normalizeSigninPayload, SigninPairError, SIGNIN_PAIR_ERRORS, SIGNIN_PAIR_STATES } from './signin-pair.js'
// "Play on my TV": the rendezvous two already-signed-in devices of one account meet on, and
// the control channel over it. The engine methods (startRemote / remotePlay / …) are the
// ordinary way in; these are for hosts driving the rendezvous themselves.
export {
  startRemoteControl, normalizeRemoteIdentity, RemoteControlError,
  REMOTE_CONTROL_ERRORS, REMOTE_CONTROL_ROLES, REMOTE_STATUS_STATES, REMOTE_EPOCH_MS, REMOTE_PROTOCOL
} from './remote-control.js'
// Problem-report vocabulary for host UIs (categories, labels, the consent line, caps).
export { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, REPORT_TEXT_MAX, REPORT_EVENT_LIMIT, REPORT_EVENT_DETAIL_MAX, REPORT_COOLDOWN_MS, isReportCategory, reportCategoryLabel } from './report.js'

export function createPlayer (opts = {}) {
  return new AliranPlayer({ http, fs, ...opts })
}
