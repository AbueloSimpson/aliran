// React Native CLI config. One job (legacy Android flavor — docs/sdk-guide.md
// "Older Android"): with ALIRAN_LEGACY=1 the build EXCLUDES react-native-bare-kit
// from Android autolinking. The engine is a C++ TurboModule statically linked into
// the app's libappmodules.so, and its prebuilt libbare-kit.so needs ELF TLS — a
// libc feature Android only ships from 10 (API 29) — so merely lowering minSdk
// would crash the app at React init on older devices; the module must not be
// linked at all. Without it, AliranBackend.isSupported() reports false and the
// SDK stays silently inactive. minSdk switches on the same env var
// (android/build.gradle), and android/settings.gradle dirties the autolinking
// cache when the mode flips (the cache keys on lock files, not on env).
const legacy = process.env.ALIRAN_LEGACY === '1'

module.exports = {
  dependencies: legacy
    ? { 'react-native-bare-kit': { platforms: { android: null } } }
    : {}
}
