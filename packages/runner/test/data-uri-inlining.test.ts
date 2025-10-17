import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  createDataCellURI,
  findAndInlineDataURILinks,
} from "../src/link-utils.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

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
      const dataURI = createDataCellURI("test data");
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
      const dataURI = createDataCellURI({ nested: { value: 42 } });
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
      const dataURI1 = createDataCellURI("first");
      const dataURI2 = createDataCellURI("second");

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
      const dataURI = createDataCellURI("nested value");
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

      const dataURI = createDataCellURI(innerCell.getAsLink());
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

      const dataURI = createDataCellURI(innerCell.getAsLink());
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
      const dataURI = createDataCellURI({ a: 1 });
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
      const dataURI = createDataCellURI("deep value");
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
      const dataURI = createDataCellURI(42);
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

      const dataURI = createDataCellURI(innerCell.getAsLink({
        includeSchema: true,
      }));
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
      const dataURI = createDataCellURI("inlined value");
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
      const dataURI1 = createDataCellURI("value1");
      const dataURI2 = createDataCellURI("value2");
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
      const dataURI = createDataCellURI("array item");
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
      const dataURI = createDataCellURI("updated value");
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
      const dataURI = createDataCellURI({
        nested: {
          array: [1, 2, 3],
          obj: { key: "value" },
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
      const dataURI = createDataCellURI("test");
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

  describe("corner cases", () => {
    it("should handle relative links within data URIs", () => {
      // Create a data URI containing both a relative link and the data it
      // points to
      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["other", "path"],
          },
        },
      };
      const dataURI = createDataCellURI({
        link: relativeLink,
        other: { path: "success" },
      });

      // Create a link to the data URI
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["link"],
          },
        },
      };

      // The relative link should be fully resolved to the actual value
      const result = findAndInlineDataURILinks(link);

      // Should return the final resolved value "success"
      expect(result).toBe("success");
    });

    it("should resolve schema correctly when path extends beyond data URI content into linked document", () => {
      // Create a cell with nested structure and schema
      const linkedCell = runtime.getCell(space, "linked", undefined, tx);
      linkedCell.set({
        level1: {
          level2: {
            level3: "deep value",
          },
        },
      });

      // Create a link to linkedCell with a schema
      const linkToOtherDoc = {
        "/": {
          [LINK_V1_TAG]: {
            id: linkedCell.entityId["/"],
            path: [],
            schema: {
              type: "object",
              properties: {
                level1: {
                  type: "object",
                  properties: {
                    level2: {
                      type: "object",
                      properties: {
                        level3: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            rootSchema: {
              type: "object",
              properties: {
                level1: {
                  type: "object",
                  properties: {
                    level2: {
                      type: "object",
                      properties: {
                        level3: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      // Embed the link in a data URI at some intermediate level
      const dataURI = createDataCellURI({ intermediate: linkToOtherDoc });

      // Now create a link that goes through data URI, then through intermediate,
      // and then further into the linked document beyond what data URI describes
      const complexLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["intermediate", "level1", "level2"],
          },
        },
      };

      const result = findAndInlineDataURILinks(complexLink);

      // Result should be a link pointing into the linked document
      // with the path extended beyond the data URI's structure
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["level1", "level2"],
            // Schema should be resolved for the nested path
            schema: {
              type: "object",
              properties: {
                level3: { type: "string" },
              },
            },
          },
        },
      });
    });

    it("should handle data URI with relative link and additional path", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      baseCell.set({
        target: {
          nested: {
            value: 123,
          },
        },
      });

      // Relative link within data URI
      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: baseCell.getAsNormalizedFullLink().id,
            path: ["target"],
          },
        },
      };
      const dataURI = createDataCellURI(relativeLink);

      // Link with additional path that goes beyond the relative link
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested", "value"],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);

      // Should combine the paths: relative link's path + additional path
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            id: baseCell.getAsNormalizedFullLink().id,
            path: ["target", "nested", "value"],
          },
        },
      });

      // Verify that the id is NOT a data: URI
      const resultLink = result as any;
      if (resultLink["/"] && resultLink["/"][LINK_V1_TAG]?.id) {
        expect(resultLink["/"][LINK_V1_TAG].id).not.toMatch(/^data:/);
      }
    });

    it("should handle deeply nested data URIs with multiple link layers", () => {
      // Create a target cell
      const targetCell = runtime.getCell(space, "target", undefined, tx);
      targetCell.set({ final: "value" });

      // Create a link to target
      const linkToTarget = targetCell.getAsLink();

      // Wrap it in a data URI
      const dataURI1 = createDataCellURI({ wrapped: linkToTarget });

      // Create a link to first data URI
      const linkToDataURI1 = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI1,
            path: ["wrapped"],
          },
        },
      };

      // Wrap that in another data URI
      const dataURI2 = createDataCellURI({ doubleWrapped: linkToDataURI1 });

      // Create final link
      const finalLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI2,
            path: ["doubleWrapped", "final"],
          },
        },
      };

      const result = findAndInlineDataURILinks(finalLink);

      // Should eventually resolve to a link to the target cell
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["final"],
          },
        },
      });
    });

    it("should handle data URI with link that has empty path but additional traversal", () => {
      const docCell = runtime.getCell(space, "doc", undefined, tx);
      docCell.set({
        field: {
          subfield: "value",
        },
      });

      // Link to document root with schema
      const linkWithSchema = {
        "/": {
          [LINK_V1_TAG]: {
            id: docCell.entityId["/"],
            path: [],
            schema: {
              type: "object",
              properties: {
                field: {
                  type: "object",
                  properties: {
                    subfield: { type: "string" },
                  },
                },
              },
            },
          },
        },
      };

      const dataURI = createDataCellURI(linkWithSchema);

      // Path extends into the linked document
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["field", "subfield"],
          },
        },
      };

      const result = findAndInlineDataURILinks(link);

      // Should return a link with the extended path and resolved schema
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["field", "subfield"],
            schema: { type: "string" },
          },
        },
      });
    });
  });
});
