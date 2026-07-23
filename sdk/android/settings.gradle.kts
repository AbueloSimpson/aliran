// Aliran native Android SDK (Kotlin) — standalone Gradle project, deliberately
// independent of the React Native client build. See docs/sdk-guide.md
// "Native Android (Kotlin)".
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "aliran-android"

include(":aliran-kit", ":demo")
