// bare-pack --builtins list (see the `bundle-backend` script in package.json).
//
// Node core specifiers that Bare does not bundle: declaring them here makes bare-pack
// resolve e.g. `node:fs` to an external `builtin:fs` instead of trying to bundle it.
// CAUTION: the react-native-bare-kit worklet runtime (0.13.x) provides NO builtins
// table — loading a `builtin:` ref crashes the worklet (SIGABRT). `crypto`, the one
// name the graph actually imports (@aliran/core -> @noble/hashes cryptoNode.js), is
// therefore NOT listed; it is remapped to @aliran/bare-node-crypto via the global
// imports map (imports.json). The rest stay listed so an unexpected node: import
// fails loudly at pack time rather than after shipping a broken bundle.
module.exports = [
  'assert', 'buffer', 'console', 'constants', 'dns', 'events', 'fs',
  'http', 'https', 'net', 'os', 'path', 'process', 'querystring', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'zlib'
]
