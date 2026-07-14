import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  isDeterministicCompileFailure,
  markDeterministicCompileFailure,
} from "../src/harness/compile-failure.ts";

describe("markDeterministicCompileFailure", () => {
  it("stamps and returns the same Error", () => {
    const error = new Error("guard throw");
    const marked = markDeterministicCompileFailure(error);
    assertEquals(marked, error);
    assertEquals(marked.message, "guard throw");
    assertEquals(isDeterministicCompileFailure(marked), true);
  });

  it("fails open for frozen errors and non-object throwables", () => {
    const frozen = Object.freeze(new Error("frozen"));
    assertEquals(markDeterministicCompileFailure(frozen), frozen);
    assertEquals(isDeterministicCompileFailure(frozen), false);
    assertEquals(markDeterministicCompileFailure("boom"), "boom");
    assertEquals(isDeterministicCompileFailure("boom"), false);
    assertEquals(markDeterministicCompileFailure(undefined), undefined);
    assertEquals(isDeterministicCompileFailure(undefined), false);
  });

  it("fails open when an exotic throwable rejects property access", () => {
    const throwingProxy = new Proxy({}, {
      get() {
        throw new Error("no property access");
      },
    });
    assertEquals(isDeterministicCompileFailure(throwingProxy), false);
  });

  it("cannot be forged with a same-named registry symbol or property", () => {
    const forged = Object.assign(new Error("transient"), {
      [Symbol.for("cf.deterministicCompileFailure")]: true,
      deterministicCompileFailure: true,
      "cf.deterministicCompileFailure": true,
    });
    assertEquals(isDeterministicCompileFailure(forged), false);
  });
});
