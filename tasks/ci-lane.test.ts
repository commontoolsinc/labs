import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { testIdentityKey } from "@commonfabric/test-support/records";
import { loadTopology } from "./test-topology.ts";

/**
 * The repository, found from this file rather than from the process's
 * own directory: a package's tests run with that package as the working
 * directory, and the paths the topology reads are the repository's.
 */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
import {
  batchesOf,
  changedFiles,
  describePlan,
  everyBatch,
  mandatoryFor,
  manifestMoment,
  parseLaneArgs,
  runBatch,
  runInvocation,
  runLane,
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
    const { mandatory } = mandatoryFor(
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
    expect(mandatoryFor([on], undefined, new Set()).mandatory.size).toBe(1);
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

  it("keeps a unit whose unavailability names only one leaf", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{
          unit: "a.test.ts",
          leafName: "bakes > slowly",
          reason: "that step's surface has not landed",
        }],
      }),
    ];
    expect(everyBatch(suites, 1, 1)[0]!.units.map((unit) => unit.unit))
      .toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("running a lane's work", () => {
  const lane = { lane: 1, of: 5, full: false, dryRun: false, root: REPOSITORY };

  /** A suite that runs the command a case gives it. */
  function runnable(command: readonly string[], id = "probe"): Suite {
    return suite({
      id,
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{ command: [...command], cwd: context.root }]),
    });
  }

  it("reports what an invocation cost and whether it passed", async () => {
    const ok = await runInvocation(
      { command: [Deno.execPath(), "eval", "0"], cwd: Deno.cwd() },
      {},
    );
    expect(ok.ok).toBe(true);
    expect(ok.seconds).toBeGreaterThan(0);
    const bad = await runInvocation(
      { command: [Deno.execPath(), "eval", "Deno.exit(3)"], cwd: Deno.cwd() },
      {},
    );
    expect(bad.ok).toBe(false);
  });

  it("runs a batch once per repeat, and every one must pass", async () => {
    // A repeat is not a retry: three runs of a test is strictly stricter
    // than one, so a batch that fails once has failed.
    const workDir = await Deno.makeTempDir({ prefix: "lane-batch-" });
    const passing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "0"]),
        units: [],
        repeats: 3,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(passing.ok).toBe(true);

    const failing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "Deno.exit(1)"], "red"),
        units: [],
        repeats: 2,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(failing.ok).toBe(false);
    await Deno.remove(workDir, { recursive: true });
  });

  it("keeps the records a batch's producers wrote", async () => {
    // Each execution writes into a spool of its own and is gathered
    // before another can reuse a runner-owned path.
    const workDir = await Deno.makeTempDir({ prefix: "lane-records-" });
    const written = JSON.stringify({
      line: "record",
      test: { k: "gate", s: "repo", n: "probe" },
      outcome: "pass",
      durationMs: 1,
    });
    const result = await runBatch(
      {
        suite: runnable([
          Deno.execPath(),
          "eval",
          `Deno.writeTextFileSync(
            Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
            ${JSON.stringify(written + "\n")},
          )`,
        ]),
        units: [],
        repeats: 1,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(result.records.map((record) => record.test.n)).toEqual(["probe"]);
    await Deno.remove(workDir, { recursive: true });
  });

  it("says which manifest it read and what it will run", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [{
          suite: runnable(["true"], "workspace-unit"),
          units: [],
          repeats: 2,
        }],
        ["deno", "toolshed"],
        { objectName: "manifest-x.json.gz" },
        ["binaries: build-binary toolshed costs 900s"],
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("manifest-x.json.gz");
    expect(printed).toContain("deno, toolshed");
    expect(printed).toContain("workspace-unit");
    // What no lane can hold is named rather than left silently absent.
    expect(printed).toContain("build-binary toolshed");
  });

  it("says it is running unselected when there is no manifest", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(lane, [], [], { absent: "the store is unreachable" });
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("the store is unreachable");
  });
});

describe("planning a lane without running it", () => {
  it("plans the full run against the working tree", async () => {
    // The full run switches selection off, so this reaches the topology
    // and the packing without a manifest or a store.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 2,
        of: 5,
        full: true,
        dryRun: true,
        root: REPOSITORY,
      });
    } finally {
      console.log = log;
    }
    expect(ok).toBe(true);
    const printed = lines.join("\n");
    expect(printed).toContain("Lane 2 of 5");
    expect(printed).toContain("running everything");
    // A lane's share of the full run is a real share of real suites.
    expect(printed).toContain("workspace-unit");
  });
});

