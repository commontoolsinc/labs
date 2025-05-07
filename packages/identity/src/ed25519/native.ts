import * as ed25519 from "npm:@noble/ed25519";
import {
  AuthorizationError,
  bytesToDid,
  didToBytes,
  ED25519_ALG,
  ed25519RawToPkcs8,
  isNativeEd25519Supported,
} from "./utils.ts";
import {
  AsBytes,
  DIDKey,
  Result,
  Signature,
  Signer,
  Verifier,
} from "../interface.ts";

// WebCrypto Key formats for Ed25519
// Non-explicitly described in https://wicg.github.io/webcrypto-secure-curves/#ed25519
//
// | Format | Public | Private |
// | ------ | ------ |---------|
// | raw    |   X    |         |
// | jwk    |   X    |    X    |
// | pkcs8  |        |    X    |
// | spki   |   X    |         |

export class NativeEd25519Signer<ID extends DIDKey> implements Signer<ID> {
  #keypair: CryptoKeyPair;
  #did: ID;
  #verifier: Verifier<ID> | null = null;
  constructor(keypair: CryptoKeyPair, did: ID) {
    this.#keypair = keypair;
    this.#did = did;
  }

  did() {
    return this.#did;
  }

  get verifier(): Verifier<ID> {
    if (!this.#verifier) {
      this.#verifier = new NativeEd25519Verifier<ID>(
        this.#keypair.publicKey,
        this.#did,
      );
    }
    return this.#verifier;
  }

  serialize(): CryptoKeyPair {
    return this.#keypair;
  }

  async sign<T>(payload: AsBytes<T>): Promise<Result<Signature<T>, Error>> {
    try {
      const signature = new Uint8Array(
        await globalThis.crypto.subtle.sign(
          ED25519_ALG,
          this.#keypair.privateKey,
          payload,
        ),
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
    const privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      pkcs8Private,
      ED25519_ALG,
      false,
      ["sign"],
    );
    // Set the public key to be extractable for DID generation.
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      rawPublic,
      ED25519_ALG,
      true,
      [
        "verify",
      ],
    );
    const did = bytesToDid(new Uint8Array(rawPublic));
    return new NativeEd25519Signer({ publicKey, privateKey }, did as ID);
  }

  static async generate<ID extends DIDKey>(): Promise<NativeEd25519Signer<ID>> {
    // This notably sets only the public key as extractable, ideal as we need
    // access to the public key for DID generation.
    const keypair = await globalThis.crypto.subtle.generateKey(
      ED25519_ALG,
      false,
      [
        "sign",
        "verify",
      ],
    );
    const did = await didFromPublicKey(keypair.publicKey);
    return new NativeEd25519Signer(keypair, did as ID);
  }

  static async deserialize<ID extends DIDKey>(keypair: CryptoKeyPair) {
    const did = await didFromPublicKey(keypair.publicKey);
    return new NativeEd25519Signer(keypair, did as ID);
  }
}

export class NativeEd25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  #publicKey: CryptoKey;
  #did: ID;
  constructor(publicKey: CryptoKey, did: ID) {
    this.#publicKey = publicKey;
    this.#did = did;
  }

  did(): ID {
    return this.#did;
  }

  async verify(
    { signature, payload }: { payload: Uint8Array; signature: Uint8Array },
  ) {
    if (
      await globalThis.crypto.subtle.verify(
        ED25519_ALG,
        this.#publicKey,
        signature,
        payload,
      )
    ) {
      return { ok: {} };
    } else {
      return { error: new AuthorizationError("Invalid signature") };
    }
  }

  static async fromDid<ID extends DIDKey>(
    did: ID,
  ): Promise<NativeEd25519Verifier<ID>> {
    const bytes = didToBytes(did);
    return await NativeEd25519Verifier.fromRaw(bytes);
  }

  static async fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
  ): Promise<NativeEd25519Verifier<ID>> {
    const did = bytesToDid(new Uint8Array(rawPublicKey)) as ID;
    // Set the public key to be extractable for DID generation.
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      rawPublicKey,
      ED25519_ALG,
      true,
      [
        "verify",
      ],
    );
    return new NativeEd25519Verifier(publicKey, did);
  }
}

async function didFromPublicKey(publicKey: CryptoKey): Promise<DIDKey> {
  const rawPublicKey = await globalThis.crypto.subtle.exportKey(
    "raw",
    publicKey,
  );
  return bytesToDid(new Uint8Array(rawPublicKey));
}
