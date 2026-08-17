// COMPILE STUB — not the real BareKit.
//
// WHY THIS EXISTS. aliran-kit's unit tests are plain JVM: RecoveryLadders, Messages,
// SourceType and LineAccumulator import nothing native and nothing from Android (the
// ladders were extracted out of the view precisely so they could be tested that way).
// But ONE class in the main source set does reach for the engine — AliranBackend's
// private BareEngineHost, which names to.holepunch.bare.kit.Worklet/IPC — and Kotlin
// has to resolve those names to compile the module at all. The real classes live in a
// jar vendored out of client/node_modules/react-native-bare-kit, which is an npm
// install of the React Native app's toolchain: about a gigabyte of tree, a
// --legacy-peer-deps ERESOLVE trap, and nothing whatsoever that the tests exercise.
//
// So: when that jar is missing, the module compiles BareEngineHost against these two
// files instead (build.gradle.kts adds this source set only then, and never alongside
// the real jar — the two would collide). That is what makes `:aliran-kit:testDebugUnitTest`
// runnable on a bare checkout, which is what CI does (.github/workflows/ci.yml, the
// `sdk-android` job).
//
// THE TRADE, STATED PLAINLY: CI therefore never compiles BareEngineHost against the
// REAL BareKit API. A signature change upstream breaks the first developer to build an
// AAR or the demo APK, not the CI lane. That is the deliberate price of a lane that
// runs the ~50 recovery/protocol tests in a minute instead of installing the RN app to
// reach them; the signatures below are copied verbatim from the shipped jar and are a
// tiny, long-stable surface (Worklet + IPC, five methods between them):
//
//   public class IPC implements Closeable {
//     public IPC(Worklet);
//     public void readable(IPC.PollCallback);
//     public ByteBuffer read();
//     public void write(ByteBuffer, IPC.WriteCallback);
//     …
//   }
//   public interface IPC.PollCallback  { void apply(); }
//   public interface IPC.WriteCallback { void apply(Throwable); }
//
// Every entry point throws: a build that got this far has no engine bundle asset and no
// per-ABI .so set either, so it could never have played anything — this just says so in
// one line instead of a FileNotFoundException three layers down.
package to.holepunch.bare.kit;

import java.nio.ByteBuffer;

public class IPC {
  public interface PollCallback {
    void apply();
  }

  public interface WriteCallback {
    void apply(Throwable error);
  }

  public IPC(Worklet worklet) {
    throw new UnsupportedOperationException(Worklet.unavailable());
  }

  public void readable(PollCallback callback) {
    throw new UnsupportedOperationException(Worklet.unavailable());
  }

  public ByteBuffer read() {
    throw new UnsupportedOperationException(Worklet.unavailable());
  }

  public void write(ByteBuffer buffer, WriteCallback callback) {
    throw new UnsupportedOperationException(Worklet.unavailable());
  }
}
