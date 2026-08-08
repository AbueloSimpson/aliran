// Far-left category rail (vertical text list, the reference's focus grammar:
// selected = accent underline). Two-level: the top level lists categories (a "›"
// marks ones with sub-categories); picking such a category DRILLS in — the rail then
// shows a pinned "‹ Parent" back header with the parent's sub-categories beneath.
// The drill state lives in LiveScreen; this renders what it's given.

import React from 'react'
import { getLocale } from '@aliran/i18n'

export interface CategoryRailItem {
  /** Full category key ('All' | 'Anime' | 'Anime/Español'). */
  key: string
  /** Display text (top-level name, or the sub's leaf label). */
  label: string
  hasChildren?: boolean
}

export interface CategoryRailProps {
  items: CategoryRailItem[]
  selected: string
  /** Index the keyboard focus sits on (LiveScreen owns rail keys). -1 = not in the rail. */
  focusIndex: number
  parentHeader?: { label: string; onBack: () => void }
  onSelect: (key: string) => void
  onActivity?: () => void
}

// The rail is MIXED copy: 'All' is ours and translated, every other label is the
// operator's own category name in the operator's language. There is no casing rule that
// is right for both, so the whole rail follows the VIEWER's locale (S56f decision) —
// a Turkish viewer's "i" upper-cases to "İ" everywhere on the surface, consistently.
export function CategoryRail ({ items, selected, focusIndex, parentHeader, onSelect, onActivity }: CategoryRailProps) {
  return (
    <div className="category-rail" onScroll={onActivity}>
      {parentHeader && (
        <div className="rail-back" onClick={() => { onActivity?.(); parentHeader.onBack() }}>
          ‹ {parentHeader.label.toLocaleUpperCase(getLocale())}
        </div>
      )}
      <div className="rail-items">
        {items.map((it, i) => (
          <div
            key={it.key}
            ref={(el) => { if (i === focusIndex) el?.scrollIntoView({ block: 'nearest' }) }}
            className={'rail-item' + (it.key === selected ? ' selected' : '') + (i === focusIndex ? ' focused' : '')}
            onMouseMove={onActivity}
            onClick={() => { onActivity?.(); onSelect(it.key) }}
          >
            <span className="rail-label">{it.label.toLocaleUpperCase(getLocale())}</span>
            {it.hasChildren && <span className="rail-chevron">›</span>}
            <span className="rail-underline" />
          </div>
        ))}
      </div>
    </div>
  )
}
