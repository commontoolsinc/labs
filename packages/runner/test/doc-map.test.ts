import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRef, type EntityId, getEntityId } from "../src/doc-map.ts";
import { refer } from "merkle-reference";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("refer", () => {
  it("should create a reference that is equal to another reference with the same source", () => {
    const ref = refer({ hello: "world" });
    const ref2 = refer({ hello: "world" });
    expect(ref).toEqual(ref2);
  });
});

describe("cell-map", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    // Create memory service for testing
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("createRef", () => {
    it("should create a reference with custom source and cause", () => {
      const source = { foo: "bar" };
      const cause = "custom-cause";
      const ref = createRef(source, cause);
      const ref2 = createRef(source);
      expect(ref).not.toEqual(ref2);
    });
  });

  describe("getEntityId", () => {
    it("should return undefined for non-cell values", () => {
      expect(getEntityId({})).toBeUndefined();
      expect(getEntityId(null)).toBeUndefined();
      expect(getEntityId(42)).toBeUndefined();
    });

    it("should return the entity ID for a cell", () => {
      const cell = runtime.getCell(space, "test-cell", undefined, tx);
      cell.set({});
      const id = getEntityId(cell);

      expect(getEntityId(cell)).toEqual(id);
      expect(getEntityId(cell.getAsQueryResult())).toEqual(id);
      expect(getEntityId(cell.getAsLegacyCellLink())).toEqual(id);
    });

    it("should return a different entity ID for reference with paths", () => {
      const c = runtime.getCell<{ foo: { bar: number } }>(
        space,
        "test-with-paths",
        undefined,
        tx,
      );
      c.set({ foo: { bar: 42 } });
      const id = getEntityId(c);

      expect(getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(getEntityId(c.getAsQueryResult(["foo"]))).not.toEqual(id);
      expect(getEntityId(c.key("foo"))).not.toEqual(id);
      expect(getEntityId(c.key("foo").getAsLegacyCellLink())).not.toEqual(id);

      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo")),
      );
      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo").getAsLegacyCellLink()),
      );
    });
  });

  describe("getCellByEntityId and setCellByEntityId", () => {
    it("should set and get a cell by entity ID", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "test-by-entity-id",
        undefined,
        tx,
      );
      c.set({ value: 42 });

      // Use Cell API to retrieve by entity ID
      const retrievedCell = runtime.getCellFromEntityId<{ value: number }>(
        space,
        c.entityId!,
      );

      // Verify we got the same cell
      expect(retrievedCell.entityId).toEqual(c.entityId);
      expect(retrievedCell.get()).toEqual({ value: 42 });

      // Also verify the cells are equal
      expect(retrievedCell.equals(c)).toBe(true);
    });

    it("should return undefined for non-existent entity ID", () => {
      const nonExistentId = createRef() as EntityId;
      // Note: We must use getDocByEntityId directly here because getCellFromEntityId
      // always creates a new doc if not found (createIfNotFound: true)
      expect(runtime.documentMap.getDocByEntityId(space, nonExistentId, false))
        .toBeUndefined();
    });
  });

  describe("cells as JSON", () => {
    it("should serialize the entity ID", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "test-json",
        undefined,
        tx,
      );
      c.set({ value: 42 });

      const expected = JSON.stringify({
        cell: c.entityId,
        path: [],
      });
      expect(JSON.stringify(c)).toEqual(expected);
    });
  });
});
