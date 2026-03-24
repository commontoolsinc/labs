import {
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { hashOfModern as modernHashRaw } from "../value-hash-modern.ts";
import { FabricHash } from "../fabric-hash.ts";
import { FabricEpochDays, FabricEpochNsec } from "../fabric-epoch.ts";
import { FabricError, FabricUint8Array } from "../fabric-native-instances.ts";

// Dynamic import to satisfy the no-external-import lint rule.
const nodeCrypto = await import("node:crypto");

/**
 * Compute the SHA-256 hash of a raw byte sequence (for verifying against
 * byte-level spec examples).
 */
function sha256(bytes: number[]): Uint8Array {
  // node:crypto digest() returns Buffer; normalize to plain Uint8Array so
  // assertEquals comparisons against production code (which also normalizes)
  // work correctly.
  const buf = nodeCrypto.createHash("sha256").update(new Uint8Array(bytes))
    .digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function hex(hash: Uint8Array): string {
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extract the raw hash bytes from modernHash for comparison. */
function modernHash(value: unknown): Uint8Array {
  return modernHashRaw(value).hash;
}

// =========================================================================
// Primitive types
// =========================================================================

Deno.test("modernHash", async (t) => {
  // --- null ---

  await t.step("null produces TAG_NULL byte stream", () => {
    // Byte stream: [0x20]
    const expected = sha256([0x20]);
    assertEquals(modernHash(null), expected);
  });

  // --- boolean ---

  await t.step("true produces TAG_BOOLEAN + 0x01", () => {
    // [0x22, 0x01]
    const expected = sha256([0x22, 0x01]);
    assertEquals(modernHash(true), expected);
  });

  await t.step("false produces TAG_BOOLEAN + 0x00", () => {
    // [0x22, 0x00]
    const expected = sha256([0x22, 0x00]);
    assertEquals(modernHash(false), expected);
  });

  await t.step("true and false produce different hashes", () => {
    assertNotEquals(hex(modernHash(true)), hex(modernHash(false)));
  });

  // --- number ---

  await t.step("42 produces TAG_NUMBER + IEEE 754 float64 BE", () => {
    const expected = sha256([
      0x23,
      0x40,
      0x45,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    assertEquals(modernHash(42), expected);
  });

  await t.step("0 produces TAG_NUMBER + all zeros", () => {
    const expected = sha256([
      0x23,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    assertEquals(modernHash(0), expected);
  });

  await t.step("-0 normalizes to +0 (same hash)", () => {
    assertEquals(modernHash(-0), modernHash(0));
  });

  await t.step("NaN throws", () => {
    assertThrows(
      () => modernHash(NaN),
      Error,
      "non-finite",
    );
  });

  await t.step("Infinity throws", () => {
    assertThrows(
      () => modernHash(Infinity),
      Error,
      "non-finite",
    );
  });

  await t.step("-Infinity throws", () => {
    assertThrows(
      () => modernHash(-Infinity),
      Error,
      "non-finite",
    );
  });

  await t.step("different numbers produce different hashes", () => {
    assertNotEquals(hex(modernHash(1)), hex(modernHash(2)));
    assertNotEquals(hex(modernHash(0)), hex(modernHash(1)));
    assertNotEquals(hex(modernHash(-1)), hex(modernHash(1)));
  });

  await t.step(
    "Number.MAX_VALUE produces TAG_NUMBER + all-nonzero IEEE 754 bytes",
    () => {
      // IEEE 754 float64 big-endian for Number.MAX_VALUE:
      // 7F EF FF FF FF FF FF FF  (all bytes non-zero)
      const expected = sha256([
        0x23,
        0x7f,
        0xef,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ]);
      assertEquals(hex(modernHash(Number.MAX_VALUE)), hex(expected));
    },
  );

  // --- string ---

  await t.step(
    "hello produces TAG_STRING + LEB128 byte length + UTF-8",
    () => {
      // UTF-8 for "hello": [0x68, 0x65, 0x6c, 0x6c, 0x6f], 5 bytes
      // LEB128(5) = [0x05]
      const expected = sha256([
        0x24,
        0x05,
        0x68,
        0x65,
        0x6c,
        0x6c,
        0x6f,
      ]);
      assertEquals(modernHash("hello"), expected);
    },
  );

  await t.step("empty string produces TAG_STRING + zero length", () => {
    // LEB128(0) = [0x00]
    const expected = sha256([0x24, 0x00]);
    assertEquals(modernHash(""), expected);
  });

  await t.step("different strings produce different hashes", () => {
    assertNotEquals(hex(modernHash("a")), hex(modernHash("b")));
    assertNotEquals(hex(modernHash("")), hex(modernHash("a")));
  });

  await t.step("multi-byte UTF-8 characters encode correctly", () => {
    // Verify consistency (same value -> same hash)
    assertEquals(modernHash("\u00e9"), modernHash("\u00e9"));
    // e-acute is 2 bytes in UTF-8
    assertNotEquals(hex(modernHash("e")), hex(modernHash("\u00e9")));
  });

  await t.step("surrogate pairs (emoji) encode correctly", () => {
    // U+1F600 (grinning face) is 4 bytes in UTF-8
    const emoji = "\u{1F600}";
    const enc = new TextEncoder();
    const utf8 = enc.encode(emoji);
    assertEquals(utf8.length, 4); // 4 bytes in UTF-8
    // LEB128(4) = [0x04]
    const expected = sha256([
      0x24,
      0x04,
      ...utf8,
    ]);
    assertEquals(modernHash(emoji), expected);
  });

  // --- bigint ---

  await t.step("0n encodes as TAG_BIGINT + LEB128 length 1 + [0x00]", () => {
    // LEB128(1) = [0x01]
    const expected = sha256([0x26, 0x01, 0x00]);
    assertEquals(modernHash(0n), expected);
  });

  await t.step("127n encodes as 1 byte: 0x7F", () => {
    const expected = sha256([0x26, 0x01, 0x7f]);
    assertEquals(modernHash(127n), expected);
  });

  await t.step("128n encodes as 2 bytes: 0x00, 0x80", () => {
    // 128 = 0x80, but high bit set means negative in two's complement,
    // so we need a leading 0x00. LEB128(2) = [0x02].
    const expected = sha256([0x26, 0x02, 0x00, 0x80]);
    assertEquals(modernHash(128n), expected);
  });

  await t.step("-1n encodes as 1 byte: 0xFF", () => {
    const expected = sha256([0x26, 0x01, 0xff]);
    assertEquals(modernHash(-1n), expected);
  });

  await t.step("-128n encodes as 1 byte: 0x80", () => {
    const expected = sha256([0x26, 0x01, 0x80]);
    assertEquals(modernHash(-128n), expected);
  });

  await t.step("-129n encodes as 2 bytes: 0xFF, 0x7F", () => {
    const expected = sha256([0x26, 0x02, 0xff, 0x7f]);
    assertEquals(modernHash(-129n), expected);
  });

  await t.step("large bigint encodes correctly", () => {
    // 2^64 = 18446744073709551616n
    // hex: 10000000000000000 -> 9 bytes: 01 00 00 00 00 00 00 00 00
    const big = 2n ** 64n;
    const hash = modernHash(big);
    assertEquals(hash.length, 32); // SHA-256 produces 32 bytes

    // Verify it's consistent
    assertEquals(modernHash(big), hash);
  });

  await t.step(
    "0x112233445566778899abcdefn matches hand-computed byte stream",
    () => {
      // 12-byte positive bigint, high nibble 0x1 so no sign-extension needed.
      // TAG_BIGINT(0x26) + LEB128(12)=0x0c + big-endian bytes
      const expected = sha256([
        0x26,
        0x0c,
        0x11,
        0x22,
        0x33,
        0x44,
        0x55,
        0x66,
        0x77,
        0x88,
        0x99,
        0xab,
        0xcd,
        0xef,
      ]);
      assertEquals(
        hex(modernHash(0x112233445566778899abcdefn)),
        hex(expected),
      );
    },
  );

  await t.step(
    "-0x112233445566778899abcdefn matches hand-computed byte stream",
    () => {
      // Negative two's complement of 11 22 33 44 55 66 77 88 99 AB CD EF:
      //   Invert: EE DD CC BB AA 99 88 77 66 54 32 10
      //   Add 1:  EE DD CC BB AA 99 88 77 66 54 32 11
      // High byte 0xEE has bit 7 set -- correctly negative, 12 bytes.
      // TAG_BIGINT(0x26) + LEB128(12)=0x0c + big-endian two's complement
      const expected = sha256([
        0x26,
        0x0c,
        0xee,
        0xdd,
        0xcc,
        0xbb,
        0xaa,
        0x99,
        0x88,
        0x77,
        0x66,
        0x54,
        0x32,
        0x11,
      ]);
      assertEquals(
        hex(modernHash(-0x112233445566778899abcdefn)),
        hex(expected),
      );
    },
  );

  // --- undefined ---

  await t.step("undefined produces TAG_UNDEFINED", () => {
    // [0x21]
    const expected = sha256([0x21]);
    assertEquals(modernHash(undefined), expected);
  });

  // --- cross-type distinctness ---

  await t.step("null vs undefined vs false produce different hashes", () => {
    const nullH = hex(modernHash(null));
    const undefH = hex(modernHash(undefined));
    const falseH = hex(modernHash(false));
    assertNotEquals(nullH, undefH);
    assertNotEquals(nullH, falseH);
    assertNotEquals(undefH, falseH);
  });

  await t.step("number 0 vs bigint 0n vs string '0' are distinct", () => {
    const numH = hex(modernHash(0));
    const bigH = hex(modernHash(0n));
    const strH = hex(modernHash("0"));
    assertNotEquals(numH, bigH);
    assertNotEquals(numH, strH);
    assertNotEquals(bigH, strH);
  });

  // =========================================================================
  // FabricUint8Array
  // =========================================================================

  await t.step(
    "FabricUint8Array produces TAG_BYTES + LEB128 length + raw bytes",
    () => {
      const bytes = new FabricUint8Array(new Uint8Array([1, 2, 3]));
      // LEB128(3) = [0x03]
      const expected = sha256([
        0x25,
        0x03,
        0x01,
        0x02,
        0x03,
      ]);
      assertEquals(modernHash(bytes), expected);
    },
  );

  await t.step(
    "empty FabricUint8Array produces TAG_BYTES + zero length",
    () => {
      const bytes = new FabricUint8Array(new Uint8Array([]));
      const expected = sha256([0x25, 0x00]);
      assertEquals(modernHash(bytes), expected);
    },
  );

  // =========================================================================
  // FabricEpochNsec (dedicated TAG_EPOCH_NSEC primitive tag)
  // =========================================================================

  await t.step(
    "FabricEpochNsec(0n) matches hand-computed byte stream",
    () => {
      // TAG_EPOCH_NSEC (0x27) + LEB128(1) + [0x00]
      const expected = sha256([
        0x27,
        0x01,
        0x00,
      ]);
      assertEquals(modernHash(new FabricEpochNsec(0n)), expected);
    },
  );

  await t.step("FabricEpochNsec with different values differ", () => {
    const d1 = new FabricEpochNsec(0n);
    const d2 = new FabricEpochNsec(1704067200000000000n);
    assertNotEquals(hex(modernHash(d1)), hex(modernHash(d2)));
  });

  await t.step("FabricEpochNsec with negative value (pre-epoch)", () => {
    const nsec = new FabricEpochNsec(-1000000000n);
    const hash = modernHash(nsec);
    assertEquals(hash.length, 32);
  });

  // =========================================================================
  // FabricEpochDays (dedicated TAG_EPOCH_DAYS primitive tag)
  // =========================================================================

  await t.step(
    "FabricEpochDays(0n) matches hand-computed byte stream",
    () => {
      // TAG_EPOCH_DAYS (0x28) + LEB128(1) + [0x00]
      const expected = sha256([
        0x28,
        0x01,
        0x00,
      ]);
      assertEquals(modernHash(new FabricEpochDays(0n)), expected);
    },
  );

  await t.step("FabricEpochDays with different values differ", () => {
    const d1 = new FabricEpochDays(0n);
    const d2 = new FabricEpochDays(19723n);
    assertNotEquals(hex(modernHash(d1)), hex(modernHash(d2)));
  });

  await t.step("FabricEpochDays with negative value (pre-epoch)", () => {
    const days = new FabricEpochDays(-365n);
    const hash = modernHash(days);
    assertEquals(hash.length, 32);
  });

  await t.step(
    "FabricEpochNsec and FabricEpochDays with same bigint differ",
    () => {
      // Same underlying value, different tag -> different hash
      const nsec = new FabricEpochNsec(100n);
      const days = new FabricEpochDays(100n);
      assertNotEquals(hex(modernHash(nsec)), hex(modernHash(days)));
    },
  );

  // =========================================================================
  // FabricError (FabricInstance via DECONSTRUCT)
  // =========================================================================

  await t.step(
    "FabricError matches byte stream built from DECONSTRUCT output",
    () => {
      // Build the expected byte stream programmatically because the
      // deconstructed state includes `stack` which is environment-dependent.
      // We construct the stream the same way modernHash does, then SHA-256 it.
      const error = new FabricError(new Error("test"));
      const enc = new TextEncoder();

      // TAG_INSTANCE (0x12) + LEB128(typeTagLen) + typeTag UTF-8
      const typeTagUtf8 = enc.encode("Error@1"); // 7 bytes
      const stream: number[] = [0x12, typeTagUtf8.length, ...typeTagUtf8];

      // Deconstructed state is an object with sorted keys.
      // FabricError.DECONSTRUCT() returns:
      //   { type: "Error", name: null, message: "test", stack: <string> }
      // Keys sorted by UTF-8: message, name, stack, type
      stream.push(0x11); // TAG_OBJECT

      // Key "message" + value "test"
      const messageKey = enc.encode("message");
      stream.push(0x24, messageKey.length, ...messageKey);
      const messageVal = enc.encode("test");
      stream.push(0x24, messageVal.length, ...messageVal);

      // Key "name" + value null (name === type for Error, so null)
      const nameKey = enc.encode("name");
      stream.push(0x24, nameKey.length, ...nameKey);
      stream.push(0x20); // TAG_NULL

      // Key "stack" + value (the actual stack string)
      const stackKey = enc.encode("stack");
      stream.push(0x24, stackKey.length, ...stackKey);
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
      stream.push(0x24, ...stackLenBytes, ...stackUtf8);

      // Key "type" + value "Error"
      const typeKey = enc.encode("type");
      stream.push(0x24, typeKey.length, ...typeKey);
      const typeVal = enc.encode("Error");
      stream.push(0x24, typeVal.length, ...typeVal);

      // TAG_END for the object
      stream.push(0x00);

      const expected = sha256(stream);
      assertEquals(modernHash(error), expected);
    },
  );

  await t.step("different errors produce different hashes", () => {
    const e1 = new FabricError(new Error("hello"));
    const e2 = new FabricError(new Error("world"));
    assertNotEquals(hex(modernHash(e1)), hex(modernHash(e2)));
  });

  await t.step("TypeError vs Error produce different hashes", () => {
    const e1 = new FabricError(new Error("msg"));
    const e2 = new FabricError(new TypeError("msg"));
    assertNotEquals(hex(modernHash(e1)), hex(modernHash(e2)));
  });

  // =========================================================================
  // Arrays
  // =========================================================================

  await t.step("empty array produces TAG_ARRAY + TAG_END", () => {
    const expected = sha256([0x10, 0x00]);
    assertEquals(modernHash([]), expected);
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
      0x23,
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
      0x23,
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
    assertEquals(modernHash([1, , 3]), expected);
  });

  await t.step("multiple consecutive holes are coalesced into one run", () => {
    // [1, , , , 5] -> hole run of 3
    const arr = new Array(5);
    arr[0] = 1;
    arr[4] = 5;
    const hash = modernHash(arr);

    // Verify by building the expected byte stream manually
    const expected = sha256([
      // TAG_ARRAY
      0x10,
      // Element 0: number 1
      0x23,
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
      0x23,
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
      const sparseH = hex(modernHash([1, , 3]));
      const undefH = hex(modernHash([1, undefined, 3]));
      const nullH = hex(modernHash([1, null, 3]));

      assertNotEquals(sparseH, undefH);
      assertNotEquals(sparseH, nullH);
      assertNotEquals(undefH, nullH);
    },
  );

  await t.step("nested arrays are recursively hashed", () => {
    const hash = modernHash([[1, 2], [3]]);
    assertEquals(hash.length, 32);
    // Different from flat array
    assertNotEquals(hex(hash), hex(modernHash([1, 2, 3])));
  });

  // =========================================================================
  // Objects
  // =========================================================================

  await t.step("empty object produces TAG_OBJECT + TAG_END", () => {
    const expected = sha256([0x11, 0x00]);
    assertEquals(modernHash({}), expected);
  });

  await t.step("object key order is deterministic (sorted by UTF-8)", () => {
    // Keys inserted in different orders produce the same hash.
    const h1 = modernHash({ a: 1, b: 2 });
    const h2 = modernHash({ b: 2, a: 1 });
    assertEquals(h1, h2);
  });

  await t.step("{a: 1, b: 2} matches hand-computed byte stream", () => {
    // Keys sorted: "a" (0x61) < "b" (0x62)
    // LEB128 lengths are single bytes for small values.
    const expected = sha256([
      // TAG_OBJECT
      0x11,
      // Key "a": TAG_STRING + LEB128(1) + UTF-8
      0x24,
      0x01,
      0x61,
      // Value 1: TAG_NUMBER + IEEE754 for 1.0
      0x23,
      0x3f,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      // Key "b": TAG_STRING + LEB128(1) + UTF-8
      0x24,
      0x01,
      0x62,
      // Value 2: TAG_NUMBER + IEEE754 for 2.0
      0x23,
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
    assertEquals(modernHash({ a: 1, b: 2 }), expected);
  });

  await t.step("nested objects are recursively hashed", () => {
    const hash = modernHash({ x: { y: 1 } });
    assertEquals(hash.length, 32);
    assertNotEquals(hex(hash), hex(modernHash({ x: 1 })));
  });

  await t.step("object with mixed value types", () => {
    const hash = modernHash({
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
    });
    assertEquals(hash.length, 32);
    // Consistency
    assertEquals(
      hash,
      modernHash({ str: "hello", num: 42, bool: true, nil: null }),
    );
  });

  // =========================================================================
  // Consistency and distinctness
  // =========================================================================

  await t.step("same value always produces the same hash", () => {
    assertEquals(modernHash(42), modernHash(42));
    assertEquals(modernHash("hello"), modernHash("hello"));
    assertEquals(modernHash([1, 2, 3]), modernHash([1, 2, 3]));
    assertEquals(
      modernHash({ a: 1 }),
      modernHash({ a: 1 }),
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
      new FabricEpochNsec(0n),
      new FabricEpochDays(0n),
      new FabricUint8Array(new Uint8Array([1])),
      new FabricError(new Error("x")),
    ];
    for (const v of values) {
      assertEquals(modernHash(v).length, 32);
    }
  });

  await t.step(
    "different values of different types produce different hashes",
    () => {
      const hashes = new Set([
        hex(modernHash(null)),
        hex(modernHash(true)),
        hex(modernHash(false)),
        hex(modernHash(0)),
        hex(modernHash("")),
        hex(modernHash(0n)),
        hex(modernHash(undefined)),
        hex(modernHash([])),
        hex(modernHash({})),
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
    const hash = modernHash(deep);
    assertEquals(hash.length, 32);
    assertEquals(modernHash(deep), hash);
  });

  await t.step("array with all holes", () => {
    const arr = new Array(5); // all holes
    const hash = modernHash(arr);
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
    const h1 = modernHash({ "\u00e9": 1, "a": 2 });
    const h2 = modernHash({ "a": 2, "\u00e9": 1 });
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
      // + keyA: TAG_STRING(0x24) + LEB128(3) + EF 80 80
      // + value 1: TAG_NUMBER(0x23) + IEEE754 for 1.0
      // + keyB: TAG_STRING(0x24) + LEB128(4) + F0 90 80 80
      // + value 2: TAG_NUMBER(0x23) + IEEE754 for 2.0
      // + TAG_END (0x00)
      const expected = sha256([
        // TAG_OBJECT
        0x11,
        // keyA: U+F000 (UTF-8 first)
        0x24,
        0x03,
        0xef,
        0x80,
        0x80,
        // value 1
        0x23,
        0x3f,
        0xf0,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // keyB: U+10000 (UTF-8 second)
        0x24,
        0x04,
        0xf0,
        0x90,
        0x80,
        0x80,
        // value 2
        0x23,
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
      assertEquals(modernHash(obj), expected);

      // Also verify the wrong (UTF-16) order produces a different hash.
      const wrongOrder = sha256([
        0x11,
        // keyB first (wrong -- UTF-16 order)
        0x24,
        0x04,
        0xf0,
        0x90,
        0x80,
        0x80,
        0x23,
        0x40,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // keyA second
        0x24,
        0x03,
        0xef,
        0x80,
        0x80,
        0x23,
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
      assertNotEquals(hex(modernHash(obj)), hex(wrongOrder));
    },
  );

  // =========================================================================
  // FabricHash hashing (TAG_CONTENT_ID = 0x29)
  // =========================================================================

  await t.step(
    "FabricHash matches hand-computed byte stream",
    () => {
      // Algorithm tag "fid1" = [0x66, 0x69, 0x64, 0x31] (4 bytes UTF-8)
      // Hash bytes: [0xDE, 0xAD, 0xBE, 0xEF] (4 bytes)
      const cid = new FabricHash(
        new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
        "fid1",
      );
      // Expected: TAG_CONTENT_ID(0x29), algTagLen(0x04), "fid1", hashLen(0x04), hash
      const expected = sha256([
        0x29,
        0x04,
        0x66,
        0x69,
        0x64,
        0x31,
        0x04,
        0xDE,
        0xAD,
        0xBE,
        0xEF,
      ]);
      assertEquals(hex(modernHash(cid)), hex(expected));
    },
  );

  await t.step(
    "FabricHash with different algorithm tags produce different hashes",
    () => {
      const bytes = new Uint8Array([0x01, 0x02, 0x03]);
      const cid1 = new FabricHash(bytes, "fid1");
      const cid2 = new FabricHash(bytes, "fid2");
      assertNotEquals(hex(modernHash(cid1)), hex(modernHash(cid2)));
    },
  );

  await t.step(
    "FabricHash with different hash bytes produce different hashes",
    () => {
      const cid1 = new FabricHash(
        new Uint8Array([0x01, 0x02]),
        "fid1",
      );
      const cid2 = new FabricHash(
        new Uint8Array([0x03, 0x04]),
        "fid1",
      );
      assertNotEquals(hex(modernHash(cid1)), hex(modernHash(cid2)));
    },
  );

  // =========================================================================
  // modernHash returns FabricHash
  // =========================================================================

  await t.step("modernHash returns FabricHash with fid1 tag", () => {
    const result = modernHashRaw(42);
    assertEquals(result instanceof FabricHash, true);
    assertEquals(result.algorithmTag, "fid1");
    assertEquals(result.hash.length, 32);
  });

  await t.step("FabricHash.toString() produces fid1:<base64>", () => {
    const result = modernHashRaw(42);
    const str = result.toString();
    assertEquals(str.startsWith("fid1:"), true);
    // Should not contain padding (unpadded base64).
    assertEquals(str.includes("="), false);
  });

  await t.step("FabricHash is frozen (FabricPrimitive)", () => {
    const result = modernHashRaw(42);
    assertEquals(Object.isFrozen(result), true);
  });
});

// ---------------------------------------------------------------------------
// Caching behavior
// ---------------------------------------------------------------------------

Deno.test("modernHash caching", async (t) => {
  await t.step("null returns same object (precomputed constant)", () => {
    const a = modernHashRaw(null);
    const b = modernHashRaw(null);
    assertStrictEquals(a, b);
  });

  await t.step("undefined returns same object (precomputed constant)", () => {
    const a = modernHashRaw(undefined);
    const b = modernHashRaw(undefined);
    assertStrictEquals(a, b);
  });

  await t.step("true returns same object (precomputed constant)", () => {
    const a = modernHashRaw(true);
    const b = modernHashRaw(true);
    assertStrictEquals(a, b);
  });

  await t.step("false returns same object (precomputed constant)", () => {
    const a = modernHashRaw(false);
    const b = modernHashRaw(false);
    assertStrictEquals(a, b);
  });

  await t.step("primitive string cache returns same object", () => {
    const a = modernHashRaw("cache-test-string");
    const b = modernHashRaw("cache-test-string");
    assertStrictEquals(a, b);
  });

  await t.step("primitive number cache returns same object", () => {
    const a = modernHashRaw(98765);
    const b = modernHashRaw(98765);
    assertStrictEquals(a, b);
  });

  await t.step("primitive bigint cache returns same object", () => {
    const a = modernHashRaw(99887766n);
    const b = modernHashRaw(99887766n);
    assertStrictEquals(a, b);
  });

  await t.step("deep-frozen object cache returns same object", () => {
    const obj = Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) });
    const a = modernHashRaw(obj);
    const b = modernHashRaw(obj);
    assertStrictEquals(a, b);
  });

  await t.step("mutable object is not cached (recomputed each time)", () => {
    const obj = { a: 1 };
    const a = modernHashRaw(obj);
    // Mutate
    obj.a = 2;
    const b = modernHashRaw(obj);
    // Hashes should differ because the object changed
    assertNotEquals(hex(a.hash), hex(b.hash));
  });

  await t.step(
    "different primitives with same type produce different hashes",
    () => {
      const a = modernHashRaw("hello");
      const b = modernHashRaw("world");
      assertNotEquals(hex(a.hash), hex(b.hash));
    },
  );
});
