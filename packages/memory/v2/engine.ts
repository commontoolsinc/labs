import { Database } from "@db/sqlite";
import type { FabricValue } from "../interface.ts";
import { applyPatch } from "./patch.ts";
import { parentPath, parsePointer, pathsOverlap } from "./path.ts";
import {
  type BranchName,
  type CellScope,
  type ClientCommit,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  isEntityDocument,
  type Operation,
  type PatchOp,
  type Reference,
  type SessionId,
} from "../v2.ts";

const DEFAULT_SCOPE: CellScope = "space";
const DEFAULT_SCOPE_KEY = "space" as const;

const normalizeScope = (scope: CellScope | undefined): CellScope =>
  scope ?? DEFAULT_SCOPE;

const encodeScopeKeyPart = (value: string): string => encodeURIComponent(value);

const resolvePrincipalSessionKey = (
  principal: string,
  sessionId: SessionId,
): string =>
  `session:${encodeScopeKeyPart(principal)}:${encodeScopeKeyPart(sessionId)}`;

const resolveCommitSessionKey = (
  sessionId: SessionId,
  principal?: string,
): string =>
  principal ? resolvePrincipalSessionKey(principal, sessionId) : sessionId;

const resolveScopeKey = (
  scope: CellScope | undefined,
  options: { principal?: string; sessionId?: SessionId },
): string => {
  const declared = normalizeScope(scope);
  switch (declared) {
    case "space":
      return DEFAULT_SCOPE_KEY;
    case "user":
      if (!options.principal) {
        throw new ProtocolError(
          "user scoped memory operations require a principal",
        );
      }
      return `user:${encodeScopeKeyPart(options.principal)}`;
    case "session":
      if (!options.principal) {
        throw new ProtocolError(
          "session scoped memory operations require a principal",
        );
      }
      if (!options.sessionId) {
        throw new ProtocolError(
          "session scoped memory operations require a session id",
        );
      }
      return resolvePrincipalSessionKey(options.principal, options.sessionId);
  }
};

const declaredScopeFromScopeKey = (scopeKey: string): CellScope => {
  if (scopeKey.startsWith("session:")) {
    return "session";
  }
  if (scopeKey.startsWith("user:")) {
    return "user";
  }
  return "space";
};

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
  PRAGMA foreign_keys = ON;
`;

const NEW_DB_PRAGMAS = `
  PRAGMA page_size = 32768;
`;

const INIT = `
BEGIN TRANSACTION;

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

