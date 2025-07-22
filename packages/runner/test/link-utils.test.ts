import { afterEach, beforeEach, describe, it } from "./helpers/tx-bdd.ts";
import { expect } from "@std/expect";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  isLegacyAlias,
  isLink,
  isSigilValue,
  isWriteRedirectLink,
  type NormalizedLink,
  parseLink,
  parseLinkOrThrow,
  sanitizeSchemaForLinks,
} from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-utils", (config) => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
      useStorageManagerTransactions: config.useStorageManagerTransactions,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    await tx.commit();
  });

  describe("isSigilValue", (config) => {
    it("should identify valid sigil values", () => {
      const validSigil = { "/": { someKey: "someValue" } };
      expect(isSigilValue(validSigil)).toBe(true);
    });

    it("should identify sigil values with empty record", () => {
      const emptySigil = { "/": {} };
      expect(isSigilValue(emptySigil)).toBe(true);
    });

    it("should identify sigil values with nested objects", () => {
      const nestedSigil = { "/": { nested: { deep: "value" } } };
      expect(isSigilValue(nestedSigil)).toBe(true);
    });

    it("should not identify objects with / and other properties", () => {
      const invalidSigil1 = { "/": { key: "value" }, otherProp: "value" };
      expect(isSigilValue(invalidSigil1)).toBe(false);

      const invalidSigil2 = { "/": { key: "value" }, extra: 123 };
      expect(isSigilValue(invalidSigil2)).toBe(false);

      const invalidSigil3 = {
        "/": { key: "value" },
        nested: { prop: "value" },
      };
      expect(isSigilValue(invalidSigil3)).toBe(false);
    });

    it("should not identify objects without / property", () => {
      const noSlash = { otherProp: "value" };
      expect(isSigilValue(noSlash)).toBe(false);

      const emptyObject = {};
      expect(isSigilValue(emptyObject)).toBe(false);
    });

    it("should not identify objects where / is not a record", () => {
      const stringSlash = { "/": "not a record" };
      expect(isSigilValue(stringSlash)).toBe(false);

      const numberSlash = { "/": 123 };
      expect(isSigilValue(numberSlash)).toBe(false);

      const arraySlash = { "/": ["not", "a", "record"] };
      expect(isSigilValue(arraySlash)).toBe(false);

      const nullSlash = { "/": null };
      expect(isSigilValue(nullSlash)).toBe(false);

      const undefinedSlash = { "/": undefined };
      expect(isSigilValue(undefinedSlash)).toBe(false);
    });

    it("should not identify non-objects", () => {
      expect(isSigilValue("string")).toBe(false);
      expect(isSigilValue(123)).toBe(false);
      expect(isSigilValue(true)).toBe(false);
      expect(isSigilValue(null)).toBe(false);
      expect(isSigilValue(undefined)).toBe(false);
      expect(isSigilValue([])).toBe(false);
    });

    it("should handle edge cases with multiple properties", () => {
      const multipleProps = {
        "/": { key: "value" },
        prop1: "value1",
        prop2: "value2",
      };
      expect(isSigilValue(multipleProps)).toBe(false);

      const onlySlashButMultiple = { "/": { key: "value" }, "/extra": "value" };
      expect(isSigilValue(onlySlashButMultiple)).toBe(false);
    });
  });

  describe("isLink", (config) => {
    it("should identify query results as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      // Has to be an object, otherwise asQueryResult() returns a literal
      cell.set({ value: 42 });
      const queryResult = cell.getAsQueryResult();
      expect(isLink(queryResult)).toBe(true);
    });

    it("should identify cell links as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      const cellLink = cell.getAsLink();
      expect(isLink(cellLink)).toBe(true);
    });

    it("should identify cells as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      expect(isLink(cell)).toBe(true);
    });

    it("should identify docs as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
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

  describe("isWriteRedirectLink", (config) => {
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

  describe("isLegacyAlias", (config) => {
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

  describe("parseLink", (config) => {
    it("should parse cells to normalized links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      cell.set({ value: 42 });
      const result = parseLink(cell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        type: "application/json",
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should parse cells with paths to normalized links", () => {
      const cell = runtime.getCell<any>(space, "test", undefined, tx);
      cell.set({ nested: { value: 42 } });
      const nestedCell = cell.key("nested");
      const result = parseLink(nestedCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested"],
        space: space,
        type: "application/json",
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
        type: "application/json",
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
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        type: "application/json",
        schema: { type: "number" },
        rootSchema: { type: "object" },
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
            overwrite: "this",
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        type: "application/json",
        schema: { type: "number" },
        rootSchema: { type: "object" },
      });
    });

    it("should parse sigil links with overwrite this to normalized links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            type: "application/json",
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
        type: "application/json",
        schema: { type: "number" },
        rootSchema: { type: "object" },
        overwrite: "redirect",
      });
    });

    it("should parse sigil links with relative references", () => {
      const baseCell = runtime.getCell(space, "base");
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
            space: space,
          },
        },
      };
      const result = parseLink(sigilLink, baseCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested", "value"],
        space: space,
        type: "application/json",
        schema: undefined,
        rootSchema: undefined,
      });
    });

    it("should parse cell links to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsLink();
      const result = parseLink(cellLink);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        type: "application/json",
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
        type: "application/json",
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
        type: "application/json",
        schema: { type: "number" },
        rootSchema: { type: "object" },
        overwrite: "redirect",
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
        type: "application/json",
        space: space,
        schema: undefined,
        rootSchema: undefined,
        overwrite: "redirect",
      });
    });

    it("should return undefined for non-link values", () => {
      expect(parseLink("string")).toBeUndefined();
      expect(parseLink(123)).toBeUndefined();
      expect(parseLink({ notLink: "value" })).toBeUndefined();
    });
  });

  describe("parseLinkOrThrow", (config) => {
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

  describe("areLinksSame", (config) => {
    it("should return true for identical objects", () => {
      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, cell)).toBe(true);
    });

    it("should return true for equivalent links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink1 = cell.getAsLink();
      const cellLink2 = cell.getAsLink();
      expect(areLinksSame(cellLink1, cellLink2)).toBe(true);
    });

    it("should return true for different link formats pointing to same location", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsWriteRedirectLink();
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

  describe("createSigilLinkFromParsedLink", (config) => {
    it("should create sigil link from normalized link", () => {
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        rootSchema: { type: "object" },
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, {
        includeSchema: true,
      });

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

      const result = createSigilLinkFromParsedLink(normalizedLink, {
        base: baseCell,
      });

      expect(result["/"][LINK_V1_TAG].space).toBeUndefined();
    });

    it("should omit id when same as base", () => {
      const baseCell = runtime.getCell(space, "base");
      const baseId = baseCell.getDoc().entityId;
      const normalizedLink: NormalizedLink = {
        id: `of:${baseId}`,
        path: ["nested", "value"],
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, {
        base: baseCell,
      });

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

  describe("stripAsCellAndStreamFromSchema", (config) => {
    it("should remove asCell and asStream from simple schema", () => {
      const schema = {
        type: "object",
        asCell: true,
        asStream: false,
        properties: {
          name: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
        },
      });
    });

    it("should remove asCell and asStream from nested properties", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            asCell: true,
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                asStream: true,
                properties: {
                  theme: { type: "string" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                properties: {
                  theme: { type: "string" },
                },
              },
            },
          },
        },
      });
    });

    it("should handle arrays of schemas", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              asCell: true,
            },
          },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      });
    });

    it("should handle anyOf arrays", () => {
      const schema = {
        type: "object",
        anyOf: [
          { type: "string", asCell: true },
          { type: "number", asStream: true },
        ],
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      });
    });

    it("should handle additionalProperties", () => {
      const schema = {
        type: "object",
        additionalProperties: {
          type: "string",
          asCell: true,
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        additionalProperties: {
          type: "string",
        },
      });
    });

    it("should not mutate the original schema", () => {
      const originalSchema = {
        type: "object",
        asCell: true,
        properties: {
          name: { type: "string", asStream: true },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(originalSchema);

      // Original should be unchanged
      expect(originalSchema.asCell).toBe(true);
      expect(originalSchema.properties.name.asStream).toBe(true);

      // Result should have flags removed
      expect((result as any).asCell).toBeUndefined();
      expect((result as any).properties.name.asStream).toBeUndefined();
    });
  });
});
