import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/api";
import { applySqliteCommitWrite } from "./sqlite/commit-eval.ts";
import {
  applyPatch,
  patchOpChangesParentKeySet,
  touchedPointerPaths,
} from "./patch.ts";
import { isPrefixPath, parentPath, pathsOverlap } from "./path.ts";
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
  type SchedulerActionSnapshotCursor,
  type SessionId,
  type SqliteOperation,
  tableDeclaresRowLabel,
} from "../v2.ts";

const DEFAULT_SCOPE: CellScope = "space";
const DEFAULT_SCOPE_KEY = "space" as const;
const DEFAULT_SCHEDULER_SNAPSHOT_LIST_LIMIT = 500;
const MAX_SCHEDULER_SNAPSHOT_LIST_LIMIT = 1_000;

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

export const resolveScopeKey = (
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
  owner_space         TEXT    NOT NULL DEFAULT '',
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  observation_id      INTEGER NOT NULL,
  commit_seq          INTEGER,
  observed_at_seq     INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  ),
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);

CREATE TABLE IF NOT EXISTS scheduler_observation_replay (
  branch              TEXT    NOT NULL DEFAULT '',
  session_id          TEXT    NOT NULL,
  local_seq           INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'kept',
  reason              TEXT,
  observation_id      INTEGER,
  observed_at_seq     INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (branch, session_id, local_seq),
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
  owner_space         TEXT    NOT NULL DEFAULT '',
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
  owner_space            TEXT    NOT NULL DEFAULT '',
  piece_id               TEXT    NOT NULL,
  process_generation     INTEGER NOT NULL,
  action_id              TEXT    NOT NULL,
  latest_observation_id  INTEGER,
  direct_dirty_seq       INTEGER,
  stale_seq              INTEGER,
  unknown_reason         TEXT,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  ),
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
  /** Entity whose confirmed read went stale (stale-read conflicts only). */
  readonly of?: string;
  readonly seq?: number;
  readonly conflictSeq?: number;
  constructor(
    message: string,
    details?: { of: string; seq: number; conflictSeq: number },
  ) {
    super(message);
    this.name = "ConflictError";
    if (details !== undefined) {
      this.of = details.of;
      this.seq = details.seq;
      this.conflictSeq = details.conflictSeq;
    }
  }
}

export class PreconditionFailedError extends Error {
  readonly precondition: "origin-committed" | "receipt-exists";

