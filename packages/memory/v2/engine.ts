import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/api";
import { applySqliteCommitWrite } from "./sqlite/commit-eval.ts";
import {
  applyPatchToDocument,
  emptyEntityDocument,
  patchOpChangesParentKeySet,
  touchedPointerPaths,
} from "./patch.ts";
import { isPrefixPath, parentPath, pathsOverlap } from "./path.ts";
import {
  containsReservedSchemaRefSubstring,
  containsSyncSchemaRefString,
  findSyncSchemaRef,
} from "./sync-schema-ref.ts";
import {
  type BranchName,
  type CellScope,
  type ClientCommit,
  type CommitClass,
  commitPreconditionValueHash,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  getServerExecutionConfig,
  isEntityDocument,
  type Operation,
  type PatchOp,
  type Reference,
  type SessionId,
  type SqliteOperation,
  tableDeclaresRowLabel,
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
  -- Server-execution v2 commit class: 'authored' | 'derived' | 'system', a
  -- closed set (docs/specs/server-side-execution/protocol.md §1). Determined
  -- by the admission path that processed the commit, never client-supplied.
  -- Written in every flag arm; enforced only under
  -- EXPERIMENTAL_SERVER_EXECUTION. Kept last so migrated stores and fresh
  -- stores agree on column order.
  class              TEXT    NOT NULL DEFAULT 'authored',
  -- The producing lease holder, derived-class commits only (protocol.md §7's
  -- closed metadata list: 'holder' — derived only). NULL on every other
  -- class. Admission verified it against the live execution_lease row before
  -- the insert (serving-loop.md §2), so a stored value names the holder that
  -- actually held the lease at admission time.
  holder             TEXT,
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
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
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

-- Server-execution v2: the single-deriver lease
-- (docs/specs/server-side-execution/serving-loop.md §2). One row per space,
-- EXACTLY three fields — the v1 branch's richer shape (branch PK,
-- generation/host/on-behalf-of columns, a state enum) is prior art this
-- REDUCES from, not substrate. 'holder' is a per-process identity (service
-- identity + process-instance component, minted at process start — DR1), so
-- the admission equality check itself fences cross-process succession.
-- Acquire/renew are DIRECT table writes on the direct-engine plane
-- (serving-loop.md §1 plane (c)) — a lease renewal is never a commit.
-- Liveness is judged by the memory server's own clock against expires_at;
-- an expired row matches nobody. References nothing; nothing references it.
CREATE TABLE IF NOT EXISTS execution_lease (
  space       TEXT    NOT NULL PRIMARY KEY,
  holder      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Server-execution v2: the scheduler basis index
-- (docs/specs/server-side-execution/serving-loop.md §3b) — "output current
-- iff these inputs unchanged since these seqs". Ids + seqs ONLY, overwritten
-- in place per (action, action_scope_key); never payloads, never per-run
-- history (payloads or per-run history are the evidence log, FORBIDDEN).
-- Rows are written INSIDE a wave's derived store transaction — never own
-- commits, never pushed to subscribers, never read at admission. Recovery
-- and warm start are the same move: activation re-marks the dirty frontier
-- by comparing recorded input seqs against current heads. The table starts
-- EMPTY: nothing is backfilled from the dropped observation tables (D10),
-- and nothing writes it until the serving loop lands (plan Phase 1 stages
-- E-F).
-- One standalone table. No FOREIGN KEY clauses anywhere: v1's satellites
-- all hung off scheduler_observation; the v2 index references nothing and
-- nothing references it.
CREATE TABLE IF NOT EXISTS scheduler_basis (
  branch           TEXT    NOT NULL, -- engine-v3 branch, as on every table
  action           TEXT    NOT NULL, -- durable action identity/fingerprint;
                                     --   restart-stable (a per-process
                                     --   component would empty the index
                                     --   exactly when recovery reads it)
  action_scope_key TEXT    NOT NULL, -- the INSTANCE that ran (scopes.md §7
                                     --   M2 re-keying; scope_key vocabulary
                                     --   is today's resolveScopeKey, moving
                                     --   to the wire-shape module per LD3,
                                     --   key-vocabulary.md §3)
  entity_space     TEXT    NOT NULL, -- the input doc's space: foreign reads
                                     --   are logged reads too
                                     --   (serving-loop.md §3b cross-space)
  entity           TEXT    NOT NULL, -- the input doc id
  entity_scope_key TEXT    NOT NULL, -- the input INSTANCE read
  seq              INTEGER NOT NULL, -- the input's seq at read time, in the
                                     --   entity's own space's sequence;
                                     --   in-wave reads share the wave's
                                     --   commit seq
  PRIMARY KEY (branch, action, action_scope_key,
               entity_space, entity, entity_scope_key)
);
-- Entity-keyed lookup mirror (implementation detail per serving-loop.md
-- §3b): activation's re-mark scan resolves "who read this doc" without a
-- full-table walk, the successor of idx_scheduler_read_index_lookup.
CREATE INDEX IF NOT EXISTS idx_scheduler_basis_entity
  ON scheduler_basis (branch, entity_space, entity, entity_scope_key);

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
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
  resolution,
  class,
  holder
)
VALUES (
  :seq,
  :branch,
  :session_id,
  :local_seq,
  :invocation_ref,
  :authorization_ref,
  :original,
  :resolution,
  :class,
  :holder
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
INSERT INTO head (branch, id, scope_key, seq, op_index, op)
VALUES (:branch, :id, :scope_key, :seq, :op_index, :op)
ON CONFLICT (branch, id, scope_key) DO UPDATE
SET seq = :seq, op_index = :op_index, op = :op
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

const SELECT_CURRENT_ENTITY_IDS = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
ORDER BY id ASC
`;

const SELECT_CURRENT_ENTITY_ID_PAGE = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
ORDER BY id ASC
LIMIT :limit
`;

const SELECT_CURRENT_ENTITY_ID_PAGE_AFTER = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
  AND id > :after
ORDER BY id ASC
LIMIT :limit
`;

const SELECT_CURRENT_ENTITY_ID = `
SELECT 1 AS present
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND id = :id
  AND op <> 'delete'
LIMIT 1
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
SELECT seq, branch, original, resolution, class, holder
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

// The derived-class admission read (serving-loop.md §2): the space's LIVE
// lease row, liveness judged by the memory server's own clock (the :now the
// admission path passes is always this process's Date.now()). An expired row
// is not returned, so it matches nobody.
const SELECT_LIVE_EXECUTION_LEASE = `
SELECT holder
FROM execution_lease
WHERE space = :space
  AND expires_at > :now
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

// True-basis (CT-1910) variants of the conflict scans: identical intervals,
// but writes produced by the reader's own session's TRUE PREDECESSORS
// (`local_seq` below the reader's) are excluded — the accepted own layers
// the reader's materialized view included; conflicting with them would be
// the self-conflict that forced pending reads to over-advance their basis
// in the first place. The exclusion is deliberately NOT session-wide: an
// own write with a HIGHER localSeq that was accepted first (out-of-order
// submission — e.g. the runner's hold-mode admission can release a later
// blind commit while an earlier read-bearing commit waits) was NOT in the
// reader's view and must conflict exactly like a foreign write. Checking
// `local_seq` here, rather than assuming the §3.6.3 same-session ordering
// holds on the wire, keeps the scan sound without trusting the transport.
const SELECT_SET_DELETE_CONFLICT_EXCLUDING_SESSION = `
SELECT r.seq AS seq
FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch
  AND r.id = :id
  AND r.scope_key = :scope_key
  AND r.seq > :after_seq
  AND r.op IN ('set', 'delete')
  AND (c.session_id <> :exclude_session OR c.local_seq >= :before_local_seq)
ORDER BY r.seq DESC, r.op_index DESC
LIMIT 1
`;

const SELECT_PATCH_CONFLICTS_EXCLUDING_SESSION = `
SELECT r.seq AS seq, r.op_index AS op_index, r.data AS data
FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch
  AND r.id = :id
  AND r.scope_key = :scope_key
  AND r.seq > :after_seq
  AND r.op = 'patch'
  AND (c.session_id <> :exclude_session OR c.local_seq >= :before_local_seq)
ORDER BY r.seq DESC, r.op_index DESC
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
  selectCurrentEntityId: PreparedStatement;
  selectCurrentEntityIds: PreparedStatement;
  selectCurrentEntityIdPage: PreparedStatement;
  selectCurrentEntityIdPageAfter: PreparedStatement;
  selectExistingCommit: PreparedStatement;
  selectHead: PreparedStatement;
  selectLatestBase: PreparedStatement;
  selectLatestSnapshot: PreparedStatement;
  selectLiveExecutionLease: PreparedStatement;
  selectNextSeq: PreparedStatement;
  selectPatchConflicts: PreparedStatement;
  selectPatchConflictsExcludingSession: PreparedStatement;
  selectPatchCount: PreparedStatement;
  selectPatches: PreparedStatement;
  selectPendingResolution: PreparedStatement;
  selectServerSeq: PreparedStatement;
  selectSetDeleteConflict: PreparedStatement;
  selectSetDeleteConflictExcludingSession: PreparedStatement;
  upsertHead: PreparedStatement;
  updateBranchHead: PreparedStatement;
  deleteBranch: PreparedStatement;
  deleteOldSnapshots: PreparedStatement;
}

