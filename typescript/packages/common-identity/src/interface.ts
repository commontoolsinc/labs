export type DID = `did:${string}:${string}`;

export type KeyPair = {
  privateKey: Signer,
  publicKey: Verifier,
};

export interface Signer {
  sign(data: Uint8Array): Promise<Uint8Array>;
  verifier(): Verifier;
  serialize(): KeyPairRaw;
}

export interface Verifier {
  verify(signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  did(): DID;
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