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

---

## 3. Tables

### 3.1 `blob` — Content-Addressed Value Storage

Stores the serialized JSON content of entity values (both full values and patch
operation lists). This is the equivalent of v1's `datum` table, renamed for
clarity. Every distinct JSON value is stored once; facts reference blobs by
hash.

```sql
CREATE TABLE blob (
  hash  TEXT NOT NULL PRIMARY KEY,  -- Merkle reference of the JSON content
  data  JSON                        -- Serialized JSON (NULL for the "empty" sentinel)
);

-- Sentinel row for deleted/empty values (replaces v1's "undefined" record)
INSERT OR IGNORE INTO blob (hash, data) VALUES ('__empty__', NULL);
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
  value_ref   TEXT    NOT NULL,              -- FK → blob.hash (value or patch ops)
  parent      TEXT,                          -- Hash of previous fact (NULL for first write)
  version     INTEGER NOT NULL,             -- Lamport clock at commit time
  commit_ref  TEXT    NOT NULL,             -- FK → commit.hash
  fact_type   TEXT    NOT NULL,             -- 'set' | 'patch' | 'delete'

  FOREIGN KEY (value_ref)  REFERENCES blob(hash),
  FOREIGN KEY (commit_ref) REFERENCES commit(hash)
);

-- Query facts by version range (for subscriptions and point-in-time reads)
CREATE INDEX idx_fact_version ON fact (version);

-- Query all facts for a specific entity (for causal chain traversal)
CREATE INDEX idx_fact_id ON fact (id);

-- Query facts by entity and version (for point-in-time entity reads)
CREATE INDEX idx_fact_id_version ON fact (id, version);

-- Query facts by commit (for commit inspection)
CREATE INDEX idx_fact_commit ON fact (commit_ref);
```

**Column details:**

| Column | Description |
|--------|-------------|
| `hash` | Content hash of `{type, id, value/ops, parent}`. Immutable identity. |
| `id` | The entity this fact is about. URI format. |
| `value_ref` | Points to the blob table. For `set`: the full JSON value. For `patch`: the JSON-serialized patch operation list. For `delete`: the `__empty__` sentinel. |
| `parent` | Hash of the previous fact for this entity. `NULL` when this is the entity's first fact (parent is the Empty reference, which is implicit). |
| `version` | Space-global Lamport clock, assigned at commit time. All facts in the same commit share the same version. |
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
  version     INTEGER NOT NULL,             -- Lamport clock (same as facts in this commit)
  branch      TEXT    NOT NULL DEFAULT '',   -- Branch this commit was applied to
  reads       JSON,                         -- Read set: {entityId: version} for validation
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))  -- Wall-clock timestamp
);

-- Query commits by version (for log traversal)
CREATE INDEX idx_commit_version ON commit (version);

-- Query commits by branch (for branch history)
CREATE INDEX idx_commit_branch ON commit (branch);
```

**Column details:**

| Column | Description |
|--------|-------------|
| `hash` | Content hash of the commit's logical content. |
| `version` | The Lamport clock value assigned to this commit. Matches the `version` on all facts in this commit. |
| `branch` | Which branch this commit targets. |
| `reads` | JSON object recording the version of each entity that was read as a precondition for this commit. Used for optimistic concurrency validation (see §03 Commit Model). |
| `created_at` | Wall-clock time for diagnostics. Not used for ordering. |

### 3.5 `snapshot` — Periodic Full-Value Materializations

Stores pre-computed full values for entities at specific versions, enabling
fast reads without full patch replay.

```sql
CREATE TABLE snapshot (
  id         TEXT    NOT NULL,    -- Entity identifier
  version    INTEGER NOT NULL,    -- Version at which this snapshot was taken
  value_ref  TEXT    NOT NULL,    -- FK → blob.hash (the full materialized value)
  branch     TEXT    NOT NULL DEFAULT '',  -- Branch this snapshot belongs to

  PRIMARY KEY (branch, id, version),
  FOREIGN KEY (value_ref) REFERENCES blob(hash)
);

-- Find the nearest snapshot before a target version
CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, version);
```

### 3.6 `branch` — Branch Metadata

Tracks branch lifecycle and fork points.

```sql
CREATE TABLE branch (
  name            TEXT    NOT NULL PRIMARY KEY,  -- Branch name ('' = default/main)
  parent_branch   TEXT,                          -- Branch this was forked from (NULL for default)
  fork_version    INTEGER,                       -- Version at the time of fork
  head_version    INTEGER NOT NULL DEFAULT 0,    -- Latest version on this branch
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);

