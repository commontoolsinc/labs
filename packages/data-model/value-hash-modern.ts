/**
 * Hash of an arbitrary value, producing a deterministic digest based on the
 * value's logical structure.
 *
 * Traverses the value tree directly and feeds type-tagged data into a single
 * SHA-256 context. See Section 6 of the formal spec and the byte-level spec for
 * the full algorithm.
 */
import {
  createHasher,
  type IncrementalHasher,
  sha256,
} from "@commonfabric/content-hash";
import { isDeepFrozen } from "./deep-freeze.ts";
import { FabricHash } from "./fabric-hash.ts";
import { FabricBytes } from "./fabric-bytes.ts";
import { DECONSTRUCT, type FabricInstance } from "./interface.ts";
import { shallowFabricFromNativeValueModern } from "./fabric-value-modern.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { encodeULEB128 } from "@commonfabric/leb128";
import { bigintToMinimalTwosComplement } from "./bigint-encoding.ts";
import { LRUCache } from "@commonfabric/utils/cache";

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
const TAG_CONTENT_HASH = 0x29;

// Special for hashing:
const TAG_STRING_HASH = 0xf0;

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
const TAG_BYTES_BYTES = new Uint8Array([TAG_BYTES]);
const TAG_BIGINT_BYTES = new Uint8Array([TAG_BIGINT]);
const TAG_EPOCH_NSEC_BYTES = new Uint8Array([TAG_EPOCH_NSEC]);
const TAG_EPOCH_DAYS_BYTES = new Uint8Array([TAG_EPOCH_DAYS]);
const TAG_CONTENT_HASH_BYTES = new Uint8Array([TAG_CONTENT_HASH]);

// ---------------------------------------------------------------------------
// Core: recursive value feeding
// ---------------------------------------------------------------------------

/**
 * Maximum encoded length of a string which is represented in just-encoded form.
 * Longer strings are represented in a hash feed as the hash of the string (in
 * Merkle-ish fashion).
 */
const MAX_DIRECT_STRING_LENGTH = 64;

/**
 * Maximum value (inclusive) of the small-length-number cache.
 */
const MAX_CACHED_SMALL_LENGTH = 500;

/** Shared TextEncoder for UTF-8 string encoding. */
const encoder = new TextEncoder();

/** Reusable 8-byte buffer for float64 encoding. */
const f64Buf = new ArrayBuffer(8);

/** Float64 "view" of `f64Buf`. */
const f64View = new DataView(f64Buf);

/** Byte-array "view" of `f64Buf`. */
const f64Bytes = new Uint8Array(f64Buf);

/** LRU cache for string representations. */
const stringRepCache = new LRUCache<string, Uint8Array>({
  capacity: 50_000,
});

/** Prepopulated cache of encoded small-length numbers. */
const smallLengthCache: Uint8Array[] = Array.from(
  { length: MAX_CACHED_SMALL_LENGTH + 1 },
  (_, i) => encodeULEB128(i),
);

/**
 * Gets the bytes needed to represent the given string, either by computing it
 * or retrieving a previously-computed result from the cache.
 */
function getStringRep(value: string) {
  const cached = stringRepCache.get(value);
  if (cached !== undefined) return cached;

  const utf8Buf = encoder.encode(value);
  const utf8Length = utf8Buf.length;

  let result;

  if (utf8Length <= MAX_DIRECT_STRING_LENGTH) {
    // Contents are: tag + utf8Length + utf8.
    const totalLength = 2 + utf8Length;
    result = new Uint8Array(totalLength);
    result[0] = TAG_STRING;
    result[1] = utf8Length; // Always fits in a byte!
    result.set(utf8Buf, 2); // After the tag and length.
  } else {
    const hashBuf = sha256(utf8Buf);

    // Contents are: tag + hash.
    const totalLength = 1 + hashBuf.length;
    result = new Uint8Array(totalLength);
    result[0] = TAG_STRING_HASH;
    result.set(hashBuf, 1); // After the tag.
  }

  stringRepCache.put(value, result);
  return result;
}

/**
 * Helper for `compareStrings()`: Is the given character code a surrogate?
 */
function isSurrogateCharCode(c: number) {
  return (c >= 0xd800) && (c <= 0xdfff);
}

/**
 * Helper for `compareStrings()`: Does the given string contain any surrogate
 * code points?
 */
function hasSurrogateCharCode(value: string) {
  return /[\ud800-\udfff]/.test(value);
}

/**
 * Compares strings by UTF-8 sort order.
 *
 * Note: Even though we could conceivably define the sort to be something
 * easier to calculate in JS, (a) ultimately we want this implementation to be
 * but one of several that aren't all written in JS, (b) those other languages
 * don't necessarily have the same encoding bias as JS, and (c) we want to make
 * the specification for hashing straightforward anyway (and are willing to pay
 * a performance cost because of it).
 */
