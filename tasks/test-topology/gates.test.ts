import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { DOC_DEMOS } from "../check-verb-session-sync.ts";
import { TRIPWIRES } from "../check-tripwires.ts";
import {
  type Gate,
  HISTORY_GATES,
  loadGateSuites,
  WORKING_TREE_GATES,
} from "./gates.ts";
import { entryNames, type Suite } from "./suite.ts";

const gates: readonly Gate[] = [...WORKING_TREE_GATES, ...HISTORY_GATES];

/**
 * The most of the tree one gate may be reached by, as a divisor. A gate
 * more than one file in eight reaches is one most changes would run.
 */
const TREE_SHARE_DIVISOR = 8;

/** The most gates one file may reach. */
const GATES_PER_FILE = 4;

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

  it("reaches the gates a change names, and no others", () => {
    // Built over every gate of both suites, so a declaration wider than
    // the change fails this rather than quietly running more.
    const reached = (...changed: string[]): string[] =>
      [byId("repo-gates"), byId("repo-history-gates")]
        .flatMap((suite) => [...suite.unitsForChange!(new Set(changed))])
        .toSorted();
    expect(reached("tasks/test-identity-aliases.jsonl")).toEqual([
      "check-test-aliases",
    ]);
    expect(reached(".github/workflows/deno.yml")).toEqual([
      "check-action-pins",
    ]);
    // The baselines and the patterns beside them reach one gate each,
    // rather than both reaching both.
    expect(reached("packages/patterns/baselines/system/home.tsx/a.json"))
      .toEqual(["check-baselines-append-only"]);
    expect(reached("packages/patterns/system/home.tsx")).toEqual([
      "check-pattern-tiers",
    ]);
    // A `**` segment stands for any run of directories, so every
    // package's integration tree reaches the gate reading them.
    expect(reached("packages/cli/integration/verb-session-demo.sh")).toEqual([
      "check-no-waitfor",
      "check-verb-session-sync",
    ]);
    expect(reached("packages/static/assets/types/dom.d.ts")).toEqual([
      "check-cfc-types",
      "check-commonfabric-types",
      "check-withheld-globals",
    ]);
    expect(reached("packages/toolshed/routes/ingest-channels/route.ts"))
      .toEqual(["check-tripwires"]);
    // The historical tree is taken back out of the two gates reading
    // `docs/`, since neither compiles nor reads a document in it.
    expect(reached("docs/history/INDEX.md")).toEqual([
      "check-docs-history-index",
    ]);
    expect(reached("mise.toml")).toEqual(["check-deno-pins"]);
    expect(reached("deno.lock")).toEqual(["check-single-copy-deps"]);
    // An ordinary source file reaches no gate. What runs for it is what
    // the score chose, which is what keeps this feature a fraction of a
    // lane rather than the bulk of one.
    expect(reached("packages/runner/src/cell.ts")).toEqual([]);
    expect(reached("elsewhere/thing.txt")).toEqual([]);
  });

  it("holds a gate to little of the tree, and a file to few gates", async () => {
    // The two bounds that keep this feature a fraction of what a lane
    // runs. A declaration wide enough to break either places its gate in
    // every lane on the strength of what it says rather than of what it
    // has caught, which is the decision the score exists to make. Every
    // entry is held to naming something as well, so one whose directory
    // the tree no longer has fails here rather than going quiet behind a
    // sibling entry that still matches.
    const listed = await new Deno.Command("git", {
      args: ["-C", root, "ls-files", "-z"],
    }).output();
    const files = new TextDecoder().decode(listed.stdout)
      .split("\0").filter((path) => path !== "");
    const reached = (at: string): readonly string[] =>
      [byId("repo-gates"), byId("repo-history-gates")]
        .flatMap((suite) => [...suite.unitsForChange!(new Set([at]))]);
    const share = new Map<string, number>();
    let crowded: { at: string; names: readonly string[] } = {
      at: "",
      names: [],
    };
    for (const at of files) {
      const names = reached(at);
      if (names.length > crowded.names.length) crowded = { at, names };
      for (const name of names) share.set(name, (share.get(name) ?? 0) + 1);
    }
    const over: string[] = [];
    for (const gate of gates) {
      for (const entry of gate.reachedBy) {
        const at = entry.replace(/^!/, "");
        if (!files.some((path) => entryNames(at, path))) {
          over.push(`${gate.name} names ${entry}, which the tree has not`);
        }
      }
      const reaching = share.get(gate.name) ?? 0;
      if (reaching * TREE_SHARE_DIVISOR > files.length) {
        over.push(
          `${gate.name} is reached by ${reaching} of ${files.length} files`,
        );
      }
    }
    if (crowded.names.length > GATES_PER_FILE) {
      over.push(
        `${crowded.at} reaches ${crowded.names.length} gates: ` +
          crowded.names.toSorted().join(", "),
      );
    }
    expect(over).toEqual([]);
  });

  it("declares nothing for the gates whose input is most of the tree", () => {
    // No small and specific part of the tree decides any of these, so
    // each is left to the score. The list is exact, so a gate added with
    // no declaration fails here rather than joining them in silence.
    const everything = gates
      .filter((gate) => gate.reachedBy.length === 0)
      .map((gate) => gate.name)
      .toSorted();
    expect(everything).toEqual([
      "check-conflict-markers",
      "check-control-characters",
      "check-local-program",
      "check-package-cycles",
      "check-skill-facts",
      "check-test-topology",
      "check-unused-deps",
      "deno-fmt",
      "deno-lint",
    ]);
  });

  it("names paths the tree holds, as the kind the entry says", async () => {
    // A renamed input leaves the gate reachable by a path nobody edits,
    // which reads as a gate nothing touches rather than as a mistake.
    const kindOf = async (entry: string): Promise<string> => {
      try {
        const info = await Deno.stat(`${root}/${entry}`);
        return info.isDirectory ? "directory" : "file";
      } catch {
        return "missing";
      }
    };
    const found: string[] = [];
    const declared: string[] = [];
    for (const gate of gates) {
      for (const entry of gate.reachedBy) {
        const at = entry.replace(/^!/, "");
        // An entry carrying a `**` segment names no one path, and the
        // bounds test is what holds it to reaching something.
        if (at.includes("**/")) continue;
        found.push(`${entry} ${await kindOf(at)}`);
        declared.push(`${entry} ${at.endsWith("/") ? "directory" : "file"}`);
      }
    }
    expect(found).toEqual(declared);
  });

  it("is reached by the inputs the gates that enumerate their own name", () => {
    // Two gates hold their inputs as constants, and the declarations
    // here are a second copy of the same facts. Comparing the copies is
    // what catches a gate that grows an input its declaration does not
    // name, which the two tests above cannot see.
    const reachedBy = (name: string, at: string): string =>
      `${name} ${
        byId("repo-gates").unitsForChange!(new Set([at])).includes(name)
          ? "runs for"
          : "misses"
      } ${at}`;
    const found: string[] = [];
    const declared: string[] = [];
    for (const { doc, demo } of DOC_DEMOS) {
      for (const at of [doc, demo]) {
        found.push(reachedBy("check-verb-session-sync", at));
        declared.push(`check-verb-session-sync runs for ${at}`);
      }
    }
    for (const tripwire of TRIPWIRES) {
      found.push(reachedBy("check-tripwires", tripwire.testFile));
      declared.push(`check-tripwires runs for ${tripwire.testFile}`);
    }
    expect(found).toEqual(declared);
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
