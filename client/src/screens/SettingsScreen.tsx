// Settings — account, service info, live diagnostics (P2P source + peers + entitled
// channel count), and sign out. Sign out clears the saved "remember me" credentials
// (D1) so the next boot lands on Login instead of auto-authorizing. Public (keyless)
// builds additionally get "Change service…" (S36): forget the runtime-entered panel
// key + sign-in and go back to the Connect screen — never offered when the key is
// baked into the APK (operator flavor).
//
// "Report a problem" is NOT here (S51): it lives on the player (NowPlayingBar /
// channel info panel), because a useful report must carry the channel being watched.
//
// "Sign in a TV" IS here, and only on a phone: this is the device that holds the
// account, so it is the device that can hand it to a television without a password
// being typed on one (<SendSignInToTv>). A TV build never shows the row — it cannot
// send, by construction: the key material a send needs is only retained where
// worklet.ts asks for it (remote.sendToTv), which is everywhere except a television.
import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { SUPPORTED_LOCALES, useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { hasBakedKey, loadServiceDescriptor } from '../config'
import { appInfoCached, checkForUpdate } from '../update'
import { theme } from '../theme'
import { LanguageMenu } from '../components/LanguageMenu'
import { PinEntryModal, PinSetupModal } from '../components/PinModal'
import { SendSignInToTv } from '../components/SendSignInToTv'

const service = loadServiceDescriptor()

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>

// Parental modal state machine: set up a new PIN, change it, or verify the current
// one before a destructive/visibility change ('remove' / 'toggle').
type PinModalState = null | { kind: 'setup' } | { kind: 'change' } | { kind: 'verify'; then: 'remove' | 'toggle' }

// The outcome of a manual update check, held as a LEAF NAME (plus the version the
// 'available' line names) rather than as copy — the sentence is looked up at render,
// so a language change repaints a result that is already on the row.
type UpdateOutcome = { code: string; version?: string }

export function SettingsScreen ({ navigation }: Props) {
  const { t, locale } = useI18n()
  const [username, setUsername] = useState<string | null>(backend.creds?.username ?? null)
  const [channels, setChannels] = useState(backend.streams.length)
  const [source, setSource] = useState<'p2p' | 'cdn' | null>(backend.source)
  const [peers, setPeers] = useState<number | null>(null)
  const [signOutFocused, setSignOutFocused] = useState(false)
  const [changeFocused, setChangeFocused] = useState(false)
  // "Smooth zapping" (S21): user-facing switch for the engine's adjacent-channel
  // prefetch. null in prefs = never set -> the app default (off) applies.
  const [smoothZap, setSmoothZap] = useState<boolean>(backend.smoothZapping ?? false)
  // Parental controls (device policy — the worklet stores the PIN digest; the UI
  // only ever sees "a PIN exists" + the hide toggle).
  const [parental, setParental] = useState<{ hide: boolean } | null>(backend.parental)
  const [pinModal, setPinModal] = useState<PinModalState>(null)
  // UI language: the PINNED choice (null = follow the device) plus whether its picker
  // is open. What is actually being rendered right now is `locale`, above.
  const [language, setLanguage] = useState<string | null>(backend.language)
  const [languageMenu, setLanguageMenu] = useState(false)
  // "Sign in a TV": the sending half of the phone -> TV handover, as an overlay.
  const [sendToTv, setSendToTv] = useState(false)
  // OTA updates: the installed build's native version (null while resolving / no
  // installer module) + the manual check's one-line outcome.
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateOutcome | null>(null)

  useEffect(() => {
    let alive = true
    appInfoCached().then((info) => {
      if (alive && info) setAppVersion(`${info.versionName} (${info.versionCode})`)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Manual check (forced past the 6 h throttle). An 'available' verdict ALSO raises
  // the App-level update banner via update.ts's shared listener — the status line
  // here just says what happened in words.
  async function checkUpdates () {
    setUpdateStatus({ code: 'checking' })
    try {
      const res = await checkForUpdate({ force: true })
      if (res == null) setUpdateStatus({ code: hasBakedKey() || backend.service ? 'unsupported' : 'connectFirst' })
      else if (res.status === 'available') setUpdateStatus({ code: 'available', version: res.entry?.versionName ?? '' })
      else if (res.status === 'current' || res.status === 'none') setUpdateStatus({ code: 'current' })
      else setUpdateStatus({ code: 'failed' })
    } catch {
      setUpdateStatus({ code: 'failed' })
    }
  }

  useEffect(() => {
    backend.requestPrefs()
    return backend.onMessage((m) => {
      if (m.type === 'prefs') {
        setUsername(m.creds?.username ?? null)
        setSmoothZap(m.smoothZapping ?? false)
        setParental(m.parental ?? null)
        setLanguage(m.language ?? null)
      }
      if (m.type === 'streams') setChannels(m.streams.length)
      if (m.type === 'status' && typeof m.peers === 'number') setPeers(m.peers)
      if (m.type === 'port' && m.source) setSource(m.source)
      if (m.type === 'source-changed') setSource(m.source)
    })
  }, [])

  function toggleSmoothZap () {
    const next = !smoothZap
    setSmoothZap(next) // optimistic; the worklet's 'prefs' reply confirms
    backend.setZapPrefetch(next)
  }

  function signOut () {
    backend.clearCredentials()
    backend.streams = [] // drop the session's display list; a fresh login rebuilds it
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] })
  }

  // "Change service…" (public keyless flavor only): forget the runtime panel key AND
  // the sign-in (the credentials belong to that panel), then land on Connect. The
  // engine stays on the old panel until the next Connect submit — the worklet swaps
  // it wholesale when a different key arrives.
  function changeService () {
    backend.clearService()
    backend.clearCredentials()
    backend.streams = []
    navigation.reset({ index: 0, routes: [{ name: 'Connect' }] })
  }

  // The ScrollView sits inside a viewport-sized root ON PURPOSE. The LanguageMenu
  // overlay fills its parent absolutely; mounted inside the ScrollView it would fill
  // the SCROLLABLE CONTENT box — about twice the viewport on a phone — and centre
  // itself below the fold. Every other overlay in the app (SortMenu, TrackMenu) is a
  // sibling of the scrolling area for the same reason.
  return (
    <View style={styles.root}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.header}>{t('settings.header')}</Text>

        <Text style={styles.groupTitle}>{t('settings.group.account')}</Text>
        <View style={styles.group}>
          <Row label={t('settings.signedInAs')} value={username ?? '—'} />
          <Row label={t('settings.entitledChannels')} value={String(channels)} />
          {/* Phone only. On a television this row would offer something that build
              cannot do — and should not be able to do: SENDING is what makes a login
              hold the account's private keys for the whole session, so a TV asks for
              none of it (see worklet.ts). */}
          {!theme.isTV && (
            <PickerRow
              label={t('settings.sendTv')}
              value=""
              hint={t('settings.sendTvHint')}
              onPress={() => setSendToTv(true)}
            />
          )}
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.playback')}</Text>
        <View style={styles.group}>
          <ToggleRow
            label={t('settings.smoothZap')}
            hint={t('settings.smoothZapHint')}
            value={smoothZap}
            onToggle={toggleSmoothZap}
          />
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.language')}</Text>
        <View style={styles.group}>
          {/* The value line names the language the app is speaking right now: the pinned
              one, or the device's with the resolved language in parentheses — so a
              viewer whose device is set to a language we do not ship can see WHICH one
              they are getting instead. The parentheses are punctuation, not copy. */}
          <PickerRow
            label={t('settings.language')}
            value={language ? nativeName(language) : `${t('settings.language.device')} (${nativeName(locale)})`}
            hint={t('settings.language.hint')}
            onPress={() => setLanguageMenu(true)}
          />
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.parental')}</Text>
        <View style={styles.group}>
          {!parental && (
            <>
              <Row label={t('settings.pin')} value={t('settings.pinNotSet')} />
              <ActionRow label={t('settings.setPin')} onPress={() => setPinModal({ kind: 'setup' })} />
            </>
          )}
          {parental && (
            <>
              <ToggleRow
                label={t('settings.hideRestricted')}
                hint={t('settings.hideRestrictedHint')}
                value={parental.hide}
                onToggle={() => setPinModal({ kind: 'verify', then: 'toggle' })}
              />
              <ActionRow label={t('settings.changePin')} onPress={() => setPinModal({ kind: 'change' })} />
              <ActionRow label={t('settings.removePin')} onPress={() => setPinModal({ kind: 'verify', then: 'remove' })} danger />
            </>
          )}
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.service')}</Text>
        <View style={styles.group}>
          <Row label={t('settings.service')} value={(hasBakedKey() ? service.name : backend.service?.name) ?? service.name} />
          <Row label={t('settings.panelKey')} value={panelKeyLabel()} />
          <Row label={t('settings.playback')} value={service.hybrid?.mode ?? 'p2p-only'} />
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.updates')}</Text>
        <View style={styles.group}>
          <Row label={t('settings.appVersion')} value={appVersion ?? '—'} />
          <ActionRow label={t('settings.checkUpdates')} onPress={checkUpdates} />
          {updateStatus != null && <Row label={t('settings.result')} value={t('settings.update.' + updateStatus.code, { version: updateStatus.version ?? '' })} />}
        </View>

        <Text style={styles.groupTitle}>{t('settings.group.diagnostics')}</Text>
        <View style={styles.group}>
          <Row label={t('settings.activeSource')} value={source ? source.toUpperCase() : '—'} />
          <Row label={t('settings.peers')} value={peers != null ? String(peers) : '—'} />
        </View>

        {/* "Report a problem" moved to the player (S51): the report must carry the
            channel being watched, which Settings cannot know. */}

        <Pressable
          style={[styles.signOut, signOutFocused && styles.signOutFocused]}
          onFocus={() => setSignOutFocused(true)}
          onBlur={() => setSignOutFocused(false)}
          onPress={signOut}
        >
          <Text style={styles.signOutText}>{t('settings.signOut')}</Text>
        </Pressable>
        <Text style={styles.signOutHint}>{t('settings.signOutHint')}</Text>

        {!hasBakedKey() && (
          <>
            <Pressable
              style={[styles.changeService, changeFocused && styles.changeServiceFocused]}
              onFocus={() => setChangeFocused(true)}
              onBlur={() => setChangeFocused(false)}
              onPress={changeService}
            >
              <Text style={styles.signOutText}>{t('settings.changeService')}</Text>
            </Pressable>
            <Text style={styles.signOutHint}>{t('settings.changeServiceHint')}</Text>
          </>
        )}

        <PinSetupModal
          visible={pinModal?.kind === 'setup' || pinModal?.kind === 'change'}
          change={pinModal?.kind === 'change'}
          onDone={() => setPinModal(null)} // the worklet's 'prefs' reply updates `parental`
          onClose={() => setPinModal(null)}
        />
        <PinEntryModal
          visible={pinModal?.kind === 'verify'}
          title={pinModal?.kind === 'verify' && pinModal.then === 'remove' ? t('settings.removePinTitle') : t('settings.hideRestricted')}
          hint={pinModal?.kind === 'verify' && pinModal.then === 'remove'
            ? t('settings.removePinHint')
            : t('settings.hideRestrictedPinHint')}
          onOk={() => {
            if (pinModal?.kind === 'verify') {
              if (pinModal.then === 'remove') backend.parentalClear()
              else backend.parentalSetHide(!(parental?.hide ?? false))
            }
            setPinModal(null)
          }}
          onClose={() => setPinModal(null)}
        />
      </ScrollView>

      {/* An overlay, not a Modal: on TV a Modal is its own focus container and
          swallows the remote (the SortMenu/TrackMenu lesson). A SIBLING of the
          ScrollView, never a child — see the note above the return. */}
      {/* On close, take the choice from the backend's optimistic mirror rather than
          waiting for the worklet's 'prefs' reply — the row must not lag a round trip
          behind the language it is already rendering in. The reply confirms it. */}
      {languageMenu && <LanguageMenu value={language} onClose={() => { setLanguage(backend.language); setLanguageMenu(false) }} />}
      {/* Same rule, same reason: a sibling of the ScrollView, never a child. */}
      {sendToTv && <SendSignInToTv onClose={() => setSendToTv(false)} />}
    </View>
  )
}

// A language's name in its own language — never translated (see LanguageMenu). Falls
// back to the raw code, which only a pref written by a newer build could produce.
function nativeName (code: string): string {
  return SUPPORTED_LOCALES.find((l) => l.code === code)?.nativeName ?? code
}

// Focusable one-line action button rendered as a settings row (phone tap + TV d-pad).
function ActionRow ({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.actionRow, focused && styles.actionRowFocused]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.actionRowText, danger && styles.actionRowDanger]}>{label}</Text>
    </Pressable>
  )
}

