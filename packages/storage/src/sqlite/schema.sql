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
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  merged_into_branch_id TEXT,
  UNIQUE(doc_id, name),
  FOREIGN KEY(doc_id) REFERENCES docs(doc_id) ON DELETE CASCADE
);

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

-- Derived Caches
CREATE TABLE IF NOT EXISTS am_chunks (
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  tx_id INTEGER NOT NULL,
  PRIMARY KEY(doc_id, branch_id, seq_no),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
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


