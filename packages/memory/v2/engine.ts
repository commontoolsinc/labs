import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/api";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { applySqliteCommitWrite } from "./sqlite/commit-eval.ts";
import {
  applyPatch,
  patchOpChangesParentKeySet,
  touchedPointerPaths,
} from "./patch.ts";
import { isPrefixPath, parentPath, pathsOverlap } from "./path.ts";
import {
  type AcceptedCommitSeq,
  type ActionExecutionProvenance,
  type BranchName,
  type CellScope,
  type ClientCommit,
  commitPreconditionValueHash,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  type ExecutionClaim,
  type ExecutionClaimAssertion,
  type ExecutionLease,
  type InputBasisSeq,
  isEntityDocument,
  type LegacyBackgroundExclusion,
  type LegacyBackgroundExclusionStatus,
  type Operation,
  type PatchOp,
  type Reference,
  type SchedulerActionSnapshotCursor,
  type SchedulerExecutionContextKey,
  type SessionId,
  type SqliteOperation,
  tableDeclaresRowLabel,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "../v2.ts";

export type { SchedulerExecutionContextKey } from "../v2.ts";

const DEFAULT_SCOPE: CellScope = "space";
const DEFAULT_SCOPE_KEY = "space" as const;
const DEFAULT_SCHEDULER_SNAPSHOT_LIST_LIMIT = 500;
const MAX_SCHEDULER_SNAPSHOT_LIST_LIMIT = 1_000;
// Exact-session observations are conservative caches: dropping one only makes
// that session run fresh. Bound them per principal/action so abandoned restart
// sessions cannot grow the cross-space read-index fanout without limit.
const MAX_RETAINED_SCHEDULER_SESSION_CONTEXTS_PER_ACTION = 32;

export interface SchedulerScopeContext {
  principal: string;
  sessionId: SessionId;
}

export type SchedulerActionSnapshotCursorWithContext =
  & SchedulerActionSnapshotCursor
  & { executionContextKey: SchedulerExecutionContextKey };

const normalizeScope = (scope: CellScope | undefined): CellScope =>
  scope ?? DEFAULT_SCOPE;

const encodeScopeKeyPart = (value: string): string => encodeURIComponent(value);

const resolvePrincipalSessionKey = (
  principal: string,
  sessionId: SessionId,
): string =>
  `session:${encodeScopeKeyPart(principal)}:${encodeScopeKeyPart(sessionId)}`;

export const resolveCommitSessionKey = (
  sessionId: SessionId,
  principal?: string,
): string =>
  principal ? resolvePrincipalSessionKey(principal, sessionId) : sessionId;

// Principal segment of a stored commit/observation session key
// (`session:<principal>:<sessionId>` per resolvePrincipalSessionKey).
// Principal-less sessions store the bare session id — no principal. The
// segments are encodeURIComponent-encoded, so splitting on ":" is exact.
export const principalOfSessionKey = (key: string): string | undefined => {
  if (!key.startsWith("session:")) return undefined;
  const parts = key.split(":");
  if (parts.length !== 3) return undefined;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
};

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

const SCHEDULER_ACTION_CAUSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_action_cause (
  branch                 TEXT    NOT NULL DEFAULT '',
  owner_space            TEXT    NOT NULL DEFAULT '',
  piece_id               TEXT    NOT NULL,
  process_generation     INTEGER NOT NULL,
  action_id              TEXT    NOT NULL,
  execution_context_key  TEXT    NOT NULL,
  source_seq             INTEGER NOT NULL,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key,
    source_seq
  ),
  CHECK (source_seq >= 0 AND source_seq <= 9007199254740991),
  FOREIGN KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  ) REFERENCES scheduler_action_state (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  ) ON DELETE CASCADE
);
`;

const SCHEDULER_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_observation (
  observation_id      INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  branch              TEXT    NOT NULL DEFAULT '',
  execution_context_key TEXT  NOT NULL,
  commit_seq          INTEGER,
  observed_at_seq     INTEGER NOT NULL DEFAULT 0,
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
    execution_context_key,
    observation_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_observation_id_context
  ON scheduler_observation (observation_id, execution_context_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_observation_session_local
  ON scheduler_observation (branch, session_id, local_seq)
  WHERE session_id IS NOT NULL AND local_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduler_action_snapshot (
  branch              TEXT    NOT NULL DEFAULT '',
  owner_space         TEXT    NOT NULL DEFAULT '',
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  execution_context_key TEXT  NOT NULL,
  observation_id      INTEGER NOT NULL,
  commit_seq          INTEGER,
  observed_at_seq     INTEGER NOT NULL DEFAULT 0,
  payload             JSON    NOT NULL,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  ),
  FOREIGN KEY (observation_id, execution_context_key)
    REFERENCES scheduler_observation(observation_id, execution_context_key)
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
  accepted_payload    JSON,
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
  read_scope_key      TEXT    NOT NULL,
  read_path           JSON    NOT NULL,
  read_kind           TEXT    NOT NULL,
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  execution_context_key TEXT  NOT NULL,
  observation_id      INTEGER NOT NULL,
  FOREIGN KEY (observation_id, execution_context_key)
    REFERENCES scheduler_observation(observation_id, execution_context_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_read_index_lookup
  ON scheduler_read_index (branch, read_space, read_id, read_scope_key);
CREATE INDEX IF NOT EXISTS idx_scheduler_read_index_action
  ON scheduler_read_index (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  );

CREATE TABLE IF NOT EXISTS scheduler_write_index (
  branch              TEXT    NOT NULL DEFAULT '',
  owner_space         TEXT    NOT NULL DEFAULT '',
  write_space         TEXT    NOT NULL,
  write_id            TEXT    NOT NULL,
  write_scope         TEXT    NOT NULL,
  write_scope_key     TEXT    NOT NULL,
  write_path          JSON    NOT NULL,
  write_kind          TEXT    NOT NULL,
  piece_id            TEXT    NOT NULL,
  process_generation  INTEGER NOT NULL,
  action_id           TEXT    NOT NULL,
  execution_context_key TEXT  NOT NULL,
  observation_id      INTEGER NOT NULL,
  FOREIGN KEY (observation_id, execution_context_key)
    REFERENCES scheduler_observation(observation_id, execution_context_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_write_index_lookup
  ON scheduler_write_index (branch, write_space, write_id, write_scope_key);
CREATE INDEX IF NOT EXISTS idx_scheduler_write_index_action
  ON scheduler_write_index (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  );

CREATE TABLE IF NOT EXISTS scheduler_action_state (
  branch                 TEXT    NOT NULL DEFAULT '',
  owner_space            TEXT    NOT NULL DEFAULT '',
  piece_id               TEXT    NOT NULL,
  process_generation     INTEGER NOT NULL,
  action_id              TEXT    NOT NULL,
  execution_context_key  TEXT    NOT NULL,
  latest_observation_id  INTEGER,
  direct_dirty_seq       INTEGER,
  stale_seq              INTEGER,
  unknown_reason         TEXT,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  ),
  FOREIGN KEY (latest_observation_id, execution_context_key)
    REFERENCES scheduler_observation(observation_id, execution_context_key)
);

${SCHEDULER_ACTION_CAUSE_SCHEMA}

CREATE TABLE IF NOT EXISTS scheduler_context_floor (
  branch                     TEXT NOT NULL DEFAULT '',
  owner_space                TEXT NOT NULL DEFAULT '',
  piece_id                   TEXT NOT NULL,
  process_generation         INTEGER NOT NULL,
  action_id                  TEXT NOT NULL,
  implementation_fingerprint TEXT NOT NULL,
  runtime_fingerprint        TEXT NOT NULL,
  principal_key              TEXT NOT NULL DEFAULT '',
  floor_scope                TEXT NOT NULL,
  PRIMARY KEY (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    implementation_fingerprint,
    runtime_fingerprint,
    principal_key
  ),
  CHECK (floor_scope IN ('space', 'user', 'session'))
);
`;

const INIT = (includeSchedulerSchema: boolean): string => `
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

CREATE TABLE IF NOT EXISTS execution_lease (
  branch                 TEXT    NOT NULL PRIMARY KEY,
  lease_generation       INTEGER NOT NULL,
  host_id                 TEXT    NOT NULL,
  on_behalf_of            TEXT    NOT NULL,
  state                   TEXT    NOT NULL,
  expires_at              REAL    NOT NULL,
  CHECK (lease_generation > 0),
  CHECK (state IN ('active', 'draining', 'revoked')),
  FOREIGN KEY (branch) REFERENCES branch(name)
);

CREATE TABLE IF NOT EXISTS legacy_background_exclusion (
  branch                 TEXT    NOT NULL PRIMARY KEY,
  exclusion_generation   INTEGER NOT NULL,
  holder_id              TEXT    NOT NULL,
  service_principal      TEXT    NOT NULL,
  expires_at             REAL    NOT NULL,
  CHECK (exclusion_generation > 0),
  FOREIGN KEY (branch) REFERENCES branch(name)
);

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

${includeSchedulerSchema ? SCHEDULER_SCHEMA : ""}

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

/**
 * Stable rejection for a claimed executor transaction whose exact lease or
 * claim authority is no longer current. Retrying the same attempt cannot
 * restore that incarnation; a later run must obtain fresh authority.
 */
export class ExecutionLeaseFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionLeaseFenceError";
  }
}

/**
 * Stable, terminal rejection from the claimed whole-action transaction
 * firewall. The host may use `diagnosticCode` to report an unserved attempt;
 * it must never retry only a subset of the rejected transaction.
 */
export class ExecutionActionFirewallError extends Error {
  readonly diagnosticCode: string;

  constructor(diagnosticCode: string, message: string) {
    super(`execution action firewall rejected ${diagnosticCode}: ${message}`);
    this.name = "ExecutionActionFirewallError";
    this.diagnosticCode = diagnosticCode;
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

export interface AcquireExecutionLeaseOptions {
  space: string;
  branch: BranchName;
  hostId: string;
  onBehalfOf: string;
  /** Sampled only after the IMMEDIATE transaction owns the SQLite lock. */
  nowMs: number | (() => number);
  ttlMs: number;
  /** Canonical fresh WRITE check, invoked inside the IMMEDIATE transaction. */
  authorizeWrite?: (engine: Engine) => boolean;
}

export interface CurrentExecutionLeaseOptions {
  space: string;
  branch: BranchName;
  nowMs: number | (() => number);
}

export interface RenewExecutionLeaseOptions {
  lease: ExecutionLease;
  /** Sampled only after the IMMEDIATE transaction owns the SQLite lock. */
  nowMs: number | (() => number);
  ttlMs: number;
  /** Canonical fresh WRITE check, invoked inside the IMMEDIATE transaction. */
  authorizeWrite?: (engine: Engine) => boolean;
}

export interface BeginExecutionLeaseDrainOptions {
  lease: ExecutionLease;
  nowMs: number | (() => number);
  drainTtlMs: number;
}

export interface RevokeExecutionLeaseOptions {
  lease: ExecutionLease;
  nowMs: number | (() => number);
}

export interface ExpireExecutionLeaseOptions {
  /** Expiry may revoke only this exact owner/generation. */
  lease: ExecutionLease;
  nowMs: number | (() => number);
}

export interface AcquireLegacyBackgroundExclusionOptions {
  space: string;
  branch: BranchName;
  holderId: string;
  servicePrincipal: string;
  /** Sampled only after the IMMEDIATE transaction owns the SQLite lock. */
  nowMs: number | (() => number);
  ttlMs: number;
  drainTtlMs: number;
  /** Canonical service-principal check inside the IMMEDIATE transaction. */
  authorizeService?: (engine: Engine) => boolean;
}

export interface CurrentLegacyBackgroundExclusionOptions {
  space: string;
  branch: BranchName;
  nowMs: number | (() => number);
}

export interface RenewLegacyBackgroundExclusionOptions {
  exclusion: LegacyBackgroundExclusion;
  nowMs: number | (() => number);
  ttlMs: number;
  drainTtlMs: number;
  authorizeService?: (engine: Engine) => boolean;
}

export interface ReleaseLegacyBackgroundExclusionOptions {
  exclusion: LegacyBackgroundExclusion;
  nowMs: number | (() => number);
  authorizeService?: (engine: Engine) => boolean;
}

/** Host-only authority checked against the durable row inside applyCommit. */
export interface ExecutionLeaseFence {
  lease: ExecutionLease;
  /** Sampled after BEGIN IMMEDIATE and the fresh authority callback. */
  nowMs: number | (() => number);
  /**
   * Canonical current WRITE and execution-policy check. It is invoked after
   * exact replay detection but before first-application mutation, inside the
   * same IMMEDIATE transaction.
   */
  authorize?: (engine: Engine) => boolean;
}

export interface ApplyCommitOptions {
  /** Actual request/replay identity for this protocol session. */
  sessionId: SessionId;
  /** Host-derived session used only to resolve PerSession scope. */
  scopeSessionId?: SessionId;
  space?: string;
  principal?: string;
  invocation?: InvocationRecord;
  invocationPayload?: FabricValue;
  authorization?: AuthorizationRecord;
  commit: ClientCommit;
  /**
   * Host-only exact live claims for scheduler observations in this commit,
   * keyed by the observation localSeq. This never appears in ClientCommit or
   * crosses the memory protocol boundary.
   */
  executionClaims?: ReadonlyMap<number, ExecutionClaim>;
  /**
   * Host-only durable authority for executor writes. Exact transaction
   * replays return before this fence; first applications validate it inside
   * the same immediate transaction as the data and scheduler writes.
   */
  executionLeaseFence?: ExecutionLeaseFence;
  /** Map of cell-db id -> attach alias for `sqlite` ops in this commit. The
   *  server attaches these BEFORE applyCommit (ATTACH can't run in a txn); the
   *  apply loop executes the SQL inside the commit's transaction against the
   *  alias. (docs/specs/sqlite-builtin/plans/atomic-writes.md) */
  sqliteAttachments?: ReadonlyMap<string, string>;
}

export interface AppliedRevision {
  id: EntityId;
  scope?: CellScope;
  scopeKey: string;
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
  /** Effective owner-derived context; emitted metadata, never client input. */
  executionContextKey?: SchedulerExecutionContextKey;
  /** Canonical accepted basis/provenance, emitted only for kept rows. */
  inputBasisSeq?: InputBasisSeq;
  executionProvenance?: ActionExecutionProvenance;
  reason?:
    | "stale-confirmed-read"
    | "stale-pending-read"
    | "pending-read-missing";
}

export type AppliedActionAttempt =
  | {
    localSeq: number;
    claim: ExecutionClaim;
    provenance: ActionExecutionProvenance;
    outcome: "committed";
    acceptedCommitSeq: AcceptedCommitSeq;
  }
  | {
    localSeq: number;
    claim: ExecutionClaim;
    provenance: ActionExecutionProvenance;
    outcome: "no-op" | "failed";
  }
  | {
    localSeq: number;
    claim: ExecutionClaim;
    provenance: ActionExecutionProvenance;
    outcome: "unserved";
    diagnosticCode: string;
  };

export interface AppliedCommit {
  seq: number;
  branch: BranchName;
  revisions: AppliedRevision[];
  schedulerObservationId?: number;
  schedulerObservationResults?: AppliedSchedulerObservationResult[];
  actionAttempts?: AppliedActionAttempt[];
  schedulerDirtiedReaders?: SchedulerReaderIndexEntry[];
}

// Replay status is process-local engine metadata, deliberately kept outside
// AppliedCommit's serialized shape. The canonical response to a replay stays
// byte-compatible while host-side post-commit feeds can avoid publishing the
// same accepted transaction twice.
const replayedAppliedCommits = new WeakSet<AppliedCommit>();

const markAppliedCommitReplay = (commit: AppliedCommit): AppliedCommit => {
  replayedAppliedCommits.add(commit);
  return commit;
};

export const isAppliedCommitReplay = (commit: AppliedCommit): boolean =>
  replayedAppliedCommits.has(commit);

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

export interface ResolvedSchedulerObservationAddress
  extends SchedulerObservationAddress {
  scopeKey: string;
}

export type SchedulerWriteAddress = SchedulerObservationAddress & {
  scopeKey?: string;
};

export interface CompleteActionScopeSummary {
  version: 1;
  complete: true;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  piece: SchedulerObservationAddress;
  reads: SchedulerObservationAddress[];
  writes: SchedulerObservationAddress[];
  materializerWriteEnvelopes: SchedulerObservationAddress[];
  directOutputs: SchedulerObservationAddress[];
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
  completeActionScopeSummary?: CompleteActionScopeSummary;
  observedAtSeq: number;
  /** Host-derived maximum accepted revision sequence in the commit read set. */
  inputBasisSeq?: InputBasisSeq;
  /** Transient exact-claim assertion; validated by the bound executor host. */
  executionClaimAssertion?: ExecutionClaimAssertion;
  /**
   * Transient report that the host discarded a claimed action as one whole
   * transaction. Valid only on an observation-only exact claimed attempt and
   * stripped before scheduler state is persisted.
   */
  executionUnservedAttempt?: { diagnosticCode: string };
  executionProvenance?: ActionExecutionProvenance;
  observedAtLocalSeq?: number;
  transactionKind: SchedulerObservationTransactionKind;
  reads: SchedulerObservationAddress[];
  shallowReads: SchedulerObservationAddress[];
  actualChangedWrites: SchedulerObservationAddress[];
  currentKnownWrites: SchedulerObservationAddress[];
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

const isSchedulerRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSchedulerExecutionContextKey = (
  value: unknown,
): value is SchedulerExecutionContextKey =>
  value === "space" ||
  (typeof value === "string" &&
    (/^user:[^:]+$/.test(value) || /^session:[^:]+:[^:]+$/.test(value)));

const isExecutionClaimAssertion = (
  value: unknown,
): value is ExecutionClaimAssertion =>
  isSchedulerRecord(value) &&
  isSchedulerExecutionContextKey(value.contextKey) &&
  Number.isSafeInteger(value.leaseGeneration) &&
  Number(value.leaseGeneration) > 0 &&
  Number.isSafeInteger(value.claimGeneration) &&
  Number(value.claimGeneration) > 0;

const isExecutionUnservedAttempt = (
  value: unknown,
): value is NonNullable<
  SchedulerActionObservation["executionUnservedAttempt"]
> =>
  isSchedulerRecord(value) &&
  typeof value.diagnosticCode === "string" &&
  value.diagnosticCode.length > 0 && value.diagnosticCode.length <= 256;

const isSchedulerObservationAddress = (value: unknown): boolean =>
  isSchedulerRecord(value) &&
  !("scopeKey" in value) &&
  !("scope_key" in value) &&
  !("readScopeKey" in value) &&
  !("writeScopeKey" in value) &&
  typeof value.space === "string" &&
  typeof value.id === "string" &&
  (value.scope === undefined || value.scope === "space" ||
    value.scope === "user" || value.scope === "session") &&
  Array.isArray(value.path) &&
  value.path.every((part) => typeof part === "string");

const isSchedulerAddressArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isSchedulerObservationAddress);

const isCompleteActionScopeSummary = (
  value: unknown,
  implementationFingerprint: unknown,
  runtimeFingerprint: unknown,
): boolean =>
  isSchedulerRecord(value) && value.version === 1 && value.complete === true &&
  value.implementationFingerprint === implementationFingerprint &&
  value.runtimeFingerprint === runtimeFingerprint &&
  isSchedulerObservationAddress(value.piece) &&
  isSchedulerAddressArray(value.reads) &&
  isSchedulerAddressArray(value.writes) &&
  isSchedulerAddressArray(value.materializerWriteEnvelopes) &&
  isSchedulerAddressArray(value.directOutputs);

export const schedulerObservationFromValue = (
  value: unknown,
): SchedulerActionObservation | undefined => {
  if (
    !isSchedulerRecord(value) ||
    "executionContextKey" in value ||
    "execution_context_key" in value ||
    (value.version !== 1 && value.version !== 2) ||
    (value.ownerSpace !== undefined && typeof value.ownerSpace !== "string") ||
    typeof value.branch !== "string" || typeof value.pieceId !== "string" ||
    typeof value.actionId !== "string" ||
    !Number.isSafeInteger(value.processGeneration) ||
    Number(value.processGeneration) < 0 ||
    (value.actionKind !== "computation" && value.actionKind !== "effect" &&
      value.actionKind !== "event-handler") ||
    typeof value.implementationFingerprint !== "string" ||
    typeof value.runtimeFingerprint !== "string" ||
    (value.completeActionScopeSummary !== undefined &&
      (value.version !== 2 ||
        !isCompleteActionScopeSummary(
          value.completeActionScopeSummary,
          value.implementationFingerprint,
          value.runtimeFingerprint,
        ))) ||
    !Number.isSafeInteger(value.observedAtSeq) ||
    Number(value.observedAtSeq) < 0 ||
    (value.inputBasisSeq !== undefined &&
      (!Number.isSafeInteger(value.inputBasisSeq) ||
        Number(value.inputBasisSeq) < 0)) ||
    (value.executionClaimAssertion !== undefined &&
      !isExecutionClaimAssertion(value.executionClaimAssertion)) ||
    (value.executionUnservedAttempt !== undefined &&
      !isExecutionUnservedAttempt(value.executionUnservedAttempt)) ||
    (value.observedAtLocalSeq !== undefined &&
      (!Number.isSafeInteger(value.observedAtLocalSeq) ||
        Number(value.observedAtLocalSeq) < 0)) ||
    (value.transactionKind !== "dependency-collection" &&
      value.transactionKind !== "action-run" &&
      value.transactionKind !== "event-preflight") ||
    !isSchedulerAddressArray(value.reads) ||
    !isSchedulerAddressArray(value.shallowReads) ||
    !isSchedulerAddressArray(value.actualChangedWrites) ||
    !isSchedulerAddressArray(value.currentKnownWrites) ||
    (value.declaredWrites === undefined
      ? value.version === 1
      : !isSchedulerAddressArray(value.declaredWrites)) ||
    !isSchedulerAddressArray(value.materializerWriteEnvelopes) ||
    (value.ignoredSchedulingWrites !== undefined &&
      !isSchedulerAddressArray(value.ignoredSchedulingWrites)) ||
    (value.actionOptions !== undefined &&
      (!isSchedulerRecord(value.actionOptions) ||
        (value.actionOptions.debounceMs !== undefined &&
          (typeof value.actionOptions.debounceMs !== "number" ||
            !Number.isFinite(value.actionOptions.debounceMs) ||
            value.actionOptions.debounceMs < 0)) ||
        (value.actionOptions.noDebounce !== undefined &&
          typeof value.actionOptions.noDebounce !== "boolean") ||
        (value.actionOptions.throttleMs !== undefined &&
          (typeof value.actionOptions.throttleMs !== "number" ||
            !Number.isFinite(value.actionOptions.throttleMs) ||
            value.actionOptions.throttleMs < 0)))) ||
    (value.status !== "success" && value.status !== "failed") ||
    (value.errorFingerprint !== undefined &&
      typeof value.errorFingerprint !== "string")
  ) {
    return undefined;
  }
  return value as unknown as SchedulerActionObservation;
};

export interface SchedulerObservationSnapshot {
  observationId: number;
  executionContextKey: SchedulerExecutionContextKey;
  commitSeq: number | null;
  observedAtSeq: number;
  observation: SchedulerActionObservation;
}

export interface SchedulerObservationSnapshotWithState
  extends SchedulerObservationSnapshot {
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
  // Session that persisted the observation. Execution-context filtering owns
  // isolation; this remains replay provenance and live-adoption echo metadata.
  writerSessionId?: string;
}

export interface SchedulerObservationSnapshotPage {
  snapshots: SchedulerObservationSnapshotWithState[];
  nextCursor?: SchedulerActionSnapshotCursorWithContext;
}

export interface SchedulerReaderIndexEntry {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
  observationId: number;
  readKind: "recursive" | "shallow";
  read: ResolvedSchedulerObservationAddress;
}

export type SchedulerWriteIndexKind =
  | "current-known"
  | "declared"
  | "materializer";

export type SchedulerWriterTarget = SchedulerObservationAddress & {
  scopeKey?: string;
};

export interface SchedulerMatchedWrite {
  kind: SchedulerWriteIndexKind;
  write: ResolvedSchedulerObservationAddress;
}

export interface SchedulerWriterCandidate {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  status: SchedulerActionObservation["status"];
  errorFingerprint?: string;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
  matchedWrites: SchedulerMatchedWrite[];
}

export interface SchedulerActionState {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
  latestObservationId: number | null;
  directDirtySeq: number | null;
  staleSeq: number | null;
  unknownReason: string | null;
}

/**
 * Host-only wake query over the durable scheduler projections.
 *
 * `demandedSchedulerPieceIds` contains canonical scheduler piece identities
 * (for example `space:of:...`), not raw execution-demand roots. The host owns
 * that normalization because raw demand remains a protocol granularity hint.
 */
export interface SchedulerStaleReadersForTargetsOptions {
  branch?: BranchName;
  ownerSpace: string;
  targets: readonly SchedulerWriteAddress[];
  demandedSchedulerPieceIds: readonly string[];
  applicableExecutionContextKeys?: readonly SchedulerExecutionContextKey[];
  /** Inclusive lower bound for direct-dirty and transitive-stale markers. */
  dirtySeq: number;
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

type ExecutionLeaseRow = {
  branch: string;
  lease_generation: number;
  host_id: string;
  on_behalf_of: string;
  state: ExecutionLease["state"];
  expires_at: number;
};

type LegacyBackgroundExclusionRow = {
  branch: string;
  exclusion_generation: number;
  holder_id: string;
  service_principal: string;
  expires_at: number;
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

const hasTable = (database: Database, table: string): boolean =>
  database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = :table
  `).get({ table }) !== undefined;

