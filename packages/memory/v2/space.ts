/**
 * Memory v2 Storage Engine
 *
 * SQLite-based storage engine implementing the v2 schema from spec §02.
 * Each space gets its own database file with tables for values, facts,
 * heads, commits, snapshots, branches, and blobs.
 */

import { Database, type Statement } from "@db/sqlite";
import { refer } from "../reference.ts";
import { applyPatch } from "./patch.ts";
import {
  EMPTY_VALUE_HASH,
  emptyRef,
  fromString,
  hashCommit,
  hashFact,
  refToString,
} from "./reference.ts";
import type {
  BranchRow,
  ClientCommit,
  Commit,
  ConflictDetail,
  Delete,
  EntityId,
  FactEntry,
  FactSet,
  HeadRow,
  JSONValue,
  Operation,
  PatchOp,
  PatchWrite,
  Reference,
  Selector,
  SetWrite,
  StoredFact,
  ValidationResult,
} from "./types.ts";
import { DEFAULT_BRANCH } from "./types.ts";

// ─── SQL Schema ──────────────────────────────────────────────────────────────

const PRAGMAS = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  PRAGMA cache_size=-64000;
  PRAGMA temp_store=MEMORY;
  PRAGMA mmap_size=268435456;
  PRAGMA foreign_keys=ON;
`;

const NEW_DB_PRAGMAS = `
  PRAGMA page_size=32768;
`;

const SCHEMA = `
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
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, head_version) VALUES ('', 0);

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

CREATE VIEW IF NOT EXISTS state AS
SELECT h.branch, h.id, f.fact_type, f.version, v.data AS value
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref;

