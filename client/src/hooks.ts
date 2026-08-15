// Shared tiny hooks (client-wide). First resident: useStableCallback, the memo
// counterpart to LiveScreen's handler props.
import { useRef } from 'react'

/**
 * Identity-stable wrapper around a handler that is re-created every render.
 *
 * LiveScreen's handlers close over live state (play() reads playingId/error, the
 * overlay setters read refs), so they cannot be useCallback'd without either stale
 * captures or a dependency list that defeats the point. The memoized panels
 * (ChannelListPanel and its rows) only hold their memo while every prop keeps its
 * identity — so the host passes THIS wrapper, whose identity never changes, and the
 * wrapper forwards to whatever the latest render's closure is.
 *
 * The ref is (re)written during render, which is safe here because the value is only
 * ever read inside event handlers — never during another component's render. Not for
 * anything called at render time. The handler must always be a function: an
 * optional/undefined slot belongs on the JSX prop (`cond ? undefined : stable`),
 * not inside the wrapper — see LiveScreen's onGuide error gate.
 */
export function useStableCallback<A extends unknown[], R> (fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  latest.current = fn
  const stable = useRef((...args: A) => latest.current(...args))
  return stable.current
}
