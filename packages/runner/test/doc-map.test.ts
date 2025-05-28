import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type EntityId, createRef } from "../src/doc-map.ts";
import { refer } from "merkle-reference";
import { Runtime } from "../src/runtime.ts";

describe("refer", () => {
  it("should create a reference that is equal to another reference with the same source", () => {
    const ref = refer({ hello: "world" });
    const ref2 = refer({ hello: "world" });
    expect(ref).toEqual(ref2);
  });
});

describe("cell-map", () => {
  let runtime: Runtime;
  
  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://test"
    });
  });
  
  afterEach(() => {
    runtime.dispose();
  });

  describe("createRef", () => {
    it("should create a reference with custom source and cause", () => {
      const source = { foo: "bar" };
      const cause = "custom-cause";
      const ref = runtime.documentMap.createRef(source, cause);
      const ref2 = runtime.documentMap.createRef(source);
      expect(ref).not.toEqual(ref2);
    });
  });

  describe("getEntityId", () => {
    it("should return undefined for non-cell values", () => {
      expect(runtime.documentMap.getEntityId({})).toBeUndefined();
      expect(runtime.documentMap.getEntityId(null)).toBeUndefined();
      expect(runtime.documentMap.getEntityId(42)).toBeUndefined();
    });

    it("should return the entity ID for a cell", () => {
      const c = runtime.documentMap.getDoc({}, undefined, "test");
      const id = runtime.documentMap.getEntityId(c);

      expect(runtime.documentMap.getEntityId(c)).toEqual(id);
      expect(runtime.documentMap.getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(runtime.documentMap.getEntityId(c.asCell())).toEqual(id);
      expect(runtime.documentMap.getEntityId({ cell: c, path: [] })).toEqual(id);
    });

    it("should return a different entity ID for reference with paths", () => {
      const c = runtime.documentMap.getDoc({ foo: { bar: 42 } }, undefined, "test");
      const id = runtime.documentMap.getEntityId(c);

      expect(runtime.documentMap.getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(runtime.documentMap.getEntityId(c.getAsQueryResult(["foo"]))).not.toEqual(id);
      expect(runtime.documentMap.getEntityId(c.asCell(["foo"]))).not.toEqual(id);
      expect(runtime.documentMap.getEntityId({ cell: c, path: ["foo"] })).not.toEqual(id);

      expect(runtime.documentMap.getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        runtime.documentMap.getEntityId(c.asCell(["foo"])),
      );
      expect(runtime.documentMap.getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        runtime.documentMap.getEntityId({ cell: c, path: ["foo"] }),
      );
    });
  });

  describe("getCellByEntityId and setCellByEntityId", () => {
    it("should set and get a cell by entity ID", () => {
      const c = runtime.documentMap.getDoc({ value: 42 }, undefined, "test");

      const retrievedCell = runtime.documentMap.getDocByEntityId(c.space, c.entityId!);

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
      const c = runtime.documentMap.getDoc({ value: 42 }, "cause", "test");
      expect(JSON.stringify(c)).toEqual(JSON.stringify(c.entityId));
    });
  });
});
