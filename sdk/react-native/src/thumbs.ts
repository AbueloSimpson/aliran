// Live-thumbnail hook (@aliran/react-native): thumb-first channel art, shared by every
// app on the SDK (it was born duplicated in the client's ChannelRow and the desktop's
// ChannelList — plain React, no react-native imports, so it lives here). The engine
// hands out thumbBase for EVERY channel, so a 404 is the normal "nothing to show"
// answer (thumbnails off, feed not warm, metered network) and the caller falls back to
// the station logo — never a broken-image state. Two details carry the feature:
//   the ?t= stamp — the thumbnail rolls IN PLACE, so without a changing URL the image
//     cache would pin the first frame forever;
//   the tick lives in the CALLER (one hook per visible row) — a list unmounts rows that
//     scroll away, so only the visible channels ever fetch, and each re-probes after a
//     miss (the SDK warms a cold feed on that first miss, so the picture appears on the
//     next tick instead of never).
import { useState, useEffect } from 'react'

// Live thumbnail refresh cadence — the broadcaster rolls /thumb.jpg at the same period,
// so a faster tick would re-fetch the frame the caller is already showing.
const THUMB_REFRESH_MS = 30000

export function useChannelThumb (thumbBase?: string): [string | null, () => void] {
  const [stamp, setStamp] = useState(0)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!thumbBase) return
    setBroken(false)
    const timer = setInterval(() => { setStamp(Date.now()); setBroken(false) }, THUMB_REFRESH_MS)
    return () => clearInterval(timer)
  }, [thumbBase])
  return [thumbBase && !broken ? `${thumbBase}?t=${stamp}` : null, () => setBroken(true)]
}
