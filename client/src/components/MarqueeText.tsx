// Single-line text that ellipsizes at rest and MARQUEES when it is the focused row
// and does not fit. Built for the channel list on the 32-bit TCL boxes, so the
// constraints are load-bearing:
//
// - PINNED ROW HEIGHT: the list jumps with getItemLayout, whose math is only exact
//   when every row is EXACTLY CHANNEL_ROW_H tall (ChannelRow.tsx). Both modes here —
//   the resting ellipsized <Text> and the scrolling Animated.Text — render the same
//   single line at the same font styles, so swapping between them never moves layout
//   (and never flashes: same glyphs, same baseline, same left edge).
// - DEFERRED MOUNT: the scroller does not exist until focus has been HELD for
//   startDelayMs. Mounting it on the focus frame would create (and on the next
//   D-pad step destroy) a native horizontal ScrollView + text + animated node per
//   step — exactly the per-step churn this branch exists to remove. During D-pad
//   transit a row renders nothing but the same static <Text> it always had; only a
//   held focus pays for the scroller, and the arm-timer resets on blur/text change,
//   so a fast focus flip can never reach it by construction.
// - DRIVERS, precisely: the scroll TRANSFORM runs on the native driver — while the
//   text is moving, the JS thread does zero work per frame. The CADENCE (the
//   per-timing delays and each loop restart) rides JS timers: a couple of callbacks
//   per multi-second cycle, not per frame. Do NOT "fix" the loop to a native one —
//   Animated.sequence cannot start natively (its _startNativeLoop throws), and the
//   JS restart path is the supported one for composed animations.
// - AT MOST ONE LOOP: `active` rides row focus, and only one row is ever focused,
//   so the app never runs more than one marquee at a time.
// - REDUCED MOTION: the OS "remove animations" setting (../motion) keeps the static
//   ellipsis even on the focused row — the fill/border focus grammar still announces
//   focus, exactly like the row's scale lift.
//
// Measurement: the outer clip View reports the slot width; the full text width comes
// from the scrolling child itself, laid out inside a scroll-disabled horizontal
// ScrollView — the one RN container that measures a child beyond its parent's width
// (Yoga otherwise wraps text at the parent edge and never reports intrinsic width).
// Text fits after all -> back to the plain ellipsized Text. The measurement is keyed
// on the text, so a title change re-measures from scratch (and re-defers first —
// never a mid-title jump).
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, Animated, Easing, StyleSheet } from 'react-native'
import type { StyleProp, TextStyle, ViewStyle, LayoutChangeEvent } from 'react-native'
import { prefersReducedMotion } from '../motion'
import { theme } from '../theme'

export interface MarqueeTextProps {
  text: string
  /** Scroll only while true (the host's focus signal) — false rests on the ellipsis. */
  active?: boolean
  style?: StyleProp<TextStyle>
  containerStyle?: StyleProp<ViewStyle>
  /** Scroll speed in px/s. TV default is slower: 10-foot reading distance. */
  speed?: number
  /** Held-focus threshold before the scroller even mounts, and the read-pause at the
   *  start of every loop. First motion therefore lands ~2x this after focus — the
   *  price of mounting nothing at all during D-pad transit. */
  startDelayMs?: number
  /** Rest at the end, fully revealed, before snapping back. */
  endDelayMs?: number
}

// Overflow epsilon: a few px of overhang is rounding and font hinting, not a title
// worth scrolling — at 10 feet a permanent twitch loop over a 2 px spill is pure
// noise. Anything a viewer would actually miss overflows by far more than this.
const OVERFLOW_EPS = 8

