/**
 * The `describe` and `it` this repository's import map resolves to.
 *
 * What matters is that the wrapper is transparent: every way the real
 * ones can be called still registers, and a call the wrapper does not
 * model reaches the real function untouched rather than being dropped.
 * The shapes below are registered for real, which is the assertion — a
 * shape the wrapper mishandled would fail to register, or would register
 * a test with no body, and Deno would refuse the module.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bodyOf, nameOf } from "../../src/records/bdd.ts";

describe("bdd", () => {
  describe("the shapes a suite can be declared in", () => {
    // Nested by name and body, which is the ordinary form and the one
    // the chain tracking is built around.

    it("registers a leaf given a name and a body", () => {
      expect(true).toBe(true);
    });

    it({
      name: "registers a leaf given one whole definition",
      fn: () => {
        expect(true).toBe(true);
      },
    });

    it("registers a leaf given a name, options and a body", {
      sanitizeOps: true,
    }, () => {
      expect(true).toBe(true);
    });
  });

  describe({
    name: "a suite declared as one whole definition",
    fn: () => {
      it("still names its leaves by the whole chain", () => {
        expect(true).toBe(true);
      });
    },
  });

  describe("the entry points hanging off each of them", () => {
    it.ignore("is registered as ignored rather than dropped", () => {
      throw new Error("an ignored leaf does not run");
    });

    // `describe.skip` is `describe.ignore` under another name; a suite
    // registered through either still registers, and its leaves are
    // reported as skipped rather than vanishing.
    describe.ignore("a suite registered as ignored", () => {
      it("does not run", () => {
        throw new Error("an ignored suite's leaves do not run");
      });
    });
  });
});

describe("reading the shape of a bdd call", () => {
  const body = () => {};

  it("takes the name from a string, an options object, or a function", () => {
    expect(nameOf(["a name", body])).toBe("a name");
    expect(nameOf([{ name: "from options" }, body])).toBe("from options");
    expect(nameOf([function named() {}])).toBe("named");
    // An anonymous body names nothing, and a call this cannot name goes
    // to the real function untouched rather than being dropped.
    expect(nameOf([{}, () => {}])).toBeUndefined();
    expect(nameOf([])).toBeUndefined();
  });

  it("finds the body whether it is an argument or a field", () => {
    expect(bodyOf(["a name", body])).toEqual({ index: 1, body });
    // A definition carrying its own body is reported at index -1,
    // because what has to be replaced is the field rather than the
    // argument.
    expect(bodyOf([{ name: "x", fn: body }])).toEqual({ index: -1, body });
    expect(bodyOf(["a name"])).toBeUndefined();
  });
});
