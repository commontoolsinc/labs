/**
 * The sealed-position addressing walk: the positions the sanitizer reports
 * having sealed become the address `buildRef` states for their path, and
 * everything else — including a caller-provided opaque link the sanitizer
 * preserved, which `sealedPaths` never lists — passes through untouched.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addressSealedPositions } from "../src/structured-result.ts";

const seal = (fragment: string) => ({
  "@link": `opaque:run-1%3Arun_pattern%3A3${fragment}`,
});
const buildRef = (path: readonly (string | number)[]) =>
  `/of:fid1:result/${path.join("/")}`;

describe("structured-result", () => {
  describe("addressSealedPositions()", () => {
    it("replaces each reported position with the address of its path", () => {
      const value = {
        count: 2,
        entries: [seal("#/entries/0"), seal("#/entries/1")],
        label: seal("#/label"),
      };
      const sealedPaths = [["entries", 0], ["entries", 1], ["label"]];
      expect(addressSealedPositions(value, sealedPaths, buildRef)).toEqual({
        count: 2,
        entries: ["/of:fid1:result/entries/0", "/of:fid1:result/entries/1"],
        label: "/of:fid1:result/label",
      });
    });

    it("addresses a sealed root as the reference itself", () => {
      expect(
        addressSealedPositions(seal(""), [[]], () => "/of:fid1:result"),
      ).toBe("/of:fid1:result");
    });

    it("leaves a preserved link alone because sealedPaths never names it", () => {
      // A caller-provided opaque link the schema admits is preserved by the
      // sanitizer — even one spelled with the sanitization's own handle id —
      // and does not appear in sealedPaths.
      const value = { evidence: seal("#/anything"), n: 1 };
      expect(addressSealedPositions(value, [], buildRef)).toEqual(value);
    });

    it("leaves the value unchanged for a path it does not hold", () => {
      const value = { list: [true], nested: { x: 1 }, n: 7 };
      expect(
        addressSealedPositions(value, [
          ["list", 5],
          ["nested", "y"],
          ["n", "x"],
        ], buildRef),
      ).toEqual(value);
    });
  });
});
