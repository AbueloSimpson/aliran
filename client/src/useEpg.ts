// Shared EPG hook: fetch a channel's now/next on open and refresh on a slow tick so
// the current program rolls over (and any progress bar advances) while the view stays
// open. The fetch is cached per feed URL (src/epg.ts), so the tick is nearly free.
// Used by both the Info panel (Now/Up-next guide) and the bottom bar (now-playing).
import { useState, useEffect } from 'react'
import { epg, type NowNext } from './epg'

export function useEpg (epgUrl?: string, epgId?: string): { data: NowNext | null; loaded: boolean } {
  const [data, setData] = useState<NowNext | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    setData(null); setLoaded(false)
    if (!epgUrl || !epgId) { setLoaded(true); return }
    const run = () => epg.getNowNext(epgUrl, epgId).then((d) => { if (alive) { setData(d); setLoaded(true) } })
    run()
    const timer = setInterval(run, 30000)
    return () => { alive = false; clearInterval(timer) }
  }, [epgUrl, epgId])
  return { data, loaded }
}