CREATE TABLE IF NOT EXISTS "commit" (
  seq                INTEGER NOT NULL PRIMARY KEY,
  branch             TEXT    NOT NULL DEFAULT '',
  session_id         TEXT    NOT NULL,
  local_seq          INTEGER NOT NULL,
  invocation_ref     TEXT,
  authorization_ref  TEXT,
  original           JSON    NOT NULL,
  resolution         JSON    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON "commit" (branch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_session_local_seq
  ON "commit" (session_id, local_seq);
CREATE INDEX IF NOT EXISTS idx_commit_invocation_ref
  ON "commit" (invocation_ref);

CREATE TABLE IF NOT EXISTS revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  scope_key   TEXT    NOT NULL DEFAULT 'space',
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_revision_branch_id_seq
  ON revision (branch, id, scope_key, seq, op_index);
CREATE INDEX IF NOT EXISTS idx_revision_commit
  ON revision (commit_seq);
CREATE INDEX IF NOT EXISTS idx_revision_branch
  ON revision (branch, seq);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  branch  TEXT    NOT NULL DEFAULT '',
  id      TEXT    NOT NULL,
  scope_key TEXT  NOT NULL DEFAULT 'space',
  seq     INTEGER NOT NULL,
  value   JSON    NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, scope_key, seq);

CREATE TABLE IF NOT EXISTS branch (
  name           TEXT    NOT NULL PRIMARY KEY,
  parent_branch  TEXT,
  fork_seq       INTEGER,
  created_seq    INTEGER NOT NULL DEFAULT 0,
  head_seq       INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'active',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT,
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

CREATE TABLE IF NOT EXISTS scheduler_observation (
  observation_id      INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  branch              TEXT    NOT NULL DEFAULT '',
  commit_seq          INTEGER,
  observed_at_seq     INTEGER NOT NULL,
  session_id          TEXT,
  local_seq           INTEGER,
  piece_id            TEXT    NOT NULL,
  action_id           TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_observation_action
  ON scheduler_observation (
    branch,
    piece_id,
    process_generation,
    action_id,
    observation_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_observation_session_local
  ON scheduler_observation (branch, session_id, local_seq)
  WHERE session_id IS NOT NULL AND local_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduler_action_snapshot (
  branch              TEXT    NOT NULL DEFAULT '',
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  observation_id      INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  PRIMARY KEY (branch, piece_id, process_generation, action_id),
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);

CREATE TABLE IF NOT EXISTS scheduler_read_index (
  branch              TEXT    NOT NULL DEFAULT '',
  owner_space         TEXT,
  read_space          TEXT    NOT NULL,
  read_id             TEXT    NOT NULL,
  read_scope          TEXT    NOT NULL,
  read_path           JSON    NOT NULL,
  read_kind           TEXT    NOT NULL,
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  observation_id      INTEGER NOT NULL,
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_read_index_lookup
  ON scheduler_read_index (branch, read_space, read_id, read_scope);
CREATE INDEX IF NOT EXISTS idx_scheduler_read_index_action
  ON scheduler_read_index (
    branch,
    piece_id,
    process_generation,
    action_id
  );

CREATE TABLE IF NOT EXISTS scheduler_write_index (
  branch              TEXT    NOT NULL DEFAULT '',
  write_space         TEXT    NOT NULL,
  write_id            TEXT    NOT NULL,
  write_scope         TEXT    NOT NULL,
  write_path          JSON    NOT NULL,
  write_kind          TEXT    NOT NULL,
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  observation_id      INTEGER NOT NULL,
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_write_index_action
  ON scheduler_write_index (
    branch,
    piece_id,
    process_generation,
    action_id
  );

CREATE TABLE IF NOT EXISTS scheduler_action_state (
  branch                 TEXT    NOT NULL DEFAULT '',
  piece_id               TEXT    NOT NULL,
  process_generation     INTEGER NOT NULL,
  action_id              TEXT    NOT NULL,
  latest_observation_id  INTEGER,
  direct_dirty_seq       INTEGER,
  stale_seq              INTEGER,
  unknown_reason         TEXT,
  PRIMARY KEY (branch, piece_id, process_generation, action_id),
  FOREIGN KEY (latest_observation_id)
    REFERENCES scheduler_observation(observation_id)
);

COMMIT;
`;

const INSERT_AUTHORIZATION = `
INSERT OR IGNORE INTO authorization (ref, authorization)
VALUES (:ref, :authorization)
`;

const INSERT_INVOCATION = `
INSERT OR IGNORE INTO invocation (ref, iss, aud, cmd, sub, invocation)
VALUES (:ref, :iss, :aud, :cmd, :sub, :invocation)
`;

const INSERT_COMMIT = `
INSERT INTO "commit" (
  seq,
  branch,
  session_id,
  local_seq,
  invocation_ref,
  authorization_ref,
  original,
  resolution
)
VALUES (
  :seq,
  :branch,
  :session_id,
  :local_seq,
  :invocation_ref,
  :authorization_ref,
  :original,
  :resolution
)
`;

const INSERT_REVISION = `
INSERT INTO revision (
  branch,
  id,
  scope_key,
  seq,
  op_index,
  op,
  data,
  commit_seq
)
VALUES (
  :branch,
  :id,
  :scope_key,
  :seq,
  :op_index,
  :op,
  :data,
  :commit_seq
)
`;

const UPSERT_HEAD = `
INSERT INTO head (branch, id, scope_key, seq, op_index)
VALUES (:branch, :id, :scope_key, :seq, :op_index)
ON CONFLICT (branch, id, scope_key) DO UPDATE
SET seq = :seq, op_index = :op_index
`;

const INSERT_SNAPSHOT = `
INSERT OR REPLACE INTO snapshot (branch, id, scope_key, seq, value)
VALUES (:branch, :id, :scope_key, :seq, :value)
`;

const DELETE_OLD_SNAPSHOTS = `
DELETE FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq NOT IN (
    SELECT seq
    FROM snapshot
    WHERE branch = :branch
      AND id = :id
      AND scope_key = :scope_key
    ORDER BY seq DESC
    LIMIT :retention
  )
`;

const UPDATE_BRANCH_HEAD = `
UPDATE branch
SET head_seq = CASE
  WHEN head_seq < :seq THEN :seq
  ELSE head_seq
END
WHERE name = :branch
`;

const SELECT_HEAD = `
SELECT seq, op_index
FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`;

const SELECT_CURRENT_LOCAL = `
SELECT r.seq, r.op_index, r.op, r.data
FROM head h
JOIN revision r
 ON r.branch = h.branch
 AND r.id = h.id
 AND r.scope_key = h.scope_key
 AND r.seq = h.seq
 AND r.op_index = h.op_index
WHERE h.branch = :branch AND h.id = :id AND h.scope_key = :scope_key
`;

const SELECT_AT_SEQ_LOCAL = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq <= :seq
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_LATEST_BASE = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op IN ('set', 'delete')
  AND (
    seq < :seq OR
    (seq = :seq AND op_index <= :op_index)
  )
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_LATEST_SNAPSHOT = `
SELECT seq, value
FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq <= :seq
ORDER BY seq DESC
LIMIT 1
`;

const SELECT_PATCHES = `
SELECT seq, op_index, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op = 'patch'
  AND (
    seq > :base_seq OR
    (seq = :base_seq AND op_index > :base_op_index)
  )
  AND (
    seq < :seq OR
    (seq = :seq AND op_index <= :op_index)
  )
ORDER BY seq ASC, op_index ASC
`;

const SELECT_PATCH_COUNT = `
SELECT COUNT(*) AS count
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op = 'patch'
  AND seq > :after_seq
  AND seq <= :seq
`;

const SELECT_NEXT_SEQ = `
SELECT COALESCE(MAX(seq), 0) + 1 AS seq
FROM "commit"
`;

const SELECT_SERVER_SEQ = `
SELECT COALESCE(MAX(seq), 0) AS seq
FROM "commit"
`;

const SELECT_EXISTING_COMMIT = `
SELECT seq, branch, original, resolution
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

const SELECT_SET_DELETE_CONFLICT = `
SELECT seq
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq > :after_seq
  AND op IN ('set', 'delete')
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_PATCH_CONFLICTS = `
SELECT seq, op_index, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq > :after_seq
  AND op = 'patch'
ORDER BY seq DESC, op_index DESC
`;

const SELECT_PENDING_RESOLUTION = `
SELECT seq
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

const SELECT_COMMIT_REVISIONS = `
SELECT branch, id, scope_key, seq, op_index, op, data, commit_seq
FROM revision
WHERE commit_seq = :commit_seq
ORDER BY op_index ASC
`;

const SELECT_BRANCH = `
SELECT name, parent_branch, fork_seq, created_seq, head_seq, status
FROM branch
WHERE name = :branch
`;

const SELECT_BRANCH_STATUS = `
SELECT status
FROM branch
WHERE name = :branch
`;

const SELECT_BRANCH_HEAD_SEQ = `
SELECT head_seq
FROM branch
WHERE name = :branch
`;

const SELECT_BRANCHES = `
SELECT name, parent_branch, fork_seq, created_seq, head_seq, status
FROM branch
ORDER BY name ASC
`;

const INSERT_BRANCH = `
INSERT INTO branch (
  name,
  parent_branch,
  fork_seq,
  created_seq,
  head_seq,
  status
)
VALUES (
  :name,
  :parent_branch,
  :fork_seq,
  :created_seq,
  :head_seq,
  'active'
)
`;

const DELETE_BRANCH = `
UPDATE branch
SET status = 'deleted',
    deleted_at = datetime('now')
WHERE name = :branch
  AND name <> ''
`;

const INSERT_BLOB = `
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size)
`;

const SELECT_BLOB = `
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash
`;

type PreparedStatement = ReturnType<Database["prepare"]>;

interface PreparedStatements {
  insertAuthorization: PreparedStatement;
  insertBlob: PreparedStatement;
  insertBranch: PreparedStatement;
  insertCommit: PreparedStatement;
  insertInvocation: PreparedStatement;
  insertRevision: PreparedStatement;
  insertSnapshot: PreparedStatement;
  selectAtSeqLocal: PreparedStatement;
  selectBlob: PreparedStatement;
  selectBranch: PreparedStatement;
  selectBranches: PreparedStatement;
  selectBranchHeadSeq: PreparedStatement;
  selectBranchStatus: PreparedStatement;
  selectCommitRevisions: PreparedStatement;
  selectCurrentLocal: PreparedStatement;
  selectExistingCommit: PreparedStatement;
  selectHead: PreparedStatement;
  selectLatestBase: PreparedStatement;
  selectLatestSnapshot: PreparedStatement;
  selectNextSeq: PreparedStatement;
  selectPatchConflicts: PreparedStatement;
  selectPatchCount: PreparedStatement;
  selectPatches: PreparedStatement;
  selectPendingResolution: PreparedStatement;
  selectServerSeq: PreparedStatement;
  selectSetDeleteConflict: PreparedStatement;
  upsertHead: PreparedStatement;
  updateBranchHead: PreparedStatement;
  deleteBranch: PreparedStatement;
  deleteOldSnapshots: PreparedStatement;
}

export interface Engine {
  url: URL;
  database: Database;
  snapshotInterval: number;
  snapshotRetention: number;
  legacyCommitMetadataRefsRequired: boolean;
  statements: PreparedStatements;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface OpenOptions {
  url: URL;
  snapshotInterval?: number;
  snapshotRetention?: number;
}

export interface InvocationRecord {
  iss: string;
  aud?: string | null;
  cmd: string;
  sub: string;
  args?: FabricValue;
  [key: string]: unknown;
}

export type AuthorizationRecord = FabricValue;

export interface ApplyCommitOptions {
  sessionId: SessionId;
  space?: string;
  principal?: string;
  invocation?: InvocationRecord;
  invocationPayload?: FabricValue;
  authorization?: AuthorizationRecord;
  commit: ClientCommit;
}

export interface AppliedRevision {
  id: EntityId;
  scope?: CellScope;
  scopeKey?: string;
  branch: BranchName;
  seq: number;
  opIndex: number;
  commitSeq: number;
  op: Operation["op"];
  document?: EntityDocument;
  patches?: PatchOp[];
}

export interface AppliedCommit {
  seq: number;
  branch: BranchName;
  revisions: AppliedRevision[];
  schedulerObservationId?: number;
  schedulerDirtiedReaders?: SchedulerReaderIndexEntry[];
}

export type SchedulerActionKind =
  | "computation"
  | "effect"
  | "event-handler";

export type SchedulerObservationTransactionKind =
  | "dependency-collection"
  | "action-run"
  | "event-preflight";

export interface SchedulerObservationAddress {
  space: string;
  id: EntityId;
  scope?: CellScope;
  path: readonly string[];
}

export interface SchedulerActionObservation {
  version: 1;
  ownerSpace?: string;
  branch: BranchName;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  observedAtSeq: number;
  observedAtLocalSeq?: number;
  transactionKind: SchedulerObservationTransactionKind;
  reads: SchedulerObservationAddress[];
  shallowReads: SchedulerObservationAddress[];
  actualChangedWrites: SchedulerObservationAddress[];
  currentKnownWrites: SchedulerObservationAddress[];
  declaredWrites: SchedulerObservationAddress[];
  materializerWriteEnvelopes: SchedulerObservationAddress[];
  ignoredSchedulingWrites?: SchedulerObservationAddress[];
  actionOptions?: {
    debounceMs?: number;
    noDebounce?: boolean;
    throttleMs?: number;
  };
  status: "success" | "failed";
  errorFingerprint?: string;
}

export interface SchedulerObservationSnapshot {
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  observation: SchedulerActionObservation;
}

export interface SchedulerObservationSnapshotWithState
  extends SchedulerObservationSnapshot {
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
}

export interface SchedulerReaderIndexEntry {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  observationId: number;
  readKind: "recursive" | "shallow";
  read: SchedulerObservationAddress;
}

export interface SchedulerActionState {
  branch: BranchName;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  latestObservationId: number | null;
  directDirtySeq: number | null;
  staleSeq: number | null;
  unknownReason: string | null;
}

export interface ReadOptions {
  id: EntityId;
  scope?: CellScope;
  principal?: string;
  sessionId?: SessionId;
  branch?: BranchName;
  seq?: number;
}

export interface EntityState {
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  branch: BranchName;
  seq: number;
  opIndex: number;
  op: Operation["op"];
  document: EntityDocument | null;
}

export interface PutBlobOptions {
  value: Uint8Array;
  contentType: string;
}

export interface BranchState {
  name: BranchName;
  parentBranch: BranchName | null;
  forkSeq: number | null;
  createdSeq: number;
  headSeq: number;
  status: string;
}

type HeadRow = {
  seq: number;
  op_index: number;
};

type CommitRow = {
  seq: number;
  branch: string;
  original: string;
  resolution: string;
};

type RevisionRow = {
  branch: string;
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: Operation["op"];
  data: string | null;
  commit_seq: number;
};

type ReadRow = {
  seq: number;
  op_index: number;
  op: Operation["op"];
  data: string | null;
};

type SnapshotRow = {
  seq: number;
  value: string;
};

type BlobRow = {
  data: Uint8Array;
  content_type: string;
  size: number;
};

type BranchRow = {
  name: string;
  parent_branch: string | null;
  fork_seq: number | null;
  created_seq: number;
  head_seq: number;
  status: string;
};

export const DEFAULT_SNAPSHOT_INTERVAL = 10;
export const DEFAULT_SNAPSHOT_RETENTION = 2;

const prepareStatements = (database: Database): PreparedStatements => ({
  insertAuthorization: database.prepare(INSERT_AUTHORIZATION),
  insertBlob: database.prepare(INSERT_BLOB),
  insertBranch: database.prepare(INSERT_BRANCH),
  insertCommit: database.prepare(INSERT_COMMIT),
  insertInvocation: database.prepare(INSERT_INVOCATION),
  insertRevision: database.prepare(INSERT_REVISION),
  insertSnapshot: database.prepare(INSERT_SNAPSHOT),
  selectAtSeqLocal: database.prepare(SELECT_AT_SEQ_LOCAL),
  selectBlob: database.prepare(SELECT_BLOB),
  selectBranch: database.prepare(SELECT_BRANCH),
  selectBranches: database.prepare(SELECT_BRANCHES),
  selectBranchHeadSeq: database.prepare(SELECT_BRANCH_HEAD_SEQ),
  selectBranchStatus: database.prepare(SELECT_BRANCH_STATUS),
  selectCommitRevisions: database.prepare(SELECT_COMMIT_REVISIONS),
  selectCurrentLocal: database.prepare(SELECT_CURRENT_LOCAL),
  selectExistingCommit: database.prepare(SELECT_EXISTING_COMMIT),
  selectHead: database.prepare(SELECT_HEAD),
  selectLatestBase: database.prepare(SELECT_LATEST_BASE),
  selectLatestSnapshot: database.prepare(SELECT_LATEST_SNAPSHOT),
  selectNextSeq: database.prepare(SELECT_NEXT_SEQ),
  selectPatchConflicts: database.prepare(SELECT_PATCH_CONFLICTS),
  selectPatchCount: database.prepare(SELECT_PATCH_COUNT),
  selectPatches: database.prepare(SELECT_PATCHES),
  selectPendingResolution: database.prepare(SELECT_PENDING_RESOLUTION),
  selectServerSeq: database.prepare(SELECT_SERVER_SEQ),
  selectSetDeleteConflict: database.prepare(SELECT_SET_DELETE_CONFLICT),
  upsertHead: database.prepare(UPSERT_HEAD),
  updateBranchHead: database.prepare(UPDATE_BRANCH_HEAD),
  deleteBranch: database.prepare(DELETE_BRANCH),
  deleteOldSnapshots: database.prepare(DELETE_OLD_SNAPSHOTS),
});

const hasColumn = (
  database: Database,
  table: string,
  column: string,
): boolean => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string }
  >;
  return rows.some((row) => row.name === column);
};

const migrateScopedEntityTables = (database: Database): void => {
  if (hasColumn(database, "revision", "scope_key")) {
    return;
  }

  database.exec(`
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_revision_branch_id_seq;
DROP INDEX IF EXISTS idx_revision_commit;
DROP INDEX IF EXISTS idx_revision_branch;
DROP INDEX IF EXISTS idx_head_branch;
DROP INDEX IF EXISTS idx_snapshot_lookup;

ALTER TABLE revision RENAME TO revision_unscoped_migration;
ALTER TABLE head RENAME TO head_unscoped_migration;
ALTER TABLE snapshot RENAME TO snapshot_unscoped_migration;

CREATE TABLE revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  scope_key   TEXT    NOT NULL DEFAULT 'space',
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX idx_revision_branch_id_seq
  ON revision (branch, id, scope_key, seq, op_index);
CREATE INDEX idx_revision_commit
  ON revision (commit_seq);
CREATE INDEX idx_revision_branch
  ON revision (branch, seq);

CREATE TABLE head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX idx_head_branch ON head (branch);

CREATE TABLE snapshot (
  branch    TEXT    NOT NULL DEFAULT '',
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  value     JSON    NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq)
);
CREATE INDEX idx_snapshot_lookup
  ON snapshot (branch, id, scope_key, seq);

INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
SELECT branch, id, 'space', seq, op_index, op, data, commit_seq
FROM revision_unscoped_migration;

INSERT INTO head (branch, id, scope_key, seq, op_index)
SELECT branch, id, 'space', seq, op_index
FROM head_unscoped_migration;

INSERT INTO snapshot (branch, id, scope_key, seq, value)
SELECT branch, id, 'space', seq, value
FROM snapshot_unscoped_migration;

DROP TABLE revision_unscoped_migration;
DROP TABLE head_unscoped_migration;
DROP TABLE snapshot_unscoped_migration;

COMMIT;
`);
};

const migrateSchedulerReadIndexOwnerSpace = (database: Database): void => {
  if (hasColumn(database, "scheduler_read_index", "owner_space")) {
    return;
  }

  database.exec(`
ALTER TABLE scheduler_read_index
ADD COLUMN owner_space TEXT;
`);
};

export const open = async (
  {
    url,
    snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL,
    snapshotRetention = DEFAULT_SNAPSHOT_RETENTION,
  }: OpenOptions,
): Promise<Engine> => {
  const database = await new Database(toDatabaseAddress(url), { create: true });
  database.exec(NEW_DB_PRAGMAS);
  database.exec(PRAGMAS);
  database.exec(INIT);
  migrateScopedEntityTables(database);
  migrateSchedulerReadIndexOwnerSpace(database);
  return {
    url,
    database,
    snapshotInterval,
    snapshotRetention,
    legacyCommitMetadataRefsRequired: commitMetadataRefsRequired(database),
    statements: prepareStatements(database),
  };
};

export const close = (engine: Engine): void => {
  engine.database.close();
};

export const createBranch = (
  engine: Engine,
  name: BranchName,
  options: {
    parentBranch?: BranchName;
    forkSeq?: number;
  } = {},
): BranchState =>
  engine.database.transaction((txEngine: Engine) => {
    if (name === DEFAULT_BRANCH) {
      return getBranch(txEngine, DEFAULT_BRANCH)!;
    }
    const existing = getBranch(txEngine, name);
    if (existing !== null) {
      return existing;
    }
    const parentBranch = options.parentBranch ?? DEFAULT_BRANCH;
    ensureReadableBranch(txEngine, parentBranch);
    const forkSeq = options.forkSeq ?? headSeq(txEngine, parentBranch);
    txEngine.statements.insertBranch.run({
      name,
      parent_branch: parentBranch,
      fork_seq: forkSeq,
      created_seq: forkSeq,
      head_seq: forkSeq,
    });
    return getBranch(txEngine, name)!;
  }).immediate(engine);

export const deleteBranch = (
  engine: Engine,
  branch: BranchName,
): void => {
  ensureReadableBranch(engine, branch);
  engine.statements.deleteBranch.run({ branch });
};

export const listBranches = (engine: Engine): BranchState[] => {
  return (engine.statements.selectBranches.all() as BranchRow[]).map(
    toBranchState,
  );
};

export const read = (
  engine: Engine,
  { id, branch = DEFAULT_BRANCH, seq, scope, principal, sessionId }:
    ReadOptions,
): EntityDocument | null => {
  return readState(engine, { id, branch, seq, scope, principal, sessionId })
    ?.document ?? null;
};

export const readState = (
  engine: Engine,
  { id, branch = DEFAULT_BRANCH, seq, scope, principal, sessionId }:
    ReadOptions,
): EntityState | null => {
  const declaredScope = normalizeScope(scope);
  const scopeKey = resolveScopeKey(scope, { principal, sessionId });
  return readStateForScopeKey(engine, {
    id,
    branch,
    seq,
    scope: declaredScope,
    scopeKey,
  });
};

const readStateForScopeKey = (
  engine: Engine,
  {
    id,
    scopeKey,
    branch = DEFAULT_BRANCH,
    seq,
    scope,
  }: {
    id: EntityId;
    scope?: CellScope;
    scopeKey: string;
    branch?: BranchName;
    seq?: number;
  },
): EntityState | null => {
  const declaredScope = scope ?? declaredScopeFromScopeKey(scopeKey);
  const targetSeq = seq ?? headSeq(engine, branch);
  const resolved = readRowForBranch(engine, {
    id,
    scopeKey,
    branch,
    seq: targetSeq,
  });
  if (resolved === null) {
    return null;
  }

  const { row, branch: resolvedBranch } = resolved;
  let document: EntityDocument | null;
  switch (row.op) {
    case "set":
      document = decodeStoredDocument(row.data);
      break;
    case "delete":
      document = null;
      break;
    case "patch":
      document = reconstructPatchedDocument(engine, {
        id,
        scopeKey,
        branch: resolvedBranch,
        seq: row.seq,
        opIndex: row.op_index,
      });
      break;
  }

  return {
    id,
    scope: declaredScope,
    scopeKey,
    branch: resolvedBranch,
    seq: row.seq,
    opIndex: row.op_index,
    op: row.op,
    document,
  };
};

export const headSeq = (
  engine: Engine,
  branch: BranchName = DEFAULT_BRANCH,
): number => {
  const row = engine.statements.selectBranchHeadSeq.get({
    branch,
  }) as { head_seq: number } | undefined;
  return row?.head_seq ?? 0;
};

export const serverSeq = (engine: Engine): number => {
  return (engine.statements.selectServerSeq.get() as { seq: number }).seq;
};

export const applyCommit = (
  engine: Engine,
  options: ApplyCommitOptions,
): AppliedCommit => {
  return engine.database.transaction(applyCommitTransaction).immediate(
    engine,
    options,
  );
};

export interface UpsertSchedulerObservationOptions {
  branch?: BranchName;
  ownerSpace?: string;
  commitSeq?: number | null;
  observedAtSeq: number;
  sessionId?: SessionId;
  localSeq?: number;
  observation: SchedulerActionObservation;
}

export interface UpsertSchedulerObservationResult {
  observationId: number;
  commitSeq: number | null;
}

export const upsertSchedulerObservation = (
  engine: Engine,
  options: UpsertSchedulerObservationOptions,
): UpsertSchedulerObservationResult =>
  engine.database.transaction(upsertSchedulerObservationTransaction).immediate(
    engine,
    options,
  );

const upsertSchedulerObservationTransaction = (
  engine: Engine,
  options: UpsertSchedulerObservationOptions,
): UpsertSchedulerObservationResult => {
  const branch = options.branch ?? options.observation.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  const observation = normalizeSchedulerObservation(
    options.observation,
    branch,
    options.observedAtSeq,
    options.ownerSpace,
  );
  const payload = encodeMemoryBoundary(observation);
  engine.database.prepare(`
    INSERT INTO scheduler_observation (
      branch,
      commit_seq,
      observed_at_seq,
      session_id,
      local_seq,
      piece_id,
      action_id,
      process_generation,
      payload
    )
    VALUES (
      :branch,
      :commit_seq,
      :observed_at_seq,
      :session_id,
      :local_seq,
      :piece_id,
      :action_id,
      :process_generation,
      :payload
    )
  `).run({
    branch,
    commit_seq: options.commitSeq ?? null,
    observed_at_seq: options.observedAtSeq,
    session_id: options.sessionId ?? null,
    local_seq: options.localSeq ?? null,
    piece_id: observation.pieceId,
    action_id: observation.actionId,
    process_generation: observation.processGeneration,
    payload,
  });
  const row = engine.database.prepare(`SELECT last_insert_rowid() AS id`)
    .get() as { id: number };
  const observationId = row.id;

  deleteSchedulerIndexRows(engine, {
    branch,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
  });
  upsertSchedulerSnapshot(engine, {
    branch,
    observationId,
    payload,
    observation,
  });
  insertSchedulerReadRows(engine, {
    branch,
    observationId,
    observation,
  });
  insertSchedulerWriteRows(engine, {
    branch,
    observationId,
    observation,
  });
  upsertSchedulerActionState(engine, {
    branch,
    observation,
    latestObservationId: observationId,
  });

  return {
    observationId,
    commitSeq: options.commitSeq ?? null,
  };
};

export const getLatestSchedulerActionSnapshot = (
  engine: Engine,
  options: {
    branch?: BranchName;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): SchedulerObservationSnapshot | undefined => {
  const row = engine.database.prepare(`
    SELECT s.observation_id, o.commit_seq, o.observed_at_seq, s.payload
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    WHERE s.branch = :branch
      AND s.piece_id = :piece_id
      AND s.process_generation = :process_generation
      AND s.action_id = :action_id
  `).get({
    branch: options.branch ?? DEFAULT_BRANCH,
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
  }) as {
    observation_id: number;
    commit_seq: number | null;
    observed_at_seq: number;
    payload: string;
  } | undefined;

  if (!row) return undefined;
  return {
    observationId: row.observation_id,
    commitSeq: row.commit_seq,
    observedAtSeq: row.observed_at_seq,
    observation: decodeSchedulerObservation(row.payload),
  };
};

export const listSchedulerActionSnapshots = (
  engine: Engine,
  options: {
    branch?: BranchName;
    pieceId?: string;
    processGeneration?: number;
    actionId?: string;
  } = {},
): SchedulerObservationSnapshotWithState[] => {
  const rows = engine.database.prepare(`
    SELECT
      s.observation_id,
      o.commit_seq,
      o.observed_at_seq,
      s.payload,
      a.direct_dirty_seq,
      a.stale_seq,
      a.unknown_reason
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    LEFT JOIN scheduler_action_state a
      ON a.branch = s.branch
      AND a.piece_id = s.piece_id
      AND a.process_generation = s.process_generation
      AND a.action_id = s.action_id
    WHERE s.branch = :branch
      AND (:piece_id IS NULL OR s.piece_id = :piece_id)
      AND (
        :process_generation IS NULL OR
        s.process_generation = :process_generation
      )
      AND (:action_id IS NULL OR s.action_id = :action_id)
    ORDER BY s.piece_id, s.process_generation, s.action_id
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    piece_id: options.pieceId ?? null,
    process_generation: options.processGeneration ?? null,
    action_id: options.actionId ?? null,
  }) as {
    observation_id: number;
    commit_seq: number | null;
    observed_at_seq: number;
    payload: string;
    direct_dirty_seq: number | null;
    stale_seq: number | null;
    unknown_reason: string | null;
  }[];

  return rows.map((row) => ({
    observationId: row.observation_id,
    commitSeq: row.commit_seq,
    observedAtSeq: row.observed_at_seq,
    observation: decodeSchedulerObservation(row.payload),
    ...(row.direct_dirty_seq !== null
      ? { directDirtySeq: row.direct_dirty_seq }
      : {}),
    ...(row.stale_seq !== null ? { staleSeq: row.stale_seq } : {}),
    ...(row.unknown_reason !== null
      ? { unknownReason: row.unknown_reason }
      : {}),
  }));
};

export const findSchedulerReadersForWrite = (
  engine: Engine,
  options: {
    branch?: BranchName;
    write: SchedulerObservationAddress;
  },
): SchedulerReaderIndexEntry[] => {
  const write = normalizeSchedulerAddress(options.write);
  const rows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      read_space,
      read_id,
      read_scope,
      read_path,
      read_kind,
      piece_id,
      process_generation,
      action_id,
      observation_id
    FROM scheduler_read_index
    WHERE branch = :branch
      AND read_space = :read_space
      AND read_id = :read_id
      AND read_scope = :read_scope
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    read_space: write.space,
    read_id: write.id,
    read_scope: normalizeSchedulerScope(write.scope),
  }) as SchedulerReadIndexRow[];

  return rows
    .filter((row) =>
      schedulerPathsOverlap(
        decodeSchedulerPath(row.read_path),
        write.path,
        row.read_kind === "shallow",
      )
    )
    .map((row) => ({
      branch: row.branch,
      ...(row.owner_space !== null ? { ownerSpace: row.owner_space } : {}),
      pieceId: row.piece_id,
      processGeneration: row.process_generation,
      actionId: row.action_id,
      observationId: row.observation_id,
      readKind: row.read_kind === "shallow" ? "shallow" : "recursive",
      read: {
        space: row.read_space,
        id: row.read_id,
        scope: row.read_scope as CellScope,
        path: decodeSchedulerPath(row.read_path),
      },
    }));
};

export const markSchedulerReadersDirtyForWrites = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    dirtySeq: number;
    writes: readonly SchedulerObservationAddress[];
  },
): SchedulerReaderIndexEntry[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const dirtied = new Map<string, SchedulerReaderIndexEntry>();
  for (const write of options.writes) {
    for (
      const reader of findSchedulerReadersForWrite(engine, {
        branch,
        write,
      })
    ) {
      const key = schedulerActionKey(reader);
      if (!dirtied.has(key)) {
        dirtied.set(key, reader);
      }
    }
  }

  markSchedulerActionsDirectDirty(engine, {
    branch,
    ownerSpace: options.ownerSpace,
    dirtySeq: options.dirtySeq,
    actions: [...dirtied.values()],
  });

  return [...dirtied.values()];
};

export const markSchedulerActionsDirectDirty = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    dirtySeq: number;
    actions: readonly SchedulerReaderIndexEntry[];
  },
): void => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const direct = dedupeSchedulerActions(options.actions, branch);
  for (const action of direct) {
    markSchedulerActionDirectDirty(engine, action, options.dirtySeq);
  }
  propagateSchedulerStaleFromActions(engine, {
    branch,
    ownerSpace: options.ownerSpace,
    dirtySeq: options.dirtySeq,
    actions: direct,
  });
};

export const getSchedulerActionState = (
  engine: Engine,
  options: {
    branch?: BranchName;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): SchedulerActionState | undefined => {
  const row = engine.database.prepare(`
    SELECT
      branch,
      piece_id,
      process_generation,
      action_id,
      latest_observation_id,
      direct_dirty_seq,
      stale_seq,
      unknown_reason
    FROM scheduler_action_state
    WHERE branch = :branch
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).get({
    branch: options.branch ?? DEFAULT_BRANCH,
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
  }) as SchedulerActionStateRow | undefined;

  if (!row) return undefined;
  return {
    branch: row.branch,
    pieceId: row.piece_id,
    processGeneration: row.process_generation,
    actionId: row.action_id,
    latestObservationId: row.latest_observation_id,
    directDirtySeq: row.direct_dirty_seq,
    staleSeq: row.stale_seq,
    unknownReason: row.unknown_reason,
  };
};

function dedupeSchedulerActions(
  actions: readonly SchedulerReaderIndexEntry[],
  fallbackBranch: BranchName,
): SchedulerReaderIndexEntry[] {
  const deduped = new Map<string, SchedulerReaderIndexEntry>();
  for (const action of actions) {
    const normalized = {
      ...action,
      branch: action.branch ?? fallbackBranch,
    };
    deduped.set(schedulerActionKey(normalized), normalized);
  }
  return [...deduped.values()];
}

function markSchedulerActionDirectDirty(
  engine: Engine,
  action: SchedulerReaderIndexEntry,
  dirtySeq: number,
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      piece_id,
      process_generation,
      action_id,
      direct_dirty_seq
    )
    VALUES (
      :branch,
      :piece_id,
      :process_generation,
      :action_id,
      :direct_dirty_seq
    )
    ON CONFLICT (branch, piece_id, process_generation, action_id)
    DO UPDATE SET
      direct_dirty_seq = CASE
        WHEN direct_dirty_seq IS NULL OR direct_dirty_seq < excluded.direct_dirty_seq
        THEN excluded.direct_dirty_seq
        ELSE direct_dirty_seq
      END
  `).run({
    branch: action.branch,
    piece_id: action.pieceId,
    process_generation: action.processGeneration,
    action_id: action.actionId,
    direct_dirty_seq: dirtySeq,
  });
}

function markSchedulerActionStale(
  engine: Engine,
  action: SchedulerReaderIndexEntry,
  staleSeq: number,
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      piece_id,
      process_generation,
      action_id,
      stale_seq
    )
    VALUES (
      :branch,
      :piece_id,
      :process_generation,
      :action_id,
      :stale_seq
    )
    ON CONFLICT (branch, piece_id, process_generation, action_id)
    DO UPDATE SET
      stale_seq = CASE
        WHEN stale_seq IS NULL OR stale_seq < excluded.stale_seq
        THEN excluded.stale_seq
        ELSE stale_seq
      END
  `).run({
    branch: action.branch,
    piece_id: action.pieceId,
    process_generation: action.processGeneration,
    action_id: action.actionId,
    stale_seq: staleSeq,
  });
}

function propagateSchedulerStaleFromActions(
  engine: Engine,
  options: {
    branch: BranchName;
    ownerSpace?: string;
    dirtySeq: number;
    actions: readonly SchedulerReaderIndexEntry[];
  },
): void {
  const queue = [...options.actions];
  const visited = new Set(queue.map(schedulerActionKey));

  for (let index = 0; index < queue.length; index++) {
    const action = queue[index];
    for (const write of schedulerWritesForAction(engine, action)) {
      const readers = findSchedulerReadersForWrite(engine, {
        branch: options.branch,
        write,
      });
      for (const reader of readers) {
        if (schedulerActionKey(reader) === schedulerActionKey(action)) {
          continue;
        }
        if (options.ownerSpace && reader.ownerSpace !== options.ownerSpace) {
          continue;
        }
        const key = schedulerActionKey(reader);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        markSchedulerActionStale(engine, reader, options.dirtySeq);
        queue.push(reader);
      }
    }
  }
}

function schedulerWritesForAction(
  engine: Engine,
  action: SchedulerReaderIndexEntry,
): SchedulerObservationAddress[] {
  const rows = engine.database.prepare(`
    SELECT
      write_space,
      write_id,
      write_scope,
      write_path
    FROM scheduler_write_index
    WHERE branch = :branch
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND write_kind IN ('current-known', 'declared')
  `).all({
    branch: action.branch,
    piece_id: action.pieceId,
    process_generation: action.processGeneration,
    action_id: action.actionId,
  }) as {
    write_space: string;
    write_id: EntityId;
    write_scope: string;
    write_path: string;
  }[];

  const writes = new Map<string, SchedulerObservationAddress>();
  for (const row of rows) {
    const write = normalizeSchedulerAddress({
      space: row.write_space,
      id: row.write_id,
      scope: row.write_scope as CellScope,
      path: decodeSchedulerPath(row.write_path),
    });
    writes.set(
      `${write.space}\0${write.scope ?? DEFAULT_SCOPE}\0${write.id}\0${
        encodeSchedulerPath(write.path)
      }`,
      write,
    );
  }
  return [...writes.values()];
}

type SchedulerReadIndexRow = {
  branch: BranchName;
  owner_space: string | null;
  read_space: string;
  read_id: EntityId;
  read_scope: string;
  read_path: string;
  read_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  observation_id: number;
};

type SchedulerActionStateRow = {
  branch: BranchName;
  piece_id: string;
  process_generation: number;
  action_id: string;
  latest_observation_id: number | null;
  direct_dirty_seq: number | null;
  stale_seq: number | null;
  unknown_reason: string | null;
};

function normalizeSchedulerObservation(
  observation: SchedulerActionObservation,
  branch: BranchName,
  observedAtSeq = observation.observedAtSeq,
  ownerSpace = observation.ownerSpace,
): SchedulerActionObservation {
  return {
    ...observation,
    ...(ownerSpace !== undefined ? { ownerSpace } : {}),
    branch,
    observedAtSeq,
    reads: observation.reads.map(normalizeSchedulerAddress),
    shallowReads: observation.shallowReads.map(normalizeSchedulerAddress),
    actualChangedWrites: observation.actualChangedWrites.map(
      normalizeSchedulerAddress,
    ),
    currentKnownWrites: observation.currentKnownWrites.map(
      normalizeSchedulerAddress,
    ),
    declaredWrites: observation.declaredWrites.map(normalizeSchedulerAddress),
    materializerWriteEnvelopes: observation.materializerWriteEnvelopes.map(
      normalizeSchedulerAddress,
    ),
    ...(observation.ignoredSchedulingWrites
      ? {
        ignoredSchedulingWrites: observation.ignoredSchedulingWrites.map(
          normalizeSchedulerAddress,
        ),
      }
      : {}),
  };
}

function normalizeSchedulerAddress(
  address: SchedulerObservationAddress,
): SchedulerObservationAddress {
  return {
    ...address,
    scope: normalizeSchedulerScope(address.scope),
    path: [...address.path],
  };
}

function normalizeSchedulerScope(scope: CellScope | undefined): CellScope {
  return scope ?? DEFAULT_SCOPE;
}

function deleteSchedulerIndexRows(
  engine: Engine,
  key: {
    branch: BranchName;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): void {
  const params = {
    branch: key.branch,
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
  };
  engine.database.prepare(`
    DELETE FROM scheduler_read_index
    WHERE branch = :branch
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).run(params);
  engine.database.prepare(`
    DELETE FROM scheduler_write_index
    WHERE branch = :branch
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).run(params);
}

function upsertSchedulerSnapshot(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    payload: string;
    observation: SchedulerActionObservation;
  },
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      piece_id,
      process_generation,
      action_id,
      observation_id,
      payload
    )
    VALUES (
      :branch,
      :piece_id,
      :process_generation,
      :action_id,
      :observation_id,
      :payload
    )
    ON CONFLICT (branch, piece_id, process_generation, action_id)
    DO UPDATE SET
      observation_id = excluded.observation_id,
      payload = excluded.payload
  `).run({
    branch: options.branch,
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    observation_id: options.observationId,
    payload: options.payload,
  });
}

function insertSchedulerReadRows(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    observation: SchedulerActionObservation;
  },
): void {
  for (
    const { address, kind } of [
      ...options.observation.reads.map((address) => ({
        address,
        kind: "recursive" as const,
      })),
      ...options.observation.shallowReads.map((address) => ({
        address,
        kind: "shallow" as const,
      })),
    ]
  ) {
    const normalized = normalizeSchedulerAddress(address);
    engine.database.prepare(`
      INSERT INTO scheduler_read_index (
        branch,
        owner_space,
        read_space,
        read_id,
        read_scope,
        read_path,
        read_kind,
        piece_id,
        process_generation,
        action_id,
        observation_id
      )
      VALUES (
        :branch,
        :owner_space,
        :read_space,
        :read_id,
        :read_scope,
        :read_path,
        :read_kind,
        :piece_id,
        :process_generation,
        :action_id,
        :observation_id
      )
    `).run({
      branch: options.branch,
      owner_space: options.observation.ownerSpace ?? null,
      read_space: normalized.space,
      read_id: normalized.id,
      read_scope: normalized.scope,
      read_path: encodeSchedulerPath(normalized.path),
      read_kind: kind,
      piece_id: options.observation.pieceId,
      process_generation: options.observation.processGeneration,
      action_id: options.observation.actionId,
      observation_id: options.observationId,
    });
  }
}

function insertSchedulerWriteRows(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    observation: SchedulerActionObservation;
  },
): void {
  for (
    const { address, kind } of [
      ...options.observation.currentKnownWrites.map((address) => ({
        address,
        kind: "current-known" as const,
      })),
      ...options.observation.declaredWrites.map((address) => ({
        address,
        kind: "declared" as const,
      })),
      ...options.observation.materializerWriteEnvelopes.map((address) => ({
        address,
        kind: "materializer" as const,
      })),
    ]
  ) {
    const normalized = normalizeSchedulerAddress(address);
    engine.database.prepare(`
      INSERT INTO scheduler_write_index (
        branch,
        write_space,
        write_id,
        write_scope,
        write_path,
        write_kind,
        piece_id,
        process_generation,
        action_id,
        observation_id
      )
      VALUES (
        :branch,
        :write_space,
        :write_id,
        :write_scope,
        :write_path,
        :write_kind,
        :piece_id,
        :process_generation,
        :action_id,
        :observation_id
      )
    `).run({
      branch: options.branch,
      write_space: normalized.space,
      write_id: normalized.id,
      write_scope: normalized.scope,
      write_path: encodeSchedulerPath(normalized.path),
      write_kind: kind,
      piece_id: options.observation.pieceId,
      process_generation: options.observation.processGeneration,
      action_id: options.observation.actionId,
      observation_id: options.observationId,
    });
  }
}

function upsertSchedulerActionState(
  engine: Engine,
  options: {
    branch: BranchName;
    observation: SchedulerActionObservation;
    latestObservationId: number;
  },
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      piece_id,
      process_generation,
      action_id,
      latest_observation_id,
      direct_dirty_seq,
      stale_seq,
      unknown_reason
    )
    VALUES (
      :branch,
      :piece_id,
      :process_generation,
      :action_id,
      :latest_observation_id,
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT (branch, piece_id, process_generation, action_id)
    DO UPDATE SET
      latest_observation_id = excluded.latest_observation_id,
      direct_dirty_seq = NULL,
      stale_seq = NULL,
      unknown_reason = NULL
  `).run({
    branch: options.branch,
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    latest_observation_id: options.latestObservationId,
  });
}

function decodeSchedulerObservation(
  payload: string,
): SchedulerActionObservation {
  return decodeMemoryBoundary<SchedulerActionObservation>(payload);
}

function encodeSchedulerPath(path: readonly string[]): string {
  return encodeMemoryBoundary([...path]);
}

function decodeSchedulerPath(payload: string): string[] {
  const path = decodeMemoryBoundary<unknown>(payload);
  if (!Array.isArray(path)) {
    throw new Error("scheduler paths must be arrays");
  }
  return path.map((part) => String(part));
}

function schedulerPathsOverlap(
  readPath: readonly string[],
  writePath: readonly string[],
  shallow: boolean,
): boolean {
  if (!shallow) {
    return pathIsPrefix(readPath, writePath) ||
      pathIsPrefix(writePath, readPath);
  }
  return pathIsPrefix(writePath, readPath) ||
    writePath.length <= readPath.length + 1 &&
      pathIsPrefix(readPath, writePath);
}

function pathIsPrefix(
  prefix: readonly string[],
  path: readonly string[],
): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((part, index) => part === path[index]);
}

function schedulerActionKey(entry: {
  branch: BranchName;
  pieceId: string;
  processGeneration: number;
  actionId: string;
}): string {
  return `${entry.branch}\0${entry.pieceId}\0${entry.processGeneration}\0${entry.actionId}`;
}

const applyCommitTransaction = (
  engine: Engine,
  {
    sessionId,
    space,
    principal,
    commit,
  }: ApplyCommitOptions,
): AppliedCommit => {
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  const schedulerObservation = commit
    .schedulerObservation as SchedulerActionObservation | undefined;
  if (commit.operations.length === 0 && !schedulerObservation) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  if (commit.operations.length === 0 && schedulerObservation) {
    const existingObservation = engine.database.prepare(`
      SELECT observation_id, observed_at_seq, payload
      FROM scheduler_observation
      WHERE branch = :branch
        AND session_id = :session_id
        AND local_seq = :local_seq
    `).get({
      branch,
      session_id: sessionKey,
      local_seq: commit.localSeq,
    }) as {
      observation_id: number;
      observed_at_seq: number;
      payload: string;
    } | undefined;
    if (existingObservation) {
      const payload = encodeMemoryBoundary(normalizeSchedulerObservation(
        schedulerObservation,
        branch,
        existingObservation.observed_at_seq,
      ));
      if (existingObservation.payload !== payload) {
        throw new ProtocolError(
          `scheduler observation replay mismatch for session ${sessionId} localSeq ${commit.localSeq}`,
        );
      }
      return {
        seq: existingObservation.observed_at_seq,
        branch,
        revisions: [],
        schedulerObservationId: existingObservation.observation_id,
      };
    }
  }

  const existing = engine.statements.selectExistingCommit.get({
    session_id: sessionKey,
    local_seq: commit.localSeq,
  }) as CommitRow | undefined;
  if (existing) {
    if (!sameStoredOriginal(existing.original, commit)) {
      throw new ProtocolError(
        `commit replay mismatch for session ${sessionId} localSeq ${commit.localSeq}`,
      );
    }
    return {
      seq: existing.seq,
      branch: existing.branch,
      revisions: selectCommitRevisions(engine, existing.seq),
    };
  }

  validateConfirmedReads(engine, branch, commit, { principal, sessionId });
  const resolvedPendingReads = resolvePendingReads(
    engine,
    sessionKey,
    sessionId,
    principal,
    branch,
    commit,
  );

  if (commit.operations.length === 0 && schedulerObservation) {
    const observedAtSeq = headSeq(engine, branch);
    const observationResult = upsertSchedulerObservationTransaction(engine, {
      branch,
      ownerSpace: space ?? schedulerObservation.ownerSpace,
      observedAtSeq,
      sessionId: sessionKey,
      localSeq: commit.localSeq,
      observation: schedulerObservation,
    });
    return {
      seq: observedAtSeq,
      branch,
      revisions: [],
      schedulerObservationId: observationResult.observationId,
    };
  }

  const seq = (engine.statements.selectNextSeq.get() as { seq: number }).seq;
  const invocationRef = engine.legacyCommitMetadataRefsRequired
    ? LEGACY_EMPTY_INVOCATION_REF
    : null;
  const authorizationRef = engine.legacyCommitMetadataRefsRequired
    ? LEGACY_EMPTY_AUTHORIZATION_REF
    : null;
  const original = encodeMemoryBoundary(commit);
  const resolution = encodeMemoryBoundary(
    resolvedPendingReads.length > 0 ? { seq, resolvedPendingReads } : { seq },
  );

  if (engine.legacyCommitMetadataRefsRequired) {
    engine.statements.insertAuthorization.run({
      ref: LEGACY_EMPTY_AUTHORIZATION_REF,
      authorization: encodeMemoryBoundary(LEGACY_EMPTY_AUTHORIZATION),
    });
    engine.statements.insertInvocation.run({
      ref: LEGACY_EMPTY_INVOCATION_REF,
      iss: LEGACY_EMPTY_INVOCATION.iss,
      aud: LEGACY_EMPTY_INVOCATION.aud ?? null,
      cmd: LEGACY_EMPTY_INVOCATION.cmd,
      sub: LEGACY_EMPTY_INVOCATION.sub,
      invocation: encodeMemoryBoundary(LEGACY_EMPTY_INVOCATION),
    });
  }
  engine.statements.insertCommit.run({
    seq,
    branch,
    session_id: sessionKey,
    local_seq: commit.localSeq,
    invocation_ref: invocationRef,
    authorization_ref: authorizationRef,
    original,
    resolution,
  });

  const revisions: AppliedRevision[] = [];
  for (const [opIndex, operation] of commit.operations.entries()) {
    const revision = writeOperation(engine, {
      branch,
      seq,
      opIndex,
      operation,
      principal,
      sessionId,
    });
    revisions.push(revision);
  }

  engine.statements.updateBranchHead.run({ branch, seq });
  materializeSnapshots(engine, branch, revisions);

  const changedSchedulerWrites = space
    ? schedulerWriteAddressesForRevisions(space, revisions)
    : [];
  let schedulerDirtiedReaders: SchedulerReaderIndexEntry[] | undefined;
  if (changedSchedulerWrites.length > 0) {
    schedulerDirtiedReaders = markSchedulerReadersDirtyForWrites(engine, {
      branch,
      ownerSpace: space,
      dirtySeq: seq,
      writes: changedSchedulerWrites,
    });
  }

  if (schedulerObservation) {
    upsertSchedulerObservationTransaction(engine, {
      branch,
      ownerSpace: space ?? schedulerObservation.ownerSpace,
      commitSeq: seq,
      observedAtSeq: seq,
      sessionId: sessionKey,
      localSeq: commit.localSeq,
      observation: schedulerObservation,
    });
  }

  return {
    seq,
    branch,
    revisions,
    ...(schedulerDirtiedReaders && schedulerDirtiedReaders.length > 0
      ? { schedulerDirtiedReaders }
      : {}),
  };
};

const writeOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    opIndex: number;
    operation: Operation;
    principal?: string;
    sessionId: SessionId;
  },
): AppliedRevision => {
  const { branch, seq, opIndex, operation, principal, sessionId } = options;
  const scope = normalizeScope(operation.scope);
  const scopeKey = resolveScopeKey(operation.scope, { principal, sessionId });
  const revisionScopeFields = scope === DEFAULT_SCOPE
    ? {}
    : { scope, scopeKey };
  switch (operation.op) {
    case "set": {
      if (!isEntityDocument(operation.value)) {
        throw new Error(
          "memory v2 set operations require explicit document objects",
        );
      }
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "set",
        data: encodeMemoryBoundary(operation.value),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "set",
        document: operation.value,
      };
    }
    case "patch": {
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "patch",
        data: encodeMemoryBoundary(operation.patches),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "patch",
        patches: operation.patches,
      };
    }
    case "delete": {
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "delete",
        data: null,
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "delete",
      };
    }
  }
};

