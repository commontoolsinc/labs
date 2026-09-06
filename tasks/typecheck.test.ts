import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl, globToRegExp, join, relative } from "@std/path";

import { recordsSpooledBy } from "@commonfabric/test-support/records";

import {
  checkGroup,
  collectPathsByScope,
  isTestModule,
  main,
  runTypecheck,
  scopeOfPath,
  selectScopes,
  UNCHECKED_TREES,
  type UncheckedTree,
} from "./typecheck.ts";
import { collectPatternFiles, isPatternSource } from "./pattern-files.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * The extensions a checked path can put in front of the type checker.
 *
 * JavaScript earns its place here: `deno check` opens a `.js` or `.jsx` file
 * a checked path names, and type-checks the ones carrying `// @ts-check`,
 * which is a diagnostic this repository would want and would otherwise lose
 * in silence. A coverage claim stated over a narrower population than the
 * gate actually reads is the defect this whole test exists to catch, so the
 * population is every module extension the checker accepts rather than the
 * ones the tree happens to hold today.
 */
const CHECKABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Whether a checked path or unchecked tree covers a repository file. */
function covers(tree: string, file: string): boolean {
  return file === tree || file.startsWith(`${tree}/`);
}

/**
 * The paths a manifest's `exclude` keeps `deno check` from opening.
 *
 * A checked path names a directory, and this test reads that as covering the
 * tree beneath it — which is true only of the files the checker itself would
 * reach. Deno drops these before it walks, so a module under one is opened by
 * nothing however a path above it reads. Every manifest is consulted rather
 * than the root alone, because a member declares its own and the checker
 * honors it.
 *
 * These are matched against a repository-relative path, so they filter the
 * walk's results rather than steering it: `walk()` takes a `skip`, but it
 * tests the absolute path an entry carries, which an anchored pattern from
 * `globToRegExp` never matches, and the exclusion would quietly stop firing.
 *
 * Only the top-level `exclude` counts. A `fmt`, `lint` or `test` block
 * carries one for its own subcommand, and reading such a block as though it
 * reached the type check would drop files the checker does open — the same
 * defect pointed the other way, and the worse direction, since it shrinks
 * what the gate is held to rather than widening it.
 */
