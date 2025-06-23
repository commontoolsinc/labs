import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  sendValueToBinding,
  unwrapOneLevelAndBindtoDoc,
} from "../src/recipe-binding.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { expectCellLinksEqual } from "./test-helpers.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("recipe-binding", () => {
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

  describe("sendValueToBinding", () => {
    it("should send value to a simple binding", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should send value to a simple binding 1",
      );
      testCell.set({ value: 0 });
      sendValueToBinding(testCell, { $alias: { path: ["value"] } }, 42);
      expect(testCell.getAsQueryResult()).toEqual({ value: 42 });
    });

    it("should handle array bindings", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "should handle array bindings 1",
      );
      testCell.set({ arr: [0, 0, 0] });
      sendValueToBinding(
        testCell,
        [{ $alias: { path: ["arr", 0] } }, { $alias: { path: ["arr", 2] } }],
        [1, 3],
      );
      expect(testCell.getAsQueryResult()).toEqual({ arr: [1, 0, 3] });
    });

    it("should handle bindings with multiple levels", () => {
      const testCell = runtime.getCell<{
        user: {
          name: {
            first: string;
            last: string;
          };
          age: number;
        };
      }>(
        space,
        "should handle bindings with multiple levels 1",
      );
      testCell.set({
        user: {
          name: {
            first: "John",
            last: "Doe",
          },
          age: 30,
        },
      });

      const binding = {
        person: {
          fullName: {
            firstName: { $alias: { path: ["user", "name", "first"] } },
            lastName: { $alias: { path: ["user", "name", "last"] } },
          },
          currentAge: { $alias: { path: ["user", "age"] } },
        },
      };

      const value = {
        person: {
          fullName: {
            firstName: "Jane",
            lastName: "Smith",
          },
          currentAge: 25,
        },
      };

      sendValueToBinding(testCell, binding, value);

      expect(testCell.getAsQueryResult()).toEqual({
        user: {
          name: {
            first: "Jane",
            last: "Smith",
          },
          age: 25,
        },
      });
    });
  });

  describe("mapBindingToCell", () => {
    it("should map bindings to cell aliases", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should map bindings to cell aliases 1",
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const binding = {
        x: { $alias: { path: ["a"] } },
        y: { $alias: { path: ["b", "c"] } },
        z: 3,
      };

      const result = unwrapOneLevelAndBindtoDoc(binding, testCell);
      expectCellLinksEqual(result).toEqual({
        x: { $alias: testCell.key("a").getAsLegacyCellLink() },
        y: { $alias: testCell.key("b").key("c").getAsLegacyCellLink() },
        z: 3,
      });
    });
  });
});