const CORE_SCHEDULER_TABLES = [
  "scheduler_observation",
  "scheduler_action_snapshot",
  "scheduler_observation_replay",
  "scheduler_read_index",
  "scheduler_write_index",
  "scheduler_action_state",
] as const;

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

const sameColumns = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((column, index) => column === expected[index]);

const hasExactIndex = (
  database: Database,
  table: string,
  index: string,
  columns: readonly string[],
  unique: boolean,
): boolean => {
  const definition = database.prepare(`PRAGMA index_list("${table}")`)
    .all() as Array<{ name: string; unique: number; partial: number }>;
  const match = definition.find((row) => row.name === index);
  return match !== undefined && match.unique === Number(unique) &&
    match.partial === 0 && sameColumns(indexColumns(database, index), columns);
};

type ForeignKeyShape = {
  table: string;
  from: string[];
  to: string[];
};

const foreignKeyShapes = (
  database: Database,
  table: string,
): ForeignKeyShape[] => {
  const rows = database.prepare(`PRAGMA foreign_key_list("${table}")`)
    .all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => {
      group.sort((left, right) => left.seq - right.seq);
      return {
        table: group[0].table,
        from: group.map((row) => row.from),
        to: group.map((row) => row.to),
      };
    });
};

const hasExactForeignKey = (
  database: Database,
  table: string,
  targetTable: string,
  from: readonly string[],
  to: readonly string[],
): boolean => {
  const shapes = foreignKeyShapes(database, table);
  return shapes.length === 1 && shapes[0].table === targetTable &&
    sameColumns(shapes[0].from, from) && sameColumns(shapes[0].to, to);
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

const migrateExecutionLeaseExpiry = (database: Database): void => {
  const column = (database.prepare(`PRAGMA table_info("execution_lease")`)
    .all() as Array<{ name: string; type: string }>).find((row) =>
      row.name === "expires_at"
    );
  if (column?.type.toUpperCase() === "REAL") return;
  database.exec(`
BEGIN TRANSACTION;

ALTER TABLE execution_lease RENAME TO execution_lease_expiry_migration;

CREATE TABLE execution_lease (
  branch                 TEXT NOT NULL PRIMARY KEY,
  lease_generation       INTEGER NOT NULL,
  host_id                 TEXT NOT NULL,
  on_behalf_of            TEXT NOT NULL,
  state                   TEXT NOT NULL,
  expires_at              REAL NOT NULL,
  CHECK (lease_generation > 0),
  CHECK (state IN ('active', 'draining', 'revoked')),
  FOREIGN KEY (branch) REFERENCES branch(name)
);

INSERT INTO execution_lease (
  branch,
  lease_generation,
  host_id,
  on_behalf_of,
  state,
  expires_at
)
SELECT
  branch,
  lease_generation,
  host_id,
  on_behalf_of,
  state,
  CAST(expires_at AS REAL)
FROM execution_lease_expiry_migration;

DROP TABLE execution_lease_expiry_migration;

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
  );
  const writeIndexHasOwnerSpace = indexColumns(
    database,
    "idx_scheduler_write_index_action",
  );
  if (
    readIndexHasOwnerSpace.includes("owner_space") &&
    readIndexHasOwnerSpace.includes("execution_context_key") &&
    writeIndexHasOwnerSpace.includes("owner_space") &&
    writeIndexHasOwnerSpace.includes("execution_context_key")
  ) {
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
    action_id,
    execution_context_key
  );

DROP INDEX IF EXISTS idx_scheduler_write_index_action;
CREATE INDEX idx_scheduler_write_index_action
  ON scheduler_write_index (
    branch,
    owner_space,
    piece_id,
    process_generation,
    action_id,
    execution_context_key
  );
`);
};

const migrateSchedulerWriteLookupIndex = (database: Database): void => {
  if (
    hasExactIndex(
      database,
      "scheduler_write_index",
      "idx_scheduler_write_index_lookup",
      ["branch", "write_space", "write_id", "write_scope_key"],
      false,
    )
  ) {
    return;
  }

  // This index is an additive target projection, not part of the scheduler
  // execution-context table contract. Repair it independently so adding or
  // correcting the index never triggers the conservative context-table
  // rebuild used for ownership/schema migrations.
  database.exec(`
DROP INDEX IF EXISTS idx_scheduler_write_index_lookup;
CREATE INDEX idx_scheduler_write_index_lookup
  ON scheduler_write_index (branch, write_space, write_id, write_scope_key);
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

const migrateSchedulerObservationReplayAcceptedPayload = (
  database: Database,
): void => {
  if (hasColumn(database, "scheduler_observation_replay", "accepted_payload")) {
    return;
  }
  database.exec(`
ALTER TABLE scheduler_observation_replay
ADD COLUMN accepted_payload JSON;
`);
};

const migrateSchedulerActionCauseSchema = (database: Database): void => {
  database.exec(SCHEDULER_ACTION_CAUSE_SCHEMA);
};

const SCHEDULER_ACTION_OWNERSHIP_COLUMNS = [
  "branch",
  "owner_space",
  "piece_id",
  "process_generation",
  "action_id",
  "execution_context_key",
] as const;

const SCHEDULER_CONTEXT_FLOOR_COLUMNS = [
  "branch",
  "owner_space",
  "piece_id",
  "process_generation",
  "action_id",
  "implementation_fingerprint",
  "runtime_fingerprint",
  "principal_key",
] as const;

export const schedulerExecutionContextSchemaCurrent = (
  database: Database,
): boolean =>
  hasColumn(database, "scheduler_observation", "execution_context_key") &&
  hasColumn(database, "scheduler_action_snapshot", "execution_context_key") &&
  hasColumn(database, "scheduler_read_index", "execution_context_key") &&
  hasColumn(database, "scheduler_read_index", "read_scope_key") &&
  hasColumn(database, "scheduler_write_index", "execution_context_key") &&
  hasColumn(database, "scheduler_write_index", "write_scope_key") &&
  hasColumn(database, "scheduler_action_state", "execution_context_key") &&
  hasColumn(database, "scheduler_context_floor", "floor_scope") &&
  sameColumns(
    primaryKeyColumns(database, "scheduler_action_snapshot"),
    SCHEDULER_ACTION_OWNERSHIP_COLUMNS,
  ) &&
  sameColumns(
    primaryKeyColumns(database, "scheduler_action_state"),
    SCHEDULER_ACTION_OWNERSHIP_COLUMNS,
  ) &&
  sameColumns(
    primaryKeyColumns(database, "scheduler_context_floor"),
    SCHEDULER_CONTEXT_FLOOR_COLUMNS,
  ) &&
  hasExactIndex(
    database,
    "scheduler_observation",
    "idx_scheduler_observation_id_context",
    ["observation_id", "execution_context_key"],
    true,
  ) &&
  hasExactIndex(
    database,
    "scheduler_read_index",
    "idx_scheduler_read_index_lookup",
    ["branch", "read_space", "read_id", "read_scope_key"],
    false,
  ) &&
  hasExactIndex(
    database,
    "scheduler_read_index",
    "idx_scheduler_read_index_action",
    SCHEDULER_ACTION_OWNERSHIP_COLUMNS,
    false,
  ) &&
  hasExactIndex(
    database,
    "scheduler_write_index",
    "idx_scheduler_write_index_action",
    SCHEDULER_ACTION_OWNERSHIP_COLUMNS,
    false,
  ) &&
  hasExactForeignKey(
    database,
    "scheduler_action_snapshot",
    "scheduler_observation",
    ["observation_id", "execution_context_key"],
    ["observation_id", "execution_context_key"],
  ) &&
  hasExactForeignKey(
    database,
    "scheduler_read_index",
    "scheduler_observation",
    ["observation_id", "execution_context_key"],
    ["observation_id", "execution_context_key"],
  ) &&
  hasExactForeignKey(
    database,
    "scheduler_write_index",
    "scheduler_observation",
    ["observation_id", "execution_context_key"],
    ["observation_id", "execution_context_key"],
  ) &&
  hasExactForeignKey(
    database,
    "scheduler_action_state",
    "scheduler_observation",
    ["latest_observation_id", "execution_context_key"],
    ["observation_id", "execution_context_key"],
  );

type SchedulerMigrationCandidate = {
  branch: BranchName;
  owner_space: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  observation_id: number;
  qualified_context_schema: number;
  snapshot_execution_context_key: SchedulerExecutionContextKey | null;
  observation_execution_context_key: SchedulerExecutionContextKey | null;
  state_execution_context_key: SchedulerExecutionContextKey | null;
  snapshot_commit_seq: number | null;
  snapshot_observed_at_seq: number;
  snapshot_payload: string;
  observation_branch: BranchName;
  observation_piece_id: string;
  observation_process_generation: number;
  observation_action_id: string;
  observation_commit_seq: number | null;
  observation_observed_at_seq: number;
  observation_payload: string;
  session_id: string | null;
  local_seq: number | null;
  created_at: string;
  latest_observation_id: number | null;
  direct_dirty_seq: number | null;
  stale_seq: number | null;
  unknown_reason: string | null;
  snapshot_reference_count: number;
  state_reference_count: number;
  replay_identity_count: number;
  observation_commit_valid: number;
};

const schedulerMigrationCandidates = (
  database: Database,
): SchedulerMigrationCandidate[] => {
  const contextColumnsPresent = [
    ["scheduler_action_snapshot", "execution_context_key"],
    ["scheduler_observation", "execution_context_key"],
    ["scheduler_action_state", "execution_context_key"],
  ].map(([table, column]) => hasColumn(database, table, column));
  const anyContextColumn = contextColumnsPresent.some(Boolean);
  const qualifiedContextSchema = contextColumnsPresent.every(Boolean);
  // A mixed ownership tuple cannot prove either legacy-unqualified or
  // context-qualified identity. Drop all active candidates and run fresh.
  if (anyContextColumn && !qualifiedContextSchema) return [];

  const contextColumns = qualifiedContextSchema
    ? `
      1 AS qualified_context_schema,
      s.execution_context_key AS snapshot_execution_context_key,
      o.execution_context_key AS observation_execution_context_key,
      a.execution_context_key AS state_execution_context_key,`
    : `
      0 AS qualified_context_schema,
      NULL AS snapshot_execution_context_key,
      NULL AS observation_execution_context_key,
      NULL AS state_execution_context_key,`;

  return database.prepare(`
    SELECT
      s.branch,
      s.owner_space,
      s.piece_id,
      s.process_generation,
      s.action_id,
      s.observation_id,
      ${contextColumns}
      s.commit_seq AS snapshot_commit_seq,
      s.observed_at_seq AS snapshot_observed_at_seq,
      s.payload AS snapshot_payload,
      o.branch AS observation_branch,
      o.piece_id AS observation_piece_id,
      o.process_generation AS observation_process_generation,
      o.action_id AS observation_action_id,
      o.commit_seq AS observation_commit_seq,
      o.observed_at_seq AS observation_observed_at_seq,
      o.payload AS observation_payload,
      o.session_id,
      o.local_seq,
      o.created_at,
      a.latest_observation_id,
      a.direct_dirty_seq,
      a.stale_seq,
      a.unknown_reason,
      (
        SELECT COUNT(*)
        FROM scheduler_action_snapshot duplicate_snapshot
        WHERE duplicate_snapshot.observation_id = s.observation_id
      ) AS snapshot_reference_count,
      (
        SELECT COUNT(*)
        FROM scheduler_action_state duplicate_state
        WHERE duplicate_state.latest_observation_id = s.observation_id
      ) AS state_reference_count,
      CASE
        WHEN o.session_id IS NULL OR o.local_seq IS NULL THEN 1
        ELSE (
          SELECT COUNT(*)
          FROM scheduler_observation replay_peer
          WHERE replay_peer.branch = o.branch
            AND replay_peer.session_id = o.session_id
            AND replay_peer.local_seq = o.local_seq
        )
      END AS replay_identity_count,
      CASE
        WHEN o.commit_seq IS NULL OR EXISTS (
          SELECT 1
          FROM "commit" commit_row
          WHERE commit_row.seq = o.commit_seq
        ) THEN 1
        ELSE 0
      END AS observation_commit_valid
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
    JOIN scheduler_action_state a
      ON a.branch = s.branch
      AND a.owner_space = s.owner_space
      AND a.piece_id = s.piece_id
      AND a.process_generation = s.process_generation
      AND a.action_id = s.action_id
      AND a.latest_observation_id = s.observation_id
  `).all() as SchedulerMigrationCandidate[];
};

function schedulerMigrationObservation(
  candidate: SchedulerMigrationCandidate,
): SchedulerActionObservation | undefined {
  try {
    if (
      (candidate.qualified_context_schema === 1 &&
        (candidate.snapshot_execution_context_key !== "space" ||
          candidate.observation_execution_context_key !== "space" ||
          candidate.state_execution_context_key !== "space")) ||
      candidate.observation_branch !== candidate.branch ||
      candidate.observation_piece_id !== candidate.piece_id ||
      candidate.observation_process_generation !==
        candidate.process_generation ||
      candidate.observation_action_id !== candidate.action_id ||
      candidate.observation_payload !== candidate.snapshot_payload ||
      candidate.snapshot_reference_count !== 1 ||
      candidate.state_reference_count !== 1 ||
      candidate.replay_identity_count !== 1 ||
      candidate.observation_commit_valid !== 1
    ) {
      return undefined;
    }
    const parsed = schedulerObservationFromValue(
      decodeMemoryBoundary(candidate.snapshot_payload),
    );
    if (
      !parsed ||
      parsed.branch !== candidate.branch ||
      normalizeSchedulerOwnerSpace(parsed.ownerSpace) !==
        candidate.owner_space ||
      parsed.pieceId !== candidate.piece_id ||
      parsed.processGeneration !== candidate.process_generation ||
      parsed.actionId !== candidate.action_id
    ) {
      return undefined;
    }
    const observation = normalizeSchedulerObservation(
      parsed,
      candidate.branch,
      candidate.snapshot_observed_at_seq,
      denormalizeSchedulerOwnerSpace(candidate.owner_space),
    );
    if (
      schedulerStaticContextFloor(observation) !== "space" ||
      schedulerRuntimeContextFloor(observation) !== "space"
    ) {
      return undefined;
    }
    return observation;
  } catch {
    return undefined;
  }
}

function restoreMigratedSchedulerCandidate(
  database: Database,
  candidate: SchedulerMigrationCandidate,
  observation: SchedulerActionObservation,
): void {
  const executionContextKey = "space" as const;
  database.prepare(`
    INSERT INTO scheduler_observation (
      observation_id,
      branch,
      execution_context_key,
      commit_seq,
      observed_at_seq,
      session_id,
      local_seq,
      piece_id,
      action_id,
      process_generation,
      payload,
      created_at
    ) VALUES (
      :observation_id,
      :branch,
      :execution_context_key,
      :commit_seq,
      :observed_at_seq,
      :session_id,
      :local_seq,
      :piece_id,
      :action_id,
      :process_generation,
      :payload,
      :created_at
    )
  `).run({
    observation_id: candidate.observation_id,
    branch: candidate.branch,
    execution_context_key: executionContextKey,
    commit_seq: candidate.observation_commit_seq,
    observed_at_seq: candidate.observation_observed_at_seq,
    session_id: candidate.session_id,
    local_seq: candidate.local_seq,
    piece_id: candidate.piece_id,
    action_id: candidate.action_id,
    process_generation: candidate.process_generation,
    payload: candidate.snapshot_payload,
    created_at: candidate.created_at,
  });
  database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id,
      commit_seq,
      observed_at_seq,
      payload
    ) VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      :observation_id,
      :commit_seq,
      :observed_at_seq,
      :payload
    )
  `).run({
    branch: candidate.branch,
    owner_space: candidate.owner_space,
    piece_id: candidate.piece_id,
    process_generation: candidate.process_generation,
    action_id: candidate.action_id,
    execution_context_key: executionContextKey,
    observation_id: candidate.observation_id,
    commit_seq: candidate.snapshot_commit_seq,
    observed_at_seq: candidate.snapshot_observed_at_seq,
    payload: candidate.snapshot_payload,
  });
  database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      latest_observation_id,
      direct_dirty_seq,
      stale_seq,
      unknown_reason
    ) VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      :latest_observation_id,
      :direct_dirty_seq,
      :stale_seq,
      :unknown_reason
    )
  `).run({
    branch: candidate.branch,
    owner_space: candidate.owner_space,
    piece_id: candidate.piece_id,
    process_generation: candidate.process_generation,
    action_id: candidate.action_id,
    execution_context_key: executionContextKey,
    latest_observation_id: candidate.latest_observation_id,
    direct_dirty_seq: candidate.direct_dirty_seq,
    stale_seq: candidate.stale_seq,
    unknown_reason: candidate.unknown_reason,
  });

  const migrationEngine = { database } as Engine;
  const migrationScopeContext: SchedulerScopeContext = {
    principal: "did:key:scheduler-migration",
    sessionId: "scheduler-migration",
  };
  reconcileSchedulerReadRows(migrationEngine, {
    branch: candidate.branch,
    observationId: candidate.observation_id,
    observation,
    executionContextKey,
    scopeContext: migrationScopeContext,
  });
  reconcileSchedulerWriteRows(migrationEngine, {
    branch: candidate.branch,
    observationId: candidate.observation_id,
    observation,
    executionContextKey,
    scopeContext: migrationScopeContext,
  });
  upsertSchedulerContextFloor(
    migrationEngine,
    {
      branch: candidate.branch,
      ownerSpace: observation.ownerSpace,
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: observation.actionId,
      implementationFingerprint: observation.implementationFingerprint,
      runtimeFingerprint: observation.runtimeFingerprint,
    },
    "",
    "space",
  );
}

const migrateSchedulerExecutionContextSchema = (database: Database): void => {
  if (!CORE_SCHEDULER_TABLES.every((table) => hasTable(database, table))) {
    database.transaction(() => {
      database.exec(`
        DROP TABLE IF EXISTS scheduler_action_cause;
        DROP TABLE IF EXISTS scheduler_observation_replay;
        DROP TABLE IF EXISTS scheduler_read_index;
        DROP TABLE IF EXISTS scheduler_write_index;
        DROP TABLE IF EXISTS scheduler_action_state;
        DROP TABLE IF EXISTS scheduler_action_snapshot;
        DROP TABLE IF EXISTS scheduler_observation;
        DROP TABLE IF EXISTS scheduler_context_floor;
      `);
      database.exec(SCHEDULER_SCHEMA);
    }).immediate();
    return;
  }
  if (schedulerExecutionContextSchemaCurrent(database)) return;

  database.transaction(() => {
    const hadContextFloor = hasTable(database, "scheduler_context_floor");
    const candidates = schedulerMigrationCandidates(database)
      .map((candidate) => ({
        candidate,
        observation: schedulerMigrationObservation(candidate),
      }))
      .filter((entry): entry is {
        candidate: SchedulerMigrationCandidate;
        observation: SchedulerActionObservation;
      } => entry.observation !== undefined);

    database.exec(`
      DROP TABLE IF EXISTS scheduler_action_cause;
      DROP INDEX IF EXISTS idx_scheduler_observation_action;
      DROP INDEX IF EXISTS idx_scheduler_observation_id_context;
      DROP INDEX IF EXISTS idx_scheduler_observation_session_local;
      DROP INDEX IF EXISTS idx_scheduler_read_index_lookup;
      DROP INDEX IF EXISTS idx_scheduler_read_index_action;
      DROP INDEX IF EXISTS idx_scheduler_write_index_action;

      ALTER TABLE scheduler_observation
        RENAME TO scheduler_observation_context_migration;
      ALTER TABLE scheduler_action_snapshot
        RENAME TO scheduler_action_snapshot_context_migration;
      ALTER TABLE scheduler_observation_replay
        RENAME TO scheduler_observation_replay_context_migration;
      ALTER TABLE scheduler_read_index
        RENAME TO scheduler_read_index_context_migration;
      ALTER TABLE scheduler_write_index
        RENAME TO scheduler_write_index_context_migration;
      ALTER TABLE scheduler_action_state
        RENAME TO scheduler_action_state_context_migration;
      ${
      hadContextFloor
        ? `ALTER TABLE scheduler_context_floor
             RENAME TO scheduler_context_floor_context_migration;`
        : ""
    }
    `);
    database.exec(SCHEDULER_SCHEMA);

    for (const { candidate, observation } of candidates) {
      restoreMigratedSchedulerCandidate(database, candidate, observation);
    }

    database.exec(`
      DROP TABLE scheduler_observation_replay_context_migration;
      DROP TABLE scheduler_read_index_context_migration;
      DROP TABLE scheduler_write_index_context_migration;
      DROP TABLE scheduler_action_state_context_migration;
      DROP TABLE scheduler_action_snapshot_context_migration;
      DROP TABLE scheduler_observation_context_migration;
      DROP TABLE IF EXISTS scheduler_context_floor_context_migration;
    `);
  }).immediate();
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
  const schedulerSchemaExists = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'scheduler_%'
    LIMIT 1
  `).get() !== undefined;
  database.exec(INIT(!schedulerSchemaExists));
  migrateExecutionLeaseExpiry(database);
  migrateScopedEntityTables(database);
  const completeSchedulerSchema = CORE_SCHEDULER_TABLES.every((table) =>
    hasTable(database, table)
  );
  if (completeSchedulerSchema) {
    migrateSchedulerReadIndexOwnerSpace(database);
    migrateSchedulerWriteIndexOwnerSpace(database);
    migrateSchedulerActionSnapshotMetadata(database);
    migrateSchedulerActionSnapshotOwnerSpaceKey(database);
    migrateSchedulerActionStateOwnerSpaceKey(database);
    migrateSchedulerObservationReplayStatus(database);
  }
  migrateSchedulerExecutionContextSchema(database);
  migrateSchedulerActionCauseSchema(database);
  migrateSchedulerObservationReplayAcceptedPayload(database);
  migrateSchedulerWriteLookupIndex(database);
  migrateSchedulerActionIndexes(database);
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

