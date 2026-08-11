package app.aliran.reactnative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Wrap and unwrap a few bytes with a key this app cannot read.
 *
 * The only caller is the viewer app's sign-in vault: a television signed in by a phone
 * has no password to remember, so it keeps the account key material on disk instead, and
 * that material is sealed with a random file key. THIS module is where the file key goes.
 * It is generated inside the AndroidKeyStore, never leaves it, and every wrap/unwrap is
 * an operation the OS performs on this app's behalf — on any device with a hardware
 * keymaster (effectively all of them since Android 6) the key itself lives in the TEE and
 * no amount of reading this app's files produces it.
 *
 * The module is deliberately STATELESS AND CONTENT-BLIND: it stores nothing, knows
 * nothing about accounts, and would wrap any 32 bytes you handed it. The record it
 * protects lives with the rest of the app's prefs, written by the Bare worklet, which is
 * also the only runtime the account's private keys are ever in.
 *
 * ---------------------------------------------------------------------------------------
 * THREE DECISIONS, MADE ONCE, HERE.
 *
 * 1. RAW KEYSTORE, NOT androidx.security-crypto. EncryptedSharedPreferences would have
 *    given the same guarantee with less code, and was rejected: Jetpack deprecated the
 *    whole security-crypto library, it pulls Tink and protobuf into an APK that ships to
 *    television set-top boxes with very little storage, and its failure mode on a device
 *    whose keystore has been reset is an exception from a constructor rather than
 *    something a caller can act on. What is here is one AES-GCM key and two operations,
 *    with no new dependency and every failure mapped to a code the app can route on.
 *
 * 2. NO setUserAuthenticationRequired. It is the right flag on a phone and the wrong one
 *    here. It requires a secure lock screen AT KEY-GENERATION TIME, and a television
 *    generally has none — so the key could not be created at all on the devices this
 *    feature exists for. Even where one exists, requiring an unlock would mean a set that
 *    cannot sign itself in until somebody walks over with a remote, which is the precise
 *    problem this feature was built to remove. The consequence is stated plainly rather
 *    than hidden: the wrap is bound to THIS APP ON THIS DEVICE, not to a person, so it
 *    does not defend against someone who has the television and can run code as the app.
 *
 * 3. NO invalidate-on-enrolment (setInvalidatedByBiometricEnrollment and friends). Those
 *    hang off user authentication, which is off for the reason above. They would also be
 *    the wrong shape for a shared device: a television is used by a household, and
 *    "somebody enrolled a fingerprint" is not a signal that the household's account should
 *    be dropped.
 *
 * The key IS destroyed by everything that should destroy it: uninstalling the app, a
 * factory reset, "clear data", and reset() below, which sign-out calls.
 * ---------------------------------------------------------------------------------------
 *
 * Every method resolves or rejects with one of three codes, and THEY DO NOT MEAN THE SAME
 * THING. The caller's response to two of them is to erase the account a television is
 * holding, which sends a viewer to another room for a phone, so the split is the product:
 *
 *   E_UNAVAILABLE  the key store could not be reached — absent on this device, or simply
 *                  not answering right now. The Android keystore daemon is not reliably up
 *                  the instant an app process starts, and a set that erased an account over
 *                  one cold-boot hiccup would be unrecoverable by design. TRANSIENT: the
 *                  caller keeps what it has and asks again.
 *   E_LOCKED       there is no key for this app any more (uninstall/restore, a keystore
 *                  reset, a wiped alias). Whatever was wrapped with it is unreadable.
 *                  TERMINAL.
 *   E_BAD_BLOB     the input is not something this key produced — truncated, corrupted,
 *                  or from another device. TERMINAL.
 *
 * The distinction only exists if it survives the trip: sdk/react-native/src/secure-key.ts
 * carries `e.code` through as a typed value rather than flattening every rejection to null,
 * which is what an earlier revision did while this block claimed the app could route on it.
 */
class AliranSecureKeyModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  /**
   * Wrap plaintext (base64 in, base64 out). Creates the app's key on first use.
   *
   * A key that exists but can no longer be loaded is REPLACED rather than reported: at
   * wrap time there is nothing yet worth preserving, and the alternative is a device that
   * can never save a sign-in again after one keystore hiccup. Anything sealed under the
   * old key becomes unreadable, which the unwrap path already treats as "start again".
   */
  @ReactMethod
  fun wrapBytes(plainB64: String, promise: Promise) {
    val plain = decode(plainB64)
    if (plain == null || plain.isEmpty()) {
      promise.reject("E_BAD_BLOB", "not base64")
      return
    }
    val key = try {
      loadKey(keyStore()) ?: generateKey()
    } catch (e: Exception) {
      // Unloadable alias: drop it and mint a fresh one. If THAT fails there is no
      // usable key store here at all.
      try {
        deleteKey()
        generateKey()
      } catch (e2: Exception) {
        promise.reject("E_UNAVAILABLE", describe(e2), e2)
        return
      }
    }
    try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, key)
      // The IV is the cipher's, never ours: setRandomizedEncryptionRequired (the default)
      // refuses a caller-supplied one, which is exactly the mistake it is there to stop.
      val iv = cipher.iv
      val ct = cipher.doFinal(plain)
      promise.resolve(Base64.encodeToString(iv + ct, Base64.NO_WRAP))
    } catch (e: Exception) {
      promise.reject("E_UNAVAILABLE", describe(e), e)
    }
  }

  /**
   * Unwrap what wrapBytes produced (base64 in, base64 out).
   *
   * THE TWO FAILURES ON THIS SIDE ARE NOT THE SAME FAILURE, and separating them is the
   * whole reason this method is longer than its counterpart. "The key store would not
   * open" is a condition of the moment — the keystore daemon at cold boot — and answering
   * it E_LOCKED told the caller the account it holds is dead. "This app has no key" really
   * is dead. So the store is opened first, on its own, and only what happens AFTER it
   * opened can be terminal.
   */
  @ReactMethod
  fun unwrapBytes(blobB64: String, promise: Promise) {
    val blob = decode(blobB64)
    if (blob == null || blob.size <= GCM_IV_BYTES) {
      promise.reject("E_BAD_BLOB", "not a wrapped blob")
      return
    }
    val ks = try {
      keyStore()
    } catch (e: Exception) {
      promise.reject("E_UNAVAILABLE", describe(e), e)
      return
    }
    val key = try {
      loadKey(ks)
    } catch (e: Exception) {
      // The store opened and then would not hand over this alias. Do NOT mint a
      // replacement here — that would answer "cannot read it" with a silent new key and
      // leave the caller believing the store still holds something.
      promise.reject("E_LOCKED", describe(e), e)
      return
    }
    if (key == null) {
      promise.reject("E_LOCKED", "no key for this app")
      return
    }
    try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob, 0, GCM_IV_BYTES))
      val plain = cipher.doFinal(blob, GCM_IV_BYTES, blob.size - GCM_IV_BYTES)
      promise.resolve(Base64.encodeToString(plain, Base64.NO_WRAP))
    } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
      promise.reject("E_LOCKED", describe(e), e)
    } catch (e: javax.crypto.AEADBadTagException) {
      // The tag is the whole point: this blob was not produced by this key.
      promise.reject("E_BAD_BLOB", describe(e), e)
    } catch (e: Exception) {
      promise.reject("E_BAD_BLOB", describe(e), e)
    }
  }

  /**
   * Destroy the app's wrapping key. Sign-out calls this, so "sign out" on a television
   * means the record beside it can never be read again even if the file survives.
   * Resolves true whether or not a key was there — the postcondition is what matters.
   */
  @ReactMethod
  fun reset(promise: Promise) {
    try {
      deleteKey()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_UNAVAILABLE", describe(e), e)
    }
  }

  /**
   * What this device's key store actually is, so the app can REPORT rather than assume.
   * `hardwareBacked` false means the key is protected by software only — the wrap is
   * still worth having (it is bound to this app) but claims about hardware must not be
   * made about it. Never rejects: an unavailable store answers { available: false }.
   *
   * IT CREATES NOTHING. This is exported from the package and is documented as "read it to
   * REPORT, never to decide", so a host is entitled to call it on a phone that will never
   * keep a sign-in — and an earlier revision minted the wrapping key here as a side effect
   * of describing it, leaving a permanent Keystore entry behind on every device that merely
   * asked. A read-shaped API must not make state. The cost is that `securityLevel` cannot
   * be answered before the first wrap: Android has no way to describe a key that does not
   * exist, so `keyPresent` false is reported alongside "unknown" rather than a guess.
   */
  @ReactMethod
  fun status(promise: Promise) {
    val map = Arguments.createMap()
    try {
      val key = loadKey(keyStore()) // null = the store works, this app has no key in it yet
      map.putBoolean("available", true)
      map.putBoolean("keyPresent", key != null)
      var hardware = false
      var level = "unknown"
      if (key != null) {
        try {
          val factory = SecretKeyFactory.getInstance(key.algorithm, PROVIDER)
          val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
          if (Build.VERSION.SDK_INT >= 31) {
            val sl = info.securityLevel
            hardware = sl == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ||
              sl == KeyProperties.SECURITY_LEVEL_STRONGBOX
            level = when (sl) {
              KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
              KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
              KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
              else -> "unknown"
            }
          } else {
            @Suppress("DEPRECATION")
            hardware = info.isInsideSecureHardware
            level = if (hardware) "tee" else "software"
          }
        } catch (_: Exception) {
          // The key works; we just cannot describe it. Say so rather than claiming either way.
        }
      }
      map.putBoolean("hardwareBacked", hardware)
      map.putString("securityLevel", level)
    } catch (e: Exception) {
      map.putBoolean("available", false)
      map.putBoolean("keyPresent", false)
      map.putBoolean("hardwareBacked", false)
      map.putString("securityLevel", "none")
    }
    promise.resolve(map)
  }

  // --- key store plumbing ---------------------------------------------------------------

  /** Open the AndroidKeyStore. Throws when there is no usable store here AT THIS MOMENT,
   *  which callers must map to E_UNAVAILABLE and never to "your key is gone". */
  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  /** The app's key in an ALREADY-OPEN store, or null when there is none. Throws only for a
   *  store that opened and then refused this alias — which is a key problem, not a store
   *  problem, and that is exactly the difference the two codes carry. */
  private fun loadKey(ks: KeyStore): SecretKey? {
    if (!ks.containsAlias(ALIAS)) return null
    val entry = ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry ?: return null
    return entry.secretKey
  }

  private fun generateKey(): SecretKey {
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    gen.init(
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(AES_KEY_BITS)
        // Default true; set explicitly because it is the reason wrapBytes must not pass
        // an IV of its own, and a future edit should have to delete this line on purpose.
        .setRandomizedEncryptionRequired(true)
        // NOT set, and the header explains each at length: setUserAuthenticationRequired
        // (a television has no lock screen to authenticate against), setUnlockedDeviceRequired
        // (a set must sign in at boot, before anybody unlocks anything), and StrongBox
        // (absent on television hardware, and a generate-time success with a use-time
        // failure is the worst shape a key can have).
        .build()
    )
    return gen.generateKey()
  }

  private fun deleteKey() {
    val ks = keyStore()
    if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
  }

  private fun decode(s: String?): ByteArray? =
    try { if (s.isNullOrEmpty()) null else Base64.decode(s, Base64.DEFAULT) } catch (_: Exception) { null }

  /** An exception's CLASS, never its message. Keystore messages have been known to echo
   *  aliases and parameters into logs, and nothing about this module's inputs belongs in
   *  a crash report. */
  private fun describe(e: Exception): String = e.javaClass.simpleName

  companion object {
    const val NAME = "AliranSecureKey"
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "aliran.signin.v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val AES_KEY_BITS = 256
    private const val GCM_IV_BYTES = 12
    private const val GCM_TAG_BITS = 128
  }
}
