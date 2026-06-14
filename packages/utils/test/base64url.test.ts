import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fromBase64Polyfill,
  fromBase64url,
  toBase64Polyfill,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";

const TEST_PAIRS: { arr: readonly number[]; b64: string }[] = [
  { arr: [], b64: "" },
  { arr: [0x00], b64: "AA" },
  { arr: [0xff], b64: "_w" },
  { arr: [0x12, 0x34], b64: "EjQ" },
  { arr: [0x98, 0x76, 0x54], b64: "mHZU" },
  { arr: [0x0a, 0x2b, 0x4c, 0x5d], b64: "CitMXQ" },
] as const;

function arrayString(arr: readonly number[]): string {
  const result: string[] = ["["];
  let first = true;
  for (const elem of arr) {
    if (first) {
      first = false;
    } else {
      result.push(", ");
    }
    if (elem < 0x10) {
      result.push("0");
    }
    result.push(elem.toString(16));
  }
  result.push("]");
  return result.join("");
}

// ============================================================================
// toUnpaddedBase64url and polyfill
// ============================================================================

for (const toBase64 of [toUnpaddedBase64url, toBase64Polyfill]) {
  describe(`${toBase64.name}`, () => {
    for (const { arr, b64 } of TEST_PAIRS) {
      const arrStr = arrayString(arr);
      it(`encodes ${arrStr} to "${b64}"`, () => {
        expect(toBase64(new Uint8Array(arr))).toBe(b64);
      });
    }
  });
}

// ============================================================================
// fromBase64url and polyfill
// ============================================================================

for (const fromBase64 of [fromBase64url, fromBase64Polyfill]) {
  describe(`${fromBase64.name}`, () => {
    for (const { arr, b64 } of TEST_PAIRS) {
      const arrStr = arrayString(arr);
      const paddingCount = 2 - ((arr.length + 2) % 3);
      const paddedStr = `${b64}${"=".repeat(paddingCount)}`;
      it(`decodes "${b64}" to ${arrStr}`, () => {
        expect(fromBase64(b64)).toEqual(new Uint8Array(arr));
      });
      if (paddedStr !== b64) {
        it(`decodes "${paddedStr}" to ${arrStr}`, () => {
          expect(fromBase64(paddedStr)).toEqual(new Uint8Array(arr));
        });
      }
    }
  });
}

// ============================================================================
// Base64url round-trip
// ============================================================================

describe("base64url round-trip", () => {
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
      const b64 = toUnpaddedBase64url(bytes);
      const decoded = fromBase64url(b64);
      expect(decoded).toEqual(bytes);
    }
  });
});
