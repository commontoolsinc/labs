// Core engine tables are scoped per-space (`commit__<token>` etc.) when `open()`
// is given a `space`, so an attached pattern cell-db can't shadow a core table
// on the write path, and two spaces' core tables never collide when attached to
// one connection (the precondition for cross-space transactions). Opening
// without a `space` keeps the legacy bare names (back-compat). A legacy bare-named
// db is migrated in place on first scoped open.

import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import type { EntityDocument } from "../v2.ts";

const SPACE_A = "did:key:z6Mk-core-scope-a";
const SPACE_B = "did:key:z6Mk-core-scope-b";

const doc = (value: unknown): EntityDocument =>
  ({ value }) as unknown as EntityDocument;

const writeEntity = (engine: Engine, id: string, value: unknown): void => {
  applyCommit(engine, {
    sessionId: "session:test",
    principal: "did:key:alice",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: doc(value) }],
    },
  });
};

const tableNames = (engine: Engine): string[] =>
  (engine.database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>)
    .map((r) => r.name);

Deno.test("open(space) scopes core tables; bare names are absent", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), space: SPACE_A });
  try {
    const names = tableNames(engine);
    // Core tables carry the per-space suffix; the bare names are gone.
    assertExists(names.find((n) => /^commit__/.test(n)));
    assertExists(names.find((n) => /^revision__/.test(n)));
    assertEquals(names.includes("commit"), false);
    assertEquals(names.includes("revision"), false);

    // The scoped schema is fully functional end to end.
    writeEntity(engine, "entity:a", { hello: "world" });
    assertEquals(read(engine, { id: "entity:a" }), {
      value: { hello: "world" },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("open() without a space keeps legacy bare names", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    const names = tableNames(engine);
    assertEquals(names.includes("commit"), true);
    assertEquals(names.includes("revision"), true);
    assertEquals(names.some((n) => /__/.test(n)), false);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("legacy bare db is migrated to scoped names in place, data intact", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });

  // 1. Create a legacy (bare-named) db and write data through it.
  const legacy = await open({ url: toFileUrl(path) });
  writeEntity(legacy, "entity:keep", { n: 42 });
  assertEquals(tableNames(legacy).includes("commit"), true);
  close(legacy);

  // 2. Reopen the SAME file WITH a space: the on-open migration renames the
  //    core tables to scoped names and the previously-written data survives.
  const scoped = await open({ url: toFileUrl(path), space: SPACE_A });
  try {
    const names = tableNames(scoped);
    assertExists(names.find((n) => /^commit__/.test(n)));
    assertEquals(names.includes("commit"), false);
    assertEquals(read(scoped, { id: "entity:keep" }), { value: { n: 42 } });
  } finally {
    close(scoped);
  }

  // 3. Reopening again is idempotent (no double-rename) and still reads.
  const reopened = await open({ url: toFileUrl(path), space: SPACE_A });
  try {
    assertEquals(read(reopened, { id: "entity:keep" }), { value: { n: 42 } });
  } finally {
    close(reopened);
    await Deno.remove(path);
  }
});

Deno.test("DIDs that collided under the old 32-bit token now get disjoint names", async () => {
  // These two same-length DIDs produced an identical FNV-1a-32 token (reported
  // in review); the SHA-256 token must keep their core tables disjoint so their
  // data can never alias when sharing a connection.
  const didX = "did:key:ziU9nCvUN8Zwo2uhnJUkWeqMA5CFhUwVpxUzdpYQFrppg";
  const didY = "did:key:zDpzMFyyrHYN9M1RoWKS6zKqz1y3Sf2kRrovdqpJfrVyv";
  const pathX = await Deno.makeTempFile({ suffix: ".sqlite" });
  const pathY = await Deno.makeTempFile({ suffix: ".sqlite" });
  const x = await open({ url: toFileUrl(pathX), space: didX });
  const y = await open({ url: toFileUrl(pathY), space: didY });
  try {
    const xCommit = tableNames(x).find((n) => /^commit__/.test(n))!;
    const yCommit = tableNames(y).find((n) => /^commit__/.test(n))!;
    assertEquals(xCommit === yCommit, false);
  } finally {
    close(x);
    close(y);
    await Deno.remove(pathX);
    await Deno.remove(pathY);
  }
});

Deno.test("two spaces' core tables are disjoint (cross-space attach ready)", async () => {
  const pathA = await Deno.makeTempFile({ suffix: ".sqlite" });
  const pathB = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engineA = await open({ url: toFileUrl(pathA), space: SPACE_A });
  const engineB = await open({ url: toFileUrl(pathB), space: SPACE_B });
  try {
    const a = new Set(tableNames(engineA));
    const b = new Set(tableNames(engineB));
    // Different spaces => different token => no shared core-table name.
    const shared = [...a].filter((n) => b.has(n) && /__/.test(n));
    assertEquals(shared, []);

    // Concretely: attach B's file into A's connection. Because the names are
    // disjoint, both spaces' core tables coexist under one connection with no
    // collision and no ambiguity for an unqualified reference.
    engineA.database.exec(`ATTACH DATABASE ? AS other`, pathB);
    try {
      const aCommit = [...a].find((n) => /^commit__/.test(n))!;
      const bCommit = [...b].find((n) => /^commit__/.test(n))!;
      assertEquals(aCommit === bCommit, false);
      // Both resolve, unqualified, on the same connection.
      engineA.database.prepare(`SELECT count(*) AS c FROM "${aCommit}"`).get();
      engineA.database.prepare(`SELECT count(*) AS c FROM "${bCommit}"`).get();
    } finally {
      engineA.database.exec(`DETACH DATABASE other`);
    }
  } finally {
    close(engineA);
    close(engineB);
    await Deno.remove(pathA);
    await Deno.remove(pathB);
  }
});
