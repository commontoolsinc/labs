import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  capabilitiesBySuite,
  claimsFor,
  loadTopology,
} from "./test-topology.ts";
import { CAPABILITIES } from "./ci-capabilities.ts";
import { stepArms } from "./test-topology/cli.ts";

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
    const on = suites.find((suite) => suite.id === "package-integration-on")!;
    const off = suites.find((suite) => suite.id === "package-integration")!;
    const shared = on.units.filter((unit) => off.units.includes(unit));
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
          test: { ...record.test, v: "server-execution" },
        }).map((claim) => claim.suite.id),
      ).toEqual(["package-integration-on"]);
    }
  });

  it("claims a recorded identity for at most one suite", () => {
    const records = [
      { test: { k: "format", s: "repo", n: "deno-fmt" } },
      { test: { k: "gate", s: "repo", n: "check-deno-pins" } },
      { test: { k: "gate", s: "repo", n: "pattern-compat home/notes" } },
      { test: { k: "gate", s: "repo", n: "pattern-vintage a b c" } },
      { test: { k: "typecheck", s: "repo", n: "cfcheck a.tsx" } },
      { test: { k: "typecheck", s: "memory", n: "deno-check" } },
      { test: { k: "integration", s: "cli", n: "integration.sh verbs" } },
      { test: { k: "integration", s: "cli", n: "fuse-exec.sh mounts" } },
    ];
    for (const record of records) {
      const claims = claimsFor(suites, record);
      expect([record.test.n, claims.length <= 1]).toEqual([
        record.test.n,
        true,
      ]);
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

describe("reading the command-line dispatch table", () => {
  it("takes the arm that runs a step alone, never a group arm", () => {
    const arms = stepArms([
      'case "$SECTION" in',
      "  all)",
      "    cf_test_step_begin one",
      "    run_one",
      "    cf_test_step_begin two",
      "    run_two",
      "    ;;",
      "  one-only)",
      "    cf_test_step_begin one",
      "    run_one",
      "    ;;",
      "  two)",
      "    cf_test_step_begin two",
      "    run_two",
      "    ;;",
      "esac",
    ].join("\n"));
    expect([...arms]).toEqual([["one", "one-only"], ["two", "two"]]);
  });

  it("gives every recorded step of the real script an arm of its own", async () => {
    const script = await Deno.readTextFile(
      new URL("../packages/cli/integration/integration.sh", import.meta.url),
    );
    const arms = stepArms(script);
    const all = new Set<string>();
    for (const line of script.split("\n")) {
      const begins = /^ {4}cf_test_step_begin (\S+)$/.exec(line);
      if (begins !== null) all.add(begins[1]!);
    }
    expect([...all].filter((step) => !arms.has(step))).toEqual([]);
  });
});
