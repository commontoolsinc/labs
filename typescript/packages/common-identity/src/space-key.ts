import { Ed25519KeyPair } from "./ed25519/index.js";
import { KeyPair, KeyPairRaw } from "./keys.js";

export class SpaceKey implements KeyPair {
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
  static async generate(): Promise<SpaceKey> {
    return new SpaceKey(await Ed25519KeyPair.generate());
  }
}