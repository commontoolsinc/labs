import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricPrimitive, type FabricValue } from "@/interface.ts";
import type { Primitive } from "@commonfabric/utils/types";
import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_VISIT_SUBTYPE,
  EmptyValueVisitor,
  type LeafVisitorResult,
  makeVisitFabricValueFunction,
  makeVisitValueFunction,
  type ValueVisitor,
  visitFabricValue,
  visitValue,
} from "@/value-visit";

import { mainResult, Recorder } from "./Recorder.ts";

describe("value-visit/impl", () => {
  describe("visitValue()", () => {
    it("visits with the shallow check by default", () => {
      const rec = new Recorder();
      const array = [() => 1];

      visitValue(array, rec);
      expect(rec.names).toContain("array");
    });

    it("visits with the deep check when asked", () => {
      const rec = new Recorder();
      const array = [() => 1];

      visitValue(array, rec, true);
      expect(rec.events).toEqual([["value", array], ["nonFabric", array]]);
    });

    it("returns `undefined` when no visitor produces a `mainResult`", () => {
      expect(visitValue({ a: [1] }, new Recorder())).toBeUndefined();
    });

    it("returns a `mainResult` typed by the visitor's `ResultType`", () => {
      class FirstNumber extends EmptyValueVisitor<never, number> {
        override visitValue(): DispatchingVisitorResult<never, number> {
          return DO_VISIT_SUBTYPE;
        }
        override visitFabricContainer(): DispatchingVisitorResult<
          never,
          number
        > {
          return DO_VISIT_SUBTYPE;
        }
        override visitFabricArray(): LeafVisitorResult<never, number> {
          return { type: "recurse", doKeys: false, doValues: true };
        }
        override visitPrimitive(
          value: Primitive | FabricPrimitive,
        ): LeafVisitorResult<never, number> {
          return (typeof value === "number") ? mainResult(value) : undefined;
        }
      }

      const result: BaselineVisitResult<number> = visitValue(
        ["x", 7, 8],
        new FirstNumber(),
      );

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
