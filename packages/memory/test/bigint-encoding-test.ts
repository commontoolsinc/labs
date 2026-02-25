import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
  fromBase64,
  toUnpaddedBase64,
} from "../bigint-encoding.ts";

// ============================================================================
// bigintToMinimalTwosComplement
// ============================================================================

describe("bigintToMinimalTwosComplement", () => {
  it("encodes 0n as [0x00]", () => {
    expect(bigintToMinimalTwosComplement(0n)).toEqual(new Uint8Array([0x00]));
  });

  it("encodes 1n as [0x01]", () => {
    expect(bigintToMinimalTwosComplement(1n)).toEqual(new Uint8Array([0x01]));
  });

  it("encodes 127n as [0x7F]", () => {
    expect(bigintToMinimalTwosComplement(127n)).toEqual(
      new Uint8Array([0x7f]),
    );
  });

  it("encodes 128n as [0x00, 0x80] (sign extension)", () => {
    expect(bigintToMinimalTwosComplement(128n)).toEqual(
      new Uint8Array([0x00, 0x80]),
    );
  });

  it("encodes -1n as [0xFF]", () => {
    expect(bigintToMinimalTwosComplement(-1n)).toEqual(
      new Uint8Array([0xff]),
    );
  });

  it("encodes -128n as [0x80]", () => {
    expect(bigintToMinimalTwosComplement(-128n)).toEqual(
      new Uint8Array([0x80]),
    );
  });

  it("encodes -129n as [0xFF, 0x7F]", () => {
    expect(bigintToMinimalTwosComplement(-129n)).toEqual(
      new Uint8Array([0xff, 0x7f]),
    );
  });

  it("encodes 255n as [0x00, 0xFF]", () => {
    expect(bigintToMinimalTwosComplement(255n)).toEqual(
      new Uint8Array([0x00, 0xff]),
    );
  });

  it("encodes 256n as [0x01, 0x00]", () => {
    expect(bigintToMinimalTwosComplement(256n)).toEqual(
      new Uint8Array([0x01, 0x00]),
    );
  });

  it("encodes 2^64 as 9 bytes", () => {
    const bytes = bigintToMinimalTwosComplement(2n ** 64n);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(0x01);
    for (let i = 1; i < 9; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});

// ============================================================================
// bigintFromMinimalTwosComplement
// ============================================================================

describe("bigintFromMinimalTwosComplement", () => {
  it("decodes [0x00] as 0n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0x00]))).toBe(0n);
  });

  it("decodes [0x01] as 1n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0x01]))).toBe(1n);
  });

  it("decodes [0x7F] as 127n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0x7f]))).toBe(127n);
  });

  it("decodes [0x00, 0x80] as 128n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0x00, 0x80]))).toBe(
      128n,
    );
  });

  it("decodes [0xFF] as -1n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0xff]))).toBe(-1n);
  });

  it("decodes [0x80] as -128n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0x80]))).toBe(
      -128n,
    );
  });

  it("decodes [0xFF, 0x7F] as -129n", () => {
    expect(bigintFromMinimalTwosComplement(new Uint8Array([0xff, 0x7f]))).toBe(
      -129n,
    );
  });

  it("throws on empty input", () => {
    expect(() => bigintFromMinimalTwosComplement(new Uint8Array([]))).toThrow(
      "empty input",
    );
  });
});

// ============================================================================
// Round-trip: encode -> decode
// ============================================================================

describe("bigint encoding round-trip", () => {
  const values = [
    0n,
    1n,
    -1n,
    42n,
    -42n,
    127n,
    128n,
    -128n,
    -129n,
    255n,
    256n,
    -256n,
    -999n,
    2n ** 32n,
    -(2n ** 32n),
    2n ** 64n,
    -(2n ** 64n),
    2n ** 128n,
    -(2n ** 128n),
    // Large positive
    0x112233445566778899abcdefn,
    // Large negative
    -0x112233445566778899abcdefn,
  ];

  for (const value of values) {
    it(`round-trips ${value}n`, () => {
      const bytes = bigintToMinimalTwosComplement(value);
      const result = bigintFromMinimalTwosComplement(bytes);
      expect(result).toBe(value);
    });
  }
});

// ============================================================================
// toUnpaddedBase64
// ============================================================================

describe("toUnpaddedBase64", () => {
  it("encodes empty bytes to empty string", () => {
    expect(toUnpaddedBase64(new Uint8Array([]))).toBe("");
  });

  it("encodes [0x00] to 'AA'", () => {
    expect(toUnpaddedBase64(new Uint8Array([0x00]))).toBe("AA");
  });

  it("encodes [0xFF] to '/w'", () => {
    expect(toUnpaddedBase64(new Uint8Array([0xff]))).toBe("/w");
  });

  it("encodes 3-byte input (no padding case)", () => {
    // 3 bytes -> 4 base64 chars (exact, no padding)
    const b64 = toUnpaddedBase64(new Uint8Array([0x01, 0x02, 0x03]));
    expect(b64.length).toBe(4);
    expect(b64).not.toContain("=");
  });

  it("never produces padding characters", () => {
    // Test various lengths (1, 2, 3, 4, 5 bytes)
    for (let len = 1; len <= 5; len++) {
      const bytes = new Uint8Array(len);
      bytes.fill(0x42);
      const b64 = toUnpaddedBase64(bytes);
      expect(b64).not.toContain("=");
    }
  });
});

// ============================================================================
// fromBase64
// ============================================================================

describe("fromBase64", () => {
  it("decodes empty string to empty bytes", () => {
    expect(fromBase64("")).toEqual(new Uint8Array([]));
  });

  it("decodes 'AA' to [0x00]", () => {
    expect(fromBase64("AA")).toEqual(new Uint8Array([0x00]));
  });

  it("decodes '/w' to [0xFF]", () => {
    expect(fromBase64("/w")).toEqual(new Uint8Array([0xff]));
  });

  it("rejects padded input ('AA==')", () => {
    expect(() => fromBase64("AA==")).toThrow("invalid character");
  });

  it("rejects padded input ('/w==')", () => {
    expect(() => fromBase64("/w==")).toThrow("invalid character");
  });
});

// ============================================================================
// Base64 round-trip
// ============================================================================

describe("base64 round-trip", () => {
  it("round-trips various byte arrays", () => {
    const testArrays = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array([0x00, 0x80]),
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
      new Uint8Array(256).map((_, i) => i),
    ];

    for (const bytes of testArrays) {
      const b64 = toUnpaddedBase64(bytes);
      const decoded = fromBase64(b64);
      expect(decoded).toEqual(bytes);
    }
  });
});

// ============================================================================
// Full pipeline: bigint -> bytes -> base64 -> bytes -> bigint
// ============================================================================

describe("bigint -> base64 -> bigint round-trip", () => {
  const values = [0n, 1n, -1n, 42n, -999n, 128n, -128n, 2n ** 64n];

  for (const value of values) {
    it(`round-trips ${value}n through base64`, () => {
      const bytes = bigintToMinimalTwosComplement(value);
      const b64 = toUnpaddedBase64(bytes);
      const decodedBytes = fromBase64(b64);
      const result = bigintFromMinimalTwosComplement(decodedBytes);
      expect(result).toBe(value);
    });
  }
});
