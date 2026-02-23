import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { canonicalHash } from "../canonical-hash.ts";
import {
  StorableDate,
  StorableError,
  StorableUint8Array,
} from "../storable-native-instances.ts";

// Dynamic import to satisfy the no-external-import lint rule.
const nodeCrypto = await import("node:crypto");

/**
 * Compute the SHA-256 hash of a raw byte sequence (for verifying against
 * byte-level spec examples).
 */
function sha256(bytes: number[]): Uint8Array {
  return nodeCrypto.createHash("sha256").update(new Uint8Array(bytes)).digest();
}

function hex(hash: Uint8Array): string {
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =========================================================================
// Primitive types
// =========================================================================

Deno.test("canonicalHash", async (t) => {
  // --- null ---

  await t.step("null produces TAG_NULL byte stream", () => {
    // Byte stream: [0x20]
    const expected = sha256([0x20]);
    assertEquals(canonicalHash(null), expected);
  });

  // --- boolean ---

  await t.step("true produces TAG_BOOLEAN + 0x01", () => {
    // [0x21, 0x01]
    const expected = sha256([0x21, 0x01]);
    assertEquals(canonicalHash(true), expected);
  });

  await t.step("false produces TAG_BOOLEAN + 0x00", () => {
    // [0x21, 0x00]
    const expected = sha256([0x21, 0x00]);
    assertEquals(canonicalHash(false), expected);
  });

  await t.step("true and false produce different hashes", () => {
    assertNotEquals(hex(canonicalHash(true)), hex(canonicalHash(false)));
  });

  // --- number ---

  await t.step("42 produces TAG_NUMBER + IEEE 754 float64 BE", () => {
    const expected = sha256([
      0x22,
      0x40,
      0x45,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    assertEquals(canonicalHash(42), expected);
  });

  await t.step("0 produces TAG_NUMBER + all zeros", () => {
    const expected = sha256([
      0x22,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    assertEquals(canonicalHash(0), expected);
  });

  await t.step("-0 normalizes to +0 (same hash)", () => {
    assertEquals(canonicalHash(-0), canonicalHash(0));
  });

  await t.step("NaN throws", () => {
    assertThrows(
      () => canonicalHash(NaN),
      Error,
      "non-finite",
    );
  });

  await t.step("Infinity throws", () => {
    assertThrows(
      () => canonicalHash(Infinity),
      Error,
      "non-finite",
    );
  });

  await t.step("-Infinity throws", () => {
    assertThrows(
      () => canonicalHash(-Infinity),
      Error,
      "non-finite",
    );
  });

  await t.step("different numbers produce different hashes", () => {
    assertNotEquals(hex(canonicalHash(1)), hex(canonicalHash(2)));
    assertNotEquals(hex(canonicalHash(0)), hex(canonicalHash(1)));
    assertNotEquals(hex(canonicalHash(-1)), hex(canonicalHash(1)));
  });

  await t.step(
    "Number.MAX_VALUE produces TAG_NUMBER + all-nonzero IEEE 754 bytes",
    () => {
      // IEEE 754 float64 big-endian for Number.MAX_VALUE:
      // 7F EF FF FF FF FF FF FF  (all bytes non-zero)
      const expected = sha256([
        0x22,
        0x7f,
        0xef,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ]);
      assertEquals(hex(canonicalHash(Number.MAX_VALUE)), hex(expected));
    },
  );

  // --- string ---

  await t.step(
    "hello produces TAG_STRING + LEB128 byte length + UTF-8",
    () => {
      // UTF-8 for "hello": [0x68, 0x65, 0x6c, 0x6c, 0x6f], 5 bytes
      // LEB128(5) = [0x05]
      const expected = sha256([
        0x23,
        0x05,
        0x68,
        0x65,
        0x6c,
        0x6c,
        0x6f,
      ]);
      assertEquals(canonicalHash("hello"), expected);
    },
  );

  await t.step("empty string produces TAG_STRING + zero length", () => {
    // LEB128(0) = [0x00]
    const expected = sha256([0x23, 0x00]);
    assertEquals(canonicalHash(""), expected);
  });

  await t.step("different strings produce different hashes", () => {
    assertNotEquals(hex(canonicalHash("a")), hex(canonicalHash("b")));
    assertNotEquals(hex(canonicalHash("")), hex(canonicalHash("a")));
  });

  await t.step("multi-byte UTF-8 characters encode correctly", () => {
    // Verify consistency (same value -> same hash)
    assertEquals(canonicalHash("\u00e9"), canonicalHash("\u00e9"));
    // e-acute is 2 bytes in UTF-8
    assertNotEquals(hex(canonicalHash("e")), hex(canonicalHash("\u00e9")));
  });

  await t.step("surrogate pairs (emoji) encode correctly", () => {
    // U+1F600 (grinning face) is 4 bytes in UTF-8
    const emoji = "\u{1F600}";
    const enc = new TextEncoder();
    const utf8 = enc.encode(emoji);
    assertEquals(utf8.length, 4); // 4 bytes in UTF-8
    // LEB128(4) = [0x04]
    const expected = sha256([
      0x23,
      0x04,
      ...utf8,
    ]);
    assertEquals(canonicalHash(emoji), expected);
  });

  // --- bigint ---

  await t.step("0n encodes as TAG_BIGINT + LEB128 length 1 + [0x00]", () => {
    // LEB128(1) = [0x01]
    const expected = sha256([0x24, 0x01, 0x00]);
    assertEquals(canonicalHash(0n), expected);
  });

  await t.step("127n encodes as 1 byte: 0x7F", () => {
    const expected = sha256([0x24, 0x01, 0x7f]);
    assertEquals(canonicalHash(127n), expected);
  });

  await t.step("128n encodes as 2 bytes: 0x00, 0x80", () => {
    // 128 = 0x80, but high bit set means negative in two's complement,
    // so we need a leading 0x00. LEB128(2) = [0x02].
    const expected = sha256([0x24, 0x02, 0x00, 0x80]);
    assertEquals(canonicalHash(128n), expected);
  });

  await t.step("-1n encodes as 1 byte: 0xFF", () => {
    const expected = sha256([0x24, 0x01, 0xff]);
    assertEquals(canonicalHash(-1n), expected);
  });

  await t.step("-128n encodes as 1 byte: 0x80", () => {
    const expected = sha256([0x24, 0x01, 0x80]);
    assertEquals(canonicalHash(-128n), expected);
  });

  await t.step("-129n encodes as 2 bytes: 0xFF, 0x7F", () => {
    const expected = sha256([0x24, 0x02, 0xff, 0x7f]);
    assertEquals(canonicalHash(-129n), expected);
  });

  await t.step("large bigint encodes correctly", () => {
    // 2^64 = 18446744073709551616n
    // hex: 10000000000000000 -> 9 bytes: 01 00 00 00 00 00 00 00 00
    const big = 2n ** 64n;
    const hash = canonicalHash(big);
    assertEquals(hash.length, 32); // SHA-256 produces 32 bytes

    // Verify it's consistent
    assertEquals(canonicalHash(big), hash);
  });

  // --- undefined ---

  await t.step("undefined produces TAG_UNDEFINED", () => {
    // [0x25]
    const expected = sha256([0x25]);
    assertEquals(canonicalHash(undefined), expected);
  });

  // --- cross-type distinctness ---

  await t.step("null vs undefined vs false produce different hashes", () => {
    const nullH = hex(canonicalHash(null));
    const undefH = hex(canonicalHash(undefined));
    const falseH = hex(canonicalHash(false));
    assertNotEquals(nullH, undefH);
    assertNotEquals(nullH, falseH);
    assertNotEquals(undefH, falseH);
  });

  await t.step("number 0 vs bigint 0n vs string '0' are distinct", () => {
    const numH = hex(canonicalHash(0));
    const bigH = hex(canonicalHash(0n));
    const strH = hex(canonicalHash("0"));
    assertNotEquals(numH, bigH);
    assertNotEquals(numH, strH);
    assertNotEquals(bigH, strH);
  });

  // =========================================================================
  // StorableUint8Array
  // =========================================================================

  await t.step(
    "StorableUint8Array produces TAG_BYTES + LEB128 length + raw bytes",
    () => {
      const bytes = new StorableUint8Array(new Uint8Array([1, 2, 3]));
      // LEB128(3) = [0x03]
      const expected = sha256([
        0x26,
        0x03,
        0x01,
        0x02,
        0x03,
      ]);
      assertEquals(canonicalHash(bytes), expected);
    },
  );

  await t.step(
    "empty StorableUint8Array produces TAG_BYTES + zero length",
    () => {
      const bytes = new StorableUint8Array(new Uint8Array([]));
      const expected = sha256([0x26, 0x00]);
      assertEquals(canonicalHash(bytes), expected);
    },
  );

  // =========================================================================
  // StorableDate (hashed via TAG_INSTANCE + DECONSTRUCT)
  // =========================================================================

  await t.step(
    "StorableDate(epoch) matches hand-computed byte stream",
    () => {
      // StorableDate(new Date(0)) deconstructs to 0 (milliseconds-since-epoch).
      // TAG_INSTANCE (0x12)
      // + LEB128(6) for typeTag "Date@1" (6 UTF-8 bytes)
      // + "Date@1" in UTF-8: [0x44, 0x61, 0x74, 0x65, 0x40, 0x31]
      // + recursive feedValue(0): TAG_NUMBER (0x22) + IEEE754 BE for 0.0
      const expected = sha256([
        // TAG_INSTANCE
        0x12,
        // LEB128(6) = typeTag byte length
        0x06,
        // "Date@1" UTF-8
        0x44,
        0x61,
        0x74,
        0x65,
        0x40,
        0x31,
        // Deconstructed state: number 0
        0x22,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);
      assertEquals(canonicalHash(new StorableDate(new Date(0))), expected);
    },
  );

  await t.step("StorableDate with different timestamps differ", () => {
    const d1 = new StorableDate(new Date(0));
    const d2 = new StorableDate(new Date(1704067200000));
    assertNotEquals(hex(canonicalHash(d1)), hex(canonicalHash(d2)));
  });

  await t.step("StorableDate with negative timestamp", () => {
    // Before epoch
    const date = new StorableDate(new Date(-1000));
    const hash = canonicalHash(date);
    assertEquals(hash.length, 32);
  });

  // =========================================================================
  // StorableError (StorableInstance via DECONSTRUCT)
  // =========================================================================

  await t.step(
    "StorableError matches byte stream built from DECONSTRUCT output",
    () => {
      // Build the expected byte stream programmatically because the
      // deconstructed state includes `stack` which is environment-dependent.
      // We construct the stream the same way canonicalHash does, then SHA-256 it.
      const error = new StorableError(new Error("test"));
      const enc = new TextEncoder();

      // TAG_INSTANCE (0x12) + LEB128(typeTagLen) + typeTag UTF-8
      const typeTagUtf8 = enc.encode("Error@1"); // 7 bytes
      const stream: number[] = [0x12, typeTagUtf8.length, ...typeTagUtf8];

      // Deconstructed state is an object with sorted keys.
      // StorableError.DECONSTRUCT() returns:
      //   { type: "Error", name: null, message: "test", stack: <string> }
      // Keys sorted by UTF-8: message, name, stack, type
      stream.push(0x11); // TAG_OBJECT

      // Key "message" + value "test"
      const messageKey = enc.encode("message");
      stream.push(0x23, messageKey.length, ...messageKey);
      const messageVal = enc.encode("test");
      stream.push(0x23, messageVal.length, ...messageVal);

      // Key "name" + value null (name === type for Error, so null)
      const nameKey = enc.encode("name");
      stream.push(0x23, nameKey.length, ...nameKey);
      stream.push(0x20); // TAG_NULL

      // Key "stack" + value (the actual stack string)
      const stackKey = enc.encode("stack");
      stream.push(0x23, stackKey.length, ...stackKey);
      const stackUtf8 = enc.encode(error.error.stack!);
      // LEB128 encode the stack length
      let stackLen = stackUtf8.length;
      const stackLenBytes: number[] = [];
      if (stackLen === 0) {
        stackLenBytes.push(0);
      } else {
        while (stackLen > 0) {
          let byte = stackLen & 0x7f;
          stackLen >>>= 7;
          if (stackLen > 0) byte |= 0x80;
          stackLenBytes.push(byte);
        }
      }
      stream.push(0x23, ...stackLenBytes, ...stackUtf8);

      // Key "type" + value "Error"
      const typeKey = enc.encode("type");
      stream.push(0x23, typeKey.length, ...typeKey);
      const typeVal = enc.encode("Error");
      stream.push(0x23, typeVal.length, ...typeVal);

      // TAG_END for the object
      stream.push(0x00);

      const expected = sha256(stream);
      assertEquals(canonicalHash(error), expected);
    },
  );

  await t.step("different errors produce different hashes", () => {
    const e1 = new StorableError(new Error("hello"));
    const e2 = new StorableError(new Error("world"));
    assertNotEquals(hex(canonicalHash(e1)), hex(canonicalHash(e2)));
  });

  await t.step("TypeError vs Error produce different hashes", () => {
    const e1 = new StorableError(new Error("msg"));
    const e2 = new StorableError(new TypeError("msg"));
    assertNotEquals(hex(canonicalHash(e1)), hex(canonicalHash(e2)));
  });

  // =========================================================================
  // Arrays
  // =========================================================================

  await t.step("empty array produces TAG_ARRAY + TAG_END", () => {
    const expected = sha256([0x10, 0x00]);
    assertEquals(canonicalHash([]), expected);
  });

  await t.step("sparse array [1, , 3] uses hole run-length encoding", () => {
    // TAG_ARRAY
    // + number 1 (TAG_NUMBER + IEEE754)
    // + TAG_HOLE + LEB128(1)
    // + number 3 (TAG_NUMBER + IEEE754)
    // + TAG_END
    const expected = sha256([
      // TAG_ARRAY
      0x10,
      // Element 0: number 1
      0x22,
      0x3f,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // Element 1: hole run of 1
      0x01,
      0x01,
      // Element 2: number 3
      0x22,
      0x40,
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // TAG_END
      0x00,
    ]);
    // deno-lint-ignore no-sparse-arrays
    assertEquals(canonicalHash([1, , 3]), expected);
  });

  await t.step("multiple consecutive holes are coalesced into one run", () => {
    // [1, , , , 5] -> hole run of 3
    const arr = new Array(5);
    arr[0] = 1;
    arr[4] = 5;
    const hash = canonicalHash(arr);

    // Verify by building the expected byte stream manually
    const expected = sha256([
      // TAG_ARRAY
      0x10,
      // Element 0: number 1
      0x22,
      0x3f,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // Elements 1-3: hole run of 3
      0x01,
      0x03,
      // Element 4: number 5
      0x22,
      0x40,
      0x14,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // TAG_END
      0x00,
    ]);
    assertEquals(hash, expected);
  });

  await t.step(
    "[1, undefined, 3] vs [1, , 3] vs [1, null, 3] are all distinct",
    () => {
      // deno-lint-ignore no-sparse-arrays
      const sparseH = hex(canonicalHash([1, , 3]));
      const undefH = hex(canonicalHash([1, undefined, 3]));
      const nullH = hex(canonicalHash([1, null, 3]));

      assertNotEquals(sparseH, undefH);
      assertNotEquals(sparseH, nullH);
      assertNotEquals(undefH, nullH);
    },
  );

  await t.step("nested arrays are recursively hashed", () => {
    const hash = canonicalHash([[1, 2], [3]]);
    assertEquals(hash.length, 32);
    // Different from flat array
    assertNotEquals(hex(hash), hex(canonicalHash([1, 2, 3])));
  });

  // =========================================================================
  // Objects
  // =========================================================================

  await t.step("empty object produces TAG_OBJECT + TAG_END", () => {
    const expected = sha256([0x11, 0x00]);
    assertEquals(canonicalHash({}), expected);
  });

  await t.step("object key order is deterministic (sorted by UTF-8)", () => {
    // Keys inserted in different orders produce the same hash.
    const h1 = canonicalHash({ a: 1, b: 2 });
    const h2 = canonicalHash({ b: 2, a: 1 });
    assertEquals(h1, h2);
  });

  await t.step("{a: 1, b: 2} matches hand-computed byte stream", () => {
    // Keys sorted: "a" (0x61) < "b" (0x62)
    // LEB128 lengths are single bytes for small values.
    const expected = sha256([
      // TAG_OBJECT
      0x11,
      // Key "a": TAG_STRING + LEB128(1) + UTF-8
      0x23,
      0x01,
      0x61,
      // Value 1: TAG_NUMBER + IEEE754 for 1.0
      0x22,
      0x3f,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // Key "b": TAG_STRING + LEB128(1) + UTF-8
      0x23,
      0x01,
      0x62,
      // Value 2: TAG_NUMBER + IEEE754 for 2.0
      0x22,
      0x40,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // TAG_END
      0x00,
    ]);
    assertEquals(canonicalHash({ a: 1, b: 2 }), expected);
  });

  await t.step("nested objects are recursively hashed", () => {
    const hash = canonicalHash({ x: { y: 1 } });
    assertEquals(hash.length, 32);
    assertNotEquals(hex(hash), hex(canonicalHash({ x: 1 })));
  });

  await t.step("object with mixed value types", () => {
    const hash = canonicalHash({
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
    });
    assertEquals(hash.length, 32);
    // Consistency
    assertEquals(
      hash,
      canonicalHash({ str: "hello", num: 42, bool: true, nil: null }),
    );
  });

  // =========================================================================
  // Consistency and distinctness
  // =========================================================================

  await t.step("same value always produces the same hash", () => {
    assertEquals(canonicalHash(42), canonicalHash(42));
    assertEquals(canonicalHash("hello"), canonicalHash("hello"));
    assertEquals(canonicalHash([1, 2, 3]), canonicalHash([1, 2, 3]));
    assertEquals(
      canonicalHash({ a: 1 }),
      canonicalHash({ a: 1 }),
    );
  });

  await t.step("all hashes are 32 bytes (SHA-256)", () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      42,
      "",
      "hello",
      0n,
      127n,
      undefined,
      [],
      [1, 2],
      {},
      { a: 1 },
      new StorableDate(new Date(0)),
      new StorableUint8Array(new Uint8Array([1])),
      new StorableError(new Error("x")),
    ];
    for (const v of values) {
      assertEquals(canonicalHash(v).length, 32);
    }
  });

  await t.step(
    "different values of different types produce different hashes",
    () => {
      const hashes = new Set([
        hex(canonicalHash(null)),
        hex(canonicalHash(true)),
        hex(canonicalHash(false)),
        hex(canonicalHash(0)),
        hex(canonicalHash("")),
        hex(canonicalHash(0n)),
        hex(canonicalHash(undefined)),
        hex(canonicalHash([])),
        hex(canonicalHash({})),
      ]);
      // All 9 should be distinct.
      assertEquals(hashes.size, 9);
    },
  );

  // =========================================================================
  // Edge cases
  // =========================================================================

  await t.step("deeply nested structure", () => {
    const deep = { a: { b: { c: { d: [1, { e: true }] } } } };
    const hash = canonicalHash(deep);
    assertEquals(hash.length, 32);
    assertEquals(canonicalHash(deep), hash);
  });

  await t.step("array with all holes", () => {
    const arr = new Array(5); // all holes
    const hash = canonicalHash(arr);
    assertEquals(hash.length, 32);

    // TAG_ARRAY + TAG_HOLE + LEB128(5) + TAG_END
    const expected = sha256([
      0x10,
      0x01,
      0x05,
      0x00,
    ]);
    assertEquals(hash, expected);
  });

  await t.step("object with non-ASCII keys sorts by UTF-8 bytes", () => {
    // Keys with non-ASCII should sort by UTF-8 byte values.
    const h1 = canonicalHash({ "\u00e9": 1, "a": 2 });
    const h2 = canonicalHash({ "a": 2, "\u00e9": 1 });
    assertEquals(h1, h2);
  });

  await t.step(
    "object key sort is UTF-8, not UTF-16 (supplementary vs BMP)",
    () => {
      // U+F000 (private use area, BMP): UTF-8 = [EF 80 80] (3 bytes)
      // U+10000 (supplementary plane):  UTF-8 = [F0 90 80 80] (4 bytes)
      //
      // UTF-16 order: U+10000 < U+F000 (surrogates 0xD800 < 0xF000)
      // UTF-8 order:  U+F000 < U+10000 (0xEF < 0xF0)
      //
      // If sorting were naive JS string comparison (UTF-16), U+10000 would
      // come first. Under correct UTF-8 byte sort, U+F000 comes first.
      const keyA = "\uF000"; // UTF-8: EF 80 80
      const keyB = "\u{10000}"; // UTF-8: F0 90 80 80

      // Verify the JS string order is opposite to UTF-8 order.
      assertEquals(keyB < keyA, true, "JS sorts U+10000 before U+F000");

      const obj = { [keyA]: 1, [keyB]: 2 };

      // Expected byte stream with UTF-8 sort order (keyA first):
      // TAG_OBJECT (0x11)
      // + keyA: TAG_STRING(0x23) + LEB128(3) + EF 80 80
      // + value 1: TAG_NUMBER(0x22) + IEEE754 for 1.0
      // + keyB: TAG_STRING(0x23) + LEB128(4) + F0 90 80 80
      // + value 2: TAG_NUMBER(0x22) + IEEE754 for 2.0
      // + TAG_END (0x00)
      const expected = sha256([
        // TAG_OBJECT
        0x11,
        // keyA: U+F000 (UTF-8 first)
        0x23,
        0x03,
        0xef,
        0x80,
        0x80,
        // value 1
        0x22,
        0x3f,
        0xf0,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // keyB: U+10000 (UTF-8 second)
        0x23,
        0x04,
        0xf0,
        0x90,
        0x80,
        0x80,
        // value 2
        0x22,
        0x40,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // TAG_END
        0x00,
      ]);
      assertEquals(canonicalHash(obj), expected);

      // Also verify the wrong (UTF-16) order produces a different hash.
      const wrongOrder = sha256([
        0x11,
        // keyB first (wrong -- UTF-16 order)
        0x23,
        0x04,
        0xf0,
        0x90,
        0x80,
        0x80,
        0x22,
        0x40,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // keyA second
        0x23,
        0x03,
        0xef,
        0x80,
        0x80,
        0x22,
        0x3f,
        0xf0,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // TAG_END
        0x00,
      ]);
      assertNotEquals(hex(canonicalHash(obj)), hex(wrongOrder));
    },
  );
});