function compareStrings(a: string, b: string): number {
  // Credit where due: Though this started out as an independent implementation
  // of the key insight for fast sorting, this incorporates ideas from
  // <https://github.com/rocicorp/compare-utf8>.

  // Here's what's going on: JS native string sort and UTF-8 sort can differ
  // only when at least one of the JS-form strings contains a codepoint for a
  // surrogate-pair. As long as we don't run into one of those, we can just
  // do a regular difference-based comparison. But if we _do_ run into one, then
  // we have to do something extra, one way or another.

  if (a === b) {
    // Easy out!
    return 0;
  }

  const minCharLen = Math.min(a.length, b.length);

  if (
    (minCharLen >= 20) && !(hasSurrogateCharCode(a) || hasSurrogateCharCode(b))
  ) {
    // Strings are long enough that it's worth a preflight check for surrogate
    // pairs, and it turns out that neither had them.
    return (a < b) ? -1 : ((a > b) ? 1 : 0);
  }

  // No luck for us today. Gotta do it the hard way.

  for (let i = 0; i < minCharLen; i++) {
    const aChar = a.charCodeAt(i);
    const bChar = b.charCodeAt(i);
    if (aChar === bChar) {
      continue;
    } else if (!(isSurrogateCharCode(aChar) || isSurrogateCharCode(bChar))) {
      return aChar - bChar;
    } else {
      // At least one is a surrogate. Use `codePointAt()` to decode whichever of
      // the strings have surrogate characters. That method operates reasonably
      // whether or not the code point is in the basic or astral plane, and it
      // also returns a reasonable value given an invalid surrogate-pair
      // sequence. Importantly, Unicode code-point order corresponds to UTF-8
      // byte order.
      const aPoint = a.codePointAt(i)!;
      const bPoint = b.codePointAt(i)!;
      return aPoint - bPoint;
    }
  }

  return a.length - b.length;
}

/**
 * Updates an incremental hasher with a length value, using the standard
 * in-hash encoding for same.
 */
function feedLength(hasher: IncrementalHasher, value: number): void {
  const valueBuf = (value <= MAX_CACHED_SMALL_LENGTH)
    ? smallLengthCache[value]
    : encodeULEB128(value);

  hasher.update(valueBuf);
}

/**
 * Feeds a single `FabricValue` into the hasher, using the type-tagged
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
          `hashOfModern: non-finite number not allowed: ${value}`,
        );
      }
      hasher.update(TAG_NUMBER_BYTES);
      // Normalize -0 to +0.
      f64View.setFloat64(0, value === 0 ? 0 : value, false); // big-endian
      hasher.update(f64Bytes);
      break;

    case "string": {
      hasher.update(getStringRep(value));
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
      if (value === null) {
        hasher.update(TAG_NULL_BYTES);
      } else {
        feedObjectValue(hasher, value);
      }
      break;

    default:
      throw new Error(
        `hashOfModern: unsupported type: ${typeof value}`,
      );
  }
}

/**
 * Feed an object-typed value (special primitives, FabricInstance, Array,
 * or plain object) into the hasher. Dispatches via `tagFromNativeValue()` /
 * `NATIVE_TAGS` for recognized types. The `null` case is handled by the
 * caller (`feedValue()`).
 */
function feedObjectValue(
  hasher: IncrementalHasher,
  value: object,
): void {
  const nativeTag = tagFromNativeValue(value);

  switch (nativeTag) {
    case NATIVE_TAGS.EpochNsec: {
      hasher.update(TAG_EPOCH_NSEC_BYTES);
      const bytes = bigintToMinimalTwosComplement(
        (value as { value: bigint }).value,
      );
      feedLength(hasher, bytes.length);
      hasher.update(bytes);
      return;
    }

    case NATIVE_TAGS.EpochDays: {
      hasher.update(TAG_EPOCH_DAYS_BYTES);
      const bytes = bigintToMinimalTwosComplement(
        (value as { value: bigint }).value,
      );
      feedLength(hasher, bytes.length);
      hasher.update(bytes);
      return;
    }

    case NATIVE_TAGS.ContentHash: {
      const cid = value as FabricHash;
      hasher.update(TAG_CONTENT_HASH_BYTES);
      hasher.update(getStringRep(cid.tag));
      // TODO(@danfuzz): Look into avoiding making a copy of bytes here.
      // This could be a performance issue.
      const cidBytes = cid.bytes;
      feedLength(hasher, cidBytes.length);
      hasher.update(cidBytes);
      return;
    }

    case NATIVE_TAGS.Array:
      feedArray(hasher, value as unknown[]);
      return;

    case NATIVE_TAGS.Object:
      feedPlainObject(hasher, value as Record<string, unknown>);
      return;

    case NATIVE_TAGS.FabricBytes: {
      hasher.update(TAG_BYTES_BYTES);
      const fab = value as FabricBytes;
      feedLength(hasher, fab.length);
      hasher.update(fab.slice());
      return;
    }

    case NATIVE_TAGS.FabricInstance: {
      // Generic FabricInstance (protocol path via DECONSTRUCT).
      hasher.update(TAG_INSTANCE_BYTES);
      const typeTag = (value as { typeTag?: unknown }).typeTag;
      if (typeof typeTag !== "string") {
        throw new Error(
          `hashOfModern: FabricInstance missing typeTag property`,
        );
      }
      hasher.update(getStringRep(typeTag));
      const state = (value as FabricInstance)[DECONSTRUCT]();
      feedValue(hasher, state);
      return;
    }

    case NATIVE_TAGS.Date:
    case NATIVE_TAGS.RegExp:
    case NATIVE_TAGS.Uint8Array: {
      // Native instances that have a well-defined FabricValue conversion.
      // Convert on-the-fly and hash the converted value.
      const converted = shallowFabricFromNativeValueModern(value, false);
      feedValue(hasher, converted);
      return;
    }

    default: {
      // Nothing else is handled. As of this writing, specifically missing are
      // `Map`, `Set`, `Error`, and `HasToJSON`.
      throw new Error(
        `hashOfModern: unsupported object type: ${
          value?.constructor?.name ?? typeof value
        }`,
      );
    }
  }
}

