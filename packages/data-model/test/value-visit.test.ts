import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import {
  type FabricArray,
  type FabricContainerValue,
  type FabricInstance,
  type FabricPlainObject,
  type FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";
import {
  type BaselineVisitResult,
  ContainerIteratingVisitor,
  type DispatchingVisitorResult,
  DO_RECURSE_KEYS,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  DO_VISIT_SUBTYPE,
  EmptyValueVisitor,
  type LeafVisitorResult,
  makeVisitFabricValueFunction,
  makeVisitValueFunction,
  type RecurseForm,
  type ValueVisitor,
  visitFabricValue,
  visitValue,
} from "@/value-visit.ts";
import type { Primitive } from "@commonfabric/utils/types";

/** One recorded call into a `Recorder`. */
type Event = [name: string, ...args: unknown[]];

/**
 * Visitor that dispatches every value to its subtype method, recurses into
 * containers the way `ContainerIteratingVisitor` does by default, and records
 * each call it receives. Each hook can be overridden per test by assigning the
 * matching `on*` property.
 */
class Recorder extends ContainerIteratingVisitor<unknown, unknown> {
  readonly events: Event[] = [];

  onValue?: (value: unknown) => DispatchingVisitorResult<unknown, unknown>;
  onCycle?: (
    value: unknown,
    originalDepth: number,
    thisDepth: number,
  ) => LeafVisitorResult<unknown, unknown>;
  onArray?: (value: FabricArray) => LeafVisitorResult<unknown, unknown>;
  onPlainObject?: (
    value: FabricPlainObject,
  ) => LeafVisitorResult<unknown, unknown>;
  onInstance?: (value: FabricInstance) => LeafVisitorResult<unknown, unknown>;
  onPrimitive?: (
    value: unknown,
    tag: PrimitiveValueTag,
  ) => LeafVisitorResult<unknown, unknown>;
  onNonFabric?: (value: unknown) => LeafVisitorResult<unknown, unknown>;
  onVisitedElement?: (
    index: number,
    value: unknown,
  ) => BaselineVisitResult<unknown>;
  onVisitedGap?: (start: number, count: number) => BaselineVisitResult<unknown>;
  onVisitedMapping?: (
    key: unknown,
    value: unknown,
  ) => BaselineVisitResult<unknown>;

  /** The names of the recorded calls, in order. */
  get names(): string[] {
    return this.events.map((e) => e[0]);
  }

  override visitValue(
    value: unknown,
  ): DispatchingVisitorResult<unknown, unknown> {
    this.events.push(["value", value]);
    return this.onValue ? this.onValue(value) : DO_VISIT_SUBTYPE;
  }

  override visitCycle(
    value: unknown,
    originalDepth: number,
    thisDepth: number,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["cycle", value, originalDepth, thisDepth]);
    return this.onCycle
      ? this.onCycle(value, originalDepth, thisDepth)
      : undefined;
  }

  override visitFabricContainer(
    value: FabricContainerValue,
  ): DispatchingVisitorResult<unknown, unknown> {
    this.events.push(["container", value]);
    return DO_VISIT_SUBTYPE;
  }

  override visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["array", value]);
    return this.onArray ? this.onArray(value) : super.visitFabricArray(value);
  }

  override visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["object", value]);
    return this.onPlainObject
      ? this.onPlainObject(value)
      : super.visitFabricPlainObject(value);
  }

  override visitFabricInstance(
    value: FabricInstance,
  ): LeafVisitorResult<unknown, unknown> {
    // Unlike the other container hooks, this one does not defer to the
    // superclass by default: the engine cannot yet iterate an instance, so
    // the default here is to stop.
    this.events.push(["instance", value]);
    return this.onInstance ? this.onInstance(value) : undefined;
  }

  override visitPrimitive(
    value: Primitive | FabricPrimitive,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["primitive", value, tag]);
    return this.onPrimitive ? this.onPrimitive(value, tag) : undefined;
  }

  override visitNonFabricValue(
    value: unknown,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["nonFabric", value]);
    return this.onNonFabric ? this.onNonFabric(value) : undefined;
  }

  override visitedArrayElement(
    array: FabricArray,
    index: number,
    value: unknown,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedElement", array, index, value]);
    return this.onVisitedElement
      ? this.onVisitedElement(index, value)
      : undefined;
  }

  override visitedArrayGap(
    array: FabricArray,
    start: number,
    count: number,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedGap", array, start, count]);
    return this.onVisitedGap ? this.onVisitedGap(start, count) : undefined;
  }

  override visitedMapping(
    container: FabricPlainObject | FabricInstance,
    key: unknown,
    value: unknown,
  ): BaselineVisitResult<unknown> {
    this.events.push(["visitedMapping", container, key, value]);
    return this.onVisitedMapping
      ? this.onVisitedMapping(key, value)
      : undefined;
  }
}

