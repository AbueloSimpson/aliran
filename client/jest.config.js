module.exports = {
  preset: 'react-native',
  // @aliran/react-native is a file: symlink; jest can follow it to ../sdk/react-native,
  // from where @babel/runtime helpers and peers don't resolve — fall back to THIS
  // app's node_modules (the jest twin of the tsconfig "paths" mapping).
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  moduleNameMapper: {
    // Untranspiled ESM + a native Worklet — stub it so tests can import the backend
    // singleton (they drive its IPC queue directly; see __mocks__/react-native-bare-kit.js).
    '^react-native-bare-kit$': '<rootDir>/__mocks__/react-native-bare-kit.js',
  },
  // COLD CACHE, NOT SLOW TESTS. On `--no-cache` — which is what a fresh CI runner does —
  // several suites lost races against jest's 5 s default while every worker was babel-
  // transforming react-native at once. Each of them passes in well under a second on a
  // warm cache, and passes on a cold one when it is the only suite running, so the
  // failures were contention rather than anything a test asserts. The client suite now
  // has a required CI lane, so the default was going to flake there.
  testTimeout: 30000,
};