COMMIT;
`;

// ─── SQL Statements ──────────────────────────────────────────────────────────

const SQL = {
  // Value operations
  insertValue:
    `INSERT OR IGNORE INTO value (hash, data) VALUES (:hash, :data);`,

  // Fact operations
  insertFact:
    `INSERT INTO fact (hash, id, value_ref, parent, branch, version, commit_ref, fact_type)
    VALUES (:hash, :id, :value_ref, :parent, :branch, :version, :commit_ref, :fact_type);`,

  // Head operations
  upsertHead: `INSERT INTO head (branch, id, fact_hash, version)
    VALUES (:branch, :id, :fact_hash, :version)
    ON CONFLICT (branch, id) DO UPDATE SET fact_hash = :fact_hash, version = :version;`,

  getHead: `SELECT h.branch, h.id, h.fact_hash, h.version
    FROM head h WHERE h.branch = :branch AND h.id = :id;`,

  // Read current value (head join)
  readCurrent: `SELECT f.fact_type, f.version, v.data, h.fact_hash
    FROM head h
    JOIN fact f ON f.hash = h.fact_hash
    JOIN value v ON v.hash = f.value_ref
    WHERE h.branch = :branch AND h.id = :id;`,

  // Snapshot operations
  findSnapshot: `SELECT s.version, v.data AS snapshot_value
    FROM snapshot s
    JOIN value v ON v.hash = s.value_ref
    WHERE s.branch = :branch AND s.id = :id AND s.version <= :version
    ORDER BY s.version DESC LIMIT 1;`,

  insertSnapshot:
    `INSERT OR REPLACE INTO snapshot (id, version, value_ref, branch)
    VALUES (:id, :version, :value_ref, :branch);`,

  countPatchesSinceSnapshot: `SELECT COUNT(*) AS patch_count
    FROM fact f
    WHERE f.id = :id AND f.fact_type = 'patch'
      AND f.version > COALESCE(
        (SELECT MAX(s.version) FROM snapshot s
         WHERE s.branch = :branch AND s.id = :id), 0);`,

  // Find latest set fact
  findLatestSet: `SELECT f.version, v.data AS set_value
    FROM fact f
    JOIN value v ON v.hash = f.value_ref
    WHERE f.id = :id AND f.fact_type = 'set' AND f.version <= :version
    ORDER BY f.version DESC LIMIT 1;`,

  // Collect patches between versions
  collectPatches: `SELECT v.data AS patch_ops, f.version
    FROM fact f
    JOIN value v ON v.hash = f.value_ref
    WHERE f.id = :id AND f.fact_type = 'patch'
      AND f.version > :base_version AND f.version <= :head_version
    ORDER BY f.version ASC;`,

  // Commit operations
  insertCommit: `INSERT INTO "commit" (hash, version, branch, reads)
    VALUES (:hash, :version, :branch, :reads);`,

  // Branch operations
  getBranch: `SELECT name, parent_branch, fork_version, head_version, created_at
    FROM branch WHERE name = :name;`,

  createBranch:
    `INSERT INTO branch (name, parent_branch, fork_version, head_version)
    VALUES (:name, :parent_branch, :fork_version, :fork_version);`,

  updateBranchVersion:
    `UPDATE branch SET head_version = :version WHERE name = :name;`,

  listBranches:
    `SELECT name, parent_branch, fork_version, head_version, created_at
    FROM branch ORDER BY created_at ASC;`,

  deleteBranchHeads: `DELETE FROM head WHERE branch = :branch;`,
  deleteBranchSnapshots: `DELETE FROM snapshot WHERE branch = :branch;`,
  deleteBranchMeta: `DELETE FROM branch WHERE name = :name;`,

  // Version management
  getMaxVersion: `SELECT MAX(head_version) AS max_version FROM branch;`,

  // Query: all heads on a branch
  queryAllHeads: `SELECT h.id, h.fact_hash, h.version
    FROM head h WHERE h.branch = :branch;`,

  // Blob operations
  insertBlob: `INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
    VALUES (:hash, :data, :content_type, :size);`,

  getBlob:
    `SELECT data, content_type, size FROM blob_store WHERE hash = :hash;`,

  // Facts by version range (for subscriptions)
  factsByVersionRange: `SELECT f.hash, f.id, f.value_ref, f.parent, f.branch,
      f.version, f.commit_ref, f.fact_type
    FROM fact f WHERE f.version > :from_version AND f.version <= :to_version
    ORDER BY f.version ASC;`,
} as const;

// ─── Prepared Statement Cache ────────────────────────────────────────────────

type PreparedStatements = Partial<Record<keyof typeof SQL, Statement>>;

const stmtCache = new WeakMap<Database, PreparedStatements>();

function getStmt(db: Database, key: keyof typeof SQL): Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = {};
    stmtCache.set(db, cache);
  }
  if (!cache[key]) {
    cache[key] = db.prepare(SQL[key]);
  }
  return cache[key]!;
}

function finalizeStatements(db: Database): void {
  const cache = stmtCache.get(db);
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
    stmtCache.delete(db);
  }
}

// ─── Space V2 ────────────────────────────────────────────────────────────────

export interface SpaceV2Options {
  /** URL for the database. file: for disk, memory: for in-memory. */
  url: URL;
  /** Snapshot interval — create a snapshot every N patch facts. Default: 10. */
  snapshotInterval?: number;
}

/**
 * A v2 storage space backed by SQLite.
 */
export class SpaceV2 {
  readonly db: Database;
  readonly snapshotInterval: number;

  private constructor(db: Database, snapshotInterval: number) {
    this.db = db;
    this.snapshotInterval = snapshotInterval;
  }

  /**
   * Open or create a v2 space database.
   */
  static open(options: SpaceV2Options): SpaceV2 {
    const { url, snapshotInterval = 10 } = options;

    const address = url.protocol === "file:" ? url : null;
    const db = new Database(address ?? ":memory:", { create: true });

    db.exec(NEW_DB_PRAGMAS);
    db.exec(PRAGMAS);
    db.exec(SCHEMA);

    return new SpaceV2(db, snapshotInterval);
  }

  /**
   * Connect to an existing v2 space database.
   */
  static connect(options: SpaceV2Options): SpaceV2 {
    const { url, snapshotInterval = 10 } = options;

    const address = url.protocol === "file:" ? url : null;
    const db = new Database(address ?? ":memory:", { create: false });

    db.exec(PRAGMAS);
    db.exec(SCHEMA);

    return new SpaceV2(db, snapshotInterval);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    finalizeStatements(this.db);
    this.db.close();
  }

  // ─── Read Operations ────────────────────────────────────────────────────

  /**
   * Read the current value of an entity on a branch.
   * Returns null if the entity doesn't exist or is deleted.
   */
  read(entityId: EntityId, branch: string = DEFAULT_BRANCH): JSONValue | null {
    const row = getStmt(this.db, "readCurrent").get({
      branch,
      id: entityId,
    }) as {
      fact_type: string;
      version: number;
      data: string | null;
      fact_hash: string;
    } | undefined;

    if (!row) return null; // Never written (Empty)
    if (row.fact_type === "delete") return null;
    if (row.fact_type === "set") {
      return row.data ? JSON.parse(row.data) : null;
    }

    // Patch — need to reconstruct
    return this.reconstructValue(entityId, row.version, branch);
  }

  /**
   * Read the head info for an entity on a branch.
   * Returns null if the entity has no head.
   */
  getHead(entityId: EntityId, branch: string = DEFAULT_BRANCH): HeadRow | null {
    const row = getStmt(this.db, "getHead").get({
      branch,
      id: entityId,
    }) as HeadRow | undefined;

    return row ?? null;
  }

  /**
   * Read a fact entry for an entity: value + version + hash.
   * Used for building query results.
   */
  readFactEntry(
    entityId: EntityId,
    branch: string = DEFAULT_BRANCH,
  ): FactEntry | null {
    const row = getStmt(this.db, "readCurrent").get({
      branch,
      id: entityId,
    }) as {
      fact_type: string;
      version: number;
      data: string | null;
      fact_hash: string;
    } | undefined;

    if (!row) return null;

    const hash = row.fact_hash as unknown as Reference;
    if (row.fact_type === "delete") {
      return { version: row.version, hash };
    }

    let value: JSONValue | undefined;
    if (row.fact_type === "set") {
      value = row.data ? JSON.parse(row.data) : null;
    } else {
      value = this.reconstructValue(entityId, row.version, branch);
    }

    return { value, version: row.version, hash };
  }

  /**
   * Query entities matching a selector.
   * For now supports simple entity-by-id queries and wildcard (*).
   */
  query(
    selector: Selector,
    branch: string = DEFAULT_BRANCH,
  ): FactSet {
    const result: FactSet = {};

    for (const [pattern, _match] of Object.entries(selector)) {
      if (pattern === "*") {
        // Wildcard: return all entities on the branch
        const rows = getStmt(this.db, "queryAllHeads").all({ branch }) as {
          id: string;
          fact_hash: string;
          version: number;
        }[];
        for (const row of rows) {
          const entry = this.readFactEntry(row.id, branch);
          if (entry) {
            result[row.id] = entry;
          }
        }
      } else {
        // Specific entity
        const entry = this.readFactEntry(pattern, branch);
        if (entry) {
          result[pattern] = entry;
        }
      }
    }

    return result;
  }

  // ─── Write Operations ───────────────────────────────────────────────────

  /**
   * Commit a client transaction.
   * Validates reads, applies operations atomically, returns commit result.
   */
  commit(clientCommit: ClientCommit): Commit {
    const branch = clientCommit.branch ?? DEFAULT_BRANCH;

    // Wrap everything in a DB transaction
    const dbTransaction = this.db.transaction(() => {
      // 1. Validate reads
      const validation = this.validate(clientCommit, branch);
      if (!validation.valid) {
        if ("conflicts" in validation) {
          const err = new Error("ConflictError") as Error & {
            name: "ConflictError";
            commit: ClientCommit;
            conflicts: ConflictDetail[];
          };
          err.name = "ConflictError";
          err.commit = clientCommit;
          err.conflicts = validation.conflicts;
          throw err;
        }
        if ("pendingDependency" in validation) {
          throw new Error(
            `Pending dependency not resolved: ${validation.pendingDependency}`,
          );
        }
        if ("cascadedRejection" in validation) {
          throw new Error(
            `Cascaded rejection from: ${validation.cascadedRejection}`,
          );
        }
      }

      // 2. Assign version (next global Lamport clock)
      const version = this.nextVersion();

      // 3. Process operations → produce facts
      const storedFacts: StoredFact[] = [];
      const commitHash = hashCommit({
        version,
        branch,
        operations: clientCommit.operations,
        reads: clientCommit.reads,
      });
      const commitHashStr = refToString(commitHash);

      // Insert commit record first (facts reference it)
      getStmt(this.db, "insertCommit").run({
        hash: commitHashStr,
        version,
        branch,
        reads: JSON.stringify(clientCommit.reads),
      });

      for (const op of clientCommit.operations) {
        if (op.op === "claim") continue; // Claims are read-only assertions

        const fact = this.applyOperation(op, branch, version, commitHashStr);
        storedFacts.push(fact);
      }

      // 4. Update branch head version
      getStmt(this.db, "updateBranchVersion").run({ version, name: branch });

      // 5. Check if snapshots are needed
      for (const fact of storedFacts) {
        if (fact.fact.type === "patch" || fact.fact.type === "set") {
          this.maybeCreateSnapshot(fact.fact.id, branch, version);
        }
      }

      return {
        hash: commitHash,
        version,
        branch,
        facts: storedFacts,
        createdAt: new Date().toISOString(),
      } satisfies Commit;
    });

    return dbTransaction();
  }

  // ─── Branch Operations ──────────────────────────────────────────────────

  /**
   * Create a new branch forked from a parent branch at its current version.
   */
  createBranch(name: string, parentBranch: string = DEFAULT_BRANCH): void {
    const parent = getStmt(this.db, "getBranch").get({
      name: parentBranch,
    }) as BranchRow | undefined;

    if (!parent) {
      throw new Error(`Parent branch not found: ${parentBranch}`);
    }

    getStmt(this.db, "createBranch").run({
      name,
      parent_branch: parentBranch,
      fork_version: parent.head_version,
    });
  }

  /**
   * Get branch metadata.
   */
  getBranch(name: string): BranchRow | null {
    const row = getStmt(this.db, "getBranch").get({ name }) as
      | BranchRow
      | undefined;
    return row ?? null;
  }

  /**
   * List all branches.
   */
  listBranches(): BranchRow[] {
    return getStmt(this.db, "listBranches").all({}) as BranchRow[];
  }

  /**
   * Delete a branch (not the default branch).
   */
  deleteBranch(name: string): void {
    if (name === DEFAULT_BRANCH) {
      throw new Error("Cannot delete the default branch");
    }

    const dbTx = this.db.transaction(() => {
      getStmt(this.db, "deleteBranchHeads").run({ branch: name });
      getStmt(this.db, "deleteBranchSnapshots").run({ branch: name });
      getStmt(this.db, "deleteBranchMeta").run({ name });
    });
    dbTx();
  }

  // ─── Blob Operations ───────────────────────────────────────────────────

  /**
   * Store a blob.
   */
  writeBlob(hash: string, data: Uint8Array, contentType: string): void {
    getStmt(this.db, "insertBlob").run({
      hash,
      data,
      content_type: contentType,
      size: data.byteLength,
    });
  }

  /**
   * Read a blob.
   */
  readBlob(
    hash: string,
  ): { data: Uint8Array; contentType: string; size: number } | null {
    const row = getStmt(this.db, "getBlob").get({ hash }) as {
      data: Uint8Array;
      content_type: string;
      size: number;
    } | undefined;
    if (!row) return null;
    return { data: row.data, contentType: row.content_type, size: row.size };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Reconstruct an entity's value by finding the nearest base and replaying patches.
   */
  private reconstructValue(
    entityId: EntityId,
    headVersion: number,
    branch: string,
  ): JSONValue | null {
    // Find nearest snapshot
    const snapshotRow = getStmt(this.db, "findSnapshot").get({
      branch,
      id: entityId,
      version: headVersion,
    }) as { version: number; snapshot_value: string } | undefined;

    // Find latest set fact
    const setRow = getStmt(this.db, "findLatestSet").get({
      id: entityId,
      version: headVersion,
    }) as { version: number; set_value: string } | undefined;

    let baseVersion: number;
    let baseValue: JSONValue;

    if (snapshotRow && (!setRow || snapshotRow.version >= setRow.version)) {
      baseVersion = snapshotRow.version;
      baseValue = JSON.parse(snapshotRow.snapshot_value);
    } else if (setRow) {
      baseVersion = setRow.version;
      baseValue = JSON.parse(setRow.set_value);
    } else {
      // No base found — start from empty object
      baseVersion = 0;
      baseValue = {};
    }

    // Collect patches between base and head
    const patchRows = getStmt(this.db, "collectPatches").all({
      id: entityId,
      base_version: baseVersion,
      head_version: headVersion,
    }) as { patch_ops: string; version: number }[];

    let value = baseValue;
    for (const patchRow of patchRows) {
      const ops: PatchOp[] = JSON.parse(patchRow.patch_ops);
      value = applyPatch(value, ops);
    }

    return value;
  }

  /**
   * Validate a client commit's read dependencies.
   */
  private validate(commit: ClientCommit, branch: string): ValidationResult {
    // Validate confirmed reads
    for (const read of commit.reads.confirmed) {
      const head = this.getHead(read.id, branch);
      if (head === null) {
        // Entity doesn't exist — valid only if read version is 0 (Empty)
        if (read.version !== 0) {
          return {
            valid: false,
            conflicts: [{
              id: read.id,
              expected: { version: read.version, hash: read.hash },
              actual: { version: 0, hash: read.hash }, // No actual head
            }],
          };
        }
      } else if (read.version < head.version) {
        // Client's read is stale
        return {
          valid: false,
          conflicts: [{
            id: read.id,
            expected: { version: read.version, hash: read.hash },
            actual: {
              version: head.version,
              hash: head.fact_hash as unknown as Reference,
            },
          }],
        };
      }
    }

    // Pending reads are validated against resolved commits
    // For now, we don't support pending reads in the server
    // (they'd need a resolution table)
    for (const read of commit.reads.pending) {
      // Pending read resolution not yet implemented
      return {
        valid: false,
        pendingDependency: read.fromCommit,
      };
    }

    return { valid: true };
  }

  /**
   * Get the next global version number.
   */
  private nextVersion(): number {
    const row = getStmt(this.db, "getMaxVersion").get({}) as {
      max_version: number | null;
    } | undefined;
    return (row?.max_version ?? 0) + 1;
  }

  /**
   * Apply a single write operation, producing a stored fact.
   */
  private applyOperation(
    op: Operation,
    branch: string,
    version: number,
    commitHashStr: string,
  ): StoredFact {
    // Resolve parent from server head state (authoritative)
    const currentHead = this.getHead(op.id, branch);
    const parentRef: Reference = currentHead
      ? fromString(currentHead.fact_hash) as unknown as Reference
      : emptyRef(op.id);
    const parentForDb = currentHead ? currentHead.fact_hash : null; // NULL for first write

    switch (op.op) {
      case "set": {
        // Store the value
        const valueJson = JSON.stringify(op.value);
        const valueHash = refToString(refer(op.value));
        getStmt(this.db, "insertValue").run({
          hash: valueHash,
          data: valueJson,
        });

        // Create the fact using server-resolved parent
        const fact: SetWrite = {
          type: "set",
          id: op.id,
          value: op.value,
          parent: parentRef,
        };
        const factHash = hashFact(fact);
        const factHashStr = refToString(factHash);

        getStmt(this.db, "insertFact").run({
          hash: factHashStr,
          id: op.id,
          value_ref: valueHash,
          parent: parentForDb,
          branch,
          version,
          commit_ref: commitHashStr,
          fact_type: "set",
        });

        // Update head
        getStmt(this.db, "upsertHead").run({
          branch,
          id: op.id,
          fact_hash: factHashStr,
          version,
        });

        return {
          hash: factHash,
          fact,
          version,
          commitHash: commitHashStr as unknown as Reference,
        };
      }

      case "patch": {
        // Store the patch ops as a value
        const opsJson = JSON.stringify(op.patches);
        const opsHash = refToString(refer(op.patches));
        getStmt(this.db, "insertValue").run({ hash: opsHash, data: opsJson });

        // Create the fact using server-resolved parent
        const fact: PatchWrite = {
          type: "patch",
          id: op.id,
          ops: op.patches,
          parent: parentRef,
        };
        const factHash = hashFact(fact);
        const factHashStr = refToString(factHash);

        getStmt(this.db, "insertFact").run({
          hash: factHashStr,
          id: op.id,
          value_ref: opsHash,
          parent: parentForDb,
          branch,
          version,
          commit_ref: commitHashStr,
          fact_type: "patch",
        });

        // Update head
        getStmt(this.db, "upsertHead").run({
          branch,
          id: op.id,
          fact_hash: factHashStr,
          version,
        });

        return {
          hash: factHash,
          fact,
          version,
          commitHash: commitHashStr as unknown as Reference,
        };
      }

      case "delete": {
        // Create the fact using server-resolved parent
        const fact: Delete = {
          type: "delete",
          id: op.id,
          parent: parentRef,
        };
        const factHash = hashFact(fact);
        const factHashStr = refToString(factHash);

        getStmt(this.db, "insertFact").run({
          hash: factHashStr,
          id: op.id,
          value_ref: EMPTY_VALUE_HASH,
          parent: parentForDb,
          branch,
          version,
          commit_ref: commitHashStr,
          fact_type: "delete",
        });

        // Update head
        getStmt(this.db, "upsertHead").run({
          branch,
          id: op.id,
          fact_hash: factHashStr,
          version,
        });

        return {
          hash: factHash,
          fact,
          version,
          commitHash: commitHashStr as unknown as Reference,
        };
      }

      default:
        throw new Error(`Unknown operation type: ${(op as { op: string }).op}`);
    }
  }

  /**
   * Check if a snapshot should be created for an entity and create it if needed.
   */
  private maybeCreateSnapshot(
    entityId: EntityId,
    branch: string,
    version: number,
  ): void {
    const row = getStmt(this.db, "countPatchesSinceSnapshot").get({
      id: entityId,
      branch,
    }) as { patch_count: number } | undefined;

    if (row && row.patch_count >= this.snapshotInterval) {
      // Materialize current value
      const value = this.read(entityId, branch);
      if (value !== null) {
        const valueJson = JSON.stringify(value);
        const valueHash = refToString(refer(value));

        getStmt(this.db, "insertValue").run({
          hash: valueHash,
          data: valueJson,
        });
        getStmt(this.db, "insertSnapshot").run({
          id: entityId,
          version,
          value_ref: valueHash,
          branch,
        });
      }
    }
  }
}
