import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import {
  type FabricArray,
  type FabricPlainObject,
  type FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";
import {
  type BaselineVisitResult,
  ContainerIteratingVisitor,
  type ContainerIterationResult,
  type DispatchingVisitorResult,
  DO_RECURSE_KEY,
  DO_RECURSE_KEY_VALUE,
  DO_RECURSE_VALUE,
  DO_VISIT_SUBTYPE,
  doIterateArray,
  doIterateMap,
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
 * Visitor that iterates every container, recurses into every element, key,
 * and value, and records each call it receives. Each hook can be overridden
 * per test by assigning the matching `on*` property.
 */
class Recorder extends ContainerIteratingVisitor<unknown, unknown> {
  readonly events: Event[] = [];

  onValue?: (value: unknown) => DispatchingVisitorResult<unknown, unknown>;
  onCycle?: (value: unknown) => LeafVisitorResult<unknown, unknown>;
  onElement?: (
    index: number,
    value: unknown,
  ) => ContainerIterationResult<unknown>;
  onMapping?: (
    key: unknown,
    value: unknown,
  ) => ContainerIterationResult<unknown>;
  onGap?: (start: number, count: number) => BaselineVisitResult<unknown>;
  onPrimitive?: (
    value: unknown,
    tag: PrimitiveValueTag,
  ) => LeafVisitorResult<unknown, unknown>;
  onNonFabric?: (value: unknown) => LeafVisitorResult<unknown, unknown>;
  onPlainObject?: (
    value: FabricPlainObject,
  ) => LeafVisitorResult<unknown, unknown>;

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
    return this.onCycle ? this.onCycle(value) : undefined;
  }

  override visitFabricContainer(
    value: FabricArray | FabricPlainObject | FabricMap,
  ): DispatchingVisitorResult<unknown, unknown> {
    this.events.push(["container", value]);
    return DO_VISIT_SUBTYPE;
  }

  override visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["array", value]);
    return super.visitFabricArray(value);
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
    value: FabricMap,
  ): LeafVisitorResult<unknown, unknown> {
    this.events.push(["instance", value]);
    return undefined;
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

  override visitArrayElement(
    index: number,
    value: unknown,
  ): ContainerIterationResult<unknown> {
    this.events.push(["element", index, value]);
    return this.onElement ? this.onElement(index, value) : DO_RECURSE_VALUE;
  }

  override visitArrayGap(
    start: number,
    count: number,
  ): BaselineVisitResult<unknown> {
    this.events.push(["gap", start, count]);
    return this.onGap ? this.onGap(start, count) : undefined;
  }

  override visitMapping(
    key: unknown,
    value: unknown,
  ): ContainerIterationResult<unknown> {
    this.events.push(["mapping", key, value]);
    return this.onMapping ? this.onMapping(key, value) : DO_RECURSE_KEY_VALUE;
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
      ["DO_RECURSE_KEY_VALUE", DO_RECURSE_KEY_VALUE, true, true],
      ["DO_RECURSE_KEY", DO_RECURSE_KEY, true, false],
      ["DO_RECURSE_VALUE", DO_RECURSE_VALUE, false, true],
    ];

    for (const [name, form, doKey, doValue] of recurseCases) {
      it(`makes \`${name}\` a frozen \`recurse\` form with \`doKey\` ${doKey} and \`doValue\` ${doValue}`, () => {
        expect(Object.isFrozen(form)).toBe(true);
        expect(form).toEqual({ type: "recurse", doKey, doValue });
      });
    }

    it("makes `DO_VISIT_SUBTYPE` a frozen `visitSubtype` form", () => {
      expect(Object.isFrozen(DO_VISIT_SUBTYPE)).toBe(true);
      expect(DO_VISIT_SUBTYPE).toEqual({ type: "visitSubtype" });
    });
  });

  describe("doIterateArray()", () => {
    it("returns an `iterateArray` form holding the given array itself", () => {
      const elements = [1, 2, 3];
      const form = doIterateArray(elements);

      expect(form.type).toBe("iterateArray");
      expect(form.elements).toBe(elements);
    });
  });

  describe("doIterateMap()", () => {
    it("returns an `iterateMap` form holding the given mappings themselves", () => {
      const mappings: [string, number][] = [["a", 1]];
      const form = doIterateMap(mappings);

      expect(form.type).toBe("iterateMap");
      expect(form.mappings).toBe(mappings);
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
  });

  describe("EmptyValueVisitor", () => {
    it("returns `undefined` from every visitor method", () => {
      const vis = new EmptyValueVisitor<unknown, unknown>();

      expect(vis.visitArrayElement(0, 1)).toBeUndefined();
      expect(vis.visitArrayGap(0, 1)).toBeUndefined();
      expect(vis.visitCycle(1, 0, 1)).toBeUndefined();
      expect(vis.visitFabricArray([])).toBeUndefined();
      expect(vis.visitFabricContainer([])).toBeUndefined();
      expect(vis.visitFabricInstance(new FabricMap(new Map()))).toBeUndefined();
      expect(vis.visitFabricPlainObject({})).toBeUndefined();
      expect(vis.visitMapping("k", 1)).toBeUndefined();
      expect(vis.visitNonFabricValue(new Date(0))).toBeUndefined();
      expect(vis.visitPrimitive(1, "number")).toBeUndefined();
      expect(vis.visitValue(1)).toBeUndefined();
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
      override visitArrayElement(): ContainerIterationResult<never> {
        return undefined;
      }
      override visitArrayGap(): BaselineVisitResult<never> {
        return undefined;
      }
      override visitCycle(): LeafVisitorResult<never, never> {
        return undefined;
      }
      override visitMapping(): ContainerIterationResult<never> {
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

    it("returns an `iterateArray` form over the array itself from `visitFabricArray()`", () => {
      const array = [1, 2];
      const form = new Iterating().visitFabricArray(array);

      expect(form).toEqual({ type: "iterateArray", elements: array });
      expect((form as { elements: unknown }).elements).toBe(array);
    });

    it("returns an `iterateMap` form over the entries from `visitFabricPlainObject()`", () => {
      const form = new Iterating().visitFabricPlainObject({ a: 1, b: 2 });

      expect(form).toEqual({
        type: "iterateMap",
        mappings: [["a", 1], ["b", 2]],
      });
    });

    it("throws from `visitFabricInstance()`", () => {
      const instance = new FabricMap(new Map());

      expect(() => new Iterating().visitFabricInstance(instance)).toThrow(
        /not yet visitable/,
      );
    });
  });

  describe("visitValue()", () => {
    describe("dispatch", () => {
      it("visits a nested value in order, keys before values", () => {
        const rec = new Recorder();
        const root = { a: [1, { b: null }] };

        expect(visitValue(root, rec)).toBeUndefined();
        expect(rec.names).toEqual([
          "value",
          "container",
          "object",
          "mapping",
          "value",
          "primitive", // The key `a`.
          "value",
          "container",
          "array",
          "element",
          "value",
          "primitive", // `1`.
          "element",
          "value",
          "container",
          "object",
          "mapping",
          "value",
          "primitive", // The key `b`.
          "value",
          "primitive", // `null`.
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
            value: FabricArray | FabricPlainObject | FabricMap,
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
        it(`puts a replacement array on the cycle stack when the iterate form is produced ${path}`, () => {
          const replacement: unknown[] = [];
          replacement.push(replacement);

          const rec = new Recorder();
          rec.onValue = (v) => {
            if (v === "x") return replace(replacement);
            if (v === replacement && path === "directly") {
              return doIterateArray<unknown>(replacement);
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
    });

    describe("`mainResult` results", () => {
      it("ends the visit from an element visitor, skipping later elements", () => {
        const rec = new Recorder();
        rec.onElement = (i) =>
          (i === 1) ? mainResult("at 1") : DO_RECURSE_VALUE;

        expect(visitValue([10, 20, 30], rec)).toEqual(mainResult("at 1"));
        expect(rec.events.filter((e) => e[0] === "element")).toEqual([
          ["element", 0, 10],
          ["element", 1, 20],
        ]);
      });

      it("ends the visit from a mapping visitor", () => {
        const rec = new Recorder();
        rec.onMapping = () => mainResult("first");

        expect(visitValue({ a: 1, b: 2 }, rec)).toEqual(mainResult("first"));
        expect(rec.events.filter((e) => e[0] === "mapping")).toEqual([
          ["mapping", "a", 1],
        ]);
      });

      it("ends the visit from a key's recursion, before the value is visited", () => {
        const rec = new Recorder();
        rec.onPrimitive = (v) => (v === "a") ? mainResult("key") : undefined;

        expect(visitValue({ a: 1 }, rec)).toEqual(mainResult("key"));
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
        ]);
      });

      it("ends the visit from a gap visitor, for a gap before an element", () => {
        const rec = new Recorder();
        rec.onGap = () => mainResult("gap");

        // deno-lint-ignore no-sparse-arrays
        expect(visitValue([, 1], rec)).toEqual(mainResult("gap"));
        expect(rec.names).not.toContain("element");
      });

      it("ends the visit from a gap visitor, for a gap at the end", () => {
        const rec = new Recorder();
        rec.onGap = () => mainResult("gap");

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
      it("recurses into both key and value for `DO_RECURSE_KEY_VALUE`", () => {
        const rec = new Recorder();
        rec.onMapping = () => DO_RECURSE_KEY_VALUE;

        visitValue({ a: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
          ["primitive", 1, "number"],
        ]);
      });

      it("recurses into the key only for `DO_RECURSE_KEY`", () => {
        const rec = new Recorder();
        rec.onMapping = () => DO_RECURSE_KEY;

        visitValue({ a: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", "a", "string"],
        ]);
      });

      it("recurses into the value only for `DO_RECURSE_VALUE`", () => {
        const rec = new Recorder();
        rec.onMapping = () => DO_RECURSE_VALUE;

        visitValue({ a: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
          ["primitive", 1, "number"],
        ]);
      });

      it("recurses into nothing for `DO_RECURSE_KEY` on an array element", () => {
        const rec = new Recorder();
        rec.onElement = () => DO_RECURSE_KEY;

        visitValue([1, 2], rec);
        expect(rec.names).not.toContain("primitive");
      });

      it("recurses into nothing for `undefined`", () => {
        const rec = new Recorder();
        rec.onElement = () => undefined;
        rec.onMapping = () => undefined;

        visitValue({ a: [1] }, rec);
        expect(rec.names).not.toContain("primitive");
      });
    });

    describe("array gaps", () => {
      const cases: [string, unknown[], Event[]][] = [
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
          expect(
            rec.events.filter((e) => e[0] === "gap" || e[0] === "element"),
          ).toEqual(expected);
        });
      }
    });

    describe("`iterateArray` validation", () => {
      it("throws when the elements array carries a named property", () => {
        const rec = new Recorder();
        rec.onPlainObject = () => {
          const elements: unknown[] & { extra?: number } = [1];
          elements.extra = 2;
          return doIterateArray<unknown>(elements);
        };

        expect(() => visitValue({}, rec)).toThrow(/Improper array/);
      });
    });

    describe("type checking", () => {
      it("routes a non-fabric root to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const date = new Date(0);

        visitValue(date, rec);
        expect(rec.events).toEqual([["value", date], ["nonFabric", date]]);
      });

      it("routes a non-fabric value synthesized under a valid root to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const date = new Date(0);
        rec.onPlainObject = () => doIterateMap<unknown>([["d", date]]);

        visitValue({ ok: 1 }, rec);
        expect(rec.events.filter((e) => e[0] === "nonFabric")).toEqual([
          ["nonFabric", date],
        ]);
      });

      it("treats an array holding a function as a `FabricArray` under the shallow check, and routes the function to `visitNonFabricValue()`", () => {
        const rec = new Recorder();
        const fn = () => 1;

        visitValue([fn], rec);
        expect(rec.names).toEqual([
          "value",
          "container",
          "array",
          "element",
          "value",
          "nonFabric",
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

      it("refuses, at compile time, a value outside the visitor's domain", () => {
        // The refusal is the point of this test: were the call to type-check,
        // the directive would be reported as unused and the file would fail
        // to compile. The line still runs, and at runtime the value reaches
        // the non-fabric hook, which is the best-effort behavior for a value
        // the types said could not arrive.
        const vis = new EmptyValueVisitor<never, number>();

        // @ts-expect-error A `Date` is not in a `never`-extra domain.
        expect(visitValue(new Date(0), vis)).toBeUndefined();
      });
    });
  });

  describe("visitFabricValue()", () => {
    it("visits a value and returns the visitor's `mainResult`", () => {
      class Count extends Recorder {
        override visitPrimitive(): LeafVisitorResult<unknown, unknown> {
          return undefined;
        }
      }

      const vis = new Count() as unknown as ValueVisitor<never, number>;
      const value = { a: [1, 2] } as FabricValue;

      expect(visitFabricValue(value, vis)).toBeUndefined();
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
