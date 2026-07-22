// Login — the EXCEPTION path since the redesign: Splash auto-authorizes with saved
// credentials and only lands here when there are none (first run / after sign out)
// or they stopped working. Username + password → main-process OPRF login (no
// plaintext leaves the machine; transient swarm-dialing retries live main-side).
// On success main wraps the credentials with safeStorage so the next boot
// authorizes automatically; sign out (Settings) clears them.

import React, { useEffect, useRef, useState } from 'react'
import { backend } from '../bridge'

export function LoginScreen () {
  const dev = backend.descriptor?.dev
  const [username, setUsername] = useState(backend.creds?.username ?? dev?.username ?? '')
  const [password, setPassword] = useState(dev?.password ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const userRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    userRef.current?.focus()
    return backend.onMessage((m) => {
      // 'streams' routes in App; a final login-error lands back here.
      if (m.type === 'login-error') { setBusy(false); setError(m.message) }
    })
  }, [])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !username || !password) return
    setError(null)
    setBusy(true)
    backend.login(username, password)
  }

  return (
    <form className="login" onSubmit={submit}>
      <div className="login-title">{backend.descriptor?.name ?? 'Aliran'}</div>
      <input
        ref={userRef}
        className="login-input"
        placeholder="Username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="login-input"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="login-error">{error}</div>}
      <button className="login-button" type="submit" disabled={busy}>
        {busy ? <span className="spinner" /> : 'Sign in'}
      </button>
    </form>
  )
}
