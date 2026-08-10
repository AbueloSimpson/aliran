// Shared EPG hook (@aliran/react-native): fetch a channel's now/next on open and
// refresh on a slow tick so the current program rolls over (and any progress bar
// advances) while the view stays open. The fetch is cached per feed URL (./epg), so
// the tick is nearly free. Any app on the SDK can render its own guide from this.
import { useState, useEffect } from 'react'
import { epg, type EpgProgram, type NowNext } from './epg'

export function useEpg (epgUrl?: string, epgId?: string, guideBase?: string): { data: NowNext | null; loaded: boolean } {
  const [data, setData] = useState<NowNext | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    setData(null); setLoaded(false)
    // The P2P guide (guideBase) needs no epgUrl/epgId — either source alone works.
    if (!guideBase && (!epgUrl || !epgId)) { setLoaded(true); return }
    const run = () => epg.getNowNext(epgUrl, epgId, guideBase).then((d) => { if (alive) { setData(d); setLoaded(true) } })
    run()
    const timer = setInterval(run, 30000)
    return () => { alive = false; clearInterval(timer) }
  }, [epgUrl, epgId, guideBase])
  return { data, loaded }
}

// Full-range core shared by useEpgPrograms and useEpgProgramsState (WS17): the
// channel's whole program list over the service's default window (now − 6 h …
// now + 48 h), refreshed on a slow tick so a guide left open rolls forward. The
// underlying caches floor at minRefetchMs, so the tick is nearly free — an
// unchanged guide costs no network at all. `ready` is the loading truth the plain
// hook cannot express: false until the FIRST resolution for the current inputs
// lands, so a renderer can tell "still fetching" from "genuinely no guide" —
// guide-less inputs (no guideBase and no epgUrl/epgId pair) resolve ready:true
// immediately with [] (nothing will ever be fetched).
function useEpgProgramsCore (epgUrl?: string, epgId?: string, guideBase?: string): { programs: EpgProgram[]; ready: boolean } {
  const [state, setState] = useState<{ programs: EpgProgram[]; ready: boolean }>({ programs: [], ready: false })
  useEffect(() => {
    let alive = true
    // The P2P guide (guideBase) needs no epgUrl/epgId — either source alone works.
    if (!guideBase && (!epgUrl || !epgId)) { setState({ programs: [], ready: true }); return }
    setState({ programs: [], ready: false })
    const run = () => epg.getPrograms(epgUrl, epgId, guideBase).then((p) => { if (alive) setState({ programs: p, ready: true }) })
    run()
    const timer = setInterval(run, 5 * 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [epgUrl, epgId, guideBase])
  return state
}

// Full-range sibling for guide screens (WS0) — the original programs-only shape,
// unchanged for existing consumers: [] both while loading and for a channel with
// no guide (use useEpgProgramsState when that difference matters).
export function useEpgPrograms (epgUrl?: string, epgId?: string, guideBase?: string): EpgProgram[] {
  return useEpgProgramsCore(epgUrl, epgId, guideBase).programs
}

// State-carrying variant (WS17): the same fetch/caching path plus the `ready`
// flag, so guide UIs can show a loading skeleton instead of the honest
// "no guide" answer during the first fetch.
export function useEpgProgramsState (epgUrl?: string, epgId?: string, guideBase?: string): { programs: EpgProgram[]; ready: boolean } {
  return useEpgProgramsCore(epgUrl, epgId, guideBase)
}
