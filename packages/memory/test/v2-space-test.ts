import { assertEquals } from "@std/assert";
import { openV2Space } from "../v2-space.ts";
import { applyCommit, V2ConflictError } from "../v2-commit.ts";
import { readBlob, writeBlob } from "../v2-blob.ts";
import { EMPTY } from "../v2-reference.ts";
import type {
  ClaimOperation,
  ClientCommit,
  Commit,
  DeleteOperation,
  EntityId,
  PatchWriteOperation,
  SetOperation,
} from "../v2-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_A: EntityId = "urn:entity:aaa";
const ENTITY_B: EntityId = "urn:entity:bbb";

/** Open a fresh in-memory v2 space for testing. */
function freshSpace() {
  return openV2Space(new URL("memory:test-space"));
}

/** Build a minimal ClientCommit with set operations. */
function makeSetCommit(
  id: EntityId,
  value: unknown,
  parent?: ReturnType<typeof EMPTY>,
  branch?: string,
): ClientCommit {
  const p = parent ?? EMPTY(id);
  const commit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      { op: "set", id, value, parent: p } as SetOperation,
    ],
  };
  if (branch !== undefined) {
    commit.branch = branch;
  }
  return commit;
}

// ---------------------------------------------------------------------------
// 1. Schema initialization
// ---------------------------------------------------------------------------

Deno.test("schema initialization: open in-memory space works", () => {
  const space = freshSpace();
  // Verify the database is usable by reading a non-existent entity
  const val = space.readEntity("", ENTITY_A);
  assertEquals(val, null);
  space.close();
});

// ---------------------------------------------------------------------------
// 2. Set / read roundtrip
// ---------------------------------------------------------------------------

Deno.test("set/read roundtrip: write and read back a value", () => {
  const space = freshSpace();
  const result = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { name: "Alice", age: 30 }),
  );

  assertEquals("ok" in result, true);

  const value = space.readEntity("", ENTITY_A);
  assertEquals(value, { name: "Alice", age: 30 });
  space.close();
});

Deno.test("set/read roundtrip: overwrite existing value", () => {
  const space = freshSpace();

  // First write
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Second write (use the fact hash from first write as parent)
  const parentHash = commit1.facts[0].hash;
  const r2 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { v: 2 }, parentHash as ReturnType<typeof EMPTY>),
  );
  assertEquals("ok" in r2, true);

  const value = space.readEntity("", ENTITY_A);
  assertEquals(value, { v: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 3. Patch and read (replay)
// ---------------------------------------------------------------------------

Deno.test("patch and read: apply patches and reconstruct value", () => {
  const space = freshSpace();

  // First: set a base value
  const r1 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { name: "Alice", tags: [] }),
  );
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;
  const parentHash = commit1.facts[0].hash;

  // Then: apply a patch
  const patchCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "patch",
        id: ENTITY_A,
        patches: [
          { op: "replace", path: "/name", value: "Bob" },
          { op: "add", path: "/tags/-", value: "admin" },
        ],
        parent: parentHash,
      } as PatchWriteOperation,
    ],
  };

  const r2 = applyCommit(space.store, patchCommit);
  assertEquals("ok" in r2, true);

  const value = space.readEntity("", ENTITY_A);
  assertEquals(value, { name: "Bob", tags: ["admin"] });
  space.close();
});

// ---------------------------------------------------------------------------
// 4. Delete entity
// ---------------------------------------------------------------------------

Deno.test("delete entity: deleted entity returns null", () => {
  const space = freshSpace();

  // Set a value
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;
  const parentHash = commit1.facts[0].hash;

  // Delete it
  const deleteCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "delete",
        id: ENTITY_A,
        parent: parentHash,
      } as DeleteOperation,
    ],
  };

  const r2 = applyCommit(space.store, deleteCommit);
  assertEquals("ok" in r2, true);

  const value = space.readEntity("", ENTITY_A);
  assertEquals(value, null);
  space.close();
});

// ---------------------------------------------------------------------------
// 5. Multiple entities
// ---------------------------------------------------------------------------

