import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";
import {
  bigintFromMtcDirect,
  bigintToMtcDirect,
} from "../src/bigint-uint8-direct.ts";
import {
  bigintFromMtcHex,
  bigintToMtcHex,
} from "../src/bigint-uint8-hex-string.ts";
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

//
// Fixtures, both main and reference
//

interface Fixture {
  value: bigint;
  encoded: Uint8Array;
  label: string;
}

const rawFixtures: Set<bigint> = new Set();

{
  // Full range of small numbers.
  for (let i = -0x100n; i <= 0x100n; i++) {
    rawFixtures.add(i);
  }

  // Many nines, decimal edition!
  for (let i = 999n; i < (1n << 200n); i = (i * 10n) + 9n) {
    rawFixtures.add(i);
    rawFixtures.add(-i);
  }

  // Many nines, hex edition!
  for (let i = 0x999n; i < (1n << 200n); i = (i << 4n) + 0x09n) {
    rawFixtures.add(i);
    rawFixtures.add(-i);
  }

  // Potential sign-bit confusion edge cases.
  for (let i = 0n; i <= 256n; i++) {
    rawFixtures.add(0x01n << i);
    rawFixtures.add(0x7en << i);
    rawFixtures.add(0x7fn << i);
    rawFixtures.add(0x80n << i);
    rawFixtures.add(0x81n << i);
    rawFixtures.add(-0x01n << i);
    rawFixtures.add(-0x7en << i);
    rawFixtures.add(-0x7fn << i);
    rawFixtures.add(-0x80n << i);
    rawFixtures.add(-0x81n << i);
  }

  // Programmatic expansion via a deterministic recurrence. The multiplier `99`
  // adds ~6.63 bits per step, so 2000 iterations sweep magnitudes from a few
  // bits up to roughly 13_270 bits (~1659 bytes), with both signs at every
  // step.
  let n = 123n;
  for (let i = 0; i < 2000; i++) {
    n = (n * 99n) + 9876n;
    rawFixtures.add(n);
    rawFixtures.add(-n);
  }
}

/**
 * Formats a `bigint` for use in a test name. Decimals up to 64 bits, hex up to
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

/**
 * Makes a fixture, optionally calculating the encoded form.
 */
function makeFixture(value: bigint, preEncoded?: number[]): Fixture {
  let encoded: Uint8Array;

  if (preEncoded) {
    encoded = new Uint8Array(preEncoded);
  } else {
    encoded = referenceEncode(value);
  }

  return { value, encoded, label: fixtureLabel(value, encoded) };
}

const fixtures: readonly Fixture[] = [...rawFixtures].sort().map((value) =>
  makeFixture(value)
);

