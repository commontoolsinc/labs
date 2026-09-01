import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { checkStore, checkTree } from "./check-test-topology.ts";
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
