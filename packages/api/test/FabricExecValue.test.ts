import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  FabricExecFunction,
  FabricExecValue,
  FabricValue,
} from "@commonfabric/api";
import type { FabricInstancePlus } from "@commonfabric/data-model/api";

// The assertions in this file are made when it is type-checked, not when it
// runs. The carrier below is a function that is never called: an assignment
// in it that must type-check pins a direction the type admits, and a
// `@ts-expect-error` marks one it must refuse -- if the refusal regresses, the
// directive becomes unused and the type check fails on it.

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
declare const execValue: FabricExecValue;
declare const plusInstance: FabricInstancePlus<FabricExecFunction>;
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

  // The alias is wider than the written-out recursion by one arm: an instance
  // whose contents may hold a function, which the alias admits and the
  // written-out recursion does not.
  const instanceArm: FabricExecValue = plusInstance;
  // @ts-expect-error a `FabricInstancePlus<FabricExecFunction>` is admitted only by the alias
  const toWrittenOut: WrittenOutExecValue = execValue;

  return {
    fromWrittenOut,
    bare,
    inArray,
    inRecord,
    instanceArm,
    toWrittenOut,
  };
}

describe("FabricExecValue", () => {
  it("admits the written-out recursion over `FabricValue` and `FabricExecFunction`, and is wider by the plus-instance arm", () => {
    // The type checker decides the claim; at run time only the carrier is
    // observable.
    expect(typeof fabricExecValueTypeChecks).toBe("function");
  });
});
