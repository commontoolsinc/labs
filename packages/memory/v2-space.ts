/**
 * Memory v2 SQLite Storage Engine
 *
 * Implements the v2 database schema, read/write operations, and space
 * lifecycle management. Each space maps to a single SQLite database
 * (file-backed or in-memory).
 *
 * @see spec 02-storage.md
 * @module v2-space
 */

import { Database, type Statement } from "@db/sqlite";
import type { EntityId, JSONValue } from "./v2-types.ts";
// Reference helpers used by v2-commit.ts via V2Space methods
import { applyPatch } from "./v2-patch.ts";
import type { PatchOp } from "./v2-types.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PREPARE = `
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS value (
  hash  TEXT NOT NULL PRIMARY KEY,
  data  JSON
);
INSERT OR IGNORE INTO value (hash, data) VALUES ('__empty__', NULL);

CREATE TABLE IF NOT EXISTS "commit" (
  hash        TEXT    NOT NULL PRIMARY KEY,
  version     INTEGER NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  reads       JSON,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commit_version ON "commit" (version);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON "commit" (branch);

CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  branch      TEXT    NOT NULL DEFAULT '',
  version     INTEGER NOT NULL,
  commit_ref  TEXT    NOT NULL,
  fact_type   TEXT    NOT NULL,
  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_ref) REFERENCES "commit"(hash)
);
CREATE INDEX IF NOT EXISTS idx_fact_version    ON fact (version);
CREATE INDEX IF NOT EXISTS idx_fact_id         ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_version ON fact (id, version);
CREATE INDEX IF NOT EXISTS idx_fact_commit     ON fact (commit_ref);
CREATE INDEX IF NOT EXISTS idx_fact_branch     ON fact (branch);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  fact_hash TEXT    NOT NULL,
  version   INTEGER NOT NULL,
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
  FOREIGN KEY (value_ref) REFERENCES value(hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, version);

