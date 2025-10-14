import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StaticCacheFS } from "@commontools/static";

import { transformSource } from "../utils.ts";

const staticCache = new StaticCacheFS();
const commontools = await staticCache.getText("types/commontools.d.ts");

describe("OpaqueRef transformer (runtime-style API)", () => {
  const types = { "commontools.d.ts": commontools };

  describe("error mode", () => {
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

  describe("debug logging", () => {
    it("logs transformation details", async () => {
      const logs: string[] = [];
      const source = `/// <cts-enable />
import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
`;

      await transformSource(source, {
        types,
        logger: (msg: string) => logs.push(msg),
      });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((log) => log.includes("TEST TRANSFORMER OUTPUT"))).toBe(
        true,
      );
    });
  });

  describe("checkWouldTransform", () => {
    it("returns true when transformation is needed", async () => {
      const source = `/// <cts-enable />
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const el = <div>{count + 1}</div>;
`;
      expect(await transformSource.checkWouldTransform(source, types)).toBe(
        true,
      );
    });

    it("returns false when no transformation is needed", async () => {
      const source = `
const count: number = 5;
const result = count + 1;
`;
      expect(await transformSource.checkWouldTransform(source, types)).toBe(
        false,
      );
    });
  });
});
