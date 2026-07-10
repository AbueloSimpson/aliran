# Client Build (Android phone + TV)

The client is a **React Native** app using **`react-native-tvos`** so one codebase
targets phone/tablet and Android TV. It embeds **Bare** via `react-native-bare-kit`
and will **not** run in Expo Go — it needs a real native build.

## Prerequisites (the main hurdle)

Install in order:

1. **Node LTS**, **Git**
2. **JDK 17** (Temurin)
3. **Android Studio** → SDK Platform 34, Platform-Tools, **NDK**, **CMake**
4. Set `ANDROID_HOME`; add `platform-tools` to `PATH`
5. An emulator (phone AVD **and** an Android TV AVD) or physical devices
6. Verify: `npx react-native doctor`

Windows is fully supported for Android builds (no Mac needed).

## Initialize the native project

> The `client/` folder currently holds source stubs and config. The native
> `android/` project is generated once by the RN CLI:

```bash
cd client
# scaffold a react-native-tvos app, then copy in src/, backend/, config/
# (see the TODO in client/README.md for exact steps)
npm install
```

## Bundle the Bare backend

```bash
npx bare-pack --target android --linked --out backend/app.bundle backend/backend.mjs
```

## Configure the panel key

- **Build-time:** put the operator `panelPubKey` + branding in `client/config`.
- **Runtime:** accept a **service-descriptor QR/deep link** so one generic APK works
  for any operator.

## Build & install

```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Test on a **phone** and an **Android TV** target (drive the TV build with a remote /
D-pad).

## Manifest notes (dual phone + TV)

Declare both `LAUNCHER` and `LEANBACK_LAUNCHER` intents; `android.software.leanback`
**not required**; `android.hardware.touchscreen` `required=false`. Allow `127.0.0.1`
cleartext in the network security config; add the `INTERNET` permission.