export type Engine = {
  url: URL;
  database: Database;
  snapshotInterval: number;
  snapshotRetention: number;
  legacyCommitMetadataRefsRequired: boolean;
  statements: PreparedStatements;
};

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

export type OpenOptions = {
  url: URL;
  snapshotInterval?: number;
  snapshotRetention?: number;
};

export type InvocationRecord = {
  iss: string;
  aud?: string | null;
  cmd: string;
  sub: string;
  args?: FabricValue;
  [key: string]: FabricValue;
};

export type AuthorizationRecord = FabricValue;

export type ApplyCommitOptions = {
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
  /** The commit's class (docs/specs/server-side-execution/protocol.md §1),
   *  determined by the ADMISSION PATH that processed the commit — the
   *  session-facing transact path is `authored` (the default here, since
   *  `applyCommit` is that path's admission core), the memory server's own
   *  direct writes pass `system`, and only a lease-holding SpaceServer will
   *  pass `derived` (Phase 1 stage B). Never populated from any
   *  client-supplied value: `ClientCommit` cannot express a class, so a field
   *  smuggled into the payload is inert. */
  commitClass?: CommitClass;
  /** The producing lease holder of a `derived`-class commit — the DR1
   *  per-process identity the SpaceServer minted at process start
   *  (serving-loop.md §2). Admission compares it against the space's live
   *  `execution_lease` row: one equality check, judged by this process's own
   *  clock. Server-internal like `commitClass`: `ClientCommit` cannot express
   *  a holder, and no session-facing path supplies one. Meaningless (and
   *  ignored) on other classes. */
  holder?: string;
};

