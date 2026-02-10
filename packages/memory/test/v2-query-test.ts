import { assertEquals } from "@std/assert";
import { openV2Space } from "../v2-space.ts";
import { applyCommit } from "../v2-commit.ts";
import { executeSimpleQuery } from "../v2-query.ts";
import { EMPTY } from "../v2-reference.ts";
import type {
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

const ENTITY_A: EntityId = "urn:entity:q-aaa";
const ENTITY_B: EntityId = "urn:entity:q-bbb";
const ENTITY_C: EntityId = "urn:entity:q-ccc";

function freshSpace() {
  return openV2Space(new URL("memory:test-query"));
}

function makeSetCommit(
  id: EntityId,
  value: unknown,
  parent?: ReturnType<typeof EMPTY>,
): ClientCommit {
  return {
    reads: { confirmed: [], pending: [] },
    operations: [
      { op: "set", id, value, parent: parent ?? EMPTY(id) } as SetOperation,
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Query specific entity by id
// ---------------------------------------------------------------------------

Deno.test("query: select specific entity by id", () => {
  const space = freshSpace();

  applyCommit(space.store, makeSetCommit(ENTITY_A, { name: "Alice" }));
  applyCommit(space.store, makeSetCommit(ENTITY_B, { name: "Bob" }));

  const result = executeSimpleQuery(space, {
    select: { [ENTITY_A]: {} },
  });

  assertEquals(Object.keys(result).length, 1);
  assertEquals(result[ENTITY_A]?.value, { name: "Alice" });
  assertEquals(result[ENTITY_A]?.version, 1);
  space.close();
});

// ---------------------------------------------------------------------------
// 2. Wildcard query returns all entities
// ---------------------------------------------------------------------------

Deno.test("query: wildcard returns all entities", () => {
  const space = freshSpace();

  applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  applyCommit(space.store, makeSetCommit(ENTITY_B, { b: 2 }));
  applyCommit(space.store, makeSetCommit(ENTITY_C, { c: 3 }));

  const result = executeSimpleQuery(space, {
    select: { "*": {} },
  });

  assertEquals(Object.keys(result).length, 3);
  assertEquals(result[ENTITY_A]?.value, { a: 1 });
  assertEquals(result[ENTITY_B]?.value, { b: 2 });
  assertEquals(result[ENTITY_C]?.value, { c: 3 });
  space.close();
});

// ---------------------------------------------------------------------------
// 3. Since filtering (wildcard)
// ---------------------------------------------------------------------------

Deno.test("query: since filtering returns only entities newer than N", () => {
  const space = freshSpace();

  // Write A at version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  assertEquals("ok" in r1, true);
  const v1 = (r1 as { ok: Commit }).ok.version;

  // Write B at version 2
  applyCommit(space.store, makeSetCommit(ENTITY_B, { b: 2 }));

  // Write C at version 3
  applyCommit(space.store, makeSetCommit(ENTITY_C, { c: 3 }));

  // Query with since=v1 should only return B and C
  const result = executeSimpleQuery(space, {
    select: { "*": {} },
    since: v1,
  });

  assertEquals(Object.keys(result).length, 2);
  assertEquals(result[ENTITY_A], undefined);
  assertEquals(result[ENTITY_B]?.value, { b: 2 });
  assertEquals(result[ENTITY_C]?.value, { c: 3 });
  space.close();
});

// ---------------------------------------------------------------------------
// 4. Since filtering for specific entity
// ---------------------------------------------------------------------------

Deno.test("query: since filtering for specific entity skips stale", () => {
  const space = freshSpace();

  // Write A at version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  assertEquals("ok" in r1, true);
  const v1 = (r1 as { ok: Commit }).ok.version;

  // Write B at version 2
  applyCommit(space.store, makeSetCommit(ENTITY_B, { b: 2 }));

  // Query specific entity with since=v1 should skip A (version 1 <= since 1)
  const result = executeSimpleQuery(space, {
    select: { [ENTITY_A]: {} },
    since: v1,
  });
  assertEquals(Object.keys(result).length, 0);

  // But B should be returned (version 2 > since 1)
  const result2 = executeSimpleQuery(space, {
    select: { [ENTITY_B]: {} },
    since: v1,
  });
  assertEquals(Object.keys(result2).length, 1);
  assertEquals(result2[ENTITY_B]?.value, { b: 2 });
  space.close();
});

// ---------------------------------------------------------------------------
// 5. Point-in-time (atVersion) query
// ---------------------------------------------------------------------------

Deno.test("query: atVersion returns entity state at specific version", () => {
  const space = freshSpace();

  // Write A at version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Overwrite A at version 2
  applyCommit(
    space.store,
    makeSetCommit(
      ENTITY_A,
      { v: 2 },
      commit1.facts[0].hash as ReturnType<typeof EMPTY>,
    ),
  );

  // Query at version 1 should return { v: 1 }
  const result = executeSimpleQuery(space, {
    select: { [ENTITY_A]: {} },
    atVersion: commit1.version,
  });

  assertEquals(Object.keys(result).length, 1);
  assertEquals(result[ENTITY_A]?.value, { v: 1 });
  space.close();
});

// ---------------------------------------------------------------------------
// 6. Non-existent entity returns empty result
// ---------------------------------------------------------------------------

Deno.test("query: non-existent entity returns empty result", () => {
  const space = freshSpace();

  const result = executeSimpleQuery(space, {
    select: { ["urn:entity:nonexistent" as EntityId]: {} },
  });

  assertEquals(Object.keys(result).length, 0);
  space.close();
});

// ---------------------------------------------------------------------------
// 7. Deleted entity excluded from results
// ---------------------------------------------------------------------------

Deno.test("query: deleted entity excluded from results", () => {
  const space = freshSpace();

  // Write A
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;

  // Delete A
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
  applyCommit(space.store, deleteCommit);

  // Query specific entity -- deleted should not appear
  const result = executeSimpleQuery(space, {
    select: { [ENTITY_A]: {} },
  });
  assertEquals(Object.keys(result).length, 0);

  // Wildcard query -- deleted should not appear
  const result2 = executeSimpleQuery(space, {
    select: { "*": {} },
  });
  assertEquals(Object.keys(result2).length, 0);
  space.close();
});

// ---------------------------------------------------------------------------
// 8. Patch entity in wildcard query
// ---------------------------------------------------------------------------

Deno.test("query: wildcard returns reconstructed patch values", () => {
  const space = freshSpace();

  // Set base value
  const r1 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { name: "Alice", score: 0 }),
  );
  assertEquals("ok" in r1, true);
  const parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply patch
  const patchCommit: ClientCommit = {
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "patch",
        id: ENTITY_A,
        patches: [{ op: "replace", path: "/score", value: 42 }],
        parent,
      } as PatchWriteOperation,
    ],
  };
  applyCommit(space.store, patchCommit);

  const result = executeSimpleQuery(space, {
    select: { "*": {} },
  });

  assertEquals(Object.keys(result).length, 1);
  assertEquals(result[ENTITY_A]?.value, { name: "Alice", score: 42 });
  space.close();
});

// ---------------------------------------------------------------------------
// 9. Empty wildcard query on empty space
// ---------------------------------------------------------------------------

Deno.test("query: wildcard on empty space returns empty result", () => {
  const space = freshSpace();

  const result = executeSimpleQuery(space, {
    select: { "*": {} },
  });

  assertEquals(Object.keys(result).length, 0);
  space.close();
});

// ---------------------------------------------------------------------------
// 10. Mixed wildcard and specific selectors
// ---------------------------------------------------------------------------

Deno.test("query: mixed wildcard and specific selectors", () => {
  const space = freshSpace();

  applyCommit(space.store, makeSetCommit(ENTITY_A, { a: 1 }));
  applyCommit(space.store, makeSetCommit(ENTITY_B, { b: 2 }));

  // Select both wildcard and specific -- both should work
  const result = executeSimpleQuery(space, {
    select: { "*": {}, [ENTITY_A]: {} },
  });

  // Wildcard captures all, specific also adds ENTITY_A (already present)
  assertEquals(Object.keys(result).length, 2);
  assertEquals(result[ENTITY_A]?.value, { a: 1 });
  assertEquals(result[ENTITY_B]?.value, { b: 2 });
  space.close();
});
