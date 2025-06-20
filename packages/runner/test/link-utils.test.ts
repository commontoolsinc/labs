import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  isLegacyAlias,
  isLink,
  isWriteRedirectLink,
  type NormalizedLink,
  parseLink,
  parseLinkOrThrow,
  parseToLegacyCellLink,
} from "../src/link-utils.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-utils", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("isLink", () => {
    it("should identify query results as links", () => {
      const cell = runtime.getCell(space, "test");
      // Has to be an object, otherwise asQueryResult() returns a literal
      cell.set({ value: 42 });
      const queryResult = cell.getAsQueryResult();
      expect(isLink(queryResult)).toBe(true);
    });

    it("should identify cell links as links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsCellLink();
      expect(isLink(cellLink)).toBe(true);
    });

    it("should identify cells as links", () => {
      const cell = runtime.getCell(space, "test");
      expect(isLink(cell)).toBe(true);
    });

    it("should identify docs as links", () => {
      const cell = runtime.getCell(space, "test");
      const doc = cell.getDoc();
      expect(isLink(doc)).toBe(true);
    });

    it("should identify EntityId format as links", () => {
      expect(isLink({ "/": "of:test" })).toBe(true);
    });

    it("should not identify non-links as links", () => {
      expect(isLink("string")).toBe(false);
      expect(isLink(123)).toBe(false);
      expect(isLink({ notLink: "value" })).toBe(false);
      expect(isLink(null)).toBe(false);
      expect(isLink(undefined)).toBe(false);
    });
  });

  describe("isWriteRedirectLink", () => {
    it("should identify legacy aliases as write redirect links", () => {
      const legacyAlias = { $alias: { path: ["test"] } };
      expect(isWriteRedirectLink(legacyAlias)).toBe(true);
    });

    it("should identify sigil links with overwrite redirect as write redirect links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: { id: "test", overwrite: "redirect" },
        },
      };
      expect(isWriteRedirectLink(sigilLink)).toBe(true);
    });

    it("should not identify regular sigil links as write redirect links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: { id: "test" },
        },
      };
      expect(isWriteRedirectLink(sigilLink)).toBe(false);
    });

    it("should not identify non-links as write redirect links", () => {
      expect(isWriteRedirectLink("string")).toBe(false);
      expect(isWriteRedirectLink({ notLink: "value" })).toBe(false);
    });
  });

  describe("isLegacyAlias", () => {
    it("should identify legacy aliases", () => {
      const legacyAlias = { $alias: { path: ["test"] } };
      expect(isLegacyAlias(legacyAlias)).toBe(true);
    });

    it("should identify legacy aliases with cell", () => {
      const cell = runtime.getCell(space, "test");
      const legacyAlias = { $alias: { cell: cell.getDoc(), path: ["test"] } };
      expect(isLegacyAlias(legacyAlias)).toBe(true);
    });

    it("should not identify non-legacy aliases", () => {
      expect(isLegacyAlias({ notAlias: "value" })).toBe(false);
      expect(isLegacyAlias({ $alias: "not object" })).toBe(false);
      expect(isLegacyAlias({ $alias: { notPath: "value" } })).toBe(false);
    });
  });

  describe("parseLink", () => {
    it("should parse cells to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      cell.set({ value: 42 });
      const result = parseLink(cell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should parse cells with paths to normalized links", () => {
      const cell = runtime.getCell<any>(space, "test");
      cell.set({ nested: { value: 42 } });
      const nestedCell = cell.key("nested");
      const result = parseLink(nestedCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested"],
        space: space,
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should parse docs to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const doc = cell.getDoc();
      const result = parseLink(doc);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
      });
    });

    it("should parse sigil links to normalized links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            schema: { type: "number" },
            rootSchema: { type: "object" },
            overwrite: "redirect",
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        rootSchema: { type: "object" },
        overwrite: undefined,
      });
    });

    it("should parse sigil links with relative references", () => {
      const baseCell = runtime.getCell(space, "base");
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
            space: space,
            overwrite: "redirect",
          },
        },
      };
      const result = parseLink(sigilLink, baseCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested", "value"],
        space: space,
        schema: undefined,
        rootSchema: undefined,
        overwrite: undefined,
      });
    });

    it("should parse cell links to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsCellLink();
      const result = parseLink(cellLink);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should parse JSON cell links to normalized links", () => {
      const jsonLink = {
        cell: { "/": "of:test" },
        path: ["nested", "value"],
      };
      const baseCell = runtime.getCell(space, "base");
      const result = parseLink(jsonLink, baseCell);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
      });
    });

    it("should parse legacy aliases to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const legacyAlias = {
        $alias: {
          cell: cell.getDoc(),
          path: ["nested", "value"],
          schema: { type: "number" },
          rootSchema: { type: "object" },
        },
      };
      const result = parseLink(legacyAlias);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        rootSchema: { type: "object" },
      });
    });

    it("should handle legacy aliases without cell using base", () => {
      const baseCell = runtime.getCell(space, "base");
      const legacyAlias = {
        $alias: {
          path: ["nested", "value"],
        },
      };
      const result = parseLink(legacyAlias, baseCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested", "value"],
        space: space,
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should return undefined for non-link values", () => {
      expect(parseLink("string")).toBeUndefined();
      expect(parseLink(123)).toBeUndefined();
      expect(parseLink({ notLink: "value" })).toBeUndefined();
    });
  });

  describe("parseLinkOrThrow", () => {
    it("should return parsed link for valid links", () => {
      const cell = runtime.getCell(space, "test");
      const result = parseLinkOrThrow(cell);
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    it("should throw error for non-link values", () => {
      expect(() => parseLinkOrThrow("string")).toThrow(
        "Cannot parse value as link",
      );
      expect(() => parseLinkOrThrow(123)).toThrow("Cannot parse value as link");
    });
  });

  describe("parseToLegacyCellLink", () => {
    it("should parse cells to legacy cell links", () => {
      const cell = runtime.getCell(space, "test");
      const result = parseToLegacyCellLink(cell, cell);

      expect(result).toBeDefined();
      expect(result?.cell).toBeDefined();
      expect(result?.path).toEqual([]);
    });

    it("should parse docs to legacy cell links", () => {
      const cell = runtime.getCell(space, "test");
      const doc = cell.getDoc();
      const result = parseToLegacyCellLink(doc);

      expect(result).toBeDefined();
      expect(result?.cell).toBeDefined();
      expect(result?.path).toEqual([]);
    });

    it("should parse legacy aliases to legacy cell links", () => {
      const cell = runtime.getCell(space, "test");
      const legacyAlias = {
        $alias: {
          cell: cell.getDoc(),
          path: ["nested", "value"],
        },
      };
      const result = parseToLegacyCellLink(legacyAlias);

      expect(result).toBeDefined();
      expect(result?.cell).toBeDefined();
      expect(result?.path).toEqual(["nested", "value"]);
    });

    it("should return undefined for non-link values", () => {
      expect(parseToLegacyCellLink("string")).toBeUndefined();
      expect(parseToLegacyCellLink(123)).toBeUndefined();
    });

    it("should throw error for links without base cell when needed", () => {
      const jsonLink = {
        cell: { "/": "of:test" },
        path: ["nested", "value"],
      };
      expect(() => parseToLegacyCellLink(jsonLink)).toThrow("No base cell");
    });
  });

  describe("areLinksSame", () => {
    it("should return true for identical objects", () => {
      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, cell)).toBe(true);
    });

    it("should return true for equivalent links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink1 = cell.getAsCellLink();
      const cellLink2 = cell.getAsCellLink();
      expect(areLinksSame(cellLink1, cellLink2)).toBe(true);
    });

    it("should return true for different link formats pointing to same location", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsCellLink();
      const sigilLink = cell.getAsLink();
      expect(areLinksSame(cellLink, sigilLink)).toBe(true);
    });

    it("should return false for different links", () => {
      const cell1 = runtime.getCell(space, "test1");
      const cell2 = runtime.getCell(space, "test2");
      expect(areLinksSame(cell1, cell2)).toBe(false);
    });

    it("should return false for link vs non-link", () => {
      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, "string")).toBe(false);
    });

    it("should handle null/undefined values", () => {
      expect(areLinksSame(null, null)).toBe(true);
      expect(areLinksSame(undefined, undefined)).toBe(true);
      expect(areLinksSame(null, undefined)).toBe(false);

      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, null)).toBe(false);
      expect(areLinksSame(null, cell)).toBe(false);
    });
  });

  describe("createSigilLinkFromParsedLink", () => {
    it("should create sigil link from normalized link", () => {
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        rootSchema: { type: "object" },
      };

      const result = createSigilLinkFromParsedLink(normalizedLink);

      expect(result).toEqual({
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            schema: { type: "number" },
            rootSchema: { type: "object" },
          },
        },
      });
    });

    it("should omit space when same as base", () => {
      const baseCell = runtime.getCell(space, "base");
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        space: space,
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, baseCell);

      expect(result["/"][LINK_V1_TAG].space).toBeUndefined();
    });

    it("should omit id when same as base", () => {
      const baseCell = runtime.getCell(space, "base");
      const baseId = baseCell.getDoc().entityId;
      const normalizedLink: NormalizedLink = {
        id: `of:${baseId}`,
        path: ["nested", "value"],
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, baseCell);

      expect(result["/"][LINK_V1_TAG].id).toBe(`of:${baseId}`);
    });

    it("should include overwrite field when present", () => {
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        overwrite: "redirect",
      };

      const result = createSigilLinkFromParsedLink(normalizedLink);

      expect(result["/"][LINK_V1_TAG].overwrite).toBe("redirect");
    });
  });
});