const SELECT_EXECUTION_LEASE = `
SELECT
  branch,
  lease_generation,
  host_id,
  on_behalf_of,
  state,
  expires_at
FROM execution_lease
WHERE branch = :branch
`;

const UPSERT_EXECUTION_LEASE = `
INSERT INTO execution_lease (
  branch,
  lease_generation,
  host_id,
  on_behalf_of,
  state,
  expires_at
)
VALUES (
  :branch,
  :lease_generation,
  :host_id,
  :on_behalf_of,
  :state,
  CAST(:expires_at AS REAL)
)
ON CONFLICT (branch) DO UPDATE SET
  lease_generation = excluded.lease_generation,
  host_id = excluded.host_id,
  on_behalf_of = excluded.on_behalf_of,
  state = excluded.state,
  expires_at = excluded.expires_at
`;

const UPDATE_EXECUTION_LEASE = `
UPDATE execution_lease
SET state = :state,
    expires_at = CAST(:expires_at AS REAL)
WHERE branch = :branch
  AND lease_generation = :lease_generation
  AND host_id = :host_id
  AND on_behalf_of = :on_behalf_of
`;

const SELECT_LEGACY_BACKGROUND_EXCLUSION = `
SELECT
  branch,
  exclusion_generation,
  holder_id,
  service_principal,
  expires_at
FROM legacy_background_exclusion
WHERE branch = :branch
`;

const UPSERT_LEGACY_BACKGROUND_EXCLUSION = `
INSERT INTO legacy_background_exclusion (
  branch,
  exclusion_generation,
  holder_id,
  service_principal,
  expires_at
)
VALUES (
  :branch,
  :exclusion_generation,
  :holder_id,
  :service_principal,
  CAST(:expires_at AS REAL)
)
ON CONFLICT (branch) DO UPDATE SET
  exclusion_generation = excluded.exclusion_generation,
  holder_id = excluded.holder_id,
  service_principal = excluded.service_principal,
  expires_at = excluded.expires_at
`;

const UPDATE_LEGACY_BACKGROUND_EXCLUSION = `
UPDATE legacy_background_exclusion
SET expires_at = CAST(:expires_at AS REAL)
WHERE branch = :branch
  AND exclusion_generation = :exclusion_generation
  AND holder_id = :holder_id
  AND service_principal = :service_principal
`;

const assertLeaseClock = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
};

const sampleLeaseClock = (
  name: string,
  clock: number | (() => number),
): number => {
  const value = typeof clock === "function" ? clock() : clock;
  assertLeaseClock(name, value);
  return value;
};

const leaseExpiry = (nowMs: number, ttlMs: number): number => {
  assertLeaseClock("execution lease server time", nowMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("execution lease TTL must be a positive integer");
  }
  const expiresAt = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError("execution lease expiry must be a safe integer");
  }
  return expiresAt;
};

const assertLeaseIdentityPart = (name: string, value: string): void => {
  if (value.length === 0) {
    throw new TypeError(`execution lease ${name} must not be empty`);
  }
};

const assertLeaseSnapshot = (lease: ExecutionLease): void => {
  if (lease.version !== 1) {
    throw new TypeError("unsupported execution lease version");
  }
  assertLeaseIdentityPart("space", lease.space);
  assertLeaseIdentityPart("host id", lease.hostId);
  assertLeaseIdentityPart("principal", lease.onBehalfOf);
  if (
    !Number.isSafeInteger(lease.leaseGeneration) ||
    lease.leaseGeneration <= 0
  ) {
    throw new TypeError(
      "execution lease generation must be a positive integer",
    );
  }
  assertLeaseClock("execution lease expiry", lease.expiresAt);
  if (
    lease.state !== "active" && lease.state !== "draining" &&
    lease.state !== "revoked"
  ) {
    throw new TypeError("unsupported execution lease state");
  }
};

const selectExecutionLeaseRow = (
  engine: Engine,
  branch: BranchName,
): ExecutionLeaseRow | null =>
  (engine.database.prepare(SELECT_EXECUTION_LEASE).get({ branch }) as
    | ExecutionLeaseRow
    | undefined) ?? null;

const toExecutionLease = (
  space: string,
  row: ExecutionLeaseRow,
): ExecutionLease => ({
  version: 1,
  space,
  branch: row.branch,
  leaseGeneration: row.lease_generation,
  hostId: row.host_id,
  onBehalfOf: row.on_behalf_of,
  state: row.state,
  expiresAt: row.expires_at,
});

const leaseOwnerMatches = (
  row: ExecutionLeaseRow,
  expected: Pick<ExecutionLease, "leaseGeneration" | "hostId" | "onBehalfOf">,
): boolean =>
  row.lease_generation === expected.leaseGeneration &&
  row.host_id === expected.hostId &&
  row.on_behalf_of === expected.onBehalfOf;

const leaseIsLive = (row: ExecutionLeaseRow, nowMs: number): boolean =>
  (row.state === "active" || row.state === "draining") &&
  row.expires_at > nowMs;

const assertLegacyBackgroundExclusion = (
  exclusion: LegacyBackgroundExclusion,
): void => {
  if (exclusion.version !== 1) {
    throw new TypeError("unsupported legacy background exclusion version");
  }
  for (
    const [name, value] of [
      ["space", exclusion.space],
      ["holder id", exclusion.holderId],
      ["service principal", exclusion.servicePrincipal],
    ] as const
  ) {
    if (value.length === 0) {
      throw new TypeError(`legacy background exclusion ${name} is required`);
    }
  }
  if (
    !Number.isSafeInteger(exclusion.exclusionGeneration) ||
    exclusion.exclusionGeneration <= 0
  ) {
    throw new TypeError(
      "legacy background exclusion generation must be a positive integer",
    );
  }
  assertLeaseClock(
    "legacy background exclusion expiry",
    exclusion.expiresAt,
  );
};

const backgroundExclusionExpiry = (nowMs: number, ttlMs: number): number => {
  assertLeaseClock("legacy background exclusion server time", nowMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(
      "legacy background exclusion TTL must be a positive integer",
    );
  }
  const expiresAt = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError("legacy background exclusion expiry must be safe");
  }
  return expiresAt;
};

const selectLegacyBackgroundExclusionRow = (
  engine: Engine,
  branch: BranchName,
): LegacyBackgroundExclusionRow | null =>
  (engine.database.prepare(SELECT_LEGACY_BACKGROUND_EXCLUSION).get({
    branch,
  }) as LegacyBackgroundExclusionRow | undefined) ?? null;

const toLegacyBackgroundExclusion = (
  space: string,
  row: LegacyBackgroundExclusionRow,
): LegacyBackgroundExclusion => ({
  version: 1,
  space,
  branch: row.branch,
  exclusionGeneration: row.exclusion_generation,
  holderId: row.holder_id,
  servicePrincipal: row.service_principal,
  expiresAt: row.expires_at,
});

const backgroundExclusionOwnerMatches = (
  row: LegacyBackgroundExclusionRow,
  expected: Pick<
    LegacyBackgroundExclusion,
    "exclusionGeneration" | "holderId" | "servicePrincipal"
  >,
): boolean =>
  row.exclusion_generation === expected.exclusionGeneration &&
  row.holder_id === expected.holderId &&
  row.service_principal === expected.servicePrincipal;

const backgroundExclusionIsLive = (
  row: LegacyBackgroundExclusionRow,
  nowMs: number,
): boolean => row.expires_at > nowMs;

const drainClientLeaseForBackground = (
  engine: Engine,
  branch: BranchName,
  nowMs: number,
  drainTtlMs: number,
): number | undefined => {
  const current = selectExecutionLeaseRow(engine, branch);
  if (current === null || !leaseIsLive(current, nowMs)) return undefined;
  // Validate the configured local drain grace, but do not shorten the durable
  // row here. Another host can only enforce the expiry in the lease snapshot it
  // already holds; letting background execution become ready before that
  // advertised deadline could overlap its Worker and effect claims. A host
  // that owns this exact lease can still revoke it early after its pool has
  // stopped, while a remote/stale owner remains fenced by the original expiry.
  leaseExpiry(nowMs, drainTtlMs);
  const expiresAt = current.expires_at;
  engine.database.prepare(UPDATE_EXECUTION_LEASE).run({
    branch: current.branch,
    lease_generation: current.lease_generation,
    host_id: current.host_id,
    on_behalf_of: current.on_behalf_of,
    state: "draining",
    expires_at: String(expiresAt),
  });
  return expiresAt;
};

const branchIsActive = (engine: Engine, branch: BranchName): boolean => {
  const row = engine.statements.selectBranchStatus.get({ branch }) as
    | { status: string }
    | undefined;
  return row?.status === "active";
};

const acquireExecutionLeaseTransaction = (
  engine: Engine,
  options: AcquireExecutionLeaseOptions,
): ExecutionLease | null => {
  assertLeaseIdentityPart("space", options.space);
  assertLeaseIdentityPart("host id", options.hostId);
  assertLeaseIdentityPart("principal", options.onBehalfOf);
  ensureActiveBranch(engine, options.branch);
  if (options.authorizeWrite?.(engine) !== true) return null;
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const expiresAt = leaseExpiry(nowMs, options.ttlMs);

  const backgroundExclusion = selectLegacyBackgroundExclusionRow(
    engine,
    options.branch,
  );
  if (
    backgroundExclusion !== null &&
    backgroundExclusionIsLive(backgroundExclusion, nowMs)
  ) {
    return null;
  }

  const current = selectExecutionLeaseRow(engine, options.branch);
  if (current !== null && leaseIsLive(current, nowMs)) {
    if (
      current.host_id !== options.hostId ||
      current.on_behalf_of !== options.onBehalfOf
    ) {
      return null;
    }
    return toExecutionLease(options.space, current);
  }

  const leaseGeneration = (current?.lease_generation ?? 0) + 1;
  if (!Number.isSafeInteger(leaseGeneration)) {
    throw new TypeError("execution lease generation exhausted");
  }
  engine.database.prepare(UPSERT_EXECUTION_LEASE).run({
    branch: options.branch,
    lease_generation: leaseGeneration,
    host_id: options.hostId,
    on_behalf_of: options.onBehalfOf,
    state: "active",
    expires_at: String(expiresAt),
  });
  return {
    version: 1,
    space: options.space,
    branch: options.branch,
    leaseGeneration,
    hostId: options.hostId,
    onBehalfOf: options.onBehalfOf,
    state: "active",
    expiresAt,
  };
};

/** Acquire one durable branch/space lease with a monotonic fence generation. */
export const acquireExecutionLease = (
  engine: Engine,
  options: AcquireExecutionLeaseOptions,
): ExecutionLease | null =>
  engine.database.transaction(acquireExecutionLeaseTransaction).immediate(
    engine,
    options,
  );

const currentExecutionLeaseTransaction = (
  engine: Engine,
  options: CurrentExecutionLeaseOptions,
): ExecutionLease | null => {
  assertLeaseIdentityPart("space", options.space);
  if (!branchIsActive(engine, options.branch)) return null;
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const row = selectExecutionLeaseRow(engine, options.branch);
  return row !== null && leaseIsLive(row, nowMs)
    ? toExecutionLease(options.space, row)
    : null;
};

/** Return the unexpired active or draining durable lease for a branch. */
export const currentExecutionLease = (
  engine: Engine,
  options: CurrentExecutionLeaseOptions,
): ExecutionLease | null =>
  engine.database.transaction(currentExecutionLeaseTransaction).immediate(
    engine,
    options,
  );

const renewExecutionLeaseTransaction = (
  engine: Engine,
  options: RenewExecutionLeaseOptions,
): ExecutionLease | null => {
  assertLeaseSnapshot(options.lease);
  if (!branchIsActive(engine, options.lease.branch)) return null;
  if (options.authorizeWrite?.(engine) !== true) return null;
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const expiresAt = leaseExpiry(nowMs, options.ttlMs);
  const backgroundExclusion = selectLegacyBackgroundExclusionRow(
    engine,
    options.lease.branch,
  );
  if (
    backgroundExclusion !== null &&
    backgroundExclusionIsLive(backgroundExclusion, nowMs)
  ) {
    return null;
  }
  const current = selectExecutionLeaseRow(engine, options.lease.branch);
  if (
    current === null || current.state !== "active" ||
    current.expires_at <= nowMs ||
    !leaseOwnerMatches(current, options.lease)
  ) {
    return null;
  }
  engine.database.prepare(UPDATE_EXECUTION_LEASE).run({
    branch: current.branch,
    lease_generation: current.lease_generation,
    host_id: current.host_id,
    on_behalf_of: current.on_behalf_of,
    state: "active",
    expires_at: String(expiresAt),
  });
  return {
    ...toExecutionLease(options.lease.space, current),
    expiresAt,
  };
};

/** Renew an active lease from the supplied server time. */
export const renewExecutionLease = (
  engine: Engine,
  options: RenewExecutionLeaseOptions,
): ExecutionLease | null =>
  engine.database.transaction(renewExecutionLeaseTransaction).immediate(
    engine,
    options,
  );

const beginExecutionLeaseDrainTransaction = (
  engine: Engine,
  options: BeginExecutionLeaseDrainOptions,
): ExecutionLease | null => {
  assertLeaseSnapshot(options.lease);
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const drainDeadline = leaseExpiry(nowMs, options.drainTtlMs);
  const current = selectExecutionLeaseRow(engine, options.lease.branch);
  if (
    current === null || !leaseIsLive(current, nowMs) ||
    !leaseOwnerMatches(current, options.lease)
  ) {
    return null;
  }
  const expiresAt = Math.min(current.expires_at, drainDeadline);
  engine.database.prepare(UPDATE_EXECUTION_LEASE).run({
    branch: current.branch,
    lease_generation: current.lease_generation,
    host_id: current.host_id,
    on_behalf_of: current.on_behalf_of,
    state: "draining",
    expires_at: String(expiresAt),
  });
  return {
    ...toExecutionLease(options.lease.space, current),
    state: "draining",
    expiresAt,
  };
};

/** Stop issuing work and bound completion of already-started attempts. */
export const beginExecutionLeaseDrain = (
  engine: Engine,
  options: BeginExecutionLeaseDrainOptions,
): ExecutionLease | null =>
  engine.database.transaction(beginExecutionLeaseDrainTransaction).immediate(
    engine,
    options,
  );

const revokeExecutionLeaseTransaction = (
  engine: Engine,
  options: RevokeExecutionLeaseOptions,
): ExecutionLease | null => {
  assertLeaseSnapshot(options.lease);
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const current = selectExecutionLeaseRow(engine, options.lease.branch);
  if (current === null || !leaseOwnerMatches(current, options.lease)) {
    return null;
  }
  const expiresAt = Math.min(current.expires_at, nowMs);
  engine.database.prepare(UPDATE_EXECUTION_LEASE).run({
    branch: current.branch,
    lease_generation: current.lease_generation,
    host_id: current.host_id,
    on_behalf_of: current.on_behalf_of,
    state: "revoked",
    expires_at: String(expiresAt),
  });
  return {
    ...toExecutionLease(options.lease.space, current),
    state: "revoked",
    expiresAt,
  };
};

/** Revoke only the exact durable owner/generation named by the caller. */
export const revokeExecutionLease = (
  engine: Engine,
  options: RevokeExecutionLeaseOptions,
): ExecutionLease | null =>
  engine.database.transaction(revokeExecutionLeaseTransaction).immediate(
    engine,
    options,
  );

const expireExecutionLeaseTransaction = (
  engine: Engine,
  options: ExpireExecutionLeaseOptions,
): ExecutionLease | null => {
  assertLeaseSnapshot(options.lease);
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    options.nowMs,
  );
  const current = selectExecutionLeaseRow(engine, options.lease.branch);
  if (
    current === null || !leaseOwnerMatches(current, options.lease)
  ) return null;
  if (
    (current.state === "active" || current.state === "draining") &&
    current.expires_at > nowMs
  ) {
    return null;
  }
  if (current.state !== "revoked") {
    engine.database.prepare(UPDATE_EXECUTION_LEASE).run({
      branch: current.branch,
      lease_generation: current.lease_generation,
      host_id: current.host_id,
      on_behalf_of: current.on_behalf_of,
      state: "revoked",
      expires_at: String(current.expires_at),
    });
  }
  return {
    ...toExecutionLease(options.lease.space, current),
    state: "revoked",
  };
};

/** Mark an elapsed exact owner/generation revoked. */
export const expireExecutionLease = (
  engine: Engine,
  options: ExpireExecutionLeaseOptions,
): ExecutionLease | null =>
  engine.database.transaction(expireExecutionLeaseTransaction).immediate(
    engine,
    options,
  );

