export interface KeyPairStatic {
  generateFromRaw(rawPrivateKey: Uint8Array): Promise<KeyPair>;
  generate(): Promise<KeyPair>;
  deserialize(input: any): KeyPair;
}

export interface KeyPair {
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  serialize(): KeyPairRaw;
}

export type InsecureCryptoKeyPair = {
  privateKey: Uint8Array,
  publicKey: Uint8Array,
};

export type KeyPairRaw = CryptoKeyPair | InsecureCryptoKeyPair;

export function isCryptoKeyPair(input: any): input is CryptoKeyPair {
  return !!(window.CryptoKey && typeof input === "object" &&
    input.privateKey instanceof window.CryptoKey &&
    input.publicKey instanceof window.CryptoKey);
}

export function isInsecureCryptoKeyPair(input: any): input is CryptoKeyPair {
  return !!(typeof input === "object" &&
    input.privateKey instanceof Uint8Array &&
    input.publicKey instanceof Uint8Array);
}