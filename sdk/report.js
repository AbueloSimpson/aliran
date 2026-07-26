// Viewer problem reports — the CLIENT half (S50c).
//
// A viewer hits "Report a problem", picks one of a closed set of categories, optionally
// types a sentence, and the engine sends it to the panel over the EXISTING P2P RPC
// socket (`report`, beside login/session). This file holds the parts a UI needs — the
// category enum, its display labels, the consent line, and the caps/cooldown the
// engine enforces — so a host app never has to hard-code them.
//
// THE DRIFT RULE: REPORT_CATEGORIES is a DUPLICATE of panel/src/reports.js's copy.
// The two live in different runtimes (the panel must not import the sdk, and the sdk
// must not import the panel), so the repo convention is duplicate-and-assert: the e2e
// drift guard in tools/e2e-reports-test.mjs imports BOTH and requires deep equality.
// Add a category here and there in the same commit, or test:reports fails.
//
// PSEUDONYMITY: the report carries the session TOKEN, never a username. The panel
// verifies the token and immediately reduces the identity to an HMAC pseudonym (see
// panel/src/reports.js). What actually leaves the device is what REPORT_CONSENT says
// — category, free text, the channel, app version + platform, the peer count and the
// engine's recent event breadcrumbs. Nothing else. Show the consent line in the UI.

// The closed category enum. Unknown values are REJECTED by the panel (never coerced
// to 'other'), and the engine rejects them locally before they reach the wire.
export const REPORT_CATEGORIES = [
  'no-audio',
  'black-screen',
  'visual-artifacts',
  'buffering',
  'wrong-content',
  'login',
  'other'
]

// Viewer-facing labels. Deliberately symptom-shaped ("what you saw"), not
// cause-shaped — a viewer cannot tell a decoder fault from a dead upstream, and a
// label that asks them to diagnose produces worse data than one that asks them to
// describe. Hosts are free to translate these; the WIRE value is the enum string.
export const REPORT_CATEGORY_LABELS = {
  'no-audio': 'No sound',
  'black-screen': 'Black screen / nothing plays',
  'visual-artifacts': 'Broken or glitchy picture',
  buffering: 'Keeps buffering or freezing',
  'wrong-content': 'Wrong programme on this channel',
  login: 'Trouble signing in',
  other: 'Something else'
}

// The consent line (S50-DESIGN D1). Shown VERBATIM in the report UI, above the
// submit control — it is the viewer's only view of what the report contains, so it
// must stay an exhaustive, plain-language list, and it must keep the closing promise
// about the account name (which the protocol structurally guarantees).
export const REPORT_CONSENT =
  'Sent with your report: the problem you picked, anything you type, the channel you were ' +
  'watching, your app version and device type, how many peers you were connected to, and the ' +
  "last few things the player did. Your account name and password are never sent."

// Free-text cap. The panel enforces its own copy of this (a client cannot bypass it);
// mirrored here so the UI can show a live counter instead of silently truncating.
export const REPORT_TEXT_MAX = 300

// How many engine breadcrumbs ride along with a report, and how long each may be.
// The ring is rolling: the newest REPORT_EVENT_LIMIT events win.
export const REPORT_EVENT_LIMIT = 50
export const REPORT_EVENT_DETAIL_MAX = 200

// Local (client-side) cooldown per channel+category — flood-control layer 1
// (S50-DESIGN D2). Mashing the button after a real outage never reaches the wire; a
// panel reply carrying its own `cooldown` seconds overrides this for that key.
export const REPORT_COOLDOWN_MS = 600000

/** Whether a value is one of the seven wire categories. */
export function isReportCategory (v) {
  return typeof v === 'string' && REPORT_CATEGORIES.includes(v)
}

/** Display label for a category (falls back to the raw value for forward-compat). */
export function reportCategoryLabel (v) {
  return REPORT_CATEGORY_LABELS[v] || String(v)
}