const acquireLegacyBackgroundExclusionTransaction = (
  engine: Engine,
  options: AcquireLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusionStatus | null => {
  assertLeaseIdentityPart("space", options.space);
  if (options.holderId.length === 0) {
    throw new TypeError("legacy background exclusion holder id is required");
  }
  if (options.servicePrincipal.length === 0) {
    throw new TypeError(
      "legacy background exclusion service principal is required",
    );
  }
  ensureActiveBranch(engine, options.branch);
  if (options.authorizeService?.(engine) !== true) return null;
  const nowMs = sampleLeaseClock(
    "legacy background exclusion server time",
    options.nowMs,
  );
  const expiresAt = backgroundExclusionExpiry(nowMs, options.ttlMs);
  const current = selectLegacyBackgroundExclusionRow(engine, options.branch);
  let exclusion: LegacyBackgroundExclusion;
  if (current !== null && backgroundExclusionIsLive(current, nowMs)) {
    if (
      current.holder_id !== options.holderId ||
      current.service_principal !== options.servicePrincipal
    ) {
      return null;
    }
    exclusion = toLegacyBackgroundExclusion(options.space, current);
  } else {
    const exclusionGeneration = (current?.exclusion_generation ?? 0) + 1;
    if (!Number.isSafeInteger(exclusionGeneration)) {
      throw new TypeError(
        "legacy background exclusion generation exhausted",
      );
    }
    engine.database.prepare(UPSERT_LEGACY_BACKGROUND_EXCLUSION).run({
      branch: options.branch,
      exclusion_generation: exclusionGeneration,
      holder_id: options.holderId,
      service_principal: options.servicePrincipal,
      expires_at: String(expiresAt),
    });
    exclusion = {
      version: 1,
      space: options.space,
      branch: options.branch,
      exclusionGeneration,
      holderId: options.holderId,
      servicePrincipal: options.servicePrincipal,
      expiresAt,
    };
  }
  const blockedUntil = drainClientLeaseForBackground(
    engine,
    options.branch,
    nowMs,
    options.drainTtlMs,
  );
  return {
    exclusion,
    serverTime: nowMs,
    ready: blockedUntil === undefined,
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
  };
};

/** Reserve one lane for legacy background execution and drain any client. */
export const acquireLegacyBackgroundExclusion = (
  engine: Engine,
  options: AcquireLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusionStatus | null =>
  engine.database.transaction(acquireLegacyBackgroundExclusionTransaction)
    .immediate(engine, options);

const currentLegacyBackgroundExclusionTransaction = (
  engine: Engine,
  options: CurrentLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusion | null => {
  assertLeaseIdentityPart("space", options.space);
  if (!branchIsActive(engine, options.branch)) return null;
  const nowMs = sampleLeaseClock(
    "legacy background exclusion server time",
    options.nowMs,
  );
  const current = selectLegacyBackgroundExclusionRow(engine, options.branch);
  return current !== null && backgroundExclusionIsLive(current, nowMs)
    ? toLegacyBackgroundExclusion(options.space, current)
    : null;
};

export const currentLegacyBackgroundExclusion = (
  engine: Engine,
  options: CurrentLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusion | null =>
  engine.database.transaction(currentLegacyBackgroundExclusionTransaction)
    .immediate(engine, options);

const renewLegacyBackgroundExclusionTransaction = (
  engine: Engine,
  options: RenewLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusionStatus | null => {
  assertLegacyBackgroundExclusion(options.exclusion);
  if (!branchIsActive(engine, options.exclusion.branch)) return null;
  if (options.authorizeService?.(engine) !== true) return null;
  const nowMs = sampleLeaseClock(
    "legacy background exclusion server time",
    options.nowMs,
  );
  const expiresAt = backgroundExclusionExpiry(nowMs, options.ttlMs);
  const current = selectLegacyBackgroundExclusionRow(
    engine,
    options.exclusion.branch,
  );
  if (
    current === null || !backgroundExclusionIsLive(current, nowMs) ||
    !backgroundExclusionOwnerMatches(current, options.exclusion)
  ) {
    return null;
  }
  engine.database.prepare(UPDATE_LEGACY_BACKGROUND_EXCLUSION).run({
    branch: current.branch,
    exclusion_generation: current.exclusion_generation,
    holder_id: current.holder_id,
    service_principal: current.service_principal,
    expires_at: String(expiresAt),
  });
  const exclusion = {
    ...toLegacyBackgroundExclusion(options.exclusion.space, current),
    expiresAt,
  };
  const blockedUntil = drainClientLeaseForBackground(
    engine,
    current.branch,
    nowMs,
    options.drainTtlMs,
  );
  return {
    exclusion,
    serverTime: nowMs,
    ready: blockedUntil === undefined,
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
  };
};

/** Refresh one exact background reservation and report client-drain state. */
export const renewLegacyBackgroundExclusion = (
  engine: Engine,
  options: RenewLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusionStatus | null =>
  engine.database.transaction(renewLegacyBackgroundExclusionTransaction)
    .immediate(engine, options);

const releaseLegacyBackgroundExclusionTransaction = (
  engine: Engine,
  options: ReleaseLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusion | null => {
  assertLegacyBackgroundExclusion(options.exclusion);
  if (options.authorizeService?.(engine) !== true) return null;
  const nowMs = sampleLeaseClock(
    "legacy background exclusion server time",
    options.nowMs,
  );
  const current = selectLegacyBackgroundExclusionRow(
    engine,
    options.exclusion.branch,
  );
  if (
    current === null ||
    !backgroundExclusionOwnerMatches(current, options.exclusion)
  ) {
    return null;
  }
  const expiresAt = Math.min(current.expires_at, nowMs);
  engine.database.prepare(UPDATE_LEGACY_BACKGROUND_EXCLUSION).run({
    branch: current.branch,
    exclusion_generation: current.exclusion_generation,
    holder_id: current.holder_id,
    service_principal: current.service_principal,
    expires_at: String(expiresAt),
  });
  return {
    ...toLegacyBackgroundExclusion(options.exclusion.space, current),
    expiresAt,
  };
};

/** Release only the exact holder/generation named by the trusted host. */
export const releaseLegacyBackgroundExclusion = (
  engine: Engine,
  options: ReleaseLegacyBackgroundExclusionOptions,
): LegacyBackgroundExclusion | null =>
  engine.database.transaction(releaseLegacyBackgroundExclusionTransaction)
    .immediate(engine, options);

const assertExecutionLeaseFenceTransaction = (
  engine: Engine,
  options: {
    fence?: ExecutionLeaseFence;
    space?: string;
    branch: BranchName;
    principal?: string;
    claims: readonly ExecutionClaim[];
    requireExactClaim?: boolean;
  },
): void => {
  const fence = options.fence;
  if (fence === undefined) return;
  assertLeaseSnapshot(fence.lease);
  if (
    options.space === undefined || fence.lease.space !== options.space ||
    fence.lease.branch !== options.branch ||
    options.principal !== fence.lease.onBehalfOf
  ) {
    throw new ExecutionLeaseFenceError(
      "execution lease does not match the commit lane and principal",
    );
  }
  if (fence.authorize?.(engine) !== true) {
    throw new ExecutionLeaseFenceError(
      "execution sponsor lacks current WRITE authority or execution policy",
    );
  }
  const nowMs = sampleLeaseClock(
    "execution lease server time",
    fence.nowMs,
  );
  const current = selectExecutionLeaseRow(engine, options.branch);
  if (
    current === null || current.state !== "active" ||
    current.expires_at <= nowMs ||
    !leaseOwnerMatches(current, fence.lease)
  ) {
    throw new ExecutionLeaseFenceError(
      "execution lease is stale, expired, or revoked",
    );
  }
  if (options.requireExactClaim === true && options.claims.length !== 1) {
    throw new ExecutionLeaseFenceError(
      "bound executor semantic transaction requires one exact execution claim incarnation",
    );
  }
  for (const claim of options.claims) {
    if (claim.expiresAt <= nowMs) {
      throw new ExecutionLeaseFenceError(
        "execution claim incarnation is expired",
      );
    }
    if (
      claim.branch !== options.branch || claim.space !== options.space ||
      claim.leaseGeneration !== current.lease_generation
    ) {
      throw new ExecutionLeaseFenceError(
        "execution claim does not match the durable lease generation",
      );
    }
  }
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
  // Optional non-FK fan-out slot for metadata-only observations. Stored only
  // on scheduler_action_snapshot; the observation row's commit_seq continues
  // to reference a real semantic commit.
  deliveryCommitSeq?: number | null;
  observedAtSeq: number;
  scopeContext: SchedulerScopeContext;
  /** Canonical commit-session key used only for replay/echo provenance. */
  writerSessionId?: string;
  localSeq?: number;
  /** Client-request replay identity when canonical host fields differ from the
   * persisted observation payload. */
  replayPayload?: string;
  observation: SchedulerActionObservation;
}

type HostSchedulerObservationOptions = UpsertSchedulerObservationOptions & {
  /** Exact source frontier covered by a claimed attempt. This never crosses
   * the protocol boundary; ordinary observations clear all pending causes. */
  causeCoverageSeq?: number;
};

export interface UpsertSchedulerObservationResult {
  observationId: number;
  commitSeq: number | null;
  executionContextKey: SchedulerExecutionContextKey;
  invalidatedExecutionContextKeys: SchedulerExecutionContextKey[];
}

export const upsertSchedulerObservation = (
  engine: Engine,
  options: UpsertSchedulerObservationOptions,
): UpsertSchedulerObservationResult =>
  engine.database.transaction(upsertSchedulerObservationTransaction).immediate(
    engine,
    options,
  );

/**
 * Persist a server-side cross-space mirror using the effective context already
 * selected by the authoritative owner-space transaction. This is deliberately
 * separate from the protocol-facing observation path: clients never select an
 * execution context, while trusted server fan-out must not independently
 * broaden or narrow ownership in each mirror database.
 */
export const upsertMirroredSchedulerObservation = (
  engine: Engine,
  options: UpsertSchedulerObservationOptions & {
    originExecutionContextKey: SchedulerExecutionContextKey;
  },
): UpsertSchedulerObservationResult =>
  engine.database.transaction(upsertSchedulerObservationTransaction).immediate(
    engine,
    options,
  );

const upsertSchedulerObservationTransaction = (
  engine: Engine,
  options:
    & HostSchedulerObservationOptions
    & { originExecutionContextKey?: SchedulerExecutionContextKey },
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
  if (options.originExecutionContextKey !== undefined) {
    // Validate the trusted origin key before consulting it. `observedAtSeq` is
    // the authoritative owner-space sequence for mirrors, so it doubles as a
    // persisted last-writer fence against delayed asynchronous fan-out.
    schedulerContextScopeForCanonicalKey(
      options.originExecutionContextKey,
      options.scopeContext,
    );
    const mirroredLatest = selectSchedulerSnapshotRow(engine, {
      branch,
      ownerSpace: observation.ownerSpace,
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: observation.actionId,
      executionContextKey: options.originExecutionContextKey,
    });
    if (
      mirroredLatest &&
      mirroredLatest.observed_at_seq > options.observedAtSeq
    ) {
      return {
        observationId: mirroredLatest.observation_id,
        commitSeq: mirroredLatest.commit_seq,
        executionContextKey: options.originExecutionContextKey,
        invalidatedExecutionContextKeys: [],
      };
    }
  }
  const { executionContextKey, invalidatedExecutionContextKeys } =
    options.originExecutionContextKey === undefined
      ? resolveSchedulerExecutionContext(engine, {
        branch,
        ownerSpace: observation.ownerSpace,
        observation,
        scopeContext: options.scopeContext,
      })
      : preserveMirroredSchedulerExecutionContext(engine, {
        branch,
        ownerSpace: observation.ownerSpace,
        observation,
        scopeContext: options.scopeContext,
        originExecutionContextKey: options.originExecutionContextKey,
      });
  invalidateSchedulerExecutionContexts(engine, {
    branch,
    ownerSpace: observation.ownerSpace,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
    executionContextKeys: invalidatedExecutionContextKeys,
  });
  const actionKey = {
    branch,
    ownerSpace: observation.ownerSpace,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
    executionContextKey,
  };
  const coveredThroughSeq = options.causeCoverageSeq ??
    (observation.executionProvenance !== undefined
      ? observation.inputBasisSeq
      : undefined) ??
    Number.MAX_SAFE_INTEGER;
  consumeSchedulerActionCauses(
    engine,
    actionKey,
    coveredThroughSeq,
  );
  const latest = selectSchedulerSnapshotRow(engine, actionKey);
  const payloadChanged = latest?.payload !== payload;
  const observationId = latest?.observation_id ??
    insertSchedulerObservationRow(engine, {
      branch,
      commitSeq: options.commitSeq ?? null,
      observedAtSeq: options.observedAtSeq,
      writerSessionId: options.writerSessionId ?? null,
      executionContextKey,
      observation,
      payload,
    });
  if (latest && payloadChanged) {
    updateSchedulerObservationRow(engine, {
      observationId,
      commitSeq: options.commitSeq ?? null,
      observedAtSeq: options.observedAtSeq,
      writerSessionId: options.writerSessionId ?? null,
      executionContextKey,
      observation,
      payload,
    });
  } else if (latest) {
    // Identical-payload coalesce (a later re-run of the same observation, and
    // possibly from a DIFFERENT writer): refresh ONLY the writer session key.
    // Context-qualified ownership handles isolation; the latest writer remains
    // useful for replay provenance and live-adoption echo suppression.
    //
    // Deliberately does NOT touch the observation row's commit_seq. Snapshot
    // commit_seq carries the latest delivery slot; preserving the observation
    // row keeps the original semantic commit available to older snapshots.
    updateSchedulerObservationWriterSession(engine, {
      observationId,
      writerSessionId: options.writerSessionId ?? null,
    });
  }

  if (payloadChanged) {
    reconcileSchedulerReadRows(engine, {
      branch,
      observationId,
      observation,
      executionContextKey,
      scopeContext: options.scopeContext,
    });
    reconcileSchedulerWriteRows(engine, {
      branch,
      observationId,
      observation,
      executionContextKey,
      scopeContext: options.scopeContext,
    });
  }
  upsertSchedulerSnapshot(engine, {
    branch,
    observationId,
    // Every semantic commit needs its own live-adoption delivery slot, even
    // when the dependency shape is unchanged. Only a metadata-only identical
    // refresh can safely preserve the existing semantic/future slot.
    commitSeq: options.commitSeq ??
      (!payloadChanged && latest?.commit_seq != null
        ? latest.commit_seq
        : options.deliveryCommitSeq ?? null),
    observedAtSeq: options.observedAtSeq,
    payload,
    observation,
    executionContextKey,
  });
  upsertSchedulerActionState(engine, {
    branch,
    observation,
    executionContextKey,
    latestObservationId: observationId,
    coveredThroughSeq,
  });
  pruneSchedulerSessionExecutionContexts(engine, {
    branch,
    ownerSpace: observation.ownerSpace,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
    principal: options.scopeContext.principal,
  });
  if (options.writerSessionId !== undefined && options.localSeq !== undefined) {
    recordSchedulerObservationReplay(engine, {
      branch,
      sessionId: options.writerSessionId,
      localSeq: options.localSeq,
      status: "kept",
      observationId,
      observedAtSeq: options.observedAtSeq,
      payload: options.replayPayload ?? payload,
      ...(options.replayPayload !== undefined
        ? { acceptedPayload: payload }
        : {}),
    });
  }

  return {
    observationId,
    commitSeq: options.commitSeq ?? null,
    executionContextKey,
    invalidatedExecutionContextKeys,
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
    executionContextKey?: SchedulerExecutionContextKey;
  },
): SchedulerObservationSnapshot | undefined => {
  const rows = engine.database.prepare(`
    SELECT
      s.observation_id,
      s.execution_context_key,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
      AND o.execution_context_key = s.execution_context_key
    WHERE s.branch = :branch
      AND s.owner_space = :owner_space
      AND s.piece_id = :piece_id
      AND s.process_generation = :process_generation
      AND s.action_id = :action_id
      AND (
        :execution_context_key IS NULL OR
        s.execution_context_key = :execution_context_key
      )
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: normalizeSchedulerOwnerSpace(options.ownerSpace),
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
    execution_context_key: options.executionContextKey ?? null,
  }) as {
    observation_id: number;
    execution_context_key: SchedulerExecutionContextKey;
    commit_seq: number | null;
    observed_at_seq: number;
    payload: string;
  }[];

  if (rows.length !== 1) return undefined;
  const row = rows[0];
  return {
    observationId: row.observation_id,
    executionContextKey: row.execution_context_key,
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
    // Commit-seq window (exclusive since, inclusive through) for the
    // incremental-adoption fan-out; rows with a NULL commit seq never
    // match a window filter.
    sinceCommitSeq?: number;
    throughCommitSeq?: number;
    limit?: number;
    cursor?: SchedulerActionSnapshotCursorWithContext;
    /** Server-derived applicable keys; omitted only for trusted internal scans. */
    applicableExecutionContextKeys?: readonly SchedulerExecutionContextKey[];
  } = {},
): SchedulerObservationSnapshotPage => {
  const limit = clampSchedulerSnapshotListLimit(options.limit);
  const cursorOwnerSpace = options.cursor
    ? normalizeSchedulerOwnerSpace(options.cursor.ownerSpace)
    : null;
  const applicableContextKeys = options.applicableExecutionContextKeys ===
      undefined
    ? undefined
    : [...new Set(options.applicableExecutionContextKeys)];
  const contextFilter = applicableContextKeys === undefined
    ? ""
    : applicableContextKeys.length === 0
    ? "AND 0"
    : `AND s.execution_context_key IN (${
      applicableContextKeys.map((_, index) => `:context_${index}`).join(", ")
    })`;
  const contextParams = Object.fromEntries(
    applicableContextKeys?.map((key, index) => [`context_${index}`, key]) ?? [],
  );
  const rows = engine.database.prepare(`
    SELECT
      s.owner_space,
      s.piece_id,
      s.process_generation,
      s.action_id,
      s.execution_context_key,
      s.observation_id,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload,
      o.session_id AS writer_session_id,
      a.direct_dirty_seq,
      a.stale_seq,
      a.unknown_reason
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
      AND o.execution_context_key = s.execution_context_key
    LEFT JOIN scheduler_action_state a
      ON a.branch = s.branch
      AND a.owner_space = s.owner_space
      AND a.piece_id = s.piece_id
      AND a.process_generation = s.process_generation
      AND a.action_id = s.action_id
      AND a.execution_context_key = s.execution_context_key
    WHERE s.branch = :branch
      AND (:owner_space IS NULL OR s.owner_space = :owner_space)
      AND (:piece_id IS NULL OR s.piece_id = :piece_id)
      AND (
        :process_generation IS NULL OR
        s.process_generation = :process_generation
      )
      AND (:action_id IS NULL OR s.action_id = :action_id)
      ${contextFilter}
      AND (
        :since_commit_seq IS NULL OR
        COALESCE(s.commit_seq, o.commit_seq) > :since_commit_seq
      )
      AND (
        :through_commit_seq IS NULL OR
        COALESCE(s.commit_seq, o.commit_seq) <= :through_commit_seq
      )
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
        ) OR
        (
          s.owner_space = :cursor_owner_space AND
          s.piece_id = :cursor_piece_id AND
          s.process_generation = :cursor_process_generation AND
          s.action_id = :cursor_action_id AND
          s.execution_context_key > :cursor_execution_context_key
        )
      )
    ORDER BY
      s.owner_space,
      s.piece_id,
      s.process_generation,
      s.action_id,
      s.execution_context_key
    LIMIT :limit_plus_one
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: options.ownerSpace !== undefined
      ? normalizeSchedulerOwnerSpace(options.ownerSpace)
      : null,
    piece_id: options.pieceId ?? null,
    process_generation: options.processGeneration ?? null,
    action_id: options.actionId ?? null,
    since_commit_seq: options.sinceCommitSeq ?? null,
    through_commit_seq: options.throughCommitSeq ?? null,
    cursor_owner_space: cursorOwnerSpace,
    cursor_piece_id: options.cursor?.pieceId ?? null,
    cursor_process_generation: options.cursor?.processGeneration ?? null,
    cursor_action_id: options.cursor?.actionId ?? null,
    cursor_execution_context_key: options.cursor?.executionContextKey ?? null,
    limit_plus_one: limit + 1,
    ...contextParams,
  }) as {
    owner_space: string;
    piece_id: string;
    process_generation: number;
    action_id: string;
    execution_context_key: SchedulerExecutionContextKey;
    observation_id: number;
    commit_seq: number | null;
    observed_at_seq: number;
    payload: string;
    writer_session_id: string | null;
    direct_dirty_seq: number | null;
    stale_seq: number | null;
    unknown_reason: string | null;
  }[];

  const pageRows = rows.slice(0, limit);
  const snapshots = pageRows.map((row) => ({
    observationId: row.observation_id,
    executionContextKey: row.execution_context_key,
    commitSeq: row.commit_seq,
    observedAtSeq: row.observed_at_seq,
    observation: decodeSchedulerSnapshotObservation(
      row.payload,
      row.observed_at_seq,
    ),
    ...(row.writer_session_id !== null
      ? { writerSessionId: row.writer_session_id }
      : {}),
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
          executionContextKey: lastRow.execution_context_key,
        },
      }
      : {}),
  };
};

export const findSchedulerReadersForWrite = (
  engine: Engine,
  options: {
    branch?: BranchName;
    write: SchedulerWriteAddress;
  },
): SchedulerReaderIndexEntry[] => {
  const declaredScope = normalizeSchedulerScope(options.write.scope);
  if (options.write.scopeKey === undefined && declaredScope !== "space") {
    throw new ProtocolError(
      "scoped scheduler writes require a resolved scope key",
    );
  }
  const write: ResolvedSchedulerObservationAddress = {
    ...normalizeSchedulerAddress(options.write),
    scopeKey: options.write.scopeKey ?? DEFAULT_SCOPE_KEY,
  };
  const rows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      read_space,
      read_id,
      read_scope,
      read_scope_key,
      read_path,
      read_kind,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id
    FROM scheduler_read_index
    WHERE branch = :branch
      AND read_space = :read_space
      AND read_id = :read_id
      AND read_scope_key = :read_scope_key
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    read_space: write.space,
    read_id: write.id,
    read_scope_key: write.scopeKey,
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
        executionContextKey: row.execution_context_key,
        observationId: row.observation_id,
        readKind: row.read_kind === "shallow" ? "shallow" : "recursive",
        read: {
          space: row.read_space,
          id: row.read_id,
          scope: row.read_scope as CellScope,
          scopeKey: row.read_scope_key,
          path: decodeSchedulerPath(row.read_path),
        },
      };
    });
};

