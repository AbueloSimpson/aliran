// Connect — the public build's first-run screen (no descriptor baked into the
// artifact): the viewer identifies their operator's service, adds their account, and
// the app does the rest — persist the key (userData), boot the engine on it, then run
// the normal OPRF login. One screen, because that's the whole onboarding contract of
// the platform: no URLs, no ports — discovery is the DHT, identity is the key.
// Operator builds never show this: their descriptor ships in the artifact.
//
// TWO WAYS TO NAME THE SERVICE, one outcome. The default is the 12-character SERVICE
// PAIRING CODE ('A3K7-9QF2-M4XR'), typed in three groups of four that advance
// themselves — the panel key is 64 hex characters, which nobody should have to type or
// read aloud. Main resolves the code over the DHT and VERIFIES the answer by
// re-deriving the code from the key it receives, so a wrong service cannot be
// substituted for the right one (sdk/pairing.js). The 64-hex field stays one click
// away for anyone who was given a key instead.

import React, { useEffect, useRef, useState } from 'react'
import { backend } from '../bridge'

const GROUPS = 3
const GROUP_SIZE = 4

// Keep typing to characters Crockford base32 actually has, and fold the confusable
// ones the way it decodes them — a viewer reading a printed card types O for 0 and I
// for 1, and should see the right character appear. Main re-normalizes and verifies;
// this only decides what the field accepts.
function cleanCode (s: string): string {
  return s.toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9ABCDEFGHJKMNPQRSTVWXYZ]/g, '')
}

// A pairing code that failed is never a "try again" — each reason has its own fix.
const PAIR_ERRORS: Record<string, string> = {
  malformed: 'That code is not complete. It has 12 characters, like A3K7-9QF2-M4XR.',
  timeout: 'No service answered that code. Check the code, and check your connection.',
  network: 'No service answered that code. Check the code, and check your connection.',
  // The dangerous one: something DID answer and could not prove it owns the code.
  unverified: 'A service answered that code but could not prove it owns it. Ask your operator for the code again.'
}

export function ConnectScreen () {
  const [mode, setMode] = useState<'code' | 'key'>('code')
  const [groups, setGroups] = useState<string[]>(() => Array(GROUPS).fill(''))
  const [panelKey, setPanelKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef<HTMLInputElement | null>(null)
  const groupRefs = useRef<Array<HTMLInputElement | null>>([])
  const creds = useRef({ username: '', password: '' })

  useEffect(() => {
    (mode === 'code' ? groupRefs.current[0] : keyRef.current)?.focus()
  }, [mode])

  useEffect(() => {
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

  // A group fills up -> jump to the next one. Deleting into an empty group jumps back.
  // The viewer types 12 characters and never touches focus.
  const onGroupChange = (i: number, raw: string) => {
    const v = cleanCode(raw).slice(0, GROUP_SIZE)
    setGroups((prev) => prev.map((g, j) => (j === i ? v : g)))
    if (v.length === GROUP_SIZE && i < GROUPS - 1) groupRefs.current[i + 1]?.focus()
  }

  const onGroupKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !groups[i] && i > 0) groupRefs.current[i - 1]?.focus()
  }

  // A pasted whole code lands in whichever box has focus — spread it across all three
  // rather than truncating it to four characters.
  const onGroupPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = cleanCode(e.clipboardData.getData('text'))
    if (text.length <= GROUP_SIZE) return // ordinary paste — let the field handle it
    e.preventDefault()
    const next = [...groups]
    for (let j = i; j < GROUPS; j++) next[j] = text.slice((j - i) * GROUP_SIZE, (j - i + 1) * GROUP_SIZE)
    setGroups(next)
    groupRefs.current[GROUPS - 1]?.focus()
  }

  // Both entry paths end here: one panel key, then the ordinary set-service -> boot ->
  // login sequence.
  const start = (key: string, name?: string) => {
    setError(null)
    setStatus('Saving service…')
    setBusy(true)
    creds.current = { username, password }
    backend.setService(key, name)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!username || !password) { setError('Enter your username and password.'); return }
    if (mode === 'key') {
      const key = panelKey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(key)) { setError('The panel key should be 64 hex characters — ask your operator for it.'); return }
      start(key)
      return
    }
    const code = groups.join('')
    if (code.length !== GROUPS * GROUP_SIZE) { setError(PAIR_ERRORS.malformed); return }
    // Resolving is a DHT search plus one memory-hard verification, so it is slow
    // enough to need its own status line.
    setError(null)
    setStatus('Finding the service…')
    setBusy(true)
    const res = await backend.resolvePairing(code)
    if (!res.ok || !res.panelPubKey) {
      setBusy(false)
      setStatus(null)
      setError(PAIR_ERRORS[res.error ?? ''] ?? res.message ?? PAIR_ERRORS.timeout)
      return
    }
    start(res.panelPubKey, res.name ?? undefined)
  }

  return (
    <form className="login connect" onSubmit={submit}>
      <div className="login-title">Aliran</div>
      <div className="connect-intro">
        Connect to your operator's service. You need the three things they gave
        you: the <b>{mode === 'code' ? 'pairing code' : 'panel key'}</b>, a <b>username</b> and
        a <b>password</b>. No URLs — the app finds the service over the peer-to-peer network.
      </div>
      {mode === 'code'
        ? (
          <div className="pair-groups">
            {groups.map((g, i) => (
              <input
                key={i}
                ref={(r) => { groupRefs.current[i] = r }}
                className="login-input pair-group"
                placeholder="––––"
                aria-label={`Pairing code, group ${i + 1} of ${GROUPS}`}
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={GROUP_SIZE}
                value={g}
                onChange={(e) => onGroupChange(i, e.target.value)}
                onKeyDown={(e) => onGroupKeyDown(i, e)}
                onPaste={(e) => onGroupPaste(i, e)}
              />
            ))}
          </div>
          )
        : (
          <input
            ref={keyRef}
            className="login-input connect-key"
            placeholder="Panel public key (64 hex characters)"
            autoCapitalize="none"
            spellCheck={false}
            value={panelKey}
            onChange={(e) => setPanelKey(e.target.value)}
          />
          )}
      <button
        className="connect-switch"
        type="button"
        onClick={() => { setError(null); setMode((m) => (m === 'code' ? 'key' : 'code')) }}
      >
        {mode === 'code' ? 'Enter the 64-character panel key instead' : 'Enter the 12-character pairing code instead'}
      </button>
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
