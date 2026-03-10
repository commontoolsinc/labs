# 02 — Storage

This section defines the SQLite database schema, indexing strategy, patch and
snapshot storage design, branch representation, point-in-time read algorithm,
and operational configuration. Every table is specified with a `CREATE TABLE`
statement and accompanied by the key SQL queries that implement the read and
write paths.

---

## 1. Database-per-Space

Each Space (identified by a DID, e.g. `did:key:z6Mkk...`) gets its own
dedicated SQLite database file. The file is named after the DID:

```
<storage_root>/<did>.sqlite
```

For example:
```
/data/spaces/did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi.sqlite
```

This isolation means:

- Spaces cannot interfere with each other's storage.
- A space can be moved, replicated, or archived by copying a single file.
- WAL mode operates independently per space.

---

## 2. SQLite Pragmas

Every database connection applies the following pragmas at open time:

```sql
-- Write-Ahead Logging for concurrent reads during writes
PRAGMA journal_mode = WAL;

-- NORMAL sync: fsync at WAL checkpoints, not every commit.
-- Balances durability and throughput.
PRAGMA synchronous = NORMAL;

-- Wait up to 5 seconds if the database is locked by another connection
PRAGMA busy_timeout = 5000;

-- 64 MB page cache (negative = KB)
PRAGMA cache_size = -64000;

-- Store temp tables and indices in memory
PRAGMA temp_store = MEMORY;

-- Memory-map up to 256 MB of the database file for faster I/O
PRAGMA mmap_size = 268435456;

-- Enforce foreign key constraints
PRAGMA foreign_keys = ON;
```

For newly created databases (before any content is written):

```sql
-- Larger page size for better I/O alignment with modern storage
PRAGMA page_size = 32768;
```

For high-throughput workloads, the storage layer may cache prepared statements
for frequently-used queries (head lookup, fact insertion, snapshot lookup).
Statement caching is an implementation optimization and is not specified here.

---

## 3. Tables

### 3.1 `value` — Content-Addressed Value Storage

Stores the serialized JSON content of entity values (both full values and patch
operation lists). This is the equivalent of v1's `datum` table, renamed for
clarity. Every distinct JSON value is stored once; facts reference values by
hash.

```sql
CREATE TABLE value (
  hash  TEXT NOT NULL PRIMARY KEY,  -- Merkle reference of the JSON content
  data  JSON                        -- Serialized JSON (NULL for the "empty" sentinel)
);

-- Sentinel row for deleted/empty values (replaces v1's "undefined" record)
INSERT OR IGNORE INTO value (hash, data) VALUES ('__empty__', NULL);
```

**Design notes:**

- `hash` is the merkle reference computed over the JSON value using the same
  algorithm as fact hashing.
- `data` is stored as a JSON text column. SQLite's JSON functions can operate
  on it directly when needed.
- The `__empty__` sentinel represents a Delete fact's value (no data). Using a
  sentinel avoids NULLs in foreign key relationships, which SQLite does not
  enforce uniqueness on.

### 3.2 `fact` — Complete History

Stores every fact ever committed. This is the immutable append-only log of all
state transitions across all entities in the space.

```sql
CREATE TABLE fact (
  hash        TEXT    NOT NULL PRIMARY KEY,  -- Content hash of this fact
  id          TEXT    NOT NULL,              -- Entity identifier
  value_ref   TEXT    NOT NULL,              -- FK → value.hash (value or patch ops)
  parent      TEXT,                          -- Hash of previous fact (NULL for first write)
  branch      TEXT    NOT NULL DEFAULT '',   -- Branch this fact was committed on (denormalized)
  seq     INTEGER NOT NULL,             -- Lamport clock at commit time
  commit_seq  INTEGER NOT NULL,             -- FK → commit.seq
  fact_type   TEXT    NOT NULL,             -- 'set' | 'patch' | 'delete'

  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_seq) REFERENCES commit(seq)
);

-- Query facts by seq range (for subscriptions and point-in-time reads)
CREATE INDEX idx_fact_seq ON fact (seq);

-- Query all facts for a specific entity (for causal chain traversal)
CREATE INDEX idx_fact_id ON fact (id);

-- Query facts by entity and seq (for point-in-time entity reads)
CREATE INDEX idx_fact_id_seq ON fact (id, seq);

-- Query facts by commit (for commit inspection)
CREATE INDEX idx_fact_commit ON fact (commit_seq);

-- Query facts by branch (for branch-scoped reads)
CREATE INDEX idx_fact_branch ON fact (branch);
```

