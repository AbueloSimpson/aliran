// OTA update banner (bottom overlay, phone tap + TV d-pad). Shown by App when a
// check finds a newer build; walks offer → download (progress) → "Install now" →
// the OS installer handoff. The MANDATORY variant (build below minVersionCode) is
// more prominent and cannot be dismissed — but never blocks playback (v1 policy).
//
// Download default is unmetered networks only — same signals the upload policy
// uses (S25: isConnectionExpensive OR cellular counts as metered) — with an
// explicit "Download anyway" override. Strings follow ASD-STE100.

import React, { useEffect, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { canRequestInstall, installApk, onInstallResult, openInstallSettings, type UpdateEntry } from '@aliran/react-native'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { theme } from '../theme'

// Same guarded require as App.tsx: a build without the NetInfo native module (or
// jest) just never reports a metered network, so the default download path opens.
let NetInfo: { addEventListener: (fn: (s: any) => void) => () => void } | null = null
try { NetInfo = require('@react-native-community/netinfo').default } catch { NetInfo = null }

export interface UpdateBannerProps {
  entry: UpdateEntry
  mandatory: boolean
  /** Hide the banner (non-mandatory only — the mandatory variant renders no way to). */
  onDismiss: () => void
}

type Phase = 'offer' | 'downloading' | 'ready' | 'installing' | 'error'

// What went wrong: our own line (update.installFailed) or the message the worklet or
// the OS installer handed us, which stays verbatim — engine and platform prose is not
// translated (S56).
type Failure = { installFailed: true } | { text: string }

export function UpdateBanner ({ entry, mandatory, onDismiss }: UpdateBannerProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('offer')
  const [progress, setProgress] = useState(0) // 0..1
  const [readyPath, setReadyPath] = useState<string | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [metered, setMetered] = useState(false)
  const [needsPermission, setNeedsPermission] = useState(false)

  useEffect(() => backend.onUpdate((m) => {
    if (m.type === 'update-progress') {
      setPhase('downloading')
      setProgress(m.total > 0 ? Math.min(1, m.received / m.total) : 0)
    }
    if (m.type === 'update-ready') { setReadyPath(m.path); setPhase('ready') }
    if (m.type === 'update-error') { setError({ text: m.message }); setPhase('error') }
  }), [])

  useEffect(() => {
    if (!NetInfo) return
    let off: (() => void) | undefined
    try {
      off = NetInfo.addEventListener((s) => setMetered(!!s?.details?.isConnectionExpensive || s?.type === 'cellular'))
    } catch { /* module absent — treated as unmetered */ }
    return () => { if (off) off() }
  }, [])

  function startDownload () {
    setError(null)
    setProgress(0)
    setPhase('downloading')
    backend.downloadUpdate() // progress/outcome arrive on the onUpdate feed above
  }

  async function install () {
    if (!readyPath) return
    // Install-permission gate: without it the PackageInstaller session would fail
    // silently on some devices. Send the viewer to the per-app setting; the button
    // stays "Install now" so the retry after granting is the same press.
    if (!(await canRequestInstall())) {
      setNeedsPermission(true)
      await openInstallSettings()
      return
    }
    setNeedsPermission(false)
    setPhase('installing')
    try {
      await installApk(readyPath) // resolves at OS-installer handoff
    } catch (e) {
      setError({ text: String((e as Error)?.message || e) })
      setPhase('error')
    }
  }

  // The handoff is not the outcome: the OS reports the terminal verdict later
  // (e.g. a signature refusal AFTER the viewer confirms). Without this listener
  // the banner waits on "Starting the installer…" forever (found on-device).
  // A success needs no handling — the update replaces the process.
  useEffect(() => {
    const off = onInstallResult((r) => {
      if (!r.success) {
        setError(r.message ? { text: r.message } : { installFailed: true })
        setPhase('error')
      }
    })
    return off
  }, [])

  const sizeMb = entry.size > 0 ? Math.max(1, Math.round(entry.size / 1048576)) : null

  return (
    <View style={[styles.banner, mandatory && styles.bannerMandatory]}>
      <Text style={styles.title}>{mandatory ? t('update.requiredTitle') : t('update.availableTitle')}</Text>
      <Text style={styles.body}>
        {sizeMb
          ? t('update.newVersionSized', { version: entry.versionName, size: sizeMb })
          : t('update.newVersion', { version: entry.versionName })}
      </Text>
      {mandatory && <Text style={styles.body}>{t('update.mustInstall')}</Text>}
      {!!entry.notes && <Text style={styles.notes} numberOfLines={3}>{entry.notes}</Text>}

      {phase === 'offer' && metered && (
        <Text style={styles.body}>{t('update.metered')}</Text>
      )}
      {phase === 'downloading' && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      )}
      {phase === 'downloading' && (
        <Text style={styles.body}>{t('update.downloading', { percent: Math.round(progress * 100) })}</Text>
      )}
      {phase === 'installing' && <Text style={styles.body}>{t('update.installing')}</Text>}
      {phase === 'ready' && needsPermission && (
        <Text style={styles.body}>{t('update.permission')}</Text>
      )}
      {phase === 'error' && !!error && <Text style={styles.error} numberOfLines={2}>{'text' in error ? error.text : t('update.installFailed')}</Text>}

      <View style={styles.buttons}>
        {phase === 'offer' && !metered && (
          <BannerButton label={t('update.download')} primary onPress={startDownload} />
        )}
        {phase === 'offer' && metered && (
          <BannerButton label={t('update.downloadAnyway')} primary onPress={startDownload} />
        )}
        {(phase === 'ready' || phase === 'installing') && (
          <BannerButton label={t('update.installNow')} primary disabled={phase === 'installing'} onPress={install} />
        )}
        {phase === 'error' && (
          <BannerButton label={t('common.tryAgain')} primary onPress={readyPath ? install : startDownload} />
        )}
        {!mandatory && phase !== 'installing' && (
          <BannerButton label={t('update.later')} onPress={onDismiss} />
        )}
      </View>
    </View>
  )
}

function BannerButton ({ label, primary, disabled, onPress }: {
  label: string
  primary?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[
        styles.button,
        primary && styles.buttonPrimary,
        focused && styles.buttonFocused,
        disabled && styles.buttonDisabled
      ]}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: theme.safeX,
    right: theme.safeX,
    bottom: theme.safeY,
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    padding: theme.spacing(1.5),
    gap: 6,
    elevation: 8
  },
  bannerMandatory: {
    borderWidth: 2,
    borderColor: theme.colors.live
  },
  title: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800' },
  body: { color: theme.colors.text, fontSize: theme.type.body },
  notes: { color: theme.colors.textDim, fontSize: theme.type.caption },
  error: { color: theme.colors.live, fontSize: theme.type.body },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.background,
    overflow: 'hidden',
    marginTop: 4
  },
  progressFill: { height: '100%', backgroundColor: theme.colors.primary },
  buttons: { flexDirection: 'row', gap: 12, marginTop: theme.spacing(1) },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: theme.colors.background,
    borderWidth: Math.max(theme.focusRing, 1),
    borderColor: 'transparent'
  },
  buttonPrimary: { backgroundColor: theme.colors.primary },
  buttonFocused: { borderColor: theme.colors.focus },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  buttonTextPrimary: { color: theme.colors.onPrimary }
})
