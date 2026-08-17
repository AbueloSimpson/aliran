// Main menu hub. BOTH builds run the vertical LEFT-rail grammar (the BBC-iPlayer
// pattern): glyph + ALL-CAPS tiles down the left edge on a translucent surface panel
// with an accent hairline, the right side the hero/info area (wordmark + live hero
// lines anchored lower-right). PHONE got it first (S22 redesign); TV joined
// 2026-08-15 (operator request — it used to keep the reference's horizontal top
// bar), with the one grammar difference remotes force: TV tiles are FOCUS-driven
// (accent ring on D-pad focus, MenuEntry) where phone tiles answer PRESS
// (RailEntry). Wallpaper = the featured stream's LIVE feed thumb when
// one is rolling (WS5), over its backdrop (panel curation, S16c) under a dark scrim,
// falling back to the operator's branding.wallpaper, then a plain brand surface (D6:
// no baked-in art). On phone a theme-token wash (background/surface gradient built
// from stacked Views — no gradient dependency in this codebase) sits ABOVE the scrim
// to ground the rail and the hero text; the scrim itself is untouched.
// The section list is DATA-DRIVEN from the service descriptor (white-label §8) AND,
// for Movies & Series, from the PANEL: that tile exists only while the operator has an
// external VOD provider enabled (S53 — backend.vod is delivered on the login/'streams'
// payload and is null otherwise), and a brand can still switch it off with
// sections.vod:false. Exit is TV-only by default (D7).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, Platform, BackHandler, ScrollView, useWindowDimensions } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import { getLocale, useI18n } from '@aliran/i18n'
import { backend, type Stream } from '../worklet'
import { visibleStreams } from '../parental'
import { loadServiceDescriptor, type SectionToggles } from '../config'
import { displayTitle, pickHero } from '../catalog'
import { useEpg, useChannelThumb } from '@aliran/react-native'
import { theme } from '../theme'

const service = loadServiceDescriptor()

type Props = NativeStackScreenProps<RootStackParamList, 'Menu'>

interface MenuItem {
  key: string
  label: string
  glyph: string
  go: () => void
}

// Dependency-free "gradient": N stacked bands whose opacity follows a quadratic ease,
// which reads smooth at this band count on device. Two layers, both from theme tokens:
// a vertical background wash (transparent top → grounded bottom, under the hero text)
// and a horizontal surface wash (left edge → transparent), giving the composite a
// subtle diagonal drift toward the rail.
// Menu icon size, trimmed on device. TWO ROUNDS OF 15%, the same way the overall density
// knob was tuned (theme.ts SCALE: 0.85 → 0.80 → 0.68 phone, 1.0 → 0.8 → 0.72 → 0.66 TV) —
// the glyphs read too large on both a phone and a television.
//
// This factor stays SEPARATE from theme's px()/SCALE ramp so the two decisions stay
// legible, but the TV rail's glyph now composes the two (px(34 * ICON_SCALE)) — see the
// `glyph` style. That was not cosmetic. Measured on a TCL 1080p set (density 320, so a
// 540dp viewport) the six-entry rail laid out at 602dp and clipped SALIR off the bottom.
// 50 of each entry's 86dp were OFF the ramp, in three pieces:
//
//   focus border 3 × 2                                            =  6dp
//   emoji line box (fontSize 25 × the ~1.44 line-box ratio of
//     Android's emoji font)                                       = 36dp
//   label marginTop, a literal 8                                  =  8dp
//
// so only 36 of the 86 answered SCALE, and no reachable SCALE could close a 62dp gap on
// its own — even at the documented 0.6 floor the rail still measured 551dp. Putting the
// glyph and the marginTop (44 of that 50) ON the ramp is what actually FIXES it, and it
// fixed it at SCALE 0.72: 530dp of 540. The operator's later step to 0.66 (theme.ts
// carries that decision, and it is a density preference rather than a fit) then buys the
// margin rather than the fit — 496dp of 540. The 6dp border stays off the ramp
// deliberately — see the `entry` style. The PHONE tiles (railGlyph/railLabel) are
// untouched: a different, already-tuned component that does not clip.
const ICON_SCALE = 0.85 * 0.85

const WASH_BANDS = 16
const washStops = Array.from({ length: WASH_BANDS }, (_, i) => (i / (WASH_BANDS - 1)) ** 2)

