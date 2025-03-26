import { base58btc } from "multiformats/bases/base58";
import { base64pad } from "multiformats/bases/base64";
import { varint } from "multiformats";
import { DIDKey } from "../interface.ts";
import * as ed25519 from "@noble/ed25519";
import { decode, encode } from "@commontools/utils/encoding";

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

function arrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function pkcs8ToEd25519Raw(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length !== (PKCS8_PREFIX.length + ED25519_PUB_KEY_RAW_SIZE)) {
    throw new Error("Invalid key length.");
  }
  if (!arrayEqual(pkcs8.subarray(0, 16), PKCS8_PREFIX)) {
    throw new Error("Invalid key prefix.");
  }
  return new Uint8Array(pkcs8.subarray(16, 48));
}

// Private Ed25519 keys cannot be imported into Subtle Crypto in "raw" format.
// Convert to "pkcs8" before doing so.
//
// @AUDIT
// via https://stackoverflow.com/a/79135112
export function ed25519RawToPkcs8(rawPrivateKey: Uint8Array): Uint8Array {
  return new Uint8Array([...PKCS8_PREFIX, ...rawPrivateKey]);
}

// Generates a new random key in pkcs8 format, pem encoded.
export function generateEd25519Pkcs8(): Uint8Array {
  return ed25519RawToPkcs8(ed25519.utils.randomPrivateKey());
}

const BEGIN_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----";
const END_PRIVATE_KEY = "-----END PRIVATE KEY-----";
const NEW_LINE = "\n";

export function toPEM(input: Uint8Array): Uint8Array {
  const encoded = encode(base64pad.encode(input));
  const header = encode(`${BEGIN_PRIVATE_KEY}${NEW_LINE}`);
  const newLine = encode(NEW_LINE);
  const footer = encode(END_PRIVATE_KEY);
  const totalLength = header.length + encoded.length + newLine.length +
    footer.length;
  const pem = new Uint8Array(totalLength);
  pem.set(header, 0);
  pem.set(encoded, header.length);
  pem.set(newLine, header.length + encoded.length);
  pem.set(footer, header.length + encoded.length + newLine.length);
  return pem;
}

export function fromPEM(input: Uint8Array): Uint8Array {
  let decoded = decode(input);
  decoded = decoded.replace(BEGIN_PRIVATE_KEY, "");
  decoded = decoded.replace(END_PRIVATE_KEY, "");
  decoded = decoded.replace(/\s/g, "");
  return base64pad.decode(decoded);
}

// Convert public key bytes into a `did:key:z...`.
export function bytesToDid(publicKey: Uint8Array): DIDKey {
  const bytes = new Uint8Array(ED25519_PUB_KEY_TAGGED_SIZE);
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
