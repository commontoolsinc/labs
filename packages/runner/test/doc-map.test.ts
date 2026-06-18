import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRef, entityIdFrom, getEntityId } from "../src/create-ref.ts";
import {
  entityRefToString,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("hashOf", () => {
  it("should create a reference that is equal to another reference with the same source", () => {
    const ref = hashOf({ hello: "world" });
    const ref2 = hashOf({ hello: "world" });
    expect(ref.taggedHashString).toEqual(ref2.taggedHashString);
  });
});

describe("getEntityId (string forms)", () => {
  const tagged = hashOf({ test: "get-entity-id" }).taggedHashString;

  afterEach(() => {
    resetModernCellRepConfig();
  });

  it("reads a bare id string", () => {
    setModernCellRepConfig(false);
    expect(entityRefToString(getEntityId(tagged)!)).toBe(tagged);
  });

  it("reads an `of:`-prefixed id string", () => {
    setModernCellRepConfig(false);
    expect(entityRefToString(getEntityId(`of:${tagged}`)!)).toBe(tagged);
  });

  it("reads a JSON-serialized legacy ref in legacy mode", () => {
    setModernCellRepConfig(false);
    const json = JSON.stringify({ "/": tagged });
    expect(getEntityId(json)).toEqual(getEntityId(tagged));
    expect(entityRefToString(getEntityId(json)!)).toBe(tagged);
  });

  it('returns undefined for a JSON `{ "/": … }` ref in modern mode', () => {
    setModernCellRepConfig(true);
    expect(getEntityId(JSON.stringify({ "/": tagged }))).toBeUndefined();
  });

  it("returns undefined for a JSON object that isn't a ref", () => {
    setModernCellRepConfig(false);
    expect(getEntityId(JSON.stringify({ not: "a ref" }))).toBeUndefined();
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

  describe("createRef", () => {
    it("should create a reference with custom source and cause", () => {
      const source = { foo: "bar" };
      const cause = "custom-cause";
      const ref = createRef(source, cause);
      const ref2 = createRef(source);
      expect(ref.taggedHashString).not.toEqual(ref2.taggedHashString);
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
      expect(getEntityId(cell.getAsLink())).toEqual(id);
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
      expect(getEntityId(c.key("foo").getAsLink())).not.toEqual(id);

      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo")),
      );
      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo").getAsLink()),
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
      tx.commit();

      // Use Cell API to retrieve by entity ID
      const retrievedCell = runtime.getCellFromEntityId<{ value: number }>(
        space,
        entityIdFrom(entityRefToString(c.entityId)),
      );

      // Verify we got the same cell
      expect(retrievedCell.entityId).toEqual(c.entityId);
      expect(retrievedCell.get()).toEqual({ value: 42 });

      // Also verify the cells are equal
      expect(retrievedCell.equals(c)).toBe(true);
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

      // toJSON returns sigil format with space for cross-space resolution
      const json = JSON.parse(JSON.stringify(c));
      expect(json["/"]).toBeDefined();
      expect(json["/"][LINK_V1_TAG]).toBeDefined();
      expect(json["/"][LINK_V1_TAG].id).toContain(
        entityRefToString(c.entityId),
      );
      expect(json["/"][LINK_V1_TAG].path).toEqual([]);
      expect(json["/"][LINK_V1_TAG].space).toEqual(space);
    });
  });
});