/**
 * Returns the distinct demanded actions that are durably dirty or stale at or
 * after `dirtySeq`, provided at least one changed target overlaps the indexed
 * read surface for the same owner/context partition.
 *
 * The target gate deliberately composes `findSchedulerReadersForWrite`: path
 * and effective-scope matching therefore cannot drift from commit-time
 * dirtying. The state lookup is broader than those direct readers because
 * propagation may cross an undemanded action before reaching a demanded one.
 */
export const staleReadersForTargets = (
  engine: Engine,
  options: SchedulerStaleReadersForTargetsOptions,
): SchedulerActionState[] => {
  if (!Number.isSafeInteger(options.dirtySeq) || options.dirtySeq < 0) {
    throw new TypeError("scheduler stale-reader dirtySeq must be non-negative");
  }
  if (
    options.targets.length === 0 ||
    options.demandedSchedulerPieceIds.length === 0
  ) {
    return [];
  }

  const branch = options.branch ?? DEFAULT_BRANCH;
  const ownerSpace = normalizeSchedulerOwnerSpace(options.ownerSpace);
  const demandedSchedulerPieceIds = [
    ...new Set(options.demandedSchedulerPieceIds),
  ];
  const applicableContextKeys = options.applicableExecutionContextKeys ===
      undefined
    ? undefined
    : [...new Set(options.applicableExecutionContextKeys)];
  if (applicableContextKeys?.length === 0) return [];
  const applicableContextSet = applicableContextKeys === undefined
    ? undefined
    : new Set(applicableContextKeys);

  // Repeated patch paths and coalesced commit batches commonly name the same
  // effective target more than once. Keep one read-index probe per target.
  const uniqueTargets = new Map<string, SchedulerWriteAddress>();
  for (const target of options.targets) {
    const declaredScope = normalizeSchedulerScope(target.scope);
    if (target.scopeKey === undefined && declaredScope !== "space") {
      throw new ProtocolError(
        "scoped scheduler stale-reader targets require a resolved scope key",
      );
    }
    const scopeKey = target.scopeKey ?? DEFAULT_SCOPE_KEY;
    uniqueTargets.set(
      [
        target.space,
        target.id,
        declaredScope,
        scopeKey,
        encodeSchedulerPath(target.path),
      ].join("\0"),
      target,
    );
  }

  let relevantTarget = false;
  for (const target of uniqueTargets.values()) {
    const readers = findSchedulerReadersForWrite(engine, {
      branch,
      write: target,
    });
    relevantTarget = readers.some((reader) =>
      normalizeSchedulerOwnerSpace(reader.ownerSpace) === ownerSpace &&
      (applicableContextSet === undefined ||
        applicableContextSet.has(reader.executionContextKey))
    );
    if (relevantTarget) break;
  }
  if (!relevantTarget) return [];

  const pieceParams = Object.fromEntries(
    demandedSchedulerPieceIds.map((pieceId, index) => [
      `demanded_piece_${index}`,
      pieceId,
    ]),
  );
  const pieceFilter = demandedSchedulerPieceIds
    .map((_, index) => `:demanded_piece_${index}`)
    .join(", ");
  const contextParams = Object.fromEntries(
    applicableContextKeys?.map((key, index) => [
      `execution_context_${index}`,
      key,
    ]) ?? [],
  );
  const contextFilter = applicableContextKeys === undefined
    ? ""
    : `AND execution_context_key IN (${
      applicableContextKeys.map((_, index) => `:execution_context_${index}`)
        .join(", ")
    })`;

  const rows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      latest_observation_id,
      direct_dirty_seq,
      stale_seq,
      unknown_reason
    FROM scheduler_action_state
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id IN (${pieceFilter})
      ${contextFilter}
      AND (
        direct_dirty_seq >= :dirty_seq OR
        stale_seq >= :dirty_seq OR
        unknown_reason IS NOT NULL
      )
    ORDER BY
      piece_id,
      process_generation,
      action_id,
      execution_context_key
  `).all({
    branch,
    owner_space: ownerSpace,
    dirty_seq: options.dirtySeq,
    ...pieceParams,
    ...contextParams,
  }) as SchedulerActionStateRow[];

  return rows.map(schedulerActionStateFromRow);
};

/**
 * Returns every current durable action whose indexed write surface overlaps
 * one of `targets`.
 *
 * Target scope keys are resolved by the authenticated caller before reaching
 * this engine seam. `applicableExecutionContextKeys` is likewise
 * server-derived; omitting it is reserved for trusted internal scans.
 */
export const writersForTargets = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    targets: readonly SchedulerWriterTarget[];
    applicableExecutionContextKeys?: readonly SchedulerExecutionContextKey[];
  },
): SchedulerWriterCandidate[] => {
  if (options.targets.length === 0) return [];

  const branch = options.branch ?? DEFAULT_BRANCH;
  const applicableContextKeys = options.applicableExecutionContextKeys ===
      undefined
    ? undefined
    : [...new Set(options.applicableExecutionContextKeys)];
  if (applicableContextKeys?.length === 0) return [];

  const contextFilter = applicableContextKeys === undefined
    ? ""
    : `AND w.execution_context_key IN (${
      applicableContextKeys.map((_, index) => `:context_${index}`).join(", ")
    })`;
  const contextParams = Object.fromEntries(
    applicableContextKeys?.map((key, index) => [`context_${index}`, key]) ?? [],
  );
  const candidates = new Map<
    string,
    {
      candidate: Omit<SchedulerWriterCandidate, "matchedWrites">;
      matchedWrites: Map<string, SchedulerMatchedWrite>;
    }
  >();

  for (const requestedTarget of options.targets) {
    const declaredScope = normalizeSchedulerScope(requestedTarget.scope);
    if (
      requestedTarget.scopeKey === undefined && declaredScope !== "space"
    ) {
      throw new ProtocolError(
        "scoped scheduler writer targets require a resolved scope key",
      );
    }
    const target: ResolvedSchedulerObservationAddress = {
      ...normalizeSchedulerAddress(requestedTarget),
      scopeKey: requestedTarget.scopeKey ?? DEFAULT_SCOPE_KEY,
    };
    const rows = engine.database.prepare(`
      SELECT
        w.branch,
        w.owner_space,
        w.write_space,
        w.write_id,
        w.write_scope,
        w.write_scope_key,
        w.write_path,
        w.write_kind,
        w.piece_id,
        w.process_generation,
        w.action_id,
        w.execution_context_key,
        w.observation_id,
        COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
        s.observed_at_seq,
        s.payload,
        a.direct_dirty_seq,
        a.stale_seq,
        a.unknown_reason
      FROM scheduler_write_index w
      JOIN scheduler_action_snapshot s
        ON s.branch = w.branch
        AND s.owner_space = w.owner_space
        AND s.piece_id = w.piece_id
        AND s.process_generation = w.process_generation
        AND s.action_id = w.action_id
        AND s.execution_context_key = w.execution_context_key
        AND s.observation_id = w.observation_id
      JOIN scheduler_observation o
        ON o.observation_id = s.observation_id
        AND o.execution_context_key = s.execution_context_key
        AND o.branch = s.branch
        AND o.piece_id = s.piece_id
        AND o.process_generation = s.process_generation
        AND o.action_id = s.action_id
        AND o.payload = s.payload
      JOIN scheduler_action_state a
        ON a.branch = w.branch
        AND a.owner_space = w.owner_space
        AND a.piece_id = w.piece_id
        AND a.process_generation = w.process_generation
        AND a.action_id = w.action_id
        AND a.execution_context_key = w.execution_context_key
        AND a.latest_observation_id = w.observation_id
      WHERE w.branch = :branch
        AND w.write_space = :write_space
        AND w.write_id = :write_id
        AND w.write_scope_key = :write_scope_key
        AND w.write_scope = :write_scope
        AND (:owner_space IS NULL OR w.owner_space = :owner_space)
        ${contextFilter}
    `).all({
      branch,
      write_space: target.space,
      write_id: target.id,
      write_scope_key: target.scopeKey,
      write_scope: declaredScope,
      owner_space: options.ownerSpace === undefined
        ? null
        : normalizeSchedulerOwnerSpace(options.ownerSpace),
      ...contextParams,
    }) as SchedulerWriterLookupRow[];

    for (const row of rows) {
      if (!isSchedulerWriteIndexKind(row.write_kind)) continue;
      let writePath: string[];
      try {
        writePath = decodeSchedulerPath(row.write_path);
      } catch {
        continue;
      }
      if (!schedulerPathsOverlap(writePath, target.path, false)) continue;

      let observation: SchedulerActionObservation | undefined;
      try {
        observation = schedulerObservationFromValue(
          decodeSchedulerSnapshotObservation(
            row.payload,
            row.observed_at_seq,
          ),
        );
      } catch {
        // Indexes are projections, never ground truth. A corrupt snapshot row
        // is an index miss so callers can fail open to piece instantiation.
        continue;
      }
      if (
        observation === undefined ||
        observation.branch !== row.branch ||
        normalizeSchedulerOwnerSpace(observation.ownerSpace) !==
          row.owner_space ||
        observation.pieceId !== row.piece_id ||
        observation.processGeneration !== row.process_generation ||
        observation.actionId !== row.action_id ||
        !schedulerObservationContainsIndexedWrite(
          observation,
          row,
          writePath,
        )
      ) {
        continue;
      }

      const ownerSpace = denormalizeSchedulerOwnerSpace(row.owner_space);
      const candidateKey = schedulerWriterCandidateKey({
        branch: row.branch,
        ownerSpace,
        pieceId: row.piece_id,
        processGeneration: row.process_generation,
        actionId: row.action_id,
        executionContextKey: row.execution_context_key,
      });
      let accumulated = candidates.get(candidateKey);
      if (!accumulated) {
        accumulated = {
          candidate: {
            branch: row.branch,
            ...(ownerSpace !== undefined ? { ownerSpace } : {}),
            pieceId: row.piece_id,
            processGeneration: row.process_generation,
            actionId: row.action_id,
            executionContextKey: row.execution_context_key,
            observationId: row.observation_id,
            commitSeq: row.commit_seq,
            observedAtSeq: row.observed_at_seq,
            actionKind: observation.actionKind,
            implementationFingerprint: observation.implementationFingerprint,
            runtimeFingerprint: observation.runtimeFingerprint,
            status: observation.status,
            ...(observation.errorFingerprint !== undefined
              ? { errorFingerprint: observation.errorFingerprint }
              : {}),
            ...(row.direct_dirty_seq !== null
              ? { directDirtySeq: row.direct_dirty_seq }
              : {}),
            ...(row.stale_seq !== null ? { staleSeq: row.stale_seq } : {}),
            ...(row.unknown_reason !== null
              ? { unknownReason: row.unknown_reason }
              : {}),
          },
          matchedWrites: new Map(),
        };
        candidates.set(candidateKey, accumulated);
      }

      const match: SchedulerMatchedWrite = {
        kind: row.write_kind,
        write: {
          space: row.write_space,
          id: row.write_id,
          scope: row.write_scope as CellScope,
          scopeKey: row.write_scope_key,
          path: writePath,
        },
      };
      accumulated.matchedWrites.set(schedulerMatchedWriteKey(match), match);
    }
  }

  return [...candidates.values()]
    .map(({ candidate, matchedWrites }) => ({
      ...candidate,
      matchedWrites: [...matchedWrites.values()].sort((left, right) =>
        compareSchedulerKeys(
          schedulerMatchedWriteKey(left),
          schedulerMatchedWriteKey(right),
        )
      ),
    }))
    .sort((left, right) =>
      compareSchedulerKeys(
        schedulerWriterCandidateKey(left),
        schedulerWriterCandidateKey(right),
      )
    );
};

export const markSchedulerReadersDirtyForWrites = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    dirtySeq: number;
    writes: readonly SchedulerWriteAddress[];
    /** The accepted action producing these writes. Scheduler self-writes do
     * not schedule another run or become causal source provenance. */
    ignoredAction?: SchedulerActionCauseKey;
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
      if (
        options.ignoredAction !== undefined &&
        schedulerActionCauseKeyEquals(reader, options.ignoredAction)
      ) {
        continue;
      }
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
  assertSchedulerActionCauseSeq(options.dirtySeq);
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

const MAX_PENDING_SCHEDULER_ACTION_CAUSES = 64;

type SchedulerActionCauseKey = {
  branch: BranchName;
  ownerSpace?: string | null;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
};

const schedulerActionCauseParams = (key: SchedulerActionCauseKey) => ({
  branch: key.branch,
  owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
  piece_id: key.pieceId,
  process_generation: key.processGeneration,
  action_id: key.actionId,
  execution_context_key: key.executionContextKey,
});

const schedulerActionCauseKeyEquals = (
  left: SchedulerActionCauseKey,
  right: SchedulerActionCauseKey,
): boolean =>
  left.branch === right.branch &&
  normalizeSchedulerOwnerSpace(left.ownerSpace) ===
    normalizeSchedulerOwnerSpace(right.ownerSpace) &&
  left.pieceId === right.pieceId &&
  left.processGeneration === right.processGeneration &&
  left.actionId === right.actionId &&
  left.executionContextKey === right.executionContextKey;

const assertSchedulerActionCauseSeq = (sourceSeq: number): void => {
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq <= 0) {
    throw new TypeError(
      "scheduler action cause sequence must be a positive safe integer",
    );
  }
};

/**
 * Retain the newest exact causes while bounding durable state. A zero row is
 * the honest overflow marker: once any exact cause has been folded into it,
 * provenance stays unknown until one accepted run covers the entire pending
 * dirty frontier.
 */
function recordSchedulerActionCause(
  engine: Engine,
  action: SchedulerActionCauseKey,
  sourceSeq: number,
): void {
  const params = schedulerActionCauseParams(action);
  engine.database.prepare(`
    INSERT OR IGNORE INTO scheduler_action_cause (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      source_seq
    ) VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      :source_seq
    )
  `).run({ ...params, source_seq: sourceSeq });

  const rowCount = (engine.database.prepare(`
    SELECT COUNT(*) AS count
    FROM scheduler_action_cause
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `).get(params) as { count: number }).count;
  if (rowCount <= MAX_PENDING_SCHEDULER_ACTION_CAUSES) return;

  engine.database.prepare(`
    INSERT OR IGNORE INTO scheduler_action_cause (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      source_seq
    ) VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      0
    )
  `).run(params);
  const boundedCount = (engine.database.prepare(`
    SELECT COUNT(*) AS count
    FROM scheduler_action_cause
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `).get(params) as { count: number }).count;
  engine.database.prepare(`
    DELETE FROM scheduler_action_cause
    WHERE rowid IN (
      SELECT rowid
      FROM scheduler_action_cause
      WHERE branch = :branch
        AND owner_space = :owner_space
        AND piece_id = :piece_id
        AND process_generation = :process_generation
        AND action_id = :action_id
        AND execution_context_key = :execution_context_key
        AND source_seq > 0
      ORDER BY source_seq ASC
      LIMIT :excess
    )
  `).run({
    ...params,
    excess: boundedCount - MAX_PENDING_SCHEDULER_ACTION_CAUSES,
  });
}

type SchedulerActionCauseCoverage = {
  causedBy: number[];
  overflowed: boolean;
  clearsOverflow: boolean;
};

function schedulerActionCauseCoverage(
  engine: Engine,
  key: SchedulerActionCauseKey,
  throughSeq: number,
): SchedulerActionCauseCoverage {
  const params = schedulerActionCauseParams(key);
  const rows = engine.database.prepare(`
    SELECT source_seq
    FROM scheduler_action_cause
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
    ORDER BY source_seq ASC
  `).all(params) as Array<{ source_seq: number }>;
  const overflowed = rows.some((row) => row.source_seq === 0);
  const exact = [...new Set(rows.map((row) => row.source_seq))]
    .filter((sourceSeq) =>
      Number.isSafeInteger(sourceSeq) && sourceSeq > 0 &&
      sourceSeq <= throughSeq
    )
    .sort((left, right) => left - right);
  if (!overflowed) {
    return { causedBy: exact, overflowed: false, clearsOverflow: false };
  }

  const state = engine.database.prepare(`
    SELECT direct_dirty_seq, stale_seq
    FROM scheduler_action_state
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `).get(params) as {
    direct_dirty_seq: number | null;
    stale_seq: number | null;
  } | undefined;
  const pendingFrontier = [state?.direct_dirty_seq, state?.stale_seq]
    .filter((seq): seq is number => seq !== null && seq !== undefined)
    .reduce<number | undefined>(
      (maximum, seq) => maximum === undefined ? seq : Math.max(maximum, seq),
      undefined,
    );
  return {
    causedBy: [],
    overflowed: true,
    clearsOverflow: pendingFrontier !== undefined &&
      Number.isSafeInteger(pendingFrontier) && pendingFrontier <= throughSeq,
  };
}

function consumeSchedulerActionCauses(
  engine: Engine,
  key: SchedulerActionCauseKey,
  throughSeq: number,
): void {
  const coverage = schedulerActionCauseCoverage(engine, key, throughSeq);
  const params = schedulerActionCauseParams(key);
  if (coverage.overflowed) {
    if (!coverage.clearsOverflow) return;
    engine.database.prepare(`
      DELETE FROM scheduler_action_cause
      WHERE branch = :branch
        AND owner_space = :owner_space
        AND piece_id = :piece_id
        AND process_generation = :process_generation
        AND action_id = :action_id
        AND execution_context_key = :execution_context_key
    `).run(params);
    return;
  }
  engine.database.prepare(`
    DELETE FROM scheduler_action_cause
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
      AND source_seq > 0
      AND source_seq <= :through_seq
  `).run({ ...params, through_seq: throughSeq });
}

export const getSchedulerActionState = (
  engine: Engine,
  options: {
    branch?: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    executionContextKey?: SchedulerExecutionContextKey;
  },
): SchedulerActionState | undefined => {
  const rows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
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
      AND (
        :execution_context_key IS NULL OR
        execution_context_key = :execution_context_key
      )
  `).all({
    branch: options.branch ?? DEFAULT_BRANCH,
    owner_space: normalizeSchedulerOwnerSpace(options.ownerSpace),
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
    execution_context_key: options.executionContextKey ?? null,
  }) as SchedulerActionStateRow[];

  if (rows.length !== 1) return undefined;
  return schedulerActionStateFromRow(rows[0]);
};

