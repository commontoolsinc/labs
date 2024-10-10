import { describe, it, expect, vi } from "vitest";
import {
  createRef,
  getEntityId,
  getCellByEntityId,
  setCellByEntityId,
  EntityId,
} from "../src/cell-map";
import { cell } from "../src/cell.js";
import { refer } from "merkle-reference";

// Mock the crypto.randomUUID function
vi.mock("crypto", () => ({
  randomUUID: () => "mocked-uuid",
}));

describe("refer", () => {
  it("should create a reference that is equal to another reference with the same source", () => {
    const ref = refer({ hello: "world" });
    const ref2 = refer({ hello: "world" });
    expect(ref).toEqual(ref2);
  });
});

describe("cell-map", () => {
  describe("createRef", () => {
    it("should create a reference with default values", () => {
      const ref = createRef();
      const ref2 = createRef("mocked-uuid");
      expect(ref).toEqual(ref2);
    });

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
      const c = cell();
      c.generateEntityId();

      expect(getEntityId(c)).toEqual(c.entityId);
      expect(getEntityId(c.getAsProxy())).toEqual(c.entityId);
      expect(getEntityId(c.getAsProxy([]))).toEqual(c.entityId);
      expect(getEntityId(c.asSimpleCell())).toEqual(c.entityId);
      expect(getEntityId(c.asSimpleCell([]))).toEqual(c.entityId);
      expect(getEntityId({ cell: c, path: [] })).toEqual(c.entityId);
    });

    it("should return a different entity ID for reference with paths", () => {
      const c = cell();
      c.generateEntityId();

      expect(getEntityId(c.getAsProxy())).toEqual(c.entityId);
      expect(getEntityId(c.getAsProxy(["foo"]))).not.toEqual(c.entityId);
      expect(getEntityId(c.asSimpleCell(["foo"]))).not.toEqual(c.entityId);
      expect(getEntityId({ cell: c, path: ["foo"] })).not.toEqual(c.entityId);

      expect(getEntityId(c.getAsProxy(["foo"]))).toEqual(
        getEntityId(c.asSimpleCell(["foo"]))
      );
      expect(getEntityId(c.getAsProxy(["foo"]))).toEqual(
        getEntityId({ cell: c, path: ["foo"] })
      );
    });
  });

  describe("getCellByEntityId and setCellByEntityId", () => {
    it("should set and get a cell by entity ID", () => {
      const c = cell({ value: 42 });
      c.generateEntityId();

      const retrievedCell = getCellByEntityId(c.entityId!);

      expect(retrievedCell).toBe(c);
    });

    it("should return undefined for non-existent entity ID", () => {
      const nonExistentId = createRef() as EntityId;
      expect(getCellByEntityId(nonExistentId)).toBeUndefined();
    });
  });
});
