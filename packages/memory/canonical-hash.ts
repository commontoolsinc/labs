/**
 * Canonical hash of an arbitrary value, producing a deterministic digest
 * based on the value's logical structure.
 *
 * Replaces merkle-reference's CID-based hashing. Traverses the value tree
 * directly (no intermediate serialization) and feeds type-tagged data into
 * a single SHA-256 context. See Section 6 of the formal spec and the
 * byte-level spec for the full algorithm.
 *
 * Gated behind `ExperimentalOptions.canonicalHashing`.
 */
import { createHasher, type IncrementalHasher } from "./hash-impl.ts";
import {
  StorableDate,
  StorableUint8Array,
} from "./storable-native-instances.ts";
import {
  DECONSTRUCT,
  isStorableInstance,
  type StorableInstance,
} from "./storable-protocol.ts";

// ---------------------------------------------------------------------------
// Type tag bytes (Section 2 of the byte-level spec)
// ---------------------------------------------------------------------------

const TAG_NULL = 0x00;
const TAG_BOOL = 0x01;
const TAG_NUMBER = 0x02;
const TAG_STRING = 0x03;
const TAG_BIGINT = 0x04;
const TAG_UNDEF = 0x05;
const TAG_BYTES = 0x06;
const TAG_DATE = 0x07;
const TAG_ARRAY = 0x08;
const TAG_OBJECT = 0x09;
const TAG_STOR = 0x0a;
const TAG_HOLE = 0x0b;

// ---------------------------------------------------------------------------
// Shared scratch buffers (safe in single-threaded JS)
// ---------------------------------------------------------------------------

/** Reusable 8-byte buffer for float64 and int64 encoding. */
const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);
const f64Bytes = new Uint8Array(f64Buf);

/** Reusable 4-byte buffer for uint32 encoding. */
const u32Buf = new ArrayBuffer(4);
const u32View = new DataView(u32Buf);
const u32Bytes = new Uint8Array(u32Buf);

/** Shared TextEncoder for UTF-8 string encoding. */
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helper: feed fixed-size integers
// ---------------------------------------------------------------------------

function feedUint32(hasher: IncrementalHasher, value: number): void {
  u32View.setUint32(0, value, false); // big-endian
  hasher.update(u32Bytes);
}

function feedInt64(hasher: IncrementalHasher, value: bigint): void {
  f64View.setBigInt64(0, value, false); // big-endian
  hasher.update(f64Bytes);
}

// ---------------------------------------------------------------------------
// Helper: bigint to minimal two's-complement big-endian bytes
// ---------------------------------------------------------------------------

