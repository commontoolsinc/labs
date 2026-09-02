/**
 * The expected-posture spec, and the one thing it must never do: pass by
 * asserting nothing.
 *
 * A spec is the audit's only way to say what a deployment was supposed to be
 * at. A file that names no field, or names one nothing reads, checks nothing
 * while looking in every line of output exactly like a deployment that held.
 * That is the failure the parse refuses, on the same terms `scripts/cell-spec.ts`
 * refuses it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import {
  loadExpectedPosture,
  parseExpectedPosture,
  postureMismatches,
} from "../expected-posture.ts";

const PROFILES_DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "profiles",
);

const MAX_ENFORCEMENT_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:spec",
  cfcPosture: "max-enforcement",
});

const FLEET_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:spec",
});

describe("the expected-posture spec", () => {
  describe("what it refuses", () => {
    it("refuses a spec that asserts nothing", () => {
      expect(() => parseExpectedPosture({})).toThrow("asserts nothing");
    });

    it("refuses a spec whose only field is a label", () => {
      expect(() => parseExpectedPosture({ label: "empty" })).toThrow(
        "asserts nothing",
      );
    });

    it("refuses a field nothing reads", () => {
      expect(() => parseExpectedPosture({ enforcementModes: "enforce" }))
        .toThrow("nothing asserts");
    });

    it("refuses an empty ceilingedSinks, which every deployment satisfies", () => {
      expect(() => parseExpectedPosture({ ceilingedSinks: [] })).toThrow(
        "which every deployment satisfies",
      );
    });

    it("admits an empty ungatedSinks, which is the strongest claim it can make", () => {
      expect(parseExpectedPosture({ ungatedSinks: [] })).toEqual({
        ungatedSinks: [],
      });
    });

    it("refuses requireDeviationsPublished: false, which asserts nothing", () => {
      expect(() => parseExpectedPosture({ requireDeviationsPublished: false }))
        .toThrow("asserts something only as true");
    });

    it("refuses a spec that is not a JSON object", () => {
      expect(() => parseExpectedPosture([])).toThrow("must be a JSON object");
    });
  });

  describe("comparing a record against a spec", () => {
    it("finds nothing wrong with the record the profile describes", async () => {
      const spec = await loadExpectedPosture(
        join(PROFILES_DIR, "max-enforcement.json"),
      );
      expect(postureMismatches(spec, MAX_ENFORCEMENT_RECORD)).toEqual([]);
    });

    it("names every field the fleet posture misses against that profile", async () => {
      const spec = await loadExpectedPosture(
        join(PROFILES_DIR, "max-enforcement.json"),
      );
      const mismatches = postureMismatches(spec, FLEET_RECORD);
      expect(mismatches.map((mismatch) => mismatch.field)).toContain(
        "flowLabels",
      );
      expect(mismatches.map((mismatch) => mismatch.field)).toContain(
        "ceilingedSinks[fetchText]",
      );
    });

    it("names an ungated sink the spec does not permit ungated", () => {
      const spec = parseExpectedPosture({ ungatedSinks: ["llm"] });
      expect(
        postureMismatches(spec, MAX_ENFORCEMENT_RECORD)
          .map((mismatch) => mismatch.field),
      ).toEqual([
        "ungatedSinks[llmDialog]",
        "ungatedSinks[generateText]",
        "ungatedSinks[generateObject]",
      ]);
    });

    it("requires a deviation for every ungated sink when the spec asks", () => {
      const spec = parseExpectedPosture({ requireDeviationsPublished: true });
      // The fleet posture leaves the six network-fetch sinks ungated with no
      // recorded rationale, so nothing publishes them as deviations.
      expect(
        postureMismatches(spec, FLEET_RECORD)
          .map((mismatch) => mismatch.field),
      ).toEqual([
        "deviations[fetchBinary]",
        "deviations[fetchText]",
        "deviations[fetchJson]",
        "deviations[fetchJsonUnchecked]",
        "deviations[fetchProgram]",
        "deviations[streamData]",
      ]);
    });
  });
});
