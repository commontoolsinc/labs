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

//
// Reference encoder
//

/**
 * Deliberately-naive minimal two's-complement encoder, used as the test
 * oracle. Optimized for obviousness rather than speed: derive the byte
 * length from the magnitude's binary representation, apply two's complement
 * via plain bigint arithmetic, then materialize bytes through `toString(16)`
 * plus `parseInt`.
 */
function referenceEncode(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0]);

  const abs = value < 0n ? -value : value;
  const magBits = abs.toString(2).length;

  // For positive `v`, the encoding needs `magBits + 1` bits (extra leading
  // 0 for the sign). For negative `v`, the same holds, except the boundary
  // value `-(2^(magBits-1))` (a power of two) fits in exactly `magBits`
  // bits because its high bit doubles as the sign bit.
  let totalBits: number;
  if (value > 0n) {
    totalBits = magBits + 1;
  } else if ((1n << BigInt(magBits - 1)) === abs) {
    totalBits = magBits;
  } else {
    totalBits = magBits + 1;
  }
  const byteLen = (totalBits + 7) >> 3;

  // Map negatives onto their unsigned two's-complement representation.
  const unsigned = value < 0n ? value + (1n << BigInt(byteLen * 8)) : value;

  // Hex pad to even, then parse byte-by-byte.
  let hex = unsigned.toString(16);
  while (hex.length < byteLen * 2) hex = "0" + hex;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================================================
// Fixtures
// ============================================================================

const rawFixtures: bigint[] = [
  // Explicit corner cases preserved from the original tests.
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
  0x112233445566778899abcdefn,
  -0x112233445566778899abcdefn,
  // Negatives whose two's-complement remainder has leading-zero padding in
  // its byte form -- a corner case that exercised a historical encoder bug
  // (see PR #3527). The corresponding positive case (odd-hex-length with
  // high nibble in 8..F) is reached via the recurrence below at iteration
  // 2, where `n = 217129053n` (= `0xCF1205D`).
  -241n,
  -242n,
  -243n,
  -244n,
  -245n,
  -246n,
  -247n,
  -248n,
  // Boundaries of the 64-bit fast path in `convertSmallValue()`: the
  // largest positive and the most-negative value it handles, plus one
  // step beyond each into the slow path.
  0x7fff_ffff_ffff_ffffn, //  2^63 - 1,  max fast-path positive
  0x8000_0000_0000_0000n, //  2^63,      first slow-path positive
  -0x8000_0000_0000_0000n, // -2^63,     most-negative fast-path
  -0x8000_0000_0000_0001n, // -2^63 - 1, first slow-path negative
];

// Programmatic expansion via a deterministic recurrence. The multiplier `99`
// adds ~6.63 bits per step, so 2000 iterations sweep magnitudes from a few
// bits up to roughly 13_270 bits (~1659 bytes), with both signs at every step.
{
  let n = 123n;
  for (let i = 0; i < 2000; i++) {
    n = (n * 99n) + 9876n;
    rawFixtures.push(n);
    rawFixtures.push(-n);
  }
}

/**
 * Format a bigint for use in a test name. Decimals up to 64 bits, hex up to
 * 128 bits, and beyond that just a hex prefix and the encoded byte count.
 */
function fixtureLabel(v: bigint, encoded: Uint8Array): string {
  if (v === 0n) return "0n";
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  if (abs < 1n << 64n) return `${v}n`;
  const hex = abs.toString(16);
  if (hex.length <= 32) return `${sign}0x${hex}n`;
  return `${sign}0x${hex.slice(0, 12)}... (${encoded.length} bytes)`;
}

interface Fixture {
  value: bigint;
  encoded: Uint8Array;
  label: string;
}

const fixtures: readonly Fixture[] = rawFixtures.map((value) => {
  const encoded = referenceEncode(value);
  return { value, encoded, label: fixtureLabel(value, encoded) };
});

//
// Reference encoder anchor
//