/** Returns a `mainResult` form carrying the given value. */
function mainResult<T>(value: T): { type: "mainResult"; value: T } {
  return { type: "mainResult", value };
}

/** Returns a `replace` form carrying the given value. */
function replace<T>(value: T): { type: "replace"; value: T } {
  return { type: "replace", value };
}

/** Returns a plain-object chain of the given depth ending in `leaf`. */
function chain(depth: number, leaf: unknown): unknown {
  let result = leaf;
  for (let i = 0; i < depth; i++) {
    result = { child: result };
  }
  return result;
}

describe("value-visit", () => {
  describe("the `DO_*` constants", () => {
    const recurseCases: [string, RecurseForm, boolean, boolean][] = [
      ["DO_RECURSE_KEYS_VALUES", DO_RECURSE_KEYS_VALUES, true, true],
      ["DO_RECURSE_KEYS", DO_RECURSE_KEYS, true, false],
      ["DO_RECURSE_VALUES", DO_RECURSE_VALUES, false, true],
    ];

    for (const [name, form, doKeys, doValues] of recurseCases) {
      it(`makes \`${name}\` a frozen \`recurse\` form with \`doKeys\` ${doKeys} and \`doValues\` ${doValues}`, () => {
        expect(Object.isFrozen(form)).toBe(true);
        expect(form).toEqual({ type: "recurse", doKeys, doValues });
      });
    }

    it("makes `DO_VISIT_SUBTYPE` a frozen `visitSubtype` form", () => {
      expect(Object.isFrozen(DO_VISIT_SUBTYPE)).toBe(true);
      expect(DO_VISIT_SUBTYPE).toEqual({ type: "visitSubtype" });
    });
  });

  describe("BaseValueVisitor", () => {
    describe("throwNoCycles()", () => {
      it("throws an error naming the value", () => {
        class NoCycles extends Recorder {
          override visitCycle(value: unknown): never {
            return this.throwNoCycles(value);
          }
        }

        const value: Record<string, unknown> = {};
        value.self = value;

        expect(() => visitValue(value, new NoCycles())).toThrow(
          /Cannot visit cyclic value: /,
        );
      });
    });

    describe("throwShouldntCall()", () => {
      it("throws an error naming the method and the visitor", () => {
        class Refusing extends Recorder {
          override visitPrimitive(): never {
            return this.throwShouldntCall("visitPrimitive");
          }
        }

        expect(() => visitValue(1, new Refusing())).toThrow(
          /Shouldn't happen: `visitPrimitive\(\)` called on `.*Refusing/,
        );
      });
    });
  });

  describe("EmptyValueVisitor", () => {
    it("returns `undefined` from every visitor method", () => {
      const vis = new EmptyValueVisitor<unknown, unknown>();
      const instance = new FabricMap(new Map());

      expect(vis.visitCycle(1, 0, 1)).toBeUndefined();
      expect(vis.visitFabricArray([])).toBeUndefined();
      expect(vis.visitFabricContainer([])).toBeUndefined();
      expect(vis.visitFabricInstance(instance)).toBeUndefined();
      expect(vis.visitFabricPlainObject({})).toBeUndefined();
      expect(vis.visitNonFabricValue(new Date(0))).toBeUndefined();
      expect(vis.visitPrimitive(1, "number")).toBeUndefined();
      expect(vis.visitValue(1)).toBeUndefined();
      expect(vis.visitedArrayElement([1], 0, 1)).toBeUndefined();
      expect(vis.visitedArrayGap([], 0, 1)).toBeUndefined();
      expect(vis.visitedMapping({}, "k", 1)).toBeUndefined();
    });

    it("completes a visit of a nested value without descending", () => {
      class Counting extends EmptyValueVisitor<never, number> {
        calls = 0;
        override visitValue(): DispatchingVisitorResult<never, number> {
          this.calls++;
          return undefined;
        }
      }

      const vis = new Counting();

      expect(visitValue({ a: [1, 2] }, vis)).toBeUndefined();
      expect(vis.calls).toBe(1);
    });
  });

  describe("ContainerIteratingVisitor", () => {
    class Iterating extends ContainerIteratingVisitor<never, never> {
      override visitCycle(): LeafVisitorResult<never, never> {
        return undefined;
      }
      override visitNonFabricValue(): LeafVisitorResult<never, never> {
        return undefined;
      }
      override visitPrimitive(): LeafVisitorResult<never, never> {
        return undefined;
      }
      override visitValue(): DispatchingVisitorResult<never, never> {
        return undefined;
      }
    }

    it("returns `DO_VISIT_SUBTYPE` from `visitFabricContainer()`", () => {
      expect(new Iterating().visitFabricContainer([])).toBe(DO_VISIT_SUBTYPE);
    });

    it("returns `DO_RECURSE_VALUES` from `visitFabricArray()`", () => {
      expect(new Iterating().visitFabricArray([1])).toBe(DO_RECURSE_VALUES);
    });

    it("returns `DO_RECURSE_VALUES` from `visitFabricPlainObject()`", () => {
      expect(new Iterating().visitFabricPlainObject({ a: 1 })).toBe(
        DO_RECURSE_VALUES,
      );
    });

    it("returns `DO_RECURSE_KEYS_VALUES` from `visitFabricInstance()`", () => {
      const instance = new FabricMap(new Map());

      expect(new Iterating().visitFabricInstance(instance)).toBe(
        DO_RECURSE_KEYS_VALUES,
      );
    });

    it("returns `undefined` from every `visited*()` method", () => {
      const vis = new Iterating();

      expect(vis.visitedArrayElement([1], 0, 1)).toBeUndefined();
      expect(vis.visitedArrayGap([], 0, 1)).toBeUndefined();
      expect(vis.visitedMapping({}, "k", 1)).toBeUndefined();
    });
  });

  describe("visitValue()", () => {
    describe("dispatch", () => {
      it("visits a nested value depth-first, reporting each element and mapping after its value", () => {
        const rec = new Recorder();
        const inner = { b: null };
        const array = [1, inner];
        const root = { a: array };

        expect(visitValue(root, rec)).toBeUndefined();
        expect(rec.events).toEqual([
          ["value", root],
          ["container", root],
          ["object", root],
          ["value", array],
          ["container", array],
          ["array", array],
          ["value", 1],
          ["primitive", 1, "number"],
          ["visitedElement", array, 0, 1],
          ["value", inner],
          ["container", inner],
          ["object", inner],
          ["value", null],
          ["primitive", null, "null"],
          ["visitedMapping", inner, "b", null],
          ["visitedElement", array, 1, inner],
          ["visitedMapping", root, "a", array],
        ]);
      });

      const primitiveCases: [string, unknown, PrimitiveValueTag][] = [
        ["a bigint", 123n, "bigint"],
        ["a boolean", true, "boolean"],
        ["`null`", null, "null"],
        ["a number", 5, "number"],
        ["a string", "x", "string"],
        ["a registry symbol", Symbol.for("value-visit"), "symbol"],
        ["`undefined`", undefined, "undefined"],
        [
          "a `FabricBytes`",
          new FabricBytes(new Uint8Array([1])),
          "FabricBytes",
        ],
      ];

      for (const [label, value, tag] of primitiveCases) {
        it(`passes ${label} to \`visitPrimitive()\` with the tag \`${tag}\``, () => {
          const rec = new Recorder();

          visitValue(value, rec);
          expect(rec.events).toEqual([
            ["value", value],
            ["primitive", value, tag],
          ]);
        });
      }

      it("passes a `FabricInstance` through `visitFabricContainer()` to `visitFabricInstance()`", () => {
        const rec = new Recorder();
        const instance = new FabricMap(new Map([["k", 1]]));

        visitValue(instance, rec);
        expect(rec.events).toEqual([
          ["value", instance],
          ["container", instance],
          ["instance", instance],
        ]);
      });

      it("does not call a subtype visitor when `visitFabricContainer()` returns something other than `visitSubtype`", () => {
        class Stopping extends Recorder {
          override visitFabricContainer(
            value: FabricContainerValue,
          ): DispatchingVisitorResult<unknown, unknown> {
            this.events.push(["container", value]);
            return mainResult("stopped");
          }
        }

        const rec = new Stopping();

        expect(visitValue([1], rec)).toEqual(mainResult("stopped"));
        expect(rec.names).toEqual(["value", "container"]);
      });

      it("returns the result of `visitValue()` without dispatching, when it is not `visitSubtype`", () => {
        const rec = new Recorder();
        rec.onValue = () => mainResult("done");

        expect(visitValue([1], rec)).toEqual(mainResult("done"));
        expect(rec.names).toEqual(["value"]);
      });
    });

    describe("`replace` results", () => {
      it("dispatches on the replacement rather than the original", () => {
        const rec = new Recorder();
        rec.onValue = (v) => (v === "x") ? replace(42) : DO_VISIT_SUBTYPE;

        visitValue("x", rec);
        expect(rec.events).toEqual([
          ["value", "x"],
          ["value", 42],
          ["primitive", 42, "number"],
        ]);
      });

      it("follows a chain of replacements", () => {
        const rec = new Recorder();
        rec.onValue = (v) => {
          if (v === "x") return replace("y");
          if (v === "y") return replace(3);
          return DO_VISIT_SUBTYPE;
        };

        visitValue("x", rec);
        expect(rec.events).toEqual([
          ["value", "x"],
          ["value", "y"],
          ["value", 3],
          ["primitive", 3, "number"],
        ]);
      });

      it("dispatches on a replacement made by a subtype visitor", () => {
        const rec = new Recorder();
        rec.onPrimitive = (v) => (v === 1) ? replace(2) : undefined;

        visitValue(1, rec);
        expect(rec.events).toEqual([
          ["value", 1],
          ["primitive", 1, "number"],
          ["value", 2],
          ["primitive", 2, "number"],
        ]);
      });

      it("routes a non-fabric replacement under a valid root to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const date = new Date(0);
        rec.onValue = (v) => (v === "x") ? replace(date) : DO_VISIT_SUBTYPE;

        visitValue(["x"], rec);
        expect(rec.events.filter((e) => e[0] === "nonFabric")).toEqual([
          ["nonFabric", date],
        ]);
      });

      it("reports the original element, not its replacement, to `visitedArrayElement()`", () => {
        const rec = new Recorder();
        rec.onValue = (v) => (v === "x") ? replace(42) : DO_VISIT_SUBTYPE;
        const array = ["x"];

        visitValue(array, rec);
        expect(rec.events.filter((e) => e[0] === "visitedElement")).toEqual([
          ["visitedElement", array, 0, "x"],
        ]);
      });

      it("puts a replacement plain object on the cycle stack", () => {
        const replacement: Record<string, unknown> = {};
        replacement.self = replacement;

        const rec = new Recorder();
        rec.onValue = (v) =>
          (v === "x") ? replace(replacement) : DO_VISIT_SUBTYPE;

        visitValue(["x"], rec);
        expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
          ["cycle", replacement, 1, 2],
        ]);
      });

      for (const path of ["directly", "via subtype dispatch"] as const) {
        it(`puts a replacement array on the cycle stack when the \`recurse\` form is produced ${path}`, () => {
          const replacement: unknown[] = [];
          replacement.push(replacement);

          const rec = new Recorder();
          rec.onValue = (v) => {
            if (v === "x") return replace(replacement);
            if (v === replacement && path === "directly") {
              return DO_RECURSE_VALUES;
            }
            return DO_VISIT_SUBTYPE;
          };

          visitValue(["x"], rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", replacement, 1, 2],
          ]);
        });
      }
    });

    describe("cycles", () => {
      it("calls `visitCycle()` with the depth the value was pushed at and the current depth", () => {
        const a: Record<string, unknown> = {};
        a.b = { c: a };

        const rec = new Recorder();

        visitValue(a, rec);
        expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
          ["cycle", a, 0, 2],
        ]);
      });

      it("does not call `visitCycle()` for shared substructure that is not a cycle", () => {
        const shared = { s: 1 };
        const rec = new Recorder();

        visitValue([shared, shared], rec);
        expect(rec.names).not.toContain("cycle");
        expect(rec.events.filter((e) => e[0] === "object")).toEqual([
          ["object", shared],
          ["object", shared],
        ]);
      });

      it("honors a `mainResult` from `visitCycle()`", () => {
        const a: Record<string, unknown> = {};
        a.self = a;

        const rec = new Recorder();
        rec.onCycle = () => mainResult("cycle!");

        expect(visitValue(a, rec)).toEqual(mainResult("cycle!"));
      });

      it("honors a `recurse` from `visitCycle()`, re-entering the value at the next depth", () => {
        const a: Record<string, unknown> = {};
        a.self = a;

        const rec = new Recorder();
        rec.onCycle = (_v, _orig, depth) =>
          (depth < 3) ? DO_RECURSE_VALUES : undefined;

        visitValue(a, rec);
        expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
          ["cycle", a, 0, 1],
          ["cycle", a, 0, 2],
          ["cycle", a, 0, 3],
        ]);
      });
    });

    describe("`mainResult` results", () => {
      it("ends the visit from `visitedArrayElement()`, skipping later elements", () => {
        const rec = new Recorder();
        rec.onVisitedElement = (i) =>
          (i === 1) ? mainResult("at 1") : undefined;
        const array = [10, 20, 30];

        expect(visitValue(array, rec)).toEqual(mainResult("at 1"));
        expect(rec.events.filter((e) => e[0] === "visitedElement")).toEqual([
          ["visitedElement", array, 0, 10],
          ["visitedElement", array, 1, 20],
        ]);
        expect(rec.events.map((e) => e[1])).not.toContain(30);
      });

      it("ends the visit from `visitedMapping()`, skipping later mappings", () => {
        const rec = new Recorder();
        rec.onVisitedMapping = () => mainResult("first");
        const object = { a: 1, b: 2 };

        expect(visitValue(object, rec)).toEqual(mainResult("first"));
        expect(rec.events.filter((e) => e[0] === "visitedMapping")).toEqual([
          ["visitedMapping", object, "a", 1],
        ]);
        expect(rec.events.map((e) => e[1])).not.toContain(2);
      });

      it("ends the visit from a key's recursion, before the value is visited", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
        rec.onPrimitive = (v) => (v === "a") ? mainResult("key") : undefined;

        expect(visitValue({ a: 1 }, rec)).toEqual(mainResult("key"));
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
        ]);
        expect(rec.names).not.toContain("visitedMapping");
      });

      it("ends the visit from `visitedArrayGap()`, for a gap before an element", () => {
        const rec = new Recorder();
        rec.onVisitedGap = () => mainResult("gap");

        // deno-lint-ignore no-sparse-arrays
        expect(visitValue([, 1], rec)).toEqual(mainResult("gap"));
        expect(rec.names).not.toContain("visitedElement");
      });

      it("ends the visit from `visitedArrayGap()`, for a gap at the end", () => {
        const rec = new Recorder();
        rec.onVisitedGap = () => mainResult("gap");

        // deno-lint-ignore no-sparse-arrays
        expect(visitValue([[1, ,], 2], rec)).toEqual(mainResult("gap"));
        expect(rec.events.map((e) => e[1])).not.toContain(2);
      });

      it("ends the visit from deep inside a nested value", () => {
        const rec = new Recorder();
        rec.onPrimitive = (v) =>
          (v === "stop") ? mainResult("deep") : undefined;

        expect(visitValue({ p: [1, "stop", 3], q: 4 }, rec)).toEqual(
          mainResult("deep"),
        );
        expect(rec.events.map((e) => e[1])).not.toContain(3);
        expect(rec.events.map((e) => e[1])).not.toContain(4);
      });
    });

    describe("`recurse` results", () => {
      it("visits both keys and values of a plain object for `DO_RECURSE_KEYS_VALUES`, each key before its value", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;

        visitValue({ a: 1, b: 2 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
          ["primitive", 1, "number"],
          ["primitive", "b", "string"],
          ["primitive", 2, "number"],
        ]);
      });

      it("visits only the keys of a plain object for `DO_RECURSE_KEYS`", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => DO_RECURSE_KEYS;

        visitValue({ a: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
        ]);
      });

      it("visits only the values of a plain object for `DO_RECURSE_VALUES`", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => DO_RECURSE_VALUES;

        visitValue({ a: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", 1, "number"],
        ]);
      });

      it("visits the elements of an array for `DO_RECURSE_VALUES`", () => {
        const rec = new Recorder();
        rec.onArray = () => DO_RECURSE_VALUES;

        visitValue([1, 2], rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", 1, "number"],
          ["primitive", 2, "number"],
        ]);
      });

      it("visits the elements of an array for `DO_RECURSE_KEYS_VALUES`, there being no keys", () => {
        const rec = new Recorder();
        rec.onArray = () => DO_RECURSE_KEYS_VALUES;

        visitValue([1], rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", 1, "number"],
        ]);
      });

      it("reports each mapping to `visitedMapping()` whichever of keys or values is recursed", () => {
        for (const form of [DO_RECURSE_KEYS, DO_RECURSE_VALUES]) {
          const rec = new Recorder();
          rec.onPlainObject = () => form;
          const object = { a: 1 };

          visitValue(object, rec);
          expect(rec.events.filter((e) => e[0] === "visitedMapping")).toEqual([
            ["visitedMapping", object, "a", 1],
          ]);
        }
      });

      it("iterates nothing for `DO_RECURSE_KEYS` on an array", () => {
        const rec = new Recorder();
        rec.onArray = () => DO_RECURSE_KEYS;

        visitValue([1, 2], rec);
        expect(rec.names).not.toContain("primitive");
        expect(rec.names).not.toContain("visitedElement");
      });

      it("iterates nothing for a `recurse` form with both flags `false`, on a plain object", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => ({
          type: "recurse",
          doKeys: false,
          doValues: false,
        });

        visitValue({ a: 1 }, rec);
        expect(rec.names).not.toContain("primitive");
        expect(rec.names).not.toContain("visitedMapping");
      });

      it("honors a `recurse` returned directly from `visitValue()`, without subtype dispatch", () => {
        const rec = new Recorder();
        rec.onValue = (v) =>
          Array.isArray(v) ? DO_RECURSE_VALUES : DO_VISIT_SUBTYPE;

        visitValue([1], rec);
        expect(rec.names).toEqual([
          "value",
          "value",
          "primitive",
          "visitedElement",
        ]);
      });

      it("throws for a `recurse` from `visitValue()` on a primitive", () => {
        const rec = new Recorder();
        rec.onValue = () => DO_RECURSE_VALUES;

        expect(() => visitValue(1, rec)).toThrow(
          /Cannot use `recurse` result with non-container: `1`/,
        );
      });

      it("throws for a `recurse` from `visitPrimitive()`", () => {
        const rec = new Recorder();
        rec.onPrimitive = () => DO_RECURSE_VALUES;

        expect(() => visitValue("x", rec)).toThrow(
          /Cannot use `recurse` result with non-container: /,
        );
      });

      it("throws for a `recurse` from `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        rec.onNonFabric = () => DO_RECURSE_VALUES;

        expect(() => visitValue(new Date(0), rec)).toThrow(
          /Cannot use `recurse` result with non-container: /,
        );
      });

      it("throws for a `recurse` on a `FabricInstance`", () => {
        const rec = new Recorder();
        rec.onInstance = () => DO_RECURSE_KEYS_VALUES;
        const instance = new FabricMap(new Map());

        expect(() => visitValue(instance, rec)).toThrow(/not yet visitable/);
      });
    });

    describe("array gaps", () => {
      /** Expected gap and element events, without the array argument. */
      type Expected = [name: string, ...args: unknown[]][];

      const cases: [string, unknown[], Expected][] = [
        // deno-lint-ignore no-sparse-arrays
        ["a leading hole", [, 5], [["gap", 0, 1], ["element", 1, 5]]],
        // deno-lint-ignore no-sparse-arrays
        ["a trailing hole", [5, ,], [["element", 0, 5], ["gap", 1, 1]]],
        [
          "several gaps",
          // deno-lint-ignore no-sparse-arrays
          [, , 5, , , 6, ,],
          [
            ["gap", 0, 2],
            ["element", 2, 5],
            ["gap", 3, 2],
            ["element", 5, 6],
            ["gap", 6, 1],
          ],
        ],
        ["a dense array", [7, 8], [["element", 0, 7], ["element", 1, 8]]],
        ["an empty array", [], []],
        ["an array of only holes", new Array(3), [["gap", 0, 3]]],
      ];

      for (const [label, array, expected] of cases) {
        it(`reports the gaps and elements of ${label}, in order`, () => {
          const rec = new Recorder();

          visitValue(array, rec);

          const actual = rec.events
            .filter((e) => e[0] === "visitedGap" || e[0] === "visitedElement")
            .map(([name, arr, ...rest]) => {
              expect(arr).toBe(array);
              return [name === "visitedGap" ? "gap" : "element", ...rest];
            });
          expect(actual).toEqual(expected);
        });
      }

      it("throws when an array taken as valid carries a named property", () => {
        // The shallow check does not take such an array to be a
        // `FabricArray`, so the only way to reach the iteration with one is
        // to assert validity.
        const rec = new Recorder() as unknown as ValueVisitor<never, unknown>;
        const array: unknown[] & { extra?: number } = [1];
        array.extra = 2;

        expect(() => visitFabricValue(array as FabricValue, rec)).toThrow(
          /Non-index property in alleged `FabricArray`: `extra`/,
        );
      });

      it("routes an array carrying a named property to `visitNonFabricValue()` under the shallow check", () => {
        const rec = new Recorder();
        const array: unknown[] & { extra?: number } = [1];
        array.extra = 2;

        visitValue(array, rec);
        expect(rec.events).toEqual([["value", array], ["nonFabric", array]]);
      });
    });

    describe("type checking", () => {
      it("routes a non-fabric root to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const date = new Date(0);

        visitValue(date, rec);
        expect(rec.events).toEqual([["value", date], ["nonFabric", date]]);
      });

      it("treats an array holding a function as a `FabricArray` under the shallow check, and routes the function to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const fn = () => 1;

        visitValue([fn], rec);
        expect(rec.names).toEqual([
          "value",
          "container",
          "array",
          "value",
          "nonFabric",
          "visitedElement",
        ]);
      });

      it("routes an array holding a function to `visitNonFabricValue()` whole under the deep check", () => {
        const rec = new Recorder();
        const array = [() => 1];

        visitValue(array, rec, true);
        expect(rec.events).toEqual([["value", array], ["nonFabric", array]]);
      });

      it("visits a deep valid value the same under either check", () => {
        const shallow = new Recorder();
        const deep = new Recorder();
        const value = chain(5, [1, "two", { three: 3n }]);

        visitValue(value, shallow);
        visitValue(value, deep, true);
        expect(deep.events).toEqual(shallow.events);
        expect(deep.names).toContain("primitive");
      });
    });

    describe("results", () => {
      it("returns `undefined` when no visitor produces a `mainResult`", () => {
        expect(visitValue({ a: [1] }, new Recorder())).toBeUndefined();
      });

      it("returns a `mainResult` typed by the visitor's `ResultType`", () => {
        class FirstNumber extends Recorder {
          override visitPrimitive(
            value: Primitive | FabricPrimitive,
            tag: PrimitiveValueTag,
          ): LeafVisitorResult<unknown, unknown> {
            return (tag === "number") ? mainResult(value) : undefined;
          }
        }

        const result = visitValue(["x", 7, 8], new FirstNumber());

        expect(result).toEqual(mainResult(7));
      });

      it("refuses, at compile time, a value outside the visitor's domain, and routes it to `visitNonFabricValue()` at runtime", () => {
        // The refusal is the point of this test: were the call to type-check,
        // the directive would be reported as unused and the file would fail
        // to compile. The line still runs, and the assertions pin the
        // best-effort runtime behavior for a value the types said could not
        // arrive: it reaches the non-fabric hook, whose parameter type is
        // `never`.
        class Strict extends EmptyValueVisitor<never, number> {
          seen: unknown[] = [];
          override visitValue(): DispatchingVisitorResult<never, number> {
            return DO_VISIT_SUBTYPE;
          }
          override visitNonFabricValue(
            value: never,
          ): LeafVisitorResult<never, number> {
            this.seen.push(value);
            return undefined;
          }
        }

        const vis = new Strict();
        const date = new Date(0);

        // @ts-expect-error A `Date` is not in a `never`-extra domain.
        expect(visitValue(date, vis)).toBeUndefined();
        expect(vis.seen).toEqual([date]);
      });
    });
  });

  describe("visitFabricValue()", () => {
    it("visits a value and returns `undefined` absent a `mainResult`", () => {
      const rec = new Recorder() as unknown as ValueVisitor<never, number>;
      const value = { a: [1, 2] } as FabricValue;

      expect(visitFabricValue(value, rec)).toBeUndefined();
      expect((rec as unknown as Recorder).names).toContain("primitive");
    });

    it("returns a `mainResult` typed by the visitor's `ResultType`", () => {
      class FirstPrimitive extends EmptyValueVisitor<never, string> {
        override visitValue(): DispatchingVisitorResult<never, string> {
          return DO_VISIT_SUBTYPE;
        }
        override visitPrimitive(
          value: Primitive | FabricPrimitive,
        ): LeafVisitorResult<never, string> {
          return mainResult(String(value));
        }
      }

      const result: BaselineVisitResult<string> = visitFabricValue(
        5,
        new FirstPrimitive(),
      );

      expect(result).toEqual(mainResult("5"));
    });

    it("throws on reaching a value that is not a `FabricValue`", () => {
      const rec = new Recorder() as unknown as ValueVisitor<never, unknown>;
      const lying = [1, new Date(0)] as unknown as FabricValue;

      expect(() => visitFabricValue(lying, rec)).toThrow(/assume valid/);
    });

    it("throws for a `recurse` on a value that is not a `FabricValue`", () => {
      const rec = new Recorder();
      rec.onValue = () => DO_RECURSE_VALUES;
      const lying = new Date(0) as unknown as FabricValue;

      expect(() =>
        visitFabricValue(lying, rec as unknown as ValueVisitor<never, unknown>)
      ).toThrow(/Cannot use `recurse` result with non-container: /);
    });
  });

  describe("makeVisitValueFunction()", () => {
    it("returns a function that visits with the bound visitor", () => {
      const rec = new Recorder();
      const visit = makeVisitValueFunction(rec);

      expect(visit([1])).toBeUndefined();
      expect(rec.names).toContain("primitive");
    });

    it("honors the `deepTypeCheck` argument it was made with", () => {
      const shallow = new Recorder();
      const deep = new Recorder();
      const array = [() => 1];

      makeVisitValueFunction(shallow)(array);
      makeVisitValueFunction(deep, true)(array);
      expect(shallow.names).toContain("array");
      expect(deep.names).not.toContain("array");
    });
  });

  describe("makeVisitFabricValueFunction()", () => {
    it("returns a function that visits with the bound visitor", () => {
      const rec = new Recorder() as unknown as ValueVisitor<never, unknown>;
      const visit = makeVisitFabricValueFunction(rec);

      expect(visit([1])).toBeUndefined();
      expect((rec as unknown as Recorder).names).toContain("primitive");
    });
  });
});
