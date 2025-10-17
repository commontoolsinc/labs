import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { findAndInlineDataURILinks } from "../src/link-utils.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Helper to create data URIs for testing
function createDataURI(data: any): string {
  const json = JSON.stringify(data);
  const base64 = btoa(json);
  return `data:application/json;charset=utf-8;base64,${base64}`;
}

describe("data URI inlining", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("findAndInlineDataURILinks", () => {
    it("should inline simple data URI links", () => {
      const dataURI = createDataURI({ value: "test data" });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toBe("test data");
    });

    it("should inline data URI links with paths", () => {
      const dataURI = createDataURI({ value: { nested: { value: 42 } } });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested", "value"],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toBe(42);
    });

    it("should inline data URI links in arrays", () => {
      const dataURI1 = createDataURI({ value: "first" });
      const dataURI2 = createDataURI({ value: "second" });

      const array = [
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI1,
              path: [],
            },
          },
        },
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI2,
              path: [],
            },
          },
        },
      ];

      const result = findAndInlineDataURILinks(array);
      expect(result).toEqual(["first", "second"]);
    });

    it("should inline data URI links in objects", () => {
      const dataURI = createDataURI({ value: "nested value" });
      const obj = {
        key1: "regular value",
        key2: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI,
              path: [],
            },
          },
        },
      };

      const result = findAndInlineDataURILinks(obj);
      expect(result).toEqual({
        key1: "regular value",
        key2: "nested value",
      });
    });

    it("should handle data URIs containing links", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ value: "inner data" });

      const dataURI = createDataURI({ value: innerCell.getAsLink() });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            id: innerCell.getAsNormalizedFullLink().id,
            path: [],
          },
        },
      });
    });

    it("should handle data URIs with links and paths", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ nested: { value: "inner data" } });

      const dataURI = createDataURI({
        value: innerCell.getAsLink(),
      });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested"],
          },
        },
      });
    });

    it("should return undefined for data URIs with invalid paths", () => {
      const dataURI = createDataURI({ value: { a: 1 } });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nonexistent"],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toBeUndefined();
    });

    it("should preserve non-data URI links", () => {
      const normalCell = runtime.getCell(space, "normal", undefined, tx);
      const link = normalCell.getAsLink();

      const result = findAndInlineDataURILinks(link);
      expect(result).toBe(link);
    });

    it("should handle primitives", () => {
      expect(findAndInlineDataURILinks("string")).toBe("string");
      expect(findAndInlineDataURILinks(42)).toBe(42);
      expect(findAndInlineDataURILinks(true)).toBe(true);
      expect(findAndInlineDataURILinks(null)).toBe(null);
    });

    it("should deeply traverse nested structures", () => {
      const dataURI = createDataURI({ value: "deep value" });
      const complex = {
        level1: {
          level2: [
            {
              level3: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: dataURI,
                    path: [],
                  },
                },
              },
            },
          ],
        },
      };

      const result = findAndInlineDataURILinks(complex);
      expect(result.level1.level2[0].level3).toBe("deep value");
    });

    it("should handle data URIs with schema", () => {
      const dataURI = createDataURI({ value: 42 });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
            schema: { type: "number" },
            rootSchema: { type: "number" },
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toBe(42);
    });

    it("should preserve schema when following links in data URIs", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ nested: { value: "data" } });

      const dataURI = createDataURI({
        value: innerCell.getAsLink({
          includeSchema: true,
        }),
      });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
            schema: { type: "object" },
            rootSchema: { type: "object" },
          },
        },
      };

      const result = findAndInlineDataURILinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested"],
          },
        },
      });
    });
  });

  describe("setRaw with data URI inlining", () => {
    it("should inline data URIs when using setRaw", () => {
      const dataURI = createDataURI({ value: "inlined value" });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.setRaw({ data: link });
      expect(targetCell.get()).toEqual({ data: "inlined value" });
    });

    it("should inline nested data URIs in objects", () => {
      const dataURI1 = createDataURI({ value: "value1" });
      const dataURI2 = createDataURI({ value: "value2" });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      targetCell.setRaw({
        field1: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI1,
              path: [],
            },
          },
        },
        field2: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI2,
              path: [],
            },
          },
        },
      });

      expect(targetCell.get()).toEqual({
        field1: "value1",
        field2: "value2",
      });
    });

    it("should inline data URIs in arrays", () => {
      const dataURI = createDataURI({ value: "array item" });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      targetCell.setRaw([
        "regular",
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI,
              path: [],
            },
          },
        },
      ]);

      expect(targetCell.get()).toEqual(["regular", "array item"]);
    });
  });

  describe("diffAndUpdate with data URI inlining", () => {
    it("should inline data URIs during diffAndUpdate", () => {
      const dataURI = createDataURI({ value: "updated value" });
      const targetCell = runtime.getCell(space, "target", undefined, tx);
      targetCell.set({ initial: "value" });

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.set({ data: link });
      expect(targetCell.get()).toEqual({ data: "updated value" });
    });

    it("should handle data URIs with complex nested structures", () => {
      const dataURI = createDataURI({
        value: {
          nested: {
            array: [1, 2, 3],
            obj: { key: "value" },
          },
        },
      });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
          },
        },
      };

      targetCell.set({ result: link });
      expect(targetCell.get()).toEqual({
        result: {
          array: [1, 2, 3],
          obj: { key: "value" },
        },
      });
    });

    it("should not write data URIs to storage", () => {
      const dataURI = createDataURI({ value: "test" });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.set(link);

      // Read the raw value from storage
      const rawValue = targetCell.getRaw();

      // The raw value should be the inlined value, not the data URI link
      expect(rawValue).toBe("test");
    });
  });
});
