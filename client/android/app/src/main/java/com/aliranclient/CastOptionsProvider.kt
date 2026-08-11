package com.aliranclient

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.reactnative.googlecast.GoogleCastOptionsProvider

/**
 * Cast framework configuration. Named in AndroidManifest.xml under
 * `com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME`, and instantiated by
 * the framework itself the first time CastContext.getSharedInstance() runs.
 *
 * THE STOCK RECEIVER, DELIBERATELY AND IN CODE. DEFAULT_MEDIA_RECEIVER_APPLICATION_ID is
 * "CC1AD845", the receiver every Chromecast already carries: no Cast Developer Console
 * registration, no fee, no hosted receiver page to keep alive, and nothing an operator has
 * to do to white-label this app. It was proven against a real TCL Google TV — HLS over a
 * plain http LAN URL plays, provided the serving side sends CORS headers (it does; without
 * them the receiver fetched the playlist and then zero segments).
 *
 * It is pinned HERE rather than left to react-native-google-cast's own default because the
 * library reads it from a manifest string (`com.reactnative.googlecast.
 * RECEIVER_APPLICATION_ID`) and falls back to the same constant. Same outcome, one
 * difference: an operator's white-label manifest cannot silently change which receiver a
 * viewer's television launches.
 *
 * EXTENDS the library's provider rather than replacing it, so the media notification, the
 * lock-screen controls and the expanded-controller activity it configures keep working —
 * substituting a bare OptionsProvider would quietly drop all three.
 */
class CastOptionsProvider : GoogleCastOptionsProvider() {
  override fun getReceiverApplicationId(context: Context): String =
      CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
}