**Column details:**

| Column | Description |
|--------|-------------|
| `hash` | Content hash of `{type, id, value/ops, parent}`. Immutable identity. |
| `id` | The entity this fact is about. URI format. |
| `value_ref` | Points to the value table. For `set`: the full JSON value. For `patch`: the JSON-serialized patch operation list. For `delete`: the `__empty__` sentinel. |
| `parent` | Hash of the previous fact for this entity. `NULL` when this is the entity's first fact (parent is the Empty reference, which is implicit). |
| `branch` | Branch this fact was committed on. Denormalized from the commit for efficient branch-scoped queries. Default `''` (main branch). |
| `seq` | Space-global Lamport clock, assigned at commit time. All facts in the same commit share the same seq. |
| `commit_seq` | Seq of the commit that included this fact. Join through `commit.seq` to recover commit hash or payload. |
| `fact_type` | Discriminant: `'set'`, `'patch'`, or `'delete'`. |

### 3.3 `head` — Current State Pointer

Tracks the current (latest) fact for each entity on each branch. This is the
equivalent of v1's `memory` table.

```sql
CREATE TABLE head (
  branch    TEXT    NOT NULL,    -- Branch name ('' for the default branch)
  id        TEXT    NOT NULL,    -- Entity identifier
  fact_hash TEXT    NOT NULL,    -- FK → fact.hash (the current head fact)
  seq   INTEGER NOT NULL,   -- Seq of the head fact (for fast lookups)

  PRIMARY KEY (branch, id),
  FOREIGN KEY (fact_hash) REFERENCES fact(hash)
);

-- Query all heads on a branch (for branch diff/merge)
CREATE INDEX idx_head_branch ON head (branch);
```

**Design notes:**

- The default (main) branch uses an empty string `''` as its branch name.
- After each commit, the head row for every affected entity is updated to point
  to the new fact.
- When an entity is deleted, the head still exists — it points to the Delete
  fact. An entity with no head row has never been written to (Empty state).

### 3.4 `commit` — Sequenced Write Log

Records every successful **write-class** command. A commit groups zero or more
facts and/or branch metadata changes that were applied atomically.

```sql
CREATE TABLE commit (
  seq         INTEGER NOT NULL PRIMARY KEY,  -- Lamport clock (same as facts in this commit)
  hash        TEXT    NOT NULL,              -- Content hash of the canonical write payload
  branch      TEXT    NOT NULL DEFAULT '',   -- Branch this commit was applied to
  session_id  TEXT    NOT NULL,              -- Server-assigned session identifier
  local_seq   INTEGER NOT NULL,              -- Client-local pending index on that session
  invocation_ref     TEXT    NOT NULL,       -- FK → invocation.ref (the UCAN invocation that carried this commit)
  authorization_ref  TEXT    NOT NULL,       -- FK → authorization.ref (the verified auth blob covering that invocation)
  original    JSON    NOT NULL,              -- Canonical write payload normalized from invocation cmd + args
  resolution  JSON    NOT NULL,              -- { seq, resolvedPendingReads?: [{ localSeq, hash, seq }] }
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),  -- Wall-clock timestamp

  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);

-- Query commits by hash (for audit/replay lookups)
CREATE INDEX idx_commit_hash ON commit (hash);

-- Query commits by branch (for branch history)
CREATE INDEX idx_commit_branch ON commit (branch);

-- Resolve pending-read dependencies quickly
CREATE UNIQUE INDEX idx_commit_session_local_seq
  ON commit (session_id, local_seq);

-- Each successful write-class invocation produces at most one commit
CREATE UNIQUE INDEX idx_commit_invocation_ref ON commit (invocation_ref);
```

**Column details:**

