import { describe, it } from "@std/testing/bdd";
import { path } from "../src/path.ts";
import * as assert from "./assert.ts";

describe("path", () => {
  it("does not mutate key path", () => {
    const obj = { a: { b: 1 } };
    const keys = ["a", "b"];
    const result = path(obj, keys);
    assert.equal(result, 1);
    assert.equal(keys[0], "a");
    assert.equal(keys[1], "b");
    assert.equal(keys.length, 2);
  });
});
