// Cell link tests: getAsLink, getAsWriteRedirectLink, and getImmutableCell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const signer2 = await Identity.fromPassphrase("test operator 2");
const space2 = signer2.did();

describe("getAsLink method", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should return new sigil format", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    // Get the new sigil format
    const link = cell.getAsLink();

    // Verify structure
    expect(link["/"]).toBeDefined();
    expect(link["/"][LINK_V1_TAG]).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toBeDefined();

    // Verify id has of: prefix
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(link["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const link = nestedCell.getAsLink();

    expect(link["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should return sigil format for both getAsLink and toJSON", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-json-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    const link = cell.getAsLink();
    const json = cell.toJSON();

    // getAsLink returns sigil format
    expect(link).toHaveProperty("/");
    expect(link["/"][LINK_V1_TAG]).toBeDefined();

    // toJSON now also returns sigil format (includes space for cross-space references)
    expect(json).toHaveProperty("/");
    expect((json as any)["/"][LINK_V1_TAG]).toBeDefined();
    expect((json as any)["/"][LINK_V1_TAG].id).toBeDefined();
    expect((json as any)["/"][LINK_V1_TAG].path).toEqual([]);
    // Verify space is included for cross-space resolution
    expect((json as any)["/"][LINK_V1_TAG].space).toEqual(space);
  });

  it("should create relative links with base parameter - same document", () => {
    const c = runtime.getCell<{ value: number; other: string }>(
      space,
      "getAsLink-base-test",
      undefined,
      tx,
    );
    c.set({ value: 42, other: "test" });
    const cell = c.key("value");

    // Link relative to base cell (same document)
    const link = cell.getAsLink({ base: c });

    // Should omit id and space since they're the same
    expect(link["/"][LINK_V1_TAG].id).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different document", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-base-test-2",
      undefined,
      tx,
    );
    c2.set({ other: "test" });
    const cell = c1.key("value");

    // Link relative to base cell (different document, same space)
    const link = cell.getAsLink({ base: c2 });

    // Should include id but not space since space is the same
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different space", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const tx2 = runtime.edit(); // We're writing into a different space!
    const c2 = runtime.getCell<{ other: string }>(
      space2,
      "getAsLink-base-test-2",
      undefined,
      tx2,
    );
    c2.set({ other: "test" });
    tx2.commit();
    const cell = c1.key("value");

    // Link relative to base cell (different space)
    const link = cell.getAsLink({ base: c2 });

    // Should include both id and space since they're different
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should include schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link with schema included
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should not include schema when includeSchema is false", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link without schema
    const link = cell.getAsLink({ includeSchema: false });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should not include schema when includeSchema is undefined", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-default-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value");

    // Link with default options (no schema)
    const link = cell.getAsLink();

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should handle both base and includeSchema options together", () => {
    const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-combined-test-1",
      schema,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-combined-test-2",
      undefined,
      tx,
    );
    const cell = c1.key("value").asSchema(schema);

    // Link with both base and schema options
    const link = cell.getAsLink({ base: c2, includeSchema: true });

    // Should include id (different docs) but not space (same space)
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
  });

  it("should handle cell without schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-cell-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value"); // No schema provided

    // Link with includeSchema but cell has no schema
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });
});

describe("getAsWriteRedirectLink method", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("should return new sigil alias format", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsWriteRedirectLink-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c;

    // Get the new sigil alias format
    const alias = cell.getAsWriteRedirectLink();

    // Verify structure
    expect(alias["/"]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].id).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].path).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].overwrite).toBe("redirect");

    // Verify id has of: prefix
    expect(alias["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(alias["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(alias["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsWriteRedirectLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const alias = nestedCell.getAsWriteRedirectLink();

    expect(alias["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should omit space when baseSpace matches", () => {
    const cell = runtime.getCell(
      space,
      "getAsWriteRedirectLink-baseSpace-test",
      undefined,
      tx,
    );

    // Get alias with same base space
    const alias = cell.getAsWriteRedirectLink({ baseSpace: space });

    // Should omit space
    expect(alias["/"][LINK_V1_TAG].space).toBeUndefined();
  });
});

describe("getImmutableCell", () => {
  describe("asCell", () => {
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

    it("should create a cell with the correct schema", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
      } as const satisfies JSONSchema;
      const cell = runtime.getImmutableCell(space, { value: 42 }, schema, tx);
      expect(cell.get()).toEqualIgnoringSymbols({ value: 42 });
    });
  });
});