const validateConfirmedReads = (
  engine: Engine,
  branch: BranchName,
  commit: ClientCommit,
  scopeContext: { principal?: string; sessionId: SessionId },
): void => {
  // A commit is evaluated under one connection principal/session context.
  // Every confirmed read in the commit resolves declared user/session scope
  // against that writer identity, even when the read points at another branch.
  // Cross-branch reads inherit this same principal context.
  for (const read of commit.reads.confirmed) {
    const readBranch = read.branch ?? branch;
    ensureReadableBranch(engine, readBranch);
    const scopeKey = resolveScopeKey(read.scope, scopeContext);
    const conflictSeq = findConflictSeq(
      engine,
      readBranch,
      read.id,
      scopeKey,
      read.seq,
      read.path,
    );
    if (conflictSeq !== null) {
      throw new ConflictError(
        `stale confirmed read: ${read.id} at seq ${read.seq} conflicted with seq ${conflictSeq}`,
      );
    }
  }
};

const resolvePendingReads = (
  engine: Engine,
  sessionKey: string,
  sessionId: SessionId,
  principal: string | undefined,
  branch: BranchName,
  commit: ClientCommit,
): Array<{ localSeq: number; seq: number }> => {
  const resolutions = new Map<number, { localSeq: number; seq: number }>();

  for (const read of commit.reads.pending) {
    let resolution = resolutions.get(read.localSeq);
    if (!resolution) {
      const row = engine.statements.selectPendingResolution.get({
        session_id: sessionKey,
        local_seq: read.localSeq,
      }) as { seq: number } | undefined;
      if (!row) {
        throw new ConflictError(
          `pending dependency not resolved: ${read.localSeq}`,
        );
      }
      resolution = {
        localSeq: read.localSeq,
        seq: row.seq,
      };
      resolutions.set(read.localSeq, resolution);
    }

    const conflictSeq = findConflictSeq(
      engine,
      branch,
      read.id,
      resolveScopeKey(read.scope, { principal, sessionId }),
      resolution.seq,
      read.path,
    );
    if (conflictSeq !== null) {
      throw new ConflictError(
        `stale pending read: ${read.id} via localSeq ${read.localSeq} conflicted with seq ${conflictSeq}`,
      );
    }
  }

  return [...resolutions.values()].sort((a, b) => a.localSeq - b.localSeq);
};

