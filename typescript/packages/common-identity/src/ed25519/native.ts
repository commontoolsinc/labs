import * as ed25519 from "@noble/ed25519";
import { ED25519_ALG, keyToDid } from "./utils.js";
import { KeyPair, KeyPairRaw } from "../keys.js";

// WebCrypto Key formats for Ed25519
// Non-explicitly described in https://wicg.github.io/webcrypto-secure-curves/#ed25519
//
// | Format | Public | Private |
// | ------ | ------ |---------|
// | raw    |   X    |         | 
// | jwk    |   X    |    X    |
// | pkcs8  |        |    X    |
// | spki   |   X    |         |

export class NativeEd25519 implements KeyPair {
  private keypair: CryptoKeyPair;
  constructor(keypair: CryptoKeyPair) {
    this.keypair = keypair;
  }

  async did(): Promise<string> {
    let rawPublic = await window.crypto.subtle.exportKey("raw", this.keypair.publicKey);
    return keyToDid(new Uint8Array(rawPublic));
  }

  serialize(): KeyPairRaw {
    return this.keypair;
  }
  
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await window.crypto.subtle.sign(ED25519_ALG, this.keypair.privateKey, data));
  }
 
  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await window.crypto.subtle.verify(ED25519_ALG, this.keypair.publicKey, signature, data);
  }

  static async generateFromRaw(rawPrivateKey: Uint8Array): Promise<NativeEd25519> {
    const pkcs8Private = ed25519RawToPkcs8(rawPrivateKey);
    const rawPublic = await ed25519.getPublicKeyAsync(rawPrivateKey);
    const privateKey = await window.crypto.subtle.importKey("pkcs8", pkcs8Private, ED25519_ALG, false, ["sign"]);
    // Set the public key to be extractable for DID generation.
    const publicKey = await window.crypto.subtle.importKey("raw", rawPublic, ED25519_ALG, true, ["verify"]);
    return new NativeEd25519({ publicKey, privateKey });
  }

  static async generate(): Promise<NativeEd25519> {
    // This notably sets only the private key as extractable, ideal as we need
    // access to the public key for DID generation. 
    let keypair = await window.crypto.subtle.generateKey(ED25519_ALG, false, ["sign", "verify"]);
    return new NativeEd25519(keypair);
  }

  static deserialize(keypair: CryptoKeyPair) {
    return new NativeEd25519(keypair);
  }

  // Returns whether ed25519 is supported in Web Crypto API.
  static async isSupported() {
    let dummyKey = new Uint8Array(32);
    try {
      await window.crypto.subtle.importKey("raw", dummyKey, ED25519_ALG, false, ["verify"]);
      return true;
    } catch (e) {}
    return false;
  }
}

// 0x302e020100300506032b657004220420
// via https://stackoverflow.com/a/79135112
const PKCS8_PREFIX = new Uint8Array([ 48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32 ]);

// Private Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
// 
// @AUDIT
// via https://stackoverflow.com/a/79135112
function ed25519RawToPkcs8(rawPrivateKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawPrivateKey]);
}