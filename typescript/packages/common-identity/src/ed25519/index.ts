import { KeyPair, KeyPairRaw, isInsecureCryptoKeyPair, isCryptoKeyPair } from "../keys.js";
import { NativeEd25519 } from "./native.js";
import { NobleEd25519 } from "./noble.js";

type Impl = NativeEd25519 | NobleEd25519;

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519KeyPair implements KeyPair {
  private impl: Impl;
  private _did: string | null;
  constructor(impl: Impl) {
    this.impl = impl;
    this._did = null;
  }

  async did() {
    if (this._did) {
      return this._did;
    }
    this._did = await this.impl.did();
    return this._did;
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
    return new Ed25519KeyPair(await NativeEd25519.isSupported() ?
      await NativeEd25519.generateFromRaw(rawPrivateKey) :
      await NobleEd25519.generateFromRaw(rawPrivateKey));
  }
  
  static async generate(): Promise<Ed25519KeyPair> {
    return new Ed25519KeyPair(await NativeEd25519.isSupported() ?
      await NativeEd25519.generate() :
      await NobleEd25519.generate());
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