const findConflictSeq = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  afterSeq: number,
  readPath: readonly string[],
): number | null => {
  const setOrDeleteConflict = engine.statements.selectSetDeleteConflict.get({
    branch,
    id,
    scope_key: scopeKey,
    after_seq: afterSeq,
  }) as { seq: number } | undefined;
  if (setOrDeleteConflict !== undefined) {
    return setOrDeleteConflict.seq;
  }

  for (
    const conflict of engine.statements.selectPatchConflicts.iter({
      branch,
      id,
      scope_key: scopeKey,
      after_seq: afterSeq,
    }) as Iterable<{
      seq: number;
      data: string | null;
    }>
  ) {
    if (
      patchOverlapsRead(
        decodeStoredPatchList(conflict.data),
        readPath,
      )
    ) {
      return conflict.seq;
    }
  }

  return null;
};

const patchOverlapsRead = (
  patches: readonly PatchOp[],
  readPath: readonly string[],
): boolean => {
  return patches.some((patch) =>
    touchedPathsForPatch(patch).some((path) => pathsOverlap(path, readPath))
  );
};

const touchedPathsForPatch = (patch: PatchOp): string[][] => {
  switch (patch.op) {
    case "replace":
      return [parsePointer(patch.path)];
    case "add":
    case "remove": {
      const path = parsePointer(patch.path);
      return [path, parentPath(path)];
    }
    case "move": {
      const from = parsePointer(patch.from);
      const to = parsePointer(patch.path);
      return [from, to, parentPath(from), parentPath(to)];
    }
    case "splice":
      return [parsePointer(patch.path)];
  }
};

