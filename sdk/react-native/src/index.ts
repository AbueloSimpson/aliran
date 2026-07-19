export { AliranBackend } from './backend'
export type { Stream, BackendMessage, HybridConfig, TuneConfig, ZapPrefetchConfig, StartOptions, SavedCredentials } from './backend'
export { AliranVideo, SelectedTrackType } from './AliranVideo'
export type { AliranVideoProps, TuneEvent, TunePhase, SelectedTrack, AudioTrack, TextTrack } from './AliranVideo'
// Remote EPG data layer (S27): the program-guide fetch/cache/now-next service +
// React hook. A channel's `epgUrl`/`epgId` (from the panel catalog) point at the feed;
// apps render their own visuals from this. See src/epg.ts.
export { EpgService, epg } from './epg'
export type { EpgProgram, NowNext, EpgServiceOpts } from './epg'
export { useEpg } from './useEpg'
