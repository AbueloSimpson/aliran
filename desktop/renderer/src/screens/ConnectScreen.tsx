// Connect — the public build's first-run screen (no descriptor baked into the
// artifact): the viewer enters their operator's PANEL PUBLIC KEY plus their
// account, and the app does the rest — persist the key (userData), boot the
// engine on it, then run the normal OPRF login. One screen, because that's the
// whole onboarding contract of the platform: no URLs, no ports — discovery is the
// DHT, identity is the key (the operator hands all three values to their viewer).
// Operator builds never show this: their descriptor ships in the artifact.

import React, { useEffect, useRef, useState } from 'react'
import { backend } from '../bridge'

export function ConnectScreen () {
  const [panelKey, setPanelKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)
  const creds = useRef({ username: '', password: '' })

  useEffect(() => {
    keyRef.current?.focus()
    return backend.onMessage((m) => {
      // Key accepted + engine booting: hand the credentials over. The main-process
      // login already retries the whole swarm-dialing window, so this is one shot.
      if (m.type === 'service') {
        setStatus('Connecting to the service…')
        backend.login(creds.current.username, creds.current.password)
      }
      // 'streams' routes in App; a final login-error (bad key looks like
      // unreachable, bad credentials say so) lands back here.
      if (m.type === 'login-error') { setBusy(false); setStatus(null); setError(m.message) }
    })
  }, [])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const key = panelKey.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(key)) { setError('The panel key should be 64 hex characters — ask your operator for it.'); return }
    if (!username || !password) { setError('Enter your username and password.'); return }
    setError(null)
    setStatus('Saving service…')
    setBusy(true)
    creds.current = { username, password }
    backend.setService(key)
  }

  return (
    <form className="login connect" onSubmit={submit}>
      <div className="login-title">Aliran</div>
      <div className="connect-intro">
        Connect to your operator's service. You need the three things they gave
        you: the <b>panel key</b>, a <b>username</b> and a <b>password</b>.
        No URLs — the service is found over the peer-to-peer network.
      </div>
      <input
        ref={keyRef}
        className="login-input connect-key"
        placeholder="Panel public key (64 hex characters)"
        autoCapitalize="none"
        spellCheck={false}
        value={panelKey}
        onChange={(e) => setPanelKey(e.target.value)}
      />
      <input
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
      {status && !error && <div className="connect-status">{status}</div>}
      <button className="login-button" type="submit" disabled={busy}>
        {busy ? <span className="spinner" /> : 'Connect'}
      </button>
    </form>
  )
}
