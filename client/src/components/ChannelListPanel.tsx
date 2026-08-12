// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of ChannelRows for the selected category, over the playing video. Selecting a
// row switches the stream IN PLACE (playback never stops). There is no manual close
// control — the overlay auto-hides after inactivity (LiveScreen's idle timer); any row
// focus or scroll here bumps that timer via onActivity.
import React, { useRef, useEffect } from 'react'
import { View, Text, FlatList, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { useI18n } from '@aliran/i18n'
import { ChannelRow, CHANNEL_ROW_H } from './ChannelRow'
import { theme } from '../theme'

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

export function ChannelListPanel ({ streams, heading, numbers, playingId, favorites, onSelect, onInfo, onGuide, onActivity }: ChannelListPanelProps) {
  const { t } = useI18n()
  const listRef = useRef<FlatList<Stream>>(null)
  const playingIndex = streams.findIndex((s) => s.id === playingId)
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
  return (
    <View style={styles.panel}>
      <Text style={styles.header} numberOfLines={1}>{heading ?? t('live.channels')}</Text>
      <FlatList
        ref={listRef}
        data={streams}
        keyExtractor={(s) => s.id}
        getItemLayout={(_, index) => ({ length: CHANNEL_ROW_H, offset: CHANNEL_ROW_H * index, index })}
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
        removeClippedSubviews
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.35 }) } catch {} }, 60)
        }}
        renderItem={({ item, index }) => (
          <ChannelRow
            stream={item}
            number={numbers.get(item.id)}
            playing={item.id === playingId}
            favorite={favorites.includes(item.id)}
            hasTVPreferredFocus={item.id === playingId || (playingId == null && index === 0)}
            onFocus={onActivity}
            onPress={() => (item.id === playingId && onGuide ? onGuide(item) : onSelect(item))}
            onLongPress={() => onInfo(item)}
          />
        )}
      />
      <Text style={styles.hint}>{t('live.holdForDetails')}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12, paddingVertical: theme.spacing(1), paddingHorizontal: theme.spacing(1) },
  header: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1), marginLeft: theme.spacing(1) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, marginTop: 4, marginLeft: theme.spacing(1), opacity: 0.7 }
})
