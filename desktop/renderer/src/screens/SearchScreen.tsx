// Search — client-side filter over the entitled catalog (title / description /
// category). No server roundtrip: the whole display list is already replicated.
// Results reuse ChannelList; selecting one jumps into Live TV.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@aliran/i18n'
import { backend } from '../bridge'
import type { Stream } from '../types'
import { channelNumbers, sortByCuration } from '../catalog'
import { ChannelList } from '../components/ChannelList'
import { visibleStreams } from '../parental'

export function SearchScreen ({ onWatch, onBack }: { onWatch: (streamId: string) => void; onBack: () => void }) {
  const { t } = useI18n()
  const [streams, setStreams] = useState<Stream[]>(() => visibleStreams(backend.streams))
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return backend.onMessage((m) => { if (m.type === 'streams') setStreams(visibleStreams(m.streams)) })
  }, [])

  const numbers = useMemo(() => channelNumbers(streams), [streams])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sortByCuration(streams)
    return sortByCuration(streams.filter((s) =>
      s.title?.toLowerCase().includes(q) ||
      s.description?.toLowerCase().includes(q) ||
      s.category?.some((c) => c.toLowerCase().includes(q))
    ))
  }, [streams, query])

  return (
    <div className="search">
      <div className="section-header">{t('search.header')}</div>
      <input
        ref={inputRef}
        className="search-input"
        placeholder={t('search.placeholder')}
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // The input owns typing; hand list navigation and Esc to the list below by
          // blurring (the list's window listener takes over), Esc directly = back.
          if (e.key === 'Escape') { e.preventDefault(); onBack() }
          if (e.key === 'ArrowDown') { e.preventDefault(); inputRef.current?.blur() }
        }}
      />
      {results.length === 0
        ? <div className="empty-center"><div className="empty-title">{t('search.noResults', { query: query.trim() })}</div></div>
        : (
          <div className="search-results">
            <ChannelList
              streams={results}
              heading={query.trim() ? t('search.resultsHeading', { count: results.length }) : t('search.allChannels')}
              numbers={numbers}
              playingId={null}
              favorites={backend.favorites}
              onSelect={(s) => onWatch(s.id)}
              onClose={onBack}
            />
          </div>
          )}
    </div>
  )
}
