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
  StorableEpochDays,
  StorableEpochNsec,
  StorableUint8Array,
} from "./storable-native-instances.ts";
import { StorableContentId } from "./storable-content-id.ts";
import { DECONSTRUCT, isStorableInstance } from "./storable-protocol.ts";
import { encodeULEB128 } from "@commontools/leb128";
import { bigintToMinimalTwosComplement } from "./bigint-encoding.ts";

// ---------------------------------------------------------------------------
// Type tag bytes (Section 2 of the byte-level spec)
// ---------------------------------------------------------------------------

// Meta (0x0N)
const TAG_END = 0x00;
const TAG_HOLE = 0x01;

// Compound (0x1N)
const TAG_ARRAY = 0x10;
const TAG_OBJECT = 0x11;
const TAG_INSTANCE = 0x12;

// Primitive (0x2N) -- ordered by conceptual size
const TAG_NULL = 0x20;
const TAG_UNDEFINED = 0x21;
const TAG_BOOLEAN = 0x22;
const TAG_NUMBER = 0x23;
const TAG_STRING = 0x24;
const TAG_BYTES = 0x25;
const TAG_BIGINT = 0x26;
const TAG_EPOCH_NSEC = 0x27;
const TAG_EPOCH_DAYS = 0x28;
const TAG_CONTENT_ID = 0x29;

// ---------------------------------------------------------------------------
// Pre-allocated tag byte arrays (avoids per-call allocation)
// ---------------------------------------------------------------------------

const TAG_END_BYTES = new Uint8Array([TAG_END]);
const TAG_HOLE_BYTES = new Uint8Array([TAG_HOLE]);
const TAG_ARRAY_BYTES = new Uint8Array([TAG_ARRAY]);
const TAG_OBJECT_BYTES = new Uint8Array([TAG_OBJECT]);
const TAG_INSTANCE_BYTES = new Uint8Array([TAG_INSTANCE]);
const TAG_NULL_BYTES = new Uint8Array([TAG_NULL]);
const TAG_UNDEFINED_BYTES = new Uint8Array([TAG_UNDEFINED]);
const TAG_BOOLEAN_TRUE_BYTES = new Uint8Array([TAG_BOOLEAN, 0x01]);
const TAG_BOOLEAN_FALSE_BYTES = new Uint8Array([TAG_BOOLEAN, 0x00]);
const TAG_NUMBER_BYTES = new Uint8Array([TAG_NUMBER]);
const TAG_STRING_BYTES = new Uint8Array([TAG_STRING]);
const TAG_BYTES_BYTES = new Uint8Array([TAG_BYTES]);
const TAG_BIGINT_BYTES = new Uint8Array([TAG_BIGINT]);
const TAG_EPOCH_NSEC_BYTES = new Uint8Array([TAG_EPOCH_NSEC]);
const TAG_EPOCH_DAYS_BYTES = new Uint8Array([TAG_EPOCH_DAYS]);
const TAG_CONTENT_ID_BYTES = new Uint8Array([TAG_CONTENT_ID]);

// ---------------------------------------------------------------------------
// Shared scratch buffer (safe in single-threaded synchronous JS -- see
// async safety analysis in PR #2856 review round 2)
// ---------------------------------------------------------------------------

/** Reusable 8-byte buffer for float64 encoding. */
const f64Buf = new ArrayBuffer(8);
const f64View = new DataView(f64Buf);
const f64Bytes = new Uint8Array(f64Buf);

/** Shared TextEncoder for UTF-8 string encoding. */
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helper: feed an unsigned LEB128 length prefix
// ---------------------------------------------------------------------------

function feedLength(hasher: IncrementalHasher, value: number): void {
  hasher.update(encodeULEB128(value));
}

// ---------------------------------------------------------------------------
// Core: recursive value feeding
// ---------------------------------------------------------------------------

/**
 * Feed a single `StorableValue` into the hasher, using the type-tagged
 * byte format from the byte-level spec.
 */
