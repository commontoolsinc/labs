import { expect } from "@std/expect";
import {
  CFC_CANONICAL_ALIAS_NAMES,
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  type FabricBytes,
  type FetchBinaryResult,
  isFabricPrimitiveSchemaType,
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

Deno.test("isFabricPrimitiveSchemaType accepts exactly the fabric-primitive vocabulary", () => {
  expect(FABRIC_PRIMITIVE_SCHEMA_TYPES.length).toBeGreaterThan(0);
  for (const name of FABRIC_PRIMITIVE_SCHEMA_TYPES) {
    expect(isFabricPrimitiveSchemaType(name)).toBe(true);
  }
  // The standard vocabulary and arbitrary names stay outside the predicate.
  expect(isFabricPrimitiveSchemaType("object")).toBe(false);
  expect(isFabricPrimitiveSchemaType("integer")).toBe(false);
  expect(isFabricPrimitiveSchemaType("FabricNope")).toBe(false);
});

Deno.test("FetchBinaryResult describes bytes plus a media type", () => {
  // Type-level pin for the fetchBinary result shape: a FabricBytes buffer and a
  // media-type string. Constructed structurally so the assertion runs without a
  // real FabricBytes instance (the constructor lives in the runtime, not here).
  const sample: FetchBinaryResult = {
    bytes: { length: 3 } as unknown as FabricBytes,
    mediaType: "image/png",
  };
  expect(sample.mediaType).toBe("image/png");
  expect(sample.bytes.length).toBe(3);
});
