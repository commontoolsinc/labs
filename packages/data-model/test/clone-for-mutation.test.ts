import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cloneForMutation,
  resetDataModelConfig,
  setDataModelConfig,
} from "../fabric-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";
import { FabricEpochNsec } from "../fabric-epoch.ts";
import { FabricError } from "../fabric-native-instances.ts";

// ============================================================================
// `cloneForMutation` tests
// ============================================================================
//
// Both legacy and modern flag states use modern clone semantics. Test cases are
// parameterized across both modes to ensure the contract is durable under
// either flag setting.

describe("cloneForMutation", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  for (const modernMode of [false, true]) {
    const label = modernMode ? "modern" : "legacy";

    describe(`(${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      // ----------------------------------------------------------------------
      // Empty path: root-only thaw
      // ----------------------------------------------------------------------

      describe("empty path", () => {
        it("returns the root as mutable, plus identical `pathValue`", () => {
          const root = Object.freeze({ a: 1, b: 2 }) as FabricValue;
          const { value, pathValue } = cloneForMutation(root, []);

          expect(value).not.toBe(root);
          expect(Object.isFrozen(value)).toBe(false);
          expect(pathValue).toBe(value);
          expect(value).toEqual({ a: 1, b: 2 });
        });

        it("returns input identity when already mutable + force=false", () => {
          const root = { a: 1 } as FabricValue;
          const { value, pathValue } = cloneForMutation(root, [], {
            force: false,
          });
          expect(value).toBe(root);
          expect(pathValue).toBe(root);
        });

        it("does not touch the input on default options (force defaults to true)", () => {
          // Default `force` is true, matching `cloneIfNecessary`'s default
          // when `frozen: false`. Even with mutable input, the result is a
          // fresh copy.
          const root = { a: 1 } as FabricValue;
          const { value, pathValue } = cloneForMutation(root, []);
          expect(value).not.toBe(root);
          expect(pathValue).toBe(value);
          expect(value).toEqual({ a: 1 });
          expect(Object.isFrozen(value)).toBe(false);
        });

        it("always shallow-clones the root when force=true", () => {
          const root = { a: 1 } as FabricValue;
          const { value, pathValue } = cloneForMutation(root, [], {
            force: true,
          });
          expect(value).not.toBe(root);
          expect(pathValue).toBe(value);
          expect(value).toEqual({ a: 1 });
          expect(Object.isFrozen(value)).toBe(false);
        });

        it("handles an empty-path FabricInstance via shallowClone(false)", () => {
          const err = new FabricError(new Error("test"));
          Object.freeze(err);
          const { value, pathValue } = cloneForMutation(
            err as unknown as FabricValue,
            [],
          );
          expect(value).not.toBe(err);
          expect(value).toBeInstanceOf(FabricError);
          expect(Object.isFrozen(value)).toBe(false);
          expect(pathValue).toBe(value);
          // The wrapped Error reference is shared by `shallowUnfrozenClone`.
          expect((value as unknown as FabricError).error).toBe(err.error);
        });
      });

      // ----------------------------------------------------------------------
      // Single-step paths
      // ----------------------------------------------------------------------

      describe("single-step path", () => {
        it("clones only the spine and exposes the leaf container", () => {
          const inner = Object.freeze({ x: 1 });
          const sibling = Object.freeze({ y: 2 });
          const root = Object.freeze({
            a: inner,
            b: sibling,
          }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["a"]);

          expect(value).not.toBe(root);
          expect(pathValue).toBe(
            (value as unknown as Record<string, unknown>).a,
          );
          expect(pathValue).not.toBe(inner); // had to thaw it
          expect(Object.isFrozen(value)).toBe(false);
          expect(Object.isFrozen(pathValue)).toBe(false);

          // Critical: the sibling subtree is preserved by identity.
          expect((value as unknown as Record<string, unknown>).b).toBe(sibling);
        });

        it("descends into a single-element array", () => {
          const noteA = Object.freeze({ title: "first" });
          const noteB = Object.freeze({ title: "second" });
          const root = Object.freeze({
            notes: Object.freeze([noteA, noteB]),
          }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["notes"]);

          expect(Array.isArray(pathValue)).toBe(true);
          expect((pathValue as unknown as unknown[]).length).toBe(2);

          // The note objects inside the freshly-thawed array are still the
          // original frozen instances -- shallow-thaw shares references.
          expect((pathValue as unknown as unknown[])[0]).toBe(noteA);
          expect((pathValue as unknown as unknown[])[1]).toBe(noteB);

          // The spliced-in array lives inside the new root.
          expect((value as unknown as Record<string, unknown>).notes).toBe(
            pathValue,
          );
        });

        it("returns input root identity when already mutable + force=false", () => {
          const inner = { x: 1 };
          const root = { a: inner } as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["a"], {
            force: false,
          });

          // Already-mutable root reused by identity.
          expect(value).toBe(root);
          // Inner was already mutable too -- reused.
          expect(pathValue).toBe(inner);
        });

        it("does not touch a mutable input on default options", () => {
          // Default `force` is true: input is left alone even when mutable.
          const inner = { x: 1 };
          const root = { a: inner } as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["a"]);

          expect(value).not.toBe(root);
          expect(pathValue).not.toBe(inner);
          // Sibling identity still preserved (would be `b` if present).
        });

        it("always copies the root and leaf when force=true", () => {
          const inner = { x: 1 };
          const root = { a: inner } as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["a"], {
            force: true,
          });

          expect(value).not.toBe(root);
          expect(pathValue).not.toBe(inner);
          // ...but the leaf's children stay shared.
          expect(pathValue).toEqual({ x: 1 });
        });
      });

      // ----------------------------------------------------------------------
      // Deep paths
      // ----------------------------------------------------------------------

      describe("deep paths", () => {
        it("clones every spine container, preserves off-spine identity", () => {
          // Tree shape:
          //   root
          //     ├ a (frozen, on spine)
          //     │   ├ b (frozen, on spine)
          //     │   │   └ c (frozen, on spine -- the target)
          //     │   └ b2 (frozen, OFF spine)
          //     └ a2 (frozen, OFF spine)
          const c = Object.freeze({ leaf: true });
          const b2 = Object.freeze({ off: "spine-b" });
          const b = Object.freeze({ c, b2 });
          const a2 = Object.freeze({ off: "spine-a" });
          const a = Object.freeze({ b, a2 });
          const root = Object.freeze({ a, a2 }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["a", "b", "c"]);

          // Every spine container is freshly cloned (or at minimum,
          // distinct from the input's frozen original).
          expect(value).not.toBe(root);
          const newA = (value as unknown as Record<string, unknown>)
            .a as Record<
              string,
              unknown
            >;
          expect(newA).not.toBe(a);
          const newB = newA.b as Record<string, unknown>;
          expect(newB).not.toBe(b);
          const newC = newB.c;
          expect(newC).toBe(pathValue);
          expect(newC).not.toBe(c);

          // Off-spine subtrees retained by identity:
          //   - root.a2 (sibling of `a`)
          //   - a.b is now newA.b (= newB); but a.a2 (= a2) -- wait, a2 is on
          //     root, not on a. The off-spine peer at depth `a` is `root.a2`.
          //   - The off-spine peer at depth `b` is `a.a2`... no, `a` only has
          //     children `b` and `a2`. So `a2` is off-spine relative to the
          //     descent into `b`.
          expect((value as unknown as Record<string, unknown>).a2).toBe(a2);
          expect(newA.a2).toBe(a2);
          expect(newB.b2).toBe(b2);

          // Spine is mutable, off-spine retains frozenness:
          expect(Object.isFrozen(value)).toBe(false);
          expect(Object.isFrozen(newA)).toBe(false);
          expect(Object.isFrozen(newB)).toBe(false);
          expect(Object.isFrozen(newC)).toBe(false);
          expect(Object.isFrozen(a2)).toBe(true);
          expect(Object.isFrozen(b2)).toBe(true);
        });

        it("descends through arrays as well as objects", () => {
          const target = Object.freeze({ leaf: true });
          const otherNote = Object.freeze({ leaf: false });
          const notes = Object.freeze([otherNote, target]);
          const root = Object.freeze({ notes }) as FabricValue;

          const { value, pathValue } = cloneForMutation(
            root,
            ["notes", "1"],
          );

          const newNotes = (value as unknown as Record<string, unknown>).notes;
          expect(Array.isArray(newNotes)).toBe(true);
          expect(newNotes).not.toBe(notes);
          // Other (off-spine) element preserved by identity.
          expect((newNotes as unknown[])[0]).toBe(otherNote);
          // Target is the freshly-thawed pathValue.
          expect((newNotes as unknown[])[1]).toBe(pathValue);
          expect(pathValue).not.toBe(target);
        });
      });

      // ----------------------------------------------------------------------
      // Deep-frozen cache preservation off-spine
      // ----------------------------------------------------------------------

      describe("deep-frozen cache preservation", () => {
        it("preserves off-spine deep-frozen subtrees in the cache", () => {
          // A deeply-nested off-spine subtree:
          const sibling = deepFreeze({ deep: { nested: [1, 2, 3] } });
          // (Sanity: deepFreeze has cached it.)
          expect(isDeepFrozen(sibling)).toBe(true);

          const target = Object.freeze({ leaf: true });
          const root = deepFreeze({ a: target, b: sibling }) as FabricValue;

          const { value } = cloneForMutation(root, ["a"]);

          // The sibling subtree is preserved by identity AND retains its
          // place in the deep-frozen cache (so future `isDeepFrozen` checks
          // and `cloneIfNecessary` short-circuits stay O(1)).
          expect((value as unknown as Record<string, unknown>).b).toBe(sibling);
          expect(isDeepFrozen(sibling)).toBe(true);
        });
      });

      // ----------------------------------------------------------------------
      // FabricInstance as the leaf at `path`
      // ----------------------------------------------------------------------

      describe("FabricInstance at leaf", () => {
        it("clones via shallowClone(false), not as a plain object", () => {
          const err = new FabricError(new Error("boom"));
          Object.freeze(err);
          const root = Object.freeze({ payload: err }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["payload"]);

          expect(pathValue).toBeInstanceOf(FabricError);
          expect(pathValue).not.toBe(err);
          expect(Object.isFrozen(pathValue)).toBe(false);
          // The wrapped native Error is preserved by identity (shallowClone).
          expect((pathValue as unknown as FabricError).error).toBe(err.error);
          // And spliced into the new spine.
          expect((value as unknown as Record<string, unknown>).payload).toBe(
            pathValue,
          );
        });
      });

      // ----------------------------------------------------------------------
      // Caller mutates `pathValue`, observes effects on `value` only
      // ----------------------------------------------------------------------

      describe("mutation through pathValue", () => {
        it("supports array push without touching the input", () => {
          const notes = Object.freeze([{ id: 1 }, { id: 2 }]);
          const root = Object.freeze({ notes }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, ["notes"]);

          (pathValue as unknown as Array<Record<string, unknown>>).push({
            id: 3,
          });

          expect((value as unknown as Record<string, unknown>).notes).toBe(
            pathValue,
          );
          expect((pathValue as unknown as unknown[]).length).toBe(3);
          // Input is untouched.
          expect(notes.length).toBe(2);
        });

        it("supports object property delete without touching the input", () => {
          const root = Object.freeze({
            keep: 1,
            drop: 2,
          }) as FabricValue;

          const { value, pathValue } = cloneForMutation(root, []);

          delete (pathValue as unknown as Record<string, unknown>).drop;

          expect(value).toEqual({ keep: 1 });
          expect((root as unknown as Record<string, unknown>).drop).toBe(2);
        });

        it("force=true does not touch the input even with mutable input", () => {
          const inner = { x: 1, y: 2 };
          const root = { inner };

          const { value, pathValue } = cloneForMutation(
            root as unknown as FabricValue,
            ["inner"],
            { force: true },
          );

          (pathValue as unknown as Record<string, unknown>).x = 999;

          expect((value as unknown as Record<string, unknown>).inner).toBe(
            pathValue,
          );
          // Input untouched.
          expect(inner.x).toBe(1);
          expect(root.inner).toBe(inner);
        });
      });

      // ----------------------------------------------------------------------
      // Error cases
      // ----------------------------------------------------------------------

      describe("errors", () => {
        it("throws on a missing path segment", () => {
          const root = Object.freeze({ a: { b: 1 } }) as FabricValue;
          expect(() => cloneForMutation(root, ["a", "nonesuch"]))
            .toThrow("missing path segment");
        });

        it("throws on a missing array index", () => {
          const root = Object.freeze({
            notes: Object.freeze([1, 2, 3]),
          }) as FabricValue;
          expect(() => cloneForMutation(root, ["notes", "10"]))
            .toThrow("missing path segment");
        });

        it("throws when descending through a primitive", () => {
          const root = Object.freeze({ x: 42 }) as FabricValue;
          expect(() => cloneForMutation(root, ["x", "anything"]))
            .toThrow("cannot descend into");
        });

        it("throws when descending through a FabricInstance", () => {
          const err = new FabricError(new Error("inside"));
          const root = Object.freeze({ err }) as FabricValue;
          // `path = ["err", "something"]` tries to descend INTO the
          // FabricInstance, which isn't supported.
          expect(() => cloneForMutation(root, ["err", "message"])).toThrow(
            "cannot descend into",
          );
        });

        it("throws when descending through a FabricPrimitive", () => {
          const epoch = new FabricEpochNsec(123n);
          const root = Object.freeze({
            epoch: epoch as unknown as FabricValue,
          }) as FabricValue;
          expect(() => cloneForMutation(root, ["epoch", "anything"]))
            .toThrow("cannot descend into");
        });

        it("throws when the leaf is a primitive (not mutable)", () => {
          const root = Object.freeze({ x: 42 }) as FabricValue;
          expect(() => cloneForMutation(root, ["x"]))
            .toThrow("cannot mutate");
        });

        it("throws when the leaf is a FabricPrimitive (not mutable)", () => {
          const epoch = new FabricEpochNsec(123n);
          const root = Object.freeze({
            epoch: epoch as unknown as FabricValue,
          }) as FabricValue;
          expect(() => cloneForMutation(root, ["epoch"]))
            .toThrow("cannot mutate");
        });

        it("throws on empty-path against a non-mutable root", () => {
          expect(() => cloneForMutation(42 as FabricValue, []))
            .toThrow("cannot mutate");
        });

        it("throws on non-empty path against a non-container root", () => {
          expect(() => cloneForMutation(42 as FabricValue, ["x"]))
            .toThrow("cannot descend into");
        });

        it("throws on non-empty path against a FabricInstance root", () => {
          // A FabricInstance is OK at the leaf but not as the root of a
          // non-empty path (we don't descend into FabricInstance internals).
          const err = new FabricError(new Error("test"));
          expect(() => cloneForMutation(err as unknown as FabricValue, ["x"]))
            .toThrow("cannot descend into");
        });
      });
    });
  }
});
