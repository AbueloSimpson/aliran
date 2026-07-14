const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @aliran/react-native is a file: dep symlinked from ../sdk/react-native (outside the
 * project root): watch its real path, and let its imports (react, react-native-video,
 * react-native-bare-kit, b4a) resolve from THIS app's node_modules.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '../sdk/react-native')],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
