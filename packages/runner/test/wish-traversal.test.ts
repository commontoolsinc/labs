/**
 * Unit tests for wish-traversal module.
 *
 * Tests the pure functions for schema tag matching and cell hierarchy traversal.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  collectMatches,
  findMatchingCells,
  schemaMatchesTag,
  traverseForTag,
  type TraversalMatch,
  type TraversalOptions,
} from "../src/builtins/wish-traversal.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";

describe("schemaMatchesTag", () => {
  describe("matches tags in schema title", () => {
    it("matches exact title (case-insensitive)", () => {
      const schema: JSONSchema = { type: "object", title: "Person" };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
      expect(schemaMatchesTag(schema, "Person")).toBe(true);
      expect(schemaMatchesTag(schema, "PERSON")).toBe(true);
    });

    it("matches hashtag in title", () => {
      const schema: JSONSchema = { type: "object", title: "Contact #person" };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
    });

    it("does not match partial title without hashtag", () => {
      const schema: JSONSchema = { type: "object", title: "PersonInfo" };
      expect(schemaMatchesTag(schema, "person")).toBe(false);
    });

    it("does not match unrelated title", () => {
      const schema: JSONSchema = { type: "object", title: "Address" };
      expect(schemaMatchesTag(schema, "person")).toBe(false);
    });
  });

  describe("matches tags in schema description", () => {
    it("matches hashtag in description", () => {
      const schema: JSONSchema = {
        type: "object",
        description: "Represents a #person in the system",
      };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
    });

    it("matches multiple hashtags in description", () => {
      const schema: JSONSchema = {
        type: "object",
        description: "A #contact that is a #person",
      };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
      expect(schemaMatchesTag(schema, "contact")).toBe(true);
    });

    it("does not match word without hashtag in description", () => {
      const schema: JSONSchema = {
        type: "object",
        description: "This is a person record",
      };
      expect(schemaMatchesTag(schema, "person")).toBe(false);
    });
  });

  describe("matches tags in $ref", () => {
    it("matches definition name in $ref", () => {
      const schema: JSONSchema = { $ref: "#/$defs/Person" };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
    });

    it("matches case-insensitively in $ref", () => {
      const schema: JSONSchema = { $ref: "#/$defs/PERSON" };
      expect(schemaMatchesTag(schema, "person")).toBe(true);
    });

    it("does not match partial ref name", () => {
      const schema: JSONSchema = { $ref: "#/$defs/PersonInfo" };
      expect(schemaMatchesTag(schema, "person")).toBe(false);
    });
  });

  describe("handles edge cases", () => {
    it("returns false for undefined schema", () => {
      expect(schemaMatchesTag(undefined, "person")).toBe(false);
    });

    it("returns false for null schema", () => {
      expect(schemaMatchesTag(null as unknown as JSONSchema, "person")).toBe(
        false,
      );
    });

    it("returns false for boolean schema", () => {
      expect(schemaMatchesTag(true as unknown as JSONSchema, "person")).toBe(
        false,
      );
      expect(schemaMatchesTag(false as unknown as JSONSchema, "person")).toBe(
        false,
      );
    });

    it("returns false for empty schema", () => {
      const schema: JSONSchema = {};
      expect(schemaMatchesTag(schema, "person")).toBe(false);
    });

    it("handles tags with hyphens", () => {
      const schema: JSONSchema = { title: "my-custom-tag" };
      expect(schemaMatchesTag(schema, "my-custom-tag")).toBe(true);
    });

    it("handles tags with numbers", () => {
      const schema: JSONSchema = { title: "person2" };
      expect(schemaMatchesTag(schema, "person2")).toBe(true);
    });
  });
});

describe("collectMatches", () => {
  function* mockGenerator(
    items: TraversalMatch[],
  ): Generator<TraversalMatch> {
    for (const item of items) {
      yield item;
    }
  }

  const createMockMatch = (id: string): TraversalMatch => ({
    cell: { sourceURI: `of:${id}` } as any,
    path: [id],
    schema: { type: "object", title: id },
  });

  it("collects all items when limit is 0 (unlimited)", () => {
    const items = [
      createMockMatch("a"),
      createMockMatch("b"),
      createMockMatch("c"),
    ];
    const result = collectMatches(mockGenerator(items), 0);
    expect(result.length).toBe(3);
  });

  it("respects limit of 1", () => {
    const items = [
      createMockMatch("a"),
      createMockMatch("b"),
      createMockMatch("c"),
    ];
    const result = collectMatches(mockGenerator(items), 1);
    expect(result.length).toBe(1);
    expect(result[0].path).toEqual(["a"]);
  });

  it("respects limit of 2", () => {
    const items = [
      createMockMatch("a"),
      createMockMatch("b"),
      createMockMatch("c"),
    ];
    const result = collectMatches(mockGenerator(items), 2);
    expect(result.length).toBe(2);
  });

  it("returns all items if fewer than limit", () => {
    const items = [createMockMatch("a")];
    const result = collectMatches(mockGenerator(items), 5);
    expect(result.length).toBe(1);
  });

  it("handles empty generator", () => {
    const result = collectMatches(mockGenerator([]), 10);
    expect(result.length).toBe(0);
  });
});

// Integration tests with actual cells
const traversalSigner = await Identity.fromPassphrase("traversal tests");
const traversalSpace = traversalSigner.did();

describe("traverseForTag with cells", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  const space = traversalSpace;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: traversalSigner });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  const personSchema: JSONSchema = {
    type: "object",
    title: "Person",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  };

  const addressBookSchema: JSONSchema = {
    type: "object",
    title: "AddressBook",
    properties: {
      name: { type: "string" },
      contacts: {
        type: "array",
        items: personSchema,
      },
    },
  };

  it("finds matching cell at root level", () => {
    const cell = runtime.getCell(space, { name: "Alice", age: 30 }, personSchema, tx);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    const matches = [...traverseForTag(cell, options)];
    expect(matches.length).toBe(1);
    expect(matches[0].path).toEqual([]);
  });

  it("does not find match when tag doesn't exist", () => {
    const cell = runtime.getCell(space, { name: "Alice", age: 30 }, personSchema, tx);

    const options: TraversalOptions = {
      tag: "address",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    const matches = [...traverseForTag(cell, options)];
    expect(matches.length).toBe(0);
  });

  it("traverses into nested objects", () => {
    const addressBook = {
      name: "My Contacts",
      contacts: [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ],
    };

    // Create cell and explicitly set its value
    const cell = runtime.getCell(space, "addressbook-test", addressBookSchema, tx);
    cell.set(addressBook);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    const matches = [...traverseForTag(cell, options)];
    // Should find each person in the contacts array
    expect(matches.length).toBe(2);
    expect(matches[0].path).toContain("0");
    expect(matches[1].path).toContain("1");
  });

  it("respects maxDepth limit", () => {
    const addressBook = {
      name: "My Contacts",
      contacts: [
        { name: "Alice", age: 30 },
      ],
    };

    const cell = runtime.getCell(space, "depth-test", addressBookSchema, tx);
    cell.set(addressBook);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 0, // Only check root level
      limit: 0,
      runtime,
      tx,
    };

    const matches = [...traverseForTag(cell, options)];
    // With maxDepth 0, we only check root - which is AddressBook, not Person
    expect(matches.length).toBe(0);
  });

  it("returns array elements, not the array itself", () => {
    const tagsSchema: JSONSchema = {
      type: "array",
      title: "TagList",
      items: {
        type: "object",
        title: "Tag",
        properties: { label: { type: "string" } },
      },
    };

    const cell = runtime.getCell(space, "tags-test", tagsSchema, tx);
    cell.set([{ label: "work" }, { label: "personal" }]);

    const options: TraversalOptions = {
      tag: "tag",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    const matches = [...traverseForTag(cell, options)];
    // Should find each Tag element
    expect(matches.length).toBe(2);
    expect(matches[0].path).toEqual(["0"]);
    expect(matches[1].path).toEqual(["1"]);
  });

  it("handles cycle detection", () => {
    // Create a cell and set its value
    const cell = runtime.getCell(space, "cycle-test", personSchema, tx);
    cell.set({ name: "Test" });

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 100, // High depth to catch cycles
      limit: 0,
      runtime,
      tx,
    };

    // Pre-add the root path to seen set using the sourceURI:path format
    const rootKey = `${cell.sourceURI}:` as any; // Empty path joined is ""
    const seen = new Set([rootKey]);
    const matches = [...traverseForTag(cell, options, [], 0, seen)];

    // Should return 0 since cell was already seen
    expect(matches.length).toBe(0);
  });
});

const findMatchingSigner = await Identity.fromPassphrase("findMatchingCells tests");
const findMatchingSpace = findMatchingSigner.did();

describe("findMatchingCells", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  const space = findMatchingSpace;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: findMatchingSigner });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  const personSchema: JSONSchema = {
    type: "object",
    title: "Person",
    properties: {
      name: { type: "string" },
    },
  };

  it("searches across multiple cells", () => {
    const cell1 = runtime.getCell(space, { name: "Alice" }, personSchema, tx);
    const cell2 = runtime.getCell(space, { name: "Bob" }, personSchema, tx);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    const matches = findMatchingCells([cell1, cell2] as Cell<unknown>[], options);
    expect(matches.length).toBe(2);
  });

  it("respects limit across all cells", () => {
    const cell1 = runtime.getCell(space, { name: "Alice" }, personSchema, tx);
    const cell2 = runtime.getCell(space, { name: "Bob" }, personSchema, tx);
    const cell3 = runtime.getCell(space, { name: "Charlie" }, personSchema, tx);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 10,
      limit: 2, // Only want 2 results total
      runtime,
      tx,
    };

    const matches = findMatchingCells(
      [cell1, cell2, cell3] as Cell<unknown>[],
      options,
    );
    expect(matches.length).toBe(2);
  });

  it("deduplicates cells across multiple roots", () => {
    const cell = runtime.getCell(space, { name: "Alice" }, personSchema, tx);

    const options: TraversalOptions = {
      tag: "person",
      maxDepth: 10,
      limit: 0,
      runtime,
      tx,
    };

    // Same cell passed twice should only appear once
    const matches = findMatchingCells([cell, cell] as Cell<unknown>[], options);
    expect(matches.length).toBe(1);
  });
});
