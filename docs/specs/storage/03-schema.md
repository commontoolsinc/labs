# Schema (per space DB)

## Pragmas

- WAL, `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size=256MB`,
  `page_size=4096`, `foreign_keys=ON`.

## Docs & Branches

```sql
CREATE TABLE docs (
  doc_id TEXT PRIMARY KEY,           -- 'doc:<mh>' or reserved like 'cid:<mh>' for type routing
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- "main" etc.
  parent_branch_id TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  merged_into_branch_id TEXT,
  UNIQUE(doc_id, name),
  FOREIGN KEY(doc_id) REFERENCES docs(doc_id) ON DELETE CASCADE
);

CREATE TABLE am_heads (
  branch_id TEXT PRIMARY KEY,
  heads_json TEXT NOT NULL,          -- JSON array of head hashes
  seq_no INTEGER NOT NULL,           -- last seq
  tx_id INTEGER NOT NULL,            -- last tx touching this branch
  root_hash BLOB,                    -- BLAKE3 over sorted heads
  committed_at TEXT NOT NULL,
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);
```

## Tx chain (verifiable)

```sql
CREATE TABLE tx (
  tx_id INTEGER PRIMARY KEY AUTOINCREMENT,
  committed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  prev_tx_hash BLOB NOT NULL,        -- 32 bytes
  tx_body_hash BLOB NOT NULL,        -- 32 bytes
  tx_hash BLOB NOT NULL,             -- 32 bytes
  server_sig BLOB NOT NULL,          -- Ed25519
  server_pubkey BLOB NOT NULL,       -- 32 bytes
  client_sig BLOB NOT NULL,          -- UCAN sig (or detached if used)
  client_pubkey BLOB NOT NULL,       -- from UCAN DID
  ucan_jwt TEXT NOT NULL,            -- exact JWT
  attestation_digest BLOB,           -- optional
  xlog_seq INTEGER,                  -- optional
  UNIQUE(tx_hash)
);
CREATE INDEX idx_tx_committed_at ON tx(committed_at);
```

Optional: store the canonical CBOR of `TxBody`:

```sql
CREATE TABLE tx_body (
  tx_id INTEGER PRIMARY KEY,
  cbor BLOB NOT NULL,
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
```

## CAS-backed changes

```sql
CREATE TABLE am_change_blobs (
  bytes_hash BLOB PRIMARY KEY,       -- BLAKE3(bytes)
  bytes BLOB NOT NULL
);

CREATE TABLE am_change_index (
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,           -- per (doc,branch)
  change_hash TEXT NOT NULL,         -- Automerge change hash
  bytes_hash BLOB NOT NULL,          -- FK -> blobs
  deps_json TEXT NOT NULL,
  lamport INTEGER,
  actor_id TEXT,
  tx_id INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, branch_id, seq_no),
  FOREIGN KEY(bytes_hash) REFERENCES am_change_blobs(bytes_hash),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
CREATE INDEX idx_change_tx   ON am_change_index(doc_id, branch_id, tx_id);
CREATE INDEX idx_change_hash ON am_change_index(change_hash);
```

## Snapshots & Chunks (derived caches)

```sql
CREATE TABLE am_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  upto_seq_no INTEGER NOT NULL,
  heads_json TEXT NOT NULL,
  root_hash BLOB NOT NULL,
  bytes BLOB NOT NULL,               -- save() bytes
  tx_id INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
CREATE INDEX idx_snap_seq ON am_snapshots(doc_id, branch_id, upto_seq_no);

CREATE TABLE am_chunks (
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,           -- aligns with change seq
  bytes BLOB NOT NULL,               -- saveIncremental() bytes
  tx_id INTEGER NOT NULL,
  PRIMARY KEY(doc_id, branch_id, seq_no),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
```

## Tx ↔ Doc touch map (optional analytics)

```sql
CREATE TABLE tx_docs (
  tx_id INTEGER NOT NULL,
  doc_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  PRIMARY KEY(tx_id, doc_id, branch_id),
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);
```

## Immutable CIDs

```sql
CREATE TABLE immutable_cids (
  cid TEXT PRIMARY KEY,              -- 'cid:<mh>'
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```
