import * as ed25519 from "npm:@noble/ed25519";
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
  #keypair: InsecureCryptoKeyPair;
  #verifier: NobleEd25519Verifier<ID> | null = null;
  constructor(keypair: InsecureCryptoKeyPair) {
    this.#keypair = keypair;
  }

  did() {
    return this.verifier.did();
  }

  get verifier(): NobleEd25519Verifier<ID> {
    if (!this.#verifier) {
      this.#verifier = new NobleEd25519Verifier(this.#keypair.publicKey);
    }
    return this.#verifier;
  }

  serialize(): InsecureCryptoKeyPair {
    return this.#keypair;
  }

  async sign<T>(payload: AsBytes<T>): Promise<Result<Signature<T>, Error>> {
    try {
      const signature = await ed25519.signAsync(
        payload,
        this.#keypair.privateKey,
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
    const privateKey = ed25519.utils.randomPrivateKey();
    return await NobleEd25519Signer.fromRaw(privateKey);
  }

  static deserialize<ID extends DIDKey>(keypair: InsecureCryptoKeyPair) {
    return Promise.resolve(new NobleEd25519Signer<ID>(keypair));
  }
}

export class NobleEd25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  #publicKey: Uint8Array;
  #did: ID;
  constructor(publicKey: Uint8Array) {
    this.#publicKey = publicKey;
    this.#did = bytesToDid(publicKey) as ID;
  }

  async verify(
    { signature, payload }: { payload: Uint8Array; signature: Uint8Array },
  ) {
    if (await ed25519.verifyAsync(signature, payload, this.#publicKey)) {
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
    return Promise.resolve(new NobleEd25519Verifier(rawPublicKey));
  }
}
