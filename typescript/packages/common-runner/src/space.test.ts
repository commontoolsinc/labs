import { describe, expect, it } from "vitest";
import { getSpace, DEFAULT_SPACE } from "./space.js";
import { getDoc } from "./doc.js";
import { getDocByEntityId } from "./cell-map.js";

describe("Doc Space Attribution", () => {
  it("should allow docs without space", () => {
    const doc = getDoc({ test: "value" });
    expect(doc.space).toBeUndefined();
  });

  it("should set DEFAULT_SPACE when generating entity ID without space", () => {
    const doc = getDoc({ test: "value" });
    doc.generateEntityId("cause");
    expect(doc.space).toBe(DEFAULT_SPACE);
  });

  it("should set DEFAULT_SPACE when setting entity ID without space", () => {
    const doc = getDoc({ test: "value" });
    const otherdoc = getDoc({ test: "value" }, "cause");
    doc.entityId = otherdoc.entityId!;
    expect(doc.space).toBe(DEFAULT_SPACE);
  });

  it("should use provided space when generating entity ID", () => {
    const space = getSpace("test://example");
    const doc = getDoc({ test: "value" }, undefined, space);
    doc.generateEntityId("cause");
    expect(doc.space).toBe(space);
  });

  it("should maintain space through getDocByEntityId", () => {
    const space = getSpace("test://example");
    const doc = getDoc({ test: "value" }, "cause", space);

    const retrieved = getDocByEntityId(doc.entityId!, true, space);
    expect(retrieved?.space).toBe(space);
  });

  it("should throw when trying to unset space with entity ID", () => {
    const doc = getDoc({ test: "value" }, "cause"); // This will have DEFAULT_SPACE
    expect(() => {
      doc.space = undefined;
    }).toThrow("Space cannot be undefined when entity ID is set");
  });

  it("should allow changing space when no entity ID", () => {
    const doc = getDoc({ test: "value" });
    const space = getSpace("test://example");
    doc.space = space;
    expect(doc.space).toBe(space);
    doc.space = undefined;
    expect(doc.space).toBeUndefined();
  });
});