  constructor(
    precondition: PreconditionFailedError["precondition"],
    message: string,
  ) {
    super(message);
    this.name = "PreconditionFailedError";
    this.precondition = precondition;
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
  /** Map of cell-db id -> attach alias for `sqlite` ops in this commit. The
   *  server attaches these BEFORE applyCommit (ATTACH can't run in a txn); the
   *  apply loop executes the SQL inside the commit's transaction against the
   *  alias. (docs/specs/sqlite-builtin/plans/atomic-writes.md) */
  sqliteAttachments?: ReadonlyMap<string, string>;
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

export interface AppliedSchedulerObservationResult {
  localSeq: number;
  status: "kept" | "dropped";
  schedulerObservationId?: number;
  reason?:
    | "stale-confirmed-read"
    | "stale-pending-read"
    | "pending-read-missing";
}

export interface AppliedCommit {
  seq: number;
  branch: BranchName;
  revisions: AppliedRevision[];
  schedulerObservationId?: number;
  schedulerObservationResults?: AppliedSchedulerObservationResult[];
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
  version: 1 | 2;
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
  currentKnownWrites?: SchedulerObservationAddress[];
  declaredWrites?: SchedulerObservationAddress[];
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

export interface SchedulerObservationSnapshotPage {
  snapshots: SchedulerObservationSnapshotWithState[];
  nextCursor?: SchedulerActionSnapshotCursor;
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
  ownerSpace?: string;
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

const primaryKeyColumns = (database: Database, table: string): string[] => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string; pk: number }
  >;
  return rows
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
};

const indexColumns = (database: Database, index: string): string[] => {
  const rows = database.prepare(`PRAGMA index_info("${index}")`).all() as Array<
    { seqno: number; name: string }
  >;
  return rows
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name);
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

const migrateSchedulerWriteIndexOwnerSpace = (database: Database): void => {
  if (hasColumn(database, "scheduler_write_index", "owner_space")) {
    return;
  }

  database.exec(`
ALTER TABLE scheduler_write_index
ADD COLUMN owner_space TEXT NOT NULL DEFAULT '';
`);
};

const migrateSchedulerActionSnapshotMetadata = (database: Database): void => {
  if (!hasColumn(database, "scheduler_action_snapshot", "commit_seq")) {
    database.exec(`
ALTER TABLE scheduler_action_snapshot
ADD COLUMN commit_seq INTEGER;
`);
  }
  if (!hasColumn(database, "scheduler_action_snapshot", "observed_at_seq")) {
    database.exec(`
ALTER TABLE scheduler_action_snapshot
ADD COLUMN observed_at_seq INTEGER NOT NULL DEFAULT 0;
`);
  }
};

const migrateSchedulerActionSnapshotOwnerSpaceKey = (
  database: Database,
): void => {
  if (
    primaryKeyColumns(database, "scheduler_action_snapshot").includes(
      "owner_space",
    )
  ) {
    return;
  }

  const ownerSpaceSelect = hasColumn(
      database,
      "scheduler_action_snapshot",
      "owner_space",
    )
    ? "COALESCE(owner_space, '')"
    : "''";

  database.exec(`
BEGIN TRANSACTION;

ALTER TABLE scheduler_action_snapshot
RENAME TO scheduler_action_snapshot_owner_space_migration;

CREATE TABLE scheduler_action_snapshot (
  branch              TEXT    NOT NULL DEFAULT '',
  owner_space         TEXT    NOT NULL DEFAULT '',
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  observation_id      INTEGER NOT NULL,
  commit_seq          INTEGER,
  observed_at_seq     INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  ),
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);

INSERT OR REPLACE INTO scheduler_action_snapshot (
  branch,
  owner_space,
  piece_id,
  process_generation,
  action_id,
  observation_id,
  commit_seq,
  observed_at_seq,
  payload
)
SELECT
  branch,
  ${ownerSpaceSelect},
  piece_id,
  process_generation,
  action_id,
  observation_id,
  commit_seq,
  observed_at_seq,
  payload
FROM scheduler_action_snapshot_owner_space_migration;

DROP TABLE scheduler_action_snapshot_owner_space_migration;

COMMIT;
`);
};

const migrateSchedulerActionStateOwnerSpaceKey = (
  database: Database,
): void => {
  if (
    primaryKeyColumns(database, "scheduler_action_state").includes(
      "owner_space",
    )
  ) {
    return;
  }

  const ownerSpaceSelect = hasColumn(
      database,
      "scheduler_action_state",
      "owner_space",
    )
    ? "COALESCE(owner_space, '')"
    : "''";

  database.exec(`
BEGIN TRANSACTION;

ALTER TABLE scheduler_action_state
RENAME TO scheduler_action_state_owner_space_migration;

CREATE TABLE scheduler_action_state (
  branch                 TEXT    NOT NULL DEFAULT '',
  owner_space            TEXT    NOT NULL DEFAULT '',
  piece_id               TEXT    NOT NULL,
  process_generation     INTEGER NOT NULL,
  action_id              TEXT    NOT NULL,
  latest_observation_id  INTEGER,
  direct_dirty_seq       INTEGER,
  stale_seq              INTEGER,
  unknown_reason         TEXT,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  ),
  FOREIGN KEY (latest_observation_id)
    REFERENCES scheduler_observation(observation_id)
);

INSERT OR REPLACE INTO scheduler_action_state (
  branch,
  owner_space,
  piece_id,
  process_generation,
  action_id,
  latest_observation_id,
  direct_dirty_seq,
  stale_seq,
  unknown_reason
)
SELECT
  branch,
  ${ownerSpaceSelect},
  piece_id,
  process_generation,
  action_id,
  latest_observation_id,
  direct_dirty_seq,
  stale_seq,
  unknown_reason
FROM scheduler_action_state_owner_space_migration;

DROP TABLE scheduler_action_state_owner_space_migration;

COMMIT;
`);
};

const migrateSchedulerActionIndexes = (database: Database): void => {
  const readIndexHasOwnerSpace = indexColumns(
    database,
    "idx_scheduler_read_index_action",
  ).includes("owner_space");
  const writeIndexHasOwnerSpace = indexColumns(
    database,
    "idx_scheduler_write_index_action",
  ).includes("owner_space");
  if (readIndexHasOwnerSpace && writeIndexHasOwnerSpace) {
    return;
  }

  database.exec(`
DROP INDEX IF EXISTS idx_scheduler_read_index_action;
CREATE INDEX idx_scheduler_read_index_action
  ON scheduler_read_index (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  );

DROP INDEX IF EXISTS idx_scheduler_write_index_action;
CREATE INDEX idx_scheduler_write_index_action
  ON scheduler_write_index (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id
  );
`);
};

const migrateSchedulerObservationReplayStatus = (database: Database): void => {
  if (hasColumn(database, "scheduler_observation_replay", "status")) {
    return;
  }

  database.exec(`
BEGIN TRANSACTION;

ALTER TABLE scheduler_observation_replay
RENAME TO scheduler_observation_replay_legacy;

CREATE TABLE scheduler_observation_replay (
  branch              TEXT    NOT NULL DEFAULT '',
  session_id          TEXT    NOT NULL,
  local_seq           INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'kept',
  reason              TEXT,
  observation_id      INTEGER,
  observed_at_seq     INTEGER NOT NULL,
  payload             JSON    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (branch, session_id, local_seq),
  FOREIGN KEY (observation_id)
    REFERENCES scheduler_observation(observation_id)
);

INSERT INTO scheduler_observation_replay (
  branch,
  session_id,
  local_seq,
  status,
  observation_id,
  observed_at_seq,
  payload,
  created_at
)
SELECT
  branch,
  session_id,
  local_seq,
  'kept',
  observation_id,
  observed_at_seq,
  payload,
  created_at
FROM scheduler_observation_replay_legacy;

DROP TABLE scheduler_observation_replay_legacy;

COMMIT;
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
  migrateSchedulerWriteIndexOwnerSpace(database);
  migrateSchedulerActionSnapshotMetadata(database);
  migrateSchedulerActionSnapshotOwnerSpaceKey(database);
  migrateSchedulerActionStateOwnerSpaceKey(database);
  migrateSchedulerActionIndexes(database);
  migrateSchedulerObservationReplayStatus(database);
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
    default:
      // `sqlite` ops are never stored as revisions; unreachable.
      throw new Error(`unexpected stored revision op: ${row.op}`);
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
  const payload = encodeSchedulerDependencySnapshot(observation);
  const actionKey = {
    branch,
    ownerSpace: observation.ownerSpace,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
  };
  const latest = selectSchedulerSnapshotRow(engine, actionKey);
  const payloadChanged = latest?.payload !== payload;
  const observationId = latest?.observation_id ??
    insertSchedulerObservationRow(engine, {
      branch,
      commitSeq: options.commitSeq ?? null,
      observedAtSeq: options.observedAtSeq,
      observation,
      payload,
    });
  if (latest && payloadChanged) {
    updateSchedulerObservationRow(engine, {
      observationId,
      commitSeq: options.commitSeq ?? null,
      observedAtSeq: options.observedAtSeq,
      observation,
      payload,
    });
  }

  if (payloadChanged) {
    reconcileSchedulerReadRows(engine, {
      branch,
      observationId,
      observation,
    });
    reconcileSchedulerWriteRows(engine, {
      branch,
      observationId,
      observation,
    });
  }
  upsertSchedulerSnapshot(engine, {
    branch,
    observationId,
    commitSeq: options.commitSeq ?? null,
    observedAtSeq: options.observedAtSeq,
    payload,
    observation,
  });
  upsertSchedulerActionState(engine, {
    branch,
    observation,
    latestObservationId: observationId,
  });
  if (options.sessionId !== undefined && options.localSeq !== undefined) {
    recordSchedulerObservationReplay(engine, {
      branch,
      sessionId: options.sessionId,
      localSeq: options.localSeq,
      status: "kept",
      observationId,
      observedAtSeq: options.observedAtSeq,
      payload,
    });
  }

  return {
    observationId,
    commitSeq: options.commitSeq ?? null,
  };
};

export const getLatestSchedulerActionSnapshot = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): SchedulerObservationSnapshot | undefined => {
  const row = engine.database.prepare(`
    SELECT
      s.observation_id,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    WHERE s.branch = :branch
      AND s.owner_space = :owner_space
      AND s.piece_id = :piece_id
      AND s.process_generation = :process_generation
      AND s.action_id = :action_id
  `).get({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: normalizeSchedulerOwnerSpace(options.ownerSpace),
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
    observation: decodeSchedulerSnapshotObservation(
      row.payload,
      row.observed_at_seq,
    ),
  };
};

export const listSchedulerActionSnapshots = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    pieceId?: string;
    processGeneration?: number;
    actionId?: string;
    limit?: number;
    cursor?: SchedulerActionSnapshotCursor;
  } = {},
): SchedulerObservationSnapshotPage => {
  const limit = clampSchedulerSnapshotListLimit(options.limit);
  const cursorOwnerSpace = options.cursor
    ? normalizeSchedulerOwnerSpace(options.cursor.ownerSpace)
    : null;
  const rows = engine.database.prepare(`
    SELECT
      s.owner_space,
      s.piece_id,
      s.process_generation,
      s.action_id,
      s.observation_id,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload,
      a.direct_dirty_seq,
      a.stale_seq,
      a.unknown_reason
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    LEFT JOIN scheduler_action_state a
      ON a.branch = s.branch
      AND a.owner_space = s.owner_space
      AND a.piece_id = s.piece_id
      AND a.process_generation = s.process_generation
      AND a.action_id = s.action_id
    WHERE s.branch = :branch
      AND (:owner_space IS NULL OR s.owner_space = :owner_space)
      AND (:piece_id IS NULL OR s.piece_id = :piece_id)
      AND (
        :process_generation IS NULL OR
        s.process_generation = :process_generation
      )
      AND (:action_id IS NULL OR s.action_id = :action_id)
      AND (
        :cursor_owner_space IS NULL OR
        s.owner_space > :cursor_owner_space OR
        (
          s.owner_space = :cursor_owner_space AND
          s.piece_id > :cursor_piece_id
        ) OR
        (
          s.owner_space = :cursor_owner_space AND
          s.piece_id = :cursor_piece_id AND
          s.process_generation > :cursor_process_generation
        ) OR
        (
          s.owner_space = :cursor_owner_space AND
          s.piece_id = :cursor_piece_id AND
          s.process_generation = :cursor_process_generation AND
          s.action_id > :cursor_action_id
        )
      )
    ORDER BY s.owner_space, s.piece_id, s.process_generation, s.action_id
    LIMIT :limit_plus_one
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: options.ownerSpace !== undefined
      ? normalizeSchedulerOwnerSpace(options.ownerSpace)
      : null,
    piece_id: options.pieceId ?? null,
    process_generation: options.processGeneration ?? null,
    action_id: options.actionId ?? null,
    cursor_owner_space: cursorOwnerSpace,
    cursor_piece_id: options.cursor?.pieceId ?? null,
    cursor_process_generation: options.cursor?.processGeneration ?? null,
    cursor_action_id: options.cursor?.actionId ?? null,
    limit_plus_one: limit + 1,
  }) as {
    owner_space: string;
    piece_id: string;
    process_generation: number;
    action_id: string;
    observation_id: number;
    commit_seq: number | null;
    observed_at_seq: number;
    payload: string;
    direct_dirty_seq: number | null;
    stale_seq: number | null;
    unknown_reason: string | null;
  }[];

  const pageRows = rows.slice(0, limit);
  const snapshots = pageRows.map((row) => ({
    observationId: row.observation_id,
    commitSeq: row.commit_seq,
    observedAtSeq: row.observed_at_seq,
    observation: decodeSchedulerSnapshotObservation(
      row.payload,
      row.observed_at_seq,
    ),
    ...(row.direct_dirty_seq !== null
      ? { directDirtySeq: row.direct_dirty_seq }
      : {}),
    ...(row.stale_seq !== null ? { staleSeq: row.stale_seq } : {}),
    ...(row.unknown_reason !== null
      ? { unknownReason: row.unknown_reason }
      : {}),
  }));
  const lastRow = rows.length > limit ? pageRows.at(-1) : undefined;
  const nextOwnerSpace = lastRow
    ? denormalizeSchedulerOwnerSpace(lastRow.owner_space)
    : undefined;
  return {
    snapshots,
    ...(lastRow
      ? {
        nextCursor: {
          ...(nextOwnerSpace !== undefined
            ? { ownerSpace: nextOwnerSpace }
            : {}),
          pieceId: lastRow.piece_id,
          processGeneration: lastRow.process_generation,
          actionId: lastRow.action_id,
        },
      }
      : {}),
  };
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
    .map((row) => {
      const ownerSpace = denormalizeSchedulerOwnerSpace(
        row.owner_space ?? "",
      );
      return {
        branch: row.branch,
        ...(ownerSpace !== undefined ? { ownerSpace } : {}),
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
      };
    });
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
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): SchedulerActionState | undefined => {
  const row = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      latest_observation_id,
      direct_dirty_seq,
      stale_seq,
      unknown_reason
    FROM scheduler_action_state
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).get({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: normalizeSchedulerOwnerSpace(options.ownerSpace),
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
  }) as SchedulerActionStateRow | undefined;

