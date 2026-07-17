// Jest stand-in for react-native-bare-kit: the package ships untranspiled ESM the
// RN jest preset does not transform, and its Worklet needs the native module anyway.
// Tests drive AliranBackend through its pending queue / onData instead of a real
// worklet (see SmoothZappingToggle.test.tsx), so start() and IPC are inert here.
class Worklet {
  constructor () {
    this.IPC = { on () {}, write () {} }
  }

  start () {}
}

module.exports = { Worklet }
