import { expect } from "@std/expect";
import {
  CFC_CANONICAL_ALIAS_NAMES,
  type FetchBinaryResult,
} from "@commonfabric/api";

// The api package is the public type surface for `commonfabric`. Most of it is
// ambient type and `declare const` material with no runtime footprint, but the
// module itself still evaluates its concrete re-exports when imported. Loading
// it here exercises that evaluation and pins the new fetch result surface.
Deno.test("api module loads and re-exports the CFC canonical alias names", () => {
  expect(Array.isArray(CFC_CANONICAL_ALIAS_NAMES)).toBe(true);
  expect(CFC_CANONICAL_ALIAS_NAMES.length).toBeGreaterThan(0);
  for (const name of CFC_CANONICAL_ALIAS_NAMES) {
    expect(typeof name).toBe("string");
  }
});

Deno.test("FetchBinaryResult describes bytes plus a media type", () => {
  type FetchBinaryResultSample = {
    bytes: Pick<FetchBinaryResult["bytes"], "length">;
    mediaType: FetchBinaryResult["mediaType"];
  };

  const sample: FetchBinaryResultSample = {
    bytes: { length: 3 },
    mediaType: "image/png",
  };
  expect(sample.mediaType).toBe("image/png");
  expect(sample.bytes.length).toBe(3);
});