  if (!row) return undefined;
  const ownerSpace = denormalizeSchedulerOwnerSpace(row.owner_space);
  return {
    branch: row.branch,
    ...(ownerSpace !== undefined ? { ownerSpace } : {}),
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
      owner_space,
      piece_id,
      process_generation,
      action_id,
      direct_dirty_seq
    )
    VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :direct_dirty_seq
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
    DO UPDATE SET
      direct_dirty_seq = CASE
        WHEN direct_dirty_seq IS NULL OR direct_dirty_seq < excluded.direct_dirty_seq
        THEN excluded.direct_dirty_seq
        ELSE direct_dirty_seq
      END
  `).run({
    branch: action.branch,
    owner_space: normalizeSchedulerOwnerSpace(action.ownerSpace),
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
      owner_space,
      piece_id,
      process_generation,
      action_id,
      stale_seq
    )
    VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :stale_seq
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
    DO UPDATE SET
      stale_seq = CASE
        WHEN stale_seq IS NULL OR stale_seq < excluded.stale_seq
        THEN excluded.stale_seq
        ELSE stale_seq
      END
  `).run({
    branch: action.branch,
    owner_space: normalizeSchedulerOwnerSpace(action.ownerSpace),
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
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND write_kind IN ('current-known', 'declared')
  `).all({
    branch: action.branch,
    owner_space: normalizeSchedulerOwnerSpace(action.ownerSpace),
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

type SchedulerWriteIndexRow = {
  branch: BranchName;
  owner_space: string;
  write_space: string;
  write_id: EntityId;
  write_scope: string;
  write_path: string;
  write_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  observation_id: number;
};

type SchedulerSnapshotRow = {
  observation_id: number;
  commit_seq: number | null;
  observed_at_seq: number;
  payload: string;
};

type SchedulerActionStateRow = {
  branch: BranchName;
  owner_space: string;
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
    ...(observation.currentKnownWrites
      ? {
        currentKnownWrites: observation.currentKnownWrites.map(
          normalizeSchedulerAddress,
        ),
      }
      : {}),
    ...(observation.declaredWrites
      ? {
        declaredWrites: observation.declaredWrites.map(
          normalizeSchedulerAddress,
        ),
      }
      : {}),
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

function normalizeSchedulerOwnerSpace(
  ownerSpace: string | null | undefined,
): string {
  return ownerSpace ?? "";
}

function denormalizeSchedulerOwnerSpace(
  ownerSpace: string,
): string | undefined {
  return ownerSpace === "" ? undefined : ownerSpace;
}

function clampSchedulerSnapshotListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SCHEDULER_SNAPSHOT_LIST_LIMIT;
  }
  return Math.max(
    1,
    Math.min(MAX_SCHEDULER_SNAPSHOT_LIST_LIMIT, Math.trunc(limit)),
  );
}

function encodeSchedulerDependencySnapshot(
  observation: SchedulerActionObservation,
): string {
  const { observedAtLocalSeq: _observedAtLocalSeq, ...stable } = observation;
  return encodeMemoryBoundary(
    {
      ...stable,
      observedAtSeq: 0,
      actualChangedWrites: [],
    } satisfies SchedulerActionObservation,
  );
}

function decodeSchedulerSnapshotObservation(
  payload: string,
  observedAtSeq: number,
): SchedulerActionObservation {
  return {
    ...decodeSchedulerObservation(payload),
    observedAtSeq,
    actualChangedWrites: [],
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

function selectSchedulerSnapshotRow(
  engine: Engine,
  key: {
    branch: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): SchedulerSnapshotRow | undefined {
  return engine.database.prepare(`
    SELECT
      s.observation_id,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    WHERE s.branch = :branch
      AND s.owner_space = :owner_space
      AND s.piece_id = :piece_id
      AND s.process_generation = :process_generation
      AND s.action_id = :action_id
  `).get({
    branch: key.branch,
    owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
  }) as SchedulerSnapshotRow | undefined;
}

class SchedulerObservationPersistenceError extends Error {
  override name = "SchedulerObservationPersistenceError";

  constructor(operation: string, cause: unknown) {
    super(`scheduler observation persistence failed during ${operation}`, {
      cause,
    });
  }
}

function runSchedulerObservationStatement<Result>(
  operation: string,
  run: () => Result,
): Result {
  try {
    return run();
  } catch (cause) {
    throw new SchedulerObservationPersistenceError(operation, cause);
  }
}

function insertSchedulerObservationRow(
  engine: Engine,
  options: {
    branch: BranchName;
    commitSeq: number | null;
    observedAtSeq: number;
    observation: SchedulerActionObservation;
    payload: string;
  },
): number {
  runSchedulerObservationStatement("insert observation row", () => {
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
      branch: options.branch,
      commit_seq: options.commitSeq,
      observed_at_seq: options.observedAtSeq,
      session_id: null,
      local_seq: null,
      piece_id: options.observation.pieceId,
      action_id: options.observation.actionId,
      process_generation: options.observation.processGeneration,
      payload: options.payload,
    });
  });
  const row = engine.database.prepare(`SELECT last_insert_rowid() AS id`)
    .get() as { id: number };
  return row.id;
}

function updateSchedulerObservationRow(
  engine: Engine,
  options: {
    observationId: number;
    commitSeq: number | null;
    observedAtSeq: number;
    observation: SchedulerActionObservation;
    payload: string;
  },
): void {
  runSchedulerObservationStatement("update observation row", () => {
    engine.database.prepare(`
      UPDATE scheduler_observation
      SET
        commit_seq = :commit_seq,
        observed_at_seq = :observed_at_seq,
        piece_id = :piece_id,
        action_id = :action_id,
        process_generation = :process_generation,
        payload = :payload
      WHERE observation_id = :observation_id
    `).run({
      observation_id: options.observationId ?? null,
      commit_seq: options.commitSeq,
      observed_at_seq: options.observedAtSeq,
      piece_id: options.observation.pieceId,
      action_id: options.observation.actionId,
      process_generation: options.observation.processGeneration,
      payload: options.payload,
    });
  });
}

function recordSchedulerObservationReplay(
  engine: Engine,
  options: {
    branch: BranchName;
    sessionId: SessionId;
    localSeq: number;
    status: AppliedSchedulerObservationResult["status"];
    reason?: AppliedSchedulerObservationResult["reason"];
    observationId?: number;
    observedAtSeq: number;
    payload: string;
  },
): void {
  runSchedulerObservationStatement("record observation replay", () => {
    engine.database.prepare(`
      INSERT INTO scheduler_observation_replay (
        branch,
        session_id,
        local_seq,
        status,
        reason,
        observation_id,
        observed_at_seq,
        payload
      )
      VALUES (
        :branch,
        :session_id,
        :local_seq,
        :status,
        :reason,
        :observation_id,
        :observed_at_seq,
        :payload
      )
      ON CONFLICT (branch, session_id, local_seq)
      DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        observation_id = excluded.observation_id,
        observed_at_seq = excluded.observed_at_seq,
        payload = excluded.payload
    `).run({
      branch: options.branch,
      session_id: options.sessionId,
      local_seq: options.localSeq,
      status: options.status,
      reason: options.reason ?? null,
      observation_id: options.observationId ?? null,
      observed_at_seq: options.observedAtSeq,
      payload: options.payload,
    });
  });
}

function getSchedulerObservationReplay(
  engine: Engine,
  options: {
    branch: BranchName;
    sessionId: SessionId;
    localSeq: number;
  },
): {
  status: AppliedSchedulerObservationResult["status"];
  reason: AppliedSchedulerObservationResult["reason"] | null;
  observation_id: number | null;
  observed_at_seq: number;
  payload: string;
} | undefined {
  return engine.database.prepare(`
    SELECT status, reason, observation_id, observed_at_seq, payload
    FROM scheduler_observation_replay
    WHERE branch = :branch
      AND session_id = :session_id
      AND local_seq = :local_seq
  `).get({
    branch: options.branch,
    session_id: options.sessionId,
    local_seq: options.localSeq,
  }) as {
    status: AppliedSchedulerObservationResult["status"];
    reason: AppliedSchedulerObservationResult["reason"] | null;
    observation_id: number | null;
    observed_at_seq: number;
    payload: string;
  } | undefined;
}

function upsertSchedulerSnapshot(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    commitSeq: number | null;
    observedAtSeq: number;
    payload: string;
    observation: SchedulerActionObservation;
  },
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      observation_id,
      commit_seq,
      observed_at_seq,
      payload
    )
    VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :observation_id,
      :commit_seq,
      :observed_at_seq,
      :payload
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
    DO UPDATE SET
      observation_id = excluded.observation_id,
      commit_seq = excluded.commit_seq,
      observed_at_seq = excluded.observed_at_seq,
      payload = excluded.payload
  `).run({
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    observation_id: options.observationId,
    commit_seq: options.commitSeq,
    observed_at_seq: options.observedAtSeq,
    payload: options.payload,
  });
}

