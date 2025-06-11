import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRef, type EntityId, getEntityId } from "../src/doc-map.ts";
import { refer } from "merkle-reference";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import { StorageManager } from "../src/storage/cache.ts";

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

  beforeEach(async () => {
    // Create memory service for testing
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
      const c = runtime.documentMap.getDoc({}, undefined, space);
      const id = getEntityId(c);

      expect(getEntityId(c)).toEqual(id);
      expect(getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(getEntityId(c.asCell())).toEqual(id);
      expect(getEntityId({ cell: c, path: [] })).toEqual(id);
    });

    it("should return a different entity ID for reference with paths", () => {
      const c = runtime.documentMap.getDoc(
        { foo: { bar: 42 } },
        undefined,
        space,
      );
      const id = getEntityId(c);

      expect(getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(getEntityId(c.getAsQueryResult(["foo"]))).not.toEqual(id);
      expect(getEntityId(c.asCell(["foo"]))).not.toEqual(id);
      expect(getEntityId({ cell: c, path: ["foo"] })).not.toEqual(id);

      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.asCell(["foo"])),
      );
      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId({ cell: c, path: ["foo"] }),
      );
    });
  });

  describe("getCellByEntityId and setCellByEntityId", () => {
    it("should set and get a cell by entity ID", () => {
      const c = runtime.documentMap.getDoc({ value: 42 }, undefined, space);

      const retrievedCell = runtime.documentMap.getDocByEntityId(
        c.space,
        c.entityId!,
      );

      expect(retrievedCell).toBe(c);
    });

    it("should return undefined for non-existent entity ID", () => {
      const nonExistentId = createRef() as EntityId;
      expect(runtime.documentMap.getDocByEntityId("test", nonExistentId, false))
        .toBeUndefined();
    });
  });

  describe("cells as JSON", () => {
    it("should serialize the entity ID", () => {
      const c = runtime.documentMap.getDoc({ value: 42 }, "cause", space);
      expect(JSON.stringify(c)).toEqual(JSON.stringify(c.entityId));
    });
  });
});