// These don't use `referenceEncode()` because these are what's used to test the
// _integrity_ of `referenceEncode()`.
const referenceFixtures: readonly Fixture[] = [
  makeFixture(-129n, [0xff, 0x7f]),
  makeFixture(-128n, [0x80]),
  makeFixture(-1n, [0xff]),
  makeFixture(0n, [0x00]),
  makeFixture(1n, [0x01]),
  makeFixture(127n, [0x7f]),
  makeFixture(255n, [0x00, 0xff]),
  makeFixture(1n << 1n, [0x02]),
  makeFixture(1n << 2n, [0x04]),
  makeFixture(1n << 3n, [0x08]),
  makeFixture(1n << 4n, [0x10]),
  makeFixture(1n << 5n, [0x20]),
  makeFixture(1n << 6n, [0x40]),
  makeFixture(1n << 7n, [0x00, 0x80]),
  makeFixture(1n << 8n, [0x01, 0x00]),
  makeFixture(1n << 9n, [0x02, 0x00]),
  makeFixture(1n << 10n, [0x04, 0x00]),
  makeFixture(1n << 11n, [0x08, 0x00]),
  makeFixture(1n << 12n, [0x10, 0x00]),
  makeFixture(1n << 13n, [0x20, 0x00]),
  makeFixture(1n << 14n, [0x40, 0x00]),
  makeFixture(1n << 15n, [0x00, 0x80, 0x00]),
  makeFixture(1n << 16n, [0x01, 0x00, 0x00]),
  makeFixture(1n << 17n, [0x02, 0x00, 0x00]),
  makeFixture(1n << 63n, [
    0x00,
    0x80,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
  makeFixture(1n << 64n, [
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
  makeFixture(
    0x0123_4567_89ab_cdef_0987_6543_21fe_dcban,
    [
      0x01,
      0x23,
      0x45,
      0x67,
      0x89,
      0xab,
      0xcd,
      0xef,
      0x09,
      0x87,
      0x65,
      0x43,
      0x21,
      0xfe,
      0xdc,
      0xba,
    ],
  ),
];

//
// Tests to validate reference encoder
//

// A small set of explicit byte-level assertions that pin `referenceEncode`
// against the spec. The rest of the suite trusts it as an oracle, so it
// matters that these can't both be wrong in the same way.
describe("`referenceEncode()` (test oracle)", () => {
  it("encodes all reference fixtures as expected", () => {
    for (const { value, encoded, label } of referenceFixtures) {
      try {
        expect(referenceEncode(value)).toEqual(new Uint8Array(encoded));
      } catch (e) {
        throw new Error(`Failed on ${label}.`, { cause: e });
      }
    }
  });
});

//
// Per-function fixture loops
//

for (
  const { biToMtc, biFromMtc, full } of [
    {
      biToMtc: bigintToMinimalTwosComplement,
      biFromMtc: bigintFromMinimalTwosComplement,
      full: false,
    },
    { biToMtc: bigintToMtcDirect, biFromMtc: bigintFromMtcDirect, full: true },
    { biToMtc: bigintToMtcHex, biFromMtc: bigintFromMtcHex, full: true },
  ]
) {
  const FIXTURE_SLICE_SIZE = 1000;
  for (let at = 0; at < fixtures.length; at += FIXTURE_SLICE_SIZE) {
    const slice = full
      ? fixtures.slice(at, at + FIXTURE_SLICE_SIZE)
      : fixtures.slice(at, at + 5);
    const sliceLabel = `fixtures ${at}..${at + slice.length - 1}`;

    describe(`${biToMtc.name}()`, () => {
      it(`correctly encodes ${sliceLabel}`, () => {
        for (let i = 0; i < slice.length; i++) {
          const { value, encoded, label } = slice[i]!;
          try {
            expect(biToMtc(value)).toEqual(encoded);
          } catch (e) {
            throw new Error(`Failed on ${label}.`, { cause: e });
          }
        }
      });
    });

    describe(`${biFromMtc.name}()`, () => {
      it(`correctly decodes ${sliceLabel}`, () => {
        for (let i = 0; i < slice.length; i++) {
          const { value, encoded, label } = slice[i]!;
          try {
            expect(biFromMtc(encoded)).toBe(value);
          } catch (e) {
            throw new Error(`Failed on ${label}.`, { cause: e });
          }
        }
      });
    });

    describe(`${biToMtc.name}()->${biFromMtc.name}() round trip through base64url`, () => {
      it(`correctly round-trips ${sliceLabel}`, () => {
        for (let i = 0; i < slice.length; i++) {
          const { value, label } = slice[i]!;
          const bytes = biToMtc(value);
          const b64 = toUnpaddedBase64url(bytes);
          const decodedBytes = fromBase64url(b64);
          try {
            expect(biFromMtc(decodedBytes)).toBe(value);
          } catch (e) {
            throw new Error(`Failed on ${label}.`, { cause: e });
          }
        }
      });
    });
  }

  //
  // Edge cases
  //

  describe(`${biFromMtc.name}()`, () => {
    it("throws on empty input", () => {
      expect(() => biFromMtc(new Uint8Array([]))).toThrow(
        "empty input",
      );
    });
  });
}
