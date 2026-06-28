// Hermetic test for conflict detection: a cell contested by two identities,
// with a constructed stale read (lost-update) — Bob reads X@1, Alice writes X@3,
// Bob commits at @4 having never seen Alice's write. Also checks the multi-user
// vs multi-session distinction.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { contendedEntities, entityConflicts } from "../conflicts.ts";

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

const SA = "session:did:key:zAlice:s1";
const SB = "session:did:key:zBob:s2";
const X = "of:X";

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = (seq: number, session: string, reads: number[]) =>
    db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       VALUES (?, ?, ?, ?, '{"seq":0}')`,
    ).run(
      seq,
      session,
      seq,
      JSON.stringify({
        operations: [{ op: "set" }],
        reads: {
          confirmed: reads.map((s) => ({ id: X, path: [], seq: s })),
          pending: [],
        },
      }),
    );
  const rev = (seq: number, op: string, commitSeq: number) =>
    db.prepare(
      `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, 0, ?, ?, ?)`,
    ).run(X, seq, op, JSON.stringify({ value: seq }), commitSeq);

  // 1: Alice creates X.  2: Bob writes X (saw @1).  3: Alice writes X again.
  // 4: Bob writes X but still read @1 → missed Alice's @3 (stale, lost update).
  commit(1, SA, []);
  rev(1, "set", 1);
  commit(2, SB, [1]);
  rev(2, "patch", 2);
  commit(3, SA, [2]);
  rev(3, "patch", 3);
  commit(4, SB, [1]);
  rev(4, "patch", 4);
  db.close();
}

Deno.test("conflicts: contention + stale-read detection", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("contendedEntities flags multi-user contention", () => {
        const rows = contendedEntities(space);
        assertEquals(rows.length, 1);
        const c = rows[0];
        assertEquals(c.id, X);
        assertEquals(c.sessions, 2);
        assertEquals(c.principals, 2); // Alice + Bob — real cross-user
        assert(c.multiUser);
        assert(c.interleaved); // A,B,A,B
      });

      await t.step(
        "entityConflicts detects the stale read (lost update)",
        () => {
          const c = entityConflicts(space, X);
          assertEquals(c.writerPrincipals, 2);
          assert(c.multiUser);
          assertEquals(c.staleReads.length, 1);
          const sr = c.staleReads[0];
          assertEquals(sr.readerCommitSeq, 4); // Bob's stale commit
          assertEquals(sr.readAtSeq, 1); // read X@1
          assertEquals(sr.missedWriteSeq, 3); // missed Alice's write @3
          assert(sr.readerAlsoWrote); // Bob also wrote → lost-update risk
        },
      );
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