/**
 * Feed an array value with sparse hole handling, terminated by TAG_END.
 */
function feedArray(hasher: IncrementalHasher, value: unknown[]): void {
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
}

/**
 * Feed a plain object value, keys sorted by UTF-8 byte order, terminated
 * by TAG_END.
 */
function feedPlainObject(
  hasher: IncrementalHasher,
  value: Record<string, unknown>,
): void {
  const keys = Object.keys(value).sort(compareStrings);

  hasher.update(TAG_OBJECT_BYTES);
  for (const key of keys) {
    // Keys are encoded in the same format as strings, and values are hashed
    // recursively.
    hasher.update(getStringRep(key));
    feedValue(hasher, value[key]);
  }
  hasher.update(TAG_END_BYTES);
}

// ---------------------------------------------------------------------------
// Uncached hash computation
// ---------------------------------------------------------------------------

/**
 * Computes the hash of a value without consulting or populating any cache.
 */
function computeHash(value: unknown): FabricHash {
  const hasher = createHasher();
  feedValue(hasher, value);
  return new FabricHash(hasher.digest(), "fid1");
}

/**
 * Like `computeHash()`, except it returns a simple string hash value, encoded
 * as `base64url`, rather than a hash object.
 */
function computeHashAsString(value: unknown): string {
  const hasher = createHasher();
  feedValue(hasher, value);
  return hasher.digest("base64url");
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Pre-computed constant hashes (these values never change). */
const NULL_HASH = computeHash(null);
const UNDEFINED_HASH = computeHash(undefined);
const TRUE_HASH = computeHash(true);
const FALSE_HASH = computeHash(false);

/**
 * LRU cache for primitive value hashes. Primitives (strings, numbers,
 * bigints) can't be WeakMap keys, so they use a bounded cache. Sizing is based
 * on historical testing (expected ~97% hit rate in practice).
 */
const primitiveHashCache = new LRUCache<
  string | number | bigint,
  FabricHash
>({
  capacity: 50_000,
});

/**
 * WeakMap cache for deep-frozen object hashes. Deep-frozen objects are
 * immutable, so their hash is stable and safe to cache by identity.
 * Mutable objects are always recomputed.
 */
const frozenObjectHashCache = new WeakMap<object, FabricHash>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Common helper for the two exported hash functions, which _might_ return a
 * plain `string` when passed `stringOkay = true`.
 */
function hashOfModernInternal(value: unknown, stringOkay: false): FabricHash;
function hashOfModernInternal(
  value: unknown,
  stringOkay: true,
): FabricHash | string;
function hashOfModernInternal(
  value: unknown,
  stringOkay: boolean,
): FabricHash | string {
  switch (typeof value) {
    case "boolean":
      return value ? TRUE_HASH : FALSE_HASH;

    case "string":
    case "number":
    case "bigint": {
      const cached = primitiveHashCache.get(value);
      if (cached !== undefined) return cached;
      const result = computeHash(value);
      primitiveHashCache.put(value, result);
      return result;
    }

    case "undefined":
      return UNDEFINED_HASH;

    case "object": {
      if (value === null) return NULL_HASH;
      if (isDeepFrozen(value)) {
        const obj = value as object;
        const cached = frozenObjectHashCache.get(obj);
        if (cached !== undefined) return cached;
        const result = computeHash(value);
        frozenObjectHashCache.set(obj, result);
        return result;
      }
      return stringOkay ? computeHashAsString(value) : computeHash(value);
    }

    default: {
      throw new Error(`Cannot hash value of type ${typeof value}`);
    }
  }
}

/**
 * Compute the SHA-256 hash of a `FabricValue`. Returns a `FabricHash` with
 * algorithm tag `fid1` (fabric ID, v1).
 * The caller (`hashOf()`) extracts the raw digest via `.bytes` for
 * `Reference.fromDigest()`.
 *
 * Caches results for primitives (LRU) and deep-frozen objects (WeakMap).
 */
export function hashOfModern(value: unknown): FabricHash {
  return hashOfModernInternal(value, false);
}

/**
 * Like `hashOfModern()`, except always returns a plain string of the hash,
 * encoded as base64url.
 */
export function hashOfModernAsString(value: unknown): string {
  const result = hashOfModernInternal(value, true);
  return (typeof result === "string") ? result : result.hashString;
}
