import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { testIdentityKey } from "@commonfabric/test-support/records";

import { census, unknownIdentity } from "./census.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import type { Suite } from "../test-topology/suite.ts";
import { loadTopology } from "../test-topology.ts";

/**
 * The repository, found from this file rather than from the process's
 * own directory: a package's tests run with that package as the working
 * directory, and the paths the topology reads are the repository's.
 */
const REPOSITORY = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
import { UNMEASURED_COST_SECONDS } from "./policy.ts";

/** A suite holding exactly what a case describes. */
function suite(partial: Partial<Suite> & { id: string }): Suite {
  return {
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs: ["deno"],
    units: [],
    unavailable: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
    ...partial,
  };
}

/** A manifest carrying exactly these entries. */
function manifestOf(entries: readonly Partial<ManifestEntry>[]): Manifest {
  return {
    schema: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    seed: "seed",
    commit: "c".repeat(40),
    runs: 1,
    dials: {},
    calibration: { setupCost: {}, suites: {}, unitOverhead: {}, prologue: 40 },
    entries: entries.map((entry) => ({
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1,
      score: 0.5,
      inputs: { catches: 0, mainCatches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
      ...entry,
    })),
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 0, digest: "" },
    coverageBaselines: [],
  };
}

describe("what a lane must run whatever the score says", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
  });

  it("runs a unit no manifest has ever seen", () => {
    const manifest = manifestOf([{}]);
    const { mandatory, manifest: seen } = census(
      [bakery],
      manifest,
      new Set(),
    );
    const key = testIdentityKey(
      unknownIdentity(bakery, "packages/bakery/proof.test.ts"),
    );
    expect(mandatory.get(key)).toBe("unknown");
    // It carries a stand-in entry, since the packer cannot place an
    // identity the manifest it was handed does not hold.
    const standing = seen.entries.find((entry) =>
      testIdentityKey(entry.test) === key
    );
    expect(standing?.unit).toBe("packages/bakery/proof.test.ts");
    expect(standing?.suite).toBe("workspace-unit");
  });

  it("runs every unit when there is no manifest at all", () => {
    const { mandatory } = census([bakery], undefined, new Set());
    expect(mandatory.size).toBe(2);
    expect([...mandatory.values()]).toEqual(["unknown", "unknown"]);
  });

  it("runs the identities of a unit the change touched", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const { mandatory } = census(
      [bakery],
      manifest,
      new Set(["packages/bakery/glaze.test.ts"]),
    );
    expect(
      mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "glaze > sets" }),
      ),
    ).toBe("changed");
    expect(
      mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "glaze > browns" }),
      ),
    ).toBe("changed");
  });

  it("asks a suite which of its units a change reaches", () => {
    // A unit that is not a path — a type-check group, a binary — is one
    // only its suite can map the diff onto, so the suite is asked rather
    // than the diff being matched against the unit's name.
    const binaries = suite({
      id: "binaries",
      mandatory: "changed",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["toolshed", "cf"],
      unitsForChange: (changed) =>
        changed.has("packages/shell/index.ts") ? ["toolshed"] : [],
    });
    const manifest = manifestOf([
      {
        test: { k: "gate", s: "repo", n: "build-binary toolshed" },
        suite: "binaries",
        unit: "toolshed",
      },
      {
        test: { k: "gate", s: "repo", n: "build-binary cf" },
        suite: "binaries",
        unit: "cf",
      },
    ]);
    const { mandatory } = census(
      [binaries],
      manifest,
      new Set(["packages/shell/index.ts"]),
    );
    expect(
      mandatory.get(
        testIdentityKey({ k: "gate", s: "repo", n: "build-binary toolshed" }),
      ),
    ).toBe("changed");
    expect(
      mandatory.get(
        testIdentityKey({ k: "gate", s: "repo", n: "build-binary cf" }),
      ),
    ).toBeUndefined();
  });

  it("runs every unit of a suite marked always", () => {
    const gates = suite({
      id: "repo-gates",
      mandatory: "always",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["deno-fmt"],
    });
    const manifest = manifestOf([{
      test: { k: "gate", s: "repo", n: "deno-fmt" },
      suite: "repo-gates",
      unit: "deno-fmt",
    }]);
    const { mandatory } = census([gates], manifest, new Set());
    expect([...mandatory.values()]).toEqual(["always"]);
  });

  it("says nothing about a unit a configuration declares unavailable", () => {
    const on = suite({
      id: "package-integration-on",
      variant: "server-execution",
      units: ["packages/oven/a.test.ts"],
      unavailable: [{
        unit: "packages/oven/a.test.ts",
        reason: "the surface it exercises has not landed",
      }],
    });
    const seen = census([on], undefined, new Set());
    expect(seen.mandatory.size).toBe(0);
    expect(seen.manifest.entries).toEqual([]);
  });

  it("keeps a unit whose unavailability names only one leaf", () => {
    // Every other identity in the file still runs, so taking the file
    // out would stop far more than the configuration asked to stop.
    const on = suite({
      id: "package-integration-on",
      variant: "server-execution",
      units: ["packages/oven/a.test.ts"],
      unavailable: [{
        unit: "packages/oven/a.test.ts",
        leafName: "bakes > slowly",
        reason: "the surface that step exercises has not landed",
      }],
    });
    expect(census([on], undefined, new Set()).mandatory.size).toBe(1);
  });
});