const schedulerWriteAddressesForRevisions = (
  space: string,
  revisions: readonly AppliedRevision[],
): SchedulerObservationAddress[] => {
  const writes = new Map<string, SchedulerObservationAddress>();
  for (const revision of revisions) {
    const paths = revision.op === "patch" && revision.patches
      ? revision.patches.flatMap(touchedPathsForPatch)
      : [[]];
    for (const path of paths) {
      const write = normalizeSchedulerAddress({
        space,
        id: revision.id,
        scope: revision.scope,
        path,
      });
      writes.set(
        `${write.space}\0${write.scope ?? DEFAULT_SCOPE}\0${write.id}\0${
          encodeSchedulerPath(write.path)
        }`,
        write,
      );
    }
  }
  return [...writes.values()];
};

const selectCommitRevisions = (
  engine: Engine,
  commitSeq: number,
): AppliedRevision[] => {
  const rows = engine.statements.selectCommitRevisions.all({
    commit_seq: commitSeq,
  }) as RevisionRow[];
  return rows.map((row) => {
    const base = {
      id: row.id,
      scope: declaredScopeFromScopeKey(row.scope_key),
      scopeKey: row.scope_key,
      branch: row.branch,
      seq: row.seq,
      opIndex: row.op_index,
      commitSeq: row.commit_seq,
      op: row.op,
    } satisfies Omit<AppliedRevision, "document" | "patches">;
    if (row.op === "set") {
      return {
        ...base,
        document: decodeStoredDocument(row.data),
      } satisfies AppliedRevision;
    }
    if (row.op === "patch") {
      return {
        ...base,
        patches: decodeStoredPatchList(row.data),
      } satisfies AppliedRevision;
    }
    return base as AppliedRevision;
  });
};

