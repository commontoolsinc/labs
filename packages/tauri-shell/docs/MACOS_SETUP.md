# macOS Development Setup

This guide covers setting up your development environment for building the Common Tools desktop app for macOS.

## Prerequisites

### 1. Install Xcode Command Line Tools

```bash
xcode-select --install
```

Verify installation:
```bash
xcode-select -p
# Should output: /Applications/Xcode.app/Contents/Developer or /Library/Developer/CommandLineTools
```

### 2. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 3. Install macOS Rust Targets

For building universal binaries (runs on both Intel and Apple Silicon):

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```

### 4. Install Tauri CLI

```bash
cargo install tauri-cli --version "^2"
```

### 5. Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"
```

## Development

### Run Development Build

```bash
deno task macos:dev
```

This builds and runs the app in development mode with hot reload support.

### Build Release App

Build a universal binary (works on both Intel and Apple Silicon Macs):
```bash
deno task macos:build
```

Build for specific architectures:
```bash
# Intel Macs only
deno task macos:build-x64

# Apple Silicon only
deno task macos:build-arm
```

The built app will be at:
- `.app` bundle: `src-tauri/target/release/bundle/macos/Common Tools.app`
- `.dmg` installer: `src-tauri/target/release/bundle/dmg/Common Tools_0.1.0_universal.dmg`

## Code Signing

### Development (Unsigned)

For local development and testing, you can run unsigned apps:

1. Build the app
2. Right-click the `.app` and select "Open"
3. Click "Open" in the security dialog

### Production (Signed & Notarized)

For distribution, apps must be signed and notarized by Apple.

#### 1. Get a Developer ID Certificate

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. In Xcode → Settings → Accounts, add your Apple ID
3. Manage Certificates → Create "Developer ID Application" certificate

#### 2. Configure Signing in tauri.conf.json

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "providerShortName": "TEAM_ID"
    }
  }
}
```

#### 3. Set Environment Variables for Notarization

```bash
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

Create an app-specific password at [appleid.apple.com](https://appleid.apple.com).

#### 4. Build with Signing

```bash
deno task macos:build
```

Tauri will automatically sign and notarize the app.

## Passkey Configuration

### Associated Domains

For passkeys to work, you need to configure Associated Domains. The entitlements file (`entitlements.plist`) already includes:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
    <string>webcredentials:common.tools</string>
</array>
```

### Apple App Site Association (AASA)

Host an AASA file at your domain (`https://common.tools/.well-known/apple-app-site-association`):

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

Replace `TEAM_ID` with your Apple Developer Team ID.

### Testing Passkeys in Development

During development, Associated Domains won't work unless you:

1. Have a valid Apple Developer account
2. Create an App ID with Associated Domains capability
3. Use a signed development build

For local testing, use passphrase authentication instead of passkeys.

## App Sandbox

The production build uses App Sandbox (required for Mac App Store). The entitlements include:

| Entitlement | Purpose |
|-------------|---------|
| `com.apple.security.app-sandbox` | Enable sandbox |
| `com.apple.security.network.client` | Allow network requests |
| `com.apple.security.files.user-selected.read-write` | Allow file access via open/save dialogs |
| `com.apple.developer.web-browser.public-key-credential` | Enable passkey/WebAuthn support |

For development, use `entitlements.debug.plist` which has fewer restrictions.

## Troubleshooting

### "App is damaged and can't be opened"

This happens with unsigned apps downloaded from the internet:

```bash
xattr -cr "/Applications/Common Tools.app"
```

Or right-click → Open → Open anyway.

### "Developer cannot be verified"

1. Open System Settings → Privacy & Security
2. Scroll to the security section
3. Click "Open Anyway" for the blocked app

### Build fails with "No available targets"

Ensure you have the correct Rust targets installed:

```bash
rustup target list --installed
# Should include: aarch64-apple-darwin, x86_64-apple-darwin
```

### "codesign failed"

- For unsigned builds: This is expected, the app will still work
- For signed builds: Check your signing identity is valid:

```bash
security find-identity -v -p codesigning
```

### App crashes on launch

Check Console.app for crash logs:
1. Open Console.app
2. Filter by "Common Tools"
3. Look for crash reports

### Notarization fails

Common issues:
- App-specific password incorrect
- Team ID mismatch
- Missing entitlements

Check the notarization log:
```bash
xcrun notarytool log <submission-id> --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID
```

### WebView shows blank screen

Ensure the shell is built:
```bash
cd ../shell && deno task build
```

## Distribution

### Direct Download

1. Build and sign the app
2. Create a DMG: `deno task macos:build`
3. Host the DMG on your website
4. Users may need to bypass Gatekeeper on first launch

### Mac App Store

1. Build with Mac App Store entitlements
2. Archive in Xcode
3. Upload via Transporter or Xcode
4. Submit for review in App Store Connect

Note: Mac App Store requires additional entitlements and may have restrictions on certain features.

### Homebrew Cask

Create a Homebrew Cask formula for easy installation:

```ruby
cask "common-tools" do
  version "0.1.0"
  sha256 "..." # SHA256 of the DMG

  url "https://github.com/commontoolsinc/labs/releases/download/v#{version}/Common.Tools_#{version}_universal.dmg"
  name "Common Tools"
  homepage "https://common.tools"

  app "Common Tools.app"
end
```

## Minimum Requirements

| Component | Version |
|-----------|---------|
| macOS | 12.0+ (Monterey) |
| Xcode Command Line Tools | Latest |
| Rust | 1.77.2+ |
| Deno | 2.0+ |
