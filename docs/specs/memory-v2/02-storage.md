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
  commit_ref  TEXT    NOT NULL,             -- FK → commit.hash
  fact_type   TEXT    NOT NULL,             -- 'set' | 'patch' | 'delete'

  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_ref) REFERENCES commit(hash)
);

-- Query facts by seq range (for subscriptions and point-in-time reads)
CREATE INDEX idx_fact_seq ON fact (seq);

-- Query all facts for a specific entity (for causal chain traversal)
CREATE INDEX idx_fact_id ON fact (id);

-- Query facts by entity and seq (for point-in-time entity reads)
CREATE INDEX idx_fact_id_seq ON fact (id, seq);

-- Query facts by commit (for commit inspection)
CREATE INDEX idx_fact_commit ON fact (commit_ref);

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
| `commit_ref` | Hash of the commit that included this fact. |
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

### 3.4 `commit` — Transaction Log

Records every committed transaction. A commit groups one or more facts that
were applied atomically.

```sql
CREATE TABLE commit (
  hash        TEXT    NOT NULL PRIMARY KEY,  -- Content hash of the commit
  seq     INTEGER NOT NULL,             -- Lamport clock (same as facts in this commit)
  branch      TEXT    NOT NULL DEFAULT '',   -- Branch this commit was applied to
  reads       JSON,                         -- Read set: {entityId: seq} for validation
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))  -- Wall-clock timestamp
);

-- Query commits by seq (for log traversal)
CREATE INDEX idx_commit_seq ON commit (seq);

-- Query commits by branch (for branch history)
CREATE INDEX idx_commit_branch ON commit (branch);
```

**Column details:**

| Column | Description |
|--------|-------------|
| `hash` | Content hash of the commit's logical content. |
| `seq` | The Lamport clock value assigned to this commit. Matches the `seq` on all facts in this commit. |
| `branch` | Which branch this commit targets. |
| `reads` | JSON object recording the seq of each entity that was read as a precondition for this commit. Used for optimistic concurrency validation (see §03 Commit Model). |
| `created_at` | Wall-clock time for diagnostics. Not used for ordering. |

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
  fork_seq    INTEGER,                       -- Seq at the time of fork
  head_seq    INTEGER NOT NULL DEFAULT 0,    -- Latest seq on this branch
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);

-- Seed the default branch
INSERT OR IGNORE INTO branch (name, head_seq) VALUES ('', 0);
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

CREATE TABLE IF NOT EXISTS commit (
  hash        TEXT    NOT NULL PRIMARY KEY,
  seq     INTEGER NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  reads       JSON,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commit_seq ON commit (seq);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON commit (branch);

CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  branch      TEXT    NOT NULL DEFAULT '',
  seq     INTEGER NOT NULL,
  commit_ref  TEXT    NOT NULL,
  fact_type   TEXT    NOT NULL,
  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_ref) REFERENCES commit(hash)
);
CREATE INDEX IF NOT EXISTS idx_fact_seq    ON fact (seq);
CREATE INDEX IF NOT EXISTS idx_fact_id         ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_seq ON fact (id, seq);
CREATE INDEX IF NOT EXISTS idx_fact_commit     ON fact (commit_ref);
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
  fork_seq    INTEGER,
  head_seq    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, head_seq) VALUES ('', 0);

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
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, :ops_hash, :parent_hash, :branch, :seq, :commit_hash, 'patch');

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
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, :value_hash, :parent_hash, :branch, :seq, :commit_hash, 'set');

-- Step 3: Update the head pointer
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch, :entity_id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, seq = :seq;
```

### 4.4 Write Path — Insert a Delete Fact

```sql
-- Step 1: Insert the fact (value_ref = __empty__ sentinel)
INSERT INTO fact (hash, id, value_ref, parent, branch, seq, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, '__empty__', :parent_hash, :branch, :seq, :commit_hash, 'delete');

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
SELECT f.seq, v.data AS set_value
FROM fact f
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
FROM fact f
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
-- (the latest fact for this entity with seq <= target)
SELECT f.hash, f.fact_type, f.seq, v.data
FROM fact f
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
FROM fact f
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
SELECT COUNT(*) AS patch_count
FROM fact f
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

Old facts can be compacted once a snapshot exists beyond them, since the
snapshot captures the materialized state. However, facts that are referenced as
`parent` by other facts must be retained to preserve causal chain integrity.

```sql
-- Find facts that are safe to compact:
-- facts older than a snapshot, not referenced as parent by any other fact
DELETE FROM fact
WHERE seq < :retention_seq
  AND hash NOT IN (SELECT parent FROM fact WHERE parent IS NOT NULL);
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

---

## 8. Branch Storage

### 8.1 Branch Representation

Branches share the global `fact` table but maintain separate head pointers in
the `head` table. The `branch` table tracks metadata.

When a branch is created:

```sql
-- Record the fork point
INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
VALUES (:branch_name, :parent_branch, :fork_seq, :fork_seq);
```

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

The `commit` row records which branch was written to:

```sql
INSERT INTO commit (hash, seq, branch, reads)
VALUES (:commit_hash, :seq, :branch_name, :reads_json);
```

### 8.3 Branch Seq Numbering

Each branch maintains its own `head_seq` (= `headSeq` in TypeScript) in
the `branch` table. When a commit is applied to a branch, `head_seq` is
set to the commit's global seq number:

```sql
UPDATE branch
SET head_seq = :seq
WHERE name = :branch_name;
```

The Lamport clock (`seq` column on facts and commits) is space-global —
it increases across all branches. The branch's
`head_seq` tracks the latest global seq applied to that branch, ensuring
that seq numbers are globally unique and orderable, even across branches.

### 8.4 Branch Deletion

```sql
-- Remove all head pointers for the branch
DELETE FROM head WHERE branch = :branch_name;

-- Remove all snapshots for the branch
DELETE FROM snapshot WHERE branch = :branch_name;

-- Remove the branch metadata
DELETE FROM branch WHERE name = :branch_name;

-- Facts and commits are NOT deleted — they are shared history
```

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

For point-in-time reads on a branch, the query must consider that the branch
was forked at a specific seq. Facts before the fork seq are inherited
from the parent branch.

```sql
-- Facts for an entity on a branch (including inherited pre-fork facts)
SELECT f.hash, f.fact_type, f.seq, v.data
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.seq <= :target_seq
  AND (
    -- Facts committed on this branch
    f.branch = :branch_name
    OR
    -- Facts from before the fork point (inherited)
    f.seq <= (SELECT fork_seq FROM branch WHERE name = :branch_name)
  )
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
