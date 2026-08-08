// Series detail — the provider's seasons and episodes (S54c, design D3/D8/D9, mockup
// screen 5).
//
// A series NEVER plays directly: its tile on the Movies & Series grid opens this screen,
// which asks the provider for the whole detail in ONE call (getSeriesInfo) and then plays
// an individual EPISODE. The episode url comes back already playable — the provider's
// token is substituted in the provider module, and an episode the provider gave no usable
// (https) path for arrives as `url: ''` and shows a notice instead of playing. Nothing on
// this screen ever dials the provider a second time.
//
// LAYOUT (mockup screen 5). Left column: the poster, a ★ rating row (the provider rates
// out of TEN — five stars is rating/2, and the number is shown beside them so nobody has
// to count), the run-date range verbatim, the genre line. Right column: the title and the
// plot (expandable — provider plots run long and must not push the seasons off-screen).
// Under both: season TILES with an episode-count badge, then the selected season's
// episode list, then Start / Add to My List.
//
// Start is a RESUME: the most recent watch-history entry belonging to this series wins,
// and playback picks up at its stored position; with no history it plays the first
// episode of the first season. My List and the history are DEVICE-LOCAL (D9) — the
// worklet owns the disk, this screen only hands it whole arrays.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Image, Pressable, ScrollView, ActivityIndicator, StyleSheet, Platform, TVFocusGuideView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../App'
import type { VodConfig, VodHistoryEntry, VodListEntry } from '@aliran/react-native'
import { useI18n } from '@aliran/i18n'
import { backend } from '../worklet'
import { getSeriesInfo, type VodEpisode, type VodErrorCode, type VodSeason, type VodSeriesDetail } from '../vod/zencontent'
import { formatDuration } from '../catalog'
import { theme } from '../theme'

// On phone TVFocusGuideView is just a View; on TV autoFocus restores focus memory (S7).
const FocusPane = (Platform.isTV ? TVFocusGuideView : View) as typeof TVFocusGuideView

type Props = NativeStackScreenProps<RootStackParamList, 'VodSeries'>

const STAR_FULL = '★'
const STAR_EMPTY = '☆'

/** The mockup's "★★★★☆ 8.0" row. The provider states a rating out of ten as a string;
 *  five stars is therefore rating/2, rounded to the nearest whole star. An absent,
 *  unparseable or zero rating has no row at all — inventing "0.0 ★☆☆☆☆" would libel
 *  every title the provider simply never rated. */
export function ratingStars (rating: string): { stars: string; value: string } | null {
  const n = Number(rating)
  if (!Number.isFinite(n) || n <= 0) return null
  const clamped = Math.min(10, n)
  const full = Math.round(clamped / 2)
  return { stars: STAR_FULL.repeat(full) + STAR_EMPTY.repeat(5 - full), value: clamped.toFixed(1) }
}

/** The title the player screen shows for an episode: "<series> S1E1 — <episode>".
 *  Numbers are the provider's own; an untitled episode keeps just the code. */
export function episodeTitle (seriesName: string, seasonNumber: number, ep: Pick<VodEpisode, 'number' | 'title'>): string {
  const code = `S${seasonNumber || 1}E${ep.number || 1}`
  const head = seriesName ? `${seriesName} ${code}` : code
  return ep.title ? `${head} — ${ep.title}` : head
}

/** Honest, named failure states — the viewer is told which of the two things broke, and
 *  never sees a provider message or an HTTP code (the VodScreen wording, for series —
 *  literally so: both screens read the same vod.error.* keys). */
function errorText (t: ReturnType<typeof useI18n>['t'], error: VodErrorCode): { title: string; hint: string } {
  if (error === 'auth') return { title: t('vod.error.authTitle'), hint: t('vod.error.authHint') }
  if (error === 'network') return { title: t('vod.error.networkTitle'), hint: t('vod.error.networkHint') }
  return { title: t('vod.error.otherTitle'), hint: t('vod.error.otherHint') }
}

