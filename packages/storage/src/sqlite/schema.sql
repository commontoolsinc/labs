-- SQLite schema for per-space storage (see docs/specs/storage/02-schema.md)

-- Pragmas
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA page_size = 4096;
PRAGMA foreign_keys = ON;

-- Documents
CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Branches
CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  merged_into_branch_id TEXT,
  UNIQUE(doc_id, name),
  FOREIGN KEY(doc_id) REFERENCES docs(doc_id) ON DELETE CASCADE
);
-- Indexes to support merge/close queries
CREATE INDEX IF NOT EXISTS idx_branches_merged_into ON branches(merged_into_branch_id);
CREATE INDEX IF NOT EXISTS idx_branches_closed ON branches(doc_id, closed);

-- Current Heads per Branch
CREATE TABLE IF NOT EXISTS am_heads (
  branch_id TEXT PRIMARY KEY,
  heads_json TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  tx_id INTEGER NOT NULL,
  root_hash BLOB NOT NULL,
  committed_at TEXT NOT NULL,
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);

-- Transactions (Global Epochs with Crypto Chain)
CREATE TABLE IF NOT EXISTS tx (
  tx_id INTEGER PRIMARY KEY AUTOINCREMENT,
  committed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  prev_tx_hash BLOB NOT NULL,
  tx_body_hash BLOB NOT NULL,
  tx_hash BLOB NOT NULL,

  server_sig BLOB NOT NULL,
  server_pubkey BLOB NOT NULL,
  client_sig BLOB NOT NULL,
  client_pubkey BLOB NOT NULL,

  ucan_jwt TEXT NOT NULL,
  attestation_digest BLOB,
  xlog_seq INTEGER,

  UNIQUE(tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_tx_committed_at ON tx(committed_at);

CREATE TABLE IF NOT EXISTS tx_docs (
  tx_id INTEGER NOT NULL,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  PRIMARY KEY(tx_id, doc_id, branch_id),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);

-- CAS-Backed Change Store
CREATE TABLE IF NOT EXISTS am_change_blobs (
  bytes_hash BLOB PRIMARY KEY,
  bytes BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS am_change_index (
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  change_hash TEXT NOT NULL,
  bytes_hash BLOB NOT NULL,
  deps_json TEXT NOT NULL,
  lamport INTEGER,
  actor_id TEXT,
  tx_id INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, branch_id, seq_no),
  FOREIGN KEY(bytes_hash) REFERENCES am_change_blobs(bytes_hash),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_tx ON am_change_index(doc_id, branch_id, tx_id);
CREATE INDEX IF NOT EXISTS idx_change_hash ON am_change_index(change_hash);
-- Perf indexes for hot paths
CREATE INDEX IF NOT EXISTS idx_change_actor_seq ON am_change_index(branch_id, actor_id, seq_no);
CREATE INDEX IF NOT EXISTS idx_change_branch_hash ON am_change_index(branch_id, change_hash);
CREATE INDEX IF NOT EXISTS idx_change_seq_range ON am_change_index(doc_id, branch_id, seq_no);

-- Derived Caches
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

-- Latest JSON cache (per doc/branch). Stores only the most recent materialized
-- JSON value and associated seq_no to enable a fast path for queries that read
-- the current document value. Historical reads still materialize via PIT.
CREATE TABLE IF NOT EXISTS json_cache (
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(doc_id, branch_id),
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_json_cache_branch_seq ON json_cache(branch_id, seq_no);

-- Space-level settings for feature flags and overrides
CREATE TABLE IF NOT EXISTS space_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS am_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  upto_seq_no INTEGER NOT NULL,
  heads_json TEXT NOT NULL,
  root_hash BLOB NOT NULL,
  bytes BLOB NOT NULL,
  tx_id INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snap_seq ON am_snapshots(doc_id, branch_id, upto_seq_no);

-- Immutable Blobs
CREATE TABLE IF NOT EXISTS immutable_cids (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Generic CAS blobs for non-change kinds (snapshots, generic blobs)
CREATE TABLE IF NOT EXISTS cas_blobs (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('am_change','am_snapshot','blob')),
  bytes BLOB NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cas_blobs_kind ON cas_blobs(kind);
-- JSON meta indexes to speed up doc/branch/seqNo and doc/branch/txId lookups
CREATE INDEX IF NOT EXISTS idx_cas_meta_seq ON cas_blobs(
  json_extract(meta_json,'$.docId'),
  json_extract(meta_json,'$.branchId'),
  json_extract(meta_json,'$.seqNo')
);
CREATE INDEX IF NOT EXISTS idx_cas_meta_tx ON cas_blobs(
  json_extract(meta_json,'$.docId'),
  json_extract(meta_json,'$.branchId'),
  json_extract(meta_json,'$.txId')
);

-- Subscriptions and at-least-once deliveries for query WS
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  consumer_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_space_consumer ON subscriptions(space_id, consumer_id);

CREATE TABLE IF NOT EXISTS subscription_cursors (
  subscription_id INTEGER NOT NULL,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_watermark INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, doc_id, branch_id),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  delivery_no INTEGER NOT NULL,
  payload BLOB NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(subscription_id, delivery_no),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_sub_acked ON subscription_deliveries(subscription_id, acked);
CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_seq ON subscription_deliveries(subscription_id, delivery_no);

