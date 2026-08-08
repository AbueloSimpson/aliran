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
import { useI18n } from '@aliran/i18n'
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
// The engine's code maps onto a CATALOG LEAF, never onto copy: the sentence is looked
// up at render (t('connect.error.' + …)), so a language change repaints an error that
// is already on screen. 'network' and 'timeout' share one leaf — from here they are
// the same event, "nothing answered".
const PAIR_ERROR_CODES: Record<string, string> = {
  malformed: 'malformed',
  timeout: 'timeout',
  network: 'timeout',
  // The dangerous one: something DID answer and could not prove it owns the code.
  unverified: 'unverified'
}

// The two things this screen can show: our own copy (a connect.error.* leaf) or the
// engine's message verbatim, which stays English by design (S56 — no error-code
// refactor in the SDK).
type Failure = { code: string } | { text: string }

// The intro is ONE sentence in the catalog, never assembled from translated fragments.
// Its three emphasised nouns arrive as {placeholders} — a translator can move them
// wherever the language needs them — and are re-wrapped in bold at render.
const INTRO_SLOTS = /(\{method\}|\{username\}|\{password\})/

export function ConnectScreen () {
  const { t } = useI18n()
  const [mode, setMode] = useState<'code' | 'key'>('code')
  const [groups, setGroups] = useState<string[]>(() => Array(GROUPS).fill(''))
  const [panelKey, setPanelKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'finding' | 'saving' | null>(null)
  const [error, setError] = useState<Failure | null>(null)
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
        setStatus('connecting')
        backend.login(creds.current.username, creds.current.password)
      }
      // 'streams' routes in App; a final login-error (bad key looks like
      // unreachable, bad credentials say so) lands back here.
      if (m.type === 'login-error') { setBusy(false); setStatus(null); setError({ text: m.message }) }
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
    setStatus('saving')
    setBusy(true)
    creds.current = { username, password }
    backend.setService(key, name)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!username || !password) { setError({ code: 'credentials' }); return }
    if (mode === 'key') {
      const key = panelKey.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(key)) { setError({ code: 'badKeyDesktop' }); return }
      start(key)
      return
    }
    const code = groups.join('')
    if (code.length !== GROUPS * GROUP_SIZE) { setError({ code: 'malformed' }); return }
    // Resolving is a DHT search plus one memory-hard verification, so it is slow
    // enough to need its own status line.
    setError(null)
    setStatus('finding')
    setBusy(true)
    const res = await backend.resolvePairing(code)
    if (!res.ok || !res.panelPubKey) {
      setBusy(false)
      setStatus(null)
      const known = PAIR_ERROR_CODES[res.error ?? '']
      setError(known ? { code: known } : res.message ? { text: res.message } : { code: 'timeout' })
      return
    }
    start(res.panelPubKey, res.name ?? undefined)
  }

  // What each intro placeholder renders as. Resolved every render, so the sentence
  // follows both the current mode and the current language.
  const slots: Record<string, string> = {
    '{method}': mode === 'code' ? t('connect.introCode') : t('connect.introKey'),
    '{username}': t('connect.introUsername'),
    '{password}': t('connect.introPassword')
  }

  return (
    <form className="login connect" onSubmit={submit}>
      <div className="login-title">Aliran</div>
      <div className="connect-intro">
        {t('connect.intro').split(INTRO_SLOTS).map((part, i) => (
          slots[part] ? <b key={i}>{slots[part]}</b> : part
        ))}
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
                aria-label={t('connect.groupAria', { n: i + 1, total: GROUPS })}
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
            placeholder={t('connect.keyPlaceholderDesktop')}
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
        {mode === 'code' ? t('connect.switchToKey') : t('connect.switchToCode')}
      </button>
      <input
        className="login-input"
        placeholder={t('common.username')}
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="login-input"
        placeholder={t('common.password')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="login-error">{'code' in error ? t('connect.error.' + error.code) : error.text}</div>}
      {status && !error && <div className="connect-status">{t('connect.status.' + status)}</div>}
      <button className="login-button" type="submit" disabled={busy}>
        {busy ? <span className="spinner" /> : t('connect.submit')}
      </button>
    </form>
  )
}
