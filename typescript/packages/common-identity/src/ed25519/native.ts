import * as ed25519 from "@noble/ed25519";
import { ED25519_ALG, bytesToDid, didToBytes } from "./utils.js";
import { DID, Signer, Verifier } from "../interface.js";

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
export const isNativeEd25519Supported = (() => {
  let isSupported: boolean | null = null;
  return async function isNativeEd25519Supported() {
    if (isSupported !== null) {
      return isSupported;
    }
    let dummyKey = new Uint8Array(32);
    try {
      await window.crypto.subtle.importKey("raw", dummyKey, ED25519_ALG, false, ["verify"]);
      isSupported = true;
    } catch (e) {
      isSupported = false;
    }
    return isSupported;
  }
})();

export class NativeEd25519Signer implements Signer {
  private keypair: CryptoKeyPair;
  constructor(keypair: CryptoKeyPair) {
    this.keypair = keypair;
  }

  verifier(): Verifier {
    return new NativeEd25519Verifier(this.keypair.publicKey);
  }

  serialize(): CryptoKeyPair {
    return this.keypair;
  }
  
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await window.crypto.subtle.sign(ED25519_ALG, this.keypair.privateKey, data));
  }

  static async fromRaw(rawPrivateKey: Uint8Array): Promise<NativeEd25519Signer> {
    const pkcs8Private = ed25519RawToPkcs8(rawPrivateKey);
    const rawPublic = await ed25519.getPublicKeyAsync(rawPrivateKey);
    const privateKey = await window.crypto.subtle.importKey("pkcs8", pkcs8Private, ED25519_ALG, false, ["sign"]);
    // Set the public key to be extractable for DID generation.
    const publicKey = await window.crypto.subtle.importKey("raw", rawPublic, ED25519_ALG, true, ["verify"]);
    return new NativeEd25519Signer({ publicKey, privateKey });
  }

  static async generate(): Promise<NativeEd25519Signer> {
    // This notably sets only the public key as extractable, ideal as we need
    // access to the public key for DID generation. 
    let keypair = await window.crypto.subtle.generateKey(ED25519_ALG, false, ["sign", "verify"]);
    return new NativeEd25519Signer(keypair);
  }

  static deserialize(keypair: CryptoKeyPair) {
    return new NativeEd25519Signer(keypair);
  }
}

export class NativeEd25519Verifier implements Verifier {
  private publicKey: CryptoKey;
  constructor(publicKey: CryptoKey) {
    this.publicKey = publicKey;
  }

  async did(): Promise<string> {
    let rawPublic = await window.crypto.subtle.exportKey("raw", this.publicKey);
    return bytesToDid(new Uint8Array(rawPublic));
  }

  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await window.crypto.subtle.verify(ED25519_ALG, this.publicKey, signature, data);
  }

  static async fromDid(did: DID): Promise<NativeEd25519Verifier> {
    let bytes = didToBytes(did);
    return await NativeEd25519Verifier.fromRaw(bytes);
  }

  static async fromRaw(rawPublicKey: Uint8Array): Promise<NativeEd25519Verifier> {
    // Set the public key to be extractable for DID generation.
    const publicKey = await window.crypto.subtle.importKey("raw", rawPublicKey, ED25519_ALG, true, ["verify"]);
    return new NativeEd25519Verifier(publicKey);
  }
}

// 0x302e020100300506032b657004220420
// via https://stackoverflow.com/a/79135112
const PKCS8_PREFIX = new Uint8Array([ 48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32 ]);

// Signer Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
// 
// @AUDIT
// via https://stackoverflow.com/a/79135112
function ed25519RawToPkcs8(rawSignerKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawSignerKey]);
}