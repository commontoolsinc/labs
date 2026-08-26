import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { recordsSpooledBy } from "@commonfabric/test-support/records";

import {
  checkGroup,
  collectPathsByScope,
  runTypecheck,
  scopeOfPath,
} from "./typecheck.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

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
      expect(byScope.get("tasks")).toContain("tasks/typecheck.ts");
      // The ui component walk contributes files, none from the outliner.
      const ui = byScope.get("ui") ?? [];
      expect(ui.length).toBeGreaterThan(0);
      expect(ui.every((path) => !path.includes("/outliner/"))).toBe(true);
      // Every path in every group belongs to the group's scope.
      for (const [scope, paths] of byScope) {
        for (const path of paths) {
          expect(scopeOfPath(path)).toBe(scope);
        }
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