describe("the identity a unit nothing has recorded stands on", () => {
  const unit = "packages/oven/bakes.test.ts";
  const on = suite({
    id: "package-integration-opposite",
    variant: "server-execution",
    units: [unit],
  });
  const off = suite({ id: "package-integration", units: [unit] });

  it("carries the configuration its suite runs in", () => {
    expect(unknownIdentity(on, unit).v).toBe("server-execution");
    expect(unknownIdentity(off, unit).v).toBeUndefined();
  });

  it("keeps two configurations of one unit apart", () => {
    // A source file belongs to one default suite and one suite for each
    // non-default configuration, and those are separate execution
    // surfaces with separate histories. Were the stand-ins to collide,
    // one entry would stand for both, one of the two would be placed in
    // no lane, and the lane would exit zero having never run it.
    const seen = census([off, on], undefined, new Set());
    expect(seen.manifest.entries.length).toBe(2);
    expect(new Set(seen.mandatory.keys()).size).toBe(2);
    expect(seen.manifest.entries.map((entry) => entry.suite).toSorted())
      .toEqual(["package-integration", "package-integration-opposite"]);
  });

  it("refuses a stand-in whose name a real test already has", () => {
    // Vanishingly unlikely and cheap to refuse. What it costs to ignore
    // is a unit that goes into no lane while everything downstream
    // counts as though it had, which is a test that quietly stops
    // running.
    const collides = manifestOf([{
      test: {
        k: "unit",
        s: "bakery",
        n: `unrecorded ${"packages/oven/bakes.test.ts"}`,
      },
      unit: "packages/oven/somewhere-else.test.ts",
    }]);
    expect(() => census([off], collides, new Set())).toThrow("run nowhere");
  });

  it("gives the whole topology as many stand-ins as it has units", async () => {
    // The property above, over the repository's real suites rather than
    // over a pair built to show it.
    const suites = await loadTopology(REPOSITORY);
    const seen = census(suites, undefined, new Set());
    const available = suites.reduce(
      (total, suite) =>
        total + suite.units.length -
        suite.unavailable.filter((entry) => entry.leafName === undefined)
          .length,
      0,
    );
    expect(seen.manifest.entries.length).toBe(available);
    expect(new Set(seen.mandatory.keys()).size).toBe(available);
  });
});

