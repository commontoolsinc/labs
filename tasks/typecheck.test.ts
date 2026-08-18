import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl } from "@std/path";

import { collectPathsByScope, scopeOfPath } from "./typecheck.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

describe("typecheck", () => {
  describe("scopeOfPath()", () => {
    it("returns the workspace member owning a path", () => {
      expect(scopeOfPath("packages/runner")).toBe("runner");
      expect(scopeOfPath("packages/cli/lib")).toBe("cli");
      expect(scopeOfPath("packages/patterns/google/core/util")).toBe(
        "patterns",
      );
      expect(scopeOfPath("packages/connectors/agents")).toBe(
        "connectors/agents",
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
});
