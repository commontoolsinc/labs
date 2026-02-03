# @commontools/tauri-shell

Tauri mobile application for Common Tools Shell with native passkey integration.

## Overview

This package provides Android and iOS mobile apps that serve the Common Tools Shell web application, with deep integration for passkeys (WebAuthn) using native platform APIs:

- **Android**: Uses Credential Manager API (Android 14+)
- **iOS**: Uses ASAuthorizationController (iOS 16+)

## Prerequisites

- [Rust](https://rustup.rs/) (1.77.2+)
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites) (`cargo install tauri-cli --version "^2"`)
- For Android:
  - Android Studio
  - Android SDK (API 28+)
  - NDK
- For iOS:
  - Xcode 15+
  - iOS SDK 16+
  - Apple Developer account (for device testing)

## Setup

### Initialize Mobile Targets

```bash
# Initialize Android
deno task android:init

# Initialize iOS
deno task ios:init
```

### Development

```bash
# Run Android development build
deno task android:dev

# Run iOS development build (requires macOS)
deno task ios:dev
```

### Production Build

```bash
# Build Android APK/AAB
deno task android:build

# Build iOS IPA
deno task ios:build
```

## Architecture

```
packages/tauri-shell/
├── src/                          # TypeScript source
│   ├── mod.ts                    # Module entry point
│   └── passkey-bridge.ts         # Passkey API bridge
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml               # Rust dependencies
│   ├── tauri.conf.json          # Tauri configuration
│   ├── src/
│   │   ├── lib.rs               # Library entry point
│   │   ├── main.rs              # Application entry point
│   │   └── passkey.rs           # Native passkey commands
│   ├── capabilities/            # Tauri permissions
│   └── gen/                     # Generated mobile code
│       ├── android/             # Android-specific code
│       │   └── app/src/main/java/tools/common/shell/
│       │       └── PasskeyHelper.kt
│       └── apple/               # iOS-specific code
│           └── Sources/
│               └── PasskeyBridge.swift
└── deno.json                    # Package configuration
```

## Passkey Integration

The passkey bridge provides a unified API that works across all platforms:

```typescript
import {
  isTauri,
  isPasskeyAvailable,
  createPasskey,
  getPasskey,
} from "@commontools/tauri-shell";

// Check if running in Tauri
if (isTauri()) {
  console.log("Running in Tauri mobile app");
}

// Create a new passkey
const credential = await createPasskey({
  rpName: "Common Tools",
  userId: btoa("user-id"),
  userName: "user@example.com",
  userDisplayName: "John Doe",
  challenge: btoa(crypto.getRandomValues(new Uint8Array(32))),
  extensions: {
    prf: {
      eval: {
        first: btoa("common-tools-prf-salt"),
      },
    },
  },
});

// Authenticate with existing passkey
const assertion = await getPasskey({
  rpId: "common.tools",
  challenge: btoa(crypto.getRandomValues(new Uint8Array(32))),
  extensions: {
    prf: {
      eval: {
        first: btoa("common-tools-prf-salt"),
      },
    },
  },
});
```

## Platform Requirements

### Android

- Minimum SDK: 28 (Android 9)
- Target SDK: 34 (Android 14)
- For full passkey support: Android 14+ recommended
- Credential Manager API provides backward compatibility

### iOS

- Minimum iOS: 16.0
- For PRF extension support: iOS 17+ recommended
- Associated Domains must be configured for passkey association

## Domain Association

For passkeys to work correctly, you must configure domain association:

### Android (assetlinks.json)

Host at `https://common.tools/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "tools.common.shell",
      "sha256_cert_fingerprints": ["YOUR_SIGNING_CERTIFICATE_SHA256"]
    }
  }
]
```

### iOS (apple-app-site-association)

Host at `https://common.tools/.well-known/apple-app-site-association`:

```json
{
  "webcredentials": {
    "apps": ["TEAM_ID.tools.common.shell"]
  },
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAM_ID.tools.common.shell",
        "paths": ["*"]
      }
    ]
  }
}
```

## License

See repository root for license information.
