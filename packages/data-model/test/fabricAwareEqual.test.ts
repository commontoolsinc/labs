/**
 * The comparison for an operand that is allowed to hold a `FabricValue`
 * without being known to be one.
 *
 * Two things are being pinned, and they pull in opposite directions. Every
 * fabric special object must be decided by content, wherever it sits, because
 * a property walk sees no content on one and calls every two of the same class
 * equal. And every value the data model does not own must still be decided the
 * way `deepEqual()` decides it, because these operands carry those too and
 * `valueEqual()` refuses them.
 *
 * The nesting cases are the ones that matter most: a comparison that only
 * checked its arguments would pass a fabric value hidden one key down straight
 * to the property walk that conflates it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricAwareEqual } from "@/index.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";

/** Fixed `FabricError` state, so two built the same way agree in every slot. */
const errorState = (message: string) => ({
  type: "Error",
  name: "Error",
  message,
  stack: undefined,
  cause: undefined,
});

/**
 * A distinct-but-equal pair of each special-object kind, plus a third value of
 * the same kind that differs. The pairs are built fresh per case so no case
 * can pass on reference identity.
 */
const SPECIAL_OBJECT_KINDS: readonly {
  name: string;
  make: () => unknown;
  makeEqual: () => unknown;
  makeDifferent: () => unknown;
}[] = [
  {
    name: "FabricBytes",
    make: () => new FabricBytes(new Uint8Array([1, 2, 3])),
    makeEqual: () => new FabricBytes(new Uint8Array([1, 2, 3])),
    makeDifferent: () => new FabricBytes(new Uint8Array([1, 2, 4])),
  },
  {
    name: "FabricEpochNsec",
    make: () => new FabricEpochNsec(1_700_000_000_000_000_000n),
    makeEqual: () => new FabricEpochNsec(1_700_000_000_000_000_000n),
    makeDifferent: () => new FabricEpochNsec(1_700_000_000_000_000_001n),
  },
  {
    name: "FabricEpochDay",
    make: () => new FabricEpochDay(20_000n),
    makeEqual: () => new FabricEpochDay(20_000n),
    makeDifferent: () => new FabricEpochDay(20_001n),
  },
  {
    name: "FabricRegExp",
    make: () => new FabricRegExp("es2025", "a+", "g"),
    makeEqual: () => new FabricRegExp("es2025", "a+", "g"),
    makeDifferent: () => new FabricRegExp("es2025", "b+", "g"),
  },
  {
    name: "FabricHash",
    make: () => new FabricHash(new Uint8Array([9, 9]), "fid1"),
    makeEqual: () => new FabricHash(new Uint8Array([9, 9]), "fid1"),
    makeDifferent: () => new FabricHash(new Uint8Array([9, 8]), "fid1"),
  },
  {
    // Built from explicit state rather than from a thrown `Error`, whose
    // captured stack differs per construction site and would make two
    // otherwise-identical errors unequal for a reason unrelated to this.
    name: "FabricError",
    make: () => new FabricError(errorState("boom")),
    makeEqual: () => new FabricError(errorState("boom")),
    makeDifferent: () => new FabricError(errorState("other")),
  },
  {
    name: "FabricLink",
    make: () => new FabricLink({ id: "of:fid1:aaa" }),
    makeEqual: () => new FabricLink({ id: "of:fid1:aaa" }),
    makeDifferent: () => new FabricLink({ id: "of:fid1:bbb" }),
  },
];

