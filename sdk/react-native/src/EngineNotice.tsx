// EngineNotice — the ready-made "this device can't run the P2P engine" screen for
// hosts of single-APK builds (minSdk 24, engine runtime-gated; docs/sdk-guide.md
// "Older Android"). Render it in the `!AliranBackend.isSupported()` branch. Purely
// presentational and content-agnostic on purpose: the optional action button is the
// seam where the HOST offers its own alternative method (its CDN/HLS playback, a
// help page, …) — this SDK ships the notice and the switch, never the delivery.
//
// Everything is overridable per-brand (copy, colors, an extra child block); the
// defaults state the floor honestly: P2P needs Android 10+, and below it no P2P
// data is reachable at all. TV-friendly: the action is a focusable Pressable with
// a visible focus state for D-pad use.

import React, { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

export interface EngineNoticeColors {
  /** Screen background (default near-black '#0B1220'). */
  background?: string
  /** Title text (default '#E5EEF7'). */
  text?: string
  /** Message text (default '#93A4BF'). */
  textDim?: string
  /** Action button fill (default '#0EA5E9'). */
  accent?: string
  /** Action button label (default '#FFFFFF'). */
  onAccent?: string
}

export interface EngineNoticeProps {
  /** Heading — typically your service or app name. */
  title?: string
  /** The explanation line. Default states the Android 10+ engine floor. */
  message?: string
  /** Label for the action button. Rendered only when onAction is also given. */
  actionLabel?: string
  /** The host's fallback seam: mount your own alternative method here. */
  onAction?: () => void
  /** Brand color overrides; anything omitted keeps the dark defaults. */
  colors?: EngineNoticeColors
  /** Optional extra content rendered under the message (e.g. a support hint). */
  children?: ReactNode
}

const DEFAULTS: Required<EngineNoticeColors> = {
  background: '#0B1220',
  text: '#E5EEF7',
  textDim: '#93A4BF',
  accent: '#0EA5E9',
  onAccent: '#FFFFFF'
}

export function EngineNotice ({ title, message, actionLabel, onAction, colors, children }: EngineNoticeProps) {
  const c = { ...DEFAULTS, ...colors }
  const [focused, setFocused] = useState(false)
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {title ? <Text style={[styles.title, { color: c.text }]}>{title}</Text> : null}
      <Text style={[styles.message, { color: c.textDim }]}>
        {message ?? "This device can't run the P2P engine — Android 10 or newer is required."}
      </Text>
      {children}
      {onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: c.accent },
            (focused || pressed) && styles.actionFocused
          ]}
        >
          <Text style={[styles.actionLabel, { color: c.onAccent }]}>{actionLabel ?? 'Use another method'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center'
  },
  message: {
    fontSize: 16,
    textAlign: 'center'
  },
  action: {
    marginTop: 28,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 6
  },
  // Focus/press feedback that reads on a TV without needing theme plumbing.
  actionFocused: {
    transform: [{ scale: 1.06 }],
    opacity: 0.92
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600'
  }
})
