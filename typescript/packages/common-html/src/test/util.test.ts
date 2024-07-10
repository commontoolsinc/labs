import { equal as assertEqual } from "node:assert/strict";
import { isObject } from "../util.js";

describe("isObject", () => {
  it("returns false for null", () => {
    assertEqual(isObject(null), false);
  });

  it("returns false for functions", () => {
    const noOp = () => {};
    assertEqual(isObject(noOp), false);
  });

  it("returns true for object", () => {
    assertEqual(isObject({}), true);
  });

  class Foo {}

  it("returns true for class instance", () => {
    assertEqual(isObject(new Foo()), true);
  });

  it("(sadly) returns true for string instances created with the new String constructor", () => {
    assertEqual(isObject(new String("Foo")), true);
  });

  it("(sadly) returns true for number instances created with the new Number constructor", () => {
    assertEqual(isObject(new Number(10)), true);
  });
});
