// Viewer problem reports — the React Native vocabulary (S50c).
//
// The RN binding cannot import sdk/report.js: the engine lives in a Bare worklet that
// Metro never resolves into, and this package deliberately has no dependency on
// @aliran/player-sdk. So this is the RN-side copy of the same closed enum, under the
// repo's duplicate-and-assert convention — the e2e drift guard in
// tools/e2e-reports-test.mjs reads THIS FILE, sdk/report.js and panel/src/reports.js
// and requires all three to be deep-equal. Change one, change all three.
//
// The wire value is the enum string; labels are display-only and translatable.

export type ReportCategory =
  | 'no-audio'
  | 'black-screen'
  | 'visual-artifacts'
  | 'buffering'
  | 'wrong-content'
  | 'login'
  | 'other'

/** Error codes a 'report-result' may carry (see AliranPlayer.report()). */
export type ReportError =
  | 'bad-category'
  | 'not-logged-in'
  | 'offline'
  | 'cooldown'
  | 'locked'
  | 'unsupported'
  | 'unauthorized'
  | 'expired'

export const REPORT_CATEGORIES: ReportCategory[] = [
  'no-audio',
  'black-screen',
  'visual-artifacts',
  'buffering',
  'wrong-content',
  'login',
  'other'
]

// Symptom-shaped, not cause-shaped: a viewer cannot tell a decoder fault from a dead
// upstream, and a label that asks them to diagnose produces worse data.
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  'no-audio': 'No sound',
  'black-screen': 'Black screen / nothing plays',
  'visual-artifacts': 'Broken or glitchy picture',
  buffering: 'Keeps buffering or freezing',
  'wrong-content': 'Wrong programme on this channel',
  login: 'Trouble signing in',
  other: 'Something else'
}

// Shown VERBATIM above the submit control (S50-DESIGN D1): the viewer's only view of
// what a report contains. Keep it exhaustive and plain — and keep the closing promise
// about the account name, which the protocol structurally guarantees (the report
// carries a session token the panel immediately reduces to an HMAC pseudonym).
export const REPORT_CONSENT =
  'Sent with your report: the problem you picked, anything you type, the channel you were ' +
  'watching, your app version and device type, how many peers you were connected to, and the ' +
  'last few things the player did. Your account name and password are never sent.'

/** Free-text cap (characters) — the panel enforces its own copy of this. */
export const REPORT_TEXT_MAX = 300
