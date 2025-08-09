-- Migration: introduce am_chunks with incremental snapshot chunks schema
-- Drops previous am_chunks (if existed) and recreates with new columns and indexes.

BEGIN TRANSACTION;

DROP TABLE IF EXISTS am_chunks;

CREATE TABLE IF NOT EXISTS am_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  from_snapshot_seq INTEGER,
  base_snapshot_digest TEXT,
  chunk_kind TEXT NOT NULL CHECK(chunk_kind IN ('automerge_incremental')),
  bytes BLOB NOT NULL,
  digest TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_am_chunks_seq ON am_chunks(doc_id, branch_id, seq_no);
CREATE INDEX IF NOT EXISTS idx_am_chunks_from_snapshot ON am_chunks(doc_id, branch_id, from_snapshot_seq);

COMMIT;
