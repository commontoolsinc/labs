import * as ed25519 from "@noble/ed25519";
import {
  InsecureCryptoKeyPair,
  Verifier,
  Signer,
  DIDKey,
  AsBytes,
  Signature,
  Result,
} from "../interface.js";
import { bytesToDid, didToBytes, AuthorizationError } from "./utils.js";

export class NobleEd25519Signer<ID extends DIDKey> implements Signer<ID> {
  private keypair: InsecureCryptoKeyPair;
  #verifier: NobleEd25519Verifier<ID> | null = null;
  constructor(keypair: InsecureCryptoKeyPair) {
    this.keypair = keypair;
  }
  did() {
    return this.verifier.did();
  }

  get verifier(): NobleEd25519Verifier<ID> {
    if (!this.#verifier) {
      this.#verifier = new NobleEd25519Verifier(this.keypair.publicKey);
    }
    return this.#verifier;
  }

  serialize(): InsecureCryptoKeyPair {
    return this.keypair;
  }

  async sign<T>(payload: AsBytes<T>): Promise<Result<Signature<T>, Error>> {
    try {
      const signature = await ed25519.signAsync(payload, this.keypair.privateKey);

      return { ok: signature as Signature<T> };
    } catch (cause) {
      return { error: cause as Error };
    }
  }

  static async fromRaw<ID extends DIDKey>(privateKey: Uint8Array): Promise<NobleEd25519Signer<ID>> {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    return new NobleEd25519Signer({ publicKey, privateKey });
  }

  static async generate<ID extends DIDKey>(): Promise<NobleEd25519Signer<ID>> {
    let privateKey = ed25519.utils.randomPrivateKey();
    return await NobleEd25519Signer.fromRaw(privateKey);
  }

  static async deserialize<ID extends DIDKey>(keypair: InsecureCryptoKeyPair) {
    return new NobleEd25519Signer<ID>(keypair);
  }
}

export class NobleEd25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  private publicKey: Uint8Array;
  private _did: ID;
  constructor(publicKey: Uint8Array) {
    this.publicKey = publicKey;
    this._did = bytesToDid(publicKey) as ID;
  }

  async verify({ signature, payload }: { payload: Uint8Array; signature: Uint8Array }) {
    if (await ed25519.verifyAsync(signature, payload, this.publicKey)) {
      return { ok: {} };
    } else {
      return { error: new AuthorizationError("Invalid signature") };
    }
  }

  did(): ID {
    return this._did;
  }

  static async fromDid<ID extends DIDKey>(did: ID): Promise<NobleEd25519Verifier<ID>> {
    let bytes = didToBytes(did);
    return await NobleEd25519Verifier.fromRaw(bytes);
  }

  static async fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
  ): Promise<NobleEd25519Verifier<ID>> {
    return new NobleEd25519Verifier(rawPublicKey);
  }
}