-- Seed the default branch
INSERT OR IGNORE INTO branch (name, head_version) VALUES ('', 0);
```

### 3.7 `blob_store` — Immutable Content-Addressed Binary Data

Stores raw binary blobs (images, files, compiled code). This is distinct from
the `blob` table, which stores JSON values. The `blob_store` table holds
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

- Two separate tables (`blob` for JSON, `blob_store` for binary) avoids
  conflating serialized JSON with raw bytes.
- Binary blobs are never modified or deleted (content-addressed and immutable).
- The `hash` column uses the same SHA-256 algorithm but applied to raw bytes
  rather than the merkle-tree encoding used for JSON values.

### 3.8 Full Initialization Script

The complete schema is applied as a single transaction when creating a new
database:

```sql
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS blob (
  hash  TEXT NOT NULL PRIMARY KEY,
  data  JSON
);
INSERT OR IGNORE INTO blob (hash, data) VALUES ('__empty__', NULL);

CREATE TABLE IF NOT EXISTS commit (
  hash        TEXT    NOT NULL PRIMARY KEY,
  version     INTEGER NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  reads       JSON,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commit_version ON commit (version);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON commit (branch);

CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  version     INTEGER NOT NULL,
  commit_ref  TEXT    NOT NULL,
  fact_type   TEXT    NOT NULL,
  FOREIGN KEY (value_ref)  REFERENCES blob(hash),
  FOREIGN KEY (commit_ref) REFERENCES commit(hash)
);
CREATE INDEX IF NOT EXISTS idx_fact_version    ON fact (version);
CREATE INDEX IF NOT EXISTS idx_fact_id         ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_version ON fact (id, version);
CREATE INDEX IF NOT EXISTS idx_fact_commit     ON fact (commit_ref);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT NOT NULL,
  id        TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  PRIMARY KEY (branch, id),
  FOREIGN KEY (fact_hash) REFERENCES fact(hash)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  id         TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  value_ref  TEXT    NOT NULL,
  branch     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (branch, id, version),
  FOREIGN KEY (value_ref) REFERENCES blob(hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, version);

CREATE TABLE IF NOT EXISTS branch (
  name            TEXT    NOT NULL PRIMARY KEY,
  parent_branch   TEXT,
  fork_version    INTEGER,
  head_version    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, head_version) VALUES ('', 0);

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

COMMIT;
```

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

3. Inserts the serialized ops into the `blob` table (deduplicated by hash).

4. Inserts a fact row with `fact_type = 'patch'` and `value_ref` pointing to
   the blob containing the ops.

A `set` write works the same way except the blob contains the complete JSON
value and `fact_type = 'set'`.

A `delete` sets `value_ref` to the `__empty__` sentinel and `fact_type = 'delete'`.

### 4.2 Write Path — Insert a Patch Fact

```sql
-- Step 1: Insert the patch ops blob (deduplicated)
INSERT OR IGNORE INTO blob (hash, data)
VALUES (:ops_hash, :ops_json);

-- Step 2: Insert the fact
INSERT INTO fact (hash, id, value_ref, parent, version, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, :ops_hash, :parent_hash, :version, :commit_hash, 'patch');

-- Step 3: Update (or insert) the head pointer
INSERT INTO head (branch, id, fact_hash)
VALUES (:branch, :entity_id, :fact_hash)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash;
```

### 4.3 Write Path — Insert a Set Fact

```sql
-- Step 1: Insert the value blob (deduplicated)
INSERT OR IGNORE INTO blob (hash, data)
VALUES (:value_hash, :value_json);

-- Step 2: Insert the fact
INSERT INTO fact (hash, id, value_ref, parent, version, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, :value_hash, :parent_hash, :version, :commit_hash, 'set');

-- Step 3: Update the head pointer
INSERT INTO head (branch, id, fact_hash)
VALUES (:branch, :entity_id, :fact_hash)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash;
```

### 4.4 Write Path — Insert a Delete Fact

```sql
-- Step 1: Insert the fact (value_ref = __empty__ sentinel)
INSERT INTO fact (hash, id, value_ref, parent, version, commit_ref, fact_type)
VALUES (:fact_hash, :entity_id, '__empty__', :parent_hash, :version, :commit_hash, 'delete');

