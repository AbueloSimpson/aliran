export { AliranBackend } from './backend'
export type { Stream, BackendMessage, HybridConfig, TuneConfig, ZapPrefetchConfig, StartOptions, SavedCredentials, SavedService, PairingResult, PairingErrorCode, VodConfig, VodListEntry, VodHistoryEntry, UpdatePlatform, AppUpdateInfo, UpdateEntry, UpdateCheckStatus, UpdateCheckResult, UpdateMessage } from './backend'
// Phone -> TV sign-in handover (sdk/signin-pair.js): the progress stream a host renders
// and the two start results. Drive it with backend.startSignIn() on the TV and
// backend.sendSignIn(code) on the phone, and answer the three questions in the stream —
// they BLOCK. `remote: { sendToTv: true }` at start() is what the phone half needs.
// SIGNIN_PAIR_ERRORS / isSigninPairError() are the runtime whitelist: the engine's
// vocabulary grows, this build's copy of it does not, so check a reason before you
// switch on it and always keep a sentence for the ones you do not know.
export type { RemoteFeatures, SigninPairState, SigninPairErrorCode, SigninPairReason, SigninPairInfo, SignInStartResult, SignInSendResult, ResumeSignInResult, ResumeSignInError } from './backend'
export { SIGNIN_PAIR_ERRORS, isSigninPairError } from './backend'
// "Send to TV", the PLAYBACK half. TWO different things behind one phrase, and the
// difference is the viewer's to know: backend.startCast() makes THIS device the origin
// server for a Chromecast (it stays awake, it serves, and the media URL is readable off
// the receiver by anything on the network — pass `receiverHost` when you know it);
// backend.remotePlay() asks another Aliran device on the same account to pull the
// channel itself, after which this device is free. The second needs `remote: {
// control: true }` at start(); the first needs nothing.
export type { CastSessionInfo, CastEndedReason, CastStartResult, RemoteIdentity, RemotePeer, RemoteInfo, RemoteStatusState, RemoteControlErrorCode, RemoteCommandResult, RemoteStartResult } from './backend'
// Platform key store (Android Keystore), native half. The binding uses it internally to
// keep a television's sign-in across restarts — `remote: { keepSignIn: true }` at start(),
// then backend.resumeSignIn() on the next boot. Exported so a host can REPORT what its
// device offers (secureKeyStatus) and can destroy the key on its own terms. See
// src/secure-key.ts and docs/security-model.md, "Account keys at rest".
export { secureKeyStatus, secureReset } from './secure-key'
export type { SecureKeyStatus } from './secure-key'
// sourceType: the container hint a redirect url needs when it does not name its own
// (see AliranVideo.tsx). Exported so the VOD screen, which drives react-native-video
// directly instead of going through <AliranVideo>, classifies urls the same way.
export { AliranVideo, SelectedTrackType, sourceType } from './AliranVideo'
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
