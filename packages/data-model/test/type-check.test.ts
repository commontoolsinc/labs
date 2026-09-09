import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isFabricArray,
  isFabricContainerValue,
  isFabricPlainObject,
} from "@/type-check.ts";
import type { FabricValue } from "@/interface.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { toCompactDebugString } from "@/value-debug.ts";

const EXAMPLE_FABRIC_BYTES = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));

const EXAMPLE_FABRIC_EPOCH_NSEC = new FabricEpochNsec(12345n);

describe("type-check", () => {
  describe("isFabricContainerValue()", () => {
    describe("given a container arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricContainerValue({})).toBe(true);
        expect(isFabricContainerValue({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isFabricContainerValue([])).toBe(true);
        expect(isFabricContainerValue([1, 2, 3])).toBe(true);
      });

      it("returns `true` for a `FabricInstance`", () => {
        expect(
          isFabricContainerValue(FabricError.fromNativeError(new Error("x"))),
        )
          .toBe(true);
      });
    });

    describe("given a non-container `FabricValue`", () => {
      it("returns `false` for a `FabricPrimitive`", () => {
        // The whole of the difference from `isFabricObjectOrArray()`, which
        // accepts these: a `FabricPrimitive` self-freezes at construction and
        // exposes no `FabricValue` for a walk to descend into, whatever it
        // holds privately.

        expect(isFabricContainerValue(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricContainerValue(new FabricEpochNsec(1n))).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricContainerValue(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricContainerValue(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isFabricContainerValue(1)).toBe(false);
        expect(isFabricContainerValue("a")).toBe(false);
        expect(isFabricContainerValue(true)).toBe(false);
        expect(isFabricContainerValue(42n)).toBe(false);
      });
    });
  });

  describe("isFabricArray()", () => {
    it("returns `true` given a `FabricArray`", () => {
      expect(isFabricArray([])).toBe(true);
      expect(isFabricArray([1])).toBe(true);
      expect(isFabricArray([{ a: "foo" }])).toBe(true);
    });

    it("returns `false` given a type-lie value", () => {
      const wrongTypeValue = new Set() as unknown as FabricValue;
      expect(isFabricArray(wrongTypeValue)).toBe(false);
    });

    for (
      const value of [
        123,
        "boop",
        { z: "zorp" },
        EXAMPLE_FABRIC_EPOCH_NSEC,
        EXAMPLE_FABRIC_BYTES,
      ]
    ) {
      const desc = toCompactDebugString(value);
      it(`returns \`false\` given ${desc}`, () => {
        expect(isFabricArray(value)).toBe(false);
      });
    }
  });

  describe("isFabricPlainObject()", () => {
    describe("given the plain-record arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricPlainObject({})).toBe(true);
        expect(isFabricPlainObject({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, never>;
        expect(isFabricPlainObject(obj)).toBe(true);
      });
    });

    describe("given a non-record `FabricValue`", () => {
      it("returns `false` for an array", () => {
        expect(isFabricPlainObject([])).toBe(false);
        expect(isFabricPlainObject([1, 2, 3])).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricPlainObject(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricPlainObject(undefined)).toBe(false);
      });

      it("returns `false` for a primitive", () => {
        expect(isFabricPlainObject(1)).toBe(false);
        expect(isFabricPlainObject("a")).toBe(false);
        expect(isFabricPlainObject(true)).toBe(false);
        expect(isFabricPlainObject(42n)).toBe(false);
      });

      it("returns `false` for a `FabricSpecialObject`", () => {
        expect(isFabricPlainObject(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricPlainObject(FabricError.fromNativeError(new Error("x"))))
          .toBe(false);
      });

      it("returns `false` for a non-plain class instance (`Date`, `Map`, …)", () => {
        // Not representable as a `FabricPlainObject`, and reachable only via
        // an unsound cast, so the guard is fed them as `unknown`.

        expect(isFabricPlainObject(new Date() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(new Map() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(/regex/ as unknown as FabricValue))
          .toBe(false);
      });
    });
  });
});
