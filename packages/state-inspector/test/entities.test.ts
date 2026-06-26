// Hermetic test for entity classification + fvj1 commit decoding (both surfaced
// by dogfooding a real fvj1 space). Side-effect free.

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";

import { openSpace } from "../db.ts";
import { listCommits } from "../queries.ts";
import { listEntities } from "../queries.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
`;

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, ?, '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );

  // Commit 1: original stored fvj1-encoded with 2 ops and 1 confirmed read.
  const original = jsonFromValue({
    localSeq: 1,
    operations: [{ op: "set" }, { op: "patch" }],
    reads: { confirmed: [{ id: "x" }], pending: [] },
  });
  commit.run(1, "session:did:key:zSpaceAAAA:11111111-2222-3333", 1, original);
  // entities (values stored as plain JSON here; decode handles both)
  rev.run("of:mod", 1, JSON.stringify({
    value: { code: "export default 1;", filename: "/api/patterns/foo/bar.tsx", identity: "h" },
  }), 1);

  commit.run(2, "session:did:key:zSpaceAAAA:11111111-2222-3333", 2, "{}");
  rev.run("of:inst", 2, JSON.stringify({ value: { $NAME: "My Notebook", notes: [] } }), 2);

  commit.run(3, "session:did:key:zSpaceAAAA:11111111-2222-3333", 3, "{}");
  rev.run("of:val", 3, JSON.stringify({ value: "none" }), 3);

  db.close();
}

Deno.test("entity classification + fvj1 commit decode", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-entities-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("listCommits decodes an fvj1 original (ops/reads non-zero)", () => {
        const rows = listCommits(space);
        const c1 = rows.find((r) => r.seq === 1)!;
        assertEquals(c1.ops, 2);
        assertEquals(c1.reads, 1);
      });

      await t.step("entities are classified by kind + named", () => {
        const ents = listEntities(space);
        const byId = Object.fromEntries(ents.map((e) => [e.id, e]));
        assertEquals(byId["of:mod"].kind, "module");
        assertEquals(byId["of:mod"].name, "module:bar.tsx");
        assertEquals(byId["of:inst"].kind, "instance");
        assertEquals(byId["of:inst"].name, "My Notebook");
        assertEquals(byId["of:val"].kind, "value");
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
