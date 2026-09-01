import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { loadGateSuites } from "./gates.ts";
import type { Suite } from "./suite.ts";

const suites = await loadGateSuites(
  new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
);
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;
const context = { root: "/repo", outputDir: "/out" };

describe("the repository's gate suites", () => {
  it("marks only the gates whose failure means the tree is broken", () => {
    expect(
      suites.filter((s) => s.mandatory === "always").map((s) => s.id),
    ).toEqual(["repo-gates"]);
  });

  it("runs a gate through the recorder that names its identity", async () => {
    const [invocation] = await byId("repo-gates").command(
      [{ unit: "deno-lint", skip: [] }],
      context,
    );
    // The wrapper is what turns a command's exit code into a record, so
    // the gate's identity is written on the command line rather than
    // being inferred from anything.
    expect(invocation!.command).toContain("run-recorded");
    expect(invocation!.command).toContain("lint");
    expect(invocation!.command).toContain("deno-lint");
    expect(invocation!.cwd).toBe("/repo");
  });

  it("gives a gate that compares against a base the base to use", async () => {
    const [invocation] = await byId("repo-checks").command(
      [{ unit: "check-test-aliases", skip: [] }],
      { ...context, baseRef: "origin/release" },
    );
    expect(invocation!.command).toContain("origin/release");
  });

  it("compares against main where the lane names no base", async () => {
    const [invocation] = await byId("repo-checks").command(
      [{ unit: "check-baselines-append-only", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("origin/main");
  });

  it("runs a gate that belongs to a package in that package", async () => {
    const [invocation] = await byId("repo-checks").command(
      [{ unit: "check-cfc-types", skip: [] }],
      context,
    );
    expect(invocation!.cwd).toBe("/repo/packages/static");
  });

  it("locates a gate by the name its record carries", () => {
    expect(
      byId("repo-gates").locate({
        test: { k: "format", s: "repo", n: "deno-fmt" },
      }),
    ).toEqual({ level: "unit", unit: "deno-fmt" });
    expect(
      byId("repo-gates").locate({
        test: { k: "gate", s: "repo", n: "check-deno-pins" },
      }),
    ).toBeUndefined();
  });

  it("checks only the package groups it was asked for", async () => {
    const typecheck = byId("typecheck");
    const [invocation] = await typecheck.command(
      [{ unit: "memory", skip: [] }, { unit: "runner", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("--scope=memory");
    expect(invocation!.command).toContain("--scope=runner");
    expect(invocation!.command).not.toContain("--scope=cli");
  });

  it("maps a changed path to the group that checks it", () => {
    const typecheck = byId("typecheck");
    expect(typecheck.unitsForChange!(new Set(["packages/memory/mod.ts"])))
      .toEqual(["memory"]);
    // A path no group checks makes nothing mandatory, rather than making
    // every group mandatory or throwing.
    expect(typecheck.unitsForChange!(new Set(["README.md"]))).toEqual([]);
  });

  it("keeps the type check and the pattern check apart by name", () => {
    // Both record under `typecheck` and the pattern check under scope
    // `repo`, so only the name separates them.
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "memory", n: "deno-check" },
      }),
    ).toEqual({ level: "unit", unit: "memory" });
    expect(
      byId("cfcheck").locate({
        test: { k: "typecheck", s: "repo", n: "cfcheck a/b.tsx" },
      }),
    ).toEqual({ level: "unit", unit: "cfcheck" });
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "repo", n: "cfcheck a/b.tsx" },
      }),
    ).toBeUndefined();
  });

  it("restricts the compatibility gate to the patterns it was given", async () => {
    const compat = byId("pattern-compat");
    const [invocation] = await compat.command(
      [{ unit: compat.units[0]!, skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("--only");
  });

  it("asks the compatibility gate for everything without a filter", async () => {
    // A filtered run does not ask the whole-tree questions — whether a
    // retired pattern still has a baseline, whether an accepted break has
    // gone orphaned — so a run given every pattern passes no filter.
    const compat = byId("pattern-compat");
    const [invocation] = await compat.command(
      compat.units.map((unit) => ({ unit, skip: [] })),
      context,
    );
    expect(invocation!.command).not.toContain("--only");
  });

  it("holds the compatibility gate's own record to the suite", () => {
    const compat = byId("pattern-compat");
    expect(
      compat.locate({ test: { k: "gate", s: "repo", n: "pattern-compat" } }),
    )
      .toEqual({ level: "suite" });
  });

  it("gives the vintage replay every record it writes", () => {
    const vintage = byId("pattern-vintage");
    expect(
      vintage.locate({
        test: { k: "gate", s: "repo", n: "pattern-vintage key tier stamp" },
      }),
    ).toEqual({ level: "unit", unit: "pattern-vintage" });
  });

  it("builds no command for units it does not hold", async () => {
    expect(await byId("cfcheck").command([], context)).toEqual([]);
    expect(
      await byId("typecheck").command([{ unit: "nowhere", skip: [] }], context),
    ).toEqual([]);
  });
});
