export { AliranBackend } from './backend'
export type { Stream, BackendMessage, HybridConfig, TuneConfig, ZapPrefetchConfig, StartOptions, SavedCredentials, SavedService, PairingResult, PairingErrorCode, VodConfig, VodListEntry, VodHistoryEntry, UpdatePlatform, AppUpdateInfo, UpdateEntry, UpdateCheckStatus, UpdateCheckResult, UpdateMessage } from './backend'
export { AliranVideo, SelectedTrackType } from './AliranVideo'
export type { AliranVideoProps, AliranVideoHandle, TuneEvent, TunePhase, SelectedTrack, AudioTrack, TextTrack, BufferConfig } from './AliranVideo'
// Ready-made "engine can't run here" screen for single-APK builds: render in the
// !AliranBackend.isSupported() branch; the optional action button is the host's
// seam for offering its own alternative method. See docs/sdk-guide.md.
export { EngineNotice } from './EngineNotice'
export type { EngineNoticeProps, EngineNoticeColors } from './EngineNotice'
// Remote EPG data layer (S27): the program-guide fetch/cache/now-next service +
// React hook. A channel's `epgUrl`/`epgId` (from the panel catalog) point at the feed;
// apps render their own visuals from this. See src/epg.ts.
export { EpgService, epg, programProgress } from './epg'
export type { EpgProgram, NowNext, EpgServiceOpts } from './epg'
export { useEpg, useEpgPrograms, useEpgProgramsState } from './useEpg'
// Live-thumbnail hook (WS0): thumb-first channel art off the engine's thumbBase, with
// the rolling ?t= stamp and 404→logo fallback semantics. See src/thumbs.ts.
export { useChannelThumb } from './thumbs'
// Viewer problem reports (S50c): the category enum + labels + the consent line a
// "Report a problem" UI must show. Submit with backend.sendReport(); the answer
// arrives as {type:'report-result'}. See src/report.ts.
export { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_CONSENT, REPORT_TEXT_MAX } from './report'
export type { ReportCategory, ReportError } from './report'
// OTA app updates, native half (Android installer — this package's android/ library):
// build identity for backend.checkUpdate(), the install-permission gate, and the
// PackageInstaller handoff for the verified file 'update-ready' points at. Safe to
// call anywhere — degrades gracefully where the module is absent. See src/update.ts.
export { getAppInfo, canRequestInstall, openInstallSettings, installApk, onInstallResult } from './update'
export type { NativeAppInfo } from './update'