-- Step 2: Update the head pointer to the delete fact
INSERT INTO head (branch, id, fact_hash)
VALUES (:branch, :entity_id, :fact_hash)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash;
```

---

## 5. Read Path

### 5.1 Read Current Value

To read an entity's current value on a branch:

```sql
-- Step 1: Find the current head fact
SELECT f.fact_type, f.version, b.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN blob b ON b.hash = f.value_ref
WHERE h.branch = :branch AND h.id = :entity_id;
```

If `fact_type = 'set'`, the `data` column contains the full value. Done.

If `fact_type = 'delete'`, the entity is deleted. Return `null`.

If `fact_type = 'patch'`, we need to find a base value and replay:

```sql
-- Step 2: Find the nearest snapshot
SELECT s.version, b.data AS snapshot_value
FROM snapshot s
JOIN blob b ON b.hash = s.value_ref
WHERE s.branch = :branch
  AND s.id = :entity_id
  AND s.version <= :head_version
ORDER BY s.version DESC
LIMIT 1;
```

```sql
-- Step 3: If no snapshot, find the most recent 'set' fact
SELECT f.version, b.data AS set_value
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'set'
  AND f.version <= :head_version
ORDER BY f.version DESC
LIMIT 1;
```

```sql
-- Step 4: Collect all patches between base and head
SELECT b.data AS patch_ops, f.version
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'patch'
  AND f.version > :base_version
  AND f.version <= :head_version
ORDER BY f.version ASC;
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
  const snapshot = findNearestSnapshot(branch, entityId, head.version);
  const baseVersion = snapshot?.version ?? findLatestSet(entityId, head.version)?.version ?? 0;
  const baseValue = snapshot?.value ?? findLatestSet(entityId, head.version)?.value ?? {};

  const patches = collectPatches(entityId, baseVersion, head.version);
  let value = baseValue;
  for (const patch of patches) {
    value = applyPatch(value, JSON.parse(patch.ops));
  }
  return value;
}
```

### 5.2 Point-in-Time Read

Read an entity's value at a specific version on a branch:

```sql
-- Find the fact that was the head at the target version
-- (the latest fact for this entity with version <= target)
SELECT f.hash, f.fact_type, f.version, b.data
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.version <= :target_version
ORDER BY f.version DESC
LIMIT 1;
```

If the result is a `set`, return the value directly. If it's a `delete`, return
`null`. If it's a `patch`, find the nearest snapshot or `set` before
`:target_version` and replay patches up to `:target_version` using the same
algorithm as §5.1 but with `target_version` as the upper bound.

```sql
-- Snapshot lookup for PIT read
SELECT s.version, b.data AS snapshot_value
FROM snapshot s
JOIN blob b ON b.hash = s.value_ref
WHERE s.branch = :branch
  AND s.id = :entity_id
  AND s.version <= :target_version
ORDER BY s.version DESC
LIMIT 1;

-- Patches between snapshot and target
SELECT b.data AS patch_ops, f.version
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.fact_type = 'patch'
  AND f.version > :snapshot_version
  AND f.version <= :target_version
ORDER BY f.version ASC;
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
  AND f.version > COALESCE(
    (SELECT MAX(s.version) FROM snapshot s
     WHERE s.branch = :branch AND s.id = :entity_id),
    0
  );
```

If `patch_count >= :snapshot_interval` (default 10), create a snapshot.

### 6.2 Snapshot Materialization

To create a snapshot, read the entity's current value using the standard read
path (§5.1), then store it:

```sql
-- Step 1: Store the materialized value as a blob
INSERT OR IGNORE INTO blob (hash, data)
VALUES (:value_hash, :value_json);

-- Step 2: Insert the snapshot record
INSERT OR REPLACE INTO snapshot (id, version, value_ref, branch)
VALUES (:entity_id, :version, :value_hash, :branch);
```

### 6.3 Snapshot Compaction

Old snapshots can be removed to reclaim space. Only the most recent snapshot per
entity per branch is needed for efficient reads. A compaction query:

```sql
-- Keep only the latest snapshot per entity per branch
DELETE FROM snapshot
WHERE rowid NOT IN (
  SELECT rowid FROM snapshot s1
  WHERE s1.version = (
    SELECT MAX(s2.version) FROM snapshot s2
    WHERE s2.branch = s1.branch AND s2.id = s1.id
  )
);
```

In practice, keeping a few historical snapshots can speed up point-in-time reads
for popular versions.

---

## 7. Branch Storage

### 7.1 Branch Representation

Branches share the global `fact` table but maintain separate head pointers in
the `head` table. The `branch` table tracks metadata.

When a branch is created:

```sql
-- Record the fork point
INSERT INTO branch (name, parent_branch, fork_version, head_version)
VALUES (:branch_name, :parent_branch, :fork_version, :fork_version);

