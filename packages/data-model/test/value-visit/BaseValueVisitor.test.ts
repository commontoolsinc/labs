import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import { Recorder } from "./Recorder.ts";

describe("BaseValueVisitor", () => {
  describe("instance members", () => {
    describe("throwNoCycles()", () => {
      it("throws an error naming the value", () => {
        class NoCycles extends Recorder {
          override visitCycle(value: unknown): never {
            return this.throwNoCycles(value);
          }
        }

        const value: Record<string, unknown> = {};
        value.self = value;

        expect(() => new VisitInProgress(new NoCycles()).visit(value, false))
          .toThrow(/Cannot visit cyclic value: /);
      });
    });

    describe("throwShouldntCall()", () => {
      it("throws an error naming the method and the visitor", () => {
        class Refusing extends Recorder {
          override visitPrimitive(): never {
            return this.throwShouldntCall("visitPrimitive");
          }
        }

        expect(() => new VisitInProgress(new Refusing()).visit(1, false))
          .toThrow(
            /Shouldn't happen: `visitPrimitive\(\)` called on `.*Refusing/,
          );
      });
    });
  });
});