describe("what the tree says and the manifest does not", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
    unavailable: [{
      unit: "packages/bakery/gone.test.ts",
      reason: "not in this configuration",
    }],
  });

  it("drops an entry naming a unit this tree does not have", () => {
    const stale = manifestOf([
      { unit: "packages/bakery/glaze.test.ts" },
      {
        test: { k: "unit", s: "bakery", n: "gone > entirely" },
        unit: "packages/bakery/gone.test.ts",
      },
      {
        test: { k: "unit", s: "bakery", n: "deleted > long ago" },
        unit: "packages/bakery/deleted.test.ts",
      },
    ]);
    const seen = census([bakery], stale, new Set());
    expect(seen.manifest.entries.map((entry) => entry.unit).toSorted())
      .toEqual([
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
      ]);
  });

  it("says nothing about an identity withheld that it cannot run", () => {
    const stale = manifestOf([{ unit: "packages/bakery/glaze.test.ts" }]);
    stale.withheld = [
      {
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        suite: "workspace-unit",
        reason: "flaky",
      },
      {
        test: { k: "unit", s: "bakery", n: "gone > entirely" },
        suite: "workspace-unit",
        reason: "flaky",
      },
    ];
    const seen = census([bakery], stale, new Set());
    expect(seen.manifest.withheld.map((held) => held.test.n))
      .toEqual(["glaze > sets"]);
  });

  it("charges an unmeasured unit what its suite's middle unit costs", () => {
    // Three units, holding one, three and one test. What a stand-in
    // stands for is a whole unit, so the middle of 2, 30 and 200 is what
    // it costs — not the middle of the seven tests inside them, which
    // would charge a new file a fraction of what running it takes.
    const wide = suite({
      id: "workspace-unit",
      units: [
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
        "packages/bakery/knead.test.ts",
        "packages/bakery/rest.test.ts",
      ],
    });
    const manifest = manifestOf([
      { unit: "packages/bakery/glaze.test.ts", cost: 2 },
      {
        test: { k: "unit", s: "bakery", n: "proof > rises" },
        unit: "packages/bakery/proof.test.ts",
        cost: 10,
      },
      {
        test: { k: "unit", s: "bakery", n: "proof > doubles" },
        unit: "packages/bakery/proof.test.ts",
        cost: 10,
      },
      {
        test: { k: "unit", s: "bakery", n: "proof > slumps" },
        unit: "packages/bakery/proof.test.ts",
        cost: 10,
      },
      {
        test: { k: "unit", s: "bakery", n: "knead > folds" },
        unit: "packages/bakery/knead.test.ts",
        cost: 200,
      },
    ]);
    const seen = census([wide], manifest, new Set());
    const standing = seen.manifest.entries.find((entry) =>
      entry.unit === "packages/bakery/rest.test.ts"
    );
    expect(standing?.cost).toBe(30);
  });

  it("replaces what the publisher's own tree said, and its packing", () => {
    const published = manifestOf([{ unit: "packages/bakery/glaze.test.ts" }]);
    published.unavailable = [{
      suite: "workspace-unit",
      unit: "packages/bakery/somewhere-else.test.ts",
      reason: "unavailable in the tree the publisher read",
    }];
    published.lanes = [{ lane: 1, projectedSeconds: 12, batches: [] }];
    published.unschedulable = [{
      test: { k: "unit", s: "bakery", n: "gone > entirely" },
      suite: "workspace-unit",
      cost: 900,
    }];
    const seen = census([bakery], published, new Set());
    expect(seen.manifest.unavailable.map((entry) => entry.unit))
      .toEqual(["packages/bakery/gone.test.ts"]);
    // A packing over a corpus this is not answers a different question.
    expect(seen.manifest.lanes).toEqual([]);
    expect(seen.manifest.unschedulable).toEqual([]);
    // What the store has seen is the store's figure, not this tree's.
    expect(seen.manifest.known).toEqual(published.known);
    expect(seen.manifest.calibration).toEqual(published.calibration);
    expect(seen.manifest.seed).toBe(published.seed);
  });

  it("charges a suite with nothing measured the unmeasured figure", () => {
    const seen = census([bakery], undefined, new Set());
    expect(seen.manifest.entries.map((entry) => entry.cost))
      .toEqual([UNMEASURED_COST_SECONDS, UNMEASURED_COST_SECONDS]);
  });
});
