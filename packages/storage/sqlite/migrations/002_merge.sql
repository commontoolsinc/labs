-- Migration: add branch close/merge columns and indexes, and space_settings table
-- Note: SQLite has limited ALTER TABLE support; we add new columns and indexes.

BEGIN TRANSACTION;

-- Add new branch state columns (no-op if columns already exist; SQLite will error if duplicate)
ALTER TABLE branches ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN closed_at TEXT;

-- Backfill closed from legacy is_closed if present
UPDATE branches SET closed = COALESCE(closed, 0);
UPDATE branches SET closed = is_closed WHERE typeof(is_closed) != 'null';

-- Create indexes for merge/close semantics
CREATE INDEX IF NOT EXISTS idx_branches_merged_into ON branches(merged_into_branch_id);
CREATE INDEX IF NOT EXISTS idx_branches_closed ON branches(doc_id, closed);

-- Create per-space settings table if it does not exist
CREATE TABLE IF NOT EXISTS space_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

COMMIT;

