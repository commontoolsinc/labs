import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  findAllWriteRedirectCells,
  sendValueToBinding,
  unwrapOneLevelAndBindtoDoc,
} from "../src/recipe-binding.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { areLinksSame } from "../src/link-utils.ts";
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
      expect(
        areLinksSame(result.x, {
          $alias: testCell.key("a").getAsLegacyCellLink(),
        }),
      ).toBe(true);
      expect(
        areLinksSame(result.y, {
          $alias: testCell.key("b").key("c").getAsLegacyCellLink(),
        }),
      ).toBe(true);
    });
  });

  describe("findAllWriteRedirectCells", () => {
    it("should find a single legacy alias binding", () => {
      const testCell = runtime.getCell<{ foo: number }>(space, "single legacy");
      testCell.set({ foo: 123 });
      const binding = { $alias: { path: ["foo"] } };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
      expect(links[0].id).toBeDefined();
      expect(links[0].space).toBe(space);
    });

    it("should find nested legacy alias bindings", () => {
      const testCell = runtime.getCell<{ a: Record<string, any> }>(
        space,
        "nested legacy",
      );
      testCell.set({ a: { b: { c: 42 } } });
      const binding = { $alias: { path: ["a"] } };
      // Add a nested alias inside the value at path 'a'
      testCell.key("a").set({
        b: { c: 42 },
        inner: { $alias: { path: ["b", "c"] } },
      });
      const nestedBinding = { $alias: { path: ["a", "inner"] } };
      const links = findAllWriteRedirectCells(
        [binding, nestedBinding],
        testCell,
      );
      expect(links.length).toBe(3);
      expect(links[0].path).toEqual(["a"]);
      expect(links[1].path).toEqual(["b", "c"]);
      expect(links[2].path).toEqual(["a", "inner"]);
    });

    it("should find all write redirect links in an array", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "array legacy",
      );
      testCell.set({ arr: [1, 2, 3] });
      const binding = [
        { $alias: { path: ["arr", 0] } },
        { $alias: { path: ["arr", 1] } },
        { $alias: { path: ["arr", 2] } },
      ];
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(3);
      expect(links.map((l) => l.path)).toEqual([
        ["arr", "0"],
        ["arr", "1"],
        ["arr", "2"],
      ]);
    });

    it("should find write redirect links in an object with multiple links", () => {
      const testCell = runtime.getCell<{ x: number; y: number }>(
        space,
        "object legacy",
      );
      testCell.set({ x: 1, y: 2 });
      const binding = {
        a: { $alias: { path: ["x"] } },
        b: { $alias: { path: ["y"] } },
        c: 3,
      };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(2);
      expect(links.map((l) => l.path)).toEqual([["x"], ["y"]]);
    });

    it("should return empty array if there are no write redirect links", () => {
      const testCell = runtime.getCell<{ foo: number }>(space, "no links");
      testCell.set({ foo: 1 });
      const binding = { bar: 2 };
      const links = findAllWriteRedirectCells(binding, testCell);
      expect(links.length).toBe(0);
    });

    it("should find write redirect links using sigil format", () => {
      const testCell = runtime.getCell<{ foo: number }>(space, "sigil link");
      testCell.set({ foo: 99 });
      const links = findAllWriteRedirectCells(
        testCell.key("foo").getAsWriteRedirectLink({ base: testCell }),
        testCell,
      );
      expect(links.length).toBe(1);
      expect(links[0].path).toEqual(["foo"]);
      expect(links[0].id).toBeDefined();
      expect(links[0].space).toBe(space);
    });
  });
});