function bigintToMinimalTwosComplement(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array([0]);
  }

  // Determine if negative.
  const negative = value < 0n;

  let hex: string;
  if (!negative) {
    hex = value.toString(16);
    // Pad to even length.
    if (hex.length % 2 !== 0) hex = "0" + hex;
    // If high bit is set, prepend a zero byte to keep it positive.
    if (parseInt(hex[0], 16) >= 8) hex = "00" + hex;
  } else {
    // For negative numbers, compute two's complement.
    const abs = -value;
    const absHex = abs.toString(16);
    // Number of bits for the magnitude.
    const bitLen = absHex.length * 4;
    // We need enough bytes to represent the value, rounded up.
    let byteLen = Math.ceil(bitLen / 8);
    // Two's complement of -abs is 2^n - abs where n is the byte-aligned size.
    let twos = (1n << BigInt(byteLen * 8)) - abs;
    // Verify the high bit is set (value must look negative).
    const highNibble = parseInt(twos.toString(16)[0] || "0", 16);
    if (highNibble < 8) {
      // High bit not set -- need one more byte.
      byteLen++;
      twos = (1n << BigInt(byteLen * 8)) - abs;
    }
    hex = twos.toString(16);
    // Pad to exact byte length.
    while (hex.length < byteLen * 2) hex = "0" + hex;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Core: recursive value feeding
// ---------------------------------------------------------------------------

/**
 * Feed a single `StorableValue` into the hasher, using the type-tagged
 * byte format from the byte-level spec.
 */
function feedValue(hasher: IncrementalHasher, value: unknown): void {
  // 1. null
  if (value === null) {
    hasher.update(new Uint8Array([TAG_NULL]));
    return;
  }

  // 2. boolean
  if (typeof value === "boolean") {
    hasher.update(new Uint8Array([TAG_BOOL, value ? 0x01 : 0x00]));
    return;
  }

  // 3. number
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `canonicalHash: non-finite number not allowed: ${value}`,
      );
    }
    hasher.update(new Uint8Array([TAG_NUMBER]));
    // Normalize -0 to +0.
    const normalized = value === 0 ? 0 : value;
    f64View.setFloat64(0, normalized, false); // big-endian
    hasher.update(f64Bytes);
    return;
  }

  // 4. string
  if (typeof value === "string") {
    hasher.update(new Uint8Array([TAG_STRING]));
    const utf8 = encoder.encode(value);
    feedUint32(hasher, utf8.length);
    hasher.update(utf8);
    return;
  }

  // 5. bigint
  if (typeof value === "bigint") {
    hasher.update(new Uint8Array([TAG_BIGINT]));
    const bytes = bigintToMinimalTwosComplement(value);
    feedUint32(hasher, bytes.length);
    hasher.update(bytes);
    return;
  }

  // 6. undefined
  if (value === undefined) {
    hasher.update(new Uint8Array([TAG_UNDEF]));
    return;
  }

  // From here on, value is an object.
  if (typeof value !== "object") {
    throw new Error(
      `canonicalHash: unsupported type: ${typeof value}`,
    );
  }

  // 7. StorableUint8Array (before generic StorableInstance check)
  if (value instanceof StorableUint8Array) {
    hasher.update(new Uint8Array([TAG_BYTES]));
    const bytes = value.bytes;
    feedUint32(hasher, bytes.length);
    hasher.update(bytes);
    return;
  }

  // 8. StorableDate (before generic StorableInstance check)
  if (value instanceof StorableDate) {
    hasher.update(new Uint8Array([TAG_DATE]));
    feedInt64(hasher, BigInt(value.date.getTime()));
    return;
  }

  // 9. StorableInstance (generic protocol path via DECONSTRUCT)
  if (isStorableInstance(value)) {
    hasher.update(new Uint8Array([TAG_STOR]));
    const inst = value as StorableInstance & { typeTag: string };
    const typeTagUtf8 = encoder.encode(inst.typeTag);
    feedUint32(hasher, typeTagUtf8.length);
    hasher.update(typeTagUtf8);
    const state = value[DECONSTRUCT]();
    feedValue(hasher, state);
    return;
  }

  // 10. Array (with sparse hole handling)
  if (Array.isArray(value)) {
    hasher.update(new Uint8Array([TAG_ARRAY]));
    feedUint32(hasher, value.length);
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Start of a hole run -- coalesce consecutive holes.
        let runLen = 0;
        while (i < value.length && !(i in value)) {
          runLen++;
          i++;
        }
        hasher.update(new Uint8Array([TAG_HOLE]));
        feedUint32(hasher, runLen);
      } else {
        feedValue(hasher, value[i]);
        i++;
      }
    }
    return;
  }

  // 11. Plain object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  // Sort keys by UTF-8 byte comparison.
  keys.sort((a, b) => {
    const aBytes = encoder.encode(a);
    const bBytes = encoder.encode(b);
    const minLen = Math.min(aBytes.length, bBytes.length);
    for (let j = 0; j < minLen; j++) {
      if (aBytes[j] !== bBytes[j]) return aBytes[j] - bBytes[j];
    }
    return aBytes.length - bBytes.length;
  });

  hasher.update(new Uint8Array([TAG_OBJECT]));
  feedUint32(hasher, keys.length);
  for (const key of keys) {
    // Keys are encoded as TAG_STRING-style values (same format as strings).
    hasher.update(new Uint8Array([TAG_STRING]));
    const keyUtf8 = encoder.encode(key);
    feedUint32(hasher, keyUtf8.length);
    hasher.update(keyUtf8);
    // Value is hashed recursively.
    feedValue(hasher, obj[key]);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the canonical SHA-256 hash of a `StorableValue`. Returns the
 * raw 32-byte digest. The caller (`refer()`) wraps it via
 * `Reference.fromDigest()`.
 */
export function canonicalHash(value: unknown): Uint8Array {
  const hasher = createHasher();
  feedValue(hasher, value);
  return hasher.digest();
}
