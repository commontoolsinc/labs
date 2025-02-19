import * as ed25519 from "@noble/ed25519";
import { KeyPair, InsecureCryptoKeyPair, KeyPairRaw } from "../keys.js";

export class NobleEd25519 implements KeyPair {
  private keypair: InsecureCryptoKeyPair;
  constructor(keypair: InsecureCryptoKeyPair) {
    this.keypair = keypair;
  }

  serialize(): KeyPairRaw {
    return this.keypair;
  }
  
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await ed25519.signAsync(data, this.keypair.privateKey);
  }
 
  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await ed25519.verifyAsync(signature, data, this.keypair.publicKey);
  }

  static async generateFromRaw(privateKey: Uint8Array): Promise<NobleEd25519> {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    return new NobleEd25519({ publicKey, privateKey });
  }

  static async generate(): Promise<NobleEd25519> {
    let privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    return new NobleEd25519({ publicKey, privateKey });
  }

  static deserialize(keypair: InsecureCryptoKeyPair) {
    return new NobleEd25519(keypair);
  }
}