// Hermetic test for time travel: structural value diff, entity diff across
// seqs, entity timeline (write-by-write), and space-growth timeline. Seeds an
// entity edited by a patch and another that is created then deleted.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import {
  diffEntity,
  diffValues,
  entityTimeline,
  spaceTimeline,
} from "../timetravel.ts";

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
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );

  // commit 1: create A
  commit.run(1, "session:did:key:zX:u", 1);
  rev.run(
    "of:A",
    1,
    "set",
    JSON.stringify({ value: { count: 0, title: "a" } }),
    1,
  );
  // commit 2: create B
  commit.run(2, "session:did:key:zX:u", 2);
  rev.run("of:B", 2, "set", JSON.stringify({ value: { x: 1 } }), 2);
  // commit 3: patch A.count -> 2
  commit.run(3, "session:did:key:zX:u", 3);
  rev.run(
    "of:A",
    3,
    "patch",
    JSON.stringify([{ op: "replace", path: "/value/count", value: 2 }]),
    3,
  );
  // commit 4: delete B
  commit.run(4, "session:did:key:zX:u", 4);
  rev.run("of:B", 4, "delete", null, 4);

  db.close();
}

Deno.test("time travel: diff + timelines", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-tt-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("diffValues classifies add/remove/change", () => {
        const changes = diffValues(
          { a: 1, b: 2, list: [1, 2] },
          { a: 1, b: 3, c: 9, list: [1, 5] },
        );
        const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
        assertEquals(byPath["b"].kind, "changed");
        assertEquals(byPath["c"].kind, "added");
        assertEquals(byPath["list/1"].kind, "changed");
        assert(!("a" in byPath));
      });

      await t.step("diffEntity across seqs shows the changed leaf", () => {
        // Default diffs the value; change paths are value-relative ("count").
        const d = diffEntity(space, { id: "of:A", fromSeq: 1, toSeq: 3 });
        assert(d.fromExists && d.toExists);
        const c = d.changes.find((x) => x.path === "count");
        assert(c, "expected value.count to change");
        assertEquals(c!.kind, "changed");
        assertEquals(c!.after, 2);
        // With --doc, paths are document-relative ("value/count").
        const dd = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          doc: true,
        });
        assert(dd.changes.some((x) => x.path === "value/count"));
      });

      await t.step("diffEntity birth→latest reports creation", () => {
        const d = diffEntity(space, { id: "of:A" });
        assertEquals(d.fromExists, false);
        assertEquals(d.toExists, true);
        assert(d.changes.length > 0);
      });

      await t.step("diffEntity captures a deletion", () => {
        const d = diffEntity(space, { id: "of:B", fromSeq: 2, toSeq: 4 });
        assertEquals(d.fromExists, true);
        assertEquals(d.toExists, false);
      });

      await t.step("entityTimeline lists each write with change counts", () => {
        const steps = entityTimeline(space, { id: "of:A" });
        assertEquals(steps.length, 2);
        assertEquals(steps[0].op, "set");
        assertEquals(steps[1].op, "patch");
        // the patch changed exactly one path (count)
        assertEquals(steps[1].changes, 1);
      });

      await t.step("spaceTimeline tracks created + cumulative growth", () => {
        const t1 = spaceTimeline(space);
        assertEquals(t1.length, 4);
        assertEquals(t1[0].created, 1); // A
        assertEquals(t1[1].created, 1); // B
        assertEquals(t1[2].created, 0); // patch A
        assertEquals(t1[3].created, 0); // delete B
        assertEquals(t1[3].cumulativeEntities, 2);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