async function excludedByManifest(
  root: string,
  members: readonly string[],
): Promise<RegExp[]> {
  const patterns: RegExp[] = [];
  for (const directory of ["", ...members]) {
    // `deno.json` wins where both exist, and Deno ignores the other whole.
    let text: string | undefined;
    for (const name of ["deno.json", "deno.jsonc"]) {
      text = await Deno.readTextFile(join(root, directory, name))
        .catch(() => undefined);
      if (text !== undefined) break;
    }
    if (text === undefined) continue;
    const manifest = parseJsonc(text) as { exclude?: string[] };
    for (const pattern of manifest.exclude ?? []) {
      const stripped = pattern.replace(/^\.\//, "");
      const scoped = directory === "" ? stripped : `${directory}/${stripped}`;
      patterns.push(
        globToRegExp(scoped.endsWith("/") ? `${scoped}**` : scoped, {
          globstar: true,
        }),
      );
    }
  }
  return patterns;
}

/**
 * The declared members, less any that another member already contains.
 *
 * The workspace nests: `packages/patterns/auth` is a member and so is the
 * tree above it. Walking both reaches the inner modules twice, and while a
 * set of paths absorbs that, a count of them does not — which is how two
 * honest censuses of this repository come to disagree. Reducing the forest
 * first makes the population walked the same thing as the population counted.
 */
function outermost(members: readonly string[]): string[] {
  const paths = members.map((member) => member.replace(/^\.\//, ""));
  return paths.filter((path) =>
    !paths.some((other) => other !== path && path.startsWith(`${other}/`))
  );
}

/**
 * Every recorded entry excusing a file, not merely the first.
 *
 * Entries are allowed to overlap, so stopping at the first match would leave
 * a later one unexamined: its reason would go unread by anything checking
 * whether reasons are true, and an entry can hide behind one written earlier.
 */
function excusedBy(file: string): UncheckedTree[] {
  return UNCHECKED_TREES.filter((entry) =>
    covers(entry.tree, file) && (entry.matches?.(file) ?? true)
  );
}

/** Whether a recorded entry excuses a file from the check. */
function excuses(file: string): boolean {
  return excusedBy(file).length > 0;
}

describe("typecheck", () => {
  describe("scopeOfPath()", () => {
    it("returns the workspace member owning a path", () => {
      expect(scopeOfPath("packages/runner")).toBe("runner");
      expect(scopeOfPath("packages/cli/lib")).toBe("cli");
      expect(scopeOfPath("packages/patterns/google/core/util")).toBe(
        "patterns",
      );
      expect(scopeOfPath("packages/connectors/agents/connector")).toBe(
        "connectors/agents/connector",
      );
      expect(
        scopeOfPath("packages/connectors/github/connector/src/client.ts"),
      ).toBe(
        "connectors/github/connector",
      );
      expect(scopeOfPath("packages/connectors/github/host/src/host.ts")).toBe(
        "connectors/github/host",
      );
      expect(scopeOfPath("tasks/typecheck.ts")).toBe("tasks");
      expect(scopeOfPath("scripts/bundle.ts")).toBe("scripts");
    });
  });

  describe("collectPathsByScope()", () => {
    it("groups every configured path under its scope", async () => {
      const byScope = await collectPathsByScope(REPO_ROOT);
      // Directory entries survive as-is under their member's scope.
      expect(byScope.get("runner")).toContain("packages/runner");
      expect(byScope.get("test-support")).toContain("packages/test-support");
      // Glob entries expand to repository-relative files.
      expect(byScope.get("scripts")).toContain("scripts/bundle.ts");
      expect(byScope.get("ui")).toContain("packages/ui");
      expect(byScope.get("tasks")).toContain("tasks");
      // Every path in every group belongs to the group's scope.
      for (const [scope, paths] of byScope) {
        for (const path of paths) {
          expect(scopeOfPath(path)).toBe(scope);
        }
      }
    });

    it("names every workspace module no recorded tree excuses", async () => {
      // The membership this walks is the workspace the repository declares,
      // not a list restated here, so a package added to `deno.jsonc` is held
      // to the claim on the day it arrives rather than on the day somebody
      // remembers to add it. What the assertion buys is the distinction the
      // checked paths cannot draw on their own: a tree left out on purpose
      // and a tree left out by accident are both simply absent from the
      // list, and this fails on the second while `UNCHECKED_TREES` excuses
      // the first. Naming the files is the point of the failure — the
      // defect this guards against is a gate reporting a clean run over
      // code it never opened, which no green result can reveal.

      const checked = [...(await collectPathsByScope(REPO_ROOT)).values()]
        .flat();
      const declared = await readWorkspaceMembers(
        join(REPO_ROOT, "deno.jsonc"),
      );
      const members = outermost(declared);
      // Every declared member, not the outermost ones: a nested member's
      // manifest carries its own `exclude` and the checker reads it.
      const dropped = await excludedByManifest(
        REPO_ROOT,
        declared.map((member) => member.replace(/^\.\//, "")),
      );
      const uncovered: string[] = [];
      for (const member of members) {
        for await (
          const entry of walk(join(REPO_ROOT, member), {
            includeDirs: false,
            exts: CHECKABLE_EXTENSIONS,
          })
        ) {
          const file = relative(REPO_ROOT, entry.path);
          if (dropped.some((pattern) => pattern.test(file))) continue;
          if (checked.some((checkPath) => covers(checkPath, file))) continue;
          if (excuses(file)) continue;
          uncovered.push(file);
        }
      }
      expect([...new Set(uncovered)].sort()).toEqual([]);
    });

    it("splits the patterns tree where cfcheck's own population splits", async () => {
      // Two entries divide this tree, and only one of them points at
      // `deno task cfcheck`. That is the one worth pinning: it reads as
      // coverage, so a file it wrongly matches is a file every later reader
      // believes is checked. It is held to that gate's own collector rather
      // than to prose, so a change in cfcheck's population fails here
      // instead of leaving the reason quietly false.
      //
      // The other direction — that no file cfcheck walks is a pattern test
      // — is not asserted here, because it cannot fail. `isPatternSource()`
      // filters test files out before the collector returns, so a walk of
      // the tree can only ever confirm it. The test below pins that
      // exclusion at its source instead.

      // Rooted at an absolute directory, since `collectPatternFiles()`
      // otherwise resolves its default against the working directory, which
      // for a test run is the package rather than the repository.
      const patternsRoot = join(REPO_ROOT, "packages", "patterns");
      const owned = new Set(
        (await collectPatternFiles(patternsRoot)).map((file) =>
          relative(REPO_ROOT, file)
        ),
      );
      const checkedPaths = [...(await collectPathsByScope(REPO_ROOT)).values()]
        .flat();
      const unchecked: string[] = [];
      const straddling = new Set<string>();
      const excusedOwned = new Map<UncheckedTree, boolean>();
      for await (
        const entry of walk(join(REPO_ROOT, "packages", "patterns"), {
          includeDirs: false,
          exts: CHECKABLE_EXTENSIONS,
        })
      ) {
        const file = relative(REPO_ROOT, entry.path);
        if (checkedPaths.some((checkPath) => covers(checkPath, file))) continue;
        // A non-test file left to cfcheck has to be one cfcheck walks.
        if (!isTestModule(file) && !owned.has(file)) unchecked.push(file);
        // And no entry may speak for files on both sides of that line,
        // because a single reason cannot be true of both. Without this, an
        // entry widened back into a blanket would excuse the tests under the
        // reason written for the sources, which is the failure this split
        // exists to prevent and the one no coverage count would show. Every
        // entry matching the file is examined rather than the first, so a
        // widened one cannot shelter behind a narrower entry declared above
        // it and never be looked at.
        for (const excuse of excusedBy(file)) {
          const seen = excusedOwned.get(excuse);
          if (seen !== undefined && seen !== owned.has(file)) {
            straddling.add(excuse.because);
          }
          excusedOwned.set(excuse, owned.has(file));
        }
      }
      expect(unchecked.sort()).toEqual([]);
      expect([...straddling]).toEqual([]);
    });

    it("pins the collector exclusion the pattern-test entry rests on", () => {
      // That entry says cfcheck never walks a pattern test. Nothing in this
      // package maintains that — it holds only while `isPatternSource()`
      // excludes test files — so it is asserted at its source, where it
      // can fail, rather than over a tree the collector has already
      // filtered. If cfcheck starts type-checking pattern tests, this is
      // what says so, and the entry needs rewriting.

      for (
        const file of [
          "packages/patterns/example/main.test.ts",
          "packages/patterns/example/main.test.tsx",
        ]
      ) {
        expect(isPatternSource(file), file).toBe(false);
      }
      // Paired with the other direction, so a predicate that rejected
      // everything would not pass as an exclusion.
      expect(isPatternSource("packages/patterns/example/main.tsx")).toBe(true);
    });

    it("records no entry that matches nothing in the tree", async () => {
      // A `matches` narrowed past the files it was written for leaves an
      // entry that excuses nobody, which reads as a live exemption and is
      // not one. The stale-tree test above catches a directory that went
      // away; this catches a predicate that did.

      const matched = new Map<UncheckedTree, number>(
        UNCHECKED_TREES.map((entry) => [entry, 0]),
      );
      for (const entry of UNCHECKED_TREES) {
        for await (
          const found of walk(join(REPO_ROOT, entry.tree), {
            includeDirs: false,
            exts: CHECKABLE_EXTENSIONS,
          })
        ) {
          const file = relative(REPO_ROOT, found.path);
          if (entry.matches?.(file) ?? true) {
            matched.set(entry, matched.get(entry)! + 1);
          }
        }
      }
      const empty = [...matched].filter(([, count]) => count === 0);
      expect(empty.map(([entry]) => entry.because)).toEqual([]);
    });

    it("records no tree that has left the repository", async () => {
      // An entry outliving its tree excuses a path nothing occupies, and
      // would go on excusing whatever later took the name.

      for (const { tree } of UNCHECKED_TREES) {
        const stat = await Deno.stat(join(REPO_ROOT, tree)).catch(() => null);
        expect(stat?.isDirectory, tree).toBe(true);
      }
    });

    it("takes an iframe guest at any depth and leaves other guests to cfcheck", async () => {
      // `isPatternSource()` sets a guest or contract aside only under an
      // `iframe-` directory, so that prefix is the condition this task's
      // claim on them rests on. A same-named file elsewhere is a pattern
      // source cfcheck compiles, and taking it here too would put one file
      // through two JSX environments that disagree.

      const root = await Deno.makeTempDir({ prefix: "typecheck-guests-" });
      try {
        for (
          const [directory, file] of [
            ["iframe-board", "guest.ts"],
            ["iframe-board/nested-canvas", "guest.tsx"],
            ["iframe-board", "contract.ts"],
            ["plain-name", "guest.ts"],
            ["plain-name", "contract.ts"],
          ]
        ) {
          const path = join(
            root,
            "packages",
            "patterns",
            ...directory.split("/"),
          );
          await Deno.mkdir(path, { recursive: true });
          await Deno.writeTextFile(join(path, file), "export {};\n");
        }

        const patterns = (await collectPathsByScope(root)).get("patterns") ??
          [];
        expect(patterns).toContain("packages/patterns/iframe-board/guest.ts");
        expect(patterns).toContain(
          "packages/patterns/iframe-board/nested-canvas/guest.tsx",
        );
        expect(patterns).toContain(
          "packages/patterns/iframe-board/contract.ts",
        );
        expect(patterns).not.toContain("packages/patterns/plain-name/guest.ts");
        expect(patterns).not.toContain(
          "packages/patterns/plain-name/contract.ts",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("checkGroup()", () => {
    it("passes a group whose file type-checks", async () => {
      const dir = await Deno.makeTempDir({ prefix: "typecheck-group-" });
      try {
        const file = join(dir, "sound.ts");
        await Deno.writeTextFile(file, "export const n: number = 1;\n");
        const result = await checkGroup("probe", [file], false);
        expect(result.success).toBe(true);
        expect(result.durationMs).toBeGreaterThan(0);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("fails a group whose file has a type error, keeping the output", async () => {
      const dir = await Deno.makeTempDir({ prefix: "typecheck-group-" });
      try {
        const file = join(dir, "unsound.ts");
        await Deno.writeTextFile(file, 'export const n: number = "one";\n');
        const result = await checkGroup("probe", [file], false);
        expect(result.success).toBe(false);
        expect(result.output).toContain("TS2322");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("fails a group whose path is not in the tree", async () => {
      // A checked path that went missing would otherwise report a clean
      // check over a package nothing looked at.

      const dir = await Deno.makeTempDir({ prefix: "typecheck-group-" });
      try {
        const result = await checkGroup(
          "probe",
          [join(dir, "gone")],
          false,
        );
        expect(result.success).toBe(false);
        expect(result.output).toContain("Cannot find module");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("fails a group whose checker cannot even spawn", async () => {
      const result = await checkGroup(
        "probe",
        ["x.ts"],
        false,
        "/no/such/deno",
      );
      expect(result.success).toBe(false);
      expect(result.output.length).toBeGreaterThan(0);
    });
  });

  describe("runTypecheck()", () => {
    const stub =
      (outcomes: Record<string, boolean>, calls: string[]) =>
      (scope: string, _paths: string[], _reload: boolean) => {
        calls.push(scope);
        return Promise.resolve({
          scope,
          durationMs: 1,
          success: outcomes[scope] ?? true,
          output: outcomes[scope] === false ? `type errors in ${scope}` : "",
        });
      };

    it("checks every group and returns true when all pass", async () => {
      const calls: string[] = [];
      const byScope = new Map([
        ["alpha", ["a.ts"]],
        ["beta", ["b.ts"]],
        ["gamma", ["c.ts"]],
      ]);
      const passed = await runTypecheck(byScope, {
        check: stub({}, calls),
      });
      expect(passed).toBe(true);
      expect(calls.sort()).toEqual(["alpha", "beta", "gamma"]);
    });

    it("returns false when any group fails", async () => {
      const byScope = new Map([["alpha", ["a.ts"]], ["beta", ["b.ts"]]]);
      const passed = await runTypecheck(byScope, {
        check: stub({ beta: false }, []),
      });
      expect(passed).toBe(false);
    });

    it("lists paths without checking anything in list mode", async () => {
      const calls: string[] = [];
      const passed = await runTypecheck(new Map([["alpha", ["a.ts"]]]), {
        list: true,
        check: stub({ alpha: false }, calls),
      });
      expect(passed).toBe(true);
      expect(calls).toEqual([]);
    });

    it("fails an empty path collection outright", async () => {
      expect(await runTypecheck(new Map())).toBe(false);
    });

    it("spools no records for a caller that did not ask for them", async () => {
      const spooled = await recordsSpooledBy(() =>
        runTypecheck(new Map([["alpha", ["a.ts"]]]), { check: stub({}, []) })
      );
      expect(spooled).toEqual([]);
    });

    it("spools one record per scope for a caller that asked", async () => {
      const spooled = await recordsSpooledBy(() =>
        runTypecheck(
          new Map([["alpha", ["a.ts"]], ["beta", ["b.ts"]]]),
          { check: stub({ beta: false }, []), recordResults: true },
        )
      );
      expect(
        spooled.map((record) => [record.test.s, record.outcome]).sort(),
      ).toEqual([["alpha", "pass"], ["beta", "fail"]]);
      expect(spooled.every((record) => record.test.k === "typecheck")).toBe(
        true,
      );
      expect(spooled.every((record) => record.test.n === "deno-check")).toBe(
        true,
      );
    });
  });

  describe("excludedByManifest()", () => {
    it("drops what the manifest excludes and keeps everything else", async () => {
      // Over-matching here shrinks the population silently, which is the one
      // direction that turns this file's whole subject into a false green, so
      // the lookalikes are asserted beside the matches.

      const declared = await readWorkspaceMembers(
        join(REPO_ROOT, "deno.jsonc"),
      );
      const dropped = await excludedByManifest(
        REPO_ROOT,
        declared.map((member) => member.replace(/^\.\//, "")),
      );
      const matches = (file: string) =>
        dropped.some((pattern) => pattern.test(file));

      expect(matches("packages/shell/dist/bundle.ts")).toBe(true);
      expect(matches("packages/x/node_modules/dep/index.js")).toBe(true);
      expect(matches("docs/history/old-plan.ts")).toBe(true);
      expect(matches("packages/runner/src/runner.ts")).toBe(false);
      // A directory whose name merely starts with an excluded one stays.
      expect(matches("packages/x/distribution/index.ts")).toBe(false);
      expect(matches("docs/history-of-things/note.ts")).toBe(false);
      // And a subcommand's own exclusion is not the type check's. These two
      // trees are named by `test` and `fmt` blocks in their members, and
      // `deno check` opens both, so dropping them would leave the gate
      // claiming less than it covers.
      expect(matches("packages/patterns/integration/all.test.ts")).toBe(false);
      expect(matches("packages/js-compiler/test/fixtures/program.ts")).toBe(
        false,
      );
    });

    it("reads a member's own exclude, resolved against that member", async () => {
      // Stated over a fixture because no member of this workspace declares a
      // top-level `exclude` today. Asserted against the tree, reading the
      // members would be indistinguishable from reading only the root, and an
      // assertion that cannot tell the two apart is not evidence for either.

      const root = await Deno.makeTempDir({ prefix: "typecheck-excludes-" });
      try {
        await Deno.writeTextFile(
          join(root, "deno.jsonc"),
          `{ "workspace": ["./packages/thing"], "exclude": ["**/dist/"] }`,
        );
        await Deno.mkdir(join(root, "packages", "thing"), { recursive: true });
        await Deno.writeTextFile(
          join(root, "packages", "thing", "deno.jsonc"),
          `{ "exclude": ["generated/"] }`,
        );

        const dropped = await excludedByManifest(root, ["packages/thing"]);
        const matches = (file: string) =>
          dropped.some((pattern) => pattern.test(file));

        expect(matches("packages/thing/generated/schema.ts")).toBe(true);
        // Resolved against the member, so the same name elsewhere survives.
        expect(matches("packages/other/generated/schema.ts")).toBe(false);
        expect(matches("generated/schema.ts")).toBe(false);
        // And the root's own exclusions still apply everywhere.
        expect(matches("packages/thing/dist/out.js")).toBe(true);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("outermost()", () => {
    it("drops a member another member contains, and keeps the rest", () => {
      // Dropping too much is the dangerous direction: a member wrongly
      // removed here is a tree the coverage walk stops visiting, which is
      // the silence this file exists to break. So the sibling and the
      // lookalike prefix are asserted alongside the nesting.

      expect(outermost([
        "./packages/patterns",
        "./packages/patterns/auth",
        "./packages/patterns-adjacent",
        "./packages/runner",
        "./tasks",
      ])).toEqual([
        "packages/patterns",
        "packages/patterns-adjacent",
        "packages/runner",
        "tasks",
      ]);
    });

    it("keeps every member when the workspace nests nowhere", () => {
      expect(outermost(["./packages/api", "./scripts"])).toEqual([
        "packages/api",
        "scripts",
      ]);
    });
  });
});

describe("selectScopes()", () => {
  const byScope = new Map([
    ["memory", ["packages/memory/mod.ts"]],
    ["runner", ["packages/runner/mod.ts"]],
  ]);

  it("returns every scope when the command line names none", () => {
    // A person running the task checks the whole tree; a lane names the
    // groups its change touched.
    expect([...selectScopes(byScope, []).keys()]).toEqual(["memory", "runner"]);
    expect([...selectScopes(byScope, ["--list"]).keys()].length).toBe(2);
  });

  it("returns only the scopes the command line names", () => {
    const selected = selectScopes(byScope, ["--scope=runner"]);
    expect([...selected.keys()]).toEqual(["runner"]);
    expect(selected.get("runner")).toEqual(["packages/runner/mod.ts"]);
  });

  it("refuses a scope that no group covers", () => {
    // Silently checking nothing would report success over a group the
    // caller believed it had checked.
    expect(() => selectScopes(byScope, ["--scope=nowhere"])).toThrow(
      "no such type-check scope",
    );
  });
});

describe("main()", () => {
  it("answers with the status the command line would exit with", async () => {
    // Zero when every group passed and one when any did not, rather
    // than exiting from inside itself, so what it decides can be
    // asserted.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    // The failing run reports its errors through `console.error`, and a
    // test that lets those through reads as a suite going wrong.
    console.error = () => {};
    try {
      expect(
        await main(["--scope=leb128"], root, {
          check: (scope) =>
            Promise.resolve({
              scope,
              durationMs: 1,
              success: true,
              output: "",
            }),
          recordResults: false,
        }),
      ).toBe(0);
      expect(
        await main(["--scope=leb128"], root, {
          check: (scope) =>
            Promise.resolve({
              scope,
              durationMs: 1,
              success: false,
              output: "a type error",
            }),
          recordResults: false,
        }),
      ).toBe(1);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});

describe("runTypecheck() with a reload", () => {
  it("says it is reloading before it checks anything", async () => {
    // The reload is the slow part, and a run that appeared to hang
    // without saying why is what the line is for.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runTypecheck(new Map([["oven", ["packages/oven/mod.ts"]]]), {
        reload: true,
        check: (scope) =>
          Promise.resolve({ scope, durationMs: 1, success: true, output: "" }),
      });
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("Reloading");
  });
});