describe("fabricAwareEqual()", () => {
  describe("given a bare special object of each kind", () => {
    for (const kind of SPECIAL_OBJECT_KINDS) {
      it(`compares a \`${kind.name}\` by content`, () => {
        expect(fabricAwareEqual(kind.make(), kind.makeEqual())).toBe(true);
        expect(fabricAwareEqual(kind.make(), kind.makeDifferent()))
          .toBe(false);
      });
    }
  });

  describe("given a special object nested inside a container", () => {
    for (const kind of SPECIAL_OBJECT_KINDS) {
      it(`compares a \`${kind.name}\` under a record key by content`, () => {
        expect(
          fabricAwareEqual({ v: kind.make() }, { v: kind.makeEqual() }),
        ).toBe(true);
        expect(
          fabricAwareEqual({ v: kind.make() }, { v: kind.makeDifferent() }),
        ).toBe(false);
      });

      it(`compares a \`${kind.name}\` at an array index by content`, () => {
        expect(fabricAwareEqual([kind.make()], [kind.makeEqual()]))
          .toBe(true);
        expect(fabricAwareEqual([kind.make()], [kind.makeDifferent()]))
          .toBe(false);
      });

      it(`compares a \`${kind.name}\` several levels down by content`, () => {
        const nest = (leaf: unknown) => ({ a: [{ b: { c: leaf } }] });
        expect(fabricAwareEqual(nest(kind.make()), nest(kind.makeEqual())))
          .toBe(true);
        expect(
          fabricAwareEqual(nest(kind.make()), nest(kind.makeDifferent())),
        ).toBe(false);
      });
    }
  });

  describe("given a special object whose codec is still a stub", () => {
    // `FabricMap` and `FabricSet` cannot be hashed, so their content equality
    // has no answer to give and `valueEqual()` says so by throwing. Reaching
    // that throw is the point: it names the class that owes the work, where
    // the property walk would have called every two of them equal and said
    // nothing. Do not soften this to a `catch`.
    it("throws for two `FabricMap`s rather than calling them equal", () => {
      expect(() =>
        fabricAwareEqual(
          new FabricMap(new Map([["a", 1]])),
          new FabricMap(new Map([["a", 2]])),
        )
      ).toThrow("not yet implemented");
    });

    it("throws for two `FabricSet`s rather than calling them equal", () => {
      expect(() =>
        fabricAwareEqual(
          new FabricSet(new Set([1])),
          new FabricSet(new Set([2])),
        )
      ).toThrow("not yet implemented");
    });

    it("throws for one nested under a record key too", () => {
      expect(() =>
        fabricAwareEqual(
          { v: new FabricSet(new Set([1])) },
          { v: new FabricSet(new Set([2])) },
        )
      ).toThrow("not yet implemented");
    });
  });

  describe("given a special object against something else", () => {
    it("answers `false` against a plain record", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, {})).toBe(false);
      expect(fabricAwareEqual({}, bytes)).toBe(false);
    });

    it("answers `false` against an array", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, [])).toBe(false);
      expect(fabricAwareEqual([], bytes)).toBe(false);
    });

    it("answers `false` against a special object of another class", () => {
      expect(
        fabricAwareEqual(
          new FabricBytes(new Uint8Array([1])),
          new FabricEpochNsec(1n),
        ),
      ).toBe(false);
    });

    it("answers `false` against a scalar", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, 1)).toBe(false);
      expect(fabricAwareEqual(bytes, null)).toBe(false);
      expect(fabricAwareEqual(bytes, undefined)).toBe(false);
    });

    it("answers `false` against a non-fabric class instance, without throwing", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, new Date(0))).toBe(false);
      expect(fabricAwareEqual(new Date(0), bytes)).toBe(false);
    });
  });

  describe("given values the data model does not own", () => {
    it("compares scalars the way `deepEqual()` does", () => {
      expect(fabricAwareEqual(1, 1)).toBe(true);
      expect(fabricAwareEqual("a", "a")).toBe(true);
      expect(fabricAwareEqual(NaN, NaN)).toBe(true);
      expect(fabricAwareEqual(0, -0)).toBe(false);
      expect(fabricAwareEqual(1, "1")).toBe(false);
    });

    it("compares plain containers structurally", () => {
      expect(fabricAwareEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }))
        .toBe(true);
      expect(fabricAwareEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }))
        .toBe(false);
      expect(fabricAwareEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it("compares a non-fabric class instance by its own properties", () => {
      class Point {
        constructor(readonly x: number) {}
      }
      expect(fabricAwareEqual(new Point(1), new Point(1))).toBe(true);
      expect(fabricAwareEqual(new Point(1), new Point(2))).toBe(false);
    });

    it("compares a `Date` the way `deepEqual()` does, not by its time", () => {
      // A `Date` carries no own properties, so the property walk calls any two
      // equal. `fabricAwareEqual()` widens `deepEqual()` for fabric values
      // only, and this pins that it does not quietly widen further.
      expect(fabricAwareEqual(new Date(0), new Date(1))).toBe(true);
    });
  });
});
