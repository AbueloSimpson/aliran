package com.aliranclient

import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.cast.framework.CastContext

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
    warmCastFramework()
  }

  /**
   * Google Cast builds its context from an Activity, and discovery does not run until it
   * exists — react-native-google-cast's own setup instructions put this call right here,
   * unguarded.
   *
   * UNGUARDED IT IS A CRASH AT LAUNCH, not a missing feature: getSharedInstance() THROWS
   * where Google Play Services is absent, and this fleet runs on Fire OS sticks and AOSP
   * boxes where it is. So it is swallowed whole, and whether casting exists on this device
   * is decided in JS by CastContext.getPlayServicesState() (client/src/cast.ts), which
   * probes availability without ever touching the call that throws.
   *
   * The Google API is called rather than the library's own RNGCCastContext wrapper (which
   * guards the same way) so this file depends on the stable Cast SDK surface instead of a
   * third-party internal package path.
   *
   * SKIPPED ON A TELEVISION. Casting FROM a television is meaningless (the set IS the
   * receiver), the button is gated off there anyway, and this is Play Services work at
   * every launch on the slowest hardware in the fleet. Leanback covers Android TV; no
   * touchscreen covers the Fire TV sticks, which have no Play Services to warm regardless.
   */
  private fun warmCastFramework() {
    try {
      val pm = packageManager
      if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
          !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
      ) {
        return
      }
      CastContext.getSharedInstance(this)
    } catch (t: Throwable) {
      // No Play Services, no Cast framework, or a device that refuses it: casting is
      // simply not offered here, and the app carries on being a television app.
    }
  }

  /**
   * CHANNEL UP / DOWN from the remote, forwarded to JS.
   *
   * IT HAS TO BE DONE HERE. react-native-tvos' key bridge does not carry these — its
   * Android helper maps the D-pad, ENTER and the media transport keys and nothing else —
   * and the app's own focus-strip rig cannot catch them either, because a strip is only
   * ever reached by a key that MOVES FOCUS, and these do not move it anywhere.
   *
   * SAFE TO CONSUME, and measured so before this was written: with this app in the
   * foreground the system publishes keycodes 166/167 straight to our own ViewRootImpl
   * (`InputDispatcher: publishKeyEvent(... com.aliranclient/.MainActivity ...)`) and acts
   * on them nowhere else, so claiming them takes nothing away from the viewer. That is
   * the opposite of the VOLUME keys, which drive the set's real speakers and must be
   * left alone — see the note beside the in-app volume state in LiveScreen.
   */
  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val direction =
        when (keyCode) {
          KeyEvent.KEYCODE_CHANNEL_UP -> "up"
          KeyEvent.KEYCODE_CHANNEL_DOWN -> "down"
          else -> null
        }
    if (direction != null) {
      emitChannelKey(direction)
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  /**
   * Fire-and-forget. Before the JS context exists there is no screen listening anyway, so
   * a missing context is a no-op rather than an error.
   */
  private fun emitChannelKey(direction: String) {
    val context = (application as? MainApplication)?.reactHost?.currentReactContext ?: return
    context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(CHANNEL_KEY_EVENT, direction)
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

  companion object {
    /** Mirrored in client/src/channelKeys.ts — the two names must stay identical. */
    const val CHANNEL_KEY_EVENT = "aliranChannelKey"
  }
}
