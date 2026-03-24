import { assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { StitchDb } from "../stitch-db.ts";
import type { CommitOp } from "../stitch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const op = (id: string, value: unknown): CommitOp => ({
  op: "set",
  id: id as CommitOp["id"],
  path: [],
  value: value as CommitOp["value"],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StitchDb", () => {
  let db: StitchDb;

  beforeEach(() => {
    db = StitchDb.open(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // currentServerSeq
  // -------------------------------------------------------------------------

  describe("currentServerSeq", () => {
    it("returns 0 on a fresh database", () => {
      assertEquals(db.currentServerSeq(), 0);
    });

    it("advances by 1 for each accepted commit", () => {
      db.acceptCommit("user1", [op("doc:a", 1)], "sig");
      assertEquals(db.currentServerSeq(), 1);

      db.acceptCommit("user1", [op("doc:b", 2)], "sig");
      assertEquals(db.currentServerSeq(), 2);
    });
  });

  // -------------------------------------------------------------------------
  // acceptCommit
  // -------------------------------------------------------------------------

  describe("acceptCommit", () => {
    it("returns the new server_seq", () => {
      const seq1 = db.acceptCommit("user1", [op("doc:a", "hello")], "sig1");
      assertEquals(seq1, 1);

      const seq2 = db.acceptCommit("user1", [op("doc:b", "world")], "sig2");
      assertEquals(seq2, 2);
    });

    it("assigned server_seqs are strictly increasing", () => {
      const seqs = [
        db.acceptCommit("u", [op("doc:x", 1)], "s"),
        db.acceptCommit("u", [op("doc:y", 2)], "s"),
        db.acceptCommit("u", [op("doc:z", 3)], "s"),
      ];
      for (let i = 1; i < seqs.length; i++) {
        assertNotEquals(seqs[i], seqs[i - 1]);
        assertEquals(seqs[i] > seqs[i - 1], true);
      }
    });

    it("applies set ops to stitch_docs atomically", () => {
      db.acceptCommit("user1", [op("doc:a", { x: 1 }), op("doc:b", { y: 2 })], "sig");

      const a = db.getDoc("doc:a");
      const b = db.getDoc("doc:b");
      assertEquals(a?.value, { x: 1 });
      assertEquals(b?.value, { y: 2 });
    });

    it("stores the user_id and signature in stitch_commits", () => {
      const serverSeq = db.acceptCommit("alice", [op("doc:a", 42)], "abc123");
      const [commit] = db.getCommitsBetween(0, serverSeq);
      assertEquals(commit.user_id, "alice");
      assertEquals(commit.signature, "abc123");
    });

    it("a commit with no ops records the commit but writes no docs", () => {
      const seq = db.acceptCommit("user1", [], "sig");
      assertEquals(seq, 1);
      assertEquals(db.getCommitsBetween(0, 1).length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // getDoc / setDoc
  // -------------------------------------------------------------------------

  describe("getDoc", () => {
    it("returns null for an unknown docId", () => {
      assertStrictEquals(db.getDoc("doc:missing"), null);
    });

    it("returns the current value and server_seq after a write", () => {
      const seq = db.acceptCommit("u", [op("doc:a", { count: 0 })], "s");
      const row = db.getDoc("doc:a");
      assertEquals(row?.value, { count: 0 });
      assertEquals(row?.server_seq, seq);
    });
  });

  describe("setDoc", () => {
    it("upserts the document value", () => {
      db.setDoc("doc:a", "first", 1);
      assertEquals(db.getDoc("doc:a")?.value, "first");

      db.setDoc("doc:a", "second", 2);
      assertEquals(db.getDoc("doc:a")?.value, "second");
    });

    it("updates server_seq when the document is overwritten", () => {
      db.setDoc("doc:a", "v1", 1);
      db.setDoc("doc:a", "v2", 5);
      assertEquals(db.getDoc("doc:a")?.server_seq, 5);
    });
  });

  // -------------------------------------------------------------------------
  // getCommitsBetween
  // -------------------------------------------------------------------------

  describe("getCommitsBetween", () => {
    it("returns an empty array when no commits exist", () => {
      assertEquals(db.getCommitsBetween(0, 10), []);
    });

    it("is exclusive of fromSeq and inclusive of toSeq", () => {
      db.acceptCommit("u", [op("doc:a", 1)], "s"); // seq 1
      db.acceptCommit("u", [op("doc:b", 2)], "s"); // seq 2
      db.acceptCommit("u", [op("doc:c", 3)], "s"); // seq 3

      const rows = db.getCommitsBetween(1, 3);
      assertEquals(rows.length, 2);
      assertEquals(rows[0].server_seq, 2);
      assertEquals(rows[1].server_seq, 3);
    });

    it("returns commits in ascending server_seq order", () => {
      for (let i = 0; i < 5; i++) {
        db.acceptCommit("u", [op(`doc:${i}`, i)], "s");
      }
      const rows = db.getCommitsBetween(0, 5);
      for (let i = 1; i < rows.length; i++) {
        assertEquals(rows[i].server_seq > rows[i - 1].server_seq, true);
      }
    });

    it("round-trips ops through JSON", () => {
      const ops = [op("doc:a", { nested: [1, 2, 3] })];
      const seq = db.acceptCommit("u", ops, "s");
      const [commit] = db.getCommitsBetween(0, seq);
      assertEquals(commit.ops, ops);
    });

    it("returns no rows when fromSeq equals toSeq", () => {
      db.acceptCommit("u", [op("doc:a", 1)], "s");
      assertEquals(db.getCommitsBetween(1, 1), []);
    });

    it("multiple commits touching the same doc track the latest write", () => {
      db.acceptCommit("u", [op("doc:a", "v1")], "s"); // seq 1
      const seq2 = db.acceptCommit("u", [op("doc:a", "v2")], "s"); // seq 2

      assertEquals(db.getDoc("doc:a")?.value, "v2");
      assertEquals(db.getDoc("doc:a")?.server_seq, seq2);

      // Both commits are still in canonical history.
      assertEquals(db.getCommitsBetween(0, 2).length, 2);
    });
  });
});
