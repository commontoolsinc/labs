import {
  AsBytes,
  DIDKey,
  isCryptoKeyPair,
  isInsecureCryptoKeyPair,
  KeyPairRaw,
  Signer,
  Verifier,
} from "../interface.ts";
import { NativeEd25519Signer, NativeEd25519Verifier } from "./native.ts";
import { NobleEd25519Signer, NobleEd25519Verifier } from "./noble.ts";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  ed25519RawToPkcs8,
  fromPEM,
  generateEd25519Pkcs8,
  isNativeEd25519Supported,
  pkcs8ToEd25519Raw,
  toPEM,
} from "./utils.ts";

// Creation options used in `Ed25519Signer` instantiation.
export interface Ed25519CreateConfig {
  // Indicates the preference of implementation to use.
  // If not specified, "webcrypto" is preferred if supported,
  // falling back to "noble" otherwise.
  // If specified, uses that implementation if supported, failing otherwise.
  implementation?: "webcrypto" | "noble";
}

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519Signer<ID extends DIDKey> implements Signer<ID> {
  #impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>;
  constructor(impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>) {
    this.#impl = impl;
  }

  get verifier(): Verifier<ID> {
    return this.#impl.verifier;
  }

  serialize(): KeyPairRaw {
    return this.#impl.serialize();
  }

  did() {
    return this.#impl.did();
  }

  sign<T>(payload: AsBytes<T>) {
    return this.#impl.sign(payload);
  }

  // Only "noble" implementations can be converted to PKCS8
  // since we need the raw material.
  toPkcs8() {
    const serialized = this.serialize();
    if (
      "privateKey" in serialized &&
      serialized.privateKey instanceof Uint8Array
    ) {
      return toPEM(ed25519RawToPkcs8(serialized.privateKey));
    }
    throw new Error(
      'Cannot convert identity to PKCS8 format: requires "noble" implementation.',
    );
  }

  static async fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      await canUseNative(config)
        ? await NativeEd25519Signer.fromRaw(rawPrivateKey)
        : await NobleEd25519Signer.fromRaw(rawPrivateKey),
    );
  }

  static async generate<ID extends DIDKey>(
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      await canUseNative(config)
        ? await NativeEd25519Signer.generate()
        : await NobleEd25519Signer.generate(),
    );
  }

  static async generateMnemonic<ID extends DIDKey>(
    config: Ed25519CreateConfig = {},
  ): Promise<
    [Ed25519Signer<ID>, string]
  > {
    const mnemonic = bip39.generateMnemonic(wordlist, 256);
    return [await Ed25519Signer.fromMnemonic(mnemonic, config), mnemonic];
  }

  static generatePkcs8(): Uint8Array {
    return toPEM(generateEd25519Pkcs8());
  }

  static async fromPkcs8<ID extends DIDKey>(
    pkcs8: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    const raw = pkcs8ToEd25519Raw(fromPEM(pkcs8));
    return await Ed25519Signer.fromRaw(raw, config);
  }

  static async fromMnemonic<ID extends DIDKey>(
    mnemonic: string,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    const bytes = bip39.mnemonicToEntropy(mnemonic, wordlist);
    return await Ed25519Signer.fromRaw(bytes, config);
  }

  static async deserialize<ID extends DIDKey>(
    input: KeyPairRaw,
  ): Promise<Ed25519Signer<ID>> {
    if (isCryptoKeyPair(input)) {
      return new Ed25519Signer(
        await NativeEd25519Signer.deserialize<ID>(input),
      );
    } else if (isInsecureCryptoKeyPair(input)) {
      return new Ed25519Signer(await NobleEd25519Signer.deserialize(input));
    } else {
      throw new Error("common-identity: Could not deserialize key.");
    }
  }
}

export class Ed25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  #impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>;
  constructor(impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>) {
    this.#impl = impl;
  }

  verify(auth: { payload: Uint8Array; signature: Uint8Array }) {
    return this.#impl.verify(auth);
  }

  did() {
    return this.#impl.did();
  }

  static async fromDid<ID extends DIDKey>(
    did: ID,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      await canUseNative(config)
        ? await NativeEd25519Verifier.fromDid(did)
        : await NobleEd25519Verifier.fromDid(did),
    );
  }

  static async fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      await canUseNative(config)
        ? await NativeEd25519Verifier.fromRaw(rawPublicKey)
        : await NobleEd25519Verifier.fromRaw(rawPublicKey),
    );
  }
}

// Returns `true` if native WebCrypto should be used,
// or `false` if Noble implementation should be used.
//
// If WebCrypto explicitly requested and not supported,
// throws an error.
async function canUseNative(config: Ed25519CreateConfig = {}) {
  if (config.implementation === "webcrypto") {
    if (!(await isNativeEd25519Supported())) {
      throw new Error(
        "Required WebCrypto features are not supported on this platform.",
      );
    }
    return true;
  }
  if (config.implementation === "noble") {
    return false;
  }
  return await isNativeEd25519Supported();
}
