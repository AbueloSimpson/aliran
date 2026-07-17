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
};