export type AppliedRevision = {
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
};

export type CommitReadDropReason =
  | "stale-confirmed-read"
  | "stale-pending-read"
  | "pending-read-missing";

export type AppliedCommit = {
  seq: number;
  branch: BranchName;
  revisions: AppliedRevision[];
};

export type ReadOptions = {
  id: EntityId;
  scope?: CellScope;
  principal?: string;
  sessionId?: SessionId;
  branch?: BranchName;
  seq?: number;
};

export type EntityState = {
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  branch: BranchName;
  seq: number;
  opIndex: number;
  op: Operation["op"];
  document: EntityDocument | null;
};

export type PutBlobOptions = {
  value: Uint8Array;
  contentType: string;
};

export type BranchState = {
  name: BranchName;
  parentBranch: BranchName | null;
  forkSeq: number | null;
  createdSeq: number;
  headSeq: number;
  status: string;
};

type HeadRow = {
  seq: number;
  op_index: number;
};

type CommitRow = {
  seq: number;
  branch: string;
  original: string;
  resolution: string;
  class: string;
  holder: string | null;
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
  selectCurrentEntityId: database.prepare(SELECT_CURRENT_ENTITY_ID),
  selectCurrentEntityIds: database.prepare(SELECT_CURRENT_ENTITY_IDS),
  selectCurrentEntityIdPage: database.prepare(SELECT_CURRENT_ENTITY_ID_PAGE),
  selectCurrentEntityIdPageAfter: database.prepare(
    SELECT_CURRENT_ENTITY_ID_PAGE_AFTER,
  ),
  selectExistingCommit: database.prepare(SELECT_EXISTING_COMMIT),
  selectHead: database.prepare(SELECT_HEAD),
  selectLatestBase: database.prepare(SELECT_LATEST_BASE),
  selectLatestSnapshot: database.prepare(SELECT_LATEST_SNAPSHOT),
  selectLiveExecutionLease: database.prepare(SELECT_LIVE_EXECUTION_LEASE),
  selectNextSeq: database.prepare(SELECT_NEXT_SEQ),
  selectPatchConflicts: database.prepare(SELECT_PATCH_CONFLICTS),
  selectPatchConflictsExcludingSession: database.prepare(
    SELECT_PATCH_CONFLICTS_EXCLUDING_SESSION,
  ),
  selectPatchCount: database.prepare(SELECT_PATCH_COUNT),
  selectPatches: database.prepare(SELECT_PATCHES),
  selectPendingResolution: database.prepare(SELECT_PENDING_RESOLUTION),
  selectServerSeq: database.prepare(SELECT_SERVER_SEQ),
  selectSetDeleteConflict: database.prepare(SELECT_SET_DELETE_CONFLICT),
  selectSetDeleteConflictExcludingSession: database.prepare(
    SELECT_SET_DELETE_CONFLICT_EXCLUDING_SESSION,
  ),
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

const columnDefault = (
  database: Database,
  table: string,
  column: string,
): string | null | undefined => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string; dflt_value: string | null }
  >;
  return rows.find((row) => row.name === column)?.dflt_value;
};

