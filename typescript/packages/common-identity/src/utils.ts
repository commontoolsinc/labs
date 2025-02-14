import * as ed25519 from "@noble/ed25519";

export function random(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  window.crypto.getRandomValues(buffer);
  return buffer;
}

export function bufferSourceToArrayBuffer(source: BufferSource): ArrayBuffer | SharedArrayBuffer {
  return ArrayBuffer.isView(source) ? source.buffer : source;
}

// Bind a handler to an `EventTarget`'s event once.
export function once(target: EventTarget, eventName: string, callback: (e: any) => any) {
  const wrap = (e: Event) => {
    callback(e);
    target.removeEventListener(eventName, wrap);
  }
  target.addEventListener(eventName, wrap);
}

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

// Derive a ed25519 `CryptoKeyPair` from a 32-byte seed.
export async function rawToEd25519KeyPair(seed: Uint8Array): Promise<CryptoKeyPair> {
  const pkcs8Private = ed25519RawToPkcs8(seed);
  const rawPublic = await ed25519.getPublicKey(seed);
  const privateKey = await window.crypto.subtle.importKey("pkcs8", pkcs8Private, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = await window.crypto.subtle.importKey("raw", rawPublic, { name: "Ed25519" }, false, ["verify"]);
  return { publicKey, privateKey };
}

// Derive a RSA `CryptoKeyPair` from a 32-byte seed.
export async function rawToRSAKeyPair(_seed: Uint8Array): Promise<CryptoKeyPair> {
  throw new Error("TODO");
}