// bare-pack --builtins list (see the `bundle-backend` script in package.json).
//
// Node core specifiers that Bare does not bundle: declaring them here makes bare-pack
// resolve e.g. `node:crypto` to an external `builtin:crypto` provided by the worklet
// runtime, instead of trying to bundle it. Currently `crypto` is the only one actually
// imported (via @aliran/core -> @noble/hashes cryptoNode.js, which only needs WebCrypto);
// the rest are listed defensively so any future node: import resolves without re-tooling.
// Wiring these builtins into the react-native-bare-kit worklet runtime is S5b's job.
module.exports = [
  'assert', 'buffer', 'console', 'constants', 'crypto', 'dns', 'events', 'fs',
  'http', 'https', 'net', 'os', 'path', 'process', 'querystring', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'zlib'
]
