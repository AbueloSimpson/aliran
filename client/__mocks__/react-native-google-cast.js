// Jest stand-in for react-native-google-cast — resolved by CONFIG, not by a jest.mock()
// in each suite, and that distinction is the whole point of this file.
//
// WHY NOT A PER-SUITE VIRTUAL MOCK. The package is a real dependency and IS installed
// here, so `require('react-native-google-cast')` in src/cast.ts succeeds and hands back a
// CastContext whose every method calls a native module that does not exist in a test run.
// Two suites used to shadow it with `jest.mock(..., { virtual: true })`, and that worked
// only about two runs in three:
//
//   jest keeps ONE Resolver per worker process (jest-runner/testWorker.js holds it in a
//   module-level Map keyed by config id; --runInBand keeps one on the test context), and
//   that Resolver's module-id cache is keyed by (requiring file, module name) and is
//   NEVER cleared between test files. A `virtual: true` mock is registered under an id
//   derived from the file that CALLED jest.mock. So if any earlier suite in the same
//   worker had already required this package from src/cast.ts WITHOUT a mock — which is
//   every suite that renders a screen: the sign-in, picker, service, zapping, language,
//   splash and parental suites all reach src/cast.ts — the cache already held the REAL
//   resolved path as the id for that requiring file. The later suite's virtual mock went
//   in under a different id, the require never matched it, and the cast suites silently
//   ran against the real library: cast.connect() threw on the absent native side and
//   EVERY send failed 'cast-connect'. Which suites share a worker, and in what order,
//   changes from run to run — hence a whole-file failure about one run in three, in
//   parallel and in band alike.
//
//   A path resolved through moduleNameMapper has one id whoever asks, so the mock cannot
//   be missed. See jest.config.js.
//
// WHAT IT ANSWERS. "No Play Services" — a real device configuration, not a fiction (Fire
// OS sticks, AOSP boxes, de-Googled phones; see src/cast.ts), and the honest description
// of a run with no native side. castAvailable() answers false and every entry point below
// it degrades to "cast is not available here". A suite that needs a live receiver passes
// its own jest.mock factory, which takes precedence over this file.
module.exports = {
  CastContext: {
    getPlayServicesState: async () => 'missing',
    getDiscoveryManager: () => null,
    getSessionManager: () => null
  }
}
