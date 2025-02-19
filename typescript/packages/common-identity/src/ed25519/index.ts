import { KeyPair, KeyPairStatic, KeyPairRaw, isInsecureCryptoKeyPair, isCryptoKeyPair } from "../keys.js";
import { NativeEd25519 } from "./native.js";
import { NobleEd25519 } from "./noble.js";

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519KeyPair implements KeyPair {
  private impl: KeyPair;
  constructor(impl: KeyPair) {
    this.impl = impl;
  }

  serialize(): KeyPairRaw {
    return this.impl.serialize();
  }

  sign(data: Uint8Array): Promise<Uint8Array> {
    return this.impl.sign(data);
  }

  verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return this.impl.verify(signature, data);
  }

  static async generateFromRaw(rawPrivateKey: Uint8Array): Promise<Ed25519KeyPair> {
    let Class: KeyPairStatic = (await NativeEd25519.isSupported()) ? NativeEd25519 : NobleEd25519;
    return new Ed25519KeyPair(await Class.generateFromRaw(rawPrivateKey)); 
  }
  
  static async generate(): Promise<Ed25519KeyPair> {
    let Class: KeyPairStatic = (await NativeEd25519.isSupported()) ? NativeEd25519 : NobleEd25519;
    return new Ed25519KeyPair(await Class.generate()); 
  }

  static deserialize(input: KeyPairRaw): Ed25519KeyPair {
    if (isCryptoKeyPair(input)) {
      return new Ed25519KeyPair(NativeEd25519.deserialize(input));
    } else if (isInsecureCryptoKeyPair(input)) {
      return new Ed25519KeyPair(NobleEd25519.deserialize(input));
    } else {
      throw new Error("common-identity: Could not deserialize key.");
    }
  };
}