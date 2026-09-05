import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { dirname, fromFileUrl, join, relative } from "@std/path";

import { recordsSpooledBy } from "@commonfabric/test-support/records";

import {
  checkGroup,
  collectPathsByScope,
  main,
  runTypecheck,
  scopeOfPath,
  selectScopes,
  UNCHECKED_TREES,
} from "./typecheck.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Whether a checked path or unchecked tree covers a repository file. */
function covers(tree: string, file: string): boolean {
  return file === tree || file.startsWith(`${tree}/`);
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

    it("names every workspace TypeScript file no recorded tree excuses", async () => {
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
      const members = await readWorkspaceMembers(
        join(REPO_ROOT, "deno.jsonc"),
      );
      const uncovered: string[] = [];
      for (const member of members) {
        for await (
          const entry of walk(join(REPO_ROOT, member), {
            includeDirs: false,
            exts: [".ts", ".tsx"],
          })
        ) {
          const file = relative(REPO_ROOT, entry.path);
          if (checked.some((checkPath) => covers(checkPath, file))) continue;
          if (UNCHECKED_TREES.some(({ tree }) => covers(tree, file))) continue;
          uncovered.push(file);
        }
      }
      expect([...new Set(uncovered)].sort()).toEqual([]);
    });

    it("records no tree that has left the repository", async () => {
      // An entry outliving its tree excuses a path nothing occupies, and
      // would go on excusing whatever later took the name.

      for (const { tree } of UNCHECKED_TREES) {
        const stat = await Deno.stat(join(REPO_ROOT, tree)).catch(() => null);
        expect(stat?.isDirectory, tree).toBe(true);
      }
    });

    it("includes iframe guests of either extension under arbitrary names", async () => {
      const root = await Deno.makeTempDir({ prefix: "typecheck-guests-" });
      try {
        for (
          const [name, guest] of [
            ["custom-board", "guest.ts"],
            ["plain-name", "guest.tsx"],
          ]
        ) {
          const directory = join(root, "packages", "patterns", name);
          await Deno.mkdir(directory, { recursive: true });
          await Deno.writeTextFile(join(directory, guest), "export {};\n");
        }

        const byScope = await collectPathsByScope(root);
        expect(byScope.get("patterns")).toContain(
          "packages/patterns/custom-board/guest.ts",
        );
        expect(byScope.get("patterns")).toContain(
          "packages/patterns/plain-name/guest.tsx",
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
