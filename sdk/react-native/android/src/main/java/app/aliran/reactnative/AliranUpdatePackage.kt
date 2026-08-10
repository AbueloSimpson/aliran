package app.aliran.reactnative

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

// Classic ReactPackage — what RN CLI autolinking scans this dir for. The new-arch
// interop layer registers the module from here on bridgeless apps too.
//
// ONE package for the whole library, not one per module: autolinking infers a single
// ReactPackage per Android library, so every native module this package ships is listed
// below. The name is historical (the installer was the first) — add here, do not add a
// second ReactPackage class.
class AliranUpdatePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      AliranUpdateModule(reactContext),
      // Keystore wrap/unwrap for the sign-in vault (see AliranSecureKeyModule).
      AliranSecureKeyModule(reactContext)
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