function schedulerActionStateFromRow(
  row: SchedulerActionStateRow,
): SchedulerActionState {
  const ownerSpace = denormalizeSchedulerOwnerSpace(row.owner_space);
  return {
    branch: row.branch,
    ...(ownerSpace !== undefined ? { ownerSpace } : {}),
    pieceId: row.piece_id,
    processGeneration: row.process_generation,
    actionId: row.action_id,
    executionContextKey: row.execution_context_key,
    latestObservationId: row.latest_observation_id,
    directDirtySeq: row.direct_dirty_seq,
    staleSeq: row.stale_seq,
    unknownReason: row.unknown_reason,
  };
}

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
      execution_context_key,
      direct_dirty_seq
    )
    VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      :direct_dirty_seq
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key
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
    execution_context_key: action.executionContextKey,
    direct_dirty_seq: dirtySeq,
  });
  recordSchedulerActionCause(engine, action, dirtySeq);
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
      execution_context_key,
      stale_seq
    )
    VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
      :stale_seq
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key
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
    execution_context_key: action.executionContextKey,
    stale_seq: staleSeq,
  });
  recordSchedulerActionCause(engine, action, staleSeq);
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
): ResolvedSchedulerObservationAddress[] {
  const rows = engine.database.prepare(`
    SELECT
      write_space,
      write_id,
      write_scope,
      write_scope_key,
      write_path
    FROM scheduler_write_index
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
      AND write_kind IN ('current-known', 'declared')
  `).all({
    branch: action.branch,
    owner_space: normalizeSchedulerOwnerSpace(action.ownerSpace),
    piece_id: action.pieceId,
    process_generation: action.processGeneration,
    action_id: action.actionId,
    execution_context_key: action.executionContextKey,
  }) as {
    write_space: string;
    write_id: EntityId;
    write_scope: string;
    write_scope_key: string;
    write_path: string;
  }[];

  const writes = new Map<string, ResolvedSchedulerObservationAddress>();
  for (const row of rows) {
    const write: ResolvedSchedulerObservationAddress = {
      ...normalizeSchedulerAddress({
        space: row.write_space,
        id: row.write_id,
        scope: row.write_scope as CellScope,
        path: decodeSchedulerPath(row.write_path),
      }),
      scopeKey: row.write_scope_key,
    };
    writes.set(
      `${write.space}\0${write.scopeKey}\0${write.id}\0${
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
  read_scope_key: string;
  read_path: string;
  read_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: SchedulerExecutionContextKey;
  observation_id: number;
};

type SchedulerWriteIndexRow = {
  branch: BranchName;
  owner_space: string;
  write_space: string;
  write_id: EntityId;
  write_scope: string;
  write_scope_key: string;
  write_path: string;
  write_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: SchedulerExecutionContextKey;
  observation_id: number;
};

type SchedulerWriterLookupRow = SchedulerWriteIndexRow & {
  commit_seq: number | null;
  observed_at_seq: number;
  payload: string;
  direct_dirty_seq: number | null;
  stale_seq: number | null;
  unknown_reason: string | null;
};

type SchedulerSnapshotRow = {
  observation_id: number;
  execution_context_key: SchedulerExecutionContextKey;
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
  execution_context_key: SchedulerExecutionContextKey;
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
    ...(observation.completeActionScopeSummary
      ? {
        completeActionScopeSummary: normalizeCompleteActionScopeSummary(
          observation.completeActionScopeSummary,
        ),
      }
      : {}),
    reads: observation.reads.map(normalizeSchedulerAddress),
    shallowReads: observation.shallowReads.map(normalizeSchedulerAddress),
    actualChangedWrites: observation.actualChangedWrites.map(
      normalizeSchedulerAddress,
    ),
    currentKnownWrites: observation.currentKnownWrites.map(
      normalizeSchedulerAddress,
    ),
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

function normalizeCompleteActionScopeSummary(
  summary: CompleteActionScopeSummary,
): CompleteActionScopeSummary {
  return {
    ...summary,
    piece: normalizeSchedulerAddress(summary.piece),
    reads: summary.reads.map(normalizeSchedulerAddress),
    writes: summary.writes.map(normalizeSchedulerAddress),
    materializerWriteEnvelopes: summary.materializerWriteEnvelopes.map(
      normalizeSchedulerAddress,
    ),
    directOutputs: summary.directOutputs.map(normalizeSchedulerAddress),
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

function resolveSchedulerAddress(
  address: SchedulerObservationAddress,
  scopeContext: SchedulerScopeContext,
): ResolvedSchedulerObservationAddress {
  const normalized = normalizeSchedulerAddress(address);
  return {
    ...normalized,
    scopeKey: resolveScopeKey(normalized.scope, scopeContext),
  };
}

type SchedulerContextScope = "space" | "user" | "session";

const schedulerContextRank = (scope: SchedulerContextScope): number =>
  scope === "space" ? 0 : scope === "user" ? 1 : 2;

const narrowerSchedulerContext = (
  left: SchedulerContextScope,
  right: SchedulerContextScope,
): SchedulerContextScope =>
  schedulerContextRank(left) >= schedulerContextRank(right) ? left : right;

const schedulerSummaryAddresses = (
  summary: CompleteActionScopeSummary,
): SchedulerObservationAddress[] => [
  summary.piece,
  ...summary.reads,
  ...summary.writes,
  ...summary.materializerWriteEnvelopes,
  ...summary.directOutputs,
];

const schedulerObservationAddresses = (
  observation: SchedulerActionObservation,
): SchedulerObservationAddress[] => [
  ...observation.reads,
  ...observation.shallowReads,
  ...observation.actualChangedWrites,
  ...observation.currentKnownWrites,
  ...(observation.declaredWrites ?? []),
  ...observation.materializerWriteEnvelopes,
  ...(observation.ignoredSchedulingWrites ?? []),
];

function trustedSchedulerScopeSummary(
  observation: SchedulerActionObservation,
): CompleteActionScopeSummary | undefined {
  const summary = observation.completeActionScopeSummary;
  const ownerSpace = observation.ownerSpace;
  if (
    !summary || summary.version !== 1 || summary.complete !== true ||
    summary.implementationFingerprint !==
      observation.implementationFingerprint ||
    !observation.implementationFingerprint.startsWith("impl:") ||
    summary.runtimeFingerprint !== observation.runtimeFingerprint ||
    ownerSpace === undefined ||
    `${normalizeSchedulerScope(summary.piece.scope)}:${summary.piece.id}` !==
      observation.pieceId ||
    summary.piece.space !== ownerSpace
  ) {
    return undefined;
  }
  return summary;
}

function schedulerAddressCoveredBy(
  address: SchedulerObservationAddress,
  envelopes: readonly SchedulerObservationAddress[],
): boolean {
  const normalized = normalizeSchedulerAddress(address);
  return envelopes.some((envelope) => {
    const normalizedEnvelope = normalizeSchedulerAddress(envelope);
    return normalized.space === normalizedEnvelope.space &&
      normalized.id === normalizedEnvelope.id &&
      normalized.scope === normalizedEnvelope.scope &&
      pathIsPrefix(normalizedEnvelope.path, normalized.path);
  });
}

function schedulerRuntimeExceedsSummary(
  observation: SchedulerActionObservation,
  summary: CompleteActionScopeSummary,
): boolean {
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  return [...observation.reads, ...observation.shallowReads].some((address) =>
    !schedulerAddressCoveredBy(address, summary.reads)
  ) ||
    [
      ...observation.actualChangedWrites,
      ...observation.currentKnownWrites,
      ...(observation.declaredWrites ?? []),
      ...(observation.ignoredSchedulingWrites ?? []),
    ].some((address) => !schedulerAddressCoveredBy(address, writeEnvelopes)) ||
    observation.materializerWriteEnvelopes.some((address) =>
      !schedulerAddressCoveredBy(
        address,
        summary.materializerWriteEnvelopes,
      )
    );
}

type ExecutionActionTransaction = Pick<
  ClientCommit,
  "reads" | "operations" | "preconditions" | "merge"
>;

const rejectExecutionAction = (
  diagnosticCode: string,
  message: string,
): never => {
  throw new ExecutionActionFirewallError(diagnosticCode, message);
};

const assertSpaceScopedAddress = (
  address: SchedulerObservationAddress,
  servedSpace: string,
  scopeContext: SchedulerScopeContext,
): void => {
  if (address.space !== servedSpace) {
    rejectExecutionAction(
      "foreign-space-surface",
      `surface ${address.id} belongs to ${address.space}, not ${servedSpace}`,
    );
  }
  if (resolveScopeKey(address.scope, scopeContext) !== DEFAULT_SCOPE_KEY) {
    rejectExecutionAction(
      "non-space-scope",
      `surface ${address.id} does not resolve to the space scope`,
    );
  }
};

/**
 * Validate the complete static and observed surface plus the actual commit
 * shape for one positively claimed action. This function is pure; callers run
 * it inside the same IMMEDIATE transaction before any commit row, revision,
 * scheduler row, SQLite statement, or merge state can be applied.
 */
const assertExecutionActionTransaction = (
  options: {
    servedSpace: string;
    branch: BranchName;
    scopeContext: SchedulerScopeContext;
    transaction: ExecutionActionTransaction;
    observation: SchedulerActionObservation;
  },
): void => {
  const { observation, transaction } = options;
  if (
    observation.ownerSpace !== options.servedSpace ||
    observation.branch !== options.branch
  ) {
    rejectExecutionAction(
      "claim-lane-mismatch",
      "observation owner space or branch does not match the served lane",
    );
  }
  const summary = trustedSchedulerScopeSummary(observation);
  if (summary === undefined) {
    return rejectExecutionAction(
      "incomplete-static-scope",
      "execution claim context requires a complete trusted static scope summary",
    );
  }

  for (const address of schedulerSummaryAddresses(summary)) {
    assertSpaceScopedAddress(
      address,
      options.servedSpace,
      options.scopeContext,
    );
  }
  for (const address of schedulerObservationAddresses(observation)) {
    assertSpaceScopedAddress(
      address,
      options.servedSpace,
      options.scopeContext,
    );
  }
  if (schedulerRuntimeExceedsSummary(observation, summary)) {
    rejectExecutionAction(
      "runtime-exceeds-static-scope",
      "observed action surfaces exceed the complete static summary",
    );
  }

  if (transaction.merge !== undefined) {
    rejectExecutionAction(
      "merge-commit",
      "claimed actions may not carry branch merge metadata",
    );
  }
  for (const precondition of transaction.preconditions ?? []) {
    if (
      precondition.kind === "entity-absent" &&
      resolveScopeKey(precondition.scope, options.scopeContext) !==
        DEFAULT_SCOPE_KEY
    ) {
      rejectExecutionAction(
        "non-space-scope",
        `precondition ${precondition.id} does not resolve to the space scope`,
      );
    }
  }

  // Framework-owned piece/argument/internal reads are deliberately excluded
  // from the scheduler's reactive read log, but the trusted complete summary
  // includes them. Claimed admission therefore accepts a canonical commit
  // read when either runtime evidence or that exhaustive certificate covers
  // it; reads outside both remain unobserved and fail closed.
  const observedReads = [
    ...observation.reads,
    ...observation.shallowReads,
    ...summary.reads,
  ];
  for (const read of transaction.reads.confirmed) {
    if ((read.branch ?? options.branch) !== options.branch) {
      rejectExecutionAction(
        "cross-branch-read",
        `confirmed read ${read.id} belongs to another branch`,
      );
    }
    if (
      resolveScopeKey(read.scope, options.scopeContext) !== DEFAULT_SCOPE_KEY
    ) {
      rejectExecutionAction(
        "non-space-scope",
        `confirmed read ${read.id} does not resolve to the space scope`,
      );
    }
    const address: SchedulerObservationAddress = {
      space: options.servedSpace,
      id: read.id,
      scope: read.scope,
      path: read.path,
    };
    if (!schedulerAddressCoveredBy(address, observedReads)) {
      rejectExecutionAction(
        "unobserved-read",
        `confirmed read ${read.id} is absent from the action observation`,
      );
    }
  }
  for (const read of transaction.reads.pending) {
    if (
      resolveScopeKey(read.scope, options.scopeContext) !== DEFAULT_SCOPE_KEY
    ) {
      rejectExecutionAction(
        "non-space-scope",
        `pending read ${read.id} does not resolve to the space scope`,
      );
    }
    const address: SchedulerObservationAddress = {
      space: options.servedSpace,
      id: read.id,
      scope: read.scope,
      path: read.path,
    };
    if (!schedulerAddressCoveredBy(address, observedReads)) {
      rejectExecutionAction(
        "unobserved-read",
        `pending read ${read.id} is absent from the action observation`,
      );
    }
  }

  for (const operation of transaction.operations) {
    if (operation.op === "sqlite") {
      rejectExecutionAction(
        "sqlite-operation",
        "claimed actions may not execute folded SQLite writes",
      );
      continue;
    }
    if (
      resolveScopeKey(operation.scope, options.scopeContext) !==
        DEFAULT_SCOPE_KEY
    ) {
      rejectExecutionAction(
        "non-space-scope",
        `write ${operation.id} does not resolve to the space scope`,
      );
    }
    const matchingWrites = observation.actualChangedWrites.filter((write) =>
      write.space === options.servedSpace && write.id === operation.id &&
      resolveScopeKey(write.scope, options.scopeContext) === DEFAULT_SCOPE_KEY
    );
    if (matchingWrites.length === 0) {
      rejectExecutionAction(
        "unobserved-write",
        `write ${operation.id} is absent from the action observation`,
      );
    }
    if (
      operation.op === "patch" &&
      operation.patches.flatMap(touchedPointerPaths).some((path) =>
        !matchingWrites.some((write) => pathsOverlap(write.path, path))
      )
    ) {
      rejectExecutionAction(
        "unobserved-write",
        `patch write ${operation.id} exceeds the observed changed paths`,
      );
    }
  }
};

function schedulerStaticContextFloor(
  observation: SchedulerActionObservation,
): SchedulerContextScope {
  const summary = trustedSchedulerScopeSummary(observation);
  const ownerSpace = observation.ownerSpace;
  if (!summary || ownerSpace === undefined) {
    return "session";
  }

  const addresses = schedulerSummaryAddresses(summary).map(
    normalizeSchedulerAddress,
  );
  const crossesSpace = addresses.some((address) =>
    address.space !== ownerSpace
  );
  if (
    addresses.some((address) =>
      normalizeSchedulerScope(address.scope) === "session"
    )
  ) {
    return "session";
  }
  if (
    addresses.some((address) =>
      normalizeSchedulerScope(address.scope) === "user"
    )
  ) {
    return "user";
  }
  return crossesSpace ? "session" : "space";
}

function schedulerRuntimeContextFloor(
  observation: SchedulerActionObservation,
): SchedulerContextScope {
  const ownerSpace = observation.ownerSpace;
  const addresses = schedulerObservationAddresses(observation);
  const summary = trustedSchedulerScopeSummary(observation);
  if (
    ownerSpace === undefined ||
    (summary !== undefined &&
      schedulerRuntimeExceedsSummary(observation, summary)) ||
    (summary === undefined &&
      addresses.some((address) => address.space !== ownerSpace)) ||
    addresses.some((address) =>
      normalizeSchedulerScope(address.scope) === "session"
    )
  ) {
    return "session";
  }
  return addresses.some((address) =>
      normalizeSchedulerScope(address.scope) === "user"
    )
    ? "user"
    : "space";
}

type SchedulerContextFloorKey = {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  implementationFingerprint: string;
  runtimeFingerprint: string;
};

function schedulerContextFloor(
  engine: Engine,
  key: SchedulerContextFloorKey,
  principalKey: string,
): SchedulerContextScope {
  const row = engine.database.prepare(`
    SELECT floor_scope
    FROM scheduler_context_floor
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND implementation_fingerprint = :implementation_fingerprint
      AND runtime_fingerprint = :runtime_fingerprint
      AND principal_key = :principal_key
  `).get({
    branch: key.branch,
    owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
    implementation_fingerprint: key.implementationFingerprint,
    runtime_fingerprint: key.runtimeFingerprint,
    principal_key: principalKey,
  }) as { floor_scope: SchedulerContextScope } | undefined;
  return row?.floor_scope ?? "space";
}

function upsertSchedulerContextFloor(
  engine: Engine,
  key: SchedulerContextFloorKey,
  principalKey: string,
  floor: SchedulerContextScope,
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_context_floor (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      implementation_fingerprint,
      runtime_fingerprint,
      principal_key,
      floor_scope
    ) VALUES (
      :branch,
      :owner_space,
      :piece_id,
      :process_generation,
      :action_id,
      :implementation_fingerprint,
      :runtime_fingerprint,
      :principal_key,
      :floor_scope
    )
    ON CONFLICT (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      implementation_fingerprint,
      runtime_fingerprint,
      principal_key
    ) DO UPDATE SET floor_scope = CASE
      WHEN excluded.floor_scope = 'session' THEN 'session'
      WHEN excluded.floor_scope = 'user' AND floor_scope = 'space' THEN 'user'
      ELSE floor_scope
    END
  `).run({
    branch: key.branch,
    owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
    implementation_fingerprint: key.implementationFingerprint,
    runtime_fingerprint: key.runtimeFingerprint,
    principal_key: principalKey,
    floor_scope: floor,
  });
}

function schedulerSnapshotMatchesFingerprint(
  engine: Engine,
  key: SchedulerContextFloorKey,
  executionContextKey: SchedulerExecutionContextKey,
): boolean {
  const row = selectSchedulerSnapshotRow(engine, {
    branch: key.branch,
    ownerSpace: key.ownerSpace,
    pieceId: key.pieceId,
    processGeneration: key.processGeneration,
    actionId: key.actionId,
    executionContextKey,
  });
  if (!row) return false;
  try {
    const existing = decodeSchedulerObservation(row.payload);
    return existing.implementationFingerprint ===
        key.implementationFingerprint &&
      existing.runtimeFingerprint === key.runtimeFingerprint;
  } catch {
    return false;
  }
}

function schedulerContextScopeForCanonicalKey(
  executionContextKey: SchedulerExecutionContextKey,
  scopeContext: SchedulerScopeContext,
): SchedulerContextScope {
  if (executionContextKey === "space") return "space";
  if (executionContextKey === resolveScopeKey("user", scopeContext)) {
    return "user";
  }
  if (executionContextKey === resolveScopeKey("session", scopeContext)) {
    return "session";
  }
  throw new ProtocolError(
    "mirrored scheduler execution context does not match the authenticated scope context",
  );
}

function invalidatedSchedulerExecutionContexts(
  engine: Engine,
  floorKey: SchedulerContextFloorKey,
  effectiveFloor: SchedulerContextScope,
  scopeContext: SchedulerScopeContext,
): SchedulerExecutionContextKey[] {
  const invalidated: SchedulerExecutionContextKey[] = [];
  if (schedulerContextRank(effectiveFloor) > schedulerContextRank("space")) {
    const spaceKey = resolveScopeKey(
      "space",
      scopeContext,
    ) as SchedulerExecutionContextKey;
    if (schedulerSnapshotMatchesFingerprint(engine, floorKey, spaceKey)) {
      invalidated.push(spaceKey);
    }
  }
  if (effectiveFloor === "session") {
    const userKey = resolveScopeKey(
      "user",
      scopeContext,
    ) as SchedulerExecutionContextKey;
    if (schedulerSnapshotMatchesFingerprint(engine, floorKey, userKey)) {
      invalidated.push(userKey);
    }
  }
  return invalidated;
}

function preserveMirroredSchedulerExecutionContext(
  engine: Engine,
  options: {
    branch: BranchName;
    ownerSpace?: string;
    observation: SchedulerActionObservation;
    scopeContext: SchedulerScopeContext;
    originExecutionContextKey: SchedulerExecutionContextKey;
  },
): {
  executionContextKey: SchedulerExecutionContextKey;
  invalidatedExecutionContextKeys: SchedulerExecutionContextKey[];
} {
  const floorKey: SchedulerContextFloorKey = {
    branch: options.branch,
    ownerSpace: options.ownerSpace,
    pieceId: options.observation.pieceId,
    processGeneration: options.observation.processGeneration,
    actionId: options.observation.actionId,
    implementationFingerprint: options.observation.implementationFingerprint,
    runtimeFingerprint: options.observation.runtimeFingerprint,
  };
  const effectiveFloor = schedulerContextScopeForCanonicalKey(
    options.originExecutionContextKey,
    options.scopeContext,
  );
  // Retain the owner's narrowing evidence so an accidental non-mirror write to
  // this ownership tuple cannot broaden it later. PerSession evidence stays on
  // the authenticated principal lineage; PerUser evidence is globally safe.
  if (effectiveFloor === "user") {
    upsertSchedulerContextFloor(engine, floorKey, "", "user");
  } else if (effectiveFloor === "session") {
    upsertSchedulerContextFloor(
      engine,
      floorKey,
      resolveScopeKey("user", options.scopeContext),
      "session",
    );
  }
  return {
    executionContextKey: options.originExecutionContextKey,
    invalidatedExecutionContextKeys: invalidatedSchedulerExecutionContexts(
      engine,
      floorKey,
      effectiveFloor,
      options.scopeContext,
    ),
  };
}

function resolveSchedulerExecutionContext(
  engine: Engine,
  options: {
    branch: BranchName;
    ownerSpace?: string;
    observation: SchedulerActionObservation;
    scopeContext: SchedulerScopeContext;
  },
): {
  executionContextKey: SchedulerExecutionContextKey;
  invalidatedExecutionContextKeys: SchedulerExecutionContextKey[];
} {
  const { observation, scopeContext } = options;
  const floorKey: SchedulerContextFloorKey = {
    branch: options.branch,
    ownerSpace: options.ownerSpace,
    pieceId: observation.pieceId,
    processGeneration: observation.processGeneration,
    actionId: observation.actionId,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
  };
  const principalKey = resolveScopeKey("user", scopeContext);
  const staticFloor = schedulerStaticContextFloor(observation);
  const runtimeFloor = schedulerRuntimeContextFloor(observation);

  // Static completeness applies to every principal for the fingerprint.
  upsertSchedulerContextFloor(engine, floorKey, "", staticFloor);
  // Runtime evidence that disproves sharing is global at least through user;
  // PerSession/cross-space narrowing remains scoped to this principal lineage.
  if (schedulerContextRank(runtimeFloor) >= schedulerContextRank("user")) {
    upsertSchedulerContextFloor(engine, floorKey, "", "user");
  }
  if (runtimeFloor === "session") {
    upsertSchedulerContextFloor(
      engine,
      floorKey,
      principalKey,
      "session",
    );
  }

  const globalFloor = schedulerContextFloor(engine, floorKey, "");
  const principalFloor = schedulerContextFloor(engine, floorKey, principalKey);
  const effectiveFloor = [
    staticFloor,
    runtimeFloor,
    globalFloor,
    principalFloor,
  ].reduce(narrowerSchedulerContext);
  const executionContextKey = resolveScopeKey(
    effectiveFloor,
    scopeContext,
  ) as SchedulerExecutionContextKey;

  const invalidatedExecutionContextKeys = invalidatedSchedulerExecutionContexts(
    engine,
    floorKey,
    effectiveFloor,
    scopeContext,
  );

  return { executionContextKey, invalidatedExecutionContextKeys };
}

function invalidateSchedulerExecutionContexts(
  engine: Engine,
  options: {
    branch: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    executionContextKeys: readonly SchedulerExecutionContextKey[];
  },
): void {
  const statementParams = {
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.ownerSpace),
    piece_id: options.pieceId,
    process_generation: options.processGeneration,
    action_id: options.actionId,
  };
  for (const executionContextKey of options.executionContextKeys) {
    const params = {
      ...statementParams,
      execution_context_key: executionContextKey,
    };
    // The snapshot is the canonical owner of the observation payload row.
    // Capture its identity before removing the active context so the payload
    // can be collected once no scheduler indexes refer to it.
    const observations = engine.database.prepare(`
      SELECT observation_id
      FROM scheduler_action_snapshot
      WHERE branch = :branch
        AND owner_space = :owner_space
        AND piece_id = :piece_id
        AND process_generation = :process_generation
        AND action_id = :action_id
        AND execution_context_key = :execution_context_key
    `).all(params) as { observation_id: number }[];
    for (
      const table of [
        "scheduler_read_index",
        "scheduler_write_index",
        "scheduler_action_state",
        "scheduler_action_snapshot",
      ]
    ) {
      engine.database.prepare(`
        DELETE FROM ${table}
        WHERE branch = :branch
          AND COALESCE(owner_space, '') = :owner_space
          AND piece_id = :piece_id
          AND process_generation = :process_generation
          AND action_id = :action_id
          AND execution_context_key = :execution_context_key
      `).run(params);
    }
    for (const { observation_id } of observations) {
      retireSchedulerObservationIfOrphaned(engine, observation_id);
    }
  }
}