function schedulerReadIndexEntries(
  branch: BranchName,
  observationId: number,
  observation: SchedulerActionObservation,
): SchedulerReadIndexRow[] {
  return [
    ...observation.reads.map((address) => ({
      address,
      kind: "recursive" as const,
    })),
    ...observation.shallowReads.map((address) => ({
      address,
      kind: "shallow" as const,
    })),
  ].map(({ address, kind }) => {
    const normalized = normalizeSchedulerAddress(address);
    return {
      branch,
      owner_space: normalizeSchedulerOwnerSpace(observation.ownerSpace),
      read_space: normalized.space,
      read_id: normalized.id,
      read_scope: normalizeSchedulerScope(normalized.scope),
      read_path: encodeSchedulerPath(normalized.path),
      read_kind: kind,
      piece_id: observation.pieceId,
      process_generation: observation.processGeneration,
      action_id: observation.actionId,
      observation_id: observationId,
    };
  });
}

function reconcileSchedulerIndexRows<Row>(
  options: {
    existingRows: Row[];
    nextRows: Row[];
    keyForRow: (row: Row) => string;
    deleteAllRows: () => void;
    deleteRow: (row: Row) => void;
    insertRow: (row: Row) => void;
  },
): void {
  const existingRowsByKey = new Map(options.existingRows.map((row) => [
    options.keyForRow(row),
    row,
  ]));
  const nextRowsByKey = new Map(options.nextRows.map((row) => [
    options.keyForRow(row),
    row,
  ]));

  const hasSharedKey = [...nextRowsByKey.keys()].some((key) =>
    existingRowsByKey.has(key)
  );
  if (!hasSharedKey && options.existingRows.length > 0) {
    options.deleteAllRows();
    existingRowsByKey.clear();
  }

  for (const [key, row] of existingRowsByKey) {
    if (!nextRowsByKey.has(key)) {
      options.deleteRow(row);
    }
  }

  for (const [key, row] of nextRowsByKey) {
    if (!existingRowsByKey.has(key)) {
      options.insertRow(row);
    }
  }
}

