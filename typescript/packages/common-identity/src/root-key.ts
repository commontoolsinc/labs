import { KeyStore } from "./key-store.js";
import { PassKey } from "./pass-key.js";
import { rawToEd25519KeyPair } from "./utils.js";

const ED25519 = "ed25519";

// WebCrypto Key formats for Ed25519
// Non-explicitly described in https://wicg.github.io/webcrypto-secure-curves/#ed25519
//
// | Format | Public | Private |
// | ------ | ------ |---------|
// | raw    |   X    |         | 
// | jwk    |   X    |    X    |
// | pkcs8  |        |    X    |
// | spki   |   X    |         |

// A `RootKey` represents the primary key from which all identities
// are derived. A `RootKey` is deterministically derived from a `PassKey`'s
// PRF output, a 32-byte hash, which is used as ed25519 key material.
// Typically, there is only one instance of `RootKey` per document.
export class RootKey {
  private keypair: CryptoKeyPair;
  constructor(keypair: CryptoKeyPair) {
    this.keypair = keypair;
  }

  // Sign `data` with this `RootKey`.
  async sign(data: Uint8Array): Promise<ArrayBuffer> {
    return await window.crypto.subtle.sign(ED25519, this.keypair.privateKey, data);
  }
 
  // Verify `signature` and `data` with this `RootKey`.
  async verify(signature: ArrayBuffer, data: Uint8Array): Promise<boolean> {
    return await window.crypto.subtle.verify(ED25519, this.keypair.publicKey, signature, data);
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

    const keypair = await rawToEd25519KeyPair(seed);
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