function retireSchedulerObservationIfOrphaned(
  engine: Engine,
  observationId: number,
): void {
  const row = engine.database.prepare(`
    SELECT
      EXISTS(
        SELECT 1 FROM scheduler_action_snapshot
        WHERE observation_id = :observation_id
      ) OR EXISTS(
        SELECT 1 FROM scheduler_read_index
        WHERE observation_id = :observation_id
      ) OR EXISTS(
        SELECT 1 FROM scheduler_write_index
        WHERE observation_id = :observation_id
      ) OR EXISTS(
        SELECT 1 FROM scheduler_action_state
        WHERE latest_observation_id = :observation_id
      ) AS active
  `).get({ observation_id: observationId }) as { active: number };
  if (row.active !== 0) return;

  // Replay rows retain status, sequence, and the requested payload needed to
  // reject mismatched retries. Once the active observation is retired, its
  // canonical accepted payload is unreachable and would duplicate that data.
  engine.database.prepare(`
    UPDATE scheduler_observation_replay
    SET observation_id = NULL,
        accepted_payload = NULL
    WHERE observation_id = :observation_id
  `).run({ observation_id: observationId });
  engine.database.prepare(`
    DELETE FROM scheduler_observation
    WHERE observation_id = :observation_id
  `).run({ observation_id: observationId });
}

function normalizeSchedulerScope(scope: CellScope | undefined): CellScope {
  return scope ?? DEFAULT_SCOPE;
}

function isSchedulerWriteIndexKind(
  value: string,
): value is SchedulerWriteIndexKind {
  return value === "current-known" || value === "declared" ||
    value === "materializer";
}

function schedulerObservationContainsIndexedWrite(
  observation: SchedulerActionObservation,
  row: SchedulerWriterLookupRow,
  writePath: readonly string[],
): boolean {
  const writes = row.write_kind === "current-known"
    ? observation.currentKnownWrites
    : row.write_kind === "declared"
    ? observation.declaredWrites ?? []
    : row.write_kind === "materializer"
    ? observation.materializerWriteEnvelopes
    : [];

  return writes.some((write) => {
    const scope = normalizeSchedulerScope(write.scope);
    return write.space === row.write_space &&
      write.id === row.write_id &&
      scope === row.write_scope &&
      schedulerScopeKeyForExecutionContext(
          scope,
          row.execution_context_key,
        ) === row.write_scope_key &&
      write.path.length === writePath.length &&
      write.path.every((part, index) => part === writePath[index]);
  });
}

function schedulerScopeKeyForExecutionContext(
  scope: CellScope,
  executionContextKey: SchedulerExecutionContextKey,
): string | undefined {
  const parts = executionContextKey.split(":");
  let encodedPrincipal: string | undefined;
  let contextScope: "space" | "user" | "session";
  if (executionContextKey === "space") {
    contextScope = "space";
  } else if (parts.length === 2 && parts[0] === "user" && parts[1] !== "") {
    contextScope = "user";
    encodedPrincipal = parts[1];
  } else if (
    parts.length === 3 && parts[0] === "session" && parts[1] !== "" &&
    parts[2] !== ""
  ) {
    contextScope = "session";
    encodedPrincipal = parts[1];
  } else {
    return undefined;
  }

  try {
    if (encodedPrincipal !== undefined) {
      decodeURIComponent(encodedPrincipal);
    }
    if (contextScope === "session") decodeURIComponent(parts[2]);
  } catch {
    return undefined;
  }

  if (scope === "space") return DEFAULT_SCOPE_KEY;
  if (scope === "user" && encodedPrincipal !== undefined) {
    return `user:${encodedPrincipal}`;
  }
  if (scope === "session" && contextScope === "session") {
    return executionContextKey;
  }
  return undefined;
}

function selectSchedulerSnapshotRow(
  engine: Engine,
  key: {
    branch: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    executionContextKey: SchedulerExecutionContextKey;
  },
): SchedulerSnapshotRow | undefined {
  return engine.database.prepare(`
    SELECT
      s.observation_id,
      s.execution_context_key,
      COALESCE(s.commit_seq, o.commit_seq) AS commit_seq,
      s.observed_at_seq AS observed_at_seq,
      s.payload
    FROM scheduler_action_snapshot s
    JOIN scheduler_observation o
      ON o.observation_id = s.observation_id
      AND o.execution_context_key = s.execution_context_key
    WHERE s.branch = :branch
      AND s.owner_space = :owner_space
      AND s.piece_id = :piece_id
      AND s.process_generation = :process_generation
      AND s.action_id = :action_id
      AND s.execution_context_key = :execution_context_key
  `).get({
    branch: key.branch,
    owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
    execution_context_key: key.executionContextKey,
  }) as SchedulerSnapshotRow | undefined;
}

function pruneSchedulerSessionExecutionContexts(
  engine: Engine,
  key: {
    branch: BranchName;
    ownerSpace?: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    principal: string;
  },
): void {
  const sessionPrefix = `session:${encodeScopeKeyPart(key.principal)}:`;
  const expired = engine.database.prepare(`
    SELECT execution_context_key
    FROM scheduler_action_snapshot
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND substr(execution_context_key, 1, length(:session_prefix)) =
        :session_prefix
    ORDER BY observed_at_seq DESC, observation_id DESC
    LIMIT -1 OFFSET :retained_limit
  `).all({
    branch: key.branch,
    owner_space: normalizeSchedulerOwnerSpace(key.ownerSpace),
    piece_id: key.pieceId,
    process_generation: key.processGeneration,
    action_id: key.actionId,
    session_prefix: sessionPrefix,
    retained_limit: MAX_RETAINED_SCHEDULER_SESSION_CONTEXTS_PER_ACTION,
  }) as { execution_context_key: SchedulerExecutionContextKey }[];
  if (expired.length === 0) return;
  invalidateSchedulerExecutionContexts(engine, {
    branch: key.branch,
    ownerSpace: key.ownerSpace,
    pieceId: key.pieceId,
    processGeneration: key.processGeneration,
    actionId: key.actionId,
    executionContextKeys: expired.map((row) => row.execution_context_key),
  });
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
    executionContextKey: SchedulerExecutionContextKey;
    // Commit session key of the writer (resolveCommitSessionKey), retained as
    // replay provenance and live-adoption echo metadata only.
    writerSessionId: string | null;
    observation: SchedulerActionObservation;
    payload: string;
  },
): number {
  runSchedulerObservationStatement("insert observation row", () => {
    engine.database.prepare(`
      INSERT INTO scheduler_observation (
        branch,
        execution_context_key,
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
        :execution_context_key,
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
      execution_context_key: options.executionContextKey,
      commit_seq: options.commitSeq,
      observed_at_seq: options.observedAtSeq,
      session_id: options.writerSessionId,
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
    executionContextKey: SchedulerExecutionContextKey;
    // See insertSchedulerObservationRow — kept current so the row always
    // names the writer whose run the stored payload came from.
    writerSessionId: string | null;
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
        session_id = :session_id,
        execution_context_key = :execution_context_key,
        piece_id = :piece_id,
        action_id = :action_id,
        process_generation = :process_generation,
        payload = :payload
      WHERE observation_id = :observation_id
    `).run({
      observation_id: options.observationId ?? null,
      commit_seq: options.commitSeq,
      observed_at_seq: options.observedAtSeq,
      session_id: options.writerSessionId,
      execution_context_key: options.executionContextKey,
      piece_id: options.observation.pieceId,
      action_id: options.observation.actionId,
      process_generation: options.observation.processGeneration,
      payload: options.payload,
    });
  });
}

