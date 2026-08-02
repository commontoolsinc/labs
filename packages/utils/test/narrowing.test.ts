import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isArrayWithOnlyIndexProperties,
  isInertArray,
} from "@commonfabric/utils/arrays";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import { isPlainObject, type ReadonlyRecord } from "@commonfabric/utils/types";

/**
 * The narrowing contract of the structural predicates, as described in the
 * header of the `types` module. These are compile-time assertions: the `test`
 * task runs with `--no-check`, so it is `deno task check` that enforces them.
 * The runtime bodies exist so the assertions sit on values that a reader can
 * see are of the stated kind, and so the file is not silently inert.
 */
describe("structural predicate narrowing", () => {
  describe("narrows an `unknown` caller, which has nothing to lose", () => {
    it("narrows `unknown` to an array", () => {
      const value: unknown = [1, 2, 3];

      if (isInertArray(value)) {
        // Reachable only if `value` narrowed; no cast in sight.
        expect(value.length).toBe(3);
      } else {
        throw new Error("Expected an inert array.");
      }
    });

    it("narrows `unknown` to a record", () => {
      const value: unknown = { a: 1 };

      if (isInertPlainObject(value)) {
        expect(Object.keys(value)).toEqual(["a"]);
      } else {
        throw new Error("Expected an inert plain object.");
      }
    });

    it("narrows `unknown` for the weaker two predicates as well", () => {
      const array: unknown = [1];
      const object: unknown = { a: 1 };

      if (isArrayWithOnlyIndexProperties(array)) {
        expect(array.length).toBe(1);
      } else {
        throw new Error("Expected an index-only array.");
      }

      if (isPlainObject(object)) {
        expect(Object.keys(object)).toEqual(["a"]);
      } else {
        throw new Error("Expected a plain object.");
      }
    });
  });

  describe("leaves the `false` branch usable for a caller that already knows the shape", () => {
    // The point of the overload pair. Were these predicates declared with the
    // narrowing signature alone, `false`-branch subtraction would reduce each
    // of these values to `never`, on the strength of a rejection whose reason
    // the type system never recorded.

    it("keeps an array usable after a `false` result", () => {
      const array: number[] = [1, 2, 3];
      Object.defineProperty(array, 1, { get: () => 2 });

      if (isInertArray(array)) {
        throw new Error("Expected an accessor-backed index to be rejected.");
      }

      // `array` is still `number[]` here, not `never`.
      expect(array.length).toBe(3);
      expect(array[0]!.toFixed(1)).toBe("1.0");
    });

    it("keeps a record usable after a `false` result", () => {
      const record: Record<string, unknown> = Object.create(null);
      record.a = 1;

      if (isInertPlainObject(record)) {
        throw new Error("Expected a null-prototype object to be rejected.");
      }

      // `record` is still `Record<string, unknown>` here, not `never`.
      expect(Object.keys(record)).toEqual(["a"]);
    });

    it("keeps a record usable after a `false` result from `isPlainObject()`", () => {
      // A record-typed value that is not `Object`-rooted. TypeScript has no way
      // to say that about a type, which is precisely why the `false` branch has
      // to stay usable.
      const record: ReadonlyRecord = Object.create({ inherited: 1 });

      if (isPlainObject(record)) {
        throw new Error("Expected a non-`Object`-rooted value to be rejected.");
      }

      expect(Object.keys(record)).toEqual([]);
    });
  });

  describe("never hands back a mutable view of a `readonly` value", () => {
    // These assert assignability rather than performing a write: the values are
    // frozen, so an actual assignment would throw at runtime under module
    // strict mode and prove nothing about the type.

    it("preserves `readonly` on a value that arrived `readonly`", () => {
      const frozen: readonly number[] = Object.freeze([1, 2, 3]);

      if (!isInertArray(frozen)) {
        throw new Error("Expected a frozen array to be inert.");
      }

      // @ts-expect-error `readonly` survives the check; it is not widened.
      const _widened: number[] = frozen;

      expect(frozen[0]).toBe(1);
    });

    it("narrows `unknown` to a read-only array, not a mutable one", () => {
      const value: unknown = Object.freeze([1]);

      if (!isInertArray(value)) {
        throw new Error("Expected a frozen array to be inert.");
      }

      // @ts-expect-error The narrowed type confers read access, not write.
      const _widened: unknown[] = value;

      expect(value[0]).toBe(1);
    });
  });
});
