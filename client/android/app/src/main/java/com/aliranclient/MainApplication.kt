package com.aliranclient

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(OrientationPackage()) // fullscreen-is-landscape lock (see OrientationModule)
          // Google Cast needs no manual entry here: react-native-google-cast autolinks,
          // and everything this app needs from it — the Play Services probe, the device
          // list, each device's address and whether it is a multi-room group — is on its
          // own JS surface (see client/src/cast.ts).
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
