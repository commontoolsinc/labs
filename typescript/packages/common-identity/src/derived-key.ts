import { Ed25519KeyPair } from "./ed25519/index.js";
import { KeyPair, KeyPairRaw } from "./keys.js";
import { RootKey } from "./root-key.js";
import { hash } from "./utils.js";

const textEncoder = new TextEncoder();

export class DerivedKey implements KeyPair {
  private keypair: Ed25519KeyPair;
  constructor(keypair: Ed25519KeyPair) {
    this.keypair = keypair;
  }

  // Sign `data` with this `RootKey`.
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await this.keypair.sign(data);
  }
 
  // Verify `signature` and `data` with this `RootKey`.
  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await this.keypair.verify(signature, data);
  }

  serialize(): KeyPairRaw {
    return this.keypair.serialize();
  }

  // Generate a `RootKey` from a `PassKey`.
  static async fromRootKey(rootKey: RootKey, name: string): Promise<DerivedKey> {
    const seed = textEncoder.encode(name);
    const hashed = await hash(seed);
    const signed = await rootKey.sign(hashed);
    const signedHash = await hash(signed);
    const keypair = await Ed25519KeyPair.generateFromRaw(signedHash);
    return new DerivedKey(keypair);
  }
}