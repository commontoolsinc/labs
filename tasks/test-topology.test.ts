import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  capabilitiesBySuite,
  claimsFor,
  identityKeys,
  loadTopology,
  suiteById,
  topologyUnits,
} from "./test-topology.ts";
import { CAPABILITIES } from "./ci-capabilities.ts";
import { serverExecutionCiLane } from "./server-execution-ci.ts";

const suites = await loadTopology(
  new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
);

describe("the test topology", () => {
  it("names each suite once", () => {
    const ids = suites.map((suite) => suite.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("asks only for capabilities the registry declares", () => {
    for (const [id, needs] of capabilitiesBySuite(suites)) {
      for (const need of needs) {
        expect([id, CAPABILITIES.has(need)]).toEqual([id, true]);
      }
    }
  });

  it("gives every suite something to run", () => {
    for (const suite of suites) {
      expect([suite.id, suite.units.length > 0]).toEqual([suite.id, true]);
    }
  });

  it("lets a default suite and a variant suite hold one source file", () => {
    const defaults = suites.find((suite) =>
      suite.id === "package-integration"
    )!;
    const opposite = suites.find((suite) =>
      suite.id === "package-integration-opposite"
    )!;
    // Pinned to a runner-scope file rather than whichever unit sorts
    // first: a record's scope has to match the part that holds the file,
    // and taking the first shared unit would make this fail for the
    // wrong reason the day a whole-file skip changes the order.
    const shared = defaults.units.filter((unit) =>
      opposite.units.includes(unit) && unit.startsWith("packages/runner/")
    );
    expect(shared.length > 0).toBe(true);
    // They are distinct execution surfaces, so the same file being a unit
    // of both is right; what must not happen is one identity reaching
    // both, and the variant is what keeps them apart.
    for (const unit of shared.slice(0, 1)) {
      const record = {
        test: { k: "integration", s: "runner", n: "x" },
        file: unit,
      };
      expect(claimsFor(suites, record).map((claim) => claim.suite.id))
        .toEqual(["package-integration"]);
      expect(
        claimsFor(suites, {
          ...record,
          test: {
            ...record.test,
            v: serverExecutionCiLane("opposite").recordVariant,
          },
        }).map((claim) => claim.suite.id),
      ).toEqual(["package-integration-opposite"]);
    }
  });

  it("claims a recorded identity for exactly one suite", () => {
    // Every name here is one some suite claims, which is what the count
    // being one says. A name nothing claims satisfies "at most one" as
    // well, so a list holding one says nothing about the topology.

    const records = [
      { test: { k: "format", s: "repo", n: "deno-fmt" } },
      { test: { k: "gate", s: "repo", n: "check-deno-pins" } },
      { test: { k: "gate", s: "repo", n: "pattern-compat annotation.tsx" } },
      { test: { k: "gate", s: "repo", n: "pattern-vintage a b c" } },
      { test: { k: "typecheck", s: "repo", n: "cfcheck a.tsx" } },
      { test: { k: "typecheck", s: "memory", n: "deno-check" } },
      {
        test: {
          k: "integration",
          s: "cli",
          n: "integration.sh verbs-walkthrough",
        },
      },
      {
        test: {
          k: "integration",
          s: "cli",
          n: "fuse-exec.sh .status reads as a whole JSON document",
        },
      },
    ];
    for (const record of records) {
      const claims = claimsFor(suites, record);
      expect([record.test.n, claims.length]).toEqual([record.test.n, 1]);
    }
  });

  it("keeps the overlapping script record out of every unit", () => {
    // `integration.sh` records its whole invocation as well as each step,
    // and the same identity appears whichever arm dispatched it. Summing
    // it with its own steps would double-count them.
    const claims = claimsFor(suites, {
      test: { k: "integration", s: "cli", n: "integration.sh" },
    });
    expect(claims.map((claim) => [claim.suite.id, claim.level])).toEqual([
      ["cli-core", "suite"],
    ]);
  });

  it("marks only the three gates that mean the tree is broken", () => {
    const always = suites.filter((suite) => suite.mandatory === "always");
    expect(always.map((suite) => suite.id)).toEqual(["repo-gates"]);
    expect(always[0]!.units).toEqual([
      "deno-fmt",
      "deno-lint",
      "check-test-topology",
    ]);
  });
});

describe("reading the topology as a whole", () => {
  it("finds a suite by the identifier its manifest entries carry", () => {
    expect(suiteById(suites, "workspace-unit")?.id).toBe("workspace-unit");
    expect(suiteById(suites, "no-such-suite")).toBeUndefined();
  });

  it("pairs every unit with the suite that runs it", () => {
    // Against suites written out here rather than against the topology:
    // asserting that the pairs come from the units they were built from
    // is a claim about the expression, not about the function.
    const pairs = topologyUnits([
      { ...suites[0]!, id: "one", units: ["a", "b"] },
      { ...suites[0]!, id: "other", units: ["c"] },
    ]);
    expect(pairs.map((pair) => [pair.suite.id, pair.unit])).toEqual([
      ["one", "a"],
      ["one", "b"],
      ["other", "c"],
    ]);
    expect(topologyUnits([])).toEqual([]);
  });

  it("keys a set of records the way the store keys them", () => {
    // A variant is the fourth part of a key, so one identity in two
    // configurations is two keys rather than one.
    const keys = identityKeys([
      { test: { k: "unit", s: "oven", n: "bakes" } },
      { test: { k: "unit", s: "oven", n: "bakes" } },
      { test: { k: "unit", s: "oven", n: "bakes", v: "server-execution" } },
    ]);
    expect(keys.size).toBe(2);
  });
});

describe("what the command-line dispatch table becomes", () => {
  /** Every step the dispatch script begins itself. */
  async function recordedSteps(): Promise<string[]> {
    const script = await Deno.readTextFile(
      new URL("../packages/cli/integration/integration.sh", import.meta.url),
    );
    return [
      ...new Set(
        [...script.matchAll(/^ {4}cf_test_step_begin (\S+)$/gm)]
          .map((found) => found[1]!),
      ),
    ];
  }

  it("makes a unit of every recorded step, and of nothing else", async () => {
    // Both halves matter. A step with no arm running it alone is a step
    // nothing can be asked to run; a group arm that became a unit would
    // run steps another unit already holds, and the packer would pay for
    // them twice.
    const steps = await recordedSteps();
    const suite = suiteById(suites, "cli-core")!;
    const fromSteps = suite.units
      .filter((unit) => unit.startsWith("integration.sh "))
      .map((unit) => unit.slice("integration.sh ".length));
    expect(fromSteps.sort()).toEqual(steps.sort());
  });

  it("gives each recorded step's identity to its own unit", async () => {
    for (const step of await recordedSteps()) {
      const name = `integration.sh ${step}`;
      expect([
        name,
        suiteById(suites, "cli-core")!.locate({
          test: { k: "integration", s: "cli", n: name },
        }),
      ]).toEqual([name, { level: "unit", unit: name }]);
    }
  });
});