const materializeSnapshots = (
  engine: Engine,
  branch: BranchName,
  revisions: readonly AppliedRevision[],
): void => {
  if (engine.snapshotInterval <= 0) {
    return;
  }

  const seen = new Set<string>();
  for (const revision of revisions) {
    const revisionScopeKey = revision.scopeKey ?? DEFAULT_SCOPE_KEY;
    const key = revisionKey(branch, revision.id, revisionScopeKey);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    maybeMaterializeSnapshot(engine, branch, revision.id, revisionScopeKey);
  }
};

const maybeMaterializeSnapshot = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): void => {
  const current = readStateForScopeKey(engine, { id, scopeKey, branch });
  if (current === null || current.document === null || current.op !== "patch") {
    return;
  }

  const baseSeq = latestMaterializationSeq(
    engine,
    branch,
    id,
    scopeKey,
    current.seq,
  );
  const patchCount = (
    engine.statements.selectPatchCount.get({
      branch,
      id,
      scope_key: scopeKey,
      after_seq: baseSeq,
      seq: current.seq,
    }) as { count: number }
  ).count;
  if (patchCount < engine.snapshotInterval) {
    return;
  }

  engine.statements.insertSnapshot.run({
    branch,
    id,
    scope_key: scopeKey,
    seq: current.seq,
    value: encodeMemoryBoundary(current.document),
  });
  compactSnapshots(engine, branch, id, scopeKey);
};

