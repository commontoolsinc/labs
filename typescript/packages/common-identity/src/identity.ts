import { Ed25519Signer, Ed25519Verifier } from "./ed25519/index.ts";
import { DIDKey, KeyPairRaw, Signer, Verifier, AsBytes } from "./interface.ts";
import { hash } from "./utils.ts";

const textEncoder = new TextEncoder();

// An `Identity` represents a public/private key pair.
//
// Additional keys can be deterministically derived from an identity.
export class Identity<ID extends DIDKey = DIDKey> implements Signer<ID> {
  private keypair: Ed25519Signer<ID>;
  #verifier: VerifierIdentity<ID> | null = null;
  constructor(keypair: Ed25519Signer<ID>) {
    this.keypair = keypair;
  }

  did() {
    return this.verifier.did();
  }

  get verifier(): VerifierIdentity<ID> {
    if (!this.#verifier) {
      this.#verifier = new VerifierIdentity(this.keypair.verifier);
    }

    return this.#verifier;
  }

  // Sign `data` with this identity.
  sign<T>(payload: AsBytes<T>) {
    return this.keypair.sign(payload);
  }

  // Serialize this identity for storage.
  serialize(): KeyPairRaw {
    return this.keypair.serialize();
  }

  // Derive a new `Identity` given a seed string.
  async derive<ID extends DIDKey>(name: string): Promise<Identity<ID>> {
    const seed = textEncoder.encode(name);
    const { ok: signed, error } = await this.sign(seed);
    if (error) {
      throw error;
    }
    const signedHash = await hash(signed);
    return await Identity.fromRaw(new Uint8Array(signedHash));
  }

  // Generate a new identity from raw ed25519 key material.
  static async fromRaw<ID extends DIDKey>(rawPrivateKey: Uint8Array): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.fromRaw<ID>(rawPrivateKey));
  }

  // Generate a new identity.
  static async generate<ID extends DIDKey>(): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.generate<ID>());
  }

  static async generateMnemonic<ID extends DIDKey>(): Promise<[Identity<ID>, string]> {
    let [signer, mnemonic] = await Ed25519Signer.generateMnemonic<ID>();
    return [new Identity(signer), mnemonic];
  }

  static async fromMnemonic<ID extends DIDKey>(mnemonic: string): Promise<Identity<ID>> {
    let signer = await Ed25519Signer.fromMnemonic<ID>(mnemonic);
    return new Identity(signer);
  }

  static async fromPassphrase<ID extends DIDKey>(passphrase: string): Promise<Identity<ID>> {
    const rawPrivateKey = await hash(new TextEncoder().encode(passphrase));
    return new Identity(await Ed25519Signer.fromRaw<ID>(rawPrivateKey));
  }

  // Deserialize `input` from storage into an `Identity`.
  static async deserialize<ID extends DIDKey>(input: any): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.deserialize(input));
  }
}

export class VerifierIdentity<ID extends DIDKey> implements Verifier<ID> {
  private inner: Verifier<ID>;

  constructor(inner: Verifier<ID>) {
    this.inner = inner;
  }

  verify(auth: { payload: Uint8Array; signature: Uint8Array }) {
    return this.inner.verify(auth);
  }

  did(): ID {
    return this.inner.did();
  }

  static async fromDid<ID extends DIDKey>(did: ID): Promise<VerifierIdentity<ID>> {
    return new VerifierIdentity(await Ed25519Verifier.fromDid(did));
  }
}
