/**
 * StitchDb — SQLite storage layer for the stitch sync protocol.
 *
 * Maintains two tables per the spec:
 *   stitch_commits — append-only canonical history
 *   stitch_docs    — materialized current state (one row per document)
 */

import { Database } from "@db/sqlite";
import type { CommitOp } from "./stitch.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA cache_size=-64000;
PRAGMA temp_store=MEMORY;
PRAGMA foreign_keys=ON;

-- Canonical history, append-only. server_seq is assigned by SQLite rowid.
CREATE TABLE IF NOT EXISTS stitch_commits (
  server_seq INTEGER PRIMARY KEY NOT NULL,
  user_id    TEXT    NOT NULL,
  ops        TEXT    NOT NULL,   -- JSON array of CommitOp
  signature  TEXT    NOT NULL
);

-- Materialized document state. server_seq is the commit that last wrote this doc.
CREATE TABLE IF NOT EXISTS stitch_docs (
  doc_id     TEXT    PRIMARY KEY NOT NULL,
  value      TEXT    NOT NULL,   -- JSON
  server_seq INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Row types returned by queries
// ---------------------------------------------------------------------------

export type CommitRow = {
  server_seq: number;
  user_id: string;
  ops: CommitOp[];
  signature: string;
};

export type DocRow = {
  doc_id: string;
  value: unknown;
  server_seq: number;
};

// ---------------------------------------------------------------------------
// StitchDb
// ---------------------------------------------------------------------------

export class StitchDb {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Open (or create) the stitch SQLite database at the given path and
   * initialise the schema.
   */
  static open(path: string): StitchDb {
    const db = new Database(path);
    db.exec(SCHEMA);
    return new StitchDb(db);
  }

  /** Current highest server_seq, or 0 if no commits exist yet. */
  currentServerSeq(): number {
    const row = this.#db.prepare(
      `SELECT COALESCE(MAX(server_seq), 0) AS seq FROM stitch_commits`,
    ).get() as { seq: number };
    return row.seq;
  }

  /**
   * Append a commit to canonical history and return the assigned server_seq.
   * The caller must apply the ops to stitch_docs in the same logical step.
   */
  CreateinsertCommit(
    userId: string,
    ops: CommitOp[],
    signature: string,
  ): number {
    this.#db.run(
      `INSERT INTO stitch_commits (user_id, ops, signature)
       VALUES (:userId, :ops, :signature)`,
      { userId, ops: JSON.stringify(ops), signature },
    );
    const row = this.#db.prepare(
      `SELECT last_insert_rowid() AS seq`,
    ).get() as { seq: number };
    return row.seq;
  }

  /** Insert a commit and apply its ops atomically. Returns the new server_seq. */
  acceptCommit(userId: string, ops: CommitOp[], signature: string): number {
    return this.#db.transaction(() => {
      const serverSeq = this.CreateinsertCommit(userId, ops, signature);
      for (const op of ops) {
        if (op.op === "set") {
          this.setDoc(op.id, op.value, serverSeq);
        }
      }
      return serverSeq;
    })();
  }

  /** Retrieve the current state of a document, or null if it does not exist. */
  getDoc(docId: string): DocRow | null {
    const row = this.#db.prepare(
      `SELECT doc_id, value, server_seq FROM stitch_docs WHERE doc_id = :docId`,
    ).get({ docId }) as
      | { doc_id: string; value: string; server_seq: number }
      | undefined;
    if (!row) return null;
    return {
      doc_id: row.doc_id,
      value: JSON.parse(row.value),
      server_seq: row.server_seq,
    };
  }

  /** Upsert the current state of a document. */
  setDoc(docId: string, value: unknown, serverSeq: number): void {
    this.#db.run(
      `INSERT INTO stitch_docs (doc_id, value, server_seq)
       VALUES (:docId, :value, :serverSeq)
       ON CONFLICT(doc_id) DO UPDATE SET value = :value, server_seq = :serverSeq`,
      { docId, value: JSON.stringify(value), serverSeq },
    );
  }

  /**
   * Retrieve all commits whose server_seq is strictly greater than fromSeq
   * and at most toSeq, in ascending order.
   */
  getCommitsBetween(fromSeq: number, toSeq: number): CommitRow[] {
    const rows = this.#db.prepare(
      `SELECT server_seq, user_id, ops, signature
       FROM stitch_commits
       WHERE server_seq > :fromSeq AND server_seq <= :toSeq
       ORDER BY server_seq ASC`,
    ).all({ fromSeq, toSeq }) as {
      server_seq: number;
      user_id: string;
      ops: string;
      signature: string;
    }[];
    return rows.map((r) => ({
      server_seq: r.server_seq,
      user_id: r.user_id,
      ops: JSON.parse(r.ops) as CommitOp[],
      signature: r.signature,
    }));
  }

  close(): void {
    this.#db.close();
  }
}