const compactSnapshots = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): void => {
  if (engine.snapshotRetention <= 0) {
    return;
  }
  engine.statements.deleteOldSnapshots.run({
    branch,
    id,
    scope_key: scopeKey,
    retention: engine.snapshotRetention,
  });
};

const latestMaterializationSeq = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  seq: number,
): number => {
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
    op_index: Number.MAX_SAFE_INTEGER,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
  }) as SnapshotRow | undefined;
  return Math.max(baseRow?.seq ?? 0, snapshotRow?.seq ?? 0);
};

const reconstructPatchedDocument = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq: number;
    opIndex: number;
  },
): EntityDocument => {
  const { id, scopeKey, branch, seq, opIndex } = options;
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
    op_index: opIndex,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
  }) as SnapshotRow | undefined;

  let baseSeq = 0;
  let baseOpIndex = -1;
  let document = emptyEntityDocument();
  if (snapshotRow && (!baseRow || snapshotRow.seq >= baseRow.seq)) {
    baseSeq = snapshotRow.seq;
    baseOpIndex = Number.MAX_SAFE_INTEGER;
    document = decodeStoredDocument(snapshotRow.value);
  } else if (baseRow) {
    baseSeq = baseRow.seq;
    baseOpIndex = baseRow.op_index;
    if (baseRow.op === "set") {
      document = decodeStoredDocument(baseRow.data);
    }
  }

  const patches = engine.statements.selectPatches.all({
    branch,
    id,
    scope_key: scopeKey,
    base_seq: baseSeq,
    base_op_index: baseOpIndex,
    seq,
    op_index: opIndex,
  }) as Array<{ data: string; seq: number; op_index: number }>;

  for (const patch of patches) {
    document = applyPatchDocument(
      document,
      decodeStoredPatchList(patch.data),
    );
  }

  return document;
};