export function MarqueeText ({
  text,
  active = false,
  style,
  containerStyle,
  speed = theme.isTV ? 40 : 60,
  startDelayMs = 800,
  endDelayMs = 1200
}: MarqueeTextProps) {
  const [containerW, setContainerW] = useState(0)
  // Focus held long enough to be worth a scroller? Armed after startDelayMs of
  // continuous `active`; disarmed (and the pending timer cleared) on blur and on a
  // text change — see DEFERRED MOUNT above.
  const [armed, setArmed] = useState(false)
  // Full (unconstrained) text width, remembered WITH the text it measured — a stale
  // width from the previous title must read as "unknown", not as an answer.
  const [measured, setMeasured] = useState<{ text: string; w: number } | null>(null)
  const offset = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!active) { setArmed(false); return }
    setArmed(false) // a text change while focused re-defers from zero
    const id = setTimeout(() => setArmed(true), startDelayMs)
    return () => clearTimeout(id)
  }, [active, text, startDelayMs])

  const textW = measured !== null && measured.text === text ? measured.w : null
  const wantMotion = active && !prefersReducedMotion()
  const overflows = textW !== null && textW > containerW + OVERFLOW_EPS
  // Mount the scroller only under a HELD focus; while the width is unknown too —
  // the measurement IS its layout.
  const scrolling = wantMotion && armed && (textW === null || overflows)
  const animating = wantMotion && armed && overflows

  useEffect(() => {
    if (!animating || textW === null) return
    const dist = textW - containerW
    // The pauses live INSIDE the timing configs: Animated.delay is hardcoded to the
    // JS driver (two timers + a dummy value per cycle), while a timing's own `delay`
    // rides the native start like the rest of the config. Each loop restart begins
    // with the startDelayMs read-pause parked at position 0.
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(offset, { toValue: -dist, duration: (dist / Math.max(1, speed)) * 1000, delay: startDelayMs, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(offset, { toValue: 0, duration: 250, delay: endDelayMs, useNativeDriver: true })
    ]))
    loop.start()
    // Blur, unmount, text/geometry change: stop the loop and park the text at the
    // start — the resting <Text> must take over exactly where a fresh row begins.
    return () => { loop.stop(); offset.setValue(0) }
  }, [animating, textW, containerW, speed, startDelayMs, endDelayMs, offset])

  const onContainerLayout = (e: LayoutChangeEvent) => {
    // A zero-width pass (collapsed flex mid-layout) is not an answer — acting on it
    // would misread every title as overflowing.
    const w = e.nativeEvent.layout.width
    if (w > 0) setContainerW(w)
  }
  const onTextLayout = (e: LayoutChangeEvent) => setMeasured({ text, w: e.nativeEvent.layout.width })

  return (
    // The container measurement is attached ONLY while `active`: containerW is
    // consulted only after the arm delay, and ~15 resting rows each paying a
    // bridge callback + a state write on mount/scroll-in is exactly the per-row
    // idle cost this component exists to avoid. Attaching the handler on the
    // focus render triggers a fresh layout dispatch for this view, so the armed
    // flow still measures before the scroller needs the width.
    <View style={[styles.clip, containerStyle]} onLayout={active ? onContainerLayout : undefined}>
      {scrolling
        ? (
          <ScrollView
            horizontal
            // scrollEnabled={false} is load-bearing for TV FOCUS, not just touch:
            // Android's horizontal ScrollView manager routes setScrollEnabled into
            // view.setFocusable(value), and the DEFAULT is focusable — without this,
            // every focused row would grow a D-pad focus target inside itself.
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            style={styles.scroller}
            pointerEvents="none"
          >
            {/* numberOfLines={1}: inside the unbounded scroller this cannot truncate
                (available width is infinite) — it only forbids WRAPPING, so a stray
                \n in a feed-sourced title cannot break the pinned row height. */}
            <Animated.Text numberOfLines={1} style={[style, { transform: [{ translateX: offset }] }]} onLayout={onTextLayout}>{text}</Animated.Text>
          </ScrollView>
          )
        : <Text numberOfLines={1} ellipsizeMode="tail" style={style}>{text}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  // The clip window. The host decides how the slot flexes in its row (containerStyle);
  // overflow hidden is what turns the translateX into a marquee instead of an overlap.
  clip: { overflow: 'hidden' },
  // The ScrollView is here ONLY as an unbounded-measure container (scroll disabled,
  // no indicator, no touch) — flexGrow 0 keeps it from stretching the clip window.
  scroller: { flexGrow: 0 }
})