| Column | Description |
|--------|-------------|
| `seq` | The Lamport clock value assigned to this commit. Matches the `seq` on all facts in this commit. Also serves as the commit log's primary key. |
| `hash` | Content hash of the canonical write payload. For `/memory/transact` this is the `ClientCommit` hash; for branch lifecycle writes it is the hash of the normalized lifecycle payload including command type. Stable across retransmission and independent of the outer UCAN wrapper. |
| `branch` | Which branch this commit targets. For branch lifecycle writes, this is the branch being created or deleted. |
| `session_id` | Identifies the logical client session that submitted the commit. Pending-read resolution is session-scoped and survives reconnects. |
| `local_seq` | The client-local pending index on that session. Combined with `session_id`, this is the idempotent replay key for write-class commands. |
| `invocation_ref` | Reference of the canonical UCAN invocation that carried this write payload over the wire. |
| `authorization_ref` | Reference of the verified `Authorization` object whose proof/signature covered that invocation. Batched sibling invocations may share this value. |
| `original` | The canonical write payload, preserved for audit, replay, and commit-hash verification. For `/memory/transact` this is `ClientCommit`; for branch lifecycle writes it is a normalized payload that includes the command type plus its args. |
| `resolution` | Server-side resolution metadata. For `/memory/transact` this includes the resolved `{ localSeq, hash, seq }` mapping for any pending-read dependencies. For branch lifecycle writes it still includes the assigned `seq` but has no pending-read entries. |
| `created_at` | Wall-clock time for diagnostics. Not used for ordering. |

**Design notes:**

- The commit row stores the semantic write payload and points to the
  authenticated transport envelope separately. This keeps `commit.hash` stable
  even if the same logical write is later replayed inside a fresh invocation or
  authorization wrapper.
- `/memory/transact` rows carry a `ClientCommit` payload and usually reference
  one or more facts. `/memory/branch/create` and `/memory/branch/delete` rows
  carry branch-lifecycle payloads and may reference zero facts.
- This split is intentionally close to later verifiable-receipt work: a future
  receipt table can add code/input/output/policy commitments without redefining
  commit identity or duplicating signatures.

#### `invocation` — Persisted UCAN Invocations

Stores the canonical invocation object for successful write-class commands.

```sql
CREATE TABLE invocation (
  ref         TEXT    NOT NULL PRIMARY KEY,  -- Merkle reference of the canonical invocation object
  iss         TEXT    NOT NULL,              -- Signer / issuer DID declared by the invocation
  aud         TEXT,                          -- Optional audience DID
  cmd         TEXT    NOT NULL,              -- E.g. "/memory/transact"
  sub         TEXT    NOT NULL,              -- Target space DID
  invocation  JSON    NOT NULL,              -- Canonical invocation object
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invocation_sub ON invocation (sub);
CREATE INDEX idx_invocation_cmd ON invocation (cmd);
CREATE INDEX idx_invocation_iss ON invocation (iss);
```

**Design notes:**

- `ref` is the raw content-addressed invocation reference. The protocol-level
  `job:<hash>` identifier is a presentation form derived from it.
- Persisting the invocation preserves who submitted the command (`iss`), which
  space it targeted (`sub`), and the exact command payload that was authorized.

#### `authorization` — Verified Authorization Blobs

Stores the verified authorization proof/signature object that covered one or
more invocations.

```sql
CREATE TABLE authorization (
  ref            TEXT    NOT NULL PRIMARY KEY,  -- Merkle reference of the canonical Authorization object
  authorization  JSON    NOT NULL,              -- { signature, access }
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Design notes:**

- One `authorization` row MAY be shared by many successful commits if multiple
  invocations were batch-signed together.
- The authorization object proves that a signer authorized a set of invocation
  refs. The signer identity itself lives on the referenced invocation (`iss`).

### 3.5 `snapshot` — Periodic Full-Value Materializations

Stores pre-computed full values for entities at specific seqs, enabling
fast reads without full patch replay.

```sql
CREATE TABLE snapshot (
  id         TEXT    NOT NULL,    -- Entity identifier
  seq    INTEGER NOT NULL,    -- Version at which this snapshot was taken
  value_ref  TEXT    NOT NULL,    -- FK → value.hash (the full materialized value)
  branch     TEXT    NOT NULL DEFAULT '',  -- Branch this snapshot belongs to

  PRIMARY KEY (branch, id, seq),
  FOREIGN KEY (value_ref) REFERENCES value(hash)
);

