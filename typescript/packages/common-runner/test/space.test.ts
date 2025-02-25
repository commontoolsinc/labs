import { describe, it, expect } from "vitest";
import { getSpace, DEFAULT_SPACE } from "../src/space.js";
import { getDoc } from "../src/doc.js";
import { getDocByEntityId } from "../src/cell-map.js";

describe("Space", () => {
  it("should create spaces with URIs", () => {
    const space = getSpace("test://example");
    expect(space.uri).toBe("test://example");
  });

  it("should return the same space object for the same URI", () => {
    const space1 = getSpace("test://example");
    const space2 = getSpace("test://example");
    expect(space1).toBe(space2);
  });

  it("should have an empty string URI for DEFAULT_SPACE", () => {
    expect(DEFAULT_SPACE.uri).toBe("");
  });
});

describe("Space with Docs", () => {
  it("should allow same entity ID in different spaces", () => {
    const space1 = getSpace("test://space1");
    const space2 = getSpace("test://space2");

    // Create a doc with same value in different spaces
    const value = { test: "value" };
    const cause = "test-cause";

    const doc1 = getDoc(value, cause, space1);
    const doc2 = getDoc(value, cause, space2);

    // Same entity ID (since same value and cause)
    expect(doc1.entityId).toEqual(doc2.entityId);

    // But different doc instances
    expect(doc1 !== doc2).toBe(true);

    // Can retrieve from correct space
    expect(getDocByEntityId(doc1.entityId!, true, space1) === doc1).toBe(true);
    expect(getDocByEntityId(doc2.entityId!, true, space2) === doc2).toBe(true);

    // Different spaces don't interfere
    expect(getDocByEntityId(doc1.entityId!, false, space2) !== doc1).toBe(true);
  });

  it("should use DEFAULT_SPACE when no space specified", () => {
    const value = { test: "default" };
    const cause = "test-cause";

    const doc = getDoc(value, cause); // No space specified
    const docWithDefault = getDoc(value, cause, DEFAULT_SPACE);

    // Same doc retrieved from default space
    expect(doc).toBe(docWithDefault);
    expect(getDocByEntityId(doc.entityId!)).toBe(doc);
  });

  it("should maintain space separation with multiple docs", () => {
    const space1 = getSpace("test://space1");
    const space2 = getSpace("test://space2");

    // Create multiple docs in each space
    const doc1a = getDoc({ id: "1a" }, "cause1", space1);
    const doc1b = getDoc({ id: "1b" }, "cause2", space1);
    const doc2a = getDoc({ id: "1a" }, "cause1", space2); // Same value/cause as doc1a

    // Verify space isolation
    expect(getDocByEntityId(doc1a.entityId!, true, space1) === doc1a).toBe(true);
    expect(getDocByEntityId(doc1b.entityId!, true, space1) === doc1b).toBe(true);
    expect(getDocByEntityId(doc2a.entityId!, true, space2) === doc2a).toBe(true);

    // Verify cross-space retrieval doesn't work
    expect(getDocByEntityId(doc1a.entityId!, false, space2) !== doc1a).toBe(true);
    expect(getDocByEntityId(doc2a.entityId!, false, space1) !== doc2a).toBe(true);
  });
});
