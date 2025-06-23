import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { followWriteRedirects } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { expectCellLinksEqual } from "./test-helpers.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("followAliases", () => {
    it("should follow a simple alias", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should follow a simple alias 1",
      );
      testCell.set({ value: 42 });
      const binding = { $alias: { path: ["value"] } };
      const result = followWriteRedirects(binding, testCell);
      expect(result.cell.getAtPath(result.path)).toBe(42);
    });

    it("should follow nested aliases", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "should follow nested aliases 1",
      );
      innerCell.set({ inner: 10 });
      const outerCell = runtime.getCell<{ outer: any }>(
        space,
        "should follow nested aliases 2",
      );
      outerCell.setRaw({
        outer: { $alias: innerCell.key("inner").getAsLegacyCellLink() },
      });
      const binding = { $alias: { path: ["outer"] } };
      const result = followWriteRedirects(binding, outerCell);
      expectCellLinksEqual(result).toEqual(
        innerCell.key("inner").getAsLegacyCellLink(),
      );
      expect(result.cell.getAtPath(result.path)).toBe(10);
    });

    it("should throw an error on circular aliases", () => {
      const cellA = runtime.getCell<any>(
        space,
        "should throw an error on circular aliases 1",
      );
      cellA.set({});
      const cellB = runtime.getCell<any>(
        space,
        "should throw an error on circular aliases 2",
      );
      cellB.set({});
      cellA.setRaw({
        alias: { $alias: cellB.key("alias").getAsLegacyCellLink() },
      });
      cellB.setRaw({
        alias: { $alias: cellA.key("alias").getAsLegacyCellLink() },
      });
      const binding = { $alias: { path: ["alias"] } };
      expect(() => followWriteRedirects(binding, cellA)).toThrow(
        "cycle detected",
      );
    });

    it("should allow aliases in aliased paths", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should allow aliases in aliased paths 1",
      );
      testCell.setRaw({
        a: { a: { $alias: { path: ["a", "b"] } }, b: { c: 1 } },
      });
      const binding = { $alias: { path: ["a", "a", "c"] } };
      const result = followWriteRedirects(binding, testCell);
      expectCellLinksEqual(result).toEqual(
        testCell.key("a").key("b").key("c").getAsLegacyCellLink(),
      );
      expect(result.cell.getAtPath(result.path)).toBe(1);
    });
  });
});
