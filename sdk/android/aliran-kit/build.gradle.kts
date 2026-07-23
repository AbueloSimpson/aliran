// aliran-kit — the Kotlin-native Aliran SDK. One library, minSdk 21:
// on Android 10+ (API 29) it hosts the full P2P engine in a Bare worklet; below
// that the engine cannot load (its ELF-TLS libc floor) and the SDK is silently
// inert (AliranBackend.isSupported() == false) — the host app mounts its own
// fallback via EngineNotice. See docs/sdk-guide.md "Native Android (Kotlin)".
//
// The engine runtime is VENDORED from the React Native package checkout — the
// same bare-kit prebuilts + linked addon set the RN app ships (Holepunch's
// bare-kit Java API has no RN dependency; react-native-bare-kit merely wraps
// it). Prerequisites, both one-time:
//   1. `cd client && npm install`            (places react-native-bare-kit)
//   2. any client Android build, or
//      `cd client/node_modules/react-native-bare-kit/android && node link.mjs`
//      (populates src/main/addons with the per-ABI addon .so set)
import java.util.Base64

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// Repo root = ../../.. from this module (sdk/android/aliran-kit).
val repoRoot: File = projectDir.parentFile.parentFile.parentFile
val bareKitDir = File(repoRoot, "client/node_modules/react-native-bare-kit/android")
val engineBundleJs = File(repoRoot, "client/backend/app.bundle.js")

// Decode client/backend/app.bundle.js (`module.exports = "<base64>"`) into a raw
// binary asset the worklet starts from. Regenerated whenever the source changes.
val engineAssetDir = layout.buildDirectory.dir("generated/engineAssets")
val generateEngineBundle = tasks.register("generateEngineBundle") {
    inputs.file(engineBundleJs)
    outputs.dir(engineAssetDir)
    doLast {
        check(engineBundleJs.exists()) {
            "client/backend/app.bundle.js missing — run `npm run bundle-backend` in client/"
        }
        val text = engineBundleJs.readText()
        val b64 = text.substringAfter('"').substringBeforeLast('"')
        val out = File(engineAssetDir.get().asFile, "app.bundle")
        out.parentFile.mkdirs()
        out.writeBytes(Base64.getDecoder().decode(b64))
    }
}

// libbare-kit.so links the shared C++ STL runtime (the RN app packaged it
// implicitly via its NDK builds); vendor libc++_shared.so per ABI from the NDK.
val libcxxDir = layout.buildDirectory.dir("generated/libcxx")
val vendorLibcxx = tasks.register("vendorLibcxx") {
    outputs.dir(libcxxDir)
    doLast {
        val sdkDir = android.sdkDirectory
        val sysroot = File(sdkDir, "ndk/27.1.12297006/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib")
        check(sysroot.exists()) { "NDK 27.1.12297006 not found under ${sysroot.path}" }
        val abis = mapOf(
            "arm64-v8a" to "aarch64-linux-android",
            "armeabi-v7a" to "arm-linux-androideabi",
            "x86" to "i686-linux-android",
            "x86_64" to "x86_64-linux-android"
        )
        for ((abi, triple) in abis) {
            val src = File(sysroot, "$triple/libc++_shared.so")
            check(src.exists()) { "missing ${src.path}" }
            val dst = File(libcxxDir.get().asFile, "$abi/libc++_shared.so")
            dst.parentFile.mkdirs()
            src.copyTo(dst, overwrite = true)
        }
    }
}

android {
    namespace = "aliran.kit"
    compileSdk = 36
    ndkVersion = "27.1.12297006"

    defaultConfig {
        minSdk = 21
    }

    sourceSets["main"].apply {
        // Engine native libs: libbare-kit.so per ABI + the linked addon set. Only
        // ever loaded on API 29+ (Worklet's static init does the System.loadLibrary,
        // and the SDK never touches that class below 29), so packaging them in a
        // minSdk-21 library is safe.
        jniLibs.srcDirs(
            File(bareKitDir, "libs/bare-kit/jni"),
            File(bareKitDir, "src/main/addons")
        )
        jniLibs.srcDir(libcxxDir)
        assets.srcDir(engineAssetDir)
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // The vendored prebuilts predate the 16 KB page-size requirement; the RN app
    // ships them the same way.
    packaging {
        jniLibs.useLegacyPackaging = false
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.named("preBuild") {
    dependsOn(generateEngineBundle, vendorLibcxx)
    doFirst {
        check(File(bareKitDir, "libs/bare-kit/classes.jar").exists()) {
            "react-native-bare-kit not found — run `npm install` in client/ first"
        }
        check(File(bareKitDir, "src/main/addons").listFiles()?.isNotEmpty() == true) {
            "Bare addon set missing — run `node link.mjs` in ${bareKitDir.path}"
        }
    }
}

dependencies {
    // The plain-Java BareKit worklet API (Worklet + IPC) and any addon class shims.
    api(files(File(bareKitDir, "libs/bare-kit/classes.jar")))
    api(fileTree(File(bareKitDir, "src/main/addons")) { include("*.classes.jar") })

    // api: hosts reach ExoPlayer/PlayerView directly (their own fallback players,
    // controller styling) — the player types are part of the SDK surface.
    api("androidx.media3:media3-exoplayer:1.8.0")
    api("androidx.media3:media3-exoplayer-hls:1.8.0")
    api("androidx.media3:media3-ui:1.8.0")

    testImplementation("junit:junit:4.13.2")
    // android's built-in org.json, for plain-JVM unit tests of the message parser.
    testImplementation("org.json:json:20240303")
}
