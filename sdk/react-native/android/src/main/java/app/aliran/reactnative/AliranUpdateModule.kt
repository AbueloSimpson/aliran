package app.aliran.reactnative

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.atomic.AtomicBoolean

// OTA update installer (classic bridge module; the new-arch interop layer hosts it
// unchanged). installApk() hands a downloaded-and-verified APK to Android's
// PackageInstaller — the OS confirmation UI and its same-signer check take over from
// there. TV-safe on purpose: Intents + PackageInstaller only, no phone-only APIs.
class AliranUpdateModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun getAppInfo(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val pm = ctx.packageManager
      val info = if (Build.VERSION.SDK_INT >= 33) {
        pm.getPackageInfo(ctx.packageName, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(ctx.packageName, 0)
      }
      // longVersionCode is the compat-safe read (versionCode is deprecated on P+).
      // The bridge has no long — gradle versionCodes are ints by definition, so the
      // narrowing cannot lose anything a real build carries.
      val code =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      val map = Arguments.createMap()
      map.putString("packageName", ctx.packageName)
      map.putInt("versionCode", code.toInt())
      map.putString("versionName", info.versionName ?: "")
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("E_APP_INFO", e.message ?: e.toString(), e)
    }
  }

  @ReactMethod
  fun canRequestInstall(promise: Promise) {
    promise.resolve(
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.packageManager.canRequestPackageInstalls()
      } else {
        true // pre-O has no per-app unknown-sources gate
      }
    )
  }

  @ReactMethod
  fun openInstallSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false) // nothing to open below O
      return
    }
    try {
      val ctx = reactApplicationContext
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:" + ctx.packageName)
      )
      val activity = reactApplicationContext.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_INSTALL_SETTINGS", e.message ?: e.toString(), e)
    }
  }

  @ReactMethod
  fun installApk(path: String, promise: Promise) {
    val ctx = reactApplicationContext
    val file: File
    val filesRoot: File
    try {
      file = File(path).canonicalFile
      filesRoot = ctx.filesDir.canonicalFile
    } catch (e: Exception) {
      promise.reject("E_BAD_PATH", e.message ?: e.toString(), e)
      return
    }
    // Only the app's own sandbox: the engine sha256-verifies and renames into
    // <filesDir>/…/updates, and nothing outside filesDir may reach the installer
    // through this module. Canonical on both sides so the /data/data symlink and
    // any ../ in the argument cannot dodge the check.
    if (!file.path.startsWith(filesRoot.path + File.separator)) {
      promise.reject("E_BAD_PATH", "not inside the app files dir: $path")
      return
    }
    if (!file.isFile) {
      promise.reject("E_NO_FILE", "no such file: $path")
      return
    }
    // The session streams a 60-150 MB file — keep it off the native-modules thread.
    // The promise settles at COMMIT HANDOFF: once the OS confirmation UI owns the
    // install, its outcome only comes back as the app restarting (success) or the
    // user cancelling — there is nothing further for the JS side to await.
    Thread { commitSession(ctx, file, promise) }.start()
  }

  private fun commitSession(ctx: ReactApplicationContext, file: File, promise: Promise) {
    val settled = AtomicBoolean(false)
    fun resolveOnce() { if (settled.compareAndSet(false, true)) promise.resolve(true) }
    fun rejectOnce(msg: String, e: Exception? = null) {
      if (settled.compareAndSet(false, true)) {
        if (e != null) promise.reject("E_INSTALL", msg, e) else promise.reject("E_INSTALL", msg)
      }
    }

    val installer = ctx.packageManager.packageInstaller
    var sessionId = -1
    var receiver: BroadcastReceiver? = null
    try {
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setAppPackageName(ctx.packageName)
      sessionId = installer.createSession(params)
      // Per-session action string: parallel/stale sessions can never cross wires.
      val action = "$ACTION_INSTALL_RESULT.$sessionId"

      receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
          when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
              // The OS wrapped its confirmation UI in EXTRA_INTENT — launch it and
              // report the handoff. The receiver stays REGISTERED: the terminal
              // status (success, or e.g. a signature refusal after the user
              // confirms) arrives through this same PendingIntent later, and the
              // promise is already settled by then — it goes out as an event.
              val confirm: Intent? =
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
              var launched = false
              try {
                if (confirm != null) {
                  confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                  context.startActivity(confirm)
                  launched = true
                }
              } catch (_: Exception) {}
              if (launched) {
                resolveOnce()
              } else {
                // No confirmation UI reached the screen — the session is stuck
                // pending in the OS with nothing visible. A silent resolve here
                // leaves the app UI waiting forever (found on-device, S22 pass).
                unregisterQuietly(ctx, this)
                try { installer.abandonSession(sessionId) } catch (_: Exception) {}
                rejectOnce("could not open the system installer — try again from the app")
              }
            }
            PackageInstaller.STATUS_SUCCESS -> {
              unregisterQuietly(ctx, this)
              resolveOnce()
              emitInstallResult(ctx, true, null)
            }
            else -> {
              unregisterQuietly(ctx, this)
              val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                ?: "install failed (status $status)"
              rejectOnce(msg)
              emitInstallResult(ctx, false, msg)
            }
          }
        }
      }
      // The status broadcast is our own PendingIntent firing under this app's
      // identity, so NOT_EXPORTED receives it (and API 33+ requires the flag).
      if (Build.VERSION.SDK_INT >= 33) {
        ctx.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
      } else {
        ctx.registerReceiver(receiver, IntentFilter(action))
      }

      installer.openSession(sessionId).use { session ->
        session.openWrite(file.name, 0, file.length()).use { out ->
          FileInputStream(file).use { input -> input.copyTo(out) }
          session.fsync(out)
        }
        // Package-explicit intent: required for a MUTABLE PendingIntent on 14+, and
        // MUTABLE is required so PackageInstaller can fill in the status extras.
        val fill = Intent(action).setPackage(ctx.packageName)
        val flags =
          if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
          else PendingIntent.FLAG_UPDATE_CURRENT
        val pending = PendingIntent.getBroadcast(ctx, sessionId, fill, flags)
        session.commit(pending.intentSender)
      }
    } catch (e: Exception) {
      if (receiver != null) unregisterQuietly(ctx, receiver)
      if (sessionId != -1) try { installer.abandonSession(sessionId) } catch (_: Exception) {}
      rejectOnce(e.message ?: e.toString(), e)
    }
  }

  private fun unregisterQuietly(ctx: ReactApplicationContext, receiver: BroadcastReceiver) {
    try { ctx.unregisterReceiver(receiver) } catch (_: Exception) {}
  }

  // Terminal install verdicts arrive AFTER installApk()'s promise settled at the
  // user-action handoff, so they travel as an event. A successful update replaces
  // the process before this can fire — in practice only failures are ever heard.
  private fun emitInstallResult(ctx: ReactApplicationContext, ok: Boolean, message: String?) {
    try {
      val map = Arguments.createMap()
      map.putBoolean("success", ok)
      if (message != null) map.putString("message", message)
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("aliranUpdateInstallResult", map)
    } catch (_: Exception) {}
  }

  companion object {
    const val NAME = "AliranUpdate"
    private const val ACTION_INSTALL_RESULT = "app.aliran.reactnative.INSTALL_RESULT"
  }
}
