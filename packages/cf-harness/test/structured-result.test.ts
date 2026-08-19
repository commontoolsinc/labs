/**
 * The sealed-position addressing walk: seals minted by the named
 * sanitization become the address `buildRef` states for their path, and
 * everything else — foreign seals, author-declared link objects, plain
 * values — passes through untouched.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { addressSealedPositions } from "../src/structured-result.ts";

const OUTPUT_ID = "run-1:run_pattern:3";
const seal = (fragment: string) => ({
  "@link": `opaque:${encodeURIComponent(OUTPUT_ID)}${fragment}`,
});
const buildRef = (path: readonly (string | number)[]) =>
  `/of:fid1:result/${path.join("/")}`;

describe("structured-result", () => {
  describe("addressSealedPositions()", () => {
    it("replaces a seal it minted with the address of its position", () => {
      const value = {
        count: 2,
        entries: [seal("#/entries/0"), seal("#/entries/1")],
        label: seal("#/label"),
      };
      expect(addressSealedPositions(value, OUTPUT_ID, buildRef)).toEqual({
        count: 2,
        entries: ["/of:fid1:result/entries/0", "/of:fid1:result/entries/1"],
        label: "/of:fid1:result/label",
      });
    });

    it("addresses a sealed root as the reference itself", () => {
      expect(
        addressSealedPositions(seal(""), OUTPUT_ID, () => "/of:fid1:result"),
      ).toBe("/of:fid1:result");
    });

    it("passes a foreign seal through untouched", () => {
      const foreign = { "@link": "opaque:other-run%3Arun_pattern%3A9#/x" };
      expect(addressSealedPositions({ x: foreign }, OUTPUT_ID, buildRef))
        .toEqual({ x: foreign });
    });

    it("passes plain values and non-seal objects through untouched", () => {
      const value = { n: 1, s: "text", nested: { "@link": 4 }, list: [true] };
      expect(addressSealedPositions(value, OUTPUT_ID, buildRef))
        .toEqual(value);
    });
  });
});
