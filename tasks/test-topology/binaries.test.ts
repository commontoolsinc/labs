import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { loadBinarySuites } from "./binaries.ts";
import type { Suite } from "./suite.ts";

const suites = loadBinarySuites();
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;

describe("the binary build suites", () => {
  it("makes one unit of each shipped binary", () => {
    expect(byId("binaries").units).toEqual([
      "toolshed",
      "bg-piece-service",
      "cf",
    ]);
  });

  it("gives the server-execution shell its own history", () => {
    // The same build under a different compile-time define, which is
    // what a variant is. One configuration's record must never stand in
    // for the other's.
    const on = byId("binaries-on");
    expect(on.variant).toBe("server-execution");
    expect(on.units).toEqual(["toolshed"]);
    expect(
      on.locate({ test: { k: "gate", s: "repo", n: "build-binary toolshed" } }),
    ).toBeUndefined();
    expect(
      on.locate({
        test: {
          k: "gate",
          s: "repo",
          n: "build-binary toolshed",
          v: "server-execution",
        },
      }),
    ).toEqual({ level: "unit", unit: "toolshed" });
  });

  it("builds a binary when the change reaches what it is built from", () => {
    const binaries = byId("binaries");
    expect(binaries.unitsForChange!(new Set(["packages/cli/mod.ts"])))
      .toEqual(["cf"]);
    // The browser shell is bundled into the toolshed binary, so a change
    // to the shell can break that compile and nothing else's.
    expect(binaries.unitsForChange!(new Set(["packages/shell/index.ts"])))
      .toEqual(["toolshed"]);
  });

  it("builds every binary that embeds a changed asset", () => {
    // The static assets are embedded in all three.
    expect(
      byId("binaries").unitsForChange!(
        new Set(["packages/static/assets/types/es2023.d.ts"]),
      ),
    ).toEqual(["toolshed", "bg-piece-service", "cf"]);
  });

  it("builds nothing for a change that reaches no binary", () => {
    expect(byId("binaries").unitsForChange!(new Set(["docs/README.md"])))
      .toEqual([]);
  });

  it("runs each binary as its own invocation", () => {
    // A build that fails takes its own identity down and leaves the
    // others to report for themselves.
    const invocations = byId("binaries").command(
      [{ unit: "cf", skip: [] }, { unit: "toolshed", skip: [] }],
      { root: "/repo", outputDir: "/out" },
    );
    return invocations.then((made) => {
      expect(made.length).toBe(2);
      expect(made[0]!.command).toContain("build-binary cf");
      expect(made[1]!.command).toContain("build-binary toolshed");
    });
  });

  it("builds the server-execution shell with the define set", () => {
    return byId("binaries-on").command(
      [{ unit: "toolshed", skip: [] }],
      { root: "/repo", outputDir: "/out" },
    ).then((made) => {
      expect(made[0]!.env?.EXPERIMENTAL_SERVER_EXECUTION).toBe("true");
    });
  });
});