-- Find the nearest snapshot before a target seq
CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, seq);
```

### 3.6 `branch` — Branch Metadata

Tracks branch lifecycle and fork points.

```sql
CREATE TABLE branch (
  name            TEXT    NOT NULL PRIMARY KEY,  -- Branch name ('' = default/main)
  parent_branch   TEXT,                          -- Branch this was forked from (NULL for default)
  fork_seq        INTEGER,                       -- Seq at the time of fork
  created_seq     INTEGER NOT NULL DEFAULT 0,    -- Seq at which the branch name came into existence
  head_seq        INTEGER NOT NULL DEFAULT 0,    -- Latest seq at which branch-visible state was updated
  status          TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'deleted'
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,

  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);

-- Seed the default branch
INSERT OR IGNORE INTO branch (name, created_seq, head_seq, status)
VALUES ('', 0, 0, 'active');
```

### 3.7 `blob_store` — Immutable Content-Addressed Binary Data

Stores raw binary blobs (images, files, compiled code). This is distinct from
the `value` table, which stores JSON values. The `blob_store` table holds
arbitrary binary data.

```sql
CREATE TABLE blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,  -- SHA-256 of the raw bytes
  data          BLOB    NOT NULL,             -- Raw binary content
  content_type  TEXT    NOT NULL,             -- MIME type
  size          INTEGER NOT NULL              -- Byte length
);
```

**Design notes:**

- Two separate tables (`value` for JSON, `blob_store` for binary) avoids
  conflating serialized JSON with raw bytes.
- Binary blobs are never modified or deleted (content-addressed and immutable).
- The `hash` column uses the same SHA-256 algorithm but applied to raw bytes
  rather than the merkle-tree encoding used for JSON values.

### 3.8 Full Initialization Script

The complete schema is applied as a single transaction when creating a new
database:

```sql
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS value (
  hash  TEXT NOT NULL PRIMARY KEY,
  data  JSON
);
INSERT OR IGNORE INTO value (hash, data) VALUES ('__empty__', NULL);

CREATE TABLE IF NOT EXISTS authorization (
  ref            TEXT    NOT NULL PRIMARY KEY,
  authorization  JSON    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invocation (
  ref         TEXT    NOT NULL PRIMARY KEY,
  iss         TEXT    NOT NULL,
  aud         TEXT,
  cmd         TEXT    NOT NULL,
  sub         TEXT    NOT NULL,
  invocation  JSON    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invocation_sub ON invocation (sub);
CREATE INDEX IF NOT EXISTS idx_invocation_cmd ON invocation (cmd);
CREATE INDEX IF NOT EXISTS idx_invocation_iss ON invocation (iss);

CREATE TABLE IF NOT EXISTS commit (
  seq         INTEGER NOT NULL PRIMARY KEY,
  hash        TEXT    NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  session_id  TEXT    NOT NULL,
  local_seq   INTEGER NOT NULL,
  invocation_ref     TEXT    NOT NULL,
  authorization_ref  TEXT    NOT NULL,
  original    JSON    NOT NULL,
  resolution  JSON    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);
CREATE INDEX IF NOT EXISTS idx_commit_hash ON commit (hash);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON commit (branch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_session_local_seq
  ON commit (session_id, local_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_invocation_ref
  ON commit (invocation_ref);

CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  branch      TEXT    NOT NULL DEFAULT '',
  seq     INTEGER NOT NULL,
  commit_seq  INTEGER NOT NULL,
  fact_type   TEXT    NOT NULL,
  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_seq) REFERENCES commit(seq)
);
CREATE INDEX IF NOT EXISTS idx_fact_seq    ON fact (seq);
CREATE INDEX IF NOT EXISTS idx_fact_id         ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_seq ON fact (id, seq);
CREATE INDEX IF NOT EXISTS idx_fact_commit     ON fact (commit_seq);
CREATE INDEX IF NOT EXISTS idx_fact_branch     ON fact (branch);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  fact_hash TEXT    NOT NULL,
  seq   INTEGER NOT NULL,
  PRIMARY KEY (branch, id),
  FOREIGN KEY (fact_hash) REFERENCES fact(hash)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  id         TEXT    NOT NULL,
  seq    INTEGER NOT NULL,
  value_ref  TEXT    NOT NULL,
  branch     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (branch, id, seq),
  FOREIGN KEY (value_ref) REFERENCES value(hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, seq);

CREATE TABLE IF NOT EXISTS branch (
  name            TEXT    NOT NULL PRIMARY KEY,
  parent_branch   TEXT,
  fork_seq        INTEGER,
  created_seq     INTEGER NOT NULL DEFAULT 0,
  head_seq        INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, created_seq, head_seq, status)
VALUES ('', 0, 0, 'active');

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

COMMIT;
```

### 3.9 `state` — Convenience View

A read-only view that joins heads with their facts and values for convenient
querying of current state:

```sql
CREATE VIEW state AS
SELECT h.branch, h.id, f.fact_type, f.seq, v.data AS value
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref;
```

This view is not used by the storage layer's internal read/write paths but is
useful for debugging and ad-hoc queries.

---

## 4. Patch Storage

### 4.1 How Patches Are Stored

When a transaction contains a patch operation for an entity, the system:

1. Serializes the patch operation list as JSON:
   ```json
   [
     {"op": "replace", "path": "/name", "value": "Alice"},
     {"op": "add", "path": "/tags/-", "value": "new-tag"}
   ]
   ```

2. Computes the merkle reference of this JSON array.

3. Inserts the serialized ops into the `value` table (deduplicated by hash).

4. Inserts a fact row with `fact_type = 'patch'` and `value_ref` pointing to
   the value row containing the ops.

A `set` write works the same way except the value row contains the complete JSON
value and `fact_type = 'set'`.

A `delete` sets `value_ref` to the `__empty__` sentinel and `fact_type = 'delete'`.

### 4.2 Write Path — Insert a Patch Fact

```sql
-- Step 1: Insert the patch ops value (deduplicated)
INSERT OR IGNORE INTO value (hash, data)
VALUES (:ops_hash, :ops_json);

-- Step 2: Insert the fact
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_seq, fact_type)
VALUES (:fact_hash, :entity_id, :ops_hash, :parent_hash, :branch, :seq, :commit_seq, 'patch');

-- Step 3: Update (or insert) the head pointer
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch, :entity_id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, seq = :seq;
```

### 4.3 Write Path — Insert a Set Fact

```sql
-- Step 1: Insert the value (deduplicated)
INSERT OR IGNORE INTO value (hash, data)
VALUES (:value_hash, :value_json);

-- Step 2: Insert the fact
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_seq, fact_type)
VALUES (:fact_hash, :entity_id, :value_hash, :parent_hash, :branch, :seq, :commit_seq, 'set');

