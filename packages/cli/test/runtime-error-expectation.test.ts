import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  runtimeErrorExpectation,
  unmetRuntimeErrorExpectation,
} from "../lib/runtime-error-expectation.ts";

describe("runtime-error-expectation", () => {
  describe("runtimeErrorExpectation()", () => {
    it("returns `true`, a whole count, or a copy of a list of strings", () => {
      expect(runtimeErrorExpectation(true)).toBe(true);
      expect(runtimeErrorExpectation(3)).toBe(3);
      expect(runtimeErrorExpectation(["a", "b"])).toEqual(["a", "b"]);
    });

    it("returns `undefined` for an absent expectation or `false`", () => {
      expect(runtimeErrorExpectation(undefined)).toBeUndefined();
      expect(runtimeErrorExpectation(false)).toBeUndefined();
    });

    it("throws for anything else, naming the value", () => {
      for (const value of [null, -1, 1.5, "true", ["a", 1], {}]) {
        expect(() => runtimeErrorExpectation(value)).toThrow(
          "`expectRuntimeErrors` is `true`, a whole count, or a list of strings, not",
        );
      }
      expect(() => runtimeErrorExpectation("true")).toThrow('"true"');
    });
  });

  describe("unmetRuntimeErrorExpectation()", () => {
    it("returns `undefined` for `true` with some errors, and a reason with none", () => {
      expect(unmetRuntimeErrorExpectation(true, ["Error: x"])).toBeUndefined();
      expect(unmetRuntimeErrorExpectation(true, [])).toBe(
        "expected some runtime error(s), saw 0",
      );
    });

    it("returns `undefined` only for exactly the count expected, zero included", () => {
      expect(unmetRuntimeErrorExpectation(2, ["Error: a", "Error: b"]))
        .toBeUndefined();
      expect(unmetRuntimeErrorExpectation(2, ["Error: a"])).toBe(
        "expected 2 runtime error(s), saw 1",
      );
      expect(unmetRuntimeErrorExpectation(0, [])).toBeUndefined();
      expect(unmetRuntimeErrorExpectation(0, ["Error: a"])).toBe(
        "expected 0 runtime error(s), saw 1",
      );
    });

    it("returns `undefined` for an empty list only when no error fired", () => {
      expect(unmetRuntimeErrorExpectation([], [])).toBeUndefined();
      expect(unmetRuntimeErrorExpectation([], ["Error: a"])).toBe(
        "expected 0 runtime error(s), saw 1; unexpected: Error: a",
      );
    });

    it("returns `undefined` for a list each of whose strings one error contains, in any order", () => {
      expect(
        unmetRuntimeErrorExpectation(
          ["second refusal", "first refusal"],
          ["Error: first refusal\n  at a", "Error: second refusal\n  at b"],
        ),
      ).toBeUndefined();
    });

    it("returns the missing strings and the unclaimed errors, by their first line", () => {
      expect(
        unmetRuntimeErrorExpectation(
          ["first refusal", "second refusal"],
          ["Error: first refusal", "TypeError: x is undefined\n  at c"],
        ),
      ).toBe(
        'expected 2 runtime error(s), saw 2; none contains "second refusal"; ' +
          "unexpected: TypeError: x is undefined",
      );
    });

    it("returns a reason when one error would have to answer for two strings", () => {
      expect(
        unmetRuntimeErrorExpectation(["refusal", "refusal"], [
          "Error: refusal",
        ]),
      ).toBe('expected 2 runtime error(s), saw 1; none contains "refusal"');
    });

    it("returns `undefined` where a shorter string's error also holds a longer one", () => {
      expect(
        unmetRuntimeErrorExpectation(["refused", "message refused"], [
          "Error: message refused",
          "Error: refused",
        ]),
      ).toBeUndefined();
    });

    it("returns `undefined` where meeting the list moves a string to another error", () => {
      expect(
        unmetRuntimeErrorExpectation(["abcd", "cde"], [
          "Error: abcd cde",
          "Error: abcd one",
        ]),
      ).toBeUndefined();
    });

    it("returns `undefined` for an overlapping list whichever order its errors fire in", () => {
      const expected = ["message refused", "profile"];
      const errors = [
        "Error: message refused: profile",
        "Error: message refused",
      ];
      expect(unmetRuntimeErrorExpectation(expected, errors)).toBeUndefined();
      expect(unmetRuntimeErrorExpectation(expected, errors.toReversed()))
        .toBeUndefined();
    });
  });
});