function feedValue(hasher: IncrementalHasher, value: unknown): void {
  switch (typeof value) {
    case "boolean":
      hasher.update(value ? TAG_BOOLEAN_TRUE_BYTES : TAG_BOOLEAN_FALSE_BYTES);
      break;

    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonicalHash: non-finite number not allowed: ${value}`,
        );
      }
      hasher.update(TAG_NUMBER_BYTES);
      // Normalize -0 to +0.
      f64View.setFloat64(0, value === 0 ? 0 : value, false); // big-endian
      hasher.update(f64Bytes);
      break;

    case "string": {
      hasher.update(TAG_STRING_BYTES);
      const utf8 = encoder.encode(value);
      feedLength(hasher, utf8.length);
      hasher.update(utf8);
      break;
    }

    case "bigint": {
      hasher.update(TAG_BIGINT_BYTES);
      const bytes = bigintToMinimalTwosComplement(value);
      feedLength(hasher, bytes.length);
      hasher.update(bytes);
      break;
    }

    case "undefined":
      hasher.update(TAG_UNDEFINED_BYTES);
      break;

    case "object":
      feedObjectValue(hasher, value);
      break;

    default:
      throw new Error(
        `canonicalHash: unsupported type: ${typeof value}`,
      );
  }
}

/**
 * Feed an object-typed value (null, StorableUint8Array, StorableInstance,
 * Array, or plain object) into the hasher.
 */
function feedObjectValue(
  hasher: IncrementalHasher,
  value: object | null,
): void {
  // 1. null (typeof null === "object")
  if (value === null) {
    hasher.update(TAG_NULL_BYTES);
    return;
  }

  // 2. StorableUint8Array (before generic StorableInstance check)
  if (value instanceof StorableUint8Array) {
    hasher.update(TAG_BYTES_BYTES);
    const bytes = value.bytes;
    feedLength(hasher, bytes.length);
    hasher.update(bytes);
    return;
  }

  // 3a. StorableEpochNsec (dedicated primitive tag)
  if (value instanceof StorableEpochNsec) {
    hasher.update(TAG_EPOCH_NSEC_BYTES);
    const bytes = bigintToMinimalTwosComplement(value.value);
    feedLength(hasher, bytes.length);
    hasher.update(bytes);
    return;
  }

  // 3b. StorableEpochDays (dedicated primitive tag)
  if (value instanceof StorableEpochDays) {
    hasher.update(TAG_EPOCH_DAYS_BYTES);
    const bytes = bigintToMinimalTwosComplement(value.value);
    feedLength(hasher, bytes.length);
    hasher.update(bytes);
    return;
  }

  // 3c. StorableContentId (dedicated primitive tag)
  if (value instanceof StorableContentId) {
    hasher.update(TAG_CONTENT_ID_BYTES);
    const algTagUtf8 = encoder.encode(value.algorithmTag);
    feedLength(hasher, algTagUtf8.length);
    hasher.update(algTagUtf8);
    feedLength(hasher, value.hash.length);
    hasher.update(value.hash);
    return;
  }

  // 4. StorableInstance (generic protocol path via DECONSTRUCT).
  if (isStorableInstance(value)) {
    hasher.update(TAG_INSTANCE_BYTES);
    const typeTag = (value as { typeTag?: unknown }).typeTag;
    if (typeof typeTag !== "string") {
      throw new Error(
        `canonicalHash: StorableInstance missing typeTag property`,
      );
    }
    const typeTagUtf8 = encoder.encode(typeTag);
    feedLength(hasher, typeTagUtf8.length);
    hasher.update(typeTagUtf8);
    const state = value[DECONSTRUCT]();
    feedValue(hasher, state);
    return;
  }

  // 5. Array (with sparse hole handling, terminated by TAG_END)
  if (Array.isArray(value)) {
    hasher.update(TAG_ARRAY_BYTES);
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Start of a hole run -- coalesce consecutive holes.
        let runLen = 0;
        while (i < value.length && !(i in value)) {
          runLen++;
          i++;
        }
        hasher.update(TAG_HOLE_BYTES);
        feedLength(hasher, runLen);
      } else {
        feedValue(hasher, value[i]);
        i++;
      }
    }
    hasher.update(TAG_END_BYTES);
    return;
  }

  // 6. Plain object
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

  hasher.update(TAG_OBJECT_BYTES);
  for (const key of keys) {
    // Keys are encoded as TAG_STRING-style values (same format as strings).
    hasher.update(TAG_STRING_BYTES);
    const keyUtf8 = encoder.encode(key);
    feedLength(hasher, keyUtf8.length);
    hasher.update(keyUtf8);
    // Value is hashed recursively.
    feedValue(hasher, obj[key]);
  }
  hasher.update(TAG_END_BYTES);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the canonical SHA-256 hash of a `StorableValue`. Returns a
 * `StorableContentId` with algorithm tag `fid1` (fabric ID, v1).
 * The caller (`refer()`) extracts the raw digest via `.hash` for
 * `Reference.fromDigest()`.
 */
export function canonicalHash(value: unknown): StorableContentId {
  const hasher = createHasher();
  feedValue(hasher, value);
  return new StorableContentId(hasher.digest(), "fid1");
}
