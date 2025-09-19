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
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
`;
      const transformed = await transformSource(source, { types });
      expect(transformed).toContain(
        'import { OpaqueRef, h, derive } from "commontools"',
      );
    });

    it("does not duplicate existing imports", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, derive, ifElse, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const el = <div>{count + 1} {isActive ? 1 : 0}</div>;
`;
      const transformed = await transformSource(source, { types });
      // Should still have single import statement
      const importMatches = transformed.match(/import.*from "commontools"/g);
      expect(importMatches).toHaveLength(1);
      expect(transformed).toContain(
        'import { OpaqueRef, derive, ifElse, h } from "commontools"',
      );
    });
  });

  describe("Error Mode", () => {
    it("reports errors instead of transforming", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
`;

      await expect(
        transformSource(source, { mode: "error", types }),
      ).rejects.toThrow(
        /JSX expression with OpaqueRef computation should use derive/,
      );
    });

    it("reports multiple errors", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const el = (
  <div>
    {count + 1}
    {isActive ? 1 : 0}
    {count * 2}
  </div>
);
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
import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
`;

      await transformSource(source, {
        types,
        logger: (msg) => logs.push(msg),
      });

      // Check that debug mode produces some output
      expect(logs.length).toBeGreaterThan(0);
      // Check for the test transformer output that test-utils.ts generates
      expect(logs.some((log) => log.includes("TEST TRANSFORMER OUTPUT"))).toBe(
        true,
      );
    });
  });

  describe("checkWouldTransform utility", () => {
    it("returns true when transformation is needed", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
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
import { OpaqueRef, derive, h, ifElse } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count > 5 ? "yes" : "no"} {count + 1}</div>;
`;
      // Test utility applies transformers regardless of directive
      const transformed = await transformSource(source, { types });
      expect(transformed).toContain(
        "derive(count, count => count + 1)",
      );
      expect(transformed).toContain(
        'ifElse(derive(count, count => count > 5), "yes", "no")',
      );
    });
  });
});