describe("planning a lane the manifest chose", () => {
  const root = REPOSITORY;

  /** What a lane prints, with the store answering as a case describes. */
  async function planned(
    entries: readonly Partial<ManifestEntry>[],
    lane = 1,
  ): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane,
          of: 5,
          full: false,
          dryRun: true,
          root,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              manifest: manifestOf(entries),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    return lines.join("\n");
  }

  it("names the manifest it planned from", async () => {
    const printed = await planned([]);
    expect(printed).toContain("manifest-fixture.json.gz");
  });

  it("gives the five lanes the whole corpus, and no unit twice", async () => {
    // Every lane packs the same manifest over the same inputs and takes
    // its own share, so the five partition the work by construction
    // rather than by anything coordinating them.
    const counted = (printed: string): number =>
      printed.split("\n")
        .map((line) => /^\| \S+ \| (\d+) \| \d+ \|$/.exec(line))
        .reduce((total, row) => total + (row === null ? 0 : Number(row[1])), 0);
    let placed = 0;
    for (const lane of [1, 2, 3, 4, 5]) {
      placed += counted(await planned([], lane));
    }
    const suites = await loadTopology(root);
    const available = suites.reduce(
      (total, suite) =>
        total + suite.units.length -
        suite.unavailable.filter((entry) => entry.leafName === undefined)
          .length,
      0,
    );
    expect(placed).toBe(available);
  });

  it("runs everything when the store has no manifest to give", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        { lane: 1, of: 5, full: false, dryRun: true, root },
        { manifest: () => Promise.resolve({ absent: "the store is gone" }) },
      );
    } finally {
      console.log = log;
    }
    // A lane with no manifest runs the mandatory set plus a
    // deterministic slice rather than failing, so pull requests keep
    // flowing while the store is unreachable.
    const printed = lines.join("\n");
    expect(printed).toContain("the store is gone");
    expect(printed).toContain("workspace-unit");
  });
});

describe("the lane's own housekeeping", () => {
  const root = REPOSITORY;

  it("reads the two flags that carry no value", () => {
    const options = parseLaneArgs(["--full", "--dry-run", "--lane", "2"]);
    expect(options?.full).toBe(true);
    expect(options?.dryRun).toBe(true);
    expect(parseLaneArgs(["--base"])).toBeUndefined();
  });

  it("takes the files a change touched from the diff", async () => {
    const repo = await Deno.makeTempDir({ prefix: "lane-diff-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: repo,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${repo}/kept.ts`, "a");
    await git("add", ".");
    await git("commit", "-q", "-m", "first");
    await git("branch", "base");
    await Deno.writeTextFile(`${repo}/added.test.ts`, "b");
    await git("add", ".");
    await git("commit", "-q", "-m", "second");
    expect([...await changedFiles(repo, "base")]).toEqual(["added.test.ts"]);
    // With no base there is no change to speak of, which is what the
    // full run on `main` asks for.
    expect([...await changedFiles(repo, undefined)]).toEqual([]);
    // A diff that cannot be taken is not a change-free pull request:
    // reading it as one would drop every changed unit without a word.
    await expect(changedFiles(repo, "no-such-ref")).rejects.toThrow(
      "cannot diff",
    );
    await Deno.remove(repo, { recursive: true });
  });

  it("writes the plan into the job summary as well as the log", async () => {
    const summary = await Deno.makeTempFile({ prefix: "summary-" });
    const previous = Deno.env.get("GITHUB_STEP_SUMMARY");
    Deno.env.set("GITHUB_STEP_SUMMARY", summary);
    const log = console.log;
    console.log = () => {};
    try {
      describePlan(
        { lane: 1, of: 5, full: false, dryRun: true, root },
        [],
        [],
        { objectName: "manifest-x.json.gz" },
      );
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
      else Deno.env.set("GITHUB_STEP_SUMMARY", previous);
    }
    expect(await Deno.readTextFile(summary)).toContain("manifest-x.json.gz");
    await Deno.remove(summary);
  });

  it("runs a lane that was given no share of the work", async () => {
    // The whole path, with nothing in it: no capability is opened, no
    // batch runs, and the directory the lane made for itself goes.
    const before = new Set<string>();
    for await (const entry of Deno.readDir("/tmp")) {
      if (entry.name.startsWith("ci-lane-")) before.add(entry.name);
    }
    const log = console.log;
    console.log = () => {};
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 9999,
        of: 10000,
        full: true,
        dryRun: false,
        root,
      });
    } finally {
      console.log = log;
    }
    expect(ok).toBe(true);
    for await (const entry of Deno.readDir("/tmp")) {
      if (entry.name.startsWith("ci-lane-")) {
        expect([entry.name, before.has(entry.name)]).toEqual([
          entry.name,
          true,
        ]);
      }
    }
  });
});

