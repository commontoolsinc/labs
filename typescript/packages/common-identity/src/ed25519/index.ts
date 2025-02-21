import { KeyPairRaw, isInsecureCryptoKeyPair, isCryptoKeyPair, Signer, Verifier, DID } from "../interface.js";
import { NativeEd25519Signer, NativeEd25519Verifier, isNativeEd25519Supported } from "./native.js";
import { NobleEd25519Signer, NobleEd25519Verifier } from "./noble.js";
import * as bip39 from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english"

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519Signer implements Signer {
  private impl: NativeEd25519Signer | NobleEd25519Signer;
  constructor(impl: NativeEd25519Signer | NobleEd25519Signer) {
    this.impl = impl;
  }

  verifier(): Verifier {
    return this.impl.verifier();
  }

  serialize(): KeyPairRaw {
    return this.impl.serialize();
  }

  sign(data: Uint8Array): Promise<Uint8Array> {
    return this.impl.sign(data);
  }

  static async fromRaw(rawPrivateKey: Uint8Array): Promise<Ed25519Signer> {
    return new Ed25519Signer(await isNativeEd25519Supported() ?
      await NativeEd25519Signer.fromRaw(rawPrivateKey) :
      await NobleEd25519Signer.fromRaw(rawPrivateKey));
  }
  
  static async generate(): Promise<Ed25519Signer> {
    return new Ed25519Signer(await isNativeEd25519Supported() ?
      await NativeEd25519Signer.generate() :
      await NobleEd25519Signer.generate());
  }
  
  static async generateMnemonic(): Promise<[Ed25519Signer, string]> {
    let mnemonic = bip39.generateMnemonic(wordlist, 256);
    return [await Ed25519Signer.fromMnemonic(mnemonic), mnemonic]; 
  }
  
  static async fromMnemonic(mnemonic: string): Promise<Ed25519Signer> {
    let bytes = bip39.mnemonicToEntropy(mnemonic, wordlist);
    return await Ed25519Signer.fromRaw(bytes);
  }

  static deserialize(input: KeyPairRaw): Ed25519Signer {
    if (isCryptoKeyPair(input)) {
      return new Ed25519Signer(NativeEd25519Signer.deserialize(input));
    } else if (isInsecureCryptoKeyPair(input)) {
      return new Ed25519Signer(NobleEd25519Signer.deserialize(input));
    } else {
      throw new Error("common-identity: Could not deserialize key.");
    }
  };
}

export class Ed25519Verifier implements Verifier {
  private impl: NativeEd25519Verifier | NobleEd25519Verifier;
  private _did: string | null;
  constructor(impl: NativeEd25519Verifier | NobleEd25519Verifier) {
    this.impl = impl;
    this._did = null;
  }

  verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return this.impl.verify(signature, data);
  }

  async did(): Promise<string> {
    if (this._did) {
      return this._did;
    }
    this._did = await this.impl.did();
    return this._did;
  }

  static async fromDid(did: DID): Promise<Ed25519Verifier> {
    return new Ed25519Verifier(await isNativeEd25519Supported() ?
      await NativeEd25519Verifier.fromDid(did) :
      await NobleEd25519Verifier.fromDid(did));
  }

  static async fromRaw(rawPublicKey: Uint8Array): Promise<Ed25519Verifier> {
    return new Ed25519Verifier(await isNativeEd25519Supported() ?
      await NativeEd25519Verifier.fromRaw(rawPublicKey) :
      await NobleEd25519Verifier.fromRaw(rawPublicKey));
  }
}