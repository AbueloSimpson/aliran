// aliran-kit demo — the verification vehicle and reference host. One APK,
// minSdk 21: full P2P on Android 10+, EngineNotice + a plain-HLS fallback below.
// The baked service descriptor (assets/service.json) is GITIGNORED — copy
// service.example.json and fill in your panel key + dev credentials.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "aliran.demo"
    compileSdk = 36

    defaultConfig {
        applicationId = "aliran.kit.demo"
        minSdk = 21
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":aliran-kit"))
}
