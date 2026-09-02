import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
} from "./selection.ts";
import { sampleManifest } from "./selection-testing.ts";

const TEST = { k: "unit", s: "memory", n: "space > writes" };
const CALIBRATION = {
  setupCost: {},
  suites: {},
  unitOverhead: {},
  prologue: 0,
};

describe("selection", () => {
  describe("parseManifest()", () => {
    it("round-trips a manifest through its serialization", () => {
      const manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });

    it("returns undefined for a schema version it does not know", () => {
      const ahead = {
        ...sampleManifest(),
        schema: MANIFEST_SCHEMA_VERSION + 1,
      };
      expect(parseManifest(JSON.stringify(ahead))).toBeUndefined();
    });

    it("returns undefined rather than obeying part of a manifest", () => {
      const manifest = sampleManifest();
      // Written into the JSON rather than the object: `JSON.stringify`
      // turns a NaN into null, so a test that sets one never reaches the
      // validator with the value it meant to.
      const text = JSON.stringify(manifest).replace(
        '"cost":0.05',
        '"cost":"free"',
      );
      expect(text).toContain('"cost":"free"');
      expect(parseManifest(text)).toBeUndefined();
    });

    it("returns undefined for text that is not JSON", () => {
      expect(parseManifest("{not json")).toBeUndefined();
      expect(parseManifest("[]")).toBeUndefined();
      expect(parseManifest(7)).toBeUndefined();
    });

    it("rejects an identity that appears twice", () => {
      const manifest = sampleManifest();
      manifest.entries.push({ ...manifest.entries[0]! });
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });

    it("keeps a variant apart from the default it shadows", () => {
      const manifest = sampleManifest();
      manifest.entries.push({
        ...manifest.entries[0]!,
        test: { ...manifest.entries[0]!.test, v: "server-execution" },
      });
      const parsed = parseManifest(JSON.stringify(manifest));
      expect(parsed?.entries.length).toBe(manifest.entries.length);
      expect(parsed?.entries.at(-1)?.test.v).toBe("server-execution");
    });

    it("rejects a repeat count nothing can run", () => {
      const manifest = sampleManifest();
      manifest.entries[0]!.repeats = 1.5;
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });

    it("rejects a flake rate that is not a share of runs", () => {
      // A negative rate sits under the exclusion threshold and would stay
      // selectable, which is the direction a corrupt manifest must not go.
      for (const flakeRate of [-1, 1.5]) {
        const manifest = sampleManifest();
        manifest.entries[0]!.flakeRate = flakeRate;
        expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
      }
    });

    it("rejects a generation time that is not one", () => {
      // A reader measures a manifest's age from this, and a value that
      // does not parse compares false against every threshold, so a
      // corrupt manifest would read as freshly generated forever.
      for (const generatedAt of ["", "yesterday", "2026-13-45T00:00:00.000Z"]) {
        const manifest = { ...sampleManifest(), generatedAt };
        expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
      }
    });

    it("rejects a correction that would make everything free", () => {
      const manifest = sampleManifest();
      manifest.calibration.suites["workspace-unit"] = {
        overhead: 0,
        correction: 0,
      };
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });
  });

  describe("what a manifest may not contain", () => {
    /** The manifest with one field replaced, as text the validator reads. */
    const withField = (
      field: string,
      value: unknown,
      into: "manifest" | "entry" = "manifest",
    ) => {
      const manifest = sampleManifest() as unknown as Record<string, unknown>;
      if (into === "manifest") manifest[field] = value;
      else {
        (manifest.entries as Record<string, unknown>[])[0]![field] = value;
      }
      return JSON.stringify(manifest);
    };

    // Every one of these is a shape a corrupt or newer writer could
    // produce, and each rejects the object whole rather than leaving a
    // reader obeying the rest of it.
    const rejected: Array<[string, string]> = [
      ["a seed that is not one", withField("seed", "")],
      ["a commit that is not one", withField("commit", 7)],
      ["a run count below zero", withField("runs", -1)],
      ["dials that are not a record", withField("dials", [])],
      [
        "a known count below zero",
        withField("known", { count: -1, digest: "d" }),
      ],
      [
        "a known digest that is not one",
        withField("known", { count: 0, digest: "" }),
      ],
      ["an attribution map that is not a name", withField("attributionMap", 7)],
      ["entries that are not a list", withField("entries", {})],
      ["withheld that is not a list", withField("withheld", {})],
      [
        "a withheld reason nobody wrote",
        withField("withheld", [{
          test: { k: "a", s: "b", n: "c" },
          suite: "s",
          reason: "why",
        }]),
      ],
      [
        "an unavailable entry with no reason",
        withField("unavailable", [{ suite: "s", unit: "u" }]),
      ],
      [
        "an unschedulable cost below zero",
        withField("unschedulable", [{
          test: { k: "a", s: "b", n: "c" },
          suite: "s",
          cost: -1,
        }]),
      ],
      [
        "a lane numbered below one",
        withField("lanes", [{ lane: 0, projectedSeconds: 0, batches: [] }]),
      ],
      [
        "a lane with no projected time",
        withField("lanes", [{ lane: 1, batches: [] }]),
      ],
      [
        "a lane batch that is not one",
        withField("lanes", [{
          lane: 1,
          projectedSeconds: 0,
          batches: [{ suite: "s" }],
        }]),
      ],
      [
        "a baseline with no member",
        withField("coverageBaselines", [{
          commit: "c",
          day: "2026-08-20",
          uncoveredLines: 0,
        }]),
      ],
      [
        "a setup cost below zero",
        withField("calibration", {
          setupCost: { a: -1 },
          suites: {},
          unitOverhead: {},
          prologue: 0,
        }),
      ],
      [
        "a prologue below zero",
        withField("calibration", {
          setupCost: {},
          suites: {},
          unitOverhead: {},
          prologue: -1,
        }),
      ],
      [
        "a suite overhead below zero",
        withField("calibration", {
          setupCost: {},
          suites: { s: { overhead: -1, correction: 1 } },
          unitOverhead: {},
          prologue: 0,
        }),
      ],
      [
        "an identity with no name",
        withField("test", { k: "a", s: "b" }, "entry"),
      ],
      [
        "an identity variant that is empty",
        withField("test", { k: "a", s: "b", n: "c", v: "" }, "entry"),
      ],
      ["a suite that is not a name", withField("suite", "", "entry")],
      ["a unit that is not a name", withField("unit", 7, "entry")],
      ["a cost below zero", withField("cost", -1, "entry")],
      ["a score that is not a number", withField("score", "high", "entry")],
      ["inputs that are not a record", withField("inputs", 7, "entry")],
      [
        "a churn that is not a number",
        withField("inputs", {
          catches: 0,
          mainCatches: 0,
          sources: 0,
          churn: "some",
        }, "entry"),
      ],
      [
        "a last catch that is not a day",
        withField("inputs", {
          catches: 0,
          mainCatches: 0,
          sources: 0,
          churn: 0,
          lastCatch: 7,
        }, "entry"),
      ],
      [
        "an independence flag that is not one",
        withField("independent", "yes", "entry"),
      ],
      [
        "a last run that is not a day",
        withField("lastRun", 7, "entry"),
      ],
      [
        "a last run that names no day at all",
        withField("lastRun", "", "entry"),
      ],

      // The lists a manifest carries beside its entries. Each has its own
      // reader, and each rejects the manifest whole.
      ["an unavailable list that is not one", withField("unavailable", 7)],
      [
        "an unavailable entry that is not a record",
        withField("unavailable", [7]),
      ],
      [
        "an unavailable entry with no suite",
        withField("unavailable", [{ suite: "", unit: "u", reason: "r" }]),
      ],
      [
        "an unavailable entry with no unit",
        withField("unavailable", [{ suite: "s", reason: "r" }]),
      ],
      [
        "an unavailable entry with no reason",
        withField("unavailable", [{ suite: "s", unit: "u", reason: 7 }]),
      ],
      [
        "an unavailable variant that is present and empty",
        withField("unavailable", [
          { suite: "s", unit: "u", reason: "r", variant: "" },
        ]),
      ],
      [
        "an unavailable leaf name that is not one",
        withField("unavailable", [
          { suite: "s", unit: "u", reason: "r", leafName: 7 },
        ]),
      ],
      [
        "an unavailable phase that is not one",
        withField("unavailable", [
          { suite: "s", unit: "u", reason: "r", phase: "" },
        ]),
      ],

      // The generation time, which is what a reader measures a manifest's
      // age from, and a value that is not a date compares false against
      // every threshold.
      ["a generation time that is not a string", withField("generatedAt", 7)],
      [
        "a generation time that is only a day",
        withField("generatedAt", "2026-08-20"),
      ],
      [
        "a generation time no calendar has",
        withField("generatedAt", "2026-99-20T00:00:00.000Z"),
      ],

      // The withheld list, which is what a lane reads to say why a test
      // it can see is one it must not run.
      ["an entry that is not a record", withField("entries", [7])],
      ["a withheld entry that is not a record", withField("withheld", [7])],
      [
        "a withheld entry with no identity",
        withField("withheld", [{ suite: "s", reason: "flaky" }]),
      ],
      [
        "a withheld entry with no suite",
        withField("withheld", [{ test: TEST, suite: "", reason: "flaky" }]),
      ],
      ["an unschedulable list that is not one", withField("unschedulable", 7)],
      [
        "an unschedulable entry that is not a record",
        withField("unschedulable", ["heavy"]),
      ],
      [
        "an unschedulable entry with no identity",
        withField("unschedulable", [{ suite: "s", cost: 400 }]),
      ],
      [
        "an unschedulable entry with no suite",
        withField("unschedulable", [{ test: TEST, suite: "", cost: 400 }]),
      ],
      [
        "an unschedulable cost that is not a number",
        withField("unschedulable", [{ test: TEST, suite: "s", cost: "lots" }]),
      ],

      // The calibration, which is what turns a planned second into the
      // second a lane really pays.
      ["a calibration that is not a record", withField("calibration", 7)],
      [
        "a setup cost that is not a record",
        withField("calibration", { ...CALIBRATION, setupCost: 7 }),
      ],
      [
        "a setup cost that is not a number",
        withField("calibration", {
          ...CALIBRATION,
          setupCost: { toolshed: "a while" },
        }),
      ],
      [
        "a suites map that is not a record",
        withField("calibration", { ...CALIBRATION, suites: [] }),
      ],
      [
        "a fitted suite that is not a record",
        withField("calibration", { ...CALIBRATION, suites: { unit: 7 } }),
      ],
      [
        "a suite overhead that is not a number",
        withField("calibration", {
          ...CALIBRATION,
          suites: { unit: { overhead: "some", correction: 1 } },
        }),
      ],
      [
        "a suite correction that is not a number",
        withField("calibration", {
          ...CALIBRATION,
          suites: { unit: { overhead: 0, correction: null } },
        }),
      ],
      [
        "a unit overhead that is not a record",
        withField("calibration", { ...CALIBRATION, unitOverhead: 7 }),
      ],
      [
        "a prologue that is not a number",
        withField("calibration", { ...CALIBRATION, prologue: "quick" }),
      ],

      // The lanes, which are what a runner is pointed at.
      ["a lane list that is not one", withField("lanes", 7)],
      ["a lane that is not a record", withField("lanes", [1])],
      [
        "a lane number that is not one",
        withField("lanes", [{ lane: "one", projectedSeconds: 2, batches: [] }]),
      ],
      [
        "a projection that is not a number",
        withField("lanes", [{ lane: 1, projectedSeconds: "2s", batches: [] }]),
      ],
      [
        "lane batches that are not a list",
        withField("lanes", [{ lane: 1, projectedSeconds: 2, batches: {} }]),
      ],
      [
        "a batch that is not a record",
        withField("lanes", [{ lane: 1, projectedSeconds: 2, batches: ["u"] }]),
      ],
      [
        "a batch with no suite",
        withField("lanes", [{
          lane: 1,
          projectedSeconds: 2,
          batches: [{ suite: "", identities: [] }],
        }]),
      ],
      [
        "a batch identity that is not a key",
        withField("lanes", [{
          lane: 1,
          projectedSeconds: 2,
          batches: [{ suite: "unit", identities: [7] }],
        }]),
      ],

      // The coverage baselines, which are what the gate measures against.
      ["a baseline list that is not one", withField("coverageBaselines", 7)],
      [
        "a baseline that is not a record",
        withField("coverageBaselines", ["packages/memory"]),
      ],
    ];

    for (const [what, text] of rejected) {
      it(`refuses ${what}`, () => {
        expect(parseManifest(text)).toBeUndefined();
      });
    }

    it("accepts the optional fields when they are well formed", () => {
      const manifest = sampleManifest({
        attributionMap: "labs/test-selection/v1/map-1.json",
        unavailable: [{
          suite: "s",
          unit: "u",
          reason: "declared",
          variant: "on",
          leafName: "a leaf",
          phase: "compile",
        }],
        coverageBaselines: [{
          member: "packages/memory",
          commit: "c",
          day: "2026-08-20",
          uncoveredLines: 3,
        }],
        withheld: [{
          test: TEST,
          suite: "workspace-unit",
          reason: "main-red",
        }],
        unschedulable: [{
          test: TEST,
          suite: "pattern-integration",
          cost: 420.5,
        }],
        calibration: {
          setupCost: { toolshed: 60 },
          suites: { "pattern-integration": { overhead: 50, correction: 1.2 } },
          unitOverhead: { "packages/patterns/one.test.ts": 10 },
          prologue: 3,
        },
        lanes: [{
          lane: 1,
          projectedSeconds: 2,
          batches: [{
            suite: "workspace-unit",
            identities: [JSON.stringify(["unit", "memory", "space > writes"])],
          }],
        }],
      });
      manifest.entries[0]!.independent = true;
      manifest.entries[0]!.lastRun = "2026-08-20";
      manifest.entries[0]!.inputs.lastCatch = "2026-08-20";
      expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });
  });

  describe("digestIdentities()", () => {
    it("agrees whatever order the identities were walked in", () => {
      const keys = ["a", "b", "c"];
      expect(digestIdentities(keys)).toBe(
        digestIdentities([...keys].reverse()),
      );
    });

    it("changes when the set changes", () => {
      expect(digestIdentities(["a", "b"])).not.toBe(
        digestIdentities(["a", "b", "c"]),
      );
    });

    it("has a digest for the empty set", () => {
      expect(digestIdentities([]).length).toBeGreaterThan(0);
    });
  });

  describe("the sample fixture", () => {
    it("is a manifest the validator accepts", () => {
      const manifest: Manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))).toBeDefined();
    });
  });
});
