import * as ed25519 from "@noble/ed25519";
import { ED25519_ALG, bytesToDid, didToBytes, AuthorizationError } from "./utils.js";
import { AsBytes, DIDKey, Signature, Signer, Verifier, Result } from "../interface.js";
import { clone } from "../utils.js";

// WebCrypto Key formats for Ed25519
// Non-explicitly described in https://wicg.github.io/webcrypto-secure-curves/#ed25519
//
// | Format | Public | Private |
// | ------ | ------ |---------|
// | raw    |   X    |         |
// | jwk    |   X    |    X    |
// | pkcs8  |        |    X    |
// | spki   |   X    |         |

// Returns whether ed25519 is supported in Web Crypto API.
// Tests both 1) key creation and 2) serialization.
//
// * Chrome currently requires Experimental Web Features flag enabled for ed25519 keys
// * Firefox supports ed25519 keys, though cannot be serialized (stored in IndexedDB)
//   until v136 https://bugzilla.mozilla.org/show_bug.cgi?id=1939993
export const isNativeEd25519Supported = (() => {
  let isSupported: boolean | null = null;
  return async function isNativeEd25519Supported() {
    if (isSupported !== null) {
      return isSupported;
    }
    let dummyKey = new Uint8Array(32);
    try {
      let key = await window.crypto.subtle.importKey("raw", dummyKey, ED25519_ALG, false, [
        "verify",
      ]);
      await clone(key);
      isSupported = true;
    } catch (e) {
      isSupported = false;
    }
    return isSupported;
  };
})();

export class NativeEd25519Signer<ID extends DIDKey> implements Signer<ID> {
  private keypair: CryptoKeyPair;
  private _did: ID;
  #verifier: Verifier<ID> | null = null;
  constructor(keypair: CryptoKeyPair, did: ID) {
    this.keypair = keypair;
    this._did = did;
  }

  did() {
    return this._did;
  }

  get verifier(): Verifier<ID> {
    if (!this.#verifier) {
      this.#verifier = new NativeEd25519Verifier<ID>(this.keypair.publicKey, this._did);
    }
    return this.#verifier;
  }

  serialize(): CryptoKeyPair {
    return this.keypair;
  }

  async sign<T>(payload: AsBytes<T>): Promise<Result<Signature<T>, Error>> {
    try {
      const signature = new Uint8Array(
        await window.crypto.subtle.sign(ED25519_ALG, this.keypair.privateKey, payload),
      );

      return { ok: signature as Signature<T> };
    } catch (cause) {
      return { error: cause as Error };
    }
  }

  static async fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
  ): Promise<NativeEd25519Signer<ID>> {
    const pkcs8Private = ed25519RawToPkcs8(rawPrivateKey);
    const rawPublic = await ed25519.getPublicKeyAsync(rawPrivateKey);
    const privateKey = await window.crypto.subtle.importKey(
      "pkcs8",
      pkcs8Private,
      ED25519_ALG,
      false,
      ["sign"],
    );
    // Set the public key to be extractable for DID generation.
    const publicKey = await window.crypto.subtle.importKey("raw", rawPublic, ED25519_ALG, true, [
      "verify",
    ]);
    let did = bytesToDid(new Uint8Array(rawPublic)) as ID;
    return new NativeEd25519Signer({ publicKey, privateKey }, did);
  }

  static async generate<ID extends DIDKey>(): Promise<NativeEd25519Signer<ID>> {
    // This notably sets only the public key as extractable, ideal as we need
    // access to the public key for DID generation.
    let keypair = await window.crypto.subtle.generateKey(ED25519_ALG, false, ["sign", "verify"]);
    let did = await didFromPublicKey(keypair.publicKey);
    return new NativeEd25519Signer(keypair, did as ID);
  }

  static async deserialize<ID extends DIDKey>(keypair: CryptoKeyPair) {
    let did = await didFromPublicKey(keypair.publicKey);
    return new NativeEd25519Signer(keypair, did as ID);
  }
}

export class NativeEd25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  private publicKey: CryptoKey;
  private _did: ID;
  constructor(publicKey: CryptoKey, did: ID) {
    this.publicKey = publicKey;
    this._did = did;
  }

  did(): ID {
    return this._did;
  }

  async verify({ signature, payload }: { payload: Uint8Array; signature: Uint8Array }) {
    if (await window.crypto.subtle.verify(ED25519_ALG, this.publicKey, signature, payload)) {
      return { ok: {} };
    } else {
      return { error: new AuthorizationError("Invalid signature") };
    }
  }

  static async fromDid<ID extends DIDKey>(did: ID): Promise<NativeEd25519Verifier<ID>> {
    let bytes = didToBytes(did);
    return await NativeEd25519Verifier.fromRaw(bytes);
  }

  static async fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
  ): Promise<NativeEd25519Verifier<ID>> {
    let did = bytesToDid(new Uint8Array(rawPublicKey)) as ID;
    // Set the public key to be extractable for DID generation.
    const publicKey = await window.crypto.subtle.importKey("raw", rawPublicKey, ED25519_ALG, true, [
      "verify",
    ]);
    return new NativeEd25519Verifier(publicKey, did);
  }
}

// 0x302e020100300506032b657004220420
// via https://stackoverflow.com/a/79135112
const PKCS8_PREFIX = new Uint8Array([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);

// Signer Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
//
// @AUDIT
// via https://stackoverflow.com/a/79135112
function ed25519RawToPkcs8(rawSignerKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawSignerKey]);
}

async function didFromPublicKey(publicKey: CryptoKey): Promise<DIDKey> {
  let rawPublicKey = await window.crypto.subtle.exportKey("raw", publicKey);
  return bytesToDid(new Uint8Array(rawPublicKey));
}
