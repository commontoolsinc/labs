// Hermetic test: build a tiny space DB in a temp dir matching the memory v2
// schema, then exercise the read-only inspector against it. Side-effect free —
// the temp dir is removed in finally.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { annotate, parseSigilLink } from "../decode.ts";
import { getValueAt, reconstructDocument } from "../reconstruct.ts";
import { entityHistory, hotEntities, listCommits, summarizeSpace } from "../queries.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY,
  branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  local_seq INTEGER NOT NULL,
  invocation_ref TEXT,
  authorization_ref TEXT,
  original JSON NOT NULL,
  resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space',
  seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL,
  op TEXT NOT NULL,
  data JSON,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY,
  parent_branch TEXT,
  fork_seq INTEGER,
  created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq) VALUES ('', 4);
`;

const LINK = {
  "/": { "link@1": { id: "of:other", space: "did:key:zABC", path: [] } },
};

function seedDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);

  const commit = db.prepare(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
     VALUES (?, '', ?, ?, ?, ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('', ?, 'space', ?, 0, ?, ?, ?)`,
  );

  const mkOriginal = (ops: number) =>
    JSON.stringify({ localSeq: ops, reads: { confirmed: [], pending: [] }, operations: new Array(ops).fill({}) });

  // seq1: set A
  commit.run(1, "session-alice", 1, mkOriginal(1), JSON.stringify({ seq: 1 }));
  rev.run("of:A", 1, "set", JSON.stringify({ value: { count: 1, link: LINK } }), 1);
  // seq2: set B
  commit.run(2, "session-bob", 1, mkOriginal(1), JSON.stringify({ seq: 2 }));
  rev.run("of:B", 2, "set", JSON.stringify({ value: { x: true } }), 2);
  // seq3: patch A.count -> 2
  commit.run(3, "session-alice", 2, mkOriginal(1), JSON.stringify({ seq: 3 }));
  rev.run("of:A", 3, "patch", JSON.stringify([{ op: "replace", path: "/value/count", value: 2 }]), 3);
  // seq4: delete B
  commit.run(4, "session-bob", 2, mkOriginal(1), JSON.stringify({ seq: 4 }));
  rev.run("of:B", 4, "delete", null, 4);

  db.close();
}

Deno.test("state-inspector autopsy core", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-test-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seedDb(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("reconstruct at seq replays set then patch", () => {
        assertEquals(getValueAt(space, { id: "of:A", atSeq: 1 }, ["count"]).value, 1);
        assertEquals(getValueAt(space, { id: "of:A", atSeq: 2 }, ["count"]).value, 1);
        assertEquals(getValueAt(space, { id: "of:A", atSeq: 3 }, ["count"]).value, 2);
        // latest (no seq) sees the patch
        assertEquals(getValueAt(space, { id: "of:A" }, ["count"]).value, 2);
      });

      await t.step("delete tombstones the entity", () => {
        assert(getValueAt(space, { id: "of:B", atSeq: 2 }).exists);
        assertEquals(getValueAt(space, { id: "of:B", atSeq: 4 }).exists, false);
      });

      await t.step("links are recognized and annotated", () => {
        const res = getValueAt(space, { id: "of:A" }, ["link"]);
        const link = parseSigilLink(res.value);
        assert(link, "expected a sigil link");
        assertEquals(link.id, "of:other");
        assertEquals(link.space, "did:key:zABC");
        const ann = annotate(res.value) as { $link: { id: string } };
        assertEquals(ann.$link.id, "of:other");
      });

      await t.step("absent entity reconstructs to undefined", () => {
        assertEquals(reconstructDocument(space, { id: "of:missing" }), undefined);
      });

      await t.step("summary counts match the seed", () => {
        const s = summarizeSpace(space);
        assertEquals(s.commits, 4);
        assertEquals(s.sessions, 2);
        assertEquals(s.entities, 2);
        assertEquals(s.revisions, 4);
        assertEquals(s.ops, { set: 2, patch: 1, delete: 1 });
        assertEquals(s.hasSchedulerTables, false);
      });

      await t.step("commits and history list the right rows", () => {
        assertEquals(listCommits(space).length, 4);
        assertEquals(listCommits(space, { session: "session-alice" }).length, 2);
        const histA = entityHistory(space, { id: "of:A" });
        assertEquals(histA.map((h) => h.op), ["set", "patch"]);
        const hot = hotEntities(space);
        assertEquals(hot.find((h) => h.id === "of:A")?.writes, 2);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
