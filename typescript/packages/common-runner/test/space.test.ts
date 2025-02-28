import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getSpace } from "../src/space.ts";
import { getDoc } from "../src/doc.ts";
import { getDocByEntityId } from "../src/cell-map.ts";

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
    expect(getDocByEntityId(space1, doc1.entityId!, true) === doc1).toBe(true);
    expect(getDocByEntityId(space2, doc2.entityId!, true) === doc2).toBe(true);

    // Different spaces don't interfere
    expect(getDocByEntityId(space2, doc1.entityId!, false) !== doc1).toBe(true);
  });

  it("should maintain space separation with multiple docs", () => {
    const space1 = getSpace("test://space1");
    const space2 = getSpace("test://space2");

    // Create multiple docs in each space
    const doc1a = getDoc({ id: "1a" }, "cause1", space1);
    const doc1b = getDoc({ id: "1b" }, "cause2", space1);
    const doc2a = getDoc({ id: "1a" }, "cause1", space2); // Same value/cause as doc1a

    // Verify space isolation
    expect(getDocByEntityId(space1, doc1a.entityId!, true) === doc1a).toBe(true);
    expect(getDocByEntityId(space1, doc1b.entityId!, true) === doc1b).toBe(true);
    expect(getDocByEntityId(space2, doc2a.entityId!, true) === doc2a).toBe(true);

    // Verify cross-space retrieval doesn't work
    expect(getDocByEntityId(space2, doc1a.entityId!, false) !== doc1a).toBe(true);
    expect(getDocByEntityId(space1, doc2a.entityId!, false) !== doc2a).toBe(true);
  });
});