function reconcileSchedulerReadRows(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    observation: SchedulerActionObservation;
  },
): void {
  const params = {
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
  };
  const existingRows = engine.database.prepare(`
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
      AND COALESCE(owner_space, '') = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).all(params) as SchedulerReadIndexRow[];
  const nextRows = schedulerReadIndexEntries(
    options.branch,
    options.observationId,
    options.observation,
  );

  const deleteReadRow = engine.database.prepare(`
    DELETE FROM scheduler_read_index
    WHERE branch = :branch
      AND owner_space IS :owner_space
      AND read_space = :read_space
      AND read_id = :read_id
      AND read_scope = :read_scope
      AND read_path = :read_path
      AND read_kind = :read_kind
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `);

  const insertReadRow = engine.database.prepare(`
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
  `);
  reconcileSchedulerIndexRows({
    existingRows,
    nextRows,
    keyForRow: schedulerReadIndexKey,
    deleteAllRows: () => {
      engine.database.prepare(`
        DELETE FROM scheduler_read_index
        WHERE branch = :branch
          AND COALESCE(owner_space, '') = :owner_space
          AND piece_id = :piece_id
          AND process_generation = :process_generation
          AND action_id = :action_id
      `).run(params);
    },
    deleteRow: (row) => {
      deleteReadRow.run({
        branch: row.branch,
        owner_space: row.owner_space,
        read_space: row.read_space,
        read_id: row.read_id,
        read_scope: row.read_scope,
        read_path: row.read_path,
        read_kind: row.read_kind,
        piece_id: row.piece_id,
        process_generation: row.process_generation,
        action_id: row.action_id,
      });
    },
    insertRow: (row) => insertReadRow.run({ ...row }),
  });
}

function schedulerReadIndexKey(row: SchedulerReadIndexRow): string {
  return [
    row.branch,
    row.owner_space ?? "",
    row.read_space,
    row.read_id,
    row.read_scope,
    row.read_path,
    row.read_kind,
    row.piece_id,
    row.process_generation,
    row.action_id,
  ].join("\0");
}

function schedulerWriteIndexEntries(
  branch: BranchName,
  observationId: number,
  observation: SchedulerActionObservation,
): SchedulerWriteIndexRow[] {
  return [
    ...(observation.currentKnownWrites ?? []).map((address) => ({
      address,
      kind: "current-known" as const,
    })),
    ...(observation.declaredWrites ?? []).map((address) => ({
      address,
      kind: "declared" as const,
    })),
    ...observation.materializerWriteEnvelopes.map((address) => ({
      address,
      kind: "materializer" as const,
    })),
  ].map(({ address, kind }) => {
    const normalized = normalizeSchedulerAddress(address);
    return {
      branch,
      owner_space: normalizeSchedulerOwnerSpace(observation.ownerSpace),
      write_space: normalized.space,
      write_id: normalized.id,
      write_scope: normalizeSchedulerScope(normalized.scope),
      write_path: encodeSchedulerPath(normalized.path),
      write_kind: kind,
      piece_id: observation.pieceId,
      process_generation: observation.processGeneration,
      action_id: observation.actionId,
      observation_id: observationId,
    };
  });
}

function reconcileSchedulerWriteRows(
  engine: Engine,
  options: {
    branch: BranchName;
    observationId: number;
    observation: SchedulerActionObservation;
  },
): void {
  const params = {
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
  };
  const existingRows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      write_space,
      write_id,
      write_scope,
      write_path,
      write_kind,
      piece_id,
      process_generation,
      action_id,
      observation_id
    FROM scheduler_write_index
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `).all(params) as SchedulerWriteIndexRow[];
  const nextRows = schedulerWriteIndexEntries(
    options.branch,
    options.observationId,
    options.observation,
  );

  const deleteWriteRow = engine.database.prepare(`
    DELETE FROM scheduler_write_index
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND write_space = :write_space
      AND write_id = :write_id
      AND write_scope = :write_scope
      AND write_path = :write_path
      AND write_kind = :write_kind
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
  `);

  const insertWriteRow = engine.database.prepare(`
    INSERT INTO scheduler_write_index (
      branch,
      owner_space,
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
      :owner_space,
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
  `);
  reconcileSchedulerIndexRows({
    existingRows,
    nextRows,
    keyForRow: schedulerWriteIndexKey,
    deleteAllRows: () => {
      engine.database.prepare(`
        DELETE FROM scheduler_write_index
        WHERE branch = :branch
          AND owner_space = :owner_space
          AND piece_id = :piece_id
          AND process_generation = :process_generation
          AND action_id = :action_id
      `).run(params);
    },
    deleteRow: (row) => {
      deleteWriteRow.run({
        branch: row.branch,
        owner_space: row.owner_space,
        write_space: row.write_space,
        write_id: row.write_id,
        write_scope: row.write_scope,
        write_path: row.write_path,
        write_kind: row.write_kind,
        piece_id: row.piece_id,
        process_generation: row.process_generation,
        action_id: row.action_id,
      });
    },
    insertRow: (row) => insertWriteRow.run({ ...row }),
  });
}