Deno.test("multiple entities: independent entities coexist", () => {
  const space = freshSpace();

  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  assertEquals("ok" in r1, true);

  const r2 = applyCommit(space.store, makeSetCommit(ENTITY_B, { b: 2 }));
  assertEquals("ok" in r2, true);

  assertEquals(space.readEntity("", ENTITY_A), { a: 1 });
  assertEquals(space.readEntity("", ENTITY_B), { b: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 6. Version numbering (Lamport clock)
// ---------------------------------------------------------------------------

Deno.test("version numbering: versions increment monotonically", () => {
  const space = freshSpace();

  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const v1 = (r1 as { ok: Commit }).ok.version;

  const commit1 = (r1 as { ok: Commit }).ok;
  const parentHash = commit1.facts[0].hash;

  const r2 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { v: 2 }, parentHash as ReturnType<typeof EMPTY>),
  );
  assertEquals("ok" in r2, true);
  const v2 = (r2 as { ok: Commit }).ok.version;

  assertEquals(v1, 1);
  assertEquals(v2, 2);
  assertEquals(v2 > v1, true);
  space.close();
});

// ---------------------------------------------------------------------------
// 7. Commit validation — stale read leads to conflict
// ---------------------------------------------------------------------------

Deno.test("commit validation: stale read produces conflict", () => {
  const space = freshSpace();

  // Write version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Write version 2 (concurrent update)
  const r2 = applyCommit(
    space.store,
    makeSetCommit(
      ENTITY_A,
      { v: 2 },
      commit1.facts[0].hash as ReturnType<typeof EMPTY>,
    ),
  );
  assertEquals("ok" in r2, true);

  // Now try to write with a stale read (claiming we read at version 1)
  const staleCommit: ClientCommit = {
    reads: {
      confirmed: [
        {
          id: ENTITY_A,
          hash: commit1.facts[0].hash,
          version: commit1.version,
        },
      ],
      pending: [],
    },
    operations: [
      {
        op: "set",
        id: ENTITY_A,
        value: { v: 3 },
        parent: commit1.facts[0].hash,
      } as SetOperation,
    ],
  };

  const r3 = applyCommit(space.store, staleCommit);
  assertEquals("error" in r3, true);
  const err = (r3 as { error: V2ConflictError }).error;
  assertEquals(err instanceof V2ConflictError, true);
  assertEquals(err.conflicts.length, 1);
  assertEquals(err.conflicts[0].id, ENTITY_A);
  space.close();
});

// ---------------------------------------------------------------------------
// 8. Commit validation — fresh read succeeds
// ---------------------------------------------------------------------------

Deno.test("commit validation: fresh read succeeds", () => {
  const space = freshSpace();

  // Write version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Write with a fresh read (claiming we read at the current version)
  const freshCommit: ClientCommit = {
    reads: {
      confirmed: [
        {
          id: ENTITY_A,
          hash: commit1.facts[0].hash,
          version: commit1.version,
        },
      ],
      pending: [],
    },
    operations: [
      {
        op: "set",
        id: ENTITY_A,
        value: { v: 2 },
        parent: commit1.facts[0].hash,
      } as SetOperation,
    ],
  };

  const r2 = applyCommit(space.store, freshCommit);
  assertEquals("ok" in r2, true);
  assertEquals(space.readEntity("", ENTITY_A), { v: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 9. Point-in-time read
// ---------------------------------------------------------------------------

Deno.test("point-in-time read: read entity at a specific version", () => {
  const space = freshSpace();

  // Write version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Write version 2
  const r2 = applyCommit(
    space.store,
    makeSetCommit(
      ENTITY_A,
      { v: 2 },
      commit1.facts[0].hash as ReturnType<typeof EMPTY>,
    ),
  );
  assertEquals("ok" in r2, true);

  // Read at version 1 — should get { v: 1 }
  const atV1 = space.readAtVersion("", ENTITY_A, commit1.version);
  assertEquals(atV1, { v: 1 });

  // Read at current version — should get { v: 2 }
  const current = space.readEntity("", ENTITY_A);
  assertEquals(current, { v: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 10. Delete then re-create
// ---------------------------------------------------------------------------

Deno.test("delete then re-create: entity can be written again after deletion", () => {
  const space = freshSpace();

  // Set
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Delete
  const deleteCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "delete",
        id: ENTITY_A,
        parent: commit1.facts[0].hash,
      } as DeleteOperation,
    ],
  };
  const r2 = applyCommit(space.store, deleteCommit);
  assertEquals("ok" in r2, true);
  assertEquals(space.readEntity("", ENTITY_A), null);

  // Re-create with the delete fact as parent
  const commit2 = (r2 as { ok: Commit }).ok;
  const r3 = applyCommit(
    space.store,
    makeSetCommit(
      ENTITY_A,
      { v: 2 },
      commit2.facts[0].hash as ReturnType<typeof EMPTY>,
    ),
  );
  assertEquals("ok" in r3, true);
  assertEquals(space.readEntity("", ENTITY_A), { v: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 11. Blob write/read roundtrip
// ---------------------------------------------------------------------------

Deno.test("blob storage: write and read blob roundtrip", () => {
  const space = freshSpace();

  const data = new TextEncoder().encode("hello, world");
  writeBlob(space.store, {
    hash: "sha256-abc123",
    data,
    contentType: "text/plain",
    size: data.length,
  });

  const blob = readBlob(space.store, "sha256-abc123");
  assertEquals(blob !== null, true);
  assertEquals(new TextDecoder().decode(blob!.data), "hello, world");
  assertEquals(blob!.contentType, "text/plain");
  assertEquals(blob!.size, data.length);

  // Non-existent blob returns null
  const missing = readBlob(space.store, "sha256-nonexistent");
  assertEquals(missing, null);

  space.close();
});

// ---------------------------------------------------------------------------
// 12. Blob deduplication
// ---------------------------------------------------------------------------

Deno.test("blob storage: duplicate writes are ignored", () => {
  const space = freshSpace();

  const data = new TextEncoder().encode("dedup test");
  writeBlob(space.store, {
    hash: "sha256-dedup",
    data,
    contentType: "text/plain",
    size: data.length,
  });

  // Writing same hash again should not throw
  writeBlob(space.store, {
    hash: "sha256-dedup",
    data,
    contentType: "text/plain",
    size: data.length,
  });

  const blob = readBlob(space.store, "sha256-dedup");
  assertEquals(blob !== null, true);
  space.close();
});

// ---------------------------------------------------------------------------
// 13. Head pointer tracks latest fact
// ---------------------------------------------------------------------------

Deno.test("head pointer: readHead returns correct fact hash and version", () => {
  const space = freshSpace();

  // No head initially
  assertEquals(space.readHead("", ENTITY_A), null);

  // Write
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  const head = space.readHead("", ENTITY_A);
  assertEquals(head !== null, true);
  assertEquals(head!.factHash, commit1.facts[0].hash.toString());
  assertEquals(head!.version, commit1.version);
  assertEquals(head!.factType, "set");
  space.close();
});

// ---------------------------------------------------------------------------
// 14. Multiple patches reconstruction
// ---------------------------------------------------------------------------

Deno.test("patch replay: multiple sequential patches reconstruct correctly", () => {
  const space = freshSpace();

  // Set base value
  const r1 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { count: 0, items: [] }),
  );
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply 3 patches
  for (let i = 1; i <= 3; i++) {
    const patchCommit: ClientCommit = {
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "patch",
          id: ENTITY_A,
          patches: [
            { op: "replace", path: "/count", value: i },
            { op: "add", path: "/items/-", value: `item-${i}` },
          ],
          parent,
        } as PatchWriteOperation,
      ],
    };
    const r = applyCommit(space.store, patchCommit);
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  const value = space.readEntity("", ENTITY_A);
  assertEquals(value, { count: 3, items: ["item-1", "item-2", "item-3"] });
  space.close();
});

// ---------------------------------------------------------------------------
// 15. Claim operation validates without writing
// ---------------------------------------------------------------------------

Deno.test("claim operation: valid claim does not produce conflict", () => {
  const space = freshSpace();

  // Write a value
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Claim with matching parent
  const claimCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "claim",
        id: ENTITY_A,
        parent: commit1.facts[0].hash,
      } as ClaimOperation,
    ],
  };

  const r2 = applyCommit(space.store, claimCommit);
  assertEquals("ok" in r2, true);

  // Value should be unchanged
  assertEquals(space.readEntity("", ENTITY_A), { v: 1 });
  space.close();
});

Deno.test("claim operation: stale claim produces conflict", () => {
  const space = freshSpace();

  // Write v1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Write v2
  const r2 = applyCommit(
    space.store,
    makeSetCommit(
      ENTITY_A,
      { v: 2 },
      commit1.facts[0].hash as ReturnType<typeof EMPTY>,
    ),
  );
  assertEquals("ok" in r2, true);

  // Claim with stale parent (v1's fact hash)
  const claimCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "claim",
        id: ENTITY_A,
        parent: commit1.facts[0].hash,
      } as ClaimOperation,
    ],
  };

  const r3 = applyCommit(space.store, claimCommit);
  assertEquals("error" in r3, true);
  space.close();
});

// ---------------------------------------------------------------------------
// 16. Non-existent entity read
// ---------------------------------------------------------------------------

Deno.test("readEntity: non-existent entity returns null", () => {
  const space = freshSpace();
  assertEquals(
    space.readEntity("", "urn:entity:nonexistent" as EntityId),
    null,
  );
  space.close();
});

Deno.test("readAtVersion: non-existent entity at any version returns null", () => {
  const space = freshSpace();
  assertEquals(
    space.readAtVersion("", "urn:entity:nonexistent" as EntityId, 999),
    null,
  );
  space.close();
});
