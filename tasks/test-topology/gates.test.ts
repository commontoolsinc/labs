import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { loadGateSuites } from "./gates.ts";
import type { Suite } from "./suite.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const suites = await loadGateSuites(root);
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;
const context = { root: "/repo", outputDir: "/out" };

describe("the repository's gate suites", () => {
  it("gives the base revision to the gates whose suite asks for history", async () => {
    // A lane opens what a suite needs before it runs any of it, so which
    // suite a gate sits in decides whether the lane it runs in has
    // history to read. Both lists are built over every gate of both
    // suites, so a gate that reaches for the base revision from the suite
    // that asks for no history fails this.

    const reading: string[] = [];
    const declared: string[] = [];
    for (const suite of [byId("repo-gates"), byId("repo-history-gates")]) {
      for (const unit of suite.units) {
        const [invocation] = await suite.command([{ unit, skip: [] }], {
          ...context,
          baseRef: "origin/release",
        });
        if (invocation!.command.includes("origin/release")) reading.push(unit);
        if (suite.needs.includes("git-history")) declared.push(unit);
      }
    }
    expect(reading.toSorted()).toEqual([
      "check-baselines-append-only",
      "check-test-aliases",
    ]);
    expect(declared.toSorted()).toEqual(reading.toSorted());
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
    const [invocation] = await byId("repo-history-gates").command(
      [{ unit: "check-test-aliases", skip: [] }],
      { ...context, baseRef: "origin/release" },
    );
    expect(invocation!.command).toContain("origin/release");
  });

  it("compares against main where the lane names no base", async () => {
    const [invocation] = await byId("repo-history-gates").command(
      [{ unit: "check-baselines-append-only", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("origin/main");
  });

  it("names a task some manifest it can reach defines", async () => {
    // `fmt` and `lint` are subcommands of Deno rather than tasks of this
    // repository, and a gate asking for one as a task exits one having
    // checked nothing. The lane reports that as a failed gate with no
    // failing test under it, which is the hardest shape of failure to
    // read, so the gates are held to naming what they run.
    const tasksOf = async (dir: string): Promise<Set<string>> => {
      for (const name of ["deno.json", "deno.jsonc"]) {
        const text = await Deno.readTextFile(path.join(dir, name)).catch(
          () => undefined,
        );
        if (text === undefined) continue;
        const manifest = parseJsonc(text) as {
          tasks?: Record<string, unknown>;
        };
        return new Set(Object.keys(manifest.tasks ?? {}));
      }
      return new Set();
    };
    const rootTasks = await tasksOf(root);
    const missing: string[] = [];
    for (const suite of suites) {
      for (const unit of suite.units) {
        const [invocation] = await suite.command([{ unit, skip: [] }], {
          root,
          outputDir: "/out",
        });
        const command = invocation!.command;
        // What the recorder was told to run, which is everything past the
        // separator and the Deno path that follows it.
        const run = command.slice(command.indexOf("--") + 2);
        if (run[0] !== "task") continue;
        const local = await tasksOf(invocation!.cwd ?? root);
        if (!local.has(run[1]!) && !rootTasks.has(run[1]!)) {
          missing.push(`${suite.id} ${unit}: no task named ${run[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("runs a gate that belongs to a package in that package", async () => {
    const [invocation] = await byId("repo-gates").command(
      [{ unit: "check-cfc-types", skip: [] }],
      context,
    );
    expect(invocation!.cwd).toBe("/repo/packages/static");
  });

  it("locates a gate by the name its record carries", () => {
    // Both gate suites record under the `gate` kind and the `repo` scope,
    // so the name is what separates one's records from the other's.
    expect(
      byId("repo-gates").locate({
        test: { k: "format", s: "repo", n: "deno-fmt" },
      }),
    ).toEqual({ level: "unit", unit: "deno-fmt" });
    expect(
      byId("repo-history-gates").locate({
        test: { k: "gate", s: "repo", n: "check-test-aliases" },
      }),
    ).toEqual({ level: "unit", unit: "check-test-aliases" });
    expect(
      byId("repo-gates").locate({
        test: { k: "gate", s: "repo", n: "check-test-aliases" },
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

  it("runs the pattern type check and the vintage replay whole", async () => {
    // Both write a record per item and neither takes a way of running
    // part of itself, so the suite is one unit and the command is the
    // task, wrapped so its exit code becomes that unit's record.
    for (const id of ["cfcheck", "pattern-vintage"]) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        context,
      );
      expect(invocation!.command).toContain("run-recorded");
      expect(invocation!.command.at(-1)).toBe(suite.units[0]);
      expect(await suite.command([], context)).toEqual([]);
    }
  });

  it("declines a type-check record whose name is another gate's", () => {
    // Both record under the `typecheck` kind, so within one scope only
    // the name separates them.
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "memory", n: "cfcheck a/b.tsx" },
      }),
    ).toBeUndefined();
  });

  it("builds no command for units it does not hold", async () => {
    expect(await byId("cfcheck").command([], context)).toEqual([]);
    expect(
      await byId("typecheck").command([{ unit: "nowhere", skip: [] }], context),
    ).toEqual([]);
    expect(
      await byId("repo-gates").command(
        [{ unit: "nowhere", skip: [] }],
        context,
      ),
    ).toEqual([]);
    expect(
      await byId("pattern-compat").command(
        [{ unit: "nowhere", skip: [] }],
        context,
      ),
    ).toEqual([]);
  });
});