-- Step 3: Update the head pointer
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch, :entity_id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, seq = :seq;
```

### 4.4 Write Path — Insert a Delete Fact

```sql
-- Step 1: Insert the fact (value_ref = __empty__ sentinel)
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_seq, fact_type)
VALUES (:fact_hash, :entity_id, '__empty__', :parent_hash, :branch, :seq, :commit_seq, 'delete');

-- Step 2: Update the head pointer to the delete fact
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch, :entity_id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, seq = :seq;
```

---

## 5. Read Path

### 5.1 Read Current Value

To read an entity's current value on a branch:

```sql
-- Step 1: Find the current head fact
SELECT f.fact_type, f.seq, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = :branch AND h.id = :entity_id;
```

If `fact_type = 'set'`, the `data` column contains the full value. Done.

If `fact_type = 'delete'`, the entity is deleted. Return `null`.

If `fact_type = 'patch'`, we need to find a base value and replay:

```sql
-- Step 2: Find the nearest snapshot
SELECT s.seq, v.data AS snapshot_value
FROM snapshot s
JOIN value v ON v.hash = s.value_ref
WHERE s.branch = :branch
  AND s.id = :entity_id
  AND s.seq <= :head_seq
ORDER BY s.seq DESC
LIMIT 1;
```

```sql
-- Step 3: If no snapshot, find the most recent 'set' fact
-- NOTE: effective_fact is a branch-scoped fact view (see §9.2).
SELECT f.seq, v.data AS set_value
FROM effective_fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'set'
  AND f.seq <= :head_seq
ORDER BY f.seq DESC
LIMIT 1;
```

```sql
-- Step 4: Collect all patches between base and head
SELECT v.data AS patch_ops, f.seq
FROM effective_fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'patch'
  AND f.seq > :base_seq
  AND f.seq <= :head_seq
