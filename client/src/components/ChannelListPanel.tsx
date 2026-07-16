// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of ChannelRows for the selected category, over the playing video. Selecting a
// row switches the stream IN PLACE (playback never stops). There is no manual close
// control — the overlay auto-hides after inactivity (LiveScreen's idle timer); any row
// focus or scroll here bumps that timer via onActivity.
import React from 'react'
import { View, Text, FlatList, StyleSheet } from 'react-native'
import type { Stream } from '../worklet'
import { ChannelRow } from './ChannelRow'
import { theme } from '../theme'

export interface ChannelListPanelProps {
  streams: Stream[]
  numbers: Map<string, number>
  playingId: string | null
  favorites: string[]
  onSelect: (stream: Stream) => void
  onInfo: (stream: Stream) => void
  /** Fired on user interaction (row focus / scroll) to defer the auto-hide timer. */
  onActivity?: () => void
}

export function ChannelListPanel ({ streams, numbers, playingId, favorites, onSelect, onInfo, onActivity }: ChannelListPanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.header}>CHANNELS</Text>
      <FlatList
        data={streams}
        keyExtractor={(s) => s.id}
        onScrollBeginDrag={onActivity}
        renderItem={({ item, index }) => (
          <ChannelRow
            stream={item}
            number={numbers.get(item.id)}
            playing={item.id === playingId}
            favorite={favorites.includes(item.id)}
            hasTVPreferredFocus={item.id === playingId || (playingId == null && index === 0)}
            onFocus={onActivity}
            onPress={() => onSelect(item)}
            onLongPress={() => onInfo(item)}
          />
        )}
      />
      <Text style={styles.hint}>hold for details</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12, paddingVertical: theme.spacing(1), paddingHorizontal: theme.spacing(1) },
  header: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1), marginLeft: theme.spacing(1) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, marginTop: 4, marginLeft: theme.spacing(1), opacity: 0.7 }
})
