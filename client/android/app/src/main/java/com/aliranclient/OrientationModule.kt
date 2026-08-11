package com.aliranclient

import android.content.pm.ActivityInfo
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Orientation lock for the PHONE's fullscreen rule ("fullscreen is ALWAYS landscape",
 * S22 round 4): React Native has no core API for Activity orientation, so this minimal
 * module exposes exactly one call. 'landscape' pins the Activity to sensor landscape
 * (either landscape, viewer's choice of which way up); 'unspecified' hands control
 * back to the system/sensor so the phone returns to its physical orientation.
 *
 * TV never calls this (a TV has no orientation to lock); the JS wrapper
 * (client/src/orientation.ts) no-ops when the module is absent (jest).
 */
class OrientationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun setOrientation(mode: String) {
    val activity = reactApplicationContext.currentActivity ?: return
    val orientation =
        if (mode == "landscape") ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    activity.runOnUiThread { activity.requestedOrientation = orientation }
  }

  companion object {
    const val NAME = "AliranOrientation"
  }
}
