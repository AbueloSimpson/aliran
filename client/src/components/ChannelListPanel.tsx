// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of ChannelRows for the selected category, over the playing video. Selecting a
// row switches the stream IN PLACE (playback never stops). There is no manual close
// control — the overlay auto-hides after inactivity (LiveScreen's idle timer); any row
// focus or scroll here bumps that timer via onActivity.
//
// On a television the remote's CHANNEL UP/DOWN keys page this list a screenful at a
// time (the guide grid's gesture, on the surface the viewer actually browses) — see the
// pager below. The D-pad still walks it one row at a time.
import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { View, Text, FlatList, StyleSheet, type ListRenderItem } from 'react-native'
import type { Stream } from '../worklet'
import { useI18n } from '@aliran/i18n'
import { ChannelRow, CHANNEL_ROW_H } from './ChannelRow'
import { onChannelKey } from '../channelKeys'
import { theme } from '../theme'

// Hoisted: closes over nothing but the module-scope row height, and FlatList treats a
// changed getItemLayout as a reason to re-measure — a per-render arrow here is a new
// prop on every parent render for no information.
const getItemLayout = (_: ArrayLike<Stream> | null | undefined, index: number) =>
  ({ length: CHANNEL_ROW_H, offset: CHANNEL_ROW_H * index, index })

export interface ChannelListPanelProps {
  streams: Stream[]
  /** Header text — the current category/sub path (e.g. "NEWS  ›  ESPAÑOL"); stays pinned
   *  above the list as it scrolls. Defaults to "CHANNELS". */
  heading?: string
  numbers: Map<string, number>
  playingId: string | null
  favorites: string[]
  onSelect: (stream: Stream) => void
  onInfo: (stream: Stream) => void
  /** Two-tier OK (WS3): pressing the row of the channel ALREADY PLAYING — previously
   *  a no-op re-tune — opens the full program guide instead. Every other row keeps
   *  tuning via onSelect. Absent = the old single-tier behavior. */
  onGuide?: (stream: Stream) => void
  /** Fired on user interaction (row focus / scroll) to defer the auto-hide timer. */
  onActivity?: () => void
}