/** The four things this screen says for itself, held by NAME so the line is looked up
 *  at render — see t('vod.series.notice.' + …). */
type Notice = 'noVideo' | 'noEpisodes' | 'listAdded' | 'listRemoved'

export function VodSeriesScreen ({ navigation, route }: Props) {
  const { t } = useI18n()
  const { id, name, icon, anio } = route.params
  // Login-scoped, exactly as on the grid: the coordinates ride the 'streams' message.
  const config: VodConfig | null = backend.vod ?? null

  const [detail, setDetail] = useState<VodSeriesDetail | null>(null)
  const [error, setError] = useState<VodErrorCode | null>(null)
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Device-local (D9). Seeded from the backend's cached prefs and kept current from the
  // 'prefs' reply — which is the TRUTH: the worklet gates and caps what it stored.
  const [myList, setMyList] = useState<VodListEntry[]>(backend.vodList || [])
  const [history, setHistory] = useState<VodHistoryEntry[]>(backend.vodHistory || [])

  useEffect(() => {
    return backend.onMessage((m) => {
      if (m.type === 'prefs') { setMyList(m.vodList || []); setHistory(m.vodHistory || []) }
    })
  }, [])

  useEffect(() => {
    if (!config) return
    let live = true
    setDetail(null); setError(null); setSeasonId(null)
    getSeriesInfo(config, id).then((res) => {
      if (!live) return
      if (res.ok) {
        setDetail(res.detail)
        // Land on the first season the provider named, so the episode list is never
        // empty on arrival (a series with no seasons falls back to every episode).
        setSeasonId(res.detail.seasons[0]?.id ?? null)
      } else setError(res.error)
    })
    return () => { live = false }
  }, [config, id])

  const seasons: VodSeason[] = detail?.seasons ?? []
  const episodes = useMemo(() => {
    const all = detail?.episodes ?? []
    if (!seasonId) return seasons.length > 0 ? [] : all
    return all.filter((e) => e.seasonId === seasonId)
  }, [detail, seasonId, seasons.length])

  const seasonOf = useCallback(
    (episode: VodEpisode) => seasons.find((s) => s.id === episode.seasonId) ?? null,
    [seasons]
  )

  // id -> this device's history entry for that EPISODE (the resume hint under each row).
  const watched = useMemo(() => {
    const out = new Map<string, VodHistoryEntry>()
    for (const h of history || []) if (h && h.kind === 'episode' && h.id) out.set(h.id, h)
    return out
  }, [history])

  // The newest history entry belonging to THIS series — what Start resumes.
  const lastWatched = useMemo(() => {
    let best: VodHistoryEntry | null = null
    for (const h of history || []) {
      if (!h || h.kind !== 'episode' || h.seriesId !== id) continue
      if (!best || (Number(h.at) || 0) > (Number(best.at) || 0)) best = h
    }
    return best
  }, [history, id])

  const saved = useMemo(
    () => (myList || []).some((e) => e && e.kind === 'series' && e.id === id),
    [myList, id]
  )

  const play = useCallback((episode: VodEpisode, resumeSec?: number) => {
    if (!episode.url) {
      // D3: a non-https (or absent) provider path never becomes a playback attempt —
      // this app will not put a viewer's password on a cleartext URL.
      setNotice('noVideo')
      return
    }
    setNotice(null)
    const season = seasonOf(episode)
    navigation.navigate('VodPlayer', {
      url: episode.url,
      title: episodeTitle(name, season?.number ?? 0, episode),
      durationSec: episode.durationSec ?? undefined,
      id: episode.id,
      kind: 'episode',
      seriesId: id,
      ...(resumeSec && resumeSec > 0 ? { resumeSec } : {})
    })
  }, [navigation, name, id, seasonOf])

  // Start = resume where this device left off, else the very first episode.
  const start = useCallback(() => {
    if (!detail) return
    if (lastWatched) {
      const episode = detail.episodes.find((e) => e.id === lastWatched.id)
      if (episode) { play(episode, lastWatched.positionSec); return }
    }
    const firstSeason = detail.seasons[0]
    const first = firstSeason
      ? detail.episodes.find((e) => e.seasonId === firstSeason.id) ?? detail.episodes[0]
      : detail.episodes[0]
    if (first) play(first)
    else setNotice('noEpisodes')
  }, [detail, lastWatched, play])

  // My List: whole-array replace, newest first (D9). The optimistic local state keeps the
  // button honest for the frame or two before the worklet answers with a 'prefs'.
  const toggleSaved = useCallback(() => {
    const rest = (myList || []).filter((e) => !(e && e.kind === 'series' && e.id === id))
    const next: VodListEntry[] = saved ? rest : [{ kind: 'series', id }, ...rest]
    setMyList(next)
    setNotice(saved ? 'listRemoved' : 'listAdded')
    try { backend.setVodList(next) } catch { /* device-local convenience, never fatal */ }
  }, [myList, saved, id])

  const rating = detail ? ratingStars(detail.rating) : null

  // The header is drawn from what the GRID already knew (poster, name, year) the instant
  // this screen mounts — the provider call only ever ADDS to it. A detail screen that
  // shows a spinner where the poster the viewer just pressed should be reads as a stall.
  function renderHeader () {
    return (
      <View style={styles.top}>
        <View style={styles.left}>
          <Poster art={detail?.icon || icon || ''} initial={name} />
          {!!rating && (
            <View style={styles.ratingRow}>
              <Text style={styles.stars}>{rating.stars}</Text>
              <Text style={styles.ratingValue}>{rating.value}</Text>
            </View>
          )}
          {!!detail?.releasedate && <Text style={styles.meta}>{detail.releasedate}</Text>}
          {!!detail?.genre && <Text style={styles.meta}>{detail.genre}</Text>}
        </View>

        <View style={styles.right}>
          <Text style={styles.title}>{name}{anio ? ` (${anio})` : ''}</Text>
          {!!detail?.plot && (
            <>
              <Text style={styles.plot} numberOfLines={expanded ? undefined : 5}>{detail.plot}</Text>
              <Pressable
                style={styles.moreBtn}
                accessibilityRole="button"
                onPress={() => setExpanded((v) => !v)}
              >
                <Text style={styles.moreText}>{expanded ? t('vod.series.less') : t('vod.series.more')}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    )
  }

  function renderDetail () {
    if (!config) return <Centered title={t('vod.empty.noProviderTitle')} hint={t('vod.empty.noProviderHint')} />
    if (error) return <Centered {...errorText(t, error)} />
    if (!detail) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>{t('vod.series.loading')}</Text>
        </View>
      )
    }
    return (
      <>
        <FocusPane style={styles.actions}>
          <ActionButton label={t('vod.series.start')} primary preferred onPress={start} />
          <ActionButton label={saved ? t('vod.series.removeFromList') : t('vod.series.addToList')} onPress={toggleSaved} />
          <ActionButton label={t('common.back')} onPress={() => navigation.goBack()} />
        </FocusPane>

        {seasons.length > 0 && (
          <>
            <Text style={styles.section}>{t('vod.series.seasons')}</Text>
            <FocusPane style={styles.seasonRow}>
              {seasons.map((s) => (
                <SeasonTile
                  key={s.id}
                  season={s}
                  active={s.id === seasonId}
                  onPress={() => setSeasonId(s.id)}
                />
              ))}
            </FocusPane>
          </>
        )}

        <Text style={styles.section}>{t('vod.series.episodes')}</Text>
        {episodes.length === 0
          ? <Text style={styles.hint}>{t('vod.series.emptySeason')}</Text>
          : (
            <FocusPane style={styles.episodes}>
              {episodes.map((e) => (
                <EpisodeRow key={e.id} episode={e} seen={watched.get(e.id) ?? null} onPress={() => play(e, watched.get(e.id)?.positionSec)} />
              ))}
            </FocusPane>
            )}
      </>
    )
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {!!notice && <Text style={styles.notice}>{t('vod.series.notice.' + notice)}</Text>}
        {renderHeader()}
        {renderDetail()}
      </ScrollView>
    </View>
  )
}

