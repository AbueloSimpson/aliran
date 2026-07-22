// Splash / device authorization (the reference's boot screen): brand surface,
// wordmark centered, a small "Authorizing device" status + spinner in the top-right
// corner. Auto-login with the saved (safeStorage-wrapped) credentials happens BEHIND
// this screen in the main process — login is the exception path, not the default.
// The transient-login retries live main-side, so the outcome here is simply
// 'streams' (→ the app routes on) or a final 'login-error' (→ Login).

import React, { useEffect } from 'react'
import { backend } from '../bridge'

export function SplashScreen ({ authorizing }: { authorizing: boolean }) {
  useEffect(() => {
    // Always ask: with no saved credentials main answers a final 'no saved
    // credentials' login-error and App routes to Login.
    backend.autoLogin()
  }, [])

  const name = backend.descriptor?.name ?? 'Aliran'
  const logo = backend.descriptor?.branding?.logo
  return (
    <div className="splash">
      <div className="splash-corner">
        <span>{authorizing ? 'Authorizing device' : 'Connecting'}</span>
        <span className="spinner spinner-dark" />
      </div>
      {logo ? <img className="splash-logo" src={logo} alt={name} /> : <div className="splash-wordmark">{name}</div>}
    </div>
  )
}
