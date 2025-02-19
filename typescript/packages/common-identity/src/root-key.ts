import { KeyStore } from "./key-store.js";
import { PassKey } from "./pass-key.js";
import { Ed25519KeyPair } from "./ed25519/index.js";

// A `RootKey` represents the primary key from which all identities
// are derived. A `RootKey` is deterministically derived from a `PassKey`'s
// PRF output, a 32-byte hash, which is used as ed25519 key material.
// Typically, there is only one instance of `RootKey` per document.
export class RootKey {
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

  // Save this key into a per-origin singleton storage.
  async saveToStorage() {
    let keyStore = await RootKey.getKeyStoreSingleton();
    await keyStore.set(this.keypair);
  }

  // Recover a `RootKey` from the per-origin singleton storage.
  static async fromStorage(): Promise<RootKey | undefined> {
    let keyStore = await RootKey.getKeyStoreSingleton();
    let keyMaterial = await keyStore.get();
    return keyMaterial ? new RootKey(keyMaterial) : undefined;
  }

  // Clear the per-origin singleton storage.
  static async clearStorage() {
    let keyStore = await RootKey.getKeyStoreSingleton();
    await keyStore.clear();
  }

  // Generate a `RootKey` from a `PassKey`.
  static async fromPassKey(passKey: PassKey): Promise<RootKey | undefined> {
    let seed = passKey.prf();
    if (!seed) {
      throw new Error("common-identity: No prf found from PassKey");
    }

    const keypair = await Ed25519KeyPair.generateFromRaw(seed);
    return new RootKey(keypair);
  }

  private static keyStore: Promise<KeyStore> | null = null;
  private static async getKeyStoreSingleton(): Promise<KeyStore> {
    if (RootKey.keyStore) {
      return RootKey.keyStore;
    }
    RootKey.keyStore = KeyStore.open();
    return RootKey.keyStore;
  }
}