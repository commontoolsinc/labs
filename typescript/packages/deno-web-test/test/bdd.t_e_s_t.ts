import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";

describe("outer", () => {
  describe("inner", () => {
    it("inner test 1", () => {
      expect(1).toBe(1);
    });
    it("inner test 2", () => {
      expect(2).toBe(2);
    });
  });
});