ORDER BY f.seq ASC;
```

Then in application code:

```typescript
function readEntity(
  branch: string,
  entityId: EntityId,
): JSONValue | null {
  const head = getHead(branch, entityId);
  if (!head) return null;                    // Never written (Empty)
  if (head.factType === "delete") return null; // Deleted

  if (head.factType === "set") {
    return JSON.parse(head.data);            // Full value at head
  }

  // head.factType === "patch" — need to reconstruct
  const snapshot = findNearestSnapshot(branch, entityId, head.seq);
  const baseSeq = snapshot?.seq ?? findLatestSet(entityId, head.seq)?.seq ?? 0;
  const baseValue = snapshot?.value ?? findLatestSet(entityId, head.seq)?.value ?? {};

  const patches = collectPatches(entityId, baseSeq, head.seq);
  let value = baseValue;
  for (const patch of patches) {
    value = applyPatch(value, JSON.parse(patch.ops));
  }
  return value;
}
```

### 5.2 Point-in-Time Read

Read an entity's value at a specific seq on a branch:

```sql
-- Find the fact that was the head at the target seq
-- (the latest fact for this entity with seq <= target).
-- NOTE: effective_fact is a branch-scoped fact view (see §9.2).
SELECT f.hash, f.fact_type, f.seq, v.data
FROM effective_fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.seq <= :target_seq
ORDER BY f.seq DESC
LIMIT 1;
```

If the result is a `set`, return the value directly. If it's a `delete`, return
`null`. If it's a `patch`, find the nearest snapshot or `set` before
`:target_seq` and replay patches up to `:target_seq` using the same
algorithm as §5.1 but with `target_seq` as the upper bound.

```sql
-- Snapshot lookup for PIT read
SELECT s.seq, v.data AS snapshot_value
FROM snapshot s
JOIN value v ON v.hash = s.value_ref
WHERE s.branch = :branch
  AND s.id = :entity_id
  AND s.seq <= :target_seq
ORDER BY s.seq DESC
LIMIT 1;

-- Patches between snapshot and target
SELECT v.data AS patch_ops, f.seq
FROM effective_fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'patch'
  AND f.seq > :snapshot_seq
  AND f.seq <= :target_seq
ORDER BY f.seq ASC;
```

### 5.3 Read Multiple Entities

For bulk reads (e.g., query results), the same algorithm applies per entity.
The query system (§05) handles batching and optimization.

---

## 6. Snapshot Creation

### 6.1 Trigger Condition

After committing a transaction, the system checks each affected entity to see
if a new snapshot should be created. The condition is:

```sql
-- Count patches since the last snapshot (or since genesis)
-- NOTE: effective_fact is a branch-scoped fact view (see §9.2).
SELECT COUNT(*) AS patch_count
FROM effective_fact f
WHERE f.id = :entity_id
  AND f.fact_type = 'patch'
  AND f.seq > COALESCE(
    (SELECT MAX(s.seq) FROM snapshot s
     WHERE s.branch = :branch AND s.id = :entity_id),
    0
  );
```

If `patch_count >= :snapshot_interval` (default 10), create a snapshot.

### 6.2 Snapshot Materialization

To create a snapshot, read the entity's current value using the standard read
path (§5.1), then store it:

```sql
-- Step 1: Store the materialized value
INSERT OR IGNORE INTO value (hash, data)
VALUES (:value_hash, :value_json);

-- Step 2: Insert the snapshot record
INSERT OR REPLACE INTO snapshot (id, seq, value_ref, branch)
VALUES (:entity_id, :seq, :value_hash, :branch);
```

### 6.3 Snapshot Compaction

Old snapshots can be removed to reclaim space. Only the most recent snapshot per
entity per branch is needed for efficient reads. A compaction query:

```sql
-- Keep only the latest snapshot per entity per branch
DELETE FROM snapshot
WHERE rowid NOT IN (
  SELECT rowid FROM snapshot s1
  WHERE s1.seq = (
    SELECT MAX(s2.seq) FROM snapshot s2
    WHERE s2.branch = s1.branch AND s2.id = s1.id
  )
);
```

In practice, keeping a few historical snapshots can speed up point-in-time reads
for popular seqs.

---

## 7. Garbage Collection

The storage layer accumulates data over time: old facts, orphaned values, and
redundant snapshots. Garbage collection (GC) reclaims space without affecting
correctness.

### 7.1 Fact Compaction

The fact log is append-only and MUST NOT be mutated in place. Historical facts
remain part of the audit trail and are required for verifiability. Compaction,
if enabled, writes archived facts to external storage but does not delete rows
from `fact`.

```sql
-- Identify archival candidates (for export), without deleting local history
SELECT f.hash
FROM fact f
WHERE f.seq < :retention_seq
  AND f.hash NOT IN (SELECT parent FROM fact WHERE parent IS NOT NULL);
