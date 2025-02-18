# common-identity

This package contains functionality encapsulating identity and key management.

> [!CAUTION]
> This is incomplete, experimental software and no guarantees are provided.
> This software contains unaudited cryptography.
> Continue reading for full details of current status and limitations.

## How it works

Using the [Web Authentication API], we use passkeys managed by
authenticators (like Yubikeys, iCloud Keychain, and Google Password Manager) to provide cross-device
authentication. With the [PRF extension], a static challenge deterministically derives a 32-byte hash
from a passkey. Typical WebAuthn usage uses a server as a relying party, where a server records
the passkey's public key and additional metadata to map a key to a "user", however our usage currently
remains entirely client-side.

The derived 32-bytes is used as raw private key material for a `RootKey`, from which all identities are derived.
The `RootKey` is securely stored in IndexedDb at a well-known location, and on page load, is retrieved,
acting as a pseudo-cookie for authentication, so that the user does not need to reauthenticate their passkey.

Identities (not yet developed) are derived from root keys. Each *space* and *persona* identity is a keypair,
used to delegate authority. These keys are derived from the `RootKey` private key, and a "name", such that
the key can be deterministically derived. Eventually, the server will (probably) record which spaces/personas
are mapped to a "user" so that authenticating on a new device, the identity keys can be reproduced.

## Browser Support

This design is bound by a complex support matrix of OS, browser, and authenticator: [Device Support]

Additionally, the PRF extension **is not** currently supported in Firefox and Safari cross-device auth:

* [Firefox: Support WebAuthn PRF Extension](https://bugzilla.mozilla.org/show_bug.cgi?id=1863819)
* [Safari: PRF extension not supported in Safari's Cross-Device WebAuthn Flow](https://developer.apple.com/forums/thread/774112)

### Algorithms

The `RootKey` currently is an ed25519 key. [ed25519 is supported in Firefox and Safari](https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519),
though Chrome requires a feature flag to be enabled. As `RootKey` must be deterministically derived, we must use a consistent
algorithm without side channel information, and algorithm support can vary between browsers.
We could instead choose to always use RSA for the `RootKey`, which (should?) always be available, though it has less
secure properties than ed25519.

As the `RootKey` is the only key stored on the client, as such it is securely stored as a [CryptoKey](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey), requiring browser supporting the algorithm type. Otherwise, we could use userspace ed25519 algorithms, like we plan on doing for derived identities.

## Usage

See [`examples/index.html`](/typescript/packages/common-identity/examples/index.html) of an example authentication flow.

```js
import { PassKey, RootKey } from "@commontools/identity";

// First check if we've already stored a root key.
let rootKey = await RootKey.fromStorage();
if (rootKey) {
  setRootKey(rootKey);
}

// If no root key set, wait for user to authenticate a PassKey,
// either by creating a new one, or reauthenticating.
onRegister(async () => {
  // passkeys can store a "name" and "displayname" for use
  // with browser mediation UI.
  await PassKey.create("User Name", "displayname");
});

onLogin(async () => {
  // A passkey is already available on the device, fetch it
  // and derive a root key
  let passkey = await PassKey.get();
  let rootKey = await RootKey.fromPassKey(passkey); 
  // Store the rootkey so that it can be recovered
  // via `RootKey.fromStorage()`. 
  await rootKey.saveToStorage();
  setRootKey(rootKey);
});

function setRootKey(rootKey) {
  // start working with root key
}
```

## UX Considerations

* No Browser/authentication combinations allow sidestepping further verification on passkeys (e.g. fingerprint unlock) via the [`userVerification`](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions#userverification) option `"discouraged"`. 
* WebAuthn PRF results are only available upon retrieving the passkey (e.g. `navigator.credentials.get()`), not upon creation (`navigator.credentials.create()`). This means, due to always requiring user verification, that creating a new key will then also require fetching the key (2 unlocks) in order to derive a `RootKey`.

## Security/Privacy Considerations

* :warning: This cryptography has not been audited.
* :warning: This solution is in development and will change.
* The WebAuthn passkey's PRF output should be considered a secret key, as the `RootKey` is derived from it, though [WebAuthn APIs are not isolated from local and extension scripts](https://levischuck.com/blog/2023-02-prf-webauthn#heading-conclusion).
* No key rotation support yet. 

## Resources

* [Yubico Web Authn Playground](https://demo.yubico.com/webauthn-developers)
* Reset security keys via chrome `chrome://settings/securityKeys`
* [Device Support](https://passkeys.dev/device-support/)

[Web Authentication API]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
[PRF extension]: https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension