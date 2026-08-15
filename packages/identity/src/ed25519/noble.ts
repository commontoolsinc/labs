import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import * as ed25519 from "@noble/ed25519";

import {
  AsBytes,
  DIDKey,
  InsecureCryptoKeyPair,
  Result,
  Signature,
  Signer,
  Verifier,
} from "../interface.ts";
import { AuthorizationError, bytesToDid, didToBytes } from "./utils.ts";

export class NobleEd25519Signer<ID extends DIDKey> implements Signer<ID> {
  /**
   * The key material, held as `FabricBytes` so that it is immutable for as
   * long as this instance exists. Nothing the constructor was handed, and
   * nothing handed out since, can alter what this signs with.
   */
  #privateKey: FabricBytes;
  #publicKey: FabricBytes;

  #verifier: NobleEd25519Verifier<ID> | null = null;

  /** Constructs an instance holding its own immutable copy of `keypair`. */
  constructor(keypair: InsecureCryptoKeyPair) {
    this.#privateKey = new FabricBytes(keypair.privateKey);
    this.#publicKey = new FabricBytes(keypair.publicKey);
  }

  /**
   * This signer's private key. Handed out as held, no copy being needed to
   * make that safe: a `FabricBytes` cannot be altered by whoever receives it.
   * A caller wanting mutable bytes takes them with `slice()`, so a copy is
   * made where one is actually required rather than on every read.
   */
  privateKey(): FabricBytes {
    return this.#privateKey;
  }

  did() {
    return this.verifier.did();
  }

  get verifier(): NobleEd25519Verifier<ID> {
    if (!this.#verifier) {
      this.#verifier = new NobleEd25519Verifier(this.#publicKey);
    }
    return this.#verifier;
  }

  /** @inheritDoc */
  serialize(): InsecureCryptoKeyPair {
    return {
      privateKey: this.#privateKey.slice(),
      publicKey: this.#publicKey.slice(),
    };
  }

  async sign<T>(payload: AsBytes<T>): Promise<Result<Signature<T>, Error>> {
    try {
      const signature = await ed25519.signAsync(
        payload,
        this.#privateKey.slice(),
      );

      return { ok: signature as Signature<T> };
    } catch (cause) {
      return { error: cause as Error };
    }
  }

  static async fromRaw<ID extends DIDKey>(
    privateKey: Uint8Array,
  ): Promise<NobleEd25519Signer<ID>> {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    return new NobleEd25519Signer({ publicKey, privateKey });
  }

  static async generate<ID extends DIDKey>(): Promise<NobleEd25519Signer<ID>> {
    const privateKey = ed25519.utils.randomSecretKey();
    return await NobleEd25519Signer.fromRaw(privateKey);
  }

  static deserialize<ID extends DIDKey>(keypair: InsecureCryptoKeyPair) {
    return Promise.resolve(new NobleEd25519Signer<ID>(keypair));
  }
}

export class NobleEd25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  #publicKey: FabricBytes;
  #did: ID;

  /**
   * Constructs an instance. `publicKey` is immutable, so it is held as given;
   * the DID derived from it here therefore cannot drift from the key this
   * verifies with.
   */
  constructor(publicKey: FabricBytes) {
    this.#publicKey = publicKey;
    this.#did = bytesToDid(publicKey.slice()) as ID;
  }

  async verify(
    { signature, payload }: { payload: Uint8Array; signature: Uint8Array },
  ) {
    if (
      await ed25519.verifyAsync(signature, payload, this.#publicKey.slice())
    ) {
      return { ok: {} };
    } else {
      return { error: new AuthorizationError("Invalid signature") };
    }
  }

  did(): ID {
    return this.#did;
  }

  static async fromDid<ID extends DIDKey>(
    did: ID,
  ): Promise<NobleEd25519Verifier<ID>> {
    const bytes = didToBytes(did);
    return await NobleEd25519Verifier.fromRaw(bytes);
  }

  static fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
  ): Promise<NobleEd25519Verifier<ID>> {
    return Promise.resolve(
      new NobleEd25519Verifier(new FabricBytes(rawPublicKey)),
    );
  }
}
