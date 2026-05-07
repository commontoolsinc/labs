import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "../bigint-encoding.ts";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";

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
// Full pipeline: bigint -> bytes -> base64url -> bytes -> bigint
// ============================================================================

describe("bigint -> base64url -> bigint round-trip", () => {
  const values = [0n, 1n, -1n, 42n, -999n, 128n, -128n, 2n ** 64n];

  for (const value of values) {
    it(`round-trips ${value}n through base64url`, () => {
      const bytes = bigintToMinimalTwosComplement(value);
      const b64 = toUnpaddedBase64url(bytes);
      const decodedBytes = fromBase64url(b64);
      const result = bigintFromMinimalTwosComplement(decodedBytes);
      expect(result).toBe(value);
    });
  }
});

// ============================================================================
// Byte-length boundary regressions
// ============================================================================

// Both `bigintToMinimalTwosComplement` paths used to confuse "leading char
// of `value.toString(16)`" with "high nibble of byte 0 of the encoded form".
// They differ when the hex string would need leading-zero padding to fill
// `byteLen * 2` characters: the hex's leading char is non-zero, but the
// padded byte representation has byte 0 starting with a zero nibble.
describe("bigintToMinimalTwosComplement byte-length corner cases", () => {
  // Positive: an odd-length hex with leading nibble in 8..F. The fast path
  // historically inserted an unnecessary sign-extension byte.
  it("does not over-pad 217129053n (= 0xCF1205D)", () => {
    expect(bigintToMinimalTwosComplement(217129053n)).toEqual(
      new Uint8Array([0x0c, 0xf1, 0x20, 0x5d]),
    );
  });

  // Negatives with abs in [241, 248]. Production historically encoded these
  // as a single byte with the high bit *clear*, breaking the round-trip
  // (e.g., -241n decoded back as 15n).
  for (let i = 241; i <= 248; i++) {
    const v = BigInt(-i);
    it(`round-trips ${v}n with sign bit set`, () => {
      const bytes = bigintToMinimalTwosComplement(v);
      expect(bytes[0] & 0x80).not.toBe(0);
      expect(bigintFromMinimalTwosComplement(bytes)).toBe(v);
    });
  }
});
