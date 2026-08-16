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
//   3. `cd client && npm run bundle-backend` (produces the engine bundle asset)
//
// …but ONLY for a build that PACKAGES something. The unit tests need none of it —
// see "the engine is a packaging prerequisite" below, which is what lets CI run them
// on a bare checkout.
import java.util.Base64

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// Repo root = ../../.. from this module (sdk/android/aliran-kit).
val repoRoot: File = projectDir.parentFile.parentFile.parentFile
val bareKitDir = File(repoRoot, "client/node_modules/react-native-bare-kit/android")
val engineBundleJs = File(repoRoot, "client/backend/app.bundle.js")
val engineJar = File(bareKitDir, "libs/bare-kit/classes.jar")
val engineAddons = File(bareKitDir, "src/main/addons")

// THE ENGINE IS A PACKAGING PREREQUISITE, NOT A COMPILATION ONE.
//
// Every prerequisite above produces bytes that go INSIDE an AAR or an APK: a jar of
// Java bindings, a per-ABI native set, an asset the worklet boots from. None of them
// is needed to run this module's unit tests, which cover RecoveryLadders, Messages,
// SourceType and LineAccumulator — plain Kotlin, no native calls, no engine (the
// recovery ladders were extracted out of the view precisely so they could be tested
// that way). Until now the checks below sat on `preBuild`, which is on the path of
// `testDebugUnitTest`, so running ~50 pure-JVM tests meant first installing the whole
// React Native app toolchain. That is why nothing ran them in CI.
//
// So each prerequisite is now detected rather than demanded. When they are all here
// the build is exactly what it was. When they are not:
//   - the engine asset + libc++ vendoring tasks skip (nothing to package);
//   - AliranBackend's BareEngineHost compiles against src/enginestub/java instead of
//     the vendored jar (that file explains the trade it makes);
//   - and every task that would PACKAGE something fails loudly, naming what is
//     missing — see the assemble guard at the bottom.
// CI takes that second path: .github/workflows/ci.yml, the `sdk-android` job.
val enginePrereqs = listOf(
    engineJar to "react-native-bare-kit not found — run `npm install` in client/ first",
    engineAddons to "Bare addon set missing — run `node link.mjs` in ${bareKitDir.path}",
    engineBundleJs to "client/backend/app.bundle.js missing — run `npm run bundle-backend` in client/"
)
val missingEnginePrereqs = enginePrereqs
    .filter { (f, _) -> if (f.isDirectory) f.listFiles().isNullOrEmpty() else !f.exists() }
    .map { (_, why) -> why }
val engineVendored = missingEnginePrereqs.isEmpty()

// Decode client/backend/app.bundle.js (`module.exports = "<base64>"`) into a raw
// binary asset the worklet starts from. Regenerated whenever the source changes.
// `inputs.files` (not `inputs.file`) on purpose: a declared @InputFile that does not
// exist is a Gradle validation FAILURE even for a task that is about to be skipped,
// which is exactly the engine-less case this has to survive.
val engineAssetDir = layout.buildDirectory.dir("generated/engineAssets")
val generateEngineBundle = tasks.register("generateEngineBundle") {
    inputs.files(engineBundleJs)
    outputs.dir(engineAssetDir)
    onlyIf { engineBundleJs.exists() }
    doLast {
        val text = engineBundleJs.readText()
        val b64 = text.substringAfter('"').substringBeforeLast('"')
        val out = File(engineAssetDir.get().asFile, "app.bundle")
        out.parentFile.mkdirs()
        out.writeBytes(Base64.getDecoder().decode(b64))
    }
}

// libbare-kit.so links the shared C++ STL runtime (the RN app packaged it
// implicitly via its NDK builds); vendor libc++_shared.so per ABI from the NDK.
// Skipped outright when there is no engine to package (see above) — an NDK is then
// one more thing a test-only build would have to install for nothing.
val libcxxDir = layout.buildDirectory.dir("generated/libcxx")
val vendorLibcxx = tasks.register("vendorLibcxx") {
    outputs.dir(libcxxDir)
    onlyIf { engineVendored }
    doLast {
        val sdkDir = android.sdkDirectory
        // The NDK's prebuilt toolchain directory is named for the HOST, not the target
        // — this used to be hardcoded to windows-x86_64, which made the module
        // Windows-only for no reason anyone chose.
        val os = System.getProperty("os.name").lowercase()
        val hostTag = when {
            os.startsWith("windows") -> "windows-x86_64"
            os.startsWith("mac") || os.startsWith("darwin") -> "darwin-x86_64"
            else -> "linux-x86_64"
        }
        val sysroot = File(sdkDir, "ndk/27.1.12297006/toolchains/llvm/prebuilt/$hostTag/sysroot/usr/lib")
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
        // No vendored jar in this checkout: give the Kotlin compiler the BareKit names
        // AliranBackend's BareEngineHost references, so the module still compiles and
        // its JVM tests still run. Added ONLY in that case — alongside the real jar it
        // would be a duplicate-class error. src/enginestub/java explains the trade.
        if (!engineJar.exists()) java.srcDir("src/enginestub/java")
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
}

// The loud failure the checks above used to give, moved to where it belongs: the tasks
// that produce a shippable artifact. `assemble*` covers assembleDebug/assembleRelease,
// `*Aar` covers the bundleDebugAar/bundleReleaseAar those depend on — and neither is on
// the path of testDebugUnitTest, which is the whole point. The `Test` exclusion keeps
// AGP's own assembleDebugUnitTest / assembleAndroidTest out of it for the same reason:
// they package tests, which have no engine in them either.
//
// ⚠ This is a convenience, not the last line of defence. An engine-less build has no
// app.bundle asset and no per-ABI .so set, and its BareEngineHost is the stub, so it
// cannot start an engine by accident however it is assembled — the stub says exactly
// that when constructed.
tasks.matching {
    (it.name.startsWith("assemble") || it.name.endsWith("Aar")) && !it.name.contains("Test")
}.configureEach {
    doFirst {
        check(engineVendored) {
            "aliran-kit cannot be packaged without the vendored engine runtime:\n" +
                missingEnginePrereqs.joinToString("\n") { "  - $it" }
        }
    }
}

dependencies {
    // The plain-Java BareKit worklet API (Worklet + IPC) and any addon class shims.
    // Declared only when they are actually there: a `files()` dependency naming a
    // missing jar is not an empty classpath entry, it is a hard resolution failure.
    // On an engine-less checkout src/enginestub/java stands in for the first of them
    // (see the source set above) and there are no addon shims to stand in for.
    if (engineJar.exists()) api(files(engineJar))
    api(fileTree(engineAddons) { include("*.classes.jar") })

    // api: hosts reach ExoPlayer/PlayerView directly (their own fallback players,
    // controller styling) — the player types are part of the SDK surface.
    api("androidx.media3:media3-exoplayer:1.8.0")
    api("androidx.media3:media3-exoplayer-hls:1.8.0")
    api("androidx.media3:media3-ui:1.8.0")

    testImplementation("junit:junit:4.13.2")
    // android's built-in org.json, for plain-JVM unit tests of the message parser.
    testImplementation("org.json:json:20240303")
}