```

### 7.2 Orphaned Values

Values in the `value` table that are not referenced by any fact's `value_ref`
can be safely deleted. The `__empty__` sentinel must never be deleted.

```sql
DELETE FROM value
WHERE hash != '__empty__'
  AND hash NOT IN (SELECT value_ref FROM fact)
  AND hash NOT IN (SELECT value_ref FROM snapshot);
```

### 7.3 Old Snapshots

Only the most recent snapshot per entity per branch is needed for efficient
current-value reads. Historical snapshots may be retained for point-in-time
read performance. See §6.3 for the compaction query.

### 7.4 Policy

- GC runs as a **background task**, never during commits.
- GC is configurable with a retention period. Facts and values within the
  retention window are never collected.
- **Default policy: retain all** (no automatic GC). GC must be explicitly
  enabled per space.
- Deletion changes reachability; it does not rewrite metadata. Any future
  label/policy metadata carried by surviving records must remain attached to
  those records until they themselves become unreachable and GC removes them.

---

## 8. Branch Storage

### 8.1 Branch Representation

Branches share the global `fact` table but maintain separate head pointers in
the `head` table. The `branch` table tracks metadata.

When a `/memory/branch/create` write succeeds, its branch-table side effect is:

```sql
-- Record the fork point
INSERT INTO branch (name, parent_branch, fork_seq, created_seq, head_seq)
VALUES (:branch_name, :parent_branch, :fork_seq, :created_seq, :created_seq);
```

This insert occurs in the same database transaction as the corresponding
branch-creation commit-log insert.

Head pointers are **not** eagerly copied from the parent branch. Instead, reads
on a child branch resolve heads lazily: if no head exists for an entity on the
child branch, the system falls back to the parent branch's head at or before
the fork seq. This avoids an O(N) copy of all head pointers at fork time
and makes branch creation O(1). See §06 Branching for the full resolution
algorithm.

### 8.2 Branch Writes

Writing to a branch is identical to writing to the default branch — the same
fact and value insertion, but the head update targets the branch name:

```sql
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch_name, :entity_id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, seq = :seq;
```

The `commit` row records which branch was written to, plus the submitting
session, invocation/auth references, and the original/resolved write payloads:

```sql
INSERT INTO commit (
  hash, seq, branch, session_id, local_seq,
  invocation_ref, authorization_ref,
  original, resolution
)
VALUES (
  :commit_hash,
  :seq,
  :branch_name,
  :session_id,
  :local_seq,
  :invocation_ref,
  :authorization_ref,
  :original_json,
  :resolution_json
);
```

Branch creation and branch deletion use the same commit-log insert pattern, but
their write transaction updates the `branch` table rather than inserting facts.

If a client replays a previously accepted transaction after reconnecting, the
server resolves idempotence by `(session_id, local_seq)`. If a row already
exists for that pair:

- If the stored `hash` matches the replayed commit hash, return the existing
  recorded result.
- If the stored `hash` differs, reject the replay as a protocol error (the
  client reused a local sequence number for different logical content).

### 8.3 Branch Seq Numbering

Each branch maintains both `created_seq` and `head_seq` in the `branch` table:

- `created_seq` (= `createdSeq`) is the global seq at which the branch name
  came into existence.
- `head_seq` (= `headSeq`) is the latest global seq at which the branch's
  visible state was updated.

At branch creation time, both columns are initialized to the creation command's
global seq. Thereafter, when an entity-state commit is applied to a branch,
`head_seq` is set to that commit's global seq number:

```sql
UPDATE branch
SET head_seq = :seq
WHERE name = :branch_name;
```

The Lamport clock (`seq` column on facts and commits) is space-global —
it increases across all branches. `created_seq` tells you when the branch name
became valid; `head_seq` tells you the latest seq whose entity-state effects are
visible on that branch. Branch deletion gets its own commit-log `seq` but does
not advance `head_seq`, because it does not change branch-visible entity state.

### 8.4 Branch Deletion

```sql
-- Soft-delete branch metadata. Keep head/snapshot rows for lineage reads.
UPDATE branch
SET status = 'deleted',
    deleted_at = datetime('now')
