import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  isDeterministicCompileFailure,
  markDeterministicCompileFailure,
} from "../src/harness/compile-failure.ts";

describe("markDeterministicCompileFailure", () => {
  it("stamps and returns the same Error", () => {
    const error = new Error("guard throw");
    const marked = markDeterministicCompileFailure(error);
    expect(marked).toBe(error);
    expect(marked.message).toBe("guard throw");
    expect(isDeterministicCompileFailure(marked)).toBe(true);
  });

  it("fails open for frozen errors and non-object throwables", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(markDeterministicCompileFailure(frozen)).toBe(frozen);
    expect(isDeterministicCompileFailure(frozen)).toBe(false);
    expect(markDeterministicCompileFailure("boom")).toBe("boom");
    expect(isDeterministicCompileFailure("boom")).toBe(false);
    expect(markDeterministicCompileFailure(undefined)).toBe(undefined);
    expect(isDeterministicCompileFailure(undefined)).toBe(false);
  });

  it("fails open for allocation failures", () => {
    const v8Style = new RangeError("Array buffer allocation failed");
    expect(markDeterministicCompileFailure(v8Style)).toBe(v8Style);
    expect(isDeterministicCompileFailure(v8Style)).toBe(false);
    const jscStyle = new Error("Out of memory");
    expect(markDeterministicCompileFailure(jscStyle)).toBe(jscStyle);
    expect(isDeterministicCompileFailure(jscStyle)).toBe(false);
  });

  it("still marks a stack overflow", () => {
    const overflow = new RangeError("Maximum call stack size exceeded");
    markDeterministicCompileFailure(overflow);
    expect(isDeterministicCompileFailure(overflow)).toBe(true);
  });

  it("fails open when an exotic throwable rejects property access", () => {
    const throwingProxy = new Proxy({}, {
      get() {
        throw new Error("no property access");
      },
    });
    expect(isDeterministicCompileFailure(throwingProxy)).toBe(false);
  });

  it("cannot be forged with a same-named registry symbol or property", () => {
    const forged = Object.assign(new Error("transient"), {
      [Symbol.for("cf.deterministicCompileFailure")]: true,
      deterministicCompileFailure: true,
      "cf.deterministicCompileFailure": true,
    });
    expect(isDeterministicCompileFailure(forged)).toBe(false);
  });
});
