import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkWouldTransform, transformSource } from "./test-utils.ts";
import { StaticCache } from "@commontools/static";
import { getTypeScriptEnvironmentTypes, TypeScriptCompiler } from "../mod.ts";

const staticCache = new StaticCache();
const commonToolsTypes = await staticCache.getText("types/commontools.d.ts");

describe("OpaqueRef Transformer", () => {
  const types = { "commontools.d.ts": commonToolsTypes };

  describe("Import Management", () => {
    it("adds derive import when needed", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      const transformed = await transformSource(source, { types });
      expect(transformed).toContain(
        'import { OpaqueRef, derive } from "commontools"',
      );
    });

    it("does not duplicate existing imports", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, derive, ifElse } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const a = count + 1;
const b = isActive ? 1 : 0;
`;
      const transformed = await transformSource(source, { types });
      // Should still have single import statement
      const importMatches = transformed.match(/import.*from "commontools"/g);
      expect(importMatches).toHaveLength(1);
      expect(transformed).toContain(
        'import { OpaqueRef, derive, ifElse } from "commontools"',
      );
    });
  });

  describe("Error Mode", () => {
    it("reports errors instead of transforming", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;

      await expect(
        transformSource(source, { mode: "error", types }),
      ).rejects.toThrow(/Binary expression with OpaqueRef should use derive/);
    });

    it("reports multiple errors", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const a = count + 1;
const b = isActive ? 1 : 0;
`;

      await expect(
        transformSource(source, { mode: "error", types }),
      ).rejects.toThrow(/OpaqueRef transformation errors/);
    });
  });

  describe("Debug Mode", () => {
    it("logs transformation details", async () => {
      const logs: string[] = [];
      const source = `/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;

      await transformSource(source, {
        debug: true,
        types,
        logger: (msg) => logs.push(msg),
      });

      // Check that debug mode produces some output
      expect(logs.length).toBeGreaterThan(0);
      // Check for the test transformer output that test-utils.ts generates
      expect(logs.some((log) => log.includes("TEST TRANSFORMER OUTPUT"))).toBe(true);
    });
  });

  describe("checkWouldTransform utility", () => {
    it("returns true when transformation is needed", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      expect(await checkWouldTransform(source, types)).toBe(true);
    });

    it("returns false when no transformation is needed", async () => {
      const source = `
const count: number = 5;
const result = count + 1;
`;
      expect(await checkWouldTransform(source, types)).toBe(false);
    });
  });

  describe("CTS-Enable Directive", () => {
    it("transformers work correctly when applied by test utility", async () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count > 5 ? "yes" : "no";
const sum = count + 1;
`;
      // Test utility applies transformers regardless of directive
      const transformed = await transformSource(source, { types });
      expect(transformed).toContain("commontools_1.derive");
      expect(transformed).toContain("commontools_1.ifElse");
    });

    it("transforms with /// <cts-enable /> directive", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      const envTypes = await getTypeScriptEnvironmentTypes(new StaticCache());
      const fullTypes = { ...envTypes, commontools: commonToolsTypes };
      const compiler = new TypeScriptCompiler(fullTypes);

      const program = {
        main: "/main.ts",
        files: [
          {
            name: "/main.ts",
            contents: source,
          },
          {
            name: "commontools.d.ts",
            contents: commonToolsTypes,
          },
        ],
      };

      const compiled = compiler.compile(program, {
        runtimeModules: ["commontools"],
      });

      // Should transform when directive is present
      expect(compiled.js).toContain("commontools_1.derive");
    });
  });
});