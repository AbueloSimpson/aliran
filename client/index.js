/**
 * @format
 */

import { AppRegistry } from 'react-native';
// S6a: real app root (Login -> Home -> Player). The S5b/S5c worklet smoke test
// lives on at ./src/WorkletSmokeTest — swap it in here to re-verify the runtime.
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