function ChannelListPanelInner ({ streams, heading, numbers, playingId, favorites, onSelect, onInfo, onGuide, onActivity }: ChannelListPanelProps) {
  const { t } = useI18n()
  const listRef = useRef<FlatList<Stream>>(null)
  const playingIndex = streams.findIndex((s) => s.id === playingId)
  // Set, not Array.includes per row: `favorites.includes(item.id)` in renderItem was a
  // linear scan per mounted row per render — and worse, the fresh boolean rode a fresh
  // closure, so every row re-rendered whenever the panel did. The Set is rebuilt only
  // when favorites actually change, and `favorite={favSet.has(...)}` stays a stable
  // primitive for the row's memo.
  const favSet = useMemo(() => new Set(favorites), [favorites])
  // On open, bring the currently-playing channel into view. Rows are EXACTLY
  // CHANNEL_ROW_H tall, so getItemLayout + initialScrollIndex mount the list ALREADY
  // AT the playing channel — one frame, no progressive render-scroll (QA round 2: a
  // deep jump in a 300+ row list visibly "scrolled like crazy" while the virtualized
  // list measured its way there). The effect below covers a zap made while the list
  // is open; it stays instant for the same reason. onScrollToIndexFailed is the belt.
  useEffect(() => {
    if (playingIndex < 1) return
    const timer = setTimeout(() => {
      try { listRef.current?.scrollToIndex({ index: playingIndex, animated: false, viewPosition: 0.35 }) } catch {}
    }, 0)
    return () => clearTimeout(timer)
  }, [playingIndex])
  // …AND PUT THE FOCUS ON IT. The panel used to open with focus nowhere a viewer could
  // see: this pane and the category rail are both autoFocus TVFocusGuideViews, the rail's
  // is first in the tree and takes it, and hasTVPreferredFocus on the playing row never
  // got a look in. Asking for the row explicitly settles it without taking the rail's
  // autoFocus away — which was tried, and cost LEFT its route INTO the rail.
  // After a frame: the row has to exist before it can hold anything.
  const playingRowRef = useRef<any>(null)
  useEffect(() => {
    if (!theme.isTV || playingIndex < 0) return
    const timer = setTimeout(() => { playingRowRef.current?.requestTVFocus?.() }, 0)
    return () => clearTimeout(timer)
    // Only on open / when the playing channel changes — not on every catalog push.
  }, [playingIndex])
  // WHERE THE D-PAD IS, so the CHANNEL keys below can page FROM it: the rows report
  // their own index as they take focus. Reset when the panel RE-SCOPES — an index into
  // the old category means nothing in the new one. The panel is never told the category
  // key, but `heading` IS that path, and it changes exactly when the scope does (a
  // catalog push, which replaces `streams` without re-scoping, must not clear it).
  const focusedIndexRef = useRef(-1)
  useEffect(() => { focusedIndexRef.current = -1 }, [heading])
  const handleRowFocus = useCallback((index: number) => {
    focusedIndexRef.current = index
    onActivity?.()
  }, [onActivity])

  // CHANNEL UP/DOWN page this list a screenful at a time — the guide's answer to "I do
  // not want to walk 200 channels one press at a time" (GuideScreen's own pageRef),
  // brought to the surface the viewer actually browses on. The keys arrive from the
  // Activity (channelKeys.ts) because the D-pad rig cannot see them: they move focus
  // nowhere. LiveScreen's own handler stands down while any panel is up, so these two
  // subscriptions never both answer a press.
  //
  // A page is MEASURED, not assumed: the row height rides the theme ramp and the panel's
  // height is whatever the overlay leaves. One row of overlap, so the viewer can see
  // where they came from.
  const pageRef = useRef(5)
  const measurePage = useCallback((height: number) => {
    pageRef.current = Math.max(1, Math.floor(height / CHANNEL_ROW_H) - 1)
  }, [])
  // The paged-to row, handed the ref that asks for native focus once it has rendered.
  // State, not a ref, because renderItem has to put the handle ON that row; cleared as
  // soon as the focus lands, so a later re-mount of the same row cannot re-fire it.
  const [pageTarget, setPageTarget] = useState<number | null>(null)
  const pageRowRef = useRef<any>(null)
  useEffect(() => {
    if (pageTarget == null) return
    // A page lands well inside the mounted window, so the row is normally there on the
    // first tick; the retries cover a jump that outran virtualization (the row mounts a
    // frame or two later), and giving up leaves the list scrolled — never wedged.
    let tries = 0
    let timer = setTimeout(function tick () {
      const row = pageRowRef.current
      if (row?.requestTVFocus) { row.requestTVFocus(); setPageTarget(null); return }
      if (++tries > 3) { setPageTarget(null); return }
      timer = setTimeout(tick, 40)
    }, 0)
    return () => clearTimeout(timer)
  }, [pageTarget])
  useEffect(() => onChannelKey((direction) => {
    if (!streams.length) return
    // Nothing focused yet (the panel just opened, or the rail still holds the focus):
    // page from the channel being watched, which is where the list is parked.
    const from = focusedIndexRef.current >= 0 && focusedIndexRef.current < streams.length
      ? focusedIndexRef.current
      : Math.max(playingIndex, 0)
    const step = direction === 'up' ? -pageRef.current : pageRef.current
    const target = Math.min(Math.max(from + step, 0), streams.length - 1)
    if (target === from) return
    onActivity?.()
    try { listRef.current?.scrollToIndex({ index: target, animated: false, viewPosition: 0.35 }) } catch {}
    setPageTarget(target)
  }), [streams, playingIndex, onActivity])

  // Two-tier OK (WS3) as ONE stable handler: the row hands its stream back, and the
  // playing-row → guide dispatch happens here instead of inside a per-row closure.
  // Rows therefore share this single function and their memo holds across renders.
  const handlePress = useCallback((s: Stream) => {
    if (s.id === playingId && onGuide) onGuide(s)
    else onSelect(s)
  }, [playingId, onGuide, onSelect])
  const renderItem: ListRenderItem<Stream> = useCallback(({ item, index }) => (
    <ChannelRow
      stream={item}
      index={index}
      number={numbers.get(item.id)}
      playing={item.id === playingId}
      favorite={favSet.has(item.id)}
      // Focus fallback: the FIRST row asks for the opening focus only when NOTHING
      // is playing at all. Keying this on "the playing channel is absent from THIS
      // list" (playingIndex < 0) was tried and reverted: it fired on every scope
      // that lacks the playing channel, so merely WALKING the rail past such a
      // category made row 0 requestFocus and yanked the D-pad out of the rail.
      // With the membership-checked scope restore the reopened panel virtually
      // always contains the playing row; when it doesn't, the rail keeps focus —
      // acceptable, and far better than stealing it mid-walk.
      hasTVPreferredFocus={item.id === playingId || (playingId == null && index === 0)}
      // The PAGE TARGET wins the handle: a CHANNEL-key jump has to be able to land on
      // the playing row too, and it is the transient one — the playing row's own effect
      // fires on open, long before any page.
      innerRef={index === pageTarget ? pageRowRef : item.id === playingId ? playingRowRef : undefined}
      onFocus={handleRowFocus}
      onPressStream={handlePress}
      onLongPressStream={onInfo}
    />
  ), [numbers, playingId, favSet, pageTarget, handleRowFocus, handlePress, onInfo])
  return (
    <View style={styles.panel}>
      <Text style={styles.header} numberOfLines={1}>{heading ?? t('live.channels')}</Text>
      {/* The list's own box, and the thing a "screenful" is measured against — the
          guide grid's `body` idiom (GuideScreen), for the same reason: what is left
          under the heading is not a number this file can know. */}
      <View style={styles.listBox} onLayout={(e) => measurePage(e.nativeEvent.layout.height)}>
        <FlatList
          ref={listRef}
          data={streams}
          keyExtractor={(s) => s.id}
          getItemLayout={getItemLayout}
          initialScrollIndex={playingIndex > 0 ? playingIndex : undefined}
          onScrollBeginDrag={onActivity}
          // THE MOUNTED-WINDOW DISCIPLINE, and this list needed it most of all. Every
          // ChannelRow runs its own EPG fetch (useEpg, for the now-playing subline), so
          // each mounted row is a request — and at FlatList's defaults a lineup of ~900
          // channels mounted enough of them at once that opening this panel was visibly
          // slower than the guide, which has carried these three props from the start.
          // Keep the numbers here and the guide's in step: same rows, same cost.
          windowSize={5}
          initialNumToRender={12}
          // …BUT NOT CLIPPING, ON A TELEVISION. removeClippedSubviews does not change
          // what is MOUNTED (windowSize decides that, and with it the EPG cost above) —
          // it DETACHES the mounted rows that are off-screen from the native view tree.
          // On Android that also takes them out of focus search, and this list's rows are
          // the focusables: pressing DOWN on the last visible row found nothing below it,
          // because the next row was mounted but detached, so focus wrapped back to the
          // top of the list and the panel scrolled up with it — the operator's "it goes
          // down four or five channels and jumps back up". Holding the key made it
          // certain, since a smooth scroll is still in flight when the next press
          // arrives; pressing slowly gave Android time to scroll, re-attach and find the
          // row, which is why it "worked slower". The guide's grid keeps the flag because
          // its rows hold nothing focusable at all (virtual focus). Phone keeps it too:
          // touch has no focus to lose.
          removeClippedSubviews={!theme.isTV}
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
            setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.35 }) } catch {} }, 60)
          }}
          renderItem={renderItem}
        />
      </View>
      <Text style={styles.hint}>{t('live.holdForDetails')}</Text>
    </View>
  )
}

// Memoized like its rows: LiveScreen re-renders on every clock tick, peer count, and
// tune-progress update, and none of those are this panel's business. Only holds if the
// host passes identity-stable handlers (LiveScreen's useStableCallback) and memoized
// streams/numbers — which it does.
export const ChannelListPanel = React.memo(ChannelListPanelInner)

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12, paddingVertical: theme.spacing(1), paddingHorizontal: theme.spacing(1) },
  header: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1), marginLeft: theme.spacing(1) },
  // Takes everything the heading and the hint leave; the FlatList inside fills it (a
  // scroll view grows and shrinks by default), so the geometry is what it always was.
  listBox: { flex: 1 },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, marginTop: 4, marginLeft: theme.spacing(1), opacity: 0.7 }
})
