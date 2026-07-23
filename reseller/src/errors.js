// Error classes for the reseller panel. ControlError mirrors the class the other
// deployables carry (library/src/titles.js owns it there); the reseller adds two
// codes of its own — `forbidden` (403: capability/scope denial) and
// `insufficient-credits` (402: a debit would take the actor's balance below zero).
// PanelError wraps failures of the downstream panel admin API so the control server
// can pass the panel's own status through (and 502 when it is unreachable): the
// message is prefixed `PANEL:` so a reseller reading the error knows which side said no.

export class ControlError extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

export class PanelError extends Error {
  constructor (code, message, httpStatus = 502) {
    super(message.startsWith('PANEL') ? message : `PANEL: ${message}`)
    this.code = code
    this.httpStatus = httpStatus
  }
}
