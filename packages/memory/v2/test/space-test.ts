import { assertEquals, assertThrows } from "@std/assert";
import { SpaceV2 } from "../space.ts";
import { emptyRef } from "../reference.ts";
import type {
  ClientCommit,
  ConfirmedRead,
  Operation,
  Reference,
} from "../types.ts";
import { DEFAULT_BRANCH } from "../types.ts";

/** Helper: create an in-memory SpaceV2 for testing. */
function createSpace(snapshotInterval = 10): SpaceV2 {
  return SpaceV2.open({ url: new URL("memory:test"), snapshotInterval });
}

/** Helper: build a simple set commit. */
function setCommit(
  id: string,
  value: unknown,
  parent: Reference,
  confirmedReads: ConfirmedRead[] = [],
  branch?: string,
): ClientCommit {
  return {
    reads: {
      confirmed: confirmedReads,
      pending: [],
    },
    operations: [
      { op: "set", id, value, parent } as Operation,
    ],
    branch,
  };
}

Deno.test("SpaceV2 - open and close", () => {
  const space = createSpace();
  space.close();
});

Deno.test("SpaceV2 - write and read entity", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // Write
    const result = space.commit(setCommit(entityId, { name: "Alice" }, parent));
    assertEquals(result.version, 1);
    assertEquals(result.branch, DEFAULT_BRANCH);
    assertEquals(result.facts.length, 1);

    // Read
    const value = space.read(entityId);
    assertEquals(value, { name: "Alice" });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - read non-existent entity returns null", () => {
  const space = createSpace();
  try {
    assertEquals(space.read("entity:missing"), null);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - overwrite entity", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    const c1 = space.commit(setCommit(entityId, { name: "Alice" }, parent));

    // Overwrite with confirmed read at version 1
    const c2 = space.commit(setCommit(
      entityId,
      { name: "Bob" },
      c1.facts[0].hash,
      [{ id: entityId, hash: c1.facts[0].hash, version: c1.version }],
    ));

    assertEquals(c2.version, 2);
    assertEquals(space.read(entityId), { name: "Bob" });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - delete entity", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    const c1 = space.commit(setCommit(entityId, { name: "Alice" }, parent));

    // Delete
    const c2 = space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c1.facts[0].hash,
          version: c1.version,
        }],
        pending: [],
      },
      operations: [
        { op: "delete", id: entityId, parent: c1.facts[0].hash },
      ],
    });

    assertEquals(c2.version, 2);
    assertEquals(space.read(entityId), null);

    // Head still exists but points to delete fact
    const head = space.getHead(entityId);
    assertEquals(head !== null, true);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - patch operation", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // Initial set
    const c1 = space.commit(
      setCommit(entityId, { name: "Alice", age: 30 }, parent),
    );

    // Patch
    const c2 = space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c1.facts[0].hash,
          version: c1.version,
        }],
        pending: [],
      },
      operations: [
        {
          op: "patch",
          id: entityId,
          patches: [
            { op: "replace", path: "/name", value: "Bob" },
            { op: "add", path: "/email", value: "bob@example.com" },
          ],
          parent: c1.facts[0].hash,
        },
      ],
    });

    assertEquals(c2.version, 2);
    assertEquals(space.read(entityId), {
      name: "Bob",
      age: 30,
      email: "bob@example.com",
    });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - multiple patches reconstruct correctly", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // Initial set
    const c1 = space.commit(setCommit(entityId, { count: 0 }, parent));
    let prevHash = c1.facts[0].hash;
    let prevVersion = c1.version;

    // Apply 5 patches
    for (let i = 1; i <= 5; i++) {
      const c = space.commit({
        reads: {
          confirmed: [{ id: entityId, hash: prevHash, version: prevVersion }],
          pending: [],
        },
        operations: [
          {
            op: "patch",
            id: entityId,
            patches: [{ op: "replace", path: "/count", value: i }],
            parent: prevHash,
          },
        ],
      });
      prevHash = c.facts[0].hash;
      prevVersion = c.version;
    }

    assertEquals(space.read(entityId), { count: 5 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - multiple entities in one commit", () => {
  const space = createSpace();
  try {
    const parent1 = emptyRef("entity:1");
    const parent2 = emptyRef("entity:2");

    const c1 = space.commit({
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "entity:1", value: { a: 1 }, parent: parent1 },
        { op: "set", id: "entity:2", value: { b: 2 }, parent: parent2 },
      ],
    });

    assertEquals(c1.facts.length, 2);
    assertEquals(space.read("entity:1"), { a: 1 });
    assertEquals(space.read("entity:2"), { b: 2 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - query specific entity", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    space.commit(setCommit(entityId, { name: "Alice" }, parent));

    const result = space.query({ "entity:1": {} });
    assertEquals(result["entity:1"]?.value, { name: "Alice" });
    assertEquals(result["entity:1"]?.version, 1);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - query wildcard", () => {
  const space = createSpace();
  try {
    space.commit({
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: "entity:1",
          value: { a: 1 },
          parent: emptyRef("entity:1"),
        },
        {
          op: "set",
          id: "entity:2",
          value: { b: 2 },
          parent: emptyRef("entity:2"),
        },
      ],
    });

    const result = space.query({ "*": {} });
    assertEquals(Object.keys(result).length, 2);
    assertEquals(result["entity:1"]?.value, { a: 1 });
    assertEquals(result["entity:2"]?.value, { b: 2 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - conflict detection: stale read", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // First write
    space.commit(setCommit(entityId, { v: 1 }, parent));

    // Second write declares it read entity:1 at version 0 (stale)
    // This should fail because version 0 < head version 1
    assertThrows(
      () =>
        space.commit(setCommit(
          entityId,
          { v: 2 },
          parent,
          [{ id: entityId, hash: parent, version: 0 }],
        )),
      Error,
      "ConflictError",
    );
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - no conflict with fresh read", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    const c1 = space.commit(setCommit(entityId, { v: 1 }, parent));

    // Write with up-to-date read
    const c2 = space.commit(setCommit(
      entityId,
      { v: 2 },
      c1.facts[0].hash,
      [{ id: entityId, hash: c1.facts[0].hash, version: c1.version }],
    ));

    assertEquals(c2.version, 2);
    assertEquals(space.read(entityId), { v: 2 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - version numbering is global", () => {
  const space = createSpace();
  try {
    const c1 = space.commit(
      setCommit("entity:1", { v: 1 }, emptyRef("entity:1")),
    );
    assertEquals(c1.version, 1);

    const c2 = space.commit(
      setCommit("entity:2", { v: 2 }, emptyRef("entity:2")),
    );
    assertEquals(c2.version, 2);

    const c3 = space.commit(
      setCommit("entity:3", { v: 3 }, emptyRef("entity:3")),
    );
    assertEquals(c3.version, 3);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - claim operation validates reads", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    const c1 = space.commit(setCommit(entityId, { v: 1 }, parent));

    // Claim with correct read — should succeed (claim is read-only)
    const c2 = space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c1.facts[0].hash,
          version: c1.version,
        }],
        pending: [],
      },
      operations: [
        { op: "claim", id: entityId, parent: c1.facts[0].hash },
      ],
    });

    assertEquals(c2.version, 2);
    // Value unchanged since claim doesn't write
    assertEquals(space.read(entityId), { v: 1 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - snapshot creation after interval", () => {
  // Use interval of 3 for testing
  const space = createSpace(3);
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // Initial set
    const c1 = space.commit(setCommit(entityId, { count: 0 }, parent));
    let prevHash = c1.facts[0].hash;
    let prevVersion = c1.version;

    // Apply 4 patches (should trigger snapshot after 3)
    for (let i = 1; i <= 4; i++) {
      const c = space.commit({
        reads: {
          confirmed: [{ id: entityId, hash: prevHash, version: prevVersion }],
          pending: [],
        },
        operations: [
          {
            op: "patch",
            id: entityId,
            patches: [{ op: "replace", path: "/count", value: i }],
            parent: prevHash,
          },
        ],
      });
      prevHash = c.facts[0].hash;
      prevVersion = c.version;
    }

    // Value should still be correct regardless of snapshot
    assertEquals(space.read(entityId), { count: 4 });
  } finally {
    space.close();
  }
});

// ─── Branch Tests ─────────────────────────────────────────────────────────────

Deno.test("SpaceV2 - branch: create and list", () => {
  const space = createSpace();
  try {
    space.createBranch("feature-a");

    const branches = space.listBranches();
    assertEquals(branches.length, 2); // default + feature-a
    assertEquals(branches[0].name, ""); // default
    assertEquals(branches[1].name, "feature-a");
    assertEquals(branches[1].parent_branch, "");
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - branch: write isolation", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";

    // Write to default branch
    space.commit(setCommit(entityId, { v: "main" }, emptyRef(entityId)));

    // Create branch
    space.createBranch("draft");

    // Write to branch
    space.commit(setCommit(
      entityId,
      { v: "draft" },
      emptyRef(entityId),
      [],
      "draft",
    ));

    // Default branch unchanged
    assertEquals(space.read(entityId, DEFAULT_BRANCH), { v: "main" });
    // Branch has its own value
    assertEquals(space.read(entityId, "draft"), { v: "draft" });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - branch: delete", () => {
  const space = createSpace();
  try {
    space.createBranch("temp");
    space.commit(setCommit(
      "entity:1",
      { v: 1 },
      emptyRef("entity:1"),
      [],
      "temp",
    ));

    space.deleteBranch("temp");

    const branches = space.listBranches();
    assertEquals(branches.length, 1); // only default
    assertEquals(space.read("entity:1", "temp"), null);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - branch: cannot delete default", () => {
  const space = createSpace();
  try {
    assertThrows(
      () => space.deleteBranch(DEFAULT_BRANCH),
      Error,
      "Cannot delete the default branch",
    );
  } finally {
    space.close();
  }
});

// ─── Blob Tests ───────────────────────────────────────────────────────────────

Deno.test("SpaceV2 - blob: write and read", () => {
  const space = createSpace();
  try {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    space.writeBlob("hash123", data, "application/octet-stream");

    const blob = space.readBlob("hash123");
    assertEquals(blob !== null, true);
    assertEquals(blob!.contentType, "application/octet-stream");
    assertEquals(blob!.size, 5);
    assertEquals(blob!.data, data);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - blob: read non-existent returns null", () => {
  const space = createSpace();
  try {
    assertEquals(space.readBlob("nonexistent"), null);
  } finally {
    space.close();
  }
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

Deno.test("SpaceV2 - write after delete", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const parent = emptyRef(entityId);

    // Set
    const c1 = space.commit(setCommit(entityId, { v: 1 }, parent));

    // Delete
    const c2 = space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c1.facts[0].hash,
          version: c1.version,
        }],
        pending: [],
      },
      operations: [
        { op: "delete", id: entityId, parent: c1.facts[0].hash },
      ],
    });

    assertEquals(space.read(entityId), null);

    // Re-write — parent is the delete fact
    space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c2.facts[0].hash,
          version: c2.version,
        }],
        pending: [],
      },
      operations: [
        { op: "set", id: entityId, value: { v: 2 }, parent: c2.facts[0].hash },
      ],
    });

    assertEquals(space.read(entityId), { v: 2 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - large batch: 100 entities", () => {
  const space = createSpace();
  try {
    const ops: Operation[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `entity:${i}`;
      ops.push({
        op: "set",
        id,
        value: { index: i },
        parent: emptyRef(id),
      });
    }

    const c = space.commit({
      reads: { confirmed: [], pending: [] },
      operations: ops,
    });

    assertEquals(c.facts.length, 100);
    assertEquals(c.version, 1); // All in one commit

    // Verify a few
    assertEquals(space.read("entity:0"), { index: 0 });
    assertEquals(space.read("entity:50"), { index: 50 });
    assertEquals(space.read("entity:99"), { index: 99 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - rapid overwrites: same entity 20 times", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    let prevHash = emptyRef(entityId) as Reference;
    let prevVersion = 0;

    for (let i = 0; i < 20; i++) {
      const reads = prevVersion > 0
        ? [{ id: entityId, hash: prevHash, version: prevVersion }]
        : [];
      const c = space.commit(setCommit(entityId, { v: i }, prevHash, reads));
      prevHash = c.facts[0].hash;
      prevVersion = c.version;
    }

    assertEquals(space.read(entityId), { v: 19 });
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - readFactEntry returns correct data", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    space.commit(setCommit(entityId, { name: "test" }, emptyRef(entityId)));

    const entry = space.readFactEntry(entityId);
    assertEquals(entry !== null, true);
    assertEquals(entry!.value, { name: "test" });
    assertEquals(entry!.version, 1);
  } finally {
    space.close();
  }
});

Deno.test("SpaceV2 - readFactEntry for deleted entity has no value", () => {
  const space = createSpace();
  try {
    const entityId = "entity:1";
    const c1 = space.commit(setCommit(entityId, { v: 1 }, emptyRef(entityId)));

    space.commit({
      reads: {
        confirmed: [{
          id: entityId,
          hash: c1.facts[0].hash,
          version: c1.version,
        }],
        pending: [],
      },
      operations: [
        { op: "delete", id: entityId, parent: c1.facts[0].hash },
      ],
    });

    const entry = space.readFactEntry(entityId);
    assertEquals(entry !== null, true);
    assertEquals(entry!.value, undefined);
    assertEquals(entry!.version, 2);
  } finally {
    space.close();
  }
});
