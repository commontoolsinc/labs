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
  });
});
