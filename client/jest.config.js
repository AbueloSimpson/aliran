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
    // The Cast library. MAPPED HERE RATHER THAN MOCKED PER SUITE, and that is not a
    // stylistic preference: it is installed, so a per-suite `jest.mock(..., { virtual:
    // true })` was registered under a module id that jest's per-worker resolver cache had
    // often already claimed for the real package — and the two cast suites then ran
    // against a library with no native side and failed as a block, on roughly one run in
    // three, ordering-dependent. A mapped path has ONE id whoever asks for it. The full
    // mechanism is written up in __mocks__/react-native-google-cast.js.
    '^react-native-google-cast$': '<rootDir>/__mocks__/react-native-google-cast.js',
  },
  // COLD CACHE, NOT SLOW TESTS. On `--no-cache` — which is what a fresh CI runner does —
  // several suites lost races against jest's 5 s default while every worker was babel-
  // transforming react-native at once. Each of them passes in well under a second on a
  // warm cache, and passes on a cold one when it is the only suite running, so the
  // failures were contention rather than anything a test asserts. The client suite now
  // has a required CI lane, so the default was going to flake there.
  //
  // IT COVERS SLOWNESS AND NOTHING ELSE. The cast suites' whole-file failures were never
  // this: they are assertion failures inside 14-second runs, they reproduce in band, and
  // raising a timeout could not have touched them. See the moduleNameMapper entry above.
  testTimeout: 30000,
  // …and 30 s was still not enough at jest's default width, because the default is sized
  // off CORES and the cost being paid is MEMORY. jest runs `cores - 1` workers; each is a
  // node process babel-transforming react-native, and on a cold cache seven of them on an
  // 8-core/8.5 GB machine page against each other until a suite's FIRST test — the one
  // billed for transforming everything the file imports — takes more than 30 s on its own.
  // Measured here on `--no-cache`, three runs each:
  //
  //   default (7 workers)   91–96 s, and one run in three failed — 5 suites, one timeout
  //                         each, always the first test of the suite
  //   maxWorkers 2          47–55 s, green
  //   maxWorkers '50%'      50–54 s, green
  //
  // So the cap is not a way of making a race less likely: it removes the oversubscription
  // that causes the slowness, and it is roughly twice as FAST for doing so. A percentage
  // rather than a fixed 2, so a CI runner with a different shape gets a proportionate
  // answer; `--maxWorkers` on the command line still overrides it.
  maxWorkers: '50%',
};
