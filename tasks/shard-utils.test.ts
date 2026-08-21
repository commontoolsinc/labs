import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseShard } from "./shard-utils.ts";

describe("shard-utils", () => {
  describe("parseShard()", () => {
    it("returns the index and total of shard notation", () => {
      expect(parseShard("2/5")).toEqual({ index: 2, total: 5 });
      expect(parseShard("9007199254740991/9007199254740991")).toEqual({
        index: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
      });
    });

    it("throws given notation that is not two positive integers", () => {
      for (const raw of ["", "1", "1/", "/4", "0/4", "1/0", "a/b", "1.5/4"]) {
        expect(() => parseShard(raw)).toThrow("Expected shard argument");
      }
    });

    it("throws given an index past the total", () => {
      expect(() => parseShard("6/5")).toThrow(
        "Shard index 6 exceeds total shard count 5",
      );
    });

    it("throws given an index or total that is not a safe integer", () => {
      const enormous = "9".repeat(400);
      for (
        const raw of [
          "1/9007199254740992",
          "9007199254740992/9007199254740992",
          "9007199254740993/9007199254740992",
          `${enormous}/${enormous}`,
        ]
      ) {
        expect(() => parseShard(raw)).toThrow("safe integers");
      }
    });
  });
});