type ForeignKeyShape = {
  table: string;
  from: string[];
  to: string[];
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
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
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

INSERT INTO head (branch, id, scope_key, seq, op_index, op)
SELECT h.branch, h.id, 'space', h.seq, h.op_index, r.op
FROM head_unscoped_migration h
JOIN revision r
  ON r.branch = h.branch
  AND r.id = h.id
  AND r.scope_key = 'space'
  AND r.seq = h.seq
  AND r.op_index = h.op_index;

INSERT INTO snapshot (branch, id, scope_key, seq, value)
SELECT branch, id, 'space', seq, value
FROM snapshot_unscoped_migration;

DROP TABLE revision_unscoped_migration;
DROP TABLE head_unscoped_migration;
DROP TABLE snapshot_unscoped_migration;

COMMIT;
`);
};

const migrateHeadCurrentOp = (database: Database): void => {
  if (
    !hasColumn(database, "head", "op") ||
    columnDefault(database, "head", "op") !== null
  ) {
    database.exec(`
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_head_branch;
DROP INDEX IF EXISTS idx_head_live_entity_ids;

ALTER TABLE head RENAME TO head_current_op_migration;

CREATE TABLE head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX idx_head_branch ON head (branch);

INSERT INTO head (branch, id, scope_key, seq, op_index, op)
SELECT
  h.branch,
  h.id,
  h.scope_key,
  h.seq,
  h.op_index,
  (
  SELECT r.op
  FROM revision r
  WHERE r.branch = h.branch
    AND r.id = h.id
    AND r.scope_key = h.scope_key
    AND r.seq = h.seq
    AND r.op_index = h.op_index
  )
FROM head_current_op_migration h;

DROP TABLE head_current_op_migration;

COMMIT;
`);
  }

  database.exec(`
CREATE INDEX IF NOT EXISTS idx_head_live_entity_ids
  ON head (branch, scope_key, id, op)
  WHERE op <> 'delete';
`);
};

// Server-execution v2 stage A: every commit row carries its `class`
// (docs/specs/server-side-execution/protocol.md §1). Pre-class rows backfill
// as 'authored' via the column default — on main every historical commit came
// through client-session admission, and the distinction the class exists for
// (`derived` vs the rest) has no historical instances to preserve.
const migrateCommitClass = (database: Database): void => {
  if (hasColumn(database, "commit", "class")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN class TEXT NOT NULL DEFAULT 'authored';
`);
};

