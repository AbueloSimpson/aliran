package com.aliranclient

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "AliranClient"

  /**
   * react-native-screens cannot rehydrate its fragment back-stack from restored instance
   * state: on an activity RECREATION (a config change like theme/rotation, a process-death
   * restore, or the system relaunching the activity under memory pressure) Android would
   * otherwise try to restore it and crash with `ScreenStackFragment` InstantiationException.
   * Passing null starts fresh — React Native rebuilds the JS-driven UI anyway. This is the
   * documented RN Screens fix; without it a recreation is a guaranteed crash.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
