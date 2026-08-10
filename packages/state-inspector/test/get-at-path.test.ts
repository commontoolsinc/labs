import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { getAtPath, selectAtPath } from "../reconstruct.ts";

describe("getAtPath()", () => {
  it("returns the root for an empty path", () => {
    const root = { value: "root" };
    expect(getAtPath(root, [])).toBe(root);
  });

  it("returns values at canonical array indexes", () => {
    expect(getAtPath(["zero", "one"], ["1"])).toBe("one");
  });

  it("returns `undefined` for noncanonical array segments", () => {
    const array = ["zero", "one"];
    for (const segment of ["", "01", "1e0", "-", "length"]) {
      expect(getAtPath(array, [segment])).toBeUndefined();
    }
  });

  it("reads only own array indexes and object properties", () => {
    const sparse = new Array<string>(1);
    const arrayPrototype = Object.create(Array.prototype) as string[];
    arrayPrototype[0] = "inherited";
    Object.setPrototypeOf(sparse, arrayPrototype);
    expect(getAtPath(sparse, ["0"])).toBeUndefined();

    expect(getAtPath({}, ["toString"])).toBeUndefined();
    expect(getAtPath({ toString: "own" }, ["toString"])).toBe("own");
    expect(getAtPath({ "": "empty" }, [""])).toBe("empty");
  });

  it("distinguishes stored undefined from a missing property", () => {
    expect(selectAtPath({ value: undefined }, ["value"])).toEqual({
      found: true,
      value: undefined,
    });
    expect(selectAtPath({}, ["value"])).toEqual({
      found: false,
      value: undefined,
    });
  });
});
