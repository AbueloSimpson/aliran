// Channel-list overlay panel (the reference's LISTA DE CANALES): dark translucent
// panel of ChannelRows for the selected category, over the playing video. Selecting a
// row switches the stream IN PLACE (playback never stops); the right-edge chevron
// hints collapse back to fullscreen video.
import React, { useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native'
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
  onCollapse: () => void
}

export function ChannelListPanel ({ streams, numbers, playingId, favorites, onSelect, onInfo, onCollapse }: ChannelListPanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.header}>CHANNELS</Text>
      <FlatList
        data={streams}
        keyExtractor={(s) => s.id}
        renderItem={({ item, index }) => (
          <ChannelRow
            stream={item}
            number={numbers.get(item.id)}
            playing={item.id === playingId}
            favorite={favorites.includes(item.id)}
            hasTVPreferredFocus={item.id === playingId || (playingId == null && index === 0)}
            onPress={() => onSelect(item)}
            onLongPress={() => onInfo(item)}
          />
        )}
      />
      <Text style={styles.hint}>hold for details</Text>
      <Chevron onPress={onCollapse} />
    </View>
  )
}

function Chevron ({ onPress }: { onPress: () => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable style={styles.chevron} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={onPress}>
      <Text style={[styles.chevronText, focused && styles.chevronFocused]}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.colors.overlay, borderTopRightRadius: 12, borderBottomRightRadius: 12, paddingVertical: theme.spacing(1), paddingLeft: theme.spacing(1), paddingRight: theme.spacing(2.5) },
  header: { color: theme.colors.textDim, fontSize: theme.type.caption, fontWeight: '800', letterSpacing: 2, marginBottom: theme.spacing(1), marginLeft: theme.spacing(1) },
  hint: { color: theme.colors.textDim, fontSize: theme.type.caption - 1, marginTop: 4, marginLeft: theme.spacing(1), opacity: 0.7 },
  chevron: { position: 'absolute', right: 2, top: '46%', padding: 8 },
  chevronText: { color: theme.colors.textDim, fontSize: theme.type.title, fontWeight: '800' },
  chevronFocused: { color: theme.colors.focus }
})