function Centered ({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  )
}

// Poster art with the grid's fallback: the title's initial on a plain surface rather
// than a grey hole (a hole reads as breakage, an initial reads as "no art").
function Poster ({ art, initial }: { art: string; initial: string }) {
  const [broken, setBroken] = useState(false)
  if (!art || broken) {
    return (
      <View style={[styles.poster, styles.posterFallback]}>
        <Text style={styles.posterInitial}>{(initial || '?').slice(0, 1).toUpperCase()}</Text>
      </View>
    )
  }
  return <Image source={{ uri: art }} style={styles.poster} resizeMode="cover" onError={() => setBroken(true)} />
}

function ActionButton ({ label, primary, preferred, onPress }: { label: string; primary?: boolean; preferred?: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      style={[styles.action, primary && styles.actionPrimary, focused && styles.actionFocused]}
      accessibilityRole="button"
      hasTVPreferredFocus={preferred}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text>
    </Pressable>
  )
}

// A season tile wears the poster tile's clothes plus the mockup's episode-count badge in
// the top-right corner of the art.
function SeasonTile ({ season, active, onPress }: { season: VodSeason; active: boolean; onPress: () => void }) {
  const { t } = useI18n()
  const [focused, setFocused] = useState(false)
  const [broken, setBroken] = useState(false)
  const showArt = !!season.icon && !broken
  // The provider's own season title wins when it has one; the numbered fallback is ours.
  const label = season.title || t('vod.series.season', { n: season.number || 1 })
  return (
    <Pressable
      style={styles.seasonTile}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <View style={[styles.seasonArt, (focused || active) && styles.seasonArtActive]}>
        {showArt
          ? <Image source={{ uri: season.icon }} style={styles.seasonImage} resizeMode="cover" onError={() => setBroken(true)} />
          : <View style={[styles.seasonImage, styles.posterFallback]}><Text style={styles.seasonNumber}>{season.number || 1}</Text></View>}
        {season.episodeCount > 0 && (
          <View style={styles.badge}><Text style={styles.badgeText}>{season.episodeCount}</Text></View>
        )}
      </View>
      <Text style={[styles.seasonLabel, active && styles.seasonLabelActive]} numberOfLines={2}>{label}</Text>
    </Pressable>
  )
}

