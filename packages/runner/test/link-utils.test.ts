import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  areLinksSame,
  createDataCellURI,
  createLLMFriendlyLink,
  createSigilLinkFromParsedLink,
  decodeJsonPointer,
  encodeJsonPointer,
  isCellLink,
  isLegacyAlias,
  isSigilValue,
  isWriteRedirectLink,
  type NormalizedLink,
  parseLink,
  parseLinkOrThrow,
  parseLLMFriendlyLink,
  sanitizeSchemaForLinks,
} from "../src/link-utils.ts";
import { getJSONFromDataURI } from "../src/uri-utils.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-utils", () => {
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
    await runtime?.dispose();
    await storageManager?.close();
    await tx.commit();
  });

  describe("isSigilValue", () => {
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

  describe("isCellLink", () => {
    it("should identify query results as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      // Has to be an object, otherwise asQueryResult() returns a literal
      cell.set({ value: 42 });
      const queryResult = cell.getAsQueryResult();
      expect(isCellLink(queryResult)).toBe(true);
    });

    it("should identify cell links as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      const cellLink = cell.getAsLink();
      expect(isCellLink(cellLink)).toBe(true);
    });

    it("should identify cells as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      expect(isCellLink(cell)).toBe(true);
    });

    it("should identify EntityId format as links", () => {
      expect(isCellLink({ "/": "of:test" })).toBe(true);
    });

    it("should not identify non-links as links", () => {
      expect(isCellLink("string")).toBe(false);
      expect(isCellLink(123)).toBe(false);
      expect(isCellLink({ notLink: "value" })).toBe(false);
      expect(isCellLink(null)).toBe(false);
      expect(isCellLink(undefined)).toBe(false);
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
      const legacyAlias = { $alias: { cell: cell.entityId, path: ["test"] } };
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

    it("should parse toJSON to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const result = parseLink(cell.toJSON(), cell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        type: "application/json",
        schema: undefined,
        rootSchema: undefined,
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

    it("should parse sigil links with relative references and not add id, space or schema if not present in the link", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        path: ["nested", "value"],
        type: "application/json",
      });

      // Don't allow `id: undefined`, etc.
      expect("id" in result!).toBe(false);
      expect("space" in result!).toBe(false);
      expect("schema" in result!).toBe(false);
      expect("rootSchema" in result!).toBe(false);
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
          cell: cell.entityId,
          path: ["nested", "value"],
          schema: { type: "number" },
          rootSchema: { type: "object" },
        },
      };
      const result = parseLink(legacyAlias, cell);

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

  describe("areLinksSame", () => {
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

  describe("createSigilLinkFromParsedLink", () => {
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
      const baseId = baseCell.getAsNormalizedFullLink().id;
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

  describe("stripAsCellAndStreamFromSchema", () => {
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

    it("should handle circular schema references without stack overflow", () => {
      // Create a circular schema like Record pattern has
      const schema: any = {
        type: "object",
        asCell: true,
        properties: {
          name: { type: "string" },
          subPieces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                schema: {} as any, // Will be set to parent schema
              },
            },
          },
        },
      };
      // Create the circular reference
      schema.properties.subPieces.items.properties.schema = schema;

      // This should not throw a stack overflow
      const result = sanitizeSchemaForLinks(schema);

      // Should have removed asCell from top level
      expect((result as any).asCell).toBeUndefined();
      // Should have processed nested properties
      expect((result as any).properties.name.type).toBe("string");
      // CT-1142: Result should be JSON-serializable without exponential growth
      expect(() => JSON.stringify(result)).not.toThrow();
      // The circular reference should use $ref
      const schemaRef = (result as any).properties.subPieces.items.properties
        .schema;
      expect(schemaRef.$ref).toBeDefined();
      expect(schemaRef.$ref).toMatch(/^#\/\$defs\//);
    });

    it("should handle direct self-reference cycle with $ref", () => {
      const schema: any = {
        type: "object",
        asCell: true,
        asStream: true,
      };
      schema.self = schema;

      const result = sanitizeSchemaForLinks(schema);

      // Top level flags should be removed
      expect((result as any).asCell).toBeUndefined();
      expect((result as any).asStream).toBeUndefined();
      // Cycle reference should be replaced with $ref
      expect((result as any).self.$ref).toBeDefined();
      expect((result as any).self.$ref).toMatch(/^#\/\$defs\//);
      // Result should have $defs section with the circular schema
      expect((result as any).$defs).toBeDefined();
      // Result should be JSON-serializable (no circular object references)
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle three-way cycle (A → B → C → A) with $ref", () => {
      const a: any = { type: "a", asCell: true, next: null };
      const b: any = { type: "b", asStream: true, next: null };
      const c: any = { type: "c", asCell: true, next: null };
      a.next = b;
      b.next = c;
      c.next = a;

      const result = sanitizeSchemaForLinks(a);

      // All flags should be removed in the processed chain
      expect((result as any).asCell).toBeUndefined();
      expect((result as any).next.asStream).toBeUndefined();
      expect((result as any).next.next.asCell).toBeUndefined();
      // The cycle back should be a $ref
      expect((result as any).next.next.next.$ref).toBeDefined();
      expect((result as any).next.next.next.$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycle through array items with $ref", () => {
      const schema: any = {
        type: "array",
        asCell: true,
        items: null,
      };
      schema.items = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).asCell).toBeUndefined();
      // Cycle reference should be a $ref
      expect((result as any).items.$ref).toBeDefined();
      expect((result as any).items.$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycle through anyOf with $ref", () => {
      const schema: any = {
        type: "object",
        asCell: true,
        anyOf: [{ type: "string" }, null],
      };
      schema.anyOf[1] = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).asCell).toBeUndefined();
      expect((result as any).anyOf[0].type).toBe("string");
      // Cycle reference should be a $ref
      expect((result as any).anyOf[1].$ref).toBeDefined();
      expect((result as any).anyOf[1].$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle multiple independent cycles", () => {
      const cycle1: any = { type: "cycle1", asCell: true };
      cycle1.self = cycle1;
      const cycle2: any = { type: "cycle2", asStream: true };
      cycle2.self = cycle2;
      const schema: any = { a: cycle1, b: cycle2 };

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).a.asCell).toBeUndefined();
      expect((result as any).b.asStream).toBeUndefined();
    });

    it("should handle keepStreams option with circular schemas", () => {
      const schema: any = {
        type: "object",
        asCell: true,
        asStream: true,
      };
      schema.self = schema;

      const result = sanitizeSchemaForLinks(schema, { keepStreams: true });

      expect((result as any).asCell).toBeUndefined();
      // asStream should be kept
      expect((result as any).asStream).toBe(true);
    });

    it("should handle shared references (diamond pattern) correctly", () => {
      // Test that same object referenced from multiple places is handled
      const shared: any = { type: "shared", asCell: true };
      const schema: any = {
        left: { path: shared },
        right: { path: shared },
      };

      const result = sanitizeSchemaForLinks(schema);

      // First encounter should strip asCell
      expect((result as any).left.path.asCell).toBeUndefined();
      // Second encounter returns the same processed result (consistent!)
      expect((result as any).right.path).toBe((result as any).left.path);
      expect((result as any).right.path.asCell).toBeUndefined();
    });

    it("should process schemas inside existing $defs", () => {
      // Bug fix test: schemas inside $defs should have asCell/asStream stripped
      const schema: any = {
        type: "object",
        $defs: {
          MyType: {
            type: "string",
            asCell: true,
            asStream: true,
          },
          NestedType: {
            type: "object",
            properties: {
              nested: { asCell: true },
            },
          },
        },
        $ref: "#/$defs/MyType",
      };

      const result = sanitizeSchemaForLinks(schema);

      // $defs schemas should have asCell/asStream stripped
      expect((result as any).$defs.MyType.asCell).toBeUndefined();
      expect((result as any).$defs.MyType.asStream).toBeUndefined();
      expect((result as any).$defs.MyType.type).toBe("string");
      // Nested properties too
      expect(
        (result as any).$defs.NestedType.properties.nested.asCell,
      ).toBeUndefined();
      // $ref should be preserved
      expect((result as any).$ref).toBe("#/$defs/MyType");
    });

    it("should avoid name collisions with existing $defs", () => {
      // Bug fix test: generated names should not overwrite existing $defs
      const schema: any = {
        type: "object",
        $defs: {
          CircularSchema_0: { type: "string", description: "user-defined" },
          CircularSchema_1: { type: "number", description: "user-defined" },
        },
      };
      // Create a cycle that would normally generate CircularSchema_0
      schema.self = schema;

      const result = sanitizeSchemaForLinks(schema);

      // User's definitions should be preserved
      expect((result as any).$defs.CircularSchema_0.description).toBe(
        "user-defined",
      );
      expect((result as any).$defs.CircularSchema_1.description).toBe(
        "user-defined",
      );
      // The cycle should use a different name (CircularSchema_2 or higher)
      expect((result as any).self.$ref).toBeDefined();
      const refName = (result as any).self.$ref.replace("#/$defs/", "");
      expect(refName).not.toBe("CircularSchema_0");
      expect(refName).not.toBe("CircularSchema_1");
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycles through oneOf", () => {
      const schema: any = {
        type: "object",
        asCell: true,
        oneOf: [{ type: "null" }, null],
      };
      schema.oneOf[1] = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).asCell).toBeUndefined();
      expect((result as any).oneOf[0].type).toBe("null");
      expect((result as any).oneOf[1].$ref).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycles through allOf", () => {
      const schema: any = {
        type: "object",
        asStream: true,
        allOf: [{ type: "object" }, null],
      };
      schema.allOf[1] = { properties: { nested: schema } };

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).asStream).toBeUndefined();
      expect((result as any).allOf[1].properties.nested.$ref).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle $defs with internal cycles", () => {
      // A definition that references itself
      const myDef: any = { type: "object", asCell: true };
      myDef.properties = { child: myDef };

      const schema: any = {
        type: "object",
        $defs: {
          MyRecursiveDef: myDef,
        },
        $ref: "#/$defs/MyRecursiveDef",
      };

      const result = sanitizeSchemaForLinks(schema);

      // asCell should be stripped
      expect((result as any).$defs.MyRecursiveDef.asCell).toBeUndefined();
      // The internal cycle should be converted to $ref
      expect(
        (result as any).$defs.MyRecursiveDef.properties.child.$ref,
      ).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });

  describe("createDataCellURI", () => {
    it("should throw on circular data", () => {
      const circular: any = { name: "test" };
      circular.self = circular;

      expect(() => createDataCellURI(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on nested circular data", () => {
      const obj1: any = { name: "obj1" };
      const obj2: any = { name: "obj2", ref: obj1 };
      obj1.ref = obj2;

      expect(() => createDataCellURI(obj1)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should throw on circular data in arrays", () => {
      const circular: any = { items: [] };
      circular.items.push(circular);

      expect(() => createDataCellURI(circular)).toThrow(
        "Cycle detected when creating data URI",
      );
    });

    it("should rewrite relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };

      const dataURI = createDataCellURI(
        { link: relativeLink },
        baseCell,
      );

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.value.link["/"][LINK_V1_TAG].path).toEqual([
        "nested",
        "value",
      ]);
      expect(parsed.value.link["/"][LINK_V1_TAG].id).toBe(baseId);
    });

    it("should rewrite nested relative links with base id", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const baseId = baseCell.getAsNormalizedFullLink().id;

      const data = {
        items: [
          {
            "/": {
              [LINK_V1_TAG]: {
                path: ["item", "0"],
              },
            },
          },
          {
            nested: {
              link: {
                "/": {
                  [LINK_V1_TAG]: {
                    path: ["item", "1"],
                  },
                },
              },
            },
          },
        ],
      };

      const dataURI = createDataCellURI(data, baseCell);

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.value.items[0]["/"][LINK_V1_TAG].id).toBe(baseId);
      expect(parsed.value.items[1].nested.link["/"][LINK_V1_TAG].id).toBe(
        baseId,
      );
    });

    it("should not modify absolute links", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      const otherCell = runtime.getCell(space, "other", undefined, tx);
      const otherId = otherCell.getAsNormalizedFullLink().id;

      const absoluteLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: otherId,
            path: ["some", "path"],
          },
        },
      };

      const dataURI = createDataCellURI({ link: absoluteLink }, baseCell);

      // Decode the data URI using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      // Should remain unchanged
      expect(parsed.value.link["/"][LINK_V1_TAG].id).toBe(otherId);
      expect(parsed.value.link["/"][LINK_V1_TAG].path).toEqual([
        "some",
        "path",
      ]);
    });

    it("should handle reused acyclic objects without throwing", () => {
      const sharedObject = { value: 42 };
      const data = {
        first: sharedObject,
        second: sharedObject,
        nested: {
          third: sharedObject,
        },
      };

      // Should not throw even though sharedObject is referenced multiple times
      const dataURI = createDataCellURI(data);

      // Decode and verify using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.value.first.value).toBe(42);
      expect(parsed.value.second.value).toBe(42);
      expect(parsed.value.nested.third.value).toBe(42);
    });

    it("should handle UTF-8 characters (emojis, special characters)", () => {
      const data = {
        emoji: "🚀 Hello World! 🌍",
        chinese: "你好世界",
        arabic: "مرحبا بالعالم",
        special: "Ñoño™©®",
        mixed: "Test 🎉 with ñ and 中文",
      };

      // Should not throw with UTF-8 characters
      const dataURI = createDataCellURI(data);

      // Decode and verify using getJSONFromDataURI
      const parsed = getJSONFromDataURI(dataURI);

      expect(parsed.value.emoji).toBe("🚀 Hello World! 🌍");
      expect(parsed.value.chinese).toBe("你好世界");
      expect(parsed.value.arabic).toBe("مرحبا بالعالم");
      expect(parsed.value.special).toBe("Ñoño™©®");
      expect(parsed.value.mixed).toBe("Test 🎉 with ñ and 中文");
    });
  });

  describe("JSON Pointer Utils", () => {
    it("should encode JSON Pointer", () => {
      expect(encodeJsonPointer(["foo", "bar"])).toBe("foo/bar");
      expect(encodeJsonPointer(["foo/bar", "baz~qux"])).toBe(
        "foo~1bar/baz~0qux",
      );
      expect(encodeJsonPointer([])).toBe("");
    });

    it("should decode JSON Pointer", () => {
      expect(decodeJsonPointer("foo/bar")).toEqual(["foo", "bar"]);
      expect(decodeJsonPointer("foo~1bar/baz~0qux")).toEqual([
        "foo/bar",
        "baz~qux",
      ]);
      expect(decodeJsonPointer("")).toEqual([""]);
    });
  });

  describe("parseLLMFriendlyLink", () => {
    const longId = "of:bafyabc12345678901234567890";

    it("should parse valid LLM friendly link", () => {
      const link = `/${longId}/path/to/cell`;
      const result = parseLLMFriendlyLink(link, space);

      expect(result).toEqual({
        id: longId,
        path: ["path", "to", "cell"],
        space: space,
        type: "application/json",
      });
    });

    it("should parse link without space if optional", () => {
      const link = `/${longId}/path`;
      const result = parseLLMFriendlyLink(link);

      expect(result).toEqual({
        id: longId,
        path: ["path"],
        type: "application/json",
      });
    });

    it("should throw if target does not start with slash", () => {
      expect(() => parseLLMFriendlyLink(`${longId}/path`, space)).toThrow(
        'Target must include a piece handle, e.g. "/of:bafyabc123/path".',
      );
    });

    it("should throw if target does not include handle", () => {
      expect(() => parseLLMFriendlyLink("/path/only", space)).toThrow(
        'Target must include a piece handle, e.g. "/of:bafyabc123/path".',
      );
    });

    it("should throw if handle is too short (human name)", () => {
      expect(() => parseLLMFriendlyLink("/of:short/path", space)).toThrow(
        'Piece references must use handles (e.g., "/of:bafyabc123/path"), not human names (e.g., "of:short").',
      );
    });
  });

  describe("createLLMFriendlyLink", () => {
    const longId = "of:bafyabc12345678901234567890";

    it("should create LLM friendly link from normalized link", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path", "to", "cell"],
        space: space,
      };
      // We need to cast to NormalizedFullLink because createLLMFriendlyLink expects it,
      // but it only uses id and path.
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`/${longId}/path/to/cell`);
    });

    it("should handle empty path", () => {
      const link: NormalizedLink = {
        id: longId,
        path: [],
        space: space,
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`/${longId}`);
    });

    it("should encode special characters in path", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path/with/slash", "path~with~tilde"],
        space: space,
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`/${longId}/path~1with~1slash/path~0with~0tilde`);
    });
  });
});
