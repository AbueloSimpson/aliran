// "SORT BY" picker for the Movies & Series grid (S54d, design D4 / mockup screen 3) —
// the desktop twin of client/src/components/SortMenu.tsx.
//
// Same shape as this app's TrackMenu: a dim full-screen backdrop that dismisses on
// click, a panel with the mockup's coloured header bar, and one row per option. The
// active row is marked "SELECTED" on the right, exactly like the mockup.
//
// Keyboard: arrows move, Enter picks, Esc closes. The listener is on the CAPTURE phase
// and stops propagation, so the grid underneath never sees these keys while the menu
// is open (the TrackMenu rule).

import React, { useEffect, useState } from 'react'
import { VOD_SORTS, type VodSortKey } from '../vod-sort'

export interface SortMenuProps {
  /** The sort currently in force — its row is the one marked SELECTED. */
  value: VodSortKey
  onSelect: (key: VodSortKey) => void
  onClose: () => void
}

export function SortMenu ({ value, onSelect, onClose }: SortMenuProps) {
  // Opening lands on the option already in force, so Enter is a no-op rather than a
  // surprise (and the arrows start from where the viewer actually is).
  const [focus, setFocus] = useState(() => Math.max(0, VOD_SORTS.findIndex((o) => o.key === value)))

  // Choosing a sort applies it AND dismisses: it is a one-shot action, and leaving the
  // panel over the grid was the annoyance.
  const choose = (key: VodSortKey) => { onSelect(key); onClose() }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((i) => Math.min(VOD_SORTS.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((i) => Math.max(0, i - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); const o = VOD_SORTS[focus]; if (o) choose(o.key) }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    // Capture phase so the grid beneath never sees these keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, value])

  return (
    <div className="sort-overlay" onClick={onClose}>
      <div className="sort-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sort-heading">SORT BY</div>
        {VOD_SORTS.map((o, i) => (
          <div
            key={o.key}
            className={'sort-row' + (o.key === value ? ' active' : '') + (i === focus ? ' focused' : '')}
            onMouseMove={() => setFocus(i)}
            onClick={() => choose(o.key)}
          >
            <span className="sort-label">{o.label}</span>
            {o.key === value && <span className="sort-selected">SELECTED</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
