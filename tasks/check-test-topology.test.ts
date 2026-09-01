import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  candidateSurfaces,
  check,
  checkStore,
  checkTree,
  parseCheckArgs,
  readRecords,
  report,
} from "./check-test-topology.ts";
import type { Suite } from "./test-topology/suite.ts";

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

describe("the tree half of the drift guard", () => {
  it("passes a file some suite enumerates", () => {
    const suites = [
      suite({ id: "workspace-unit", units: ["packages/bakery/glaze.test.ts"] }),
    ];
    expect(checkTree(suites, ["packages/bakery/glaze.test.ts"])).toEqual([]);
  });

  it("fails a file no suite accounts for", () => {
    const findings = checkTree([suite({ id: "workspace-unit" })], [
      "packages/bakery/glaze.test.ts",
    ]);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("claimed by no suite");
  });

  it("accepts a file inside a unit coarser than a file", () => {
    // A workspace member that runs whole, or a directory one task owns,
    // accounts for what it contains.
    const suites = [
      suite({ id: "workspace-unit", units: ["packages/bakery"] }),
    ];
    expect(checkTree(suites, ["packages/bakery/glaze.test.ts"])).toEqual([]);
  });

  it("lets a default suite and a variant suite claim one file", () => {
    const suites = [
      suite({ id: "package-integration", units: ["packages/oven/a.test.ts"] }),
      suite({
        id: "package-integration-on",
        variant: "server-execution",
        units: ["packages/oven/a.test.ts"],
      }),
    ];
    expect(checkTree(suites, ["packages/oven/a.test.ts"])).toEqual([]);
  });

  it("fails two suites claiming one file under the same variant", () => {
    const suites = [
      suite({ id: "one", units: ["packages/oven/a.test.ts"] }),
      suite({ id: "other", units: ["packages/oven/a.test.ts"] }),
    ];
    const findings = checkTree(suites, ["packages/oven/a.test.ts"]);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("one and other");
  });

  it("accepts a file a configuration declares unavailable", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        variant: "server-execution",
        unavailable: [{
          unit: "packages/oven/a.test.ts",
          phase: "phase-3",
          reason: "the surface it exercises has not landed",
        }],
      }),
    ];
    expect(checkTree(suites, ["packages/oven/a.test.ts"])).toEqual([]);
  });

  it("accepts a script a suite names as a source of its own", () => {
    // A suite whose units are dispatch arms names the scripts those arms
    // run, because no arm is a path.
    const suites = [
      suite({
        id: "cli-core",
        units: ["integration.sh verbs"],
        sources: ["packages/cli/integration/integration.sh"],
      }),
    ];
    expect(checkTree(suites, ["packages/cli/integration/integration.sh"]))
      .toEqual([]);
  });
});

describe("the store half of the drift guard", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/test/glaze.test.ts"],
    locate: (record) =>
      record.file === "packages/bakery/test/glaze.test.ts"
        ? { level: "unit", unit: record.file }
        : undefined,
  });

  it("passes a recorded identity exactly one suite claims", () => {
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
    }]);
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
  });

  it("fails an identity no suite recognizes", () => {
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
    }]);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("no suite claims")
      ),
    ).toBe(true);
  });

  it("fails an identity two suites claim", () => {
    const twin = suite({ ...bakery, id: "runner-unit" });
    const findings = checkStore([bakery, twin], [{
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
    }]);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("both claim")
      ),
    ).toBe(true);
  });

  it("says nothing about the lane measuring its own setup and batches", () => {
    // The lane writes these through the same record machinery every test
    // uses, and no suite claims them: nothing enumerates them and no lane
    // can be asked to run one. Failing on them would fail every `main`
    // run the moment lanes exist.
    const findings = checkStore([bakery], [
      { test: { k: "gate", s: "ci", n: "ci-lane setup toolshed-baked-on" } },
      { test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" } },
      {
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        file: "packages/bakery/test/glaze.test.ts",
      },
    ]);
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
  });

  it("still fails a gate-kind record that is not the lane's own", () => {
    const findings = checkStore([bakery], [
      { test: { k: "gate", s: "ci", n: "something nobody declared" } },
    ]);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("no suite claims")
      ),
    ).toBe(true);
  });

  it("reports a unit the run never recorded rather than failing", () => {
    const findings = checkStore([bakery], []);
    expect(findings.map((finding) => finding.fails)).toEqual([false]);
    expect(findings[0]!.message).toContain("never recorded");
  });

  it("says nothing about a unit a configuration declares unavailable", () => {
    const withSkip = suite({
      ...bakery,
      unavailable: [{
        unit: "packages/bakery/test/glaze.test.ts",
        reason: "the surface it exercises has not landed",
      }],
    });
    expect(checkStore([withSkip], [])).toEqual([]);
  });
});

