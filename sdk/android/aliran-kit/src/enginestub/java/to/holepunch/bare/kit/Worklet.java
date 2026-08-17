// COMPILE STUB — not the real BareKit. See IPC.java in this directory for the whole
// story; the short form: this source set is added to the module ONLY when the vendored
// engine runtime is absent from the checkout (see build.gradle.kts), so that the JVM
// unit tests — which touch none of this — can still be compiled and run on a bare
// checkout with no client/ install. A real build never sees these classes.
//
// Signatures are copied from the shipped jar
// (client/node_modules/react-native-bare-kit/android/libs/bare-kit/classes.jar):
//
//   public class Worklet implements Closeable {
//     public Worklet(Worklet.Options);
//     public void start(String, InputStream, String[]) throws IOException;
//     …
//   }
//
// Only the members AliranBackend.BareEngineHost actually calls are reproduced. The real
// class loads libbare-kit.so in a static initializer; this one deliberately does not —
// that native load is the whole reason the SDK never touches Worklet below API 29.
package to.holepunch.bare.kit;

import java.io.InputStream;

public class Worklet {
  public static class Options {
    public Options() {}
  }

  public Worklet(Options options) {
    throw new UnsupportedOperationException(unavailable());
  }

  public void start(String name, InputStream source, String[] argv) {
    throw new UnsupportedOperationException(unavailable());
  }

  static String unavailable() {
    return "aliran-kit was built against the BareKit COMPILE STUB, without the vendored "
        + "engine runtime — run `npm install` in client/ and `node link.mjs` in "
        + "client/node_modules/react-native-bare-kit/android, then rebuild.";
  }
}