// A small set of explicit byte-level assertions that pin `referenceEncode`
// against the spec. The rest of the suite trusts it as an oracle, so it
// matters that these can't both be wrong in the same way.
describe("referenceEncode (test oracle)", () => {
  it("encodes 0n", () => {
    expect(referenceEncode(0n)).toEqual(new Uint8Array([0x00]));
  });

  it("encodes 1n", () => {
    expect(referenceEncode(1n)).toEqual(new Uint8Array([0x01]));
  });

  it("encodes 127n", () => {
    expect(referenceEncode(127n)).toEqual(new Uint8Array([0x7f]));
  });

  it("encodes 128n (sign extension)", () => {
    expect(referenceEncode(128n)).toEqual(new Uint8Array([0x00, 0x80]));
  });

  it("encodes 255n", () => {
    expect(referenceEncode(255n)).toEqual(new Uint8Array([0x00, 0xff]));
  });

  it("encodes 256n", () => {
    expect(referenceEncode(256n)).toEqual(new Uint8Array([0x01, 0x00]));
  });

  it("encodes -1n", () => {
    expect(referenceEncode(-1n)).toEqual(new Uint8Array([0xff]));
  });

  it("encodes -128n", () => {
    expect(referenceEncode(-128n)).toEqual(new Uint8Array([0x80]));
  });

  it("encodes -129n (sign extension)", () => {
    expect(referenceEncode(-129n)).toEqual(new Uint8Array([0xff, 0x7f]));
  });

  it("encodes 2^64 as 9 bytes", () => {
    const bytes = referenceEncode(2n ** 64n);
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(0x01);
    for (let i = 1; i < 9; i++) expect(bytes[i]).toBe(0x00);
  });
});

//
// Per-function fixture loops
//

const FIXTURE_SLICE_SIZE = 1000;
for (let at = 0; at < fixtures.length; at += FIXTURE_SLICE_SIZE) {
  const slice = fixtures.slice(at, at + FIXTURE_SLICE_SIZE);
  const sliceLabel = `fixtures ${at}..${at + slice.length - 1}`;

  describe("bigintToMinimalTwosComplement()", () => {
    it(`correctly encodes ${sliceLabel}`, () => {
      for (let i = 0; i < slice.length; i++) {
        const { value, encoded, label } = slice[i];
        try {
          expect(bigintToMinimalTwosComplement(value)).toEqual(encoded);
        } catch {
          throw new Error(`Failed on ${label}.`);
        }
      }
    });
  });

  describe("bigintFromMinimalTwosComplement()", () => {
    it(`correctly decodes ${sliceLabel}`, () => {
      for (let i = 0; i < slice.length; i++) {
        const { value, encoded, label } = slice[i];
        try {
          expect(bigintFromMinimalTwosComplement(encoded)).toBe(value);
        } catch {
          throw new Error(`Failed on ${label}.`);
        }
      }
    });
  });

  describe("round trip through base64url", () => {
    it(`correctly round-trips ${sliceLabel}`, () => {
      for (let i = 0; i < slice.length; i++) {
        const { value, label } = slice[i];
        const bytes = bigintToMinimalTwosComplement(value);
        const b64 = toUnpaddedBase64url(bytes);
        const decodedBytes = fromBase64url(b64);
        try {
          expect(bigintFromMinimalTwosComplement(decodedBytes)).toBe(value);
        } catch {
          throw new Error(`Failed on ${label}.`);
        }
      }
    });
  });
}

//
// Edge cases and specific regression tests
//

describe("bigintFromMinimalTwosComplement()", () => {
  it("throws on empty input", () => {
    expect(() => bigintFromMinimalTwosComplement(new Uint8Array([]))).toThrow(
      "empty input",
    );
  });
});

// Both `bigintToMinimalTwosComplement` paths used to confuse "leading char
// of `value.toString(16)`" with "high nibble of byte 0 of the encoded form".
// They differ when the hex string would need leading-zero padding to fill
// `byteLen * 2` characters: the hex's leading char is non-zero, but the
// padded byte representation has byte 0 starting with a zero nibble.
describe("bigintToMinimalTwosComplement()", () => {
  describe("byte-length corner cases", () => {
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
});
