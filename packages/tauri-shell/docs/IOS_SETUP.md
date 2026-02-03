# iOS Development Setup

This guide covers setting up your development environment for building the Common Tools mobile app for iOS.

> **Note:** iOS development requires macOS. You cannot build iOS apps on Windows or Linux.

## Prerequisites

### 1. Install Xcode

Install Xcode from the Mac App Store or [Apple Developer Downloads](https://developer.apple.com/download/more/).

Required version: **Xcode 15.0+**

After installation, open Xcode once to accept the license agreement and install additional components.

### 2. Install Xcode Command Line Tools

```bash
xcode-select --install
```

Verify installation:
```bash
xcode-select -p
# Should output: /Applications/Xcode.app/Contents/Developer
```

### 3. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 4. Install Rust iOS Targets

```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
```

### 5. Install Tauri CLI

```bash
cargo install tauri-cli --version "^2"
```

### 6. Install CocoaPods (if needed)

```bash
sudo gem install cocoapods
```

Or with Homebrew:
```bash
brew install cocoapods
```

## Apple Developer Account

To run on physical devices or distribute your app, you need an Apple Developer account.

### Free Account (Testing Only)
- Create an Apple ID at [appleid.apple.com](https://appleid.apple.com)
- Limited to 3 apps, 7-day provisioning profiles
- No App Store distribution

### Paid Account ($99/year)
- Enroll at [developer.apple.com/programs](https://developer.apple.com/programs)
- Required for App Store distribution
- Longer provisioning profiles (1 year)

### Configure Xcode Signing

1. Open Xcode → Settings → Accounts
2. Click "+" → Add Apple ID
3. Sign in with your Apple Developer account

## Initialize iOS Project

From the `packages/tauri-shell` directory:

```bash
deno task ios:init
```

This creates the iOS project structure in `src-tauri/gen/apple/`.

### Configure Bundle Identifier

The default bundle identifier is `tools.common.shell`. To change it:

1. Open `src-tauri/tauri.conf.json`
2. Modify the `identifier` field
3. Re-run `deno task ios:init`

## Development

### Run on Simulator

```bash
deno task ios:dev
```

This opens an iOS Simulator with the app.

To specify a simulator:
```bash
deno task ios:dev -- --device "iPhone 15 Pro"
```

### Run on Physical Device

1. Connect your iPhone/iPad via USB
2. Trust the computer on your device
3. In Xcode, select your device as the build target
4. Run:

```bash
deno task ios:dev
```

**First-time setup on device:**
1. On your device, go to Settings → General → VPN & Device Management
2. Trust your developer certificate

### Build Release IPA

```bash
deno task ios:build
```

## Passkey Configuration

### Associated Domains

Passkeys require Associated Domains to be configured. This is already set up in the entitlements file.

The entitlements include:
```
webcredentials:common.tools
applinks:common.tools
```

### Apple App Site Association (AASA)

Host an AASA file at your domain (e.g., `https://common.tools/.well-known/apple-app-site-association`):

```json
{
  "webcredentials": {
    "apps": [
      "TEAM_ID.tools.common.shell"
    ]
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

Replace `TEAM_ID` with your Apple Developer Team ID (found in Apple Developer Portal → Membership).

### Enable Associated Domains in Apple Developer Portal

1. Go to [developer.apple.com](https://developer.apple.com)
2. Navigate to Certificates, Identifiers & Profiles → Identifiers
3. Select your App ID (or create one)
4. Enable "Associated Domains" capability
5. Save changes

### Development Testing

For local development, Associated Domains won't work. Use these workarounds:

1. **Use a passphrase instead of passkey** during development
2. **Test on TestFlight** where Associated Domains work
3. **Use ngrok or similar** to expose localhost with HTTPS

## Face ID / Touch ID Configuration

The app already includes the necessary Info.plist entry for biometric authentication:

```xml
<key>NSFaceIDUsageDescription</key>
<string>Common Tools uses Face ID to authenticate with passkeys.</string>
```

## Troubleshooting

### "Signing for 'commontools-shell' requires a development team"

1. Open the Xcode project: `open src-tauri/gen/apple/commontools-shell.xcodeproj`
2. Select the project in the navigator
3. Select the target → Signing & Capabilities
4. Select your Team from the dropdown

### "No provisioning profile"

- For simulators: No provisioning profile needed
- For devices: Ensure you have a valid Apple Developer account and signing is configured

### "Device is not available"

```bash
# List available simulators
xcrun simctl list devices

# Boot a specific simulator
xcrun simctl boot "iPhone 15 Pro"
```

### Build fails with "Module not found"

```bash
cd src-tauri/gen/apple
pod install
```

### "The application's Info.plist does not contain a valid CFBundleVersion"

Ensure `tauri.conf.json` has a valid version:
```json
{
  "version": "0.1.0"
}
```

### Simulator keyboard doesn't appear

Press `Cmd + K` in the simulator to toggle the software keyboard.

### App crashes on launch

Check Console.app for crash logs:
1. Open Console.app
2. Select your device/simulator
3. Filter by your app name

## Minimum Requirements

| Component | Version |
|-----------|---------|
| macOS | 13.0+ (Ventura) |
| Xcode | 15.0+ |
| iOS SDK | 16.0+ |
| Swift | 5.9+ |
| Rust | 1.77.2+ |
| CocoaPods | 1.14+ (if needed) |

## App Store Submission

### Archive for Distribution

1. Open the Xcode project
2. Select "Any iOS Device" as the build target
3. Product → Archive
4. In Organizer, select the archive → Distribute App

### Required App Store Assets

- App Icon (1024x1024)
- Screenshots for all device sizes
- App description and metadata
- Privacy policy URL

### TestFlight

1. Upload your build via Xcode Organizer or Transporter
2. In App Store Connect, add testers
3. Testers install via TestFlight app
