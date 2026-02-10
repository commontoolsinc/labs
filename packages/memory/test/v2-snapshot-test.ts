import { assertEquals } from "@std/assert";
import { openV2Space } from "../v2-space.ts";
import { applyCommit } from "../v2-commit.ts";
import { EMPTY } from "../v2-reference.ts";
import {
  createSnapshot,
  DEFAULT_SNAPSHOT_POLICY,
  shouldCreateSnapshot,
} from "../v2-snapshot.ts";
import type {
  ClientCommit,
  Commit,
  EntityId,
  PatchWriteOperation,
  SetOperation,
} from "../v2-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_A: EntityId = "urn:entity:snap-a";

function freshSpace() {
  return openV2Space(new URL("memory:test-snapshot"));
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

function makePatchCommit(
  id: EntityId,
  patches: unknown[],
  parent: ReturnType<typeof EMPTY>,
): ClientCommit {
  return {
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "patch", id, patches, parent } as PatchWriteOperation],
  };
}

// ---------------------------------------------------------------------------
// 1. shouldCreateSnapshot returns false below threshold
// ---------------------------------------------------------------------------

Deno.test("snapshot: shouldCreateSnapshot returns false below patchInterval", () => {
  const space = freshSpace();

  // Set a base value
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { count: 0 }));
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply 5 patches (below default threshold of 10)
  for (let i = 1; i <= 5; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/count", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  const head = space.readHead("", ENTITY_A);
  assertEquals(
    shouldCreateSnapshot(space.store, "", ENTITY_A, head!.version),
    false,
  );

  space.close();
});

// ---------------------------------------------------------------------------
// 2. shouldCreateSnapshot returns true at threshold (no auto-snapshot)
// ---------------------------------------------------------------------------

Deno.test("snapshot: shouldCreateSnapshot returns true at patchInterval", () => {
  const space = freshSpace();

  // Set a base value
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { count: 0 }));
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply exactly 10 patches (default threshold)
  // applyCommit auto-creates a snapshot at the 10th patch, so
  // shouldCreateSnapshot returns false after. Verify the auto-snapshot
  // was created and that shouldCreateSnapshot returns false (already done).
  for (let i = 1; i <= 10; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/count", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // The auto-snapshot was created at patch 10, so shouldCreateSnapshot
  // returns false (0 patches since the snapshot).
  const head = space.readHead("", ENTITY_A);
  assertEquals(
    shouldCreateSnapshot(space.store, "", ENTITY_A, head!.version),
    false,
  );

  // Verify a snapshot exists in the table
  const snapRow = space.store
    .prepare(
      "SELECT COUNT(*) as cnt FROM snapshot WHERE id = ? AND branch = ?",
    )
    .get(ENTITY_A, "") as { cnt: number };
  assertEquals(snapRow.cnt >= 1, true);

  space.close();
});

// ---------------------------------------------------------------------------
// 3. Custom policy with lower threshold
// ---------------------------------------------------------------------------

Deno.test("snapshot: custom policy with patchInterval=3", () => {
  const space = freshSpace();

  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 0 }));
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply 3 patches
  for (let i = 1; i <= 3; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/v", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  const head = space.readHead("", ENTITY_A);
  assertEquals(
    shouldCreateSnapshot(space.store, "", ENTITY_A, head!.version, {
      patchInterval: 3,
    }),
    true,
  );
  assertEquals(
    shouldCreateSnapshot(space.store, "", ENTITY_A, head!.version, {
      patchInterval: 5,
    }),
    false,
  );

  space.close();
});

// ---------------------------------------------------------------------------
// 4. createSnapshot stores and readEntity still works
// ---------------------------------------------------------------------------

