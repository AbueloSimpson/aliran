// Jest stand-in for react-native-bare-kit: the package ships untranspiled ESM the
// RN jest preset does not transform, and its Worklet needs the native module anyway.
// Tests drive AliranBackend through its pending queue / onData instead of a real
// worklet (see SmoothZappingToggle.test.tsx), so start() and IPC are inert here.
class Worklet {
  constructor () {
    this.IPC = { on () {}, write () {} }
    this.started = false
  }

  // THE SECOND START THROWS, exactly as the native one does, and that is the only part
  // of this stub with any behaviour in it. Android recreates the ACTIVITY over a process
  // — and a worklet — that never stopped, so the RN root re-runs and the host boots the
  // backend a second time. An inert start() made that look free, and the wedge it really
  // caused (an app stuck on "Connecting…" until a force-stop) reached hardware with a
  // full green suite behind it. See __tests__/WorkletRestart.test.tsx.
  start () {
    if (this.started) throw new Error('Worklet has already been started')
    this.started = true
  }
}

module.exports = { Worklet }
