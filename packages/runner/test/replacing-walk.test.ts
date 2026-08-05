// The walk two conversions share: one replacing cells with the links that
// reach them, one replacing client-side handles with the refs that name them.
// What it owns is the recursion -- ancestor tracking, container rebuilding, and
// the one place a cycle is recognized.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricExecValue } from "@commonfabric/api";

import { type Replacer, replacingWalk } from "../src/replacing-walk.ts";

/**
 * A value the walk accepts but the type cannot describe: a cycle is outside
 * `FabricExecValue`, which is the point of the cases that use this.
 */
function asExecValue(value: unknown): FabricExecValue {
  return value as FabricExecValue;
}

/** Replaces any string beginning with `@` with the rest of it, uppercased. */
const AT_NAMES: Replacer = {
  replace: (value) =>
    typeof value === "string" && value.startsWith("@")
      ? { value: value.slice(1).toUpperCase() }
      : undefined,
  cycle: (_value, path) => ({ cycleAt: [...path] }),
};

describe("replacing-walk", () => {
  describe("replacement", () => {
    it("replaces a value at the root", () => {
      expect(replacingWalk("@a", AT_NAMES)).toBe("A");
    });

    it("replaces values at every depth", () => {
      expect(replacingWalk({ x: ["@a", { y: "@b" }], z: "plain" }, AT_NAMES))
        .toEqual({ x: ["A", { y: "B" }], z: "plain" });
    });

    it("does not descend into what a replacement returns", () => {
      const replacer: Replacer = {
        ...AT_NAMES,
        replace: (value) =>
          value === "seed" ? { value: { nested: "@a" } } : undefined,
      };
      // `@a` sits inside the replacement, so a walk that descended into it
      // would have uppercased it.
      expect(replacingWalk("seed", replacer)).toEqual({ nested: "@a" });
    });

    it("passes a value no replacement claims through unchanged", () => {
      expect(replacingWalk(7, AT_NAMES)).toBe(7);
      expect(replacingWalk(null, AT_NAMES)).toBe(null);
      expect(replacingWalk(undefined, AT_NAMES)).toBe(undefined);
    });

    it("lets a replacement refuse a value by throwing", () => {
      const replacer: Replacer = {
        ...AT_NAMES,
        replace: (value) => {
          if (typeof value === "number") throw new Error("no numbers");
          return undefined;
        },
      };
      expect(() => replacingWalk({ a: 1 }, replacer)).toThrow("no numbers");
    });
  });

  describe("cycles and sharing", () => {
    it("returns the cycle stand-in for a value it is already inside", () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(replacingWalk(asExecValue(cyclic), AT_NAMES)).toEqual({
        a: 1,
        self: { cycleAt: [] },
      });
    });

    it("returns a cycle stand-in naming the path it points back to", () => {
      const inner: Record<string, unknown> = { name: "inner" };
      inner.back = inner;
      expect(replacingWalk(asExecValue({ outer: { inner } }), AT_NAMES))
        .toEqual({
          outer: {
            inner: { name: "inner", back: { cycleAt: ["outer", "inner"] } },
          },
        });
    });

    it("walks a twice-reachable value at both of its positions", () => {
      // Shared, not circular: neither position is inside the other.
      const shared = { n: "@a" };
      expect(replacingWalk({ x: shared, y: shared }, AT_NAMES))
        .toEqual({ x: { n: "A" }, y: { n: "A" } });
    });

    it("walks a value shared between siblings after a deep subtree", () => {
      // Pins that the ancestor is cleared on the way back out: `shared` is no
      // longer an ancestor by the time `later` is reached.
      const shared = { n: "@a" };
      expect(
        replacingWalk({ deep: { a: { b: shared } }, later: shared }, AT_NAMES),
      ).toEqual({ deep: { a: { b: { n: "A" } } }, later: { n: "A" } });
    });
  });

  describe("entering a container", () => {
    it("descends into what `enter` returns", () => {
      const replacer: Replacer = {
        ...AT_NAMES,
        enter: (value) => ({ into: { ...value as object, added: "@b" } }),
      };
      expect(replacingWalk({ kept: "@a" }, replacer))
        .toEqual({ kept: "A", added: "B" });
    });

    it("stops at a container `enter` returns a value for", () => {
      const replacer: Replacer = {
        ...AT_NAMES,
        enter: (value) =>
          Array.isArray(value) ? { value: "flattened" } : { into: value },
      };
      expect(replacingWalk({ list: ["@a"] }, replacer))
        .toEqual({ list: "flattened" });
    });

    it("clears the ancestor even when `enter` stops the descent", () => {
      const shared: FabricExecValue[] = ["@a"];
      const replacer: Replacer = {
        ...AT_NAMES,
        enter: (value) =>
          Array.isArray(value) ? { value: "flattened" } : { into: value },
      };
      // The second position must not be treated as a cycle.
      expect(replacingWalk({ x: shared, y: shared }, replacer))
        .toEqual({ x: "flattened", y: "flattened" });
    });

    it("clears the ancestor even when `enter` throws", () => {
      const shared = { boom: true };
      let thrown = 0;
      const replacer: Replacer = {
        ...AT_NAMES,
        enter: (value) => {
          if (value === shared && thrown++ === 0) throw new Error("first only");
          return { into: value };
        },
      };
      expect(() => replacingWalk({ x: shared }, replacer))
        .toThrow("first only");
      // A leaked ancestor would make this second, independent walk see a cycle.
      expect(replacingWalk({ x: shared }, replacer)).toEqual({
        x: { boom: true },
      });
    });
  });
});
