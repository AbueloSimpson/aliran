/**
 * @format
 */

import { AppRegistry } from 'react-native';
// S5b: temporary root is the worklet smoke test (backend integration in progress).
// S6 restores the real App (Login/Home/Player) once navigation deps are wired.
import App from './src/WorkletSmokeTest';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
