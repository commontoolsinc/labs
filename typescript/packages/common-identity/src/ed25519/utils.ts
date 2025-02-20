import bs58 from "bs58";

export const ED25519_ALG = "Ed25519";

// 0x302e020100300506032b657004220420
// via https://stackoverflow.com/a/79135112
const PKCS8_PREFIX = new Uint8Array([ 48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32 ]);

// Private Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
// 
// @AUDIT
// via https://stackoverflow.com/a/79135112
export function ed25519RawToPkcs8(rawPrivateKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawPrivateKey]);
}

const ED25519_MAGIC_BYTES = new Uint8Array([0xed, 0x01]);

// Convert public key bytes into a `did:key:z...`.
export function keyToDid(publicKey: Uint8Array): string {
  let bytes = new Uint8Array(ED25519_MAGIC_BYTES.length + publicKey.length);
  bytes.set(ED25519_MAGIC_BYTES);
  bytes.set(publicKey, ED25519_MAGIC_BYTES.length);
  return `did:key:z${bs58.encode(bytes)}`;
}