// One episode: number + title, the runtime as a chip, one line of plot, and this
// DEVICE's own progress ("Resume at 12:34" / "Watched").
function EpisodeRow ({ episode, seen, onPress }: { episode: VodEpisode; seen: VodHistoryEntry | null; onPress: () => void }) {
  const { t } = useI18n()
  const [focused, setFocused] = useState(false)
  const duration = episode.durationSec && episode.durationSec > 0 ? formatDuration(episode.durationSec) : ''
  const progress = seen
    ? (seen.positionSec > 0 ? t('vod.series.resumeAt', { time: formatDuration(seen.positionSec) }) : t('vod.series.watched'))
    : ''
  return (
    <Pressable
      style={[styles.episode, focused && styles.episodeFocused]}
      accessibilityRole="button"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
    >
      <Text style={styles.episodeNum}>{episode.number || '-'}</Text>
      <View style={styles.episodeBody}>
        <Text style={styles.episodeTitle} numberOfLines={1}>{episode.title || t('vod.series.episode', { n: episode.number || '' }).trim()}</Text>
        {!!episode.plot && <Text style={styles.episodePlot} numberOfLines={2}>{episode.plot}</Text>}
      </View>
      <View style={styles.episodeSide}>
        {!!duration && <Text style={styles.durationChip}>{duration}</Text>}
        {!!progress && <Text style={styles.progressText}>{progress}</Text>}
      </View>
    </Pressable>
  )
}

const POSTER_W = theme.isTV ? 220 : 130
const SEASON_W = theme.isTV ? 150 : 92

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scroll: { paddingVertical: theme.safeY, paddingHorizontal: theme.safeX, paddingBottom: theme.spacing(3) },

  top: { flexDirection: 'row', gap: theme.spacing(2) },
  left: { width: POSTER_W, gap: 6 },
  right: { flex: 1, gap: theme.spacing(0.75) },

  poster: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.textDim, backgroundColor: theme.colors.surface },
  posterFallback: { alignItems: 'center', justifyContent: 'center' },
  posterInitial: { color: theme.colors.textDim, fontSize: theme.type.display, fontWeight: '800' },

  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stars: { color: theme.colors.accent, fontSize: theme.type.label },
  ratingValue: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '700' },
  meta: { color: theme.colors.textDim, fontSize: theme.type.caption },

  title: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '800' },
  plot: { color: theme.colors.textDim, fontSize: theme.type.body, lineHeight: theme.type.body + 6 },
  moreBtn: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: theme.colors.surface },
  moreText: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 1 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(0.75), marginTop: theme.spacing(1.5) },
  action: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.surface,
    borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  actionPrimary: { backgroundColor: theme.colors.primary },
  actionFocused: { borderColor: theme.colors.focus },
  actionText: { color: theme.colors.text, fontSize: theme.type.label, fontWeight: '800', letterSpacing: 1 },
  actionTextPrimary: { color: theme.colors.onPrimary },

  section: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginTop: theme.spacing(2), marginBottom: theme.spacing(0.75) },

  seasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(1) },
  seasonTile: { width: SEASON_W },
  seasonArt: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.textDim, overflow: 'hidden', backgroundColor: theme.colors.surface },
  seasonArtActive: { borderColor: theme.colors.focus },
  seasonImage: { width: '100%', height: '100%' },
  seasonNumber: { color: theme.colors.textDim, fontSize: theme.type.title, fontWeight: '800' },
  badge: {
    position: 'absolute', top: 4, right: 4, minWidth: 22, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 999, backgroundColor: theme.colors.overlayStrong, alignItems: 'center'
  },
  badgeText: { color: theme.colors.text, fontSize: theme.type.caption, fontWeight: '800' },
  seasonLabel: { color: theme.colors.textDim, fontSize: theme.type.caption, textAlign: 'center', marginTop: 4 },
  seasonLabelActive: { color: theme.colors.text, fontWeight: '700' },

  episodes: { gap: 6 },
  episode: {
    flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1),
    paddingHorizontal: theme.spacing(1), paddingVertical: theme.spacing(0.75), borderRadius: 10,
    backgroundColor: theme.colors.surface, borderWidth: theme.focusRing, borderColor: 'transparent'
  },
  episodeFocused: { borderColor: theme.colors.focus },
  episodeNum: { color: theme.colors.textDim, fontSize: theme.type.title, fontWeight: '800', minWidth: 34, textAlign: 'center' },
  episodeBody: { flex: 1 },
  episodeTitle: { color: theme.colors.text, fontSize: theme.type.body, fontWeight: '700' },
  episodePlot: { color: theme.colors.textDim, fontSize: theme.type.caption, marginTop: 2 },
  episodeSide: { alignItems: 'flex-end', gap: 4 },
  durationChip: {
    color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '700',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: theme.colors.background,
    overflow: 'hidden'
  },
  progressText: { color: theme.colors.accent, fontSize: theme.type.caption, fontWeight: '700' },

  center: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: theme.spacing(4), paddingHorizontal: theme.spacing(2) },
  notice: {
    color: theme.colors.text, backgroundColor: theme.colors.overlayStrong, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: theme.spacing(1), fontSize: theme.type.caption
  },
  emptyTitle: { color: theme.colors.text, fontSize: theme.type.title, fontWeight: '700', textAlign: 'center' },
  hint: { color: theme.colors.textDim, fontSize: theme.type.body, textAlign: 'center' }
})
