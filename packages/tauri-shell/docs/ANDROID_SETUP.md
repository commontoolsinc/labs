# Android Development Setup

This guide covers setting up your development environment for building the Common Tools mobile app for Android.

## Prerequisites

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 2. Install Android Studio

Download and install [Android Studio](https://developer.android.com/studio).

During installation, ensure these components are selected:
- Android SDK
- Android SDK Platform
- Android Virtual Device (AVD)

### 3. Install Android SDK Components

Open Android Studio, then go to **Settings → Languages & Frameworks → Android SDK**.

Install the following SDK Platforms (SDK Manager → SDK Platforms tab):
- Android 14.0 (API 34) - Target SDK
- Android 9.0 (API 28) - Minimum SDK

Install the following SDK Tools (SDK Manager → SDK Tools tab):
- Android SDK Build-Tools
- Android SDK Command-line Tools
- Android Emulator
- Android SDK Platform-Tools
- NDK (Side by side) - **Required for Rust compilation**

### 4. Configure Environment Variables

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`):

```bash
# Android SDK
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 $ANDROID_HOME/ndk | sort -V | tail -n1)"

# Add to PATH
export PATH="$PATH:$ANDROID_HOME/platform-tools"
export PATH="$PATH:$ANDROID_HOME/tools"
export PATH="$PATH:$ANDROID_HOME/tools/bin"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin"
```

On macOS, the SDK is typically at:
```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

Reload your shell:
```bash
source ~/.bashrc  # or ~/.zshrc
```

### 5. Install Rust Android Targets

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### 6. Install Tauri CLI

```bash
cargo install tauri-cli --version "^2"
```

## Initialize Android Project

From the `packages/tauri-shell` directory:

```bash
deno task android:init
```

This creates the Android project structure in `src-tauri/gen/android/`.

## Development

### Run on Emulator

1. Create an AVD in Android Studio (Tools → Device Manager → Create Device)
   - Recommended: Pixel 7 with API 34
2. Start the emulator
3. Run:

```bash
deno task android:dev
```

### Run on Physical Device

1. Enable Developer Options on your device:
   - Go to Settings → About Phone
   - Tap "Build number" 7 times
2. Enable USB Debugging in Developer Options
3. Connect your device via USB
4. Run:

```bash
deno task android:dev
```

### Build Release APK

```bash
deno task android:build
```

The APK will be at `src-tauri/gen/android/app/build/outputs/apk/`.

### Build Release AAB (for Play Store)

```bash
deno task android:build -- --aab
```

## Passkey Configuration

### Digital Asset Links

For passkeys to work in production, you must host a Digital Asset Links file at your domain.

Create `/.well-known/assetlinks.json` on your server (e.g., `https://common.tools/.well-known/assetlinks.json`):

```json
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "tools.common.shell",
      "sha256_cert_fingerprints": [
        "YOUR_SHA256_FINGERPRINT"
      ]
    }
  }
]
```

### Get Your Signing Certificate Fingerprint

For debug builds:
```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA256
```

For release builds, use your release keystore.

## Troubleshooting

### "SDK location not found"

Create `local.properties` in `src-tauri/gen/android/`:
```
sdk.dir=/path/to/Android/Sdk
```

### "NDK not found"

Ensure NDK is installed and `NDK_HOME` is set:
```bash
echo $NDK_HOME
# Should output something like /home/user/Android/Sdk/ndk/26.1.10909125
```

### Build fails with "AAPT2 error"

Clear the build cache:
```bash
cd src-tauri/gen/android
./gradlew clean
```

### Emulator is slow

- Enable hardware acceleration (HAXM on Intel, Hypervisor on AMD)
- Use x86_64 system images instead of ARM
- Allocate more RAM to the emulator

### "Installed Build Tools revision X is corrupted"

Remove and reinstall Build Tools in SDK Manager.

## Minimum Requirements

| Component | Version |
|-----------|---------|
| Android Studio | 2023.1+ (Hedgehog) |
| Android SDK | API 34 |
| Android NDK | 25+ |
| Gradle | 8.0+ |
| JDK | 17+ |
| Rust | 1.77.2+ |