function schedulerWriteIndexKey(row: SchedulerWriteIndexRow): string {
  return [
    row.branch,
    row.owner_space,
    row.write_space,
    row.write_id,
    row.write_scope,
    row.write_path,
    row.write_kind,
    row.piece_id,
    row.process_generation,
    row.action_id,
  ].join("\0");
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
      owner_space,
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
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :latest_observation_id,
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
    DO UPDATE SET
      latest_observation_id = excluded.latest_observation_id,
      direct_dirty_seq = NULL,
      stale_seq = NULL,
      unknown_reason = NULL
  `).run({
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
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
  const path = decodeMemoryBoundary(payload);
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
  ownerSpace?: string | null;
  pieceId: string;
  processGeneration: number;
  actionId: string;
}): string {
  return `${entry.branch}\0${
    normalizeSchedulerOwnerSpace(entry.ownerSpace)
  }\0${entry.pieceId}\0${entry.processGeneration}\0${entry.actionId}`;
}

const applyCommitTransaction = (
  engine: Engine,
  {
    sessionId,
    space,
    principal,
    commit,
    sqliteAttachments,
  }: ApplyCommitOptions,
): AppliedCommit => {
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  const schedulerObservation = commit
    .schedulerObservation as SchedulerActionObservation | undefined;
  const schedulerObservationBatch = commit.schedulerObservationBatch ?? [];
  const hasSchedulerObservationBatch = schedulerObservationBatch.length > 0;
  if (schedulerObservation && hasSchedulerObservationBatch) {
    throw new ProtocolError(
      "memory v2 commit cannot mix schedulerObservation and schedulerObservationBatch",
    );
  }
  if (commit.operations.length > 0 && hasSchedulerObservationBatch) {
    throw new ProtocolError(
      "memory v2 schedulerObservationBatch commits must not include semantic operations",
    );
  }
  const hasPreconditions = (commit.preconditions?.length ?? 0) > 0;
  if (
    commit.operations.length === 0 && !schedulerObservation &&
    !hasSchedulerObservationBatch && !hasPreconditions
  ) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  // Replay detection first: a commit this session already applied returns
  // its stored result without re-validating preconditions — re-checking
  // entity-absent against the state the original application created would
  // wrongly reject the replay. Observation-only commits keep their own
  // replay table and never insert here, so this is a no-op for them.
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

  // Preconditions gate every commit shape, including the observation-only
  // fast paths below — a descendant of an uncommitted origin must not
  // persist anything, observations included.
  validateCommitPreconditions(engine, sessionKey, branch, commit, {
    principal,
    sessionId,
  });

  if (commit.operations.length === 0 && hasSchedulerObservationBatch) {
    return applySchedulerObservationBatchCommit(engine, {
      sessionId,
      sessionKey,
      space,
      principal,
      branch,
      batch: schedulerObservationBatch,
    });
  }

  if (commit.operations.length === 0 && schedulerObservation) {
    return applySchedulerObservationOnlyCommit(engine, {
      sessionId,
      sessionKey,
      space,
      principal,
      branch,
      localSeq: commit.localSeq,
      reads: commit.reads,
      schedulerObservation,
    });
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
    if (operation.op === "sqlite") {
      // Execute the SQL inside this commit's transaction (atomic with the cell
      // ops). It is NOT an entity revision — do not push to `revisions[]` so the
      // revision/head/snapshot/dirty machinery never sees it.
      applySqliteOperation(engine, operation, sqliteAttachments, {
        principal,
        sessionId,
      });
      continue;
    }
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

/**
 * Apply a folded `sqlite` op inside the commit transaction. The target cell-db
 * must already be ATTACHed by the caller (server, before applyCommit) under the
 * alias in `attachments`; unqualified names in the SQL resolve to it. Throwing
 * here (e.g. the guard rejecting DDL, or a commit-time row-label violation)
 * rolls back the whole commit.
 */
const applySqliteOperation = (
  engine: Engine,
  op: SqliteOperation,
  attachments: ReadonlyMap<string, string> | undefined,
  commitScope: { principal?: string; sessionId: SessionId },
): void => {
  // The server attaches exactly one cell-db (under an alias) before applyCommit;
  // assert it's present, then run the statement UNQUALIFIED. Unqualified table
  // names resolve to that single attached db — the ≤1-cell-db-per-commit rule
  // (#attachCommitSqliteDbs) plus the core-table guard prevent ambiguity, so the
  // alias is not used to qualify the SQL here (only the presence matters).
  if (!attachments?.has(op.db.id)) {
    throw new ProtocolError(
      `sqlite op for db ${op.db.id} has no attachment (server must attach before applyCommit)`,
    );
  }
  // Plain guarded write — except when the db declares a per-row label rule, in
  // which case the affected rows are read back and re-derived through the
  // shared evaluator, rolling back the commit on any violation (CFC Phase 3.c;
  // see sqlite/commit-eval.ts).
  applySqliteCommitWrite(
    engine.database,
    resolveSqliteOpOwner(engine, op, commitScope),
  );
};

/**
 * Backfill `db.owner` (the `dbOwner()` evaluation input) for a rule-bearing
 * sqlite op that arrived without it — a pre-3.c client's `db.exec` never sent
 * the field, and its writes must not start failing on `dbOwner()` rules under
 * a server-first rolling upgrade. The db handle CELL (`op.db.id`) carries the
 * owner stamped at creation — the same value the read side resolves — so a
 * value read of the committed handle doc recovers it. The handle doc lives at
 * the db's DECLARED scope (`op.db.scope`), so the read is resolved with that
 * scope plus the commit's principal / session — a `user`/`session`-scoped
 * handle is missed by a default-scope read. Best-effort and fail-closed: a
 * missing doc / owner (or a scoped handle whose scope key can't be resolved,
 * e.g. an anonymous commit lacking a principal) leaves the op unchanged, and a
 * `dbOwner()` rule then refuses as before.
 */
const resolveSqliteOpOwner = (
  engine: Engine,
  op: SqliteOperation,
  commitScope: { principal?: string; sessionId: SessionId },
): SqliteOperation => {
  if (
    op.db.owner !== undefined || op.db.tables === undefined ||
    !Object.values(op.db.tables).some(tableDeclaresRowLabel)
  ) {
    return op;
  }
  // `resolveScopeKey` (inside `read`) throws for a user/session scope missing a
  // principal/session — a best-effort backfill must not abort the commit, so
  // fail closed to the unchanged op instead.
  let doc: EntityDocument | null;
  try {
    doc = read(engine, {
      id: op.db.id,
      scope: op.db.scope,
      principal: commitScope.principal,
      sessionId: commitScope.sessionId,
    });
  } catch {
    return op;
  }
  const owner = (doc?.value as { owner?: unknown } | undefined)?.owner;
  return typeof owner === "string" ? { ...op, db: { ...op.db, owner } } : op;
};

const writeOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    opIndex: number;
    // `sqlite` ops are handled in the apply loop (applySqliteOperation), never
    // here — they are not entity revisions.
    operation: Exclude<Operation, SqliteOperation>;
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

const validateCommitPreconditions = (
  engine: Engine,
  sessionKey: string,
  branch: BranchName,
  commit: ClientCommit,
  scopeContext: { principal?: string; sessionId: SessionId },
): void => {
  for (const precondition of commit.preconditions ?? []) {
    // Wire input: validate the shape deterministically so malformed entries
    // surface as ProtocolError instead of a TypeError-turned-TransactionError.
    if (
      precondition === null || typeof precondition !== "object" ||
      Array.isArray(precondition)
    ) {
      throw new ProtocolError("malformed commit precondition: not an object");
    }
    switch (precondition.kind) {
      case "origin-committed": {
        if (!Number.isInteger(precondition.originLocalSeq)) {
          throw new ProtocolError(
            "malformed origin-committed precondition: originLocalSeq must be an integer",
          );
        }
        // Same-session commits are applied in order, so the origin's fate is
        // decided when the follow-up arrives; an absent origin means rejection.
        const row = engine.statements.selectPendingResolution.get({
          session_id: sessionKey,
          local_seq: precondition.originLocalSeq,
        }) as { seq: number } | undefined;
        if (!row) {
          throw new PreconditionFailedError(
            "origin-committed",
            `origin commit not committed: localSeq ${precondition.originLocalSeq}`,
          );
        }
        break;
      }
      case "entity-absent": {
        const scopeKey = resolveScopeKey(precondition.scope, scopeContext);
        const existingSetOrDelete = engine.statements.selectSetDeleteConflict
          .get({
            branch,
            id: precondition.id,
            scope_key: scopeKey,
            after_seq: 0,
          }) as { seq: number } | undefined;
        if (existingSetOrDelete !== undefined) {
          throw new PreconditionFailedError(
            "receipt-exists",
            `entity-absent precondition target already exists: ${precondition.id}`,
          );
        }
        break;
      }
      default:
        throw new ProtocolError(
          `unsupported commit precondition: ${
            String((precondition as { kind?: unknown }).kind)
          }`,
        );
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
      read.nonRecursive ?? false,
    );
    if (conflictSeq !== null) {
      throw new ConflictError(
        `stale confirmed read: ${read.id} at seq ${read.seq} conflicted with seq ${conflictSeq}`,
        { of: read.id, seq: read.seq, conflictSeq },
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
      read.nonRecursive ?? false,
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
  // When true, treat `readPath` as a SHALLOW (shape-only) dependency — conflict
  // only with writes at-or-above it (patchOverlapsNonRecursiveRead). Tier-1
  // (set/delete) stays path-blind even for a shallow read: a whole-doc
  // replace/delete changes the container the shape read observed, so it must
  // still conflict. Only Tier-2 (patch) granularity is refined.
  nonRecursive: boolean = false,
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
    const patches = decodeStoredPatchList(conflict.data);
    const overlaps = nonRecursive
      ? patchOverlapsNonRecursiveRead(patches, readPath)
      : patchOverlapsRead(patches, readPath);
    if (overlaps) {
      return conflict.seq;
    }
  }

  return null;
};

type SchedulerObservationDropReason = NonNullable<
  AppliedSchedulerObservationResult["reason"]
>;

const schedulerObservationReadDropReason = (
  engine: Engine,
  {
    sessionKey,
    sessionId,
    principal,
    branch,
    reads,
  }: {
    sessionKey: string;
    sessionId: SessionId;
    principal: string | undefined;
    branch: BranchName;
    reads: ClientCommit["reads"];
  },
): SchedulerObservationDropReason | undefined => {
  for (const read of reads.confirmed) {
    const readBranch = read.branch ?? branch;
    ensureReadableBranch(engine, readBranch);
    const scopeKey = resolveScopeKey(read.scope, { principal, sessionId });
    const conflictSeq = findConflictSeq(
      engine,
      readBranch,
      read.id,
      scopeKey,
      read.seq,
      read.path,
      read.nonRecursive ?? false,
    );
    if (conflictSeq !== null) {
      return "stale-confirmed-read";
    }
  }

  const resolutions = new Map<number, { localSeq: number; seq: number }>();
  for (const read of reads.pending) {
    let resolution = resolutions.get(read.localSeq);
    if (!resolution) {
      const row = engine.statements.selectPendingResolution.get({
        session_id: sessionKey,
        local_seq: read.localSeq,
      }) as { seq: number } | undefined;
      if (!row) {
        return "pending-read-missing";
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
      read.nonRecursive ?? false,
    );
    if (conflictSeq !== null) {
      return "stale-pending-read";
    }
  }

  return undefined;
};

const replayedSchedulerObservationResult = (
  localSeq: number,
  replay: {
    status: AppliedSchedulerObservationResult["status"];
    reason: AppliedSchedulerObservationResult["reason"] | null;
    observation_id: number | null;
  },
): AppliedSchedulerObservationResult => {
  if (replay.status === "dropped") {
    return {
      localSeq,
      status: "dropped",
      reason: replay.reason ?? "stale-confirmed-read",
    };
  }
  if (replay.observation_id === null) {
    throw new ProtocolError(
      `kept scheduler observation replay missing observation id for localSeq ${localSeq}`,
    );
  }
  return {
    localSeq,
    status: "kept",
    schedulerObservationId: replay.observation_id,
  };
};

const schedulerObservationReplayPayload = (
  options: {
    branch: BranchName;
    observedAtSeq: number;
    ownerSpace?: string;
    observation: SchedulerActionObservation;
  },
): string =>
  encodeSchedulerDependencySnapshot(
    normalizeSchedulerObservation(
      options.observation,
      options.branch,
      options.observedAtSeq,
      options.ownerSpace,
    ),
  );

const applySchedulerObservationOnlyCommit = (
  engine: Engine,
  {
    sessionId,
    sessionKey,
    space,
    principal,
    branch,
    localSeq,
    reads,
    schedulerObservation,
  }: {
    sessionId: SessionId;
    sessionKey: string;
    space?: string;
    principal?: string;
    branch: BranchName;
    localSeq: number;
    reads: ClientCommit["reads"];
    schedulerObservation: SchedulerActionObservation;
  },
): AppliedCommit => {
  const observedAtSeq = headSeq(engine, branch);
  const replayPayload = schedulerObservationReplayPayload({
    branch,
    observedAtSeq,
    ownerSpace: space ?? schedulerObservation.ownerSpace,
    observation: schedulerObservation,
  });
  const existingReplay = getSchedulerObservationReplay(engine, {
    branch,
    sessionId: sessionKey,
    localSeq,
  });
  if (existingReplay) {
    if (existingReplay.payload !== replayPayload) {
      throw new ProtocolError(
        `scheduler observation replay mismatch for session ${sessionId} localSeq ${localSeq}`,
      );
    }
    const replayed = replayedSchedulerObservationResult(
      localSeq,
      existingReplay,
    );
    return {
      seq: existingReplay.observed_at_seq,
      branch,
      revisions: [],
      ...(replayed.schedulerObservationId !== undefined
        ? { schedulerObservationId: replayed.schedulerObservationId }
        : {}),
      schedulerObservationResults: [replayed],
    };
  }

  const dropReason = schedulerObservationReadDropReason(engine, {
    sessionKey,
    sessionId,
    principal,
    branch,
    reads,
  });
  if (dropReason) {
    recordSchedulerObservationReplay(engine, {
      branch,
      sessionId: sessionKey,
      localSeq,
      status: "dropped",
      reason: dropReason,
      observedAtSeq,
      payload: replayPayload,
    });
    return {
      seq: observedAtSeq,
      branch,
      revisions: [],
      schedulerObservationResults: [{
        localSeq,
        status: "dropped",
        reason: dropReason,
      }],
    };
  }

  const observationResult = upsertSchedulerObservationTransaction(engine, {
    branch,
    ownerSpace: space ?? schedulerObservation.ownerSpace,
    observedAtSeq,
    sessionId: sessionKey,
    localSeq,
    observation: schedulerObservation,
  });
  return {
    seq: observedAtSeq,
    branch,
    revisions: [],
    schedulerObservationId: observationResult.observationId,
    schedulerObservationResults: [{
      localSeq,
      status: "kept",
      schedulerObservationId: observationResult.observationId,
    }],
  };
};

const applySchedulerObservationBatchCommit = (
  engine: Engine,
  {
    sessionId,
    sessionKey,
    space,
    principal,
    branch,
    batch,
  }: {
    sessionId: SessionId;
    sessionKey: string;
    space?: string;
    principal?: string;
    branch: BranchName;
    batch: NonNullable<ClientCommit["schedulerObservationBatch"]>;
  },
): AppliedCommit => {
  const results: AppliedSchedulerObservationResult[] = [];
  for (const item of batch) {
    const result = applySchedulerObservationOnlyCommit(engine, {
      sessionId,
      sessionKey,
      space,
      principal,
      branch,
      localSeq: item.localSeq,
      reads: item.reads,
      schedulerObservation: item
        .schedulerObservation as SchedulerActionObservation,
    });
    results.push(result.schedulerObservationResults![0]);
  }

  return {
    seq: headSeq(engine, branch),
    branch,
    revisions: [],
    schedulerObservationResults: results,
  };
};

// The COMMIT conflict matcher uses LEAF-ONLY touched paths (no add/remove/move
// parent-path injection) — the same discipline `touchedLeafPathsForPatch`
// applies to the scheduler reader-dirty index (CT-1623), here extended to the
// commit-conflict path. For a recursive read the injected parent is REDUNDANT
// (bidirectional `pathsOverlap` already matches a container reader against the
// leaf write, since the container read is a prefix of the leaf) and HARMFUL (the
// parent prefix-matches every disjoint SIBLING reader — e.g. a distinct-key
// writer's own-key/diff and link-resolution reads — manufacturing the
// write-contention over-conflict). Same-key writes still conflict (the leaf
// exactly matches an own-key read) and whole-container readers still conflict
// (their read prefixes the leaf). Keyset/shape readers are matched separately by
// the nonRecursive path, which keeps the parent injection.
export const patchOverlapsRead = (
  patches: readonly PatchOp[],
  readPath: readonly string[],
): boolean => {
  return patches.some((patch) =>
    touchedLeafPathsForPatch(patch).some((path) => pathsOverlap(path, readPath))
  );
};

// Overlap test for a SHALLOW (nonRecursive / shape-only) read. A shape read at
// `readPath` observed the container's key-set / existence but not its descendants'
// deep values, so it conflicts only with a write touching `readPath` itself or an
// ANCESTOR of it — `isPrefixPath(touched, readPath)`. Here we DO use the
// parent-injecting `touchedPathsForPatch`: a key add/remove injects the patch's
// parent path, which equals `readPath` for a direct child mutation, so a keyset
// reader still conflicts with key add/remove (the shape it observed changed). A
// disjoint deep-value `replace` strictly BELOW `readPath` touches no ancestor, so
// it no longer over-conflicts. Strict subset of `patchOverlapsRead` ⇒ never a
// false-negative. (Recursive reads use the leaf-only `patchOverlapsRead` above.)
export const patchOverlapsNonRecursiveRead = (
  patches: readonly PatchOp[],
  readPath: readonly string[],
): boolean => {
  return patches.some((patch) =>
    touchedPathsForPatch(patch).some((path) => isPrefixPath(path, readPath))
  );
};

const touchedPathsForPatch = (patch: PatchOp): string[][] => {
  const leaves = touchedPointerPaths(patch);
  // Ops that change the parent container's key-set — the structural ops
  // (add/remove/move) and a mergeable op that materialized a previously-absent
  // path (its `createsKey` flag) — also touch the parent, so a shape-only
  // reader of the parent must be invalidated. Ops that only change a value at an
  // already-present path touch only the leaf/array path, which such a reader
  // already prefixes.
  return patchOpChangesParentKeySet(patch)
    ? [...leaves, ...leaves.map((path) => parentPath(path))]
    : leaves;
};

// The EXACT changed leaf paths of a patch — without the ancestor/parent paths
// that `touchedPathsForPatch` adds for add/remove/move. Used by BOTH the
// scheduler reader-dirty index (`schedulerWriteAddressesForRevisions`) and the
// commit-conflict matcher (`patchOverlapsRead`).
//
// `touchedPathsForPatch` emits a patch's parent path so that whole-container
// reads are invalidated when a key is added/removed. For structural-overlap
// matching that parent path is both REDUNDANT and HARMFUL:
//   - Redundant: bidirectional prefix overlap already matches a reader of the
//     container (e.g. read `["value"]`) against the LEAF write
//     (e.g. `["value","plusOne"]`) — the container read is a prefix of the leaf —
//     so shape/whole-object readers are caught by the leaf alone.
//   - Harmful: the parent write (e.g. `["value"]`) ALSO prefix-matches every
//     disjoint SIBLING reader (`["value","doubled"]`, ...), whose value did not
//     change. The structural match has no way to tell the sibling is unchanged,
//     so it over-fires: spurious reload re-runs for the scheduler index
//     (CT-1623), and spurious commit conflicts for distinct-key writers (the
//     write-contention drops). Emitting only the leaf paths keeps every correct
//     match and drops the spurious sibling match. Keyset/shape (nonRecursive)
//     readers, which DO need to see key add/remove, are matched by a separate
//     path that retains `touchedPathsForPatch`'s parent injection.
const touchedLeafPathsForPatch = (patch: PatchOp): string[][] =>
  touchedPointerPaths(patch);

const schedulerWriteAddressesForRevisions = (
  space: string,
  revisions: readonly AppliedRevision[],
): SchedulerObservationAddress[] => {
  const writes = new Map<string, SchedulerObservationAddress>();
  for (const revision of revisions) {
    const paths = revision.op === "patch" && revision.patches
      ? revision.patches.flatMap(touchedLeafPathsForPatch)
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
  const parsed = decodeMemoryBoundary(data ?? "null");
  if (!isEntityDocument(parsed)) {
    throw new Error("memory v2 stored documents must be plain object roots");
  }
  return parsed;
};

const decodeStoredPatchList = (data: string | null): PatchOp[] => {
  const parsed = decodeMemoryBoundary(data ?? "[]");
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