describe("what the tree half looks at", () => {
  /** A tree holding the files a case names. */
  async function tree(files: readonly string[]): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "surfaces-" });
    for (const file of files) {
      const at = `${root}/${file}`;
      await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(at, "");
    }
    return root;
  }

  it("finds every shape Deno takes for a test file", async () => {
    const root = await tree([
      "packages/oven/test/bake.test.ts",
      "packages/oven/test/glaze.test.tsx",
      "packages/oven/test/proof_test.ts",
      "packages/oven/test/test.ts",
      "packages/oven/src/oven.ts",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/oven/test/bake.test.ts",
        "packages/oven/test/glaze.test.tsx",
        "packages/oven/test/proof_test.ts",
        "packages/oven/test/test.ts",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("finds a shell script only where an integration directory holds it", async () => {
    const root = await tree([
      "packages/cli/integration/acl.sh",
      "packages/cli/support/release.sh",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/cli/integration/acl.sh",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("passes over the directories that hold no surface of their own", async () => {
    const root = await tree([
      "packages/oven/node_modules/dep/a.test.ts",
      "packages/oven/dist/b.test.ts",
      "packages/oven/test/c.test.ts",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/oven/test/c.test.ts",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("holds a listed exception to still being in the tree", () => {
    // A file that gets registered or deleted takes its line with it,
    // which is what stops the list describing a tree nobody has.
    const findings = checkTree([], [], {
      unregistered: [{ path: "packages/gone.test.ts", reason: "moved away" }],
    });
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("no longer holds it");
  });

  it("holds a listed exception to still being unclaimed", () => {
    const claimed = suite({ id: "workspace-unit", units: ["a.test.ts"] });
    const findings = checkTree([claimed], ["a.test.ts"], {
      fixtures: [{ path: "a.test.ts", reason: "a fixture a test drives" }],
    });
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("still listed as unclaimed");
  });
});

describe("reading a run's records", () => {
  it("takes every record of every report in a file", async () => {
    const at = await Deno.makeTempFile({ suffix: ".ndjson" });
    const context = {
      schema: 1,
      line: "context",
      reportId: "01GATHERTEST000000000000",
      repo: "commontoolsinc/labs",
      commit: "c".repeat(40),
      dirty: false,
      env: "ci",
      os: "linux",
      arch: "x86_64",
      denoVersion: "2.9.4",
      startedAt: "2026-08-17T21:00:00.000Z",
    };
    await Deno.writeTextFile(
      at,
      [
        JSON.stringify(context),
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n: "bakes" },
          outcome: "pass",
          durationMs: 1,
          file: "packages/oven/test/bake.test.ts",
        }),
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n: "glazes", v: "server-execution" },
          outcome: "fail",
          durationMs: 2,
        }),
      ].join("\n") + "\n",
    );
    try {
      const records = await readRecords([at]);
      expect(records.map((record) => record.test.n)).toEqual([
        "bakes",
        "glazes",
      ]);
      // The file the producer knew travels with the record, because it
      // is what locates a unit identity.
      expect(records[0]!.file).toBe("packages/oven/test/bake.test.ts");
      expect(records[1]!.test.v).toBe("server-execution");
    } finally {
      await Deno.remove(at);
    }
  });
});

describe("what the guard declines to fail on", () => {
  it("accepts a declared fixture and reports a declared unrun test", () => {
    const findings = checkTree([], ["fixture.test.ts", "unrun.test.ts"], {
      fixtures: [{ path: "fixture.test.ts", reason: "a test drives it" }],
      unregistered: [{ path: "unrun.test.ts", reason: "no suite runs it" }],
    });
    // A fixture is not a test surface and says nothing. A test nothing
    // runs is a defect, reported so somebody can act on it, and not a
    // failure, because registering one means deciding where it runs.
    expect(findings.map((finding) => finding.fails)).toEqual([false]);
    expect(findings[0]!.message).toContain("runs nowhere");
  });

  it("counts one recorded identity once, however often it was run", () => {
    // Re-running a commit ten times says nothing new about whether the
    // topology claims what it produced.
    const bakery = suite({
      id: "workspace-unit",
      units: ["packages/bakery/test/glaze.test.ts"],
      locate: () => ({
        level: "unit",
        unit: "packages/bakery/test/glaze.test.ts",
      }),
    });
    const record = {
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
    };
    expect(checkStore([bakery], [record, record, record])).toEqual([]);
  });
});

describe("running the check and saying what it found", () => {
  it("runs the store half only when a run's records are named", () => {
    expect(parseCheckArgs([], "/repo")).toEqual({ root: "/repo" });
    expect(parseCheckArgs(["--records", "a.ndjson", "b.ndjson"], "/repo"))
      .toEqual({ root: "/repo", records: ["a.ndjson", "b.ndjson"] });
  });

  it("says a tree it accounts for is accounted for", () => {
    const out: string[] = [];
    const err: string[] = [];
    const passed = report([], 20, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(passed).toBe(true);
    expect(out[0]).toContain("20 suites");
    expect(err).toEqual([]);
  });

  it("separates what fails from what is only reported", () => {
    // A surface nobody registered fails; a test that runs nowhere is
    // reported, because registering one means deciding where it runs.
    const out: string[] = [];
    const err: string[] = [];
    const passed = report(
      [
        { fails: false, message: "a.test.ts runs nowhere" },
        { fails: true, message: "b.test.ts is claimed by no suite" },
      ],
      20,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );
    expect(passed).toBe(false);
    expect(out).toEqual(["topology (reported): a.test.ts runs nowhere"]);
    expect(err[0]).toBe("topology: b.test.ts is claimed by no suite");
    expect(err[1]).toContain("1 test surface(s)");
  });

  it("accounts for this repository's own tree", async () => {
    // The check the repository runs on itself, run the way it runs it.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const { findings, suites } = await check({ root });
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
    expect(suites).toBeGreaterThan(0);
  });
});