CREATE TABLE IF NOT EXISTS branch (
  name            TEXT    NOT NULL PRIMARY KEY,
  parent_branch   TEXT,
  fork_version    INTEGER,
  head_version    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
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
`;

const STATE_VIEW = `
CREATE VIEW IF NOT EXISTS state AS
SELECT h.branch, h.id, f.fact_type, f.version, v.data AS value
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref;
`;

// Pragmas applied to every database connection
const PRAGMAS = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  PRAGMA cache_size=-64000;
  PRAGMA temp_store=MEMORY;
  PRAGMA mmap_size=268435456;
  PRAGMA foreign_keys=ON;
`;

// Must be set before database has any content (new DBs only)
const NEW_DB_PRAGMAS = `
  PRAGMA page_size=32768;
`;

// ---------------------------------------------------------------------------
// SQL Queries
// ---------------------------------------------------------------------------

const READ_HEAD = `
SELECT h.fact_hash, h.version, f.fact_type
FROM head h
JOIN fact f ON f.hash = h.fact_hash
WHERE h.branch = ? AND h.id = ?;
`;

const READ_HEAD_VALUE = `
SELECT f.fact_type, f.version, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = ? AND h.id = ?;
`;

const FIND_NEAREST_SNAPSHOT = `
SELECT s.version, v.data AS snapshot_value
FROM snapshot s
JOIN value v ON v.hash = s.value_ref
WHERE s.branch = ?
  AND s.id = ?
  AND s.version <= ?
ORDER BY s.version DESC
LIMIT 1;
`;

const FIND_LATEST_SET = `
SELECT f.version, v.data AS set_value
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = ?
  AND f.fact_type = 'set'
  AND f.version <= ?
ORDER BY f.version DESC
LIMIT 1;
`;

const COLLECT_PATCHES = `
SELECT v.data AS patch_ops, f.version
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = ?
  AND f.fact_type = 'patch'
  AND f.version > ?
  AND f.version <= ?
ORDER BY f.version ASC;
`;

const FIND_FACT_AT_VERSION = `
SELECT f.hash, f.fact_type, f.version, v.data
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.id = ?
  AND f.version <= ?
ORDER BY f.version DESC
LIMIT 1;
`;

const INSERT_VALUE = `
INSERT OR IGNORE INTO value (hash, data) VALUES (?, ?);
`;

const INSERT_FACT = `
INSERT INTO fact (hash, id, value_ref, parent, branch, version, commit_ref, fact_type)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);
`;

const UPSERT_HEAD = `
INSERT INTO head (branch, id, fact_hash, version)
VALUES (?, ?, ?, ?)
ON CONFLICT (branch, id) DO UPDATE SET fact_hash = excluded.fact_hash, version = excluded.version;
`;

const INSERT_COMMIT = `
INSERT INTO "commit" (hash, version, branch, reads)
VALUES (?, ?, ?, ?);
`;

const GET_BRANCH_HEAD_VERSION = `
SELECT head_version FROM branch WHERE name = ?;
`;

const GET_MAX_VERSION = `
SELECT COALESCE(MAX(head_version), 0) AS max_version FROM branch;
`;

const UPDATE_BRANCH_HEAD_VERSION = `
UPDATE branch SET head_version = ? WHERE name = ?;
`;

const INSERT_SNAPSHOT = `
INSERT OR REPLACE INTO snapshot (id, version, value_ref, branch)
VALUES (?, ?, ?, ?);
`;

const GET_BRANCH = `
SELECT name, parent_branch, fork_version, head_version, created_at, deleted_at
FROM branch WHERE name = ?;
`;

const CREATE_BRANCH = `
INSERT INTO branch (name, parent_branch, fork_version, head_version)
VALUES (?, ?, ?, ?);
`;

const SOFT_DELETE_BRANCH = `
UPDATE branch SET deleted_at = datetime('now') WHERE name = ? AND deleted_at IS NULL;
`;

const LIST_ACTIVE_BRANCHES = `
SELECT name, parent_branch, fork_version, head_version, created_at, deleted_at
FROM branch WHERE deleted_at IS NULL ORDER BY created_at;
`;

const LIST_ALL_BRANCHES = `
SELECT name, parent_branch, fork_version, head_version, created_at, deleted_at
FROM branch ORDER BY created_at;
`;

const READ_HEAD_AT_VERSION = `
SELECT h.fact_hash, h.version, f.fact_type
FROM head h
JOIN fact f ON f.hash = h.fact_hash
WHERE h.branch = ? AND h.id = ? AND h.version <= ?;
`;

const FIND_LATEST_FACT_ON_BRANCH = `
SELECT f.hash AS fact_hash, f.version, f.fact_type
FROM fact f
WHERE f.id = ? AND f.branch = ? AND f.version <= ?
ORDER BY f.version DESC
LIMIT 1;
`;

const FIND_MODIFIED_ENTITIES = `
SELECT DISTINCT id, fact_hash, version FROM head
WHERE branch = ? AND version > ?;
`;

// ---------------------------------------------------------------------------
// Prepared Statement Cache
// ---------------------------------------------------------------------------

type PreparedStatements = {
  readHead?: Statement;
  readHeadValue?: Statement;
  findNearestSnapshot?: Statement;
  findLatestSet?: Statement;
  collectPatches?: Statement;
  findFactAtVersion?: Statement;
  insertValue?: Statement;
  insertFact?: Statement;
  upsertHead?: Statement;
  insertCommit?: Statement;
  getBranchHeadVersion?: Statement;
  updateBranchHeadVersion?: Statement;
  insertSnapshot?: Statement;
  getBranch?: Statement;
  createBranch?: Statement;
  softDeleteBranch?: Statement;
  listActiveBranches?: Statement;
  listAllBranches?: Statement;
  readHeadAtVersion?: Statement;
  findLatestFactOnBranch?: Statement;
  findModifiedEntities?: Statement;
  getMaxVersion?: Statement;
};

const preparedStatementsCache = new WeakMap<Database, PreparedStatements>();

function getStmt(
  db: Database,
  key: keyof PreparedStatements,
  sql: string,
): Statement {
  let cache = preparedStatementsCache.get(db);
  if (!cache) {
    cache = {};
    preparedStatementsCache.set(db, cache);
  }
  if (!cache[key]) {
    cache[key] = db.prepare(sql);
  }
  return cache[key]!;
}

function finalizePreparedStatements(db: Database): void {
  const cache = preparedStatementsCache.get(db);
  if (cache) {
    for (const stmt of Object.values(cache)) {
      if (stmt) {
        try {
          stmt.finalize();
        } catch {
          // Ignore errors during finalization
        }
      }
    }
    preparedStatementsCache.delete(db);
  }
}

// ---------------------------------------------------------------------------
// V2Session / V2Space
// ---------------------------------------------------------------------------

export interface V2Session {
  subject: string;
  store: Database;
}

/**
 * Reconstructs a value when the head fact is a patch. Finds the nearest
 * snapshot or latest set, then replays patches in version order.
 */
function reconstructFromPatches(
  store: Database,
  branch: string,
  entityId: EntityId,
  headVersion: number,
): JSONValue | null {
  // Find nearest snapshot
  const snapStmt = getStmt(store, "findNearestSnapshot", FIND_NEAREST_SNAPSHOT);
  const snapRow = snapStmt.get(branch, entityId, headVersion) as
    | { version: number; snapshot_value: string | null }
    | undefined;

  let baseVersion: number;
  let baseValue: JSONValue;

  if (snapRow && snapRow.snapshot_value !== null) {
    baseVersion = snapRow.version;
    baseValue = JSON.parse(snapRow.snapshot_value);
  } else {
    // Find the latest set
    const setStmt = getStmt(store, "findLatestSet", FIND_LATEST_SET);
    const setRow = setStmt.get(entityId, headVersion) as
      | { version: number; set_value: string | null }
      | undefined;

    if (setRow && setRow.set_value !== null) {
      baseVersion = setRow.version;
      baseValue = JSON.parse(setRow.set_value);
    } else {
      // No base value found — start from empty object
      baseVersion = 0;
      baseValue = {};
    }
  }

  // Collect and apply patches
  const patchStmt = getStmt(store, "collectPatches", COLLECT_PATCHES);
  const patchRows = patchStmt.all(entityId, baseVersion, headVersion) as Array<{
    patch_ops: string;
    version: number;
  }>;

  let value = baseValue;
  for (const row of patchRows) {
    const ops = JSON.parse(row.patch_ops) as PatchOp[];
    value = applyPatch(value, ops);
  }
  return value;
}

export class V2Space implements V2Session {
  constructor(public subject: string, public store: Database) {}

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Read the current value of an entity on a branch.
   *
   * @see spec 02-storage.md §5.1
   */
  readEntity(branch: string, entityId: EntityId): JSONValue | null {
    const stmt = getStmt(this.store, "readHeadValue", READ_HEAD_VALUE);
    const row = stmt.get(branch, entityId) as
      | { fact_type: string; version: number; data: string | null }
      | undefined;

    if (!row) return null; // Never written

    if (row.fact_type === "delete") return null;

    if (row.fact_type === "set") {
      return row.data !== null ? JSON.parse(row.data) : null;
    }

    // patch — reconstruct
    return reconstructFromPatches(this.store, branch, entityId, row.version);
  }

  /**
   * Read the head pointer for an entity on a branch.
   */
  readHead(
    branch: string,
    entityId: EntityId,
  ): { factHash: string; version: number; factType: string } | null {
    const stmt = getStmt(this.store, "readHead", READ_HEAD);
    const row = stmt.get(branch, entityId) as
      | { fact_hash: string; version: number; fact_type: string }
      | undefined;

    if (!row) return null;
    return {
      factHash: row.fact_hash,
      version: row.version,
      factType: row.fact_type,
    };
  }

  /**
   * Read an entity's value at a specific version.
   *
   * @see spec 02-storage.md §5.2, §9
   */
  readAtVersion(
    branch: string,
    entityId: EntityId,
    targetVersion: number,
  ): JSONValue | null {
    const stmt = getStmt(this.store, "findFactAtVersion", FIND_FACT_AT_VERSION);
    const row = stmt.get(entityId, targetVersion) as
      | {
        hash: string;
        fact_type: string;
        version: number;
        data: string | null;
      }
      | undefined;

    if (!row) return null; // Entity didn't exist at this version

    if (row.fact_type === "delete") return null;

    if (row.fact_type === "set") {
      return row.data !== null ? JSON.parse(row.data) : null;
    }

    // patch — reconstruct up to targetVersion
    return reconstructFromPatches(this.store, branch, entityId, targetVersion);
  }

  // -------------------------------------------------------------------------
  // Write operations (used by v2-commit.ts)
  // -------------------------------------------------------------------------

  insertValue(hash: string, data: string): void {
    const stmt = getStmt(this.store, "insertValue", INSERT_VALUE);
    stmt.run(hash, data);
  }

  insertFact(params: {
    hash: string;
    id: EntityId;
    valueRef: string;
    parent: string | null;
    branch: string;
    version: number;
    commitRef: string;
    factType: string;
  }): void {
    const stmt = getStmt(this.store, "insertFact", INSERT_FACT);
    stmt.run(
      params.hash,
      params.id,
      params.valueRef,
      params.parent,
      params.branch,
      params.version,
      params.commitRef,
      params.factType,
    );
  }

  updateHead(
    branch: string,
    entityId: EntityId,
    factHash: string,
    version: number,
  ): void {
    const stmt = getStmt(this.store, "upsertHead", UPSERT_HEAD);
    stmt.run(branch, entityId, factHash, version);
  }

  insertCommit(
    hash: string,
    version: number,
    branch: string,
    reads: string | null,
  ): void {
    const stmt = getStmt(this.store, "insertCommit", INSERT_COMMIT);
    stmt.run(hash, version, branch, reads);
  }

  insertSnapshot(
    entityId: EntityId,
    version: number,
    valueRef: string,
    branch: string,
  ): void {
    const stmt = getStmt(this.store, "insertSnapshot", INSERT_SNAPSHOT);
    stmt.run(entityId, version, valueRef, branch);
  }

  // -------------------------------------------------------------------------
  // Version management
  // -------------------------------------------------------------------------

  /**
   * Get the next version number (space-global Lamport clock).
   * Returns the max version across ALL branches + 1.
   */
  nextVersion(_branch: string): number {
    const stmt = getStmt(this.store, "getMaxVersion", GET_MAX_VERSION);
    const row = stmt.get() as { max_version: number };
    return row.max_version + 1;
  }

  /**
   * Update the branch's head_version after a commit.
   */
  updateBranchHeadVersion(branch: string, version: number): void {
    const stmt = getStmt(
      this.store,
      "updateBranchHeadVersion",
      UPDATE_BRANCH_HEAD_VERSION,
    );
    stmt.run(version, branch);
  }

  // -------------------------------------------------------------------------
  // Branch operations
  // -------------------------------------------------------------------------

  /**
   * Get branch metadata by name.
   */
  getBranch(name: string): {
    name: string;
    parentBranch: string | null;
    forkVersion: number | null;
    headVersion: number;
    createdAt: string;
    deletedAt: string | null;
  } | null {
    const stmt = getStmt(this.store, "getBranch", GET_BRANCH);
    const row = stmt.get(name) as {
      name: string;
      parent_branch: string | null;
      fork_version: number | null;
      head_version: number;
      created_at: string;
      deleted_at: string | null;
    } | undefined;

    if (!row) return null;
    return {
      name: row.name,
      parentBranch: row.parent_branch,
      forkVersion: row.fork_version,
      headVersion: row.head_version,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    };
  }

  /**
   * Create a new branch record.
   */
  createBranchRecord(
    name: string,
    parentBranch: string,
    forkVersion: number,
    headVersion: number,
  ): void {
    const stmt = getStmt(this.store, "createBranch", CREATE_BRANCH);
    stmt.run(name, parentBranch, forkVersion, headVersion);
  }

  /**
   * Soft-delete a branch by setting deleted_at.
   */
  softDeleteBranch(name: string): boolean {
    const stmt = getStmt(this.store, "softDeleteBranch", SOFT_DELETE_BRANCH);
    stmt.run(name);
    return this.store.changes > 0;
  }

  /**
   * List branches.
   */
  listBranches(includeDeleted = false): Array<{
    name: string;
    parentBranch: string | null;
    forkVersion: number | null;
    headVersion: number;
    createdAt: string;
    deletedAt: string | null;
  }> {
    const sql = includeDeleted ? LIST_ALL_BRANCHES : LIST_ACTIVE_BRANCHES;
    const key = includeDeleted ? "listAllBranches" : "listActiveBranches";
    const stmt = getStmt(this.store, key, sql);
    const rows = stmt.all() as Array<{
      name: string;
      parent_branch: string | null;
      fork_version: number | null;
      head_version: number;
      created_at: string;
      deleted_at: string | null;
    }>;
    return rows.map((r) => ({
      name: r.name,
      parentBranch: r.parent_branch,
      forkVersion: r.fork_version,
      headVersion: r.head_version,
      createdAt: r.created_at,
      deletedAt: r.deleted_at,
    }));
  }

  /**
   * Read a head entry with a version constraint (for parent chain resolution).
   */
  readHeadAtVersion(
    branch: string,
    entityId: EntityId,
    maxVersion: number,
  ): { factHash: string; version: number; factType: string } | null {
    const stmt = getStmt(this.store, "readHeadAtVersion", READ_HEAD_AT_VERSION);
    const row = stmt.get(branch, entityId, maxVersion) as
      | { fact_hash: string; version: number; fact_type: string }
      | undefined;
    if (!row) return null;
    return {
      factHash: row.fact_hash,
      version: row.version,
      factType: row.fact_type,
    };
  }

  /**
   * Find the latest fact for an entity on a specific branch up to a version.
   * Used for parent chain head resolution when the head table has been updated
   * past the fork point.
   */
  findLatestFactOnBranch(
    entityId: EntityId,
    branch: string,
    maxVersion: number,
  ): { factHash: string; version: number; factType: string } | null {
    const stmt = getStmt(
      this.store,
      "findLatestFactOnBranch",
      FIND_LATEST_FACT_ON_BRANCH,
    );
    const row = stmt.get(entityId, branch, maxVersion) as
      | { fact_hash: string; version: number; fact_type: string }
      | undefined;
    if (!row) return null;
    return {
      factHash: row.fact_hash,
      version: row.version,
      factType: row.fact_type,
    };
  }

  /**
   * Find all entities modified on a branch since a given version.
   */
  findModifiedEntities(
    branch: string,
    sinceVersion: number,
  ): Array<{ id: EntityId; factHash: string; version: number }> {
    const stmt = getStmt(
      this.store,
      "findModifiedEntities",
      FIND_MODIFIED_ENTITIES,
    );
    const rows = stmt.all(branch, sinceVersion) as Array<{
      id: string;
      fact_hash: string;
      version: number;
    }>;
    return rows.map((r) => ({
      id: r.id as EntityId,
      factHash: r.fact_hash,
      version: r.version,
    }));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    finalizePreparedStatements(this.store);
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// Open / Connect / Close
// ---------------------------------------------------------------------------

/**
 * Parse a space URL into a subject DID and database address.
 *
 * Supports:
 *   file:///path/to/<did>.sqlite  → file-backed
 *   memory:<did>                  → in-memory
 */
function parseSpaceUrl(url: URL): { subject: string; address: URL | null } {
  const { pathname } = url;
  const base = pathname.split("/").pop() as string;
  const did = base.endsWith(".sqlite")
    ? base.slice(0, -".sqlite".length)
    : base;

  return {
    address: url.protocol === "file:" ? url : null,
    subject: did,
  };
}

/**
 * Open a v2 space database, creating it if it doesn't exist.
 */
export function openV2Space(url: URL): V2Space {
  const { subject, address } = parseSpaceUrl(url);
  const db = new Database(address ?? ":memory:", { create: true });
  db.exec(NEW_DB_PRAGMAS);
  db.exec(PRAGMAS);
  db.exec(PREPARE);
  db.exec(STATE_VIEW);
  return new V2Space(subject, db);
}

/**
 * Connect to an existing v2 space database.
 */
export function connectV2Space(url: URL): V2Space {
  const { subject, address } = parseSpaceUrl(url);
  const db = new Database(address ?? ":memory:", { create: false });
  db.exec(PRAGMAS);
  db.exec(PREPARE);
  db.exec(STATE_VIEW);
  return new V2Space(subject, db);
}

/**
 * Close a v2 space, cleaning up prepared statements and the database handle.
 */
export function closeV2Space(space: V2Space): void {
  space.close();
}