// The service's panel key, truncated for the row: the baked key when the build ships
// one, else the runtime-entered service's key ('—' before the first Connect).
function panelKeyLabel (): string {
  const key = hasBakedKey() ? service.panelPubKey : backend.service?.panelPubKey
  return key ? key.slice(0, 16) + '…' : '—'
}

// A settings row that opens a picker: reads like Row, focuses like ActionRow, and
// carries the same hint line a ToggleRow does.
function PickerRow ({ label, value, hint, onPress }: { label: string; value: string; hint: string; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.toggleRow, focused && styles.toggleRowFocused]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <View style={styles.toggleTexts}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </Pressable>
  )
}

function Row ({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  )
}

// Focusable settings switch (phone tap + TV d-pad select). Rendered as a pill so the
// state reads at TV distance; the hint explains the data cost per the S21 brief.
function ToggleRow ({ label, hint, value, onToggle }: { label: string; hint: string; value: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.toggleRow, focused && styles.toggleRowFocused]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <View style={styles.toggleTexts}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <View style={[styles.togglePill, value && styles.togglePillOn]}>
        <Text style={[styles.togglePillText, value && styles.togglePillTextOn]}>{value ? t('common.on') : t('common.off')}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.safeX, paddingVertical: theme.safeY, maxWidth: 720, alignSelf: 'stretch' },
  header: { color: theme.colors.textDim, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1.5) },
  groupTitle: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginTop: theme.spacing(1.5), marginBottom: 6 },
  group: { backgroundColor: theme.colors.surface, borderRadius: 10, paddingHorizontal: theme.spacing(1.5), paddingVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: theme.isTV ? 12 : 10, gap: 16 },
  rowLabel: { color: theme.colors.textDim, fontSize: theme.type.body },
  rowValue: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '600', flexShrink: 1 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingVertical: theme.isTV ? 12 : 10, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  toggleRowFocused: { borderColor: theme.colors.focus },
  toggleTexts: { flex: 1, gap: 4 },
  toggleHint: { color: theme.colors.textDim, fontSize: theme.type.caption, lineHeight: 18 },
  togglePill: {
    minWidth: 64, alignItems: 'center', borderRadius: 999,
    paddingVertical: 6, paddingHorizontal: 14, backgroundColor: theme.colors.background
  },
  togglePillOn: { backgroundColor: theme.colors.focus },
  togglePillText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },
  togglePillTextOn: { color: theme.colors.background },
  signOut: {
    marginTop: theme.spacing(2.5), backgroundColor: theme.colors.surface, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', borderWidth: Math.max(theme.focusRing, 1), borderColor: theme.colors.live
  },
  signOutFocused: { backgroundColor: theme.colors.live, borderColor: theme.colors.focus },
  signOutText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  signOutHint: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 8 },
  changeService: {
    marginTop: theme.spacing(2), backgroundColor: theme.colors.surface, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  changeServiceFocused: { borderColor: theme.colors.focus, backgroundColor: theme.colors.background },
  actionRow: {
    paddingVertical: theme.isTV ? 12 : 10, borderRadius: 8,
    borderWidth: Math.max(theme.focusRing, 1), borderColor: 'transparent'
  },
  actionRowFocused: { borderColor: theme.colors.focus },
  actionRowText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  actionRowDanger: { color: theme.colors.live }
})
