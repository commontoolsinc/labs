import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { testIdentityKey } from "@commonfabric/test-support/records";
import {
  batchesOf,
  everyBatch,
  mandatoryFor,
  manifestMoment,
  parseLaneArgs,
  unknownIdentity,
} from "./ci-lane.ts";
import type { Suite } from "./test-topology/suite.ts";
import type { Manifest, ManifestEntry } from "./test-selection/manifest.ts";

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
    calibration: {
      setupCost: {},
      suites: {},
      unitOverhead: {},
      prologue: 40,
    },
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

describe("reading the lane's command line", () => {
  it("takes the lane, its share, and the moment to resolve at", () => {
    const options = parseLaneArgs([
      "--lane",
      "3",
      "--of",
      "5",
      "--base",
      "origin/main",
      "--at",
      "2026-09-01T12:00:00Z",
    ], "/repo");
    expect(options?.lane).toBe(3);
    expect(options?.of).toBe(5);
    expect(options?.base).toBe("origin/main");
    expect(options?.at).toBe("2026-09-01T12:00:00Z");
  });

  it("refuses a lane outside the run it belongs to", () => {
    expect(parseLaneArgs(["--lane", "6", "--of", "5"])).toBeUndefined();
    expect(parseLaneArgs(["--lane", "0", "--of", "5"])).toBeUndefined();
  });

  it("refuses a flag it does not know", () => {
    expect(parseLaneArgs(["--shard", "1/5"])).toBeUndefined();
  });
});

describe("the moment a lane resolves its manifest at", () => {
  const lane = { lane: 1, of: 5, full: false, dryRun: false };

  /** A repository whose one commit was made at a moment a case chose. */
  async function repository(committed: string): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-commit-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: root,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_DATE: committed,
          GIT_COMMITTER_DATE: committed,
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${root}/a.txt`, "a");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "one");
    return root;
  }

  it("takes the commit's date, normalized to UTC", async () => {
    // Git writes the committer's own offset and manifest names carry
    // UTC, so the two are only comparable once this one is normalized.
    const root = await repository("2026-09-01T10:41:59-07:00");
    expect((await manifestMoment({ ...lane, root })).at).toBe(
      "2026-09-01T17:41:59.000Z",
    );
  });

  it("takes the same moment however many times a run is attempted", async () => {
    // The property the whole thing turns on: nothing about the moment
    // comes from the run, so a re-run resolves what the first attempt
    // resolved.
    const root = await repository("2026-09-01T10:41:59-07:00");
    const first = await manifestMoment({ ...lane, root });
    const again = await manifestMoment({ ...lane, root });
    expect(again.at).toBe(first.at);
    expect(first.note).toBeUndefined();
  });

  it("lets a caller ask about a moment that is not this tree's", async () => {
    const root = await repository("2026-09-01T10:41:59-07:00");
    const moment = await manifestMoment({
      ...lane,
      root,
      at: "2026-08-01T00:00:00.000Z",
    });
    expect(moment.at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to the newest manifest outside a repository, and says so", async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-nogit-" });
    const moment = await manifestMoment({ ...lane, root });
    expect(moment.note).toContain("cannot read the commit's date");
    expect(Number.isNaN(new Date(moment.at).getTime())).toBe(false);
  });
});

describe("what a lane must run whatever the score says", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
  });

  it("runs a unit no manifest has ever seen", () => {
    const manifest = manifestOf([{}]);
    const { mandatory, unknown } = mandatoryFor([bakery], manifest, new Set());
    const key = testIdentityKey(
      unknownIdentity(bakery, "packages/bakery/proof.test.ts"),
    );
    expect(mandatory.get(key)).toBe("unknown");
    expect(unknown.get(key)).toEqual({
      suite: "workspace-unit",
      unit: "packages/bakery/proof.test.ts",
    });
  });

  it("runs every unit when there is no manifest at all", () => {
    const { mandatory } = mandatoryFor([bakery], undefined, new Set());
    expect(mandatory.size).toBe(2);
    expect([...mandatory.values()]).toEqual(["unknown", "unknown"]);
  });

  it("runs the identities of a unit the change touched", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const { mandatory } = mandatoryFor(
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
    const { mandatory } = mandatoryFor([gates], manifest, new Set());
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
    expect(mandatoryFor([on], undefined, new Set()).mandatory.size).toBe(0);
  });
});

describe("turning a lane's selections into batches", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts"],
  });

  it("skips the identities inside a chosen unit that were not chosen", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: ["glaze > browns"],
    }]);
  });

  it("skips nothing when every identity of a unit was chosen", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches[0]!.units[0]!.skip).toEqual([]);
  });

  it("takes the most runs any identity in the batch asked for", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 3,
    }]);
    expect(batches[0]!.repeats).toBe(3);
  });
});

describe("running everything", () => {
  it("gives each lane its own share and no unit twice", () => {
    const suites = [
      suite({
        id: "workspace-unit",
        units: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
      }),
    ];
    const lanes = [1, 2, 3].map((lane) => everyBatch(suites, lane, 3));
    const placed = lanes.flatMap((batches) =>
      batches.flatMap((batch) => batch.units.map((unit) => unit.unit))
    );
    expect(placed.toSorted()).toEqual([
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
    ]);
  });

  it("leaves out a unit a configuration declares unavailable", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{ unit: "a.test.ts", reason: "not landed yet" }],
      }),
    ];
    expect(everyBatch(suites, 1, 1)[0]!.units.map((unit) => unit.unit))
      .toEqual(["b.test.ts"]);
  });
});
