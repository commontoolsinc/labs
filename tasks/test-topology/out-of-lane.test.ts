import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { loadOutOfLaneSuite } from "./out-of-lane.ts";
import { unavailableUnits } from "./suite.ts";

const suite = loadOutOfLaneSuite();

describe("the commands no lane runs", () => {
  it("claims the identities the jobs outside the lanes record", () => {
    // Every one of these is a command continuous integration runs and
    // records, so the store half of the drift guard meets it on a run of
    // the default branch and has to find a suite that claims it.
    for (
      const test of [
        { k: "gate", s: "repo", n: "coverage-check" },
        { k: "test", s: "cf-harness", n: "cfc-properties" },
        { k: "gate", s: "cf-harness", n: "cfc-audit-properties" },
      ]
    ) {
      expect(suite.locate({ test })).toEqual({ level: "unit", unit: test.n });
    }
  });

  it("declines a name it holds under a surface it does not", () => {
    // The audit records under the harness's own scope, and a gate of the
    // repository's by that name would be a different thing.
    expect(
      suite.locate({ test: { k: "gate", s: "repo", n: "cfc-properties" } }),
    ).toBeUndefined();
  });

  it("makes every one of them unavailable, with the reason in words", () => {
    expect([...unavailableUnits(suite)].sort()).toEqual(
      [...suite.units].sort(),
    );
    for (const entry of suite.unavailable) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses a request for a unit, naming what was asked for", () => {
    // A packer that reached past the unavailable list would otherwise
    // get an empty command list back, run nothing, and report the batch
    // green.
    const context = { root: "/repo", outputDir: "/out" };
    expect(() => suite.command([{ unit: "coverage-check", skip: [] }], context))
      .toThrow("coverage-check");
  });

  it("builds no command when it is asked for nothing", async () => {
    expect(await suite.command([], { root: "/repo", outputDir: "/out" }))
      .toEqual([]);
  });
});