// Refresh ONLY the writer session key of an existing observation row. Used on
// the identical-payload coalesce path so echo suppression names the latest
// writer WITHOUT disturbing commit_seq (the adoption-window carrier — see the
// coalesce branch in upsertSchedulerObservationTransaction).
function updateSchedulerObservationWriterSession(
  engine: Engine,
  options: {
    observationId: number;
    writerSessionId: string | null;
  },
): void {
  runSchedulerObservationStatement("update observation writer session", () => {
    engine.database.prepare(`
      UPDATE scheduler_observation
      SET session_id = :session_id
      WHERE observation_id = :observation_id
    `).run({
      observation_id: options.observationId,
      session_id: options.writerSessionId,
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
    acceptedPayload?: string;
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
        payload,
        accepted_payload
      )
      VALUES (
        :branch,
        :session_id,
        :local_seq,
        :status,
        :reason,
        :observation_id,
        :observed_at_seq,
        :payload,
        :accepted_payload
      )
      ON CONFLICT (branch, session_id, local_seq)
      DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        observation_id = excluded.observation_id,
        observed_at_seq = excluded.observed_at_seq,
        payload = excluded.payload,
        accepted_payload = excluded.accepted_payload
    `).run({
      branch: options.branch,
      session_id: options.sessionId,
      local_seq: options.localSeq,
      status: options.status,
      reason: options.reason ?? null,
      observation_id: options.observationId ?? null,
      observed_at_seq: options.observedAtSeq,
      payload: options.payload,
      accepted_payload: options.acceptedPayload ?? null,
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
  execution_context_key: SchedulerExecutionContextKey | null;
  observed_at_seq: number;
  payload: string;
  accepted_payload: string | null;
} | undefined {
  return engine.database.prepare(`
    SELECT
      replay.status,
      replay.reason,
      replay.observation_id,
      active_snapshot.execution_context_key,
      active_snapshot.payload AS accepted_payload,
      replay.observed_at_seq,
      replay.payload
    FROM scheduler_observation_replay replay
    LEFT JOIN scheduler_observation observation
      ON observation.observation_id = replay.observation_id
    LEFT JOIN scheduler_action_snapshot active_snapshot
      ON active_snapshot.observation_id = observation.observation_id
      AND active_snapshot.execution_context_key =
        observation.execution_context_key
      AND active_snapshot.payload =
        COALESCE(replay.accepted_payload, replay.payload)
      AND active_snapshot.observed_at_seq = replay.observed_at_seq
      AND observation.session_id = replay.session_id
    WHERE replay.branch = :branch
      AND replay.session_id = :session_id
      AND replay.local_seq = :local_seq
  `).get({
    branch: options.branch,
    session_id: options.sessionId,
    local_seq: options.localSeq,
  }) as {
    status: AppliedSchedulerObservationResult["status"];
    reason: AppliedSchedulerObservationResult["reason"] | null;
    observation_id: number | null;
    execution_context_key: SchedulerExecutionContextKey | null;
    observed_at_seq: number;
    payload: string;
    accepted_payload: string | null;
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
    executionContextKey: SchedulerExecutionContextKey;
  },
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
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
      :execution_context_key,
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
      action_id,
      execution_context_key
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
    execution_context_key: options.executionContextKey,
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
  executionContextKey: SchedulerExecutionContextKey,
  scopeContext: SchedulerScopeContext,
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
    const normalized = resolveSchedulerAddress(address, scopeContext);
    return {
      branch,
      owner_space: normalizeSchedulerOwnerSpace(observation.ownerSpace),
      read_space: normalized.space,
      read_id: normalized.id,
      read_scope: normalizeSchedulerScope(normalized.scope),
      read_scope_key: normalized.scopeKey,
      read_path: encodeSchedulerPath(normalized.path),
      read_kind: kind,
      piece_id: observation.pieceId,
      process_generation: observation.processGeneration,
      action_id: observation.actionId,
      execution_context_key: executionContextKey,
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
    executionContextKey: SchedulerExecutionContextKey;
    scopeContext: SchedulerScopeContext;
  },
): void {
  const params = {
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    execution_context_key: options.executionContextKey,
  };
  const existingRows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      read_space,
      read_id,
      read_scope,
      read_scope_key,
      read_path,
      read_kind,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id
    FROM scheduler_read_index
    WHERE branch = :branch
      AND COALESCE(owner_space, '') = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `).all(params) as SchedulerReadIndexRow[];
  const nextRows = schedulerReadIndexEntries(
    options.branch,
    options.observationId,
    options.observation,
    options.executionContextKey,
    options.scopeContext,
  );

  const deleteReadRow = engine.database.prepare(`
    DELETE FROM scheduler_read_index
    WHERE branch = :branch
      AND owner_space IS :owner_space
      AND read_space = :read_space
      AND read_id = :read_id
      AND read_scope = :read_scope
      AND read_scope_key = :read_scope_key
      AND read_path = :read_path
      AND read_kind = :read_kind
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `);

  const insertReadRow = engine.database.prepare(`
    INSERT INTO scheduler_read_index (
      branch,
      owner_space,
      read_space,
      read_id,
      read_scope,
      read_scope_key,
      read_path,
      read_kind,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id
    )
    VALUES (
      :branch,
      :owner_space,
      :read_space,
      :read_id,
      :read_scope,
      :read_scope_key,
      :read_path,
      :read_kind,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
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
          AND execution_context_key = :execution_context_key
      `).run(params);
    },
    deleteRow: (row) => {
      deleteReadRow.run({
        branch: row.branch,
        owner_space: row.owner_space,
        read_space: row.read_space,
        read_id: row.read_id,
        read_scope: row.read_scope,
        read_scope_key: row.read_scope_key,
        read_path: row.read_path,
        read_kind: row.read_kind,
        piece_id: row.piece_id,
        process_generation: row.process_generation,
        action_id: row.action_id,
        execution_context_key: row.execution_context_key,
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
    row.read_scope_key,
    row.read_path,
    row.read_kind,
    row.piece_id,
    row.process_generation,
    row.action_id,
    row.execution_context_key,
  ].join("\0");
}

function schedulerWriteIndexEntries(
  branch: BranchName,
  observationId: number,
  observation: SchedulerActionObservation,
  executionContextKey: SchedulerExecutionContextKey,
  scopeContext: SchedulerScopeContext,
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
    const normalized = resolveSchedulerAddress(address, scopeContext);
    return {
      branch,
      owner_space: normalizeSchedulerOwnerSpace(observation.ownerSpace),
      write_space: normalized.space,
      write_id: normalized.id,
      write_scope: normalizeSchedulerScope(normalized.scope),
      write_scope_key: normalized.scopeKey,
      write_path: encodeSchedulerPath(normalized.path),
      write_kind: kind,
      piece_id: observation.pieceId,
      process_generation: observation.processGeneration,
      action_id: observation.actionId,
      execution_context_key: executionContextKey,
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
    executionContextKey: SchedulerExecutionContextKey;
    scopeContext: SchedulerScopeContext;
  },
): void {
  const params = {
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    execution_context_key: options.executionContextKey,
  };
  const existingRows = engine.database.prepare(`
    SELECT
      branch,
      owner_space,
      write_space,
      write_id,
      write_scope,
      write_scope_key,
      write_path,
      write_kind,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id
    FROM scheduler_write_index
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `).all(params) as SchedulerWriteIndexRow[];
  const nextRows = schedulerWriteIndexEntries(
    options.branch,
    options.observationId,
    options.observation,
    options.executionContextKey,
    options.scopeContext,
  );

  const deleteWriteRow = engine.database.prepare(`
    DELETE FROM scheduler_write_index
    WHERE branch = :branch
      AND owner_space = :owner_space
      AND write_space = :write_space
      AND write_id = :write_id
      AND write_scope = :write_scope
      AND write_scope_key = :write_scope_key
      AND write_path = :write_path
      AND write_kind = :write_kind
      AND piece_id = :piece_id
      AND process_generation = :process_generation
      AND action_id = :action_id
      AND execution_context_key = :execution_context_key
  `);

  const insertWriteRow = engine.database.prepare(`
    INSERT INTO scheduler_write_index (
      branch,
      owner_space,
      write_space,
      write_id,
      write_scope,
      write_scope_key,
      write_path,
      write_kind,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
      observation_id
    )
    VALUES (
      :branch,
      :owner_space,
      :write_space,
      :write_id,
      :write_scope,
      :write_scope_key,
      :write_path,
      :write_kind,
      :piece_id,
      :process_generation,
      :action_id,
      :execution_context_key,
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
          AND execution_context_key = :execution_context_key
      `).run(params);
    },
    deleteRow: (row) => {
      deleteWriteRow.run({
        branch: row.branch,
        owner_space: row.owner_space,
        write_space: row.write_space,
        write_id: row.write_id,
        write_scope: row.write_scope,
        write_scope_key: row.write_scope_key,
        write_path: row.write_path,
        write_kind: row.write_kind,
        piece_id: row.piece_id,
        process_generation: row.process_generation,
        action_id: row.action_id,
        execution_context_key: row.execution_context_key,
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
    row.write_scope_key,
    row.write_path,
    row.write_kind,
    row.piece_id,
    row.process_generation,
    row.action_id,
    row.execution_context_key,
  ].join("\0");
}

function upsertSchedulerActionState(
  engine: Engine,
  options: {
    branch: BranchName;
    observation: SchedulerActionObservation;
    executionContextKey: SchedulerExecutionContextKey;
    latestObservationId: number;
    coveredThroughSeq: number;
  },
): void {
  engine.database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      execution_context_key,
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
      :execution_context_key,
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
      action_id,
      execution_context_key
    )
    DO UPDATE SET
      latest_observation_id = excluded.latest_observation_id,
      direct_dirty_seq = CASE
        WHEN direct_dirty_seq > :covered_through_seq THEN direct_dirty_seq
        ELSE NULL
      END,
      stale_seq = CASE
        WHEN stale_seq > :covered_through_seq THEN stale_seq
        ELSE NULL
      END,
      unknown_reason = NULL
  `).run({
    branch: options.branch,
    owner_space: normalizeSchedulerOwnerSpace(options.observation.ownerSpace),
    piece_id: options.observation.pieceId,
    process_generation: options.observation.processGeneration,
    action_id: options.observation.actionId,
    execution_context_key: options.executionContextKey,
    latest_observation_id: options.latestObservationId,
    covered_through_seq: options.coveredThroughSeq,
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
  if (
    !Array.isArray(path) ||
    !path.every((part): part is string => typeof part === "string")
  ) {
    throw new Error("scheduler paths must be arrays of strings");
  }
  return path;
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
  executionContextKey: SchedulerExecutionContextKey;
}): string {
  return `${entry.branch}\0${
    normalizeSchedulerOwnerSpace(entry.ownerSpace)
  }\0${entry.pieceId}\0${entry.processGeneration}\0${entry.actionId}\0${entry.executionContextKey}`;
}

function schedulerWriterCandidateKey(entry: {
  branch: BranchName;
  ownerSpace?: string | null;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
}): string {
  return [
    entry.branch,
    normalizeSchedulerOwnerSpace(entry.ownerSpace),
    entry.pieceId,
    String(entry.processGeneration),
    entry.actionId,
    entry.executionContextKey,
  ].join("\0");
}

function schedulerMatchedWriteKey(match: SchedulerMatchedWrite): string {
  return [
    match.kind,
    match.write.space,
    match.write.scopeKey,
    match.write.id,
    encodeSchedulerPath(match.write.path),
  ].join("\0");
}

function compareSchedulerKeys(left: string, right: string): number {
  return utf8Compare(left, right);
}

const applyCommitTransaction = (
  engine: Engine,
  {
    sessionId,
    scopeSessionId = sessionId,
    space,
    principal,
    commit,
    executionClaims,
    executionLeaseFence,
    sqliteAttachments,
  }: ApplyCommitOptions,
): AppliedCommit => {
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  const scopeContext = { principal, sessionId: scopeSessionId };
  const schedulerObservation = commit
    .schedulerObservation as SchedulerActionObservation | undefined;
  const schedulerObservationBatch = commit.schedulerObservationBatch ?? [];
  const hasSchedulerObservationBatch = schedulerObservationBatch.length > 0;
  if ((schedulerObservation || hasSchedulerObservationBatch) && !principal) {
    throw new ProtocolError(
      "scheduler observations require an authenticated principal",
    );
  }
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
    const observationReplay = schedulerObservation
      ? getSchedulerObservationReplay(engine, {
        branch: existing.branch,
        sessionId: sessionKey,
        localSeq: commit.localSeq,
      })
      : undefined;
    const observationResult = observationReplay
      ? replayedSchedulerObservationResult(
        commit.localSeq,
        observationReplay,
      )
      : undefined;
    return markAppliedCommitReplay({
      seq: existing.seq,
      branch: existing.branch,
      revisions: selectCommitRevisions(engine, existing.seq),
      ...(observationResult?.schedulerObservationId !== undefined
        ? { schedulerObservationId: observationResult.schedulerObservationId }
        : {}),
      ...(observationResult
        ? { schedulerObservationResults: [observationResult] }
        : {}),
    });
  }

  // Preconditions gate every commit shape, including the observation-only
  // fast paths below — a descendant of an uncommitted origin must not
  // persist anything, observations included.
  validateCommitPreconditions(engine, sessionKey, branch, commit, scopeContext);

  if (commit.operations.length === 0 && hasSchedulerObservationBatch) {
    return applySchedulerObservationBatchCommit(engine, {
      sessionId,
      scopeSessionId,
      sessionKey,
      space,
      principal,
      branch,
      batch: schedulerObservationBatch,
      executionClaims,
      executionLeaseFence,
    });
  }

  if (commit.operations.length === 0 && schedulerObservation) {
    return applySchedulerObservationOnlyCommit(engine, {
      sessionId,
      scopeSessionId,
      sessionKey,
      space,
      principal,
      branch,
      localSeq: commit.localSeq,
      transaction: commit,
      schedulerObservation,
      executionClaim: executionClaims?.get(commit.localSeq),
      executionLeaseFence,
    });
  }

  validateConfirmedReads(engine, branch, commit, scopeContext);
  const resolvedPendingReads = resolvePendingReads(
    engine,
    sessionKey,
    scopeContext,
    branch,
    commit,
  );
  const inputBasisSeq = acceptedInputBasisSeq(
    commit.reads.confirmed,
    resolvedPendingReads,
  );
  const executionClaim = executionClaims?.get(commit.localSeq);
  const acceptedObservation = schedulerObservation
    ? acceptedSchedulerObservation(schedulerObservation, {
      branch,
      space,
      principal,
      inputBasisSeq,
      executionClaim,
      ...(executionClaim !== undefined
        ? {
          causedBy: schedulerActionCauseCoverage(engine, {
            branch,
            ownerSpace: space ?? schedulerObservation.ownerSpace,
            pieceId: schedulerObservation.pieceId,
            processGeneration: schedulerObservation.processGeneration,
            actionId: schedulerObservation.actionId,
            executionContextKey: executionClaim.contextKey,
          }, inputBasisSeq).causedBy,
        }
        : {}),
    })
    : undefined;
  if (
    acceptedObservation?.provenance !== undefined &&
    schedulerObservation?.status === "failed"
  ) {
    throw new ProtocolError(
      "failed claimed actions must not include semantic operations",
    );
  }
  if (acceptedObservation?.provenance !== undefined) {
    if (acceptedObservation.unservedDiagnosticCode !== undefined) {
      rejectExecutionAction(
        "unserved-marker-with-operations",
        "an unserved attempt marker is valid only without semantic operations",
      );
    }
    assertExecutionActionTransaction({
      servedSpace: space!,
      branch,
      scopeContext: { principal: principal!, sessionId: scopeSessionId },
      transaction: commit,
      observation: schedulerObservation!,
    });
  }

  assertExecutionLeaseFenceTransaction(engine, {
    fence: executionLeaseFence,
    space,
    branch,
    principal,
    claims: executionClaims === undefined ? [] : [...executionClaims.values()],
    requireExactClaim: commit.operations.length > 0,
  });

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
        ...scopeContext,
      });
      continue;
    }
    const revision = writeOperation(engine, {
      branch,
      seq,
      opIndex,
      operation,
      ...scopeContext,
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
      ...(acceptedObservation?.provenance !== undefined
        ? {
          ignoredAction: {
            branch,
            ownerSpace: space ?? acceptedObservation.observation.ownerSpace,
            pieceId: acceptedObservation.observation.pieceId,
            processGeneration:
              acceptedObservation.observation.processGeneration,
            actionId: acceptedObservation.observation.actionId,
            executionContextKey:
              acceptedObservation.provenance.claim.contextKey,
          },
        }
        : {}),
    });
  }

  const schedulerObservationResult = acceptedObservation
    ? upsertSchedulerObservationTransaction(engine, {
      branch,
      ownerSpace: space ?? acceptedObservation.observation.ownerSpace,
      commitSeq: seq,
      observedAtSeq: seq,
      scopeContext: { principal: principal!, sessionId: scopeSessionId },
      writerSessionId: sessionKey,
      localSeq: commit.localSeq,
      ...(acceptedObservation.provenance !== undefined
        ? { causeCoverageSeq: inputBasisSeq }
        : {}),
      replayPayload: schedulerObservationReplayPayload({
        branch,
        observedAtSeq: seq,
        ownerSpace: space ?? schedulerObservation!.ownerSpace,
        observation: schedulerObservation!,
      }),
      observation: acceptedObservation.observation,
    })
    : undefined;
  if (
    acceptedObservation?.provenance !== undefined &&
    schedulerObservationResult?.executionContextKey !==
      acceptedObservation.provenance.claim.contextKey
  ) {
    throw new ProtocolError(
      "execution claim context does not match the effective scheduler context",
    );
  }

  return {
    seq,
    branch,
    revisions,
    ...(schedulerObservationResult
      ? {
        schedulerObservationId: schedulerObservationResult.observationId,
        schedulerObservationResults: [{
          localSeq: commit.localSeq,
          status: "kept" as const,
          schedulerObservationId: schedulerObservationResult.observationId,
          executionContextKey: schedulerObservationResult.executionContextKey,
          inputBasisSeq,
          ...(acceptedObservation?.provenance !== undefined
            ? { executionProvenance: acceptedObservation.provenance }
            : {}),
        }],
      }
      : {}),
    ...(acceptedObservation?.provenance !== undefined &&
        executionClaims?.get(commit.localSeq) !== undefined
      ? {
        actionAttempts: [{
          localSeq: commit.localSeq,
          claim: executionClaims.get(commit.localSeq)!,
          provenance: acceptedObservation.provenance,
          outcome: "committed" as const,
          acceptedCommitSeq: toAcceptedCommitSeq(seq),
        }],
      }
      : {}),
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
    ? { scopeKey }
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
      case "entity-value-hash": {
        if (
          precondition.valueHash !== null &&
          typeof precondition.valueHash !== "string"
        ) {
          throw new ProtocolError(
            "malformed entity-value-hash precondition: valueHash must be a string or null",
          );
        }
        const state = readState(engine, {
          branch,
          id: precondition.id,
          scope: precondition.scope,
          principal: scopeContext.principal,
          sessionId: scopeContext.sessionId,
        });
        const currentHash = state?.document === null ||
            state?.document === undefined ||
            !Object.hasOwn(state.document, "value")
          ? null
          : commitPreconditionValueHash(state.document.value);
        if (currentHash !== precondition.valueHash) {
          throw new ConflictError(
            `entity-value-hash precondition target changed: ${precondition.id}`,
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
  commit: Pick<ClientCommit, "reads">,
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
  scopeContext: { principal?: string; sessionId: SessionId },
  branch: BranchName,
  commit: Pick<ClientCommit, "reads">,
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
      resolveScopeKey(read.scope, scopeContext),
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

/**
 * Compute the scalar basis from reads whose revision identities are accepted
 * by the canonical transaction path. Confirmed reads already name their
 * durable sequence; pending reads use the server-assigned sequence of the
 * source commit. The accepting head/commit sequence is deliberately absent.
 */
const acceptedInputBasisSeq = (
  confirmed: ClientCommit["reads"]["confirmed"],
  resolvedPending: readonly { seq: number }[],
): InputBasisSeq => {
  let basis = 0;
  for (const read of confirmed) basis = Math.max(basis, read.seq);
  for (const read of resolvedPending) basis = Math.max(basis, read.seq);
  return toInputBasisSeq(basis);
};

const resolvedPendingReadsForBasis = (
  engine: Engine,
  sessionKey: string,
  reads: ClientCommit["reads"]["pending"],
): { seq: number }[] => {
  const resolutions = new Map<number, { seq: number }>();
  for (const read of reads) {
    if (resolutions.has(read.localSeq)) continue;
    const row = engine.statements.selectPendingResolution.get({
      session_id: sessionKey,
      local_seq: read.localSeq,
    }) as { seq: number } | undefined;
    // A missing dependency is handled by the existing observation validation
    // and the observation is dropped. It contributes no accepted basis.
    if (row !== undefined) resolutions.set(read.localSeq, row);
  }
  return [...resolutions.values()];
};

const claimKeyFromExecutionClaim = (
  claim: ExecutionClaim,
): ActionExecutionProvenance["claim"] => ({
  branch: claim.branch,
  space: claim.space,
  contextKey: claim.contextKey,
  pieceId: claim.pieceId,
  actionId: claim.actionId,
  actionKind: claim.actionKind,
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
});

const acceptedSchedulerObservation = (
  observation: SchedulerActionObservation,
  options: {
    branch: BranchName;
    space?: string;
    principal?: string;
    inputBasisSeq: InputBasisSeq;
    executionClaim?: ExecutionClaim;
    causedBy?: readonly number[];
  },
): {
  observation: SchedulerActionObservation;
  provenance?: ActionExecutionProvenance;
  unservedDiagnosticCode?: string;
} => {
  const assertedClaim = observation.executionClaimAssertion;
  const unservedAttempt = observation.executionUnservedAttempt;
  // Reserved fields are host outputs. Strip any wire/Worker assertion before
  // constructing the canonical accepted observation.
  const {
    inputBasisSeq: _assertedBasis,
    executionClaimAssertion: _assertedClaim,
    executionUnservedAttempt: _unservedAttempt,
    executionProvenance: _assertedProvenance,
    ...untrustedObservation
  } = observation;
  const claim = options.executionClaim;
  if (claim === undefined) {
    if (assertedClaim !== undefined || unservedAttempt !== undefined) {
      throw new ExecutionLeaseFenceError(
        "execution claim incarnation is not live for this action attempt",
      );
    }
    return {
      observation: {
        ...untrustedObservation,
        inputBasisSeq: options.inputBasisSeq,
      },
    };
  }
  if (
    assertedClaim === undefined ||
    assertedClaim.contextKey !== claim.contextKey ||
    assertedClaim.leaseGeneration !== claim.leaseGeneration ||
    assertedClaim.claimGeneration !== claim.claimGeneration ||
    options.principal === undefined || options.space === undefined ||
    claim.branch !== options.branch || claim.space !== options.space ||
    // Initial server execution is deliberately space-scoped. W1.3 owns the
    // full firewall; a host cannot smuggle a narrower claim through W0.4.
    claim.contextKey !== "space" ||
    claim.pieceId !== observation.pieceId ||
    claim.actionId !== observation.actionId ||
    claim.actionKind !== observation.actionKind ||
    claim.implementationFingerprint !== observation.implementationFingerprint ||
    claim.runtimeFingerprint !== observation.runtimeFingerprint ||
    observation.actionKind === "event-handler" ||
    observation.transactionKind !== "action-run"
  ) {
    throw new ExecutionLeaseFenceError(
      "execution claim incarnation does not match the accepted scheduler action",
    );
  }
  const provenance: ActionExecutionProvenance = {
    claim: claimKeyFromExecutionClaim(claim),
    onBehalfOf: options.principal,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
    causedBy: [...new Set(options.causedBy ?? [])]
      .filter((sourceSeq) => Number.isSafeInteger(sourceSeq) && sourceSeq > 0)
      .sort((left, right) => left - right),
    inputBasisSeq: options.inputBasisSeq,
  };
  return {
    provenance,
    ...(unservedAttempt !== undefined
      ? { unservedDiagnosticCode: unservedAttempt.diagnosticCode }
      : {}),
    observation: {
      ...untrustedObservation,
      inputBasisSeq: options.inputBasisSeq,
      // An unserved attempt may have discovered a narrower/foreign surface.
      // Persist that scheduler evidence under its derived context without
      // falsely labeling the observation as a space-scoped accepted execution.
      ...(unservedAttempt === undefined
        ? { executionProvenance: provenance }
        : {}),
    },
  };
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
    scopeContext,
    branch,
    reads,
  }: {
    sessionKey: string;
    scopeContext: { principal?: string; sessionId: SessionId };
    branch: BranchName;
    reads: ClientCommit["reads"];
  },
): SchedulerObservationDropReason | undefined => {
  for (const read of reads.confirmed) {
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
      resolveScopeKey(read.scope, scopeContext),
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
    execution_context_key: SchedulerExecutionContextKey | null;
    accepted_payload: string | null;
  },
): AppliedSchedulerObservationResult => {
  if (replay.status === "dropped") {
    return {
      localSeq,
      status: "dropped",
      reason: replay.reason ?? "stale-confirmed-read",
    };
  }
  const accepted = replay.accepted_payload === null
    ? undefined
    : decodeSchedulerObservation(replay.accepted_payload);
  return {
    localSeq,
    status: "kept",
    ...(replay.observation_id !== null
      ? { schedulerObservationId: replay.observation_id }
      : {}),
    ...(replay.execution_context_key !== null
      ? { executionContextKey: replay.execution_context_key }
      : {}),
    ...(accepted?.inputBasisSeq !== undefined
      ? { inputBasisSeq: accepted.inputBasisSeq }
      : {}),
    ...(accepted?.executionProvenance !== undefined
      ? { executionProvenance: accepted.executionProvenance }
      : {}),
  };
};

const schedulerObservationReplayPayload = (
  options: {
    branch: BranchName;
    observedAtSeq: number;
    ownerSpace?: string;
    observation: SchedulerActionObservation;
  },
): string => {
  // Replay identity is the client/Worker request, not host-derived acceptance
  // metadata. A reconnect may reconstruct the same authority separately.
  const {
    inputBasisSeq: _acceptedBasis,
    executionProvenance: _acceptedProvenance,
    ...requestedObservation
  } = options.observation;
  return encodeSchedulerDependencySnapshot(
    normalizeSchedulerObservation(
      requestedObservation as SchedulerActionObservation,
      options.branch,
      options.observedAtSeq,
      options.ownerSpace,
    ),
  );
};

const applySchedulerObservationOnlyCommit = (
  engine: Engine,
  {
    sessionId,
    scopeSessionId,
    sessionKey,
    space,
    principal,
    branch,
    localSeq,
    transaction,
    schedulerObservation,
    executionClaim,
    executionLeaseFence,
  }: {
    sessionId: SessionId;
    scopeSessionId: SessionId;
    sessionKey: string;
    space?: string;
    principal?: string;
    branch: BranchName;
    localSeq: number;
    transaction: ExecutionActionTransaction;
    schedulerObservation: SchedulerActionObservation;
    executionClaim?: ExecutionClaim;
    executionLeaseFence?: ExecutionLeaseFence;
  },
): AppliedCommit => {
  const observedAtSeq = headSeq(engine, branch);
  // Request replay identity retains the transient exact-claim assertion while
  // excluding only host-authored acceptance fields. Check it before the live
  // claim fence so a lost-response replay remains idempotent after revoke.
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
    return markAppliedCommitReplay({
      seq: existingReplay.observed_at_seq,
      branch,
      revisions: [],
      ...(replayed.schedulerObservationId !== undefined
        ? { schedulerObservationId: replayed.schedulerObservationId }
        : {}),
      schedulerObservationResults: [replayed],
    });
  }

  const unservedAttempt =
    schedulerObservation.executionUnservedAttempt !== undefined;
  const strictReadValidation = unservedAttempt || executionClaim !== undefined;
  let dropReason: SchedulerObservationDropReason | undefined;
  let inputBasisSeq: InputBasisSeq;
  if (strictReadValidation) {
    // Every claimed settlement is authoritative only after the same canonical
    // conflict path has accepted every input revision. Never turn a stale
    // claimed no-op into a successful dropped observation: reject it so the
    // scheduler catches up and retries. Unserved attempts require the same
    // strict basis even though they do not persist execution provenance.
    validateConfirmedReads(
      engine,
      branch,
      transaction,
      { principal, sessionId: scopeSessionId },
    );
    const resolvedPending = resolvePendingReads(
      engine,
      sessionKey,
      { principal, sessionId: scopeSessionId },
      branch,
      transaction,
    );
    inputBasisSeq = acceptedInputBasisSeq(
      transaction.reads.confirmed,
      resolvedPending,
    );
  } else {
    inputBasisSeq = acceptedInputBasisSeq(
      transaction.reads.confirmed,
      resolvedPendingReadsForBasis(
        engine,
        sessionKey,
        transaction.reads.pending,
      ),
    );
    dropReason = schedulerObservationReadDropReason(engine, {
      sessionKey,
      scopeContext: { principal, sessionId: scopeSessionId },
      branch,
      reads: transaction.reads,
    });
  }
  const accepted = acceptedSchedulerObservation(schedulerObservation, {
    branch,
    space,
    principal,
    inputBasisSeq,
    executionClaim,
    ...(executionClaim !== undefined
      ? {
        causedBy: schedulerActionCauseCoverage(engine, {
          branch,
          ownerSpace: space ?? schedulerObservation.ownerSpace,
          pieceId: schedulerObservation.pieceId,
          processGeneration: schedulerObservation.processGeneration,
          actionId: schedulerObservation.actionId,
          executionContextKey: executionClaim.contextKey,
        }, inputBasisSeq).causedBy,
      }
      : {}),
  });
  if (accepted.provenance !== undefined) {
    if (accepted.unservedDiagnosticCode === undefined) {
      assertExecutionActionTransaction({
        servedSpace: space!,
        branch,
        scopeContext: { principal: principal!, sessionId: scopeSessionId },
        transaction,
        observation: schedulerObservation,
      });
    } else if (transaction.merge !== undefined) {
      rejectExecutionAction(
        "merge-commit",
        "an unserved attempt marker may not carry branch merge metadata",
      );
    }
  }
  assertExecutionLeaseFenceTransaction(engine, {
    fence: executionLeaseFence,
    space,
    branch,
    principal,
    claims: executionClaim === undefined ? [] : [executionClaim],
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
    ownerSpace: space ?? accepted.observation.ownerSpace,
    // An observation-only commit advances no semantic sequence, so reserve the
    // next GLOBAL server sequence as its delivery slot. `observedAtSeq` is the
    // selected branch's head and can lag the space-wide sync watermark after a
    // different branch commits; branchHead + 1 may therefore already be in the
    // past for every receiver. The next semantic commit, on any branch, gets
    // exactly serverSeq + 1 and its advancing sync window can carry this row.
    deliveryCommitSeq: serverSeq(engine) + 1,
    observedAtSeq,
    scopeContext: { principal: principal!, sessionId: scopeSessionId },
    writerSessionId: sessionKey,
    localSeq,
    replayPayload,
    ...(accepted.provenance !== undefined
      ? { causeCoverageSeq: inputBasisSeq }
      : {}),
    observation: accepted.observation,
  });
  if (
    accepted.provenance !== undefined &&
    accepted.unservedDiagnosticCode === undefined &&
    observationResult.executionContextKey !==
      accepted.provenance.claim.contextKey
  ) {
    throw new ExecutionLeaseFenceError(
      "execution claim context does not match the effective scheduler context",
    );
  }
  return {
    seq: observedAtSeq,
    branch,
    revisions: [],
    schedulerObservationId: observationResult.observationId,
    schedulerObservationResults: [{
      localSeq,
      status: "kept",
      schedulerObservationId: observationResult.observationId,
      executionContextKey: observationResult.executionContextKey,
      inputBasisSeq,
      ...(accepted.provenance !== undefined &&
          accepted.unservedDiagnosticCode === undefined
        ? { executionProvenance: accepted.provenance }
        : {}),
    }],
    ...(accepted.provenance !== undefined && executionClaim !== undefined
      ? {
        actionAttempts: [{
          localSeq,
          claim: executionClaim,
          provenance: accepted.provenance,
          ...(accepted.unservedDiagnosticCode !== undefined
            ? {
              outcome: "unserved" as const,
              diagnosticCode: accepted.unservedDiagnosticCode,
            }
            : {
              outcome: schedulerObservation.status === "failed"
                ? "failed" as const
                : "no-op" as const,
            }),
        }],
      }
      : {}),
  };
};

const applySchedulerObservationBatchCommit = (
  engine: Engine,
  {
    sessionId,
    scopeSessionId,
    sessionKey,
    space,
    principal,
    branch,
    batch,
    executionClaims,
    executionLeaseFence,
  }: {
    sessionId: SessionId;
    scopeSessionId: SessionId;
    sessionKey: string;
    space?: string;
    principal?: string;
    branch: BranchName;
    batch: NonNullable<ClientCommit["schedulerObservationBatch"]>;
    executionClaims?: ReadonlyMap<number, ExecutionClaim>;
    executionLeaseFence?: ExecutionLeaseFence;
  },
): AppliedCommit => {
  const results: AppliedSchedulerObservationResult[] = [];
  const actionAttempts: AppliedActionAttempt[] = [];
  let hasNewObservation = false;
  for (const item of batch) {
    const result = applySchedulerObservationOnlyCommit(engine, {
      sessionId,
      scopeSessionId,
      sessionKey,
      space,
      principal,
      branch,
      localSeq: item.localSeq,
      transaction: {
        reads: item.reads,
        operations: [],
      },
      schedulerObservation: item
        .schedulerObservation as SchedulerActionObservation,
      executionClaim: executionClaims?.get(item.localSeq),
      executionLeaseFence,
    });
    hasNewObservation ||= !isAppliedCommitReplay(result);
    results.push(result.schedulerObservationResults![0]);
    actionAttempts.push(...(result.actionAttempts ?? []));
  }

  const commit: AppliedCommit = {
    seq: headSeq(engine, branch),
    branch,
    revisions: [],
    schedulerObservationResults: results,
    ...(actionAttempts.length > 0 ? { actionAttempts } : {}),
  };
  return hasNewObservation ? commit : markAppliedCommitReplay(commit);
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
): ResolvedSchedulerObservationAddress[] => {
  const writes = new Map<string, ResolvedSchedulerObservationAddress>();
  for (const revision of revisions) {
    const paths = revision.op === "patch" && revision.patches
      ? revision.patches.flatMap(touchedLeafPathsForPatch)
      : [[]];
    for (const path of paths) {
      const write: ResolvedSchedulerObservationAddress = {
        ...normalizeSchedulerAddress({
          space,
          id: revision.id,
          scope: revision.scope,
          path,
        }),
        scopeKey: revision.scopeKey,
      };
      writes.set(
        `${write.space}\0${write.scopeKey}\0${write.id}\0${
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