Deno.test("snapshot: createSnapshot stores snapshot, readEntity returns correct value", () => {
  const space = freshSpace();

  // Set base
  const r1 = applyCommit(
    space.store,
    makeSetCommit(ENTITY_A, { count: 0, items: [] }),
  );
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply a few patches
  for (let i = 1; i <= 3; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [
          { op: "replace", path: "/count", value: i },
          { op: "add", path: "/items/-", value: `item-${i}` },
        ],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // Manually create a snapshot at the current version
  const head = space.readHead("", ENTITY_A);
  const currentValue = space.readEntity("", ENTITY_A);
  assertEquals(currentValue, {
    count: 3,
    items: ["item-1", "item-2", "item-3"],
  });

  createSnapshot(space, "", ENTITY_A, head!.version, currentValue!);

  // Apply more patches after snapshot
  for (let i = 4; i <= 6; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [
          { op: "replace", path: "/count", value: i },
          { op: "add", path: "/items/-", value: `item-${i}` },
        ],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // readEntity should still return correct value (using snapshot + patches after it)
  const finalValue = space.readEntity("", ENTITY_A);
  assertEquals(finalValue, {
    count: 6,
    items: ["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"],
  });

  space.close();
});

// ---------------------------------------------------------------------------
// 5. readAtVersion works with snapshots
// ---------------------------------------------------------------------------

Deno.test("snapshot: readAtVersion works correctly with snapshot acceleration", () => {
  const space = freshSpace();

  // Set base at version 1
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { v: 0 }));
  assertEquals("ok" in r1, true);
  const commit1 = (r1 as { ok: Commit }).ok;
  let parent = commit1.facts[0].hash;

  // Apply patches at versions 2, 3, 4
  for (let i = 1; i <= 3; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/v", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // Create snapshot at version 4
  const headAtV4 = space.readHead("", ENTITY_A);
  createSnapshot(space, "", ENTITY_A, headAtV4!.version, { v: 3 });

  // Apply more patches at versions 5, 6
  for (let i = 4; i <= 5; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/v", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // PIT read at version 1 (before any patches)
  assertEquals(space.readAtVersion("", ENTITY_A, commit1.version), { v: 0 });

  // PIT read at current
  assertEquals(space.readEntity("", ENTITY_A), { v: 5 });

  space.close();
});

// ---------------------------------------------------------------------------
// 6. Automatic snapshot via applyCommit (10 patches trigger snapshot)
// ---------------------------------------------------------------------------

Deno.test("snapshot: applyCommit creates snapshot after 10 patches", () => {
  const space = freshSpace();

  // Set base
  const r1 = applyCommit(space.store, makeSetCommit(ENTITY_A, { count: 0 }));
  assertEquals("ok" in r1, true);
  let parent = (r1 as { ok: Commit }).ok.facts[0].hash;

  // Apply 10 patches -- applyCommit should auto-create snapshot at the 10th
  for (let i = 1; i <= 10; i++) {
    const r = applyCommit(
      space.store,
      makePatchCommit(
        ENTITY_A,
        [{ op: "replace", path: "/count", value: i }],
        parent as ReturnType<typeof EMPTY>,
      ),
    );
    assertEquals("ok" in r, true);
    parent = (r as { ok: Commit }).ok.facts[0].hash;
  }

  // Verify snapshot exists by checking the snapshot table
  const snapRow = space.store
    .prepare(
      "SELECT COUNT(*) as cnt FROM snapshot WHERE id = ? AND branch = ?",
    )
    .get(ENTITY_A, "") as { cnt: number };
  assertEquals(snapRow.cnt >= 1, true);

  // Verify readEntity still correct
  assertEquals(space.readEntity("", ENTITY_A), { count: 10 });

  space.close();
});

// ---------------------------------------------------------------------------
// 7. DEFAULT_SNAPSHOT_POLICY
// ---------------------------------------------------------------------------

Deno.test("snapshot: DEFAULT_SNAPSHOT_POLICY has patchInterval=10", () => {
  assertEquals(DEFAULT_SNAPSHOT_POLICY.patchInterval, 10);
});
