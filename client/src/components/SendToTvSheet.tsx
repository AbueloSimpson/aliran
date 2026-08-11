// "Play on a TV" — the device picker (PHONE ONLY; see the gate in NowPlayingBar).
//
// ONE SHEET, TWO SECTIONS, AND THE SECTIONS ARE THE POINT. A viewer who has never heard
// of either mechanism has to leave this sheet knowing what they chose, so the two kinds
// of target are never mixed into one list and each section carries one plain sentence
// about what happens to THIS PHONE if you pick from it:
//
//   Your devices   the television plays the channel itself; this phone is then free.
//   Cast devices   this phone sends the channel to the television; it must stay on.
//
// "Your devices" is FIRST because it is better on every axis a viewer would care about —
// full quality off the swarm, no battery on this phone, nothing served from here — and
// list order is the only way to say "prefer this" without a paragraph nobody reads.
//
// THE WARNING IS NOT A FOOTNOTE. While this phone casts, the channel is reachable by
// anything on the network that can read the media URL off the television — measured, not
// theorised. When the app knows the television's address it tells the engine to serve
// that address ONLY, and the active card says so; when it cannot (a speaker group, or a
// platform that would not say) the card says THAT instead. There is no state where the
// sheet is silent about which one is true.
//
// Portrait AND landscape: the phone app is no longer landscape-locked, so the panel is
// height-capped with its body in a ScrollView rather than laid out for one shape.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { useI18n } from '@aliran/i18n'
import type { Stream } from '../worklet'
import { theme } from '../theme'
import * as castLib from '../cast'
import {
  activeSend, handoffTargets, sendCast, sendHandoff, stopSending, subscribe,
  type ActiveSend, type CastTarget, type HandoffTarget, type SendFailure
} from '../sendToTv'

// How long "Looking for devices…" runs before the sheet says it found none. The Cast
// framework answers a warm mDNS cache in well under a second and a cold one in a few, so
// this is generous rather than tuned — the list keeps updating either way.
const DISCOVERY_MS = 8000

export interface SendToTvSheetProps {
  /**
   * The channel being watched — the one this sheet sends. NULL is a real state, not a
   * caller mistake: a cast keeps running whatever this phone's own catalog does, and the
   * catalog can empty out under it (the operator removes the playing channel, a parental
   * change hides it, a re-login lands between two pushes). The picker then has nothing to
   * send and the ACTIVE CARD is the whole point of the sheet — its Stop button is the only
   * way to shut down a LAN origin server that is still decrypting and serving.
   */
  stream: Stream | null
  onClose: () => void
}

/**
 * Should the entry point exist on this device — and is something being sent right now?
 *
 * `can`: two independent reasons for yes, and both have to be checked because they fail
 * independently — this build/device can reach the Cast framework (Play Services, absent
 * on the Fire OS sticks and AOSP boxes in this fleet), or the account already has a
 * television on the rendezvous. Neither = no button; a picker that can only ever be
 * empty is worse than no picker. The Cast half is asked through cast.castAvailable(),
 * which never touches CastContext — touching CastContext IS the call that throws where
 * the answer is no.
 *
 * `sending`: the entry point lights up while a session runs. Casting does not change
 * anything the viewer can see on this phone — the local picture keeps playing — so
 * without this the one visible sign that the phone is awake and serving is a sheet the
 * viewer has closed.
 */
export function useSendToTv (): { can: boolean; sending: boolean } {
  const [canCast, setCanCast] = useState(false)
  const [state, setState] = useState(() => ({ targets: handoffTargets().length, sending: !!activeSend() }))
  useEffect(() => {
    let alive = true
    castLib.castAvailable().then((v) => { if (alive) setCanCast(v) }).catch(() => {})
    const off = subscribe(() => setState({ targets: handoffTargets().length, sending: !!activeSend() }))
    return () => { alive = false; off() }
  }, [])
  // `sending` also keeps the entry point alive: a viewer casting on a network whose only
  // receiver has since dropped off discovery still needs the way back in to press Stop.
  return { can: canCast || state.targets > 0 || state.sending, sending: state.sending }
}

