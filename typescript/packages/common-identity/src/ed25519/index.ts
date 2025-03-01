import {
  KeyPairRaw,
  isInsecureCryptoKeyPair,
  isCryptoKeyPair,
  Signer,
  Verifier,
  DIDKey,
  AsBytes,
} from "../interface.ts";
import { NativeEd25519Signer, NativeEd25519Verifier, isNativeEd25519Supported } from "./native.ts";
import { NobleEd25519Signer, NobleEd25519Verifier } from "./noble.ts";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519Signer<ID extends DIDKey> implements Signer<ID> {
  private impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>;
  constructor(impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>) {
    this.impl = impl;
  }

  get verifier(): Verifier<ID> {
    return this.impl.verifier;
  }

  serialize(): KeyPairRaw {
    return this.impl.serialize();
  }

  did() {
    return this.impl.did();
  }

  sign<T>(payload: AsBytes<T>) {
    return this.impl.sign(payload);
  }

  static async fromRaw<ID extends DIDKey>(rawPrivateKey: Uint8Array): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      (await isNativeEd25519Supported())
        ? await NativeEd25519Signer.fromRaw(rawPrivateKey)
        : await NobleEd25519Signer.fromRaw(rawPrivateKey),
    );
  }

  static async generate<ID extends DIDKey>(): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      (await isNativeEd25519Supported())
        ? await NativeEd25519Signer.generate()
        : await NobleEd25519Signer.generate(),
    );
  }

  static async generateMnemonic<ID extends DIDKey>(): Promise<[Ed25519Signer<ID>, string]> {
    let mnemonic = bip39.generateMnemonic(wordlist, 256);
    return [await Ed25519Signer.fromMnemonic(mnemonic), mnemonic];
  }

  static async fromMnemonic<ID extends DIDKey>(mnemonic: string): Promise<Ed25519Signer<ID>> {
    let bytes = bip39.mnemonicToEntropy(mnemonic, wordlist);
    return await Ed25519Signer.fromRaw(bytes);
  }

  static async deserialize<ID extends DIDKey>(input: KeyPairRaw): Promise<Ed25519Signer<ID>> {
    if (isCryptoKeyPair(input)) {
      return new Ed25519Signer(await NativeEd25519Signer.deserialize<ID>(input));
    } else if (isInsecureCryptoKeyPair(input)) {
      return new Ed25519Signer(await NobleEd25519Signer.deserialize(input));
    } else {
      throw new Error("common-identity: Could not deserialize key.");
    }
  }
}

export class Ed25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  private impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>;
  constructor(impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>) {
    this.impl = impl;
  }

  verify(auth: { payload: Uint8Array; signature: Uint8Array }) {
    return this.impl.verify(auth);
  }

  did() {
    return this.impl.did();
  }

  static async fromDid<ID extends DIDKey>(did: ID): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      (await isNativeEd25519Supported())
        ? await NativeEd25519Verifier.fromDid(did)
        : await NobleEd25519Verifier.fromDid(did),
    );
  }

  static async fromRaw<ID extends DIDKey>(rawPublicKey: Uint8Array): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      (await isNativeEd25519Supported())
        ? await NativeEd25519Verifier.fromRaw(rawPublicKey)
        : await NobleEd25519Verifier.fromRaw(rawPublicKey),
    );
  }
}
