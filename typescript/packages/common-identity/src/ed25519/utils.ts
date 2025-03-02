import { base58btc } from "multiformats/bases/base58";
import { varint } from "multiformats";
import { DIDKey } from "../interface.ts";

export const ED25519_ALG = "Ed25519";
const ED25519_CODE = 0xed;
const ED25519_PUB_KEY_RAW_SIZE = 32;
const ED25519_PUB_KEY_TAG_SIZE = varint.encodingLength(ED25519_CODE);
const ED25519_PUB_KEY_TAGGED_SIZE = ED25519_PUB_KEY_RAW_SIZE +
  ED25519_PUB_KEY_TAG_SIZE;
const DID_KEY_PREFIX = `did:key:`;
const DID_KEY_PREFIX_SIZE = DID_KEY_PREFIX.length;

// 0x302e020100300506032b657004220420
// via https://stackoverflow.com/a/79135112
const PKCS8_PREFIX = new Uint8Array([
  48,
  46,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  112,
  4,
  34,
  4,
  32,
]);

// Private Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
//
// @AUDIT
// via https://stackoverflow.com/a/79135112
export function ed25519RawToPkcs8(rawPrivateKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawPrivateKey]);
}

// Convert public key bytes into a `did:key:z...`.
export function bytesToDid(publicKey: Uint8Array): DIDKey {
  let bytes = new Uint8Array(ED25519_PUB_KEY_TAGGED_SIZE);
  varint.encodeTo(ED25519_CODE, bytes);
  bytes.set(publicKey, ED25519_PUB_KEY_TAG_SIZE);
  return `did:key:${base58btc.encode(bytes)}`;
}

// Convert DID key into public key bytes.
export function didToBytes(did: DIDKey): Uint8Array {
  const bytes = base58btc.decode(did.slice(DID_KEY_PREFIX_SIZE));
  const [code] = varint.decode(bytes);
  if (code !== ED25519_CODE) {
    throw new RangeError(
      `Unsupported key algorithm expected 0x${
        ED25519_CODE.toString(
          16,
        )
      }, instead of 0x${code.toString(16)}`,
    );
  }
  if (bytes.length !== ED25519_PUB_KEY_TAGGED_SIZE) {
    throw new RangeError(
      `Expected Uint8Array with byteLength ${ED25519_PUB_KEY_TAGGED_SIZE}, instead got Uint8Array with byteLength ${bytes.byteLength}`,
    );
  }
  return bytes.subarray(ED25519_PUB_KEY_TAG_SIZE);
}

export class AuthorizationError extends Error {
  override name = "AuthorizationError" as const;
}
