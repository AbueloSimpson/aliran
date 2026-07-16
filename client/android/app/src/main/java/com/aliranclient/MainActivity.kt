package com.aliranclient

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    enableImmersive()
  }

  /** Re-hide the bars after a transient reveal (edge swipe) or a dialog/keyboard. */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) enableImmersive()
  }

  /**
   * Sticky-immersive, edge-to-edge chrome so live video fills the whole screen (this is a
   * 10-foot / TV-style app): BOTH system bars are HIDDEN so nothing distracts from playback —
   * the status bar (clock/battery) AND the navigation buttons (back/home/recents) fade away.
   * A swipe in from an edge reveals them transiently to use, then they auto re-hide; the back
   * gesture still works throughout. onWindowFocusChanged re-applies after a reveal/dialog.
   */
  private fun enableImmersive() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
