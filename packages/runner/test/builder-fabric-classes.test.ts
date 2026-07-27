import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { createBuilder } from "../src/builder/factory.ts";

// The Fabric value classes reach pattern code as `export declare const`s in
// `api/index.ts`, but the runtime values behind those declarations are bound in
// `builder/factory.ts`. The two sides are maintained separately, so a class can
// be declared without being bound -- which type-checks at pattern-compile time
// and then fails when the pattern actually runs `new ...()`. These tests pin
// the runtime half.
//
// The name list is explicit rather than derived from the declarations in
// `api/index.ts`. Not every declared class is necessarily meant to be
// constructible from pattern code, so enumerating the intended ones keeps this
// test to checking the bindings it knows about.
const PATTERN_CONSTRUCTIBLE_CLASSES = [
  "FabricInstance",
  "FabricPrimitive",
  "FabricEpochNsec",
  "FabricEpochDays",
  "FabricHash",
  "FabricBytes",
];

describe("commonfabric Fabric value classes", () => {
  // Viewed as a plain record on purpose: the question here is what the builder
  // surface carries at runtime, which is exactly the question its static type
  // cannot answer.
  const commonfabric = createBuilder().commonfabric as unknown as Record<
    string,
    unknown
  >;

  describe("runtime bindings", () => {
    for (const name of PATTERN_CONSTRUCTIBLE_CLASSES) {
      it(`exposes \`${name}\` as a function on the pattern surface`, () => {
        expect(typeof commonfabric[name]).toBe("function");
      });
    }
  });

  describe("FabricBytes", () => {
    it("is the `data-model` class itself, not a stand-in", () => {
      expect(commonfabric.FabricBytes).toBe(FabricBytes);
    });

    it("constructs an instance that round-trips its bytes", () => {
      const BoundFabricBytes = commonfabric.FabricBytes as typeof FabricBytes;
      const bytes = new Uint8Array([1, 2, 3, 253, 254, 255]);
      const instance = new BoundFabricBytes(bytes);

      expect(instance).toBeInstanceOf(FabricBytes);
      expect(instance.length).toBe(6);
      expect(instance.slice()).toEqual(bytes);
    });
  });
});