const readRowForBranch = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq: number;
  },
): { row: ReadRow; branch: BranchName } | null => {
  ensureReadableBranch(engine, options.branch);
  assertReadableSeq(engine, options.branch, options.seq);

  const currentRow =
    (options.seq === headSeq(engine, options.branch)
      ? engine.statements.selectCurrentLocal.get({
        branch: options.branch,
        id: options.id,
        scope_key: options.scopeKey,
      })
      : engine.statements.selectAtSeqLocal.get({
        branch: options.branch,
        id: options.id,
        scope_key: options.scopeKey,
        seq: options.seq,
      })) as ReadRow | undefined;
  if (currentRow !== undefined) {
    return { row: currentRow, branch: options.branch };
  }

  const branch = getBranch(engine, options.branch);
  if (branch?.parentBranch === null || branch?.parentBranch === undefined) {
    return null;
  }
  const inheritedSeq = Math.min(options.seq, branch.forkSeq ?? 0);
  return readRowForBranch(engine, {
    id: options.id,
    scopeKey: options.scopeKey,
    branch: branch.parentBranch,
    seq: inheritedSeq,
  });
};

const getBranch = (engine: Engine, branch: BranchName): BranchState | null => {
  const row = engine.statements.selectBranch.get({
    branch,
  }) as BranchRow | undefined;
  return row ? toBranchState(row) : null;
};

const toBranchState = (row: BranchRow): BranchState => ({
  name: row.name,
  parentBranch: row.parent_branch,
  forkSeq: row.fork_seq,
  createdSeq: row.created_seq,
  headSeq: row.head_seq,
  status: row.status,
});

const assertReadableSeq = (
  engine: Engine,
  branch: BranchName,
  seq: number,
): void => {
  const state = getBranch(engine, branch);
  if (state === null) {
    throw new Error(`unknown branch: ${branch}`);
  }
  const minSeq = branch === DEFAULT_BRANCH ? 0 : state.createdSeq;
  if (seq < minSeq || seq > state.headSeq) {
    throw new Error(`seq ${seq} is out of range for branch ${branch}`);
  }
};

const ensureReadableBranch = (engine: Engine, branch: BranchName): void => {
  const row = engine.statements.selectBranchStatus.get({
    branch,
  }) as { status: string } | undefined;
  if (!row) {
    throw new Error(`unknown branch: ${branch}`);
  }
};

const ensureActiveBranch = (engine: Engine, branch: BranchName): void => {
  const row = engine.statements.selectBranchStatus.get({
    branch,
  }) as { status: string } | undefined;
  if (!row) {
    throw new Error(`unknown branch: ${branch}`);
  }
  if (row.status !== "active") {
    throw new Error(`branch is not active: ${branch}`);
  }
};

const emptyEntityDocument = (): EntityDocument => ({});

const decodeStoredDocument = (data: string | null): EntityDocument => {
  const parsed = decodeMemoryBoundary<unknown>(data ?? "null");
  if (!isEntityDocument(parsed)) {
    throw new Error("memory v2 stored documents must be plain object roots");
  }
  return parsed;
};

const decodeStoredPatchList = (data: string | null): PatchOp[] => {
  const parsed = decodeMemoryBoundary<unknown>(data ?? "[]");
  if (!Array.isArray(parsed)) {
    throw new Error("memory v2 stored patches must be arrays");
  }
  return parsed as PatchOp[];
};

const applyPatchDocument = (
  document: EntityDocument,
  patches: PatchOp[],
): EntityDocument =>
  applyPatch(document as FabricValue, patches) as EntityDocument;

const sameStoredOriginal = (
  stored: string,
  incoming: ClientCommit,
): boolean => {
  return stored === encodeMemoryBoundary(incoming);
};

const revisionKey = (
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): string => `${branch}\0${scopeKey}\0${id}`;

const LEGACY_EMPTY_INVOCATION_REF =
  "memory-v2:legacy-empty-invocation" as Reference;
const LEGACY_EMPTY_AUTHORIZATION_REF =
  "memory-v2:legacy-empty-authorization" as Reference;
const LEGACY_EMPTY_INVOCATION: InvocationRecord = {
  iss: "did:key:memory-v2-legacy-placeholder",
  aud: null,
  cmd: "/memory/transact/legacy-placeholder",
  sub: "did:key:memory-v2-legacy-placeholder",
};
const LEGACY_EMPTY_AUTHORIZATION: AuthorizationRecord = {};

const commitMetadataRefsRequired = (database: Database): boolean => {
  const rows = database.prepare(`PRAGMA table_info("commit")`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const byName = new Map(rows.map((row) => [row.name, row.notnull] as const));
  return byName.get("invocation_ref") === 1 ||
    byName.get("authorization_ref") === 1;
};

const toDatabaseAddress = (url: URL): URL | string => {
  return url.protocol === "file:" ? url : ":memory:";
};
