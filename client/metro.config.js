const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @aliran/react-native and @aliran/i18n are file: deps symlinked from ../sdk/react-native
 * and ../i18n (outside the project root): watch their real paths, and let their imports
 * (react, react-native-video, react-native-bare-kit, b4a) resolve from THIS app's
 * node_modules. Both ship TypeScript source with no build step, so Metro is what
 * compiles them — a locale catalog edit is picked up by the same watcher.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [
    path.resolve(__dirname, '../sdk/react-native'),
    path.resolve(__dirname, '../i18n'),
  ],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