export function SendToTvSheet ({ stream, onClose }: SendToTvSheetProps) {
  const { t } = useI18n()
  const [active, setActive] = useState<ActiveSend | null>(() => activeSend())
  const [handoffs, setHandoffs] = useState<HandoffTarget[]>(() => handoffTargets())
  const [casts, setCasts] = useState<CastTarget[]>([])
  const [canCast, setCanCast] = useState(false)
  // The row a tap is working on — one at a time, and the rest go inert while it runs.
  // A cast start connects a session, reads an address, binds a server and loads a URL;
  // a second tap in the middle of that is four more steps racing the first four.
  //
  // THE REF IS THE LATCH; the state is only what the rows render from. A `useCallback`
  // closed over the STATE reads the value from its own render cycle, so two presses in
  // the same frame — a fat finger on two rows, a double tap — both saw null and both ran.
  const [busyId, setBusyId] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const [failure, setFailure] = useState<SendFailure | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const off = subscribe(() => {
      setActive(activeSend())
      setHandoffs(handoffTargets())
    })
    return () => { alive.current = false; off() }
  }, [])

  // Discovery runs only while this sheet is open: it is a standing multicast cost, and
  // a picker nobody is looking at has no reason to pay it.
  useEffect(() => {
    let stop: (() => void) | null = null
    castLib.castAvailable().then((ok) => {
      if (!alive.current) return
      setCanCast(ok)
      if (!ok) return
      stop = castLib.discover((list) => {
        // address/isGroup ride along from discovery: they are what decides whether the
        // session can be pinned, and that has to be known BEFORE the server starts.
        if (alive.current) {
          setCasts(list.map((d) => ({
            kind: 'cast' as const, deviceId: d.id, name: d.name, model: d.model, address: d.address, isGroup: d.isGroup
          })))
        }
      })
    }).catch(() => {})
    return () => { if (stop) stop() }
  }, [])

  const run = useCallback(async (id: string, go: () => Promise<SendFailure | null>) => {
    if (busyRef.current) return
    busyRef.current = id
    setFailure(null)
    setBusyId(id)
    const err = await go()
    busyRef.current = null
    if (!alive.current) return
    setBusyId(null)
    if (err) setFailure(err)
  }, [])

  const stop = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = 'stop'
    // A previous send's error has nothing to say about the session that just stopped.
    setFailure(null)
    setBusyId('stop')
    await stopSending()
    busyRef.current = null
    if (!alive.current) return
    setBusyId(null)
  }, [])

  // "Looking for devices…" IS A STATE, NOT A SPINNER THAT NEVER ENDS. Discovery pushes an
  // empty list for a network with no receivers, which is the ordinary case indoors, and it
  // pushes nothing at all when there is nothing to push — so without a deadline the phone
  // spins for as long as the sheet is open and never says the plain thing. The list stays
  // live afterwards: a receiver that wakes up later still appears.
  const [searchedOut, setSearchedOut] = useState(false)
  useEffect(() => {
    if (!canCast) return
    const timer = setTimeout(() => { if (alive.current) setSearchedOut(true) }, DISCOVERY_MS)
    return () => clearTimeout(timer)
  }, [canCast])

  const searching = canCast && casts.length === 0 && !searchedOut
  const noCastDevices = canCast && casts.length === 0 && searchedOut
  // "There is no way to send from this device at all" — which cannot happen while casting
  // is parked (castLib.CAST_ENABLED): the handoff half is always offered, and its own empty
  // state ("sign in to this service on your TV") is the sentence that helps. Without this
  // guard a viewer with no signed-in TV would read both, the second contradicting the first.
  const nothing = castLib.CAST_ENABLED && handoffs.length === 0 && !canCast

  return (
    <View style={styles.overlay}>
      <View style={styles.panel}>
        <Text style={styles.heading}>{t('tvplay.title')}</Text>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
          {!!stream && <Text style={styles.channel} numberOfLines={1}>{stream.title}</Text>}

          {active && <ActiveCard active={active} busy={busyId === 'stop'} onStop={stop} />}

          {!!failure && <Text style={styles.error}>{failureText(t, failure)}</Text>}

          {/* Nothing to send, but the card above is still live and still stoppable: the
              rows below would have no channel to hand over, so they are not offered. */}
          {!stream && <Text style={styles.empty}>{t('tvplay.noChannel')}</Text>}

          {!!stream && (
            <>
              {/* --- handoff: the television does the work --------------------- */}
              <Text style={styles.section}>{t('tvplay.yourDevices')}</Text>
              <Text style={styles.sectionHint}>{t('tvplay.yourDevicesHint')}</Text>
              {handoffs.length === 0
                ? <Text style={styles.empty}>{t('tvplay.noYourDevices')}</Text>
                : handoffs.map((d) => (
                  <DeviceRow
                    key={d.deviceId}
                    name={d.name}
                    sub={d.platform ?? undefined}
                    busy={busyId === d.deviceId}
                    disabled={!!busyId && busyId !== d.deviceId}
                    onPress={() => run(d.deviceId, () => sendHandoff(d, stream))}
                  />
                ))}

              {/* --- cast: THIS PHONE does the work ---------------------------- */}
              {canCast && (
                <>
                  <Text style={styles.section}>{t('tvplay.castDevices')}</Text>
                  <Text style={styles.sectionHint}>{t('tvplay.castHint')}</Text>
                  <Text style={styles.sectionWarn}>{t('tvplay.castWarn')}</Text>
                  {searching && (
                    <View style={styles.searching}>
                      <ActivityIndicator color={theme.colors.primary} />
                      <Text style={styles.empty}>{t('tvplay.searching')}</Text>
                    </View>
                  )}
                  {noCastDevices && <Text style={styles.empty}>{t('tvplay.noCastDevices')}</Text>}
                  {casts.map((d) => (
                    <DeviceRow
                      key={d.deviceId}
                      name={d.name}
                      sub={d.model}
                      busy={busyId === d.deviceId}
                      disabled={!!busyId && busyId !== d.deviceId}
                      onPress={() => run(d.deviceId, () => sendCast(d, stream))}
                    />
                  ))}
                </>
              )}

              {nothing && <Text style={styles.empty}>{t('tvplay.nothing')}</Text>}
            </>
          )}
        </ScrollView>
        <Pressable style={styles.close} accessibilityRole="button" onPress={onClose}>
          <Text style={styles.closeText}>{t('common.close')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

/**
 * What is running, in the viewer's terms, plus the one security fact that differs
 * between the two modes.
 *
 * A CAST always shows which of the two it is — serving one address, or serving whatever
 * asks — because "unpinned" is the default the platform hands us most often and a
 * default nobody was told about is the thing the security review objected to.
 */
function ActiveCard ({ active, busy, onStop }: { active: ActiveSend; busy: boolean; onStop: () => void }) {
  const { t } = useI18n()
  const cast = active.kind === 'cast'
  return (
    <View style={[styles.card, cast ? styles.cardCast : styles.cardHandoff]}>
      <Text style={styles.cardTitle}>
        {cast ? t('tvplay.activeCast', { device: active.deviceName }) : t('tvplay.activeHandoff', { device: active.deviceName })}
      </Text>
      <Text style={styles.cardBody}>{cast ? t('tvplay.activeCastBody') : t('tvplay.activeHandoffBody')}</Text>
      {cast && (
        <Text style={active.pinned ? styles.cardPinned : styles.cardUnpinned}>
          {active.pinned ? t('tvplay.pinned') : active.group ? t('tvplay.unpinnedGroup') : t('tvplay.unpinned')}
        </Text>
      )}
      <Pressable style={styles.stop} accessibilityRole="button" onPress={busy ? undefined : onStop}>
        <Text style={styles.stopText}>{busy ? t('tvplay.working') : t('tvplay.stop')}</Text>
      </Pressable>
    </View>
  )
}

function DeviceRow ({ name, sub, busy, disabled, onPress }: { name: string; sub?: string; busy: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={disabled || busy ? undefined : onPress}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
        {!!sub && <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>}
      </View>
      {busy && <ActivityIndicator color={theme.colors.primary} />}
    </Pressable>
  )
}

/**
 * One sentence per failure. The three that are routinely confused stay apart on purpose:
 * 'timeout' is "nothing came back" and NEVER "it said no"; 'unavailable' is "it took the
 * command and could not do it"; 'refused' is the only one that means a device said no.
 */
function failureText (t: (k: string) => string, f: SendFailure): string {
  switch (f) {
    case 'cast-connect': return t('tvplay.error.castConnect')
    case 'cast-serve': return t('tvplay.error.castServe')
    case 'cast-load': return t('tvplay.error.castLoad')
    case 'refused': return t('tvplay.error.refused')
    case 'unentitled': return t('tvplay.error.unentitled')
    case 'unavailable': return t('tvplay.error.unavailable')
    case 'timeout': return t('tvplay.error.timeout')
    case 'unknown': return t('tvplay.error.unknown')
    case 'offline': return t('tvplay.error.offline')
    default: return t('tvplay.error.failed')
  }
}

const styles = StyleSheet.create({
  // An overlay, not a Modal — a sibling of the screen's own tree, like every other sheet
  // in this app (a Modal is its own focus container).
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.overlayStrong, alignItems: 'center', justifyContent: 'center', padding: theme.spacing(1) },
  // Height-capped, not shaped: this has to read in portrait AND in a landscape phone,
  // where the whole window is barely taller than three rows.
  panel: {
    width: '92%', maxWidth: 560, maxHeight: '92%',
    backgroundColor: theme.colors.surface, borderRadius: 14,
    paddingVertical: theme.spacing(1.25), paddingHorizontal: theme.spacing(1.25)
  },
  heading: {
    color: theme.colors.onPrimary, backgroundColor: theme.colors.primary,
    fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2,
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(0.75),
    borderRadius: 8, marginBottom: theme.spacing(0.75), overflow: 'hidden', textAlign: 'center'
  },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyInner: { paddingBottom: theme.spacing(0.5) },
  channel: { color: theme.colors.accent, fontSize: theme.type.body, fontWeight: '800', marginBottom: theme.spacing(0.75) },
  section: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1.5, marginTop: theme.spacing(1) },
  sectionHint: { color: theme.colors.textDim, fontSize: theme.type.label, lineHeight: 18, marginTop: 4, marginBottom: theme.spacing(0.5) },
  sectionWarn: { color: theme.colors.text, fontSize: theme.type.label, lineHeight: 18, marginBottom: theme.spacing(0.5) },
  empty: { color: theme.colors.textDim, fontSize: theme.type.label, lineHeight: 18, marginBottom: theme.spacing(0.5) },
  searching: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), marginBottom: theme.spacing(0.5) },
  error: { color: theme.colors.live, fontSize: theme.type.label, lineHeight: 18, marginTop: theme.spacing(0.5) },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75),
    backgroundColor: theme.colors.background, borderRadius: 10,
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(1), marginBottom: 8
  },
  rowPressed: { backgroundColor: theme.colors.overlay },
  rowDisabled: { opacity: 0.45 },
  rowMain: { flex: 1 },
  rowName: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  rowSub: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  card: { borderRadius: 10, borderWidth: 2, padding: theme.spacing(1), marginBottom: theme.spacing(0.5) },
  cardHandoff: { borderColor: theme.colors.focus, backgroundColor: theme.colors.background },
  cardCast: { borderColor: theme.colors.accent, backgroundColor: theme.colors.background },
  cardTitle: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  cardBody: { color: theme.colors.textDim, fontSize: theme.type.label, lineHeight: 18, marginTop: 4 },
  cardPinned: { color: theme.colors.textDim, fontSize: theme.type.label, lineHeight: 18, marginTop: 6 },
  cardUnpinned: { color: theme.colors.live, fontSize: theme.type.label, lineHeight: 18, marginTop: 6 },
  stop: { alignSelf: 'flex-start', marginTop: theme.spacing(0.75), borderRadius: 10, paddingVertical: 10, paddingHorizontal: theme.spacing(1.5), backgroundColor: theme.colors.surface },
  stopText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' },
  close: { alignSelf: 'center', marginTop: theme.spacing(0.75), borderRadius: 10, paddingVertical: 12, paddingHorizontal: theme.spacing(2), backgroundColor: theme.colors.background },
  closeText: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '800' }
})