WHERE name = :branch_name
  AND name != '';
```

Facts and commits are NOT deleted (shared history). Head and snapshot rows are
also retained so child-branch ancestry and historical reads remain valid.
This update occurs in the same database transaction as the corresponding
branch-deletion commit-log insert.

---

## 9. Point-in-Time Read Implementation

Point-in-time reads combine fact lookup and snapshot-based reconstruction.

### 9.1 Algorithm

```typescript
function readAtSeq(
  branch: string,
  entityId: EntityId,
  targetSeq: number,
): JSONValue | null {
  // 1. Find the latest fact for this entity at or before targetSeq
  const latestFact = findFactAtSeq(entityId, targetSeq);
  if (!latestFact) return null;  // Entity didn't exist at this seq

  // 2. If it's a delete, entity was deleted at this seq
  if (latestFact.factType === "delete") return null;

  // 3. If it's a set, return the value directly
  if (latestFact.factType === "set") {
    return JSON.parse(latestFact.data);
  }

  // 4. It's a patch — find nearest snapshot ≤ targetSeq
  const snapshot = findNearestSnapshot(branch, entityId, targetSeq);

  // 5. If no snapshot, find the latest set ≤ targetSeq
  const baseSet = snapshot
    ? null
    : findLatestSetBefore(entityId, targetSeq);

  const baseSeq = snapshot?.seq ?? baseSet?.seq ?? 0;
  const baseValue = snapshot?.value ?? baseSet?.value ?? {};

  // 6. Collect and apply patches from baseSeq to targetSeq
  const patches = collectPatches(entityId, baseSeq, targetSeq);
  let value = baseValue;
  for (const patch of patches) {
    value = applyPatch(value, JSON.parse(patch.ops));
  }
  return value;
}
```

### 9.2 Branch-Aware PIT Reads

For point-in-time reads on a branch, the query must include:

- Facts written directly on the target branch
- Facts inherited from ancestor branches, constrained by each fork seq
- Facts written by merge transactions on the target branch at their merge seq

In the phase-3 baseline, merges are materialized as ordinary target-branch
writes, so the same lineage-based `effective_fact` query works for both regular
commits and merge commits:

```sql
WITH RECURSIVE lineage(name, parent_branch, fork_seq, max_seq) AS (
  SELECT b.name, b.parent_branch, b.fork_seq, :target_seq
  FROM branch b
  WHERE b.name = :branch_name

  UNION ALL

  SELECT p.name, p.parent_branch, p.fork_seq, MIN(l.max_seq, l.fork_seq)
  FROM lineage l
  JOIN branch p ON p.name = l.parent_branch
  WHERE l.parent_branch IS NOT NULL
),
effective_fact AS (
  SELECT f.*
  FROM fact f
  JOIN lineage l ON l.name = f.branch
  WHERE f.seq <= l.max_seq
)
SELECT f.hash, f.fact_type, f.seq, v.data
FROM effective_fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.seq <= :target_seq
ORDER BY f.seq DESC
LIMIT 1;
```

---

## 10. Blob Store Operations

### 10.1 Write a Blob

```sql
-- Content-addressed: INSERT OR IGNORE deduplicates automatically
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size);
```

### 10.2 Read a Blob

```sql
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash;
```

### 10.3 Blob Metadata

Blob metadata is stored as a regular entity (see §01 Data Model, section 5).
The metadata entity id is derived from the blob hash:

```
urn:blob-meta:<blob_hash>
```

Reading and writing blob metadata uses the standard entity read/write paths.
Deleting an entity that references a blob does not delete this metadata entity;
only ordinary entity deletion of `urn:blob-meta:<hash>` or later GC of
unreachable records can remove it.

---

## 11. Migration

Memory v2 is a **clean break** from v1. There is no migration path from the v1
database schema to v2. Existing v1 databases are not modified; new v2 databases
are created fresh.

If data from v1 spaces needs to be carried forward, it must be exported from v1
and re-imported as new facts in v2. This is an explicit, application-level
operation — not an automatic migration.

**Rationale**: The structural changes (removal of the `the` dimension, addition
of patches, snapshots, branches, and blobs) make in-place migration
impractical. A clean start simplifies the implementation and avoids carrying
forward legacy constraints.