describe("what a lane records about itself", () => {
  const lane = { lane: 1, of: 5, full: false, dryRun: false, root: REPOSITORY };

  it("records what each batch cost, beside the records it gathered", async () => {
    // The publisher fits the suite overheads and corrections from these,
    // so they travel as ordinary records rather than a pipeline of their
    // own — and they stay unmarked, because they measure the lane rather
    // than an alternate execution of a test.
    const workDir = await Deno.makeTempDir({ prefix: "lane-timing-" });
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const report = `${workDir}/report.xml`;
    const suiteUnderTest = suite({
      id: "workspace-unit",
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{
          command: [
            Deno.execPath(),
            "eval",
            `Deno.writeTextFileSync(${JSON.stringify(report)}, ${
              JSON.stringify(
                '<?xml version="1.0"?><testsuites><testsuite name="s" ' +
                  'tests="1" failures="0"><testcase name="bakes" ' +
                  'classname="test/bake.test.ts" time="0.25"/></testsuite>' +
                  "</testsuites>",
              )
            })`,
          ],
          cwd: context.root,
          junit: [{
            path: report,
            kind: "unit",
            scope: "bakery",
            filePrefix: "packages/bakery",
          }],
        }]),
    });
    const result = await runBatch(
      { suite: suiteUnderTest, units: [], repeats: 1 },
      lane,
      workDir,
      spool,
      {},
    );
    expect(result.ok).toBe(true);
    // The report's case reaches the lane's records with its file joined on.
    expect(result.records.map((record) => record.test.n)).toEqual(["bakes"]);
    expect(result.records[0]!.file).toBe("packages/bakery/test/bake.test.ts");

    const spooled: string[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (entry.isFile) {
        spooled.push(await Deno.readTextFile(`${spool}/${entry.name}`));
      }
    }
    const written = spooled.join("");
    expect(written).toContain("ci-lane batch workspace-unit");
    expect(written).toContain('"s":"ci"');
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  });

  it("marks a batch's records with the variant its suite declares", async () => {
    const workDir = await Deno.makeTempDir({ prefix: "lane-variant-" });
    const written = JSON.stringify({
      line: "record",
      test: { k: "integration", s: "runner", n: "attaches" },
      outcome: "pass",
      durationMs: 1,
    });
    const result = await runBatch(
      {
        suite: suite({
          id: "package-integration-on",
          variant: "server-execution",
          units: ["one"],
          command: (_units, context) =>
            Promise.resolve([{
              command: [
                Deno.execPath(),
                "eval",
                `Deno.writeTextFileSync(
                  Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
                  ${JSON.stringify(written + "\n")},
                )`,
              ],
              cwd: context.root,
            }]),
        }),
        units: [],
        repeats: 1,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    // A variant belongs to the suite that ran, not to the producer that
    // reported, so it is written on regardless of what the producer said.
    expect(result.records[0]!.test.v).toBe("server-execution");
    await Deno.remove(workDir, { recursive: true });
  });

  it("says how far past a lane's budget the mandatory set went", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane: 1,
          of: 5,
          full: false,
          dryRun: true,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              // A gate the change did not touch, costing most of a lane:
              // `always` outranks the budget, so the lane takes it and
              // reports what that cost rather than dropping it.
              manifest: manifestOf([{
                test: { k: "format", s: "repo", n: "deno-fmt" },
                suite: "repo-gates",
                unit: "deno-fmt",
                // Past a lane's 230-second budget and inside the
                // 300-second bound, so it is placed and reported rather
                // than being unschedulable.
                cost: 280,
              }]),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("past the");
  });
});

describe("the last corners of a lane's bookkeeping", () => {
  it("puts two identities of one unit in one batch, and skips neither", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const bakery = suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts"],
    });
    const batches = batchesOf(
      [bakery],
      manifest,
      manifest.entries.map((entry) => ({
        entry,
        reason: "value" as const,
        repeats: 1,
      })),
    );
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: [],
    }]);
  });

  it("drops a selection whose suite the topology no longer has", () => {
    // A manifest naming a suite this tree does not declare is a
    // manifest written before the suite was renamed or removed.
    const manifest = manifestOf([{ suite: "a-suite-that-left" }]);
    expect(
      batchesOf([], manifest, [{
        entry: manifest.entries[0]!,
        reason: "value",
        repeats: 1,
      }]),
    ).toEqual([]);
  });
});
