// Hermetic test for the scope_key compatibility shim. Older space DBs predate
// the per-scope `scope_key` column on `revision`; openSpace shadows the table
// with a TEMP VIEW supplying a constant 'space' scope so scope-aware queries
// (which all filter `scope_key = 'space'`) work unchanged on those DBs.

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { reconstructDocument } from "../reconstruct.ts";
import { listEntityModels } from "../model.ts";

// NOTE: no `scope_key` column on `revision` — the legacy schema.
const LEGACY_SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, seq, op_index)
);
`;

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (1, 'session:did:key:zX:u', 1, '{}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 1, 0, 'set', ?, 1)`,
  ).run(JSON.stringify({ value: { count: 7 } }));
  db.close();
}

Deno.test("scope_key shim: a DB without scope_key still inspects", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-db-" });
  const dbPath = `${dir}/legacy.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      // The shimmed column resolves to 'space', so the default scope finds it.
      const has = space.db
        .prepare(
          "SELECT scope_key, count(*) n FROM revision GROUP BY scope_key",
        )
        .all<{ scope_key: string; n: number }>();
      assertEquals(has, [{ scope_key: "space", n: 1 }]);

      const doc = reconstructDocument(space, { id: "of:a" });
      assertEquals((doc?.value as { count: number }).count, 7);

      const models = listEntityModels(space);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, "of:a");
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