-- Copy all head pointers from the parent branch at the fork version
INSERT INTO head (branch, id, fact_hash)
SELECT :branch_name, h.id, h.fact_hash
FROM head h
WHERE h.branch = :parent_branch;
```

### 7.2 Branch Writes

Writing to a branch is identical to writing to the default branch — the same
fact and blob insertion, but the head update targets the branch name:

```sql
INSERT INTO head (branch, id, fact_hash)
VALUES (:branch_name, :entity_id, :fact_hash)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash;
```

The `commit` row records which branch was written to:

```sql
INSERT INTO commit (hash, version, branch, reads)
VALUES (:commit_hash, :version, :branch_name, :reads_json);
```

### 7.3 Branch Version Numbering

Each branch maintains its own `head_version` in the `branch` table. When a
commit is applied to a branch, `head_version` is incremented:

```sql
UPDATE branch
SET head_version = head_version + 1
WHERE name = :branch_name;
```

The Lamport clock (`version` on facts and commits) is still space-global — it
increases across all branches. This ensures that version numbers are globally
unique and orderable, even across branches.

### 7.4 Branch Deletion

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

## 8. Point-in-Time Read Implementation

Point-in-time reads combine fact lookup and snapshot-based reconstruction.

### 8.1 Algorithm

```typescript
function readAtVersion(
  branch: string,
  entityId: EntityId,
  targetVersion: number,
): JSONValue | null {
  // 1. Find the latest fact for this entity at or before targetVersion
  const latestFact = findFactAtVersion(entityId, targetVersion);
  if (!latestFact) return null;  // Entity didn't exist at this version

  // 2. If it's a delete, entity was deleted at this version
  if (latestFact.factType === "delete") return null;

  // 3. If it's a set, return the value directly
  if (latestFact.factType === "set") {
    return JSON.parse(latestFact.data);
  }

  // 4. It's a patch — find nearest snapshot ≤ targetVersion
  const snapshot = findNearestSnapshot(branch, entityId, targetVersion);

  // 5. If no snapshot, find the latest set ≤ targetVersion
  const baseSet = snapshot
    ? null
    : findLatestSetBefore(entityId, targetVersion);

  const baseVersion = snapshot?.version ?? baseSet?.version ?? 0;
  const baseValue = snapshot?.value ?? baseSet?.value ?? {};

  // 6. Collect and apply patches from baseVersion to targetVersion
  const patches = collectPatches(entityId, baseVersion, targetVersion);
  let value = baseValue;
  for (const patch of patches) {
    value = applyPatch(value, JSON.parse(patch.ops));
  }
  return value;
}
```

### 8.2 Branch-Aware PIT Reads

For point-in-time reads on a branch, the query must consider that the branch
was forked at a specific version. Facts before the fork version are inherited
from the parent branch.

```sql
-- Facts for an entity on a branch (including inherited pre-fork facts)
SELECT f.hash, f.fact_type, f.version, b.data
FROM fact f
JOIN blob b ON b.hash = f.value_ref
WHERE f.id = :entity_id
  AND f.version <= :target_version
  AND (
    -- Facts committed on this branch
    f.commit_ref IN (SELECT hash FROM commit WHERE branch = :branch_name)
    OR
    -- Facts from before the fork point (inherited)
    f.version <= (SELECT fork_version FROM branch WHERE name = :branch_name)
  )
ORDER BY f.version DESC
LIMIT 1;
```

---

## 9. Blob Store Operations

### 9.1 Write a Blob

```sql
-- Content-addressed: INSERT OR IGNORE deduplicates automatically
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size);
```

### 9.2 Read a Blob

```sql
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash;
```

### 9.3 Blob Metadata

Blob metadata is stored as a regular entity (see §01 Data Model, section 5).
The metadata entity id is derived from the blob hash:

```
urn:blob-meta:<blob_hash>
```

Reading and writing blob metadata uses the standard entity read/write paths.

---

## 10. Migration

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
