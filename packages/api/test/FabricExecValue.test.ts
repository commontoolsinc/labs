import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  FabricExecFunction,
  FabricExecValue,
  FabricValue,
} from "@commonfabric/api";

// The assertions in this file are made when it is type-checked, not when it
// runs. The carrier below is a function that is never called: each assignment
// in it pins a direction the type admits.

/**
 * The recursive shape `FabricExecValue` names, written out: a `FabricValue`,
 * a function, or a read-only tree of either.
 */
type WrittenOutExecValue =
  | FabricValue
  | FabricExecFunction
  | readonly WrittenOutExecValue[]
  | { readonly [key: string]: WrittenOutExecValue };

declare const writtenOut: WrittenOutExecValue;
declare const fn: FabricExecFunction;
declare const fnArray: readonly FabricExecFunction[];
declare const fnRecord: { readonly [key: string]: FabricExecFunction };

/** Carrier for the `FabricExecValue` checks. */
function fabricExecValueTypeChecks() {
  // The written-out recursion is admitted, and so is a function at the top
  // and inside each container.
  const fromWrittenOut: FabricExecValue = writtenOut;
  const bare: FabricExecValue = fn;
  const inArray: FabricExecValue = fnArray;
  const inRecord: FabricExecValue = fnRecord;

  return { fromWrittenOut, bare, inArray, inRecord };
}

describe("FabricExecValue", () => {
  it("admits the written-out recursion over `FabricValue` and `FabricExecFunction`", () => {
    // The type checker decides the claim; at run time only the carrier is
    // observable.
    expect(typeof fabricExecValueTypeChecks).toBe("function");
  });
});
