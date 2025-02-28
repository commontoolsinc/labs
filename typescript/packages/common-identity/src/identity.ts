import { Ed25519Signer, Ed25519Verifier } from "./ed25519/index.ts";
import { DID, KeyPairRaw, Signer, Verifier } from "./interface.ts";
import { hash } from "./utils.ts";

const textEncoder = new TextEncoder();

// An `Identity` represents a public/private key pair.
//
// Additional keys can be deterministically derived from an identity.
export class Identity implements Signer {
  private keypair: Ed25519Signer;
  constructor(keypair: Ed25519Signer) {
    this.keypair = keypair;
  }

  verifier(): VerifierIdentity {
    return new VerifierIdentity(this.keypair.verifier());
  }

  // Sign `data` with this identity.
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await this.keypair.sign(data);
  }

  // Serialize this identity for storage.
  serialize(): KeyPairRaw {
    return this.keypair.serialize();
  }

  // Derive a new `Identity` given a seed string.
  async derive(name: string): Promise<Identity> {
    const seed = textEncoder.encode(name);
    const signed = await this.sign(seed);
    const signedHash = await hash(signed);
    return await Identity.fromRaw(new Uint8Array(signedHash));
  }

  // Generate a new identity from raw ed25519 key material.
  static async fromRaw(rawPrivateKey: Uint8Array): Promise<Identity> {
    return new Identity(await Ed25519Signer.fromRaw(rawPrivateKey));
  }

  // Generate a new identity.
  static async generate(): Promise<Identity> {
    return new Identity(await Ed25519Signer.generate());
  }

  static async generateMnemonic(): Promise<[Identity, string]> {
    let [signer, mnemonic] = await Ed25519Signer.generateMnemonic();
    return [new Identity(signer), mnemonic];
  }

  static async fromMnemonic(mnemonic: string): Promise<Identity> {
    let signer = await Ed25519Signer.fromMnemonic(mnemonic);
    return new Identity(signer);
  }

  // Deserialize `input` from storage into an `Identity`.
  static async deserialize(input: any): Promise<Identity> {
    return new Identity(await Ed25519Signer.deserialize(input));
  }
}

export class VerifierIdentity implements Verifier {
  private inner: Verifier;

  constructor(inner: Verifier) {
    this.inner = inner;
  }

  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await this.inner.verify(signature, data);
  }

  did(): DID {
    return this.inner.did();
  }

  static async fromDid(did: DID): Promise<VerifierIdentity> {
    return new VerifierIdentity(await Ed25519Verifier.fromDid(did));
  }
}
