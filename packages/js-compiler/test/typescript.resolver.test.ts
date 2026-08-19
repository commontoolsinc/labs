import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveProgram } from "../typescript/resolver.ts";
import { TARGET } from "../typescript/options.ts";
import { InMemoryProgram } from "../program.ts";

describe("typescript/resolver.ts", () => {
  describe("resolveProgram", () => {
    const graph = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    it("unresolvedModules.type allow-all", async () => {
      const program = await resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow-all" },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      );
      expect(program.files.length).toBe(2);
    });
    it("unresolvedModules.type allow", async () => {
      const program = await resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow", identifiers: ["@std/math"] },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      );
      expect(program.files.length).toBe(2);
      await expect(resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow", identifiers: [] },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      )).rejects.toThrow();
    });
    it("unresolvedModules.type deny", async () => {
      await expect(resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow", identifiers: [] },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      )).rejects.toThrow();
    });

    it("names an import that escapes the program root", async () => {
      const escaping = new InMemoryProgram("/main.tsx", {
        "/main.tsx": "import { helper } from '../../cfc/admin/mod.ts';",
      });
      await expect(resolveProgram(
        escaping,
        {
          unresolvedModules: { type: "allow-all" },
          resolveUnresolvedModuleTypes: false,
          target: TARGET,
        },
      )).rejects.toThrow(
        'Import "../../cfc/admin/mod.ts" in "/main.tsx" escapes the program root.',
      );
    });

    it("resolves a parent import that stays inside the root", async () => {
      const inside = new InMemoryProgram("/core/main.tsx", {
        "/core/main.tsx": "import { helper } from '../util/mod.ts';",
        "/util/mod.ts": "export const helper = 1;",
      });
      const program = await resolveProgram(
        inside,
        {
          unresolvedModules: { type: "deny" },
          resolveUnresolvedModuleTypes: false,
          target: TARGET,
        },
      );
      expect(program.files.length).toBe(2);
    });
  });
});
