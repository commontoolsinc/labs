import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  collectDataFileNames,
  resolveProgram,
} from "../typescript/resolver.ts";
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

  describe("collectDataFileNames", () => {
    const names = (contents: string) =>
      collectDataFileNames({ name: "/main.tsx", contents }, TARGET);

    it("reads the path a dataFile call names", () => {
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          'export default () => dataFile("/data/cities.json");\n',
      )).toEqual(["/data/cities.json"]);
    });

    it("reads every path a module names", () => {
      expect(names(
        'import { dataFile, pattern } from "commonfabric";\n' +
          "export default pattern(() => ({\n" +
          '  a: dataFile("/a.json"),\n' +
          '  b: dataFile("/b.txt"),\n' +
          "}));\n",
      )).toEqual(["/a.json", "/b.txt"]);
    });

    it("follows the binding through a renaming import", () => {
      expect(names(
        'import { dataFile as read } from "commonfabric";\n' +
          'export default () => read("/data/cities.json");\n',
      )).toEqual(["/data/cities.json"]);
    });

    it("follows the binding through a namespace import", () => {
      expect(names(
        'import * as cf from "commonfabric";\n' +
          'export default () => cf.dataFile("/data/cities.json");\n',
      )).toEqual(["/data/cities.json"]);
    });

    it("ignores a dataFile that is not the runtime's", () => {
      expect(names(
        'import { dataFile } from "./local-helpers.ts";\n' +
          'export default () => dataFile("/data/cities.json");\n',
      )).toEqual([]);
    });

    it("ignores a type-only import, which binds no value", () => {
      expect(names(
        'import type { dataFile } from "commonfabric";\n' +
          "export default () => 1;\n",
      )).toEqual([]);
    });

    it("ignores a path the source does not state", () => {
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          "export default (name: string) => dataFile(name);\n",
      )).toEqual([]);
    });

    it("reads a call nested inside other code", () => {
      expect(names(
        'import { dataFile, pattern } from "commonfabric";\n' +
          "export default pattern(() => {\n" +
          '  const parsed = JSON.parse(dataFile("/data/cities.json"));\n' +
          "  return { count: parsed.length };\n" +
          "});\n",
      )).toEqual(["/data/cities.json"]);
    });

    it("ignores an inline type-only specifier, which binds no value", () => {
      expect(names(
        'import { pattern, type dataFile } from "commonfabric";\n' +
          "export default pattern(() => ({}));\n",
      )).toEqual([]);
    });

    it("ignores an import that binds no names at all", () => {
      expect(names(
        'import "commonfabric";\n' +
          'export default () => dataFile("/data/cities.json");\n',
      )).toEqual([]);
    });

    it("ignores a call through a parameter of the same name", () => {
      // The inner `dataFile` is the parameter, not the import, so the file it
      // names is not one this module reads.
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          "function helper(dataFile: (s: string) => string) {\n" +
          '  return dataFile("/shadowed.json");\n' +
          "}\n" +
          'export default () => [helper((s) => s), dataFile("/real.json")];\n',
      )).toEqual(["/real.json"]);
    });

    it("ignores a call through a local of the same name", () => {
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          "export default () => {\n" +
          "  const dataFile = (s: string) => s;\n" +
          '  return dataFile("/shadowed.json");\n' +
          "};\n",
      )).toEqual([]);
    });

    it("ignores a call through a destructured binding of the same name", () => {
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          "export default (input: { dataFile: (s: string) => string }) => {\n" +
          "  const { dataFile } = input;\n" +
          '  return dataFile("/shadowed.json");\n' +
          "};\n",
      )).toEqual([]);
    });

    it("ignores a call through a shadowed namespace alias", () => {
      expect(names(
        'import * as cf from "commonfabric";\n' +
          "export default (cf: { dataFile: (s: string) => string }) =>\n" +
          '  cf.dataFile("/shadowed.json");\n',
      )).toEqual([]);
    });

    it("reads a call whose scope shadows some other name", () => {
      expect(names(
        'import { dataFile } from "commonfabric";\n' +
          "export default () => {\n" +
          "  const other = 1;\n" +
          '  return [other, dataFile("/data/cities.json")];\n' +
          "};\n",
      )).toEqual(["/data/cities.json"]);
    });

    it("finds nothing in a module that never imports it", () => {
      expect(names("export const x = 1;\n")).toEqual([]);
    });
  });
});
