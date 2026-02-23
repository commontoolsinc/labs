import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeSLEB128,
  decodeULEB128,
  encodeSLEB128,
  encodeULEB128,
} from "../mod.ts";

Deno.test("encodeULEB128", async (t) => {
  await t.step("encodes 0", () => {
    assertEquals(encodeULEB128(0), new Uint8Array([0x00]));
  });

  await t.step("encodes 1", () => {
    assertEquals(encodeULEB128(1), new Uint8Array([0x01]));
  });

  await t.step("encodes 127 (max single byte)", () => {
    assertEquals(encodeULEB128(127), new Uint8Array([0x7f]));
  });

  await t.step("encodes 128 (first two-byte value)", () => {
    assertEquals(encodeULEB128(128), new Uint8Array([0x80, 0x01]));
  });

  await t.step("encodes 624485 (Wikipedia example)", () => {
    // 624485 = 0x98765 -> LEB128: [0xE5, 0x8E, 0x26]
    assertEquals(
      encodeULEB128(624485),
      new Uint8Array([0xe5, 0x8e, 0x26]),
    );
  });

  await t.step("encodes 255", () => {
    assertEquals(encodeULEB128(255), new Uint8Array([0xff, 0x01]));
  });

  await t.step("encodes 16383 (max two-byte value)", () => {
    assertEquals(encodeULEB128(16383), new Uint8Array([0xff, 0x7f]));
  });

  await t.step("encodes 16384 (first three-byte value)", () => {
    assertEquals(
      encodeULEB128(16384),
      new Uint8Array([0x80, 0x80, 0x01]),
    );
  });

  await t.step("throws on negative", () => {
    assertThrows(() => encodeULEB128(-1), Error, "non-negative");
  });

  await t.step("throws on non-integer", () => {
    assertThrows(() => encodeULEB128(1.5), Error, "non-negative integer");
  });
});

Deno.test("decodeULEB128", async (t) => {
  await t.step("decodes 0", () => {
    assertEquals(decodeULEB128(new Uint8Array([0x00])), {
      value: 0,
      nextIndex: 1,
    });
  });

  await t.step("decodes 127", () => {
    assertEquals(decodeULEB128(new Uint8Array([0x7f])), {
      value: 127,
      nextIndex: 1,
    });
  });

  await t.step("decodes 128", () => {
    assertEquals(decodeULEB128(new Uint8Array([0x80, 0x01])), {
      value: 128,
      nextIndex: 2,
    });
  });

  await t.step("decodes 624485 (Wikipedia example)", () => {
    assertEquals(decodeULEB128(new Uint8Array([0xe5, 0x8e, 0x26])), {
      value: 624485,
      nextIndex: 3,
    });
  });

  await t.step("decodes at offset", () => {
    // Prefix bytes [0xff, 0xff], then encoded 128 = [0x80, 0x01]
    assertEquals(
      decodeULEB128(new Uint8Array([0xff, 0xff, 0x80, 0x01]), 2),
      { value: 128, nextIndex: 4 },
    );
  });

  await t.step("throws on truncated input", () => {
    assertThrows(
      () => decodeULEB128(new Uint8Array([0x80])),
      Error,
      "unexpected end",
    );
  });

  await t.step("roundtrip for various values", () => {
    const values = [0, 1, 5, 63, 64, 127, 128, 255, 256, 16383, 16384, 65535];
    for (const v of values) {
      const encoded = encodeULEB128(v);
      const decoded = decodeULEB128(encoded);
      assertEquals(decoded.value, v, `roundtrip failed for ${v}`);
      assertEquals(decoded.nextIndex, encoded.length);
    }
  });
});

Deno.test("encodeSLEB128", async (t) => {
  await t.step("encodes 0", () => {
    assertEquals(encodeSLEB128(0), new Uint8Array([0x00]));
  });

  await t.step("encodes -1", () => {
    assertEquals(encodeSLEB128(-1), new Uint8Array([0x7f]));
  });

  await t.step("encodes 1", () => {
    assertEquals(encodeSLEB128(1), new Uint8Array([0x01]));
  });

  await t.step("encodes 63 (max positive single byte)", () => {
    assertEquals(encodeSLEB128(63), new Uint8Array([0x3f]));
  });

  await t.step("encodes 64 (first positive two-byte)", () => {
    assertEquals(encodeSLEB128(64), new Uint8Array([0xc0, 0x00]));
  });

  await t.step("encodes -64 (min negative single byte)", () => {
    assertEquals(encodeSLEB128(-64), new Uint8Array([0x40]));
  });

  await t.step("encodes -65 (first negative two-byte)", () => {
    assertEquals(encodeSLEB128(-65), new Uint8Array([0xbf, 0x7f]));
  });

  await t.step("encodes -123456 (Wikipedia example)", () => {
    // -123456 -> signed LEB128: [0xC0, 0xBB, 0x78]
    assertEquals(
      encodeSLEB128(-123456),
      new Uint8Array([0xc0, 0xbb, 0x78]),
    );
  });
});

Deno.test("decodeSLEB128", async (t) => {
  await t.step("decodes 0", () => {
    assertEquals(decodeSLEB128(new Uint8Array([0x00])), {
      value: 0,
      nextIndex: 1,
    });
  });

  await t.step("decodes -1", () => {
    assertEquals(decodeSLEB128(new Uint8Array([0x7f])), {
      value: -1,
      nextIndex: 1,
    });
  });

  await t.step("decodes 63", () => {
    assertEquals(decodeSLEB128(new Uint8Array([0x3f])), {
      value: 63,
      nextIndex: 1,
    });
  });

  await t.step("decodes -64", () => {
    assertEquals(decodeSLEB128(new Uint8Array([0x40])), {
      value: -64,
      nextIndex: 1,
    });
  });

  await t.step("decodes -123456 (Wikipedia example)", () => {
    assertEquals(decodeSLEB128(new Uint8Array([0xc0, 0xbb, 0x78])), {
      value: -123456,
      nextIndex: 3,
    });
  });

  await t.step("roundtrip for various signed values", () => {
    const values = [
      0,
      1,
      -1,
      63,
      64,
      -64,
      -65,
      127,
      128,
      -128,
      -129,
      1000,
      -1000,
    ];
    for (const v of values) {
      const encoded = encodeSLEB128(v);
      const decoded = decodeSLEB128(encoded);
      assertEquals(decoded.value, v, `roundtrip failed for ${v}`);
      assertEquals(decoded.nextIndex, encoded.length);
    }
  });
});
