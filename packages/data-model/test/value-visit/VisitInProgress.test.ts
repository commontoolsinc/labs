import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { type FabricContainerValue, type FabricValue } from "@/interface.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";
import {
  type DispatchingVisitorResult,
  DO_RECURSE_KEYS,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  DO_VISIT_SUBTYPE,
  type ValueVisitor,
} from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import { chain, mainResult, Recorder, replace } from "./Recorder.ts";

/** Runs a fresh checking visit of `value` with `vis`. */
function visit(
  value: unknown,
  vis: ValueVisitor<unknown, unknown>,
  deepTypeCheck = false,
): unknown {
  return new VisitInProgress(vis).visit(value, deepTypeCheck);
}

/** Runs a fresh assume-valid visit of `value` with `vis`. */
function visitAssumingValid(
  value: unknown,
  vis: ValueVisitor<unknown, unknown>,
): unknown {
  return new VisitInProgress(vis as ValueVisitor<never, unknown>)
    .visitFabricValue(value as FabricValue);
}

describe("VisitInProgress", () => {
  describe("instance members", () => {
    describe("visit()", () => {
      describe("dispatch", () => {
        it("visits a nested value depth-first, reporting each element and mapping after its value", () => {
          const rec = new Recorder();
          const inner = { b: null };
          const array = [1, inner];
          const root = { a: array };

          expect(visit(root, rec)).toBeUndefined();
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

            visit(value, rec);
            expect(rec.events).toEqual([
              ["value", value],
              ["primitive", value, tag],
            ]);
          });
        }

        it("passes a `FabricInstance` through `visitFabricContainer()` to `visitFabricInstance()`", () => {
          const rec = new Recorder();
          const instance = new FabricMap(new Map([["k", 1]]));

          visit(instance, rec);
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

          expect(visit([1], rec)).toEqual(mainResult("stopped"));
          expect(rec.names).toEqual(["value", "container"]);
        });

        it("returns the result of `visitValue()` without dispatching, when it is not `visitSubtype`", () => {
          const rec = new Recorder();
          rec.onValue = () => mainResult("done");

          expect(visit([1], rec)).toEqual(mainResult("done"));
          expect(rec.names).toEqual(["value"]);
        });
      });

      describe("`replace` results", () => {
        it("dispatches on the replacement rather than the original", () => {
          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(42) : DO_VISIT_SUBTYPE;

          visit("x", rec);
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

          visit("x", rec);
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

          visit(1, rec);
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

          visit(["x"], rec);
          expect(rec.events.filter((e) => e[0] === "nonFabric")).toEqual([
            ["nonFabric", date],
          ]);
        });

        it("reports the original element, not its replacement, to `visitedArrayElement()`", () => {
          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(42) : DO_VISIT_SUBTYPE;
          const array = ["x"];

          visit(array, rec);
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

          visit(["x"], rec);
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

            visit(["x"], rec);
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

          visit(a, rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", a, 0, 2],
          ]);
        });

        it("does not call `visitCycle()` for shared substructure that is not a cycle", () => {
          const shared = { s: 1 };
          const rec = new Recorder();

          visit([shared, shared], rec);
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

          expect(visit(a, rec)).toEqual(mainResult("cycle!"));
        });

        it("honors a `recurse` from `visitCycle()`, re-entering the value at the next depth", () => {
          const a: Record<string, unknown> = {};
          a.self = a;

          const rec = new Recorder();
          rec.onCycle = (_v, _orig, depth) =>
            (depth < 3) ? DO_RECURSE_VALUES : undefined;

          visit(a, rec);
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

          expect(visit(array, rec)).toEqual(mainResult("at 1"));
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

          expect(visit(object, rec)).toEqual(mainResult("first"));
          expect(rec.events.filter((e) => e[0] === "visitedMapping")).toEqual([
            ["visitedMapping", object, "a", 1],
          ]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
        });

        it("ends the visit from a key's recursion, before the value is visited", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onPrimitive = (v) => (v === "a") ? mainResult("key") : undefined;

          expect(visit({ a: 1 }, rec)).toEqual(mainResult("key"));
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
          ]);
          expect(rec.names).not.toContain("visitedMapping");
        });

        it("ends the visit from `visitedArrayGap()`, for a gap before an element", () => {
          const rec = new Recorder();
          rec.onVisitedGap = () => mainResult("gap");

          // deno-lint-ignore no-sparse-arrays
          expect(visit([, 1], rec)).toEqual(mainResult("gap"));
          expect(rec.names).not.toContain("visitedElement");
        });

        it("ends the visit from `visitedArrayGap()`, for a gap at the end", () => {
          const rec = new Recorder();
          rec.onVisitedGap = () => mainResult("gap");

          // deno-lint-ignore no-sparse-arrays
          expect(visit([[1, ,], 2], rec)).toEqual(mainResult("gap"));
          expect(rec.events.map((e) => e[1])).not.toContain(2);
        });

        it("ends the visit from deep inside a nested value", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v) =>
            (v === "stop") ? mainResult("deep") : undefined;

          expect(visit({ p: [1, "stop", 3], q: 4 }, rec)).toEqual(
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

          visit({ a: 1, b: 2 }, rec);
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

          visit({ a: 1 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
          ]);
        });

        it("visits only the values of a plain object for `DO_RECURSE_VALUES`", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_VALUES;

          visit({ a: 1 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
          ]);
        });

        it("visits the elements of an array for `DO_RECURSE_VALUES`", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_VALUES;

          visit([1, 2], rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("visits the elements of an array for `DO_RECURSE_KEYS_VALUES`, there being no keys", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_KEYS_VALUES;

          visit([1], rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
          ]);
        });

        it("reports each mapping to `visitedMapping()` whichever of keys or values is recursed", () => {
          for (const form of [DO_RECURSE_KEYS, DO_RECURSE_VALUES]) {
            const rec = new Recorder();
            rec.onPlainObject = () => form;
            const object = { a: 1 };

            visit(object, rec);
            expect(rec.events.filter((e) => e[0] === "visitedMapping"))
              .toEqual([
                ["visitedMapping", object, "a", 1],
              ]);
          }
        });

        it("iterates nothing for `DO_RECURSE_KEYS` on an array", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_KEYS;

          visit([1, 2], rec);
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

          visit({ a: 1 }, rec);
          expect(rec.names).not.toContain("primitive");
          expect(rec.names).not.toContain("visitedMapping");
        });

        it("honors a `recurse` returned directly from `visitValue()`, without subtype dispatch", () => {
          const rec = new Recorder();
          rec.onValue = (v) =>
            Array.isArray(v) ? DO_RECURSE_VALUES : DO_VISIT_SUBTYPE;

          visit([1], rec);
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

          expect(() => visit(1, rec)).toThrow(
            /Cannot use `recurse` result with non-container: `1`/,
          );
        });

        it("throws for a `recurse` from `visitPrimitive()`", () => {
          const rec = new Recorder();
          rec.onPrimitive = () => DO_RECURSE_VALUES;

          expect(() => visit("x", rec)).toThrow(
            /Cannot use `recurse` result with non-container: /,
          );
        });

        it("throws for a `recurse` from `visitNonFabricValue()`", () => {
          const rec = new Recorder();
          rec.onNonFabric = () => DO_RECURSE_VALUES;

          expect(() => visit(new Date(0), rec)).toThrow(
            /Cannot use `recurse` result with non-container: /,
          );
        });

        it("throws for a `recurse` on a `FabricInstance`", () => {
          const rec = new Recorder();
          rec.onInstance = () => DO_RECURSE_KEYS_VALUES;
          const instance = new FabricMap(new Map());

          expect(() => visit(instance, rec)).toThrow(/not yet visitable/);
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

            visit(array, rec);

            const actual = rec.events
              .filter((e) => e[0] === "visitedGap" || e[0] === "visitedElement")
              .map(([name, arr, ...rest]) => {
                expect(arr).toBe(array);
                return [name === "visitedGap" ? "gap" : "element", ...rest];
              });
            expect(actual).toEqual(expected);
          });
        }

        it("routes an array carrying a named property to `visitNonFabricValue()` under the shallow check", () => {
          const rec = new Recorder();
          const array: unknown[] & { extra?: number } = [1];
          array.extra = 2;

          visit(array, rec);
          expect(rec.events).toEqual([["value", array], ["nonFabric", array]]);
        });
      });

      describe("type checking", () => {
        it("routes a non-fabric root to `visitNonFabricValue()`", () => {
          const rec = new Recorder();
          const date = new Date(0);

          visit(date, rec);
          expect(rec.events).toEqual([["value", date], ["nonFabric", date]]);
        });

        it("treats an array holding a function as a `FabricArray` under the shallow check, and routes the function to `visitNonFabricValue()`", () => {
          const rec = new Recorder();
          const fn = () => 1;

          visit([fn], rec);
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

          visit(array, rec, true);
          expect(rec.events).toEqual([["value", array], ["nonFabric", array]]);
        });

        it("visits a deep valid value the same under either check", () => {
          const shallow = new Recorder();
          const deep = new Recorder();
          const value = chain(5, [1, "two", { three: 3n }]);

          visit(value, shallow);
          visit(value, deep, true);
          expect(deep.events).toEqual(shallow.events);
          expect(deep.names).toContain("primitive");
        });
      });

      describe("results", () => {
        it("returns `undefined` when no visitor produces a `mainResult`", () => {
          expect(visit({ a: [1] }, new Recorder())).toBeUndefined();
        });

        it("returns the first `mainResult` a visitor produces", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v, tag) =>
            (tag === "number") ? mainResult(v) : undefined;

          expect(visit(["x", 7, 8], rec)).toEqual(mainResult(7));
        });
      });

      describe("re-entry", () => {
        it("throws when a visitor starts another top-level visit on the same instance mid-visit", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onPrimitive = () => {
            inProgress.visit(2, false);
            return undefined;
          };

          expect(() => inProgress.visit([1], false)).toThrow(
            /multiple concurrent top-level visits/,
          );
        });

        it("accepts a second top-level visit once the first has completed", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);

          expect(inProgress.visit([1], false)).toBeUndefined();
          expect(inProgress.visit({ a: 2 }, false)).toBeUndefined();
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("accepts a second top-level visit after the first threw", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onPrimitive = (v) => (v === 1) ? DO_RECURSE_VALUES : undefined;

          expect(() => inProgress.visit([1], false)).toThrow(/non-container/);
          expect(inProgress.visit([2], false)).toBeUndefined();
        });

        it("throws when a visitor re-enters from the root value, before anything is on the stack", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onValue = (v) => {
            if (v === "root") {
              inProgress.visit(2, false);
            }
            return DO_VISIT_SUBTYPE;
          };

          expect(() => inProgress.visit("root", false)).toThrow(
            /multiple concurrent top-level visits/,
          );
        });

        it("keeps the outer visit's checking mode when a visitor swallows a re-entry error", () => {
          // The array holding a function is the tell: the outer visit is
          // shallow and iterates it, whereas the re-entry asked for a deep
          // check, under which it would go whole to `visitNonFabricValue()`.
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          const array = [() => 1];
          rec.onValue = (v) => {
            if (v === "root") {
              try {
                inProgress.visit(2, true);
              } catch {
                // Deliberately swallowed.
              }
              return replace(array);
            }
            return DO_VISIT_SUBTYPE;
          };

          inProgress.visit("root", false);
          expect(rec.names).toEqual([
            "value",
            "value",
            "container",
            "array",
            "value",
            "nonFabric",
            "visitedElement",
          ]);
        });
      });
    });

    describe("visitFabricValue()", () => {
      it("visits a value and returns `undefined` absent a `mainResult`", () => {
        const rec = new Recorder();

        expect(visitAssumingValid({ a: [1, 2] }, rec)).toBeUndefined();
        expect(rec.names).toContain("primitive");
      });

      it("returns a `mainResult` a visitor produces", () => {
        const rec = new Recorder();
        rec.onPrimitive = (v) => mainResult(String(v));

        expect(visitAssumingValid(5, rec)).toEqual(mainResult("5"));
      });

      it("throws on reaching a value that is not a `FabricValue`", () => {
        const rec = new Recorder();

        expect(() => visitAssumingValid([1, new Date(0)], rec)).toThrow(
          /assume valid/,
        );
      });

      it("throws for a `recurse` on a value that is not a `FabricValue`", () => {
        const rec = new Recorder();
        rec.onValue = () => DO_RECURSE_VALUES;

        expect(() => visitAssumingValid(new Date(0), rec)).toThrow(
          /Cannot use `recurse` result with non-container: /,
        );
      });

      it("throws when an array taken as valid carries a named property", () => {
        // The shallow check does not take such an array to be a
        // `FabricArray`, so the only way to reach the iteration with one is
        // to assert validity.
        const rec = new Recorder();
        const array: unknown[] & { extra?: number } = [1];
        array.extra = 2;

        expect(() => visitAssumingValid(array, rec)).toThrow(
          /Non-index property in alleged `FabricArray`: `extra`/,
        );
      });
    });
  });
});