// Memoized: takes no props, and the menu re-renders on every 30 s thumb poll —
// no need to rebuild 32 style arrays each time.
const BackgroundWash = React.memo(function BackgroundWash () {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, styles.washColumn]}>
        {washStops.map((t, i) => <View key={i} style={[styles.washBandV, { opacity: 0.85 * t }]} />)}
      </View>
      <View style={[StyleSheet.absoluteFill, styles.washRow]}>
        {washStops.map((t, i) => <View key={i} style={[styles.washBandH, { opacity: 0.5 * (1 - t) }]} />)}
      </View>
    </View>
  )
})

export function MenuScreen ({ navigation }: Props) {
  const { t } = useI18n()
  // Boot trace: when this render pass started, so the mount effect below can say how
  // long the first paint took — the window the vc13 trace lost 42 s inside.
  const mountT0 = useRef(Date.now())
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  // The panel's VOD provider switch. It rides the same 'streams' message, so a menu
  // mounted before login sees it the moment the catalog lands.
  const [vodEnabled, setVodEnabled] = useState<boolean>(!!backend.vod?.enabled)

  // Boot trace: the first committed frame. The gap from mountT0 is what a viewer
  // waits between the splash handing over and a menu they can press.
  useEffect(() => {
    console.log(`[boot-ui] menu first frame ${Date.now() - mountT0.current}ms after mount (${streams.length} channels${backend.provisional ? ', provisional' : ''})`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'streams') {
        // Boot trace: when each lineup lands at THIS screen (the swap the viewer sees).
        console.log(`[boot-ui] menu lineup ${m.provisional ? 'provisional' : 'real'} n=${m.streams.length} at t+${Date.now() - mountT0.current}ms`)
        setStreams(visibleStreams(m.streams)); setVodEnabled(!!m.vod?.enabled)
      }
      // A parental change in Settings (this screen stays mounted under the stack)
      // can re-hide/reveal restricted channels — recompute the wallpaper pick.
      if (m.type === 'prefs') setStreams(visibleStreams(backend.streams))
    })
  }, [])

  const hero = useMemo(() => pickHero(streams), [streams])
  const wallpaper = hero?.backdrop || hero?.poster || service.branding?.wallpaper
  // Live hero: the featured channel's rolling feed thumb (the SDK's 30 s poll — the
  // same hook the channel rows use) layered over its backdrop. The backdrop stays
  // mounted underneath, so nothing changes while the thumb loads — and a 404
  // (thumbnails off, feed cold) IS today's backdrop-only wallpaper. The existing
  // scrim above does all the blending; no new overlays.
  const [heroThumb, onHeroThumbError] = useChannelThumb(hero?.thumbBase)
  // The chip latches on a real decoded frame, not URL truthiness: the hook re-probes
  // 404ing feeds every 30 s (url flips truthy before the error lands), which would
  // flash the chip on thumb-less channels without this latch.
  const [thumbShown, setThumbShown] = useState(false)
  useEffect(() => { setThumbShown(false) }, [hero?.thumbBase])
  // Now-playing line for the featured stream — omitted entirely when it has no guide.
  const { data: heroEpg } = useEpg(hero?.epgUrl, hero?.epgId, hero?.guideBase)
  const nowTitle = heroEpg?.now?.title
  // Phone-only orientation trim (the TV branch below never reads it): the rail keeps
  // a touch more breathing room in landscape, and cedes width to the hero in portrait.
  const { width, height } = useWindowDimensions()
  const portrait = height >= width

  // Built fresh every render rather than memoized: the labels are translated, and a
  // memo keyed on the data alone would keep showing the previous language's bar after
  // a switch. Seven objects is not a cost worth a stale menu.
  const items = ((): MenuItem[] => {
    // sections.guide is new with the guide hub (WS5) — typed locally until the
    // descriptor's SectionToggles grows the field.
    const s: SectionToggles & { guide?: boolean } = service.sections ?? {}
    const list: MenuItem[] = [
      { key: 'live', label: t('menu.live'), glyph: '📺', go: () => navigation.navigate('Live', {}) }
    ]
    // TV opens the standalone Guide screen (D-pad grid); phone opens Live with the
    // guide overlay up, so the playing stream shows above the grid (WS7).
    if (s.guide !== false) list.push({ key: 'guide', label: t('menu.guide'), glyph: '🗓️', go: () => (theme.isTV ? navigation.navigate('Guide') : navigation.navigate('Live', { guide: true })) })
    if (vodEnabled && s.vod !== false) list.push({ key: 'vod', label: t('menu.vod'), glyph: '🎬', go: () => navigation.navigate('Vod') })
    if (s.favorites !== false) list.push({ key: 'favorites', label: t('menu.favorites'), glyph: '⭐', go: () => navigation.navigate('Favorites') })
    // Same split for search: TV keeps the standalone Search screen; phone raises the
    // in-player search overlay over the live video (WS15).
    if (s.search !== false) list.push({ key: 'search', label: t('menu.search'), glyph: '🔍', go: () => (theme.isTV ? navigation.navigate('Search') : navigation.navigate('Live', { search: true })) })
    if (s.settings !== false) list.push({ key: 'settings', label: t('menu.settings'), glyph: '⚙️', go: () => navigation.navigate('Settings') })
    if (s.exit ?? Platform.isTV) list.push({ key: 'exit', label: t('menu.exit'), glyph: '🚪', go: () => BackHandler.exitApp() })
    return list
  })()

  if (theme.isTV) {
    // TV: the same left-rail grammar as the phone (operator request 2026-08-15 — the
    // section icons used to ride a horizontal TOP bar, out of step with the phone
    // build). The rail keeps the FOCUS-driven MenuEntry, never the touch-only
    // RailEntry: D-pad UP/DOWN walks it, OK enters, the first item takes preferred
    // focus — the accent ring is the selection state a remote viewer navigates by.
    // Top-aligned on purpose (no flexGrow/center like the phone rail): a centered
    // overflow in a ScrollView clips the top entries out of reach. The DEFAULT set of
    // six (no VOD provider) must fit at rest and does — 496dp of a 540dp viewport at the
    // shipped SCALE of 0.66, device-measured on both TCL sets; it did NOT before the
    // sizing fix (602dp, SALIR below the fold). The fix itself was device-verified on the
    // Android 11 set (1920x1080, density 320) by building both sides, at the 0.72 it
    // landed on first: SALIR's label was entirely below the fold before and the whole
    // tile on screen after, at 530dp. The measured tile pitch was 81dp against the 80dp
    // (74 tile + 6 gap) this comment predicts, so the model is good to about a dp — which
    // is what makes the ~44dp of margin here worth trusting rather than re-measuring.
    // If an entry is ever added to the default set, re-measure anyway: the lever is this
    // rail's own paddingVertical/gap (see the `entry` and `tvRailContent` styles), NOT
    // theme's SCALE.
    // A seventh entry (VOD enabled) takes it to 571dp and it scrolls, which is what
    // the ScrollView is here for — the rail is reachable, just not all at rest.
    // The wordmark + hero/now-playing lines move to
    // the lower-right hero area, phone-style — the old absolute bottom-left footer
    // would sit under the rail.
    return (
      <View style={styles.container}>
        {wallpaper && <Image source={{ uri: wallpaper }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
        {hero && heroThumb && (
          // The uri carries a rolling ?t= stamp; the Image element itself stays mounted
          // across polls (same slot in the tree) — only the source updates.
          <Image
            source={{ uri: heroThumb }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={() => { setThumbShown(false); onHeroThumbError() }}
            onLoad={() => setThumbShown(true)}
            accessibilityLabel={t('menu.heroLiveNow', { title: displayTitle(hero) })}
          />
        )}
        <View style={[StyleSheet.absoluteFill, styles.scrim]} />

        <View style={styles.tvBody}>
          <View style={styles.tvRail}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.tvRailContent}>
              {items.map((item, i) => <MenuEntry key={item.key} item={item} first={i === 0} />)}
            </ScrollView>
          </View>

          <View style={styles.tvHeroArea}>
            <Text style={styles.wordmark}>{service.name}</Text>
            {hero && (
              <View style={styles.heroLine}>
                {hero.isLive && <Text style={styles.live}>{t('common.liveBadge')}</Text>}
                <Text style={styles.heroTitle} numberOfLines={1}>{displayTitle(hero)}</Text>
              </View>
            )}
            {!!nowTitle && (
              <View style={styles.heroLine}>
                {/* The chip needs live evidence: only after a feed frame actually loaded. */}
                {thumbShown && <Text style={styles.liveChip}>{t('common.live')}</Text>}
                <Text style={styles.heroTitle} numberOfLines={1}>{nowTitle}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    )
  }

  // PHONE: left rail + right hero area. The flex row works in both orientations —
  // portrait narrows the rail so the hero keeps room lower-right.
  return (
    <View style={styles.container}>
      {wallpaper && <Image source={{ uri: wallpaper }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
      {hero && heroThumb && (
        // The uri carries a rolling ?t= stamp; the Image element itself stays mounted
        // across polls (same slot in the tree) — only the source updates.
        <Image
          source={{ uri: heroThumb }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => { setThumbShown(false); onHeroThumbError() }}
          onLoad={() => setThumbShown(true)}
          accessibilityLabel={t('menu.heroLiveNow', { title: displayTitle(hero) })}
        />
      )}
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      <BackgroundWash />

      <View style={styles.phoneBody}>
        <View style={[styles.rail, { width: portrait ? 100 : 118 }]}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.railContent}>
            {items.map(item => <RailEntry key={item.key} item={item} />)}
          </ScrollView>
        </View>

        <View style={styles.heroArea}>
          <Text style={styles.wordmark}>{service.name}</Text>
          {hero && (
            <View style={styles.heroLine}>
              {hero.isLive && <Text style={styles.live}>{t('common.liveBadge')}</Text>}
              <Text style={styles.heroTitle} numberOfLines={1}>{displayTitle(hero)}</Text>
            </View>
          )}
          {!!nowTitle && (
            <View style={styles.heroLine}>
              {/* The chip needs live evidence: only after a feed frame actually loaded. */}
              {thumbShown && <Text style={styles.liveChip}>{t('common.live')}</Text>}
              <Text style={styles.heroTitle} numberOfLines={1}>{nowTitle}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

function MenuEntry ({ item, first }: { item: MenuItem; first: boolean }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.entry, focused && styles.entryFocused]}
      hasTVPreferredFocus={first}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={item.go}
    >
      <Text style={styles.glyph}>{item.glyph}</Text>
      <Text style={[styles.label, focused && styles.labelFocused]}>{item.label.toLocaleUpperCase(getLocale())}</Text>
    </Pressable>
  )
}

// Phone rail tile: the menu-icon focus grammar (accent rounded border) adapted for
// touch — the border + label tint apply on PRESS, over a stronger overlay fill.
function RailEntry ({ item }: { item: MenuItem }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={({ pressed }) => [styles.railEntry, pressed && styles.railEntryActive]}
      onPress={item.go}
    >
      {({ pressed }) => (
        <>
          <Text style={styles.railGlyph}>{item.glyph}</Text>
          <Text style={[styles.railLabel, pressed && styles.railLabelActive]}>{item.label.toLocaleUpperCase(getLocale())}</Text>
        </>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scrim: { backgroundColor: theme.colors.overlay, opacity: 0.55 },
  // Theme-token wash bands (see BackgroundWash).
  washColumn: { flexDirection: 'column' },
  washRow: { flexDirection: 'row' },
  washBandV: { flex: 1, backgroundColor: theme.colors.background },
  washBandH: { flex: 1, backgroundColor: theme.colors.surface },
  // --- TV left rail (the phone rail's grammar, focus-driven) ---
  tvBody: { flex: 1, flexDirection: 'row' },
  // Same translucent surface + accent hairline as the phone rail; the safe insets
  // live on the rail itself so no entry ever sits in overscan.
  tvRail: { backgroundColor: theme.colors.overlay, borderRightWidth: 1, borderRightColor: theme.colors.accent, paddingLeft: theme.safeX },
  // ⚠ The gap is QUANTIZED and barely moves with SCALE: spacing(0.75) rounds to 6dp at
  // both 0.72 and 0.66, and spacing(0.5) to 4dp at both. Small spacings are the first
  // thing rounding flattens, which is part of why the global ramp is a poor lever for a
  // rail that overflows — most of what it would shrink here does not shrink. To buy
  // height, drop this to spacing(0.5) (5 gaps × 2dp = 10dp) before touching SCALE.
  tvRailContent: { paddingVertical: theme.safeY + theme.spacing(1), paddingRight: theme.spacing(1), gap: theme.spacing(0.75) },
  tvHeroArea: { flex: 1, justifyContent: 'flex-end', alignItems: 'flex-end', paddingLeft: theme.spacing(2), paddingRight: theme.safeX, paddingBottom: theme.safeY + theme.spacing(1.5) },
  // These three (entry/glyph/label) are the TV rail's tiles — MenuEntry is rendered only
  // from the isTV branch above, the phone uses railEntry/railGlyph/railLabel — so every
  // number here is a TV number and putting them on the ramp cannot touch the phone.
  // The TV tile's height budget. These are the numbers at SCALE 0.72, which is where the
  // fix landed and where every part of it was measured on device; the ramp has since
  // stepped to 0.66 by operator decision, which takes the same six-entry rail to 496dp.
  // Either way it is the rail total — 6 tiles + 5 gaps + 2 × [safeY + spacing(1)] — that
  // has to stay under a 540dp viewport:
  //
  //   focus border 3 × 2                          =  6dp  off ramp, deliberately
  //   paddingVertical spacing(1.25) × 2           = 22dp
  //   glyph line box  px(25) 18 × ~1.44           = 26dp
  //   label marginTop px(8)                       =  6dp
  //   label line box  type.label 12 × ~1.17       = 14dp
  //                                                 ----
  //                                                 74dp  → a 530dp rail at 0.72
  //
  // paddingVertical is the lever if this ever needs to give: 1.25 → 1 takes the tile to
  // 70dp and the rail to 506. Reach for that, not theme's SCALE.
  //
  // None of those figures is load-bearing on its own, and deliberately so — a budget in a
  // comment is a budget nothing checks. TvMenuRail's fit guard recomputes this whole sum
  // from the styles this component actually renders, at whatever SCALE is set, and fails
  // when six entries stop fitting 540dp. Change a number here and that lane is what tells
  // you.
  entry: {
    alignItems: 'center', justifyContent: 'center',
    minWidth: theme.isTV ? 132 : 92,
    paddingVertical: theme.spacing(1.25), paddingHorizontal: theme.spacing(1),
    // borderWidth stays OFF the ramp on purpose, unlike the glyph and the label margin:
    // it is the focus affordance a remote navigates by, not a density value, and at 6dp
    // of the tile's height it is not what was pushing the rail past the fold.
    borderRadius: 12, borderWidth: 3, borderColor: 'transparent'
  },
  entryFocused: { borderColor: theme.colors.accent, backgroundColor: theme.colors.overlay },
  // ON the ramp (see ICON_SCALE): the emoji line box is the single largest contributor to
  // the tile's height, so it has to shrink with everything else or the rail overflows.
  glyph: { fontSize: theme.px(Math.round((theme.isTV ? 34 : 26) * ICON_SCALE)) },
  label: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 2, marginTop: theme.px(8) },
  labelFocused: { color: theme.colors.accent },
  // --- phone rail + hero area ---
  phoneBody: { flex: 1, flexDirection: 'row' },
  // Translucent surface panel: the hero art shows through; a 1px accent hairline
  // marks the rail's edge (the "subtle accent edge" of the redesign).
  rail: { backgroundColor: theme.colors.overlay, borderRightWidth: 1, borderRightColor: theme.colors.accent },
  railContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.safeY + theme.spacing(1), paddingHorizontal: theme.spacing(0.75), gap: theme.spacing(1) },
  railEntry: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: theme.spacing(1.25), paddingHorizontal: theme.spacing(0.5),
    borderRadius: 12, borderWidth: 2, borderColor: 'transparent'
  },
  railEntryActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.overlayStrong },
  railGlyph: { fontSize: Math.round(24 * ICON_SCALE) },
  railLabel: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1.5, marginTop: 6, textAlign: 'center' },
  railLabelActive: { color: theme.colors.accent },
  // alignItems flex-end anchors the wordmark/hero lines to the LOWER-RIGHT corner
  // (the redesign's spec); text still truncates via numberOfLines.
  heroArea: { flex: 1, justifyContent: 'flex-end', alignItems: 'flex-end', paddingLeft: theme.spacing(2), paddingRight: theme.safeX, paddingBottom: theme.safeY + theme.spacing(1.5) },
  // --- shared footer/hero text ---
  wordmark: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800', opacity: 0.9 },
  heroLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, maxWidth: 480 },
  live: { color: theme.colors.live, fontWeight: '800', fontSize: theme.type.caption },
  heroTitle: { color: theme.colors.textDim, fontSize: theme.type.caption },
  // ChannelRow's LIVE badge vocabulary (filled pill), local to this screen.
  liveChip: { color: theme.colors.onPrimary, backgroundColor: theme.colors.live, fontSize: theme.type.caption - 2, fontWeight: '800', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' }
})
