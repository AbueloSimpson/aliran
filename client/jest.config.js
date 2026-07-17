module.exports = {
  preset: 'react-native',
  // @aliran/react-native is a file: symlink; jest can follow it to ../sdk/react-native,
  // from where @babel/runtime helpers and peers don't resolve — fall back to THIS
  // app's node_modules (the jest twin of the tsconfig "paths" mapping).
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
};
