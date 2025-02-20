import { Ed25519KeyPair } from "./ed25519/index.js";
import { KeyPair, KeyPairRaw } from "./keys.js";
import { hash } from "./utils.js";

const textEncoder = new TextEncoder();

// An `Identity` represents a public/private key pair.
//
// Additional keys can be deterministically derived from an identity. 
export class Identity implements KeyPair {
  private keypair: Ed25519KeyPair;
  constructor(keypair: Ed25519KeyPair) {
    this.keypair = keypair;
  }

  // Sign `data` with this identity.
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await this.keypair.sign(data);
  }
 
  // Verify `signature` and `data` with this identity.
  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await this.keypair.verify(signature, data);
  }

  // Serialize this identity for storage.
  serialize(): KeyPairRaw {
    return this.keypair.serialize();
  }
  
  // Derive a new `Identity` given a seed string.
  async derive(name: string): Promise<Identity> {
    const seed = textEncoder.encode(name);
    const hashed = await hash(seed);
    const signed = await this.sign(hashed);
    const signedHash = await hash(signed);
    return await Identity.generateFromRaw(signedHash);
  }

  // Generate a new identity from raw ed25519 key material.
  static async generateFromRaw(rawPrivateKey: Uint8Array): Promise<Identity> {
    return new Identity(await Ed25519KeyPair.generateFromRaw(rawPrivateKey));
  }
  
  // Generate a new identity.
  static async generate(): Promise<Identity> {
    return new Identity(await Ed25519KeyPair.generate());
  }

  // Deserialize `input` from storage into an `Identity`.
  static deserialize(input: any): Identity {
    return new Identity(Ed25519KeyPair.deserialize(input)); 
  }
}