// Server-execution v2 stage B: derived-class commits carry their producing
// lease holder (protocol.md §7 — `holder`, derived only). Historical rows
// stay NULL: no derived commit could exist before the lease admission check
// this column lands with, so there is nothing to backfill. Runs after
// migrateCommitClass so migrated stores and fresh stores agree on column
// order (class, then holder).
const migrateCommitHolder = (database: Database): void => {
  if (hasColumn(database, "commit", "holder")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN holder TEXT;
`);
};

// Server-execution v2 Phase 1 stage C.2: the observation-payload tables are
// REPLACED by the scheduler_basis index (serving-loop.md §3b). The drop list
// is §3b's SEVEN tables, deliberately not a constant enumerating six (D6 —
// scheduler_context_floor was created and dropped through separate statements
// and is easy to leave behind). Satellites drop before the scheduler_
// observation spine they FK into; scheduler_basis itself is created by INIT.
// NO BACKFILL (D10): rows keyed by process_generation history cannot be
// reinterpreted as overwrite-in-place basis state, so a store that had opted
// into persistentSchedulerState loses warm start once — the first activation
// re-marks everything dirty and recomputes, exactly what an absent index
// means.
const migrateSchedulerObservationTablesToBasis = (database: Database): void => {
  database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS scheduler_observation_replay;
      DROP TABLE IF EXISTS scheduler_read_index;
      DROP TABLE IF EXISTS scheduler_write_index;
      DROP TABLE IF EXISTS scheduler_action_state;
      DROP TABLE IF EXISTS scheduler_action_snapshot;
      DROP TABLE IF EXISTS scheduler_observation;
      DROP TABLE IF EXISTS scheduler_context_floor;
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
  database.exec(INIT);
  migrateScopedEntityTables(database);
  migrateHeadCurrentOp(database);
  migrateCommitClass(database);
  migrateCommitHolder(database);
  migrateSchedulerObservationTablesToBasis(database);
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

export const listEntityIds = (
  engine: Engine,
): EntityId[] => {
  return (engine.statements.selectCurrentEntityIds.all({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
  }) as { id: EntityId }[]).map(({ id }) => id);
};

export type EntityIdPageOptions = {
  after?: EntityId;
  limit: number;
};

export const listEntityIdPage = (
  engine: Engine,
  { after, limit }: EntityIdPageOptions,
): EntityId[] => {
  const statement = after === undefined
    ? engine.statements.selectCurrentEntityIdPage
    : engine.statements.selectCurrentEntityIdPageAfter;
  return (statement.all({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
    limit,
    ...(after === undefined ? {} : { after }),
  }) as { id: EntityId }[]).map(({ id }) => id);
};

export const entityIdExists = (
  engine: Engine,
  id: EntityId,
): boolean => {
  return engine.statements.selectCurrentEntityId.get({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
    id,
  }) !== undefined;
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

const applyCommitTransaction = (
  engine: Engine,
  {
    sessionId,
    space,
    principal,
    commit,
    sqliteAttachments,
    commitClass = "authored",
    holder,
  }: ApplyCommitOptions,
): AppliedCommit => {
  // The derived-class posture gate (protocol.md §1): off the flag NOTHING
  // may claim the class — retries included — because `derived` names the
  // single-deriver posture and nothing outside EXPERIMENTAL_SERVER_EXECUTION
  // may claim it. Only this gate precedes replay detection; the LIVE-lease
  // equality check sits after it below, on the fresh-commit path.
  if (commitClass === "derived" && !getServerExecutionConfig()) {
    throw new ProtocolError(
      "derived-class commits are unclaimable while " +
        "EXPERIMENTAL_SERVER_EXECUTION is off (protocol.md §1)",
    );
  }
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  // Replay detection FIRST — ahead of every current-authority admission
  // check, the live-lease equality check included (owner review on #5349,
  // 2026-08-12): a commit this session already applied returns its stored
  // result without re-validating preconditions — re-checking entity-absent
  // against the state the original application created would wrongly reject
  // the replay — and without consulting the live `execution_lease`: the
  // lease authorizes NEW derived commits, and a network retry of an
  // already-ACCEPTED one must keep its stored answer after the producing
  // lease was released, expired, or succeeded by a new holder. The stored
  // identity spans the payload bytes (sameStoredOriginal) AND the admission
  // envelope (class; for derived, the producing holder): a same-key
  // resubmission differing in either is a DIFFERENT submission and is
  // refused, never answered.
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
    // Envelope identity, normalized exactly as the insert below persists
    // it: a holder sticks to derived commits only, so a stray holder that
    // was inert on the original stays inert on the retry.
    const incomingHolder = commitClass === "derived" ? holder ?? null : null;
    if (existing.class !== commitClass || existing.holder !== incomingHolder) {
      throw new ProtocolError(
        `commit replay mismatch for session ${sessionId} localSeq ` +
          `${commit.localSeq}: stored class/holder differ from the resubmission`,
      );
    }
    return {
      seq: existing.seq,
      branch: existing.branch,
      revisions: selectCommitRevisions(engine, existing.seq),
    };
  }

  // The derived-class admission rule (serving-loop.md §2, protocol.md §2's
  // `derived` row): the producer holds the space's live `execution_lease` —
  // ONE equality check against the row's holder, not admission machinery.
  // Fresh commits only: an exact replay already answered from the store
  // above. Liveness is judged by THIS process's clock — the memory
  // server's own, never the holder's: the select excludes expired rows, so
  // an expired lease matches nobody and a fresh derived commit under one
  // is rejected even before any successor acquires.
  if (commitClass === "derived") {
    const lease = space === undefined
      ? undefined
      : engine.statements.selectLiveExecutionLease.get({
        space,
        now: Date.now(),
      }) as { holder: string } | undefined;
    if (
      holder === undefined || lease === undefined || lease.holder !== holder
    ) {
      throw new ProtocolError(
        "derived-class commit rejected: producer does not hold the live " +
          "execution_lease for the space (serving-loop.md §2)",
      );
    }
  }
  const hasPreconditions = (commit.preconditions?.length ?? 0) > 0;
  if (commit.operations.length === 0 && !hasPreconditions) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  validateCommitPreconditions(engine, sessionKey, branch, commit, {
    principal,
    sessionId,
  });

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
    class: commitClass,
    holder: commitClass === "derived" ? holder ?? null : null,
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

  validateStoredSyncSchemaRefs(engine, branch, revisions, original);

  engine.statements.updateBranchHead.run({ branch, seq });
  materializeSnapshots(engine, branch, revisions);

  return {
    seq,
    branch,
    revisions,
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
        op: "set",
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
        op: "patch",
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
        op: "delete",
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

/**
 * Validated `basisSeq` of a pending read — the CT-1910 true-basis shape — or
 * `undefined` for the legacy shape. In the SERVER's space-log seq space (an
 * accepted-commit `seq`, NOT the session's localSeq space); see
 * {@link PendingRead.basisSeq}. A basis ahead of the log claims knowledge
 * the server never produced. (A basis AT head is legal and yields an empty
 * scan — the same client-trusted claim a confirmed read at head makes.)
 */
const pendingReadBasisSeq = (
  engine: Engine,
  read: { id: string; basisSeq?: number },
): number | undefined => {
  const { basisSeq } = read;
  if (basisSeq === undefined) {
    return undefined;
  }
  if (!Number.isInteger(basisSeq) || basisSeq < 0) {
    throw new ProtocolError(
      `pending read on ${read.id} names a malformed basisSeq: ${basisSeq}`,
    );
  }
  if (basisSeq > serverSeq(engine)) {
    throw new ProtocolError(
      `pending read on ${read.id} claims a basisSeq ahead of the log: ${basisSeq}`,
    );
  }
  return basisSeq;
};

// Shared normalization/validation for a pending read's dependency set: a
// non-empty array (or scalar) of integer localSeqs. Malformed shapes are a
// protocol violation regardless of which validator (ordinary commit or
// scheduler observation) encounters them.
const pendingReadLayers = (
  read: { id: string; localSeq: number | number[] },
): number[] => {
  const layers = Array.isArray(read.localSeq) ? read.localSeq : [read.localSeq];
  if (layers.length === 0) {
    throw new ProtocolError(
      `pending read on ${read.id} names no localSeq`,
    );
  }
  for (const layer of layers) {
    if (!Number.isInteger(layer)) {
      throw new ProtocolError(
        `pending read on ${read.id} names a non-integer localSeq`,
      );
    }
  }
  return layers;
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
    // An array localSeq names EVERY pending layer the read's view sat on:
    // each element must have resolved to an accepted commit, and staleness
    // is checked exactly once, from the basis §3.6.3 selects — the declared
    // `basisSeq` when present, else the resolution of the HIGHEST element —
    // the document's top-of-stack layer below the reader, which the array
    // MUST include (03-commit-model.md §3.5). A scalar is the single-layer
    // form.
    const layers = pendingReadLayers(read);
    let basis: { localSeq: number; seq: number } | undefined;
    for (const localSeq of layers) {
      let resolution = resolutions.get(localSeq);
      if (!resolution) {
        const row = engine.statements.selectPendingResolution.get({
          session_id: sessionKey,
          local_seq: localSeq,
        }) as { seq: number } | undefined;
        if (!row) {
          throw new ConflictError(
            `pending dependency not resolved: ${localSeq}`,
          );
        }
        resolution = { localSeq, seq: row.seq };
        resolutions.set(localSeq, resolution);
      }
      if (basis === undefined || localSeq > basis.localSeq) {
        basis = resolution;
      }
    }

    // CT-1910 repair: a reader that names its true confirmed basis is
    // scanned over the FULL interval (basisSeq, head], excluding only its
    // own session's predecessor commits (local_seq below the reader's) —
    // the accepted layers its materialized view included. A legacy reader
    // (no basisSeq) keeps the max-dependency basis, so the over-advance
    // deviation persists for it alone
    // (docs/specs/memory-v2/09-invariants.md, INV-1).
    const trueBasis = pendingReadBasisSeq(engine, read);
    const conflictSeq = trueBasis !== undefined
      ? findConflictSeq(
        engine,
        branch,
        read.id,
        resolveScopeKey(read.scope, { principal, sessionId }),
        trueBasis,
        read.path,
        read.nonRecursive ?? false,
        { sessionKey, beforeLocalSeq: commit.localSeq },
      )
      : findConflictSeq(
        engine,
        branch,
        read.id,
        resolveScopeKey(read.scope, { principal, sessionId }),
        basis!.seq,
        read.path,
        read.nonRecursive ?? false,
      );
    if (conflictSeq !== null) {
      throw new ConflictError(
        `stale pending read: ${read.id} via localSeq ${
          basis!.localSeq
        } conflicted with seq ${conflictSeq}`,
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
  // True-basis reads (CT-1910): skip writes produced by this commit session
  // key's TRUE PREDECESSOR commits (`local_seq < beforeLocalSeq`) — the
  // reader's own accepted layers, which its view included. Own writes with
  // a higher localSeq (accepted out of submission order) conflict like
  // foreign writes; see the comment on the *_EXCLUDING_SESSION statements.
  exclude?: { sessionKey: string; beforeLocalSeq: number },
): number | null => {
  const setDeleteStatement = exclude === undefined
    ? engine.statements.selectSetDeleteConflict
    : engine.statements.selectSetDeleteConflictExcludingSession;
  const patchStatement = exclude === undefined
    ? engine.statements.selectPatchConflicts
    : engine.statements.selectPatchConflictsExcludingSession;
  const exclusionParams = exclude === undefined ? {} : {
    exclude_session: exclude.sessionKey,
    before_local_seq: exclude.beforeLocalSeq,
  };
  const setOrDeleteConflict = setDeleteStatement.get({
    branch,
    id,
    scope_key: scopeKey,
    after_seq: afterSeq,
    ...exclusionParams,
  }) as { seq: number } | undefined;
  if (setOrDeleteConflict !== undefined) {
    return setOrDeleteConflict.seq;
  }

  for (
    const conflict of patchStatement.iter({
      branch,
      id,
      scope_key: scopeKey,
      after_seq: afterSeq,
      ...exclusionParams,
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

const rejectStoredSyncSchemaRef = (
  document: EntityDocument | undefined,
): void => {
  const ref = findSyncSchemaRef(document);
  if (ref !== undefined) {
    throw new ProtocolError(
      `memory v2 documents may not persist reserved wire schema reference: ${ref}`,
    );
  }
};

const validateStoredSyncSchemaRefs = (
  engine: Engine,
  branch: BranchName,
  revisions: readonly AppliedRevision[],
  serializedCommit: string,
): void => {
  // Every string a set document or patch operation carries appears verbatim
  // in the commit's serialization (already computed for the commit log), so
  // a commit whose serialization lacks both reserved prefixes can only put a
  // reference into a schema position via a JSON Patch move relocating a
  // string that already exists in the stored pre-state.
  const commitMayIntroduceRef = containsReservedSchemaRefSubstring(
    serializedCommit,
  );

  // Entities whose patches need post-state validation, keyed by revision key,
  // preserving this commit's revision order per entity.
  const statefulEntities = new Map<string, AppliedRevision[]>();

  for (const revision of revisions) {
    if (revision.op === "set" && commitMayIntroduceRef) {
      rejectStoredSyncSchemaRef(revision.document);
    }
    // Every revision here is set/patch/delete: sqlite operations never enter
    // the revisions list (see applyCommitTransaction).
    const key = revisionKey(
      branch,
      revision.id,
      revision.scopeKey ?? DEFAULT_SCOPE_KEY,
    );
    const isCandidatePatch = revision.op === "patch" &&
      (revision.patches?.some((patch) => patch.op === "move") === true ||
        (commitMayIntroduceRef &&
          containsSyncSchemaRefString(revision.patches)));
    const group = statefulEntities.get(key);
    if (group !== undefined) {
      // Once an entity is stateful, every later revision participates in the
      // replay so each intermediate stored state is validated.
      group.push(revision);
      continue;
    }
    if (isCandidatePatch) {
      // Earlier same-commit revisions of this entity are irrelevant history:
      // a set baseline is re-established by the replay's reconstruction.
      statefulEntities.set(key, [revision]);
    }
  }

  for (const group of statefulEntities.values()) {
    validateStatefulEntityRevisions(
      engine,
      branch,
      group,
      commitMayIntroduceRef,
    );
  }
};

/** Replays one entity's in-commit revisions, validating each stored state.
 *  Reconstructs the pre-state at most once per entity (and not at all when
 *  neither the commit nor any stored source row can contain a reserved
 *  reference), keeping validation linear in this commit's patch count. */
const validateStatefulEntityRevisions = (
  engine: Engine,
  branch: BranchName,
  entityRevisions: readonly AppliedRevision[],
  commitMayIntroduceRef: boolean,
): void => {
  const first = entityRevisions[0];
  const scopeKey = first.scopeKey ?? DEFAULT_SCOPE_KEY;
  if (
    !commitMayIntroduceRef &&
    !storedEntitySourcesMayContainRef(engine, {
      id: first.id,
      scopeKey,
      branch,
      seq: first.seq,
      opIndex: first.opIndex,
    })
  ) {
    // A move can only relocate an existing string, and every string in the
    // stored pre-state appears verbatim in some stored source row.
    return;
  }

  let document: EntityDocument | undefined;
  for (const revision of entityRevisions) {
    if (revision.op === "set") {
      document = revision.document;
      // Already validated by the set path when the commit can introduce a
      // reference; a clean commit's set document cannot contain one.
      continue;
    }
    if (revision.op !== "patch") {
      // A delete tombstones the entity: later in-commit patches start empty.
      document = emptyEntityDocument();
      continue;
    }
    document = document === undefined
      ? reconstructPatchedDocument(engine, {
        id: revision.id,
        scopeKey,
        branch,
        seq: revision.seq,
        opIndex: revision.opIndex,
      })
      : applyPatchToDocument(document, revision.patches ?? []);
    rejectStoredSyncSchemaRef(document);
  }
};

/** Substring probe over the serialized rows reconstruction would read — the
 *  latest set/snapshot base and the patch span — without decoding any of
 *  them. A negative answer proves the reconstructed pre-state cannot contain
 *  a reserved reference. */
const storedEntitySourcesMayContainRef = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq: number;
    opIndex: number;
  },
): boolean => {
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
  let baseMayContain = false;
  if (snapshotRow && (!baseRow || snapshotRow.seq >= baseRow.seq)) {
    baseSeq = snapshotRow.seq;
    baseOpIndex = Number.MAX_SAFE_INTEGER;
    baseMayContain = containsReservedSchemaRefSubstring(snapshotRow.value);
  } else if (baseRow) {
    baseSeq = baseRow.seq;
    baseOpIndex = baseRow.op_index;
    baseMayContain = baseRow.op === "set" && baseRow.data !== null &&
      containsReservedSchemaRefSubstring(baseRow.data);
  }
  if (baseMayContain) return true;

  const patches = engine.statements.selectPatches.all({
    branch,
    id,
    scope_key: scopeKey,
    base_seq: baseSeq,
    base_op_index: baseOpIndex,
    seq,
    op_index: opIndex,
  }) as Array<{ data: string }>;
  return patches.some((patch) =>
    containsReservedSchemaRefSubstring(patch.data)
  );
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
    document = applyPatchToDocument(
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
