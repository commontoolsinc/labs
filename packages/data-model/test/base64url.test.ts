import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url, toUnpaddedBase64url } from "../base64url.ts";

// ============================================================================
// toUnpaddedBase64url
// ============================================================================

describe("toUnpaddedBase64url", () => {
  it("encodes empty bytes to empty string", () => {
    expect(toUnpaddedBase64url(new Uint8Array([]))).toBe("");
  });

  it("encodes [0x00] to 'AA'", () => {
    expect(toUnpaddedBase64url(new Uint8Array([0x00]))).toBe("AA");
  });

  it("encodes [0xFF] to '_w'", () => {
    expect(toUnpaddedBase64url(new Uint8Array([0xff]))).toBe("_w");
  });

  it("encodes 3-byte input (no padding case)", () => {
    // 3 bytes -> 4 base64url chars (exact, no padding)
    const b64 = toUnpaddedBase64url(new Uint8Array([0x01, 0x02, 0x03]));
    expect(b64.length).toBe(4);
    expect(b64).not.toContain("=");
  });

  it("never produces padding characters", () => {
    // Test various lengths (1, 2, 3, 4, 5 bytes)
    for (let len = 1; len <= 5; len++) {
      const bytes = new Uint8Array(len);
      bytes.fill(0x42);
      const b64 = toUnpaddedBase64url(bytes);
      expect(b64).not.toContain("=");
    }
  });
});

// ============================================================================
// fromBase64url
// ============================================================================

describe("fromBase64url", () => {
  it("decodes empty string to empty bytes", () => {
    expect(fromBase64url("")).toEqual(new Uint8Array([]));
  });

  it("decodes 'AA' to [0x00]", () => {
    expect(fromBase64url("AA")).toEqual(new Uint8Array([0x00]));
  });

  it("decodes '_w' to [0xFF]", () => {
    expect(fromBase64url("_w")).toEqual(new Uint8Array([0xff]));
  });

  it("accepts padded input ('AA==')", () => {
    expect(fromBase64url("AA==")).toEqual(new Uint8Array([0x00]));
  });

  it("accepts padded input ('_w==')", () => {
    expect(fromBase64url("_w==")).toEqual(new Uint8Array([0xff]));
  });
});

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
