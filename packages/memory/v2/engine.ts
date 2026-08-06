import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/api";
import { applySqliteCommitWrite } from "./sqlite/commit-eval.ts";
import {
  applyPatch,
  patchOpChangesParentKeySet,
  touchedPointerPaths,
} from "./patch.ts";
import {
  isPrefixPath,
  parentPath,
  parsePointer,
  pathsOverlap,
} from "./path.ts";
import { replaceSchedulerBasisRows } from "./scheduler-basis.ts";
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
  type DerivedWriteAnnotation,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  getServerExecutionConfig,
  isEntityDocument,
  type Operation,
  type PatchOp,
  ProtocolError,
  type Reference,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  type ScopeKey,
  scopeOfScopeKey,
  type SessionId,
  type SqliteOperation,
  tableDeclaresRowLabel,
} from "../v2.ts";

// The scope_key vocabulary is PROTOCOL vocabulary and lives in the
// wire-shape module (../v2.ts, beside CellScope) as the ONE definition —
// ledger LD3 (key-vocabulary.md §3). The engine imports it and re-exports
// the names its consumers historically reached through `Engine.*`; it
// defines no scope-key format of its own. Identity DERIVATION stays
// engine-owned: admission threads the authenticated session's
// principal/sessionId into the constructor for `authored` traffic.
export {
  principalOfSessionKey,
  ProtocolError,
  resolveScopeKey,
} from "../v2.ts";

const DEFAULT_SCOPE: CellScope = "space";
// The space scope's one shared instance, per the shared vocabulary (the
// `scope ?? "space"` construction below and every stored default agree).
const DEFAULT_SCOPE_KEY: ScopeKey = "space";
const normalizeScope = (scope: CellScope | undefined): CellScope =>
  scope ?? DEFAULT_SCOPE;

export const resolveCommitSessionKey = (
  sessionId: SessionId,
  principal?: string,
): string =>
  principal ? resolvePrincipalSessionKey(principal, sessionId) : sessionId;

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
  -- Per-write identity annotations WITHIN a derived commit's body
  -- (protocol.md §1: the addressing/attribution pair, per action run) and
  -- the eventIds the commit consequences (protocol.md §7: consequenceOf,
  -- derived only — bounded by the wave's input, never graph-scaled). JSON
  -- arrays; NULL on every non-derived class. Attribution is recorded, not
  -- read (protocol.md §1); the scopeKey half was CONSUMED at admission to
  -- key scoped rows.
  annotations        JSON,
  consequence_of     JSON,
  -- The watermark this derived commit is current through (protocol.md §4,
  -- §7's closed metadata list: 'derivedThrough' — derived only). NULL on
  -- every other class, and NULL on derived commits produced outside a
  -- serving loop (stage-D-era test waves predate the watermark). The
  -- watermark DOC (one well-known doc per space) rides the commit's own
  -- operations; this column is the metadata half.
  derived_through    INTEGER,
  -- Server-produced AUTHORED commits only (protocol.md §2's delegated
  -- row, §2b): the ORIGINATING chain actor + the capability grant this
  -- commit was admitted under — delegation, never session-identity
  -- impersonation. NULL on every other admission path.
  acting_principal   TEXT,
  acting_session     TEXT,
  capability_ref     TEXT,
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
-- EMPTY: nothing is backfilled from the dropped observation tables (D10).
-- The writer is scheduler-basis.ts (stage D), invoked inside a wave's
-- derived store transaction; nothing invokes it in production until the
-- serving loop lands (plan Phase 1 stages E-F).
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
  holder,
  annotations,
  consequence_of,
  derived_through,
  acting_principal,
  acting_session,
  capability_ref
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
  :holder,
  :annotations,
  :consequence_of,
  :derived_through,
  :acting_principal,
  :acting_session,
  :capability_ref
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
SELECT seq, branch, original, resolution
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

// ProtocolError moved to the wire-shape module (../v2.ts) with the shared
// scope-key vocabulary that throws it; re-exported near the imports above.

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
  /** Per-write identity annotations of a `derived`-class commit
   *  (protocol.md §1): the explicit `scope_key` on scoped writes
   *  (ADDRESSING — consumed here to key rows, since the service envelope
   *  has no session to derive keys from) and the acting identity per
   *  action run (ATTRIBUTION — stored, never read by admission).
   *  Server-internal like `commitClass`; rejected on any other class
   *  (protocol.md §7's closed list). */
  annotations?: readonly DerivedWriteAnnotation[];
  /** The eventIds whose handler consequences this `derived`-class commit
   *  carries (protocol.md §7 — `consequenceOf`, derived only; bounded by
   *  the wave's input, never graph-scaled). Stored on the commit row;
   *  rejected on any other class. */
  consequenceOf?: readonly string[];
  /** The watermark this `derived`-class commit is current through
   *  (protocol.md §4, §7 — `derivedThrough`, derived only; every split of
   *  one wave repeats the same value). Stored on the commit row; rejected
   *  on any other class. Optional even on derived commits: a wave produced
   *  outside a serving loop (tests driving the accumulator directly) has
   *  no watermark to carry, and the column stays NULL. */
  derivedThrough?: number;
  /** Server-produced AUTHORED admission (protocol.md §2's delegated row,
   *  §2b — outbox event appends, `.inSpace` provisioning): the commit's
   *  metadata carries the ORIGINATING chain actor + the capability grant,
   *  and admission validates the grant against the target — a
   *  delegated-capability check, NEVER session-identity impersonation.
   *  Scoped writes key from the validated CARRIED identity (scopes.md §5:
   *  consequences land in the actor's instances). Only meaningful with
   *  the (default) authored class; refused elsewhere. Like the other
   *  server-internal carriage, `ClientCommit` cannot express it. */
  delegated?: {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;
  };
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
  /** The explicit scope INSTANCE to read (protocol.md §2's read row —
   *  the read half of the transaction identity model). When present it
   *  bypasses the session-identity resolution: the caller (a lease
   *  holder — admission enforced at the server layer, not here) names
   *  the instance directly. When absent, the scope resolves from
   *  (principal, sessionId) as today. */
  scopeKey?: string;
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

// Server-execution v2 stage D: derived-class commits carry their per-write
// identity annotations and consequenceOf inside the commit row (protocol.md
// §1, §7). Historical rows stay NULL — both fields are derived-only and no
// derived commit predates them. Runs after migrateCommitHolder so migrated
// stores and fresh stores agree on column order (class, holder, annotations,
// consequence_of).
const migrateCommitWaveCarriage = (database: Database): void => {
  // One guard per column, matching the prior migrations' shape: ALTERs
  // are not transactional as a pair, and migrations run on every store
  // open — a single first-column guard would turn a crash between the
  // two ALTERs into a store with `annotations` present and
  // `consequence_of` missing FOREVER (the guard forever satisfied, the
  // second ALTER forever skipped, every commit INSERT failing).
  if (!hasColumn(database, "commit", "annotations")) {
    database.exec(`
ALTER TABLE "commit"
ADD COLUMN annotations JSON;
`);
  }
  if (!hasColumn(database, "commit", "consequence_of")) {
    database.exec(`
ALTER TABLE "commit"
ADD COLUMN consequence_of JSON;
`);
  }
};

// Server-execution v2 stage F: derived-class commits carry the watermark
// they are current through (protocol.md §4, §7 — `derivedThrough`, derived
// only). Historical rows stay NULL: no serving loop existed to advance a
// watermark before this column. Runs after migrateCommitWaveCarriage so
// migrated stores and fresh stores agree on column order.
const migrateCommitDerivedThrough = (database: Database): void => {
  if (hasColumn(database, "commit", "derived_through")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN derived_through INTEGER;
`);
};

// Server-execution v2 stage F: server-produced authored commits carry the
// delegated acting identity + capability grant they were admitted under
// (protocol.md §2's delegated row, §2b). Historical rows stay NULL — no
// delegated producer predates this column trio. One guard per column
// (the migrateCommitWaveCarriage crash-window rationale).
const migrateCommitDelegation = (database: Database): void => {
  for (
    const column of ["acting_principal", "acting_session", "capability_ref"]
  ) {
    if (!hasColumn(database, "commit", column)) {
      database.exec(`
ALTER TABLE "commit"
ADD COLUMN ${column} TEXT;
`);
    }
  }
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
  migrateCommitWaveCarriage(database);
  migrateCommitDerivedThrough(database);
  migrateCommitDelegation(database);
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
  {
    id,
    branch = DEFAULT_BRANCH,
    seq,
    scope,
    principal,
    sessionId,
    scopeKey: explicitScopeKey,
  }: ReadOptions,
): EntityState | null => {
  const declaredScope = explicitScopeKey !== undefined
    ? scopeOfScopeKey(explicitScopeKey)
    : normalizeScope(scope);
  const scopeKey = explicitScopeKey ??
    resolveScopeKey(scope, { principal, sessionId });
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
  const declaredScope = scope ?? scopeOfScopeKey(scopeKey);
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

/**
 * A wave commit's per-doc CAS re-verification failed: some doc the batch
 * writes has a head past the wave's basis, or a rebased doc's head moved
 * past the head the rebase decision observed. The wave commit step folds
 * `conflictedDocs` into its conflict resolution and re-attempts —
 * whole-wave CAS failure is forbidden (serving-loop.md §3d), so this
 * error NAMES what moved.
 */
export class WaveCommitConflictError extends Error {
  override readonly name = "WaveCommitConflictError";
  readonly conflictedDocs: readonly string[];
  constructor(conflictedDocs: readonly string[]) {
    super(
      `wave commit re-verification: doc head(s) advanced past the wave ` +
        `basis: ${conflictedDocs.join(", ")}`,
    );
    this.conflictedDocs = conflictedDocs;
  }
}

/**
 * A wave commit's precondition pre-check failed. Unlike the shared
 * validator's first-failure throw, this NAMES every failing precondition
 * by index into the batch's preconditions array, so the wave commit step
 * can resolve each failure to its owning contribution per write class
 * (serving-loop.md §3d — one contribution's violated create-only mark
 * must not abort every other contribution's work).
 */
export class WavePreconditionError extends Error {
  override readonly name = "WavePreconditionError";
  readonly failedPreconditions: readonly number[];
  constructor(failedPreconditions: readonly number[], detail: string) {
    super(
      `wave commit precondition(s) failed at index(es) ` +
        `${failedPreconditions.join(", ")}: ${detail}`,
    );
    this.failedPreconditions = failedPreconditions;
  }
}

/** Current head seq of one doc instance (0 when never written). */
export const selectDocHead = (
  engine: Engine,
  options: { branch?: BranchName; id: EntityId; scopeKey: string },
): number => {
  const row = engine.database.prepare(`
SELECT seq FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`).get({
      branch: options.branch ?? DEFAULT_BRANCH,
      id: options.id,
      scope_key: options.scopeKey,
    }) as { seq: number } | undefined;
  return row?.seq ?? 0;
};

/**
 * The value paths written to one doc instance by revisions after
 * `sinceSeq` — the field-level merge input for the wave commit step's
 * rebase of non-re-derivable writes (serving-loop.md §3d). A `set` or
 * `delete` revision reports the root path (it rewrites the whole doc);
 * a `patch` revision reports its patches' pointer paths.
 */
export const selectWritePathsSince = (
  engine: Engine,
  options: {
    branch?: BranchName;
    id: EntityId;
    scopeKey: string;
    sinceSeq: number;
  },
): Array<readonly string[]> => {
  const rows = engine.database.prepare(`
SELECT op, data FROM revision
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
  AND seq > :since_seq
ORDER BY seq, op_index
`).all({
      branch: options.branch ?? DEFAULT_BRANCH,
      id: options.id,
      scope_key: options.scopeKey,
      since_seq: options.sinceSeq,
    }) as Array<{ op: string; data: string | null }>;
  const paths: Array<readonly string[]> = [];
  for (const row of rows) {
    if (row.op === "patch" && row.data !== null) {
      const patches = decodeMemoryBoundary(row.data) as PatchOp[];
      for (const patch of patches) {
        paths.push(parsePointer(patch.path));
      }
    } else {
      paths.push([]);
    }
  }
  return paths;
};

/**
 * One admitted commit as the serving loop's subscription sees it
 * (serving-loop.md §1 plane (d), §3): class + holder for the self-echo
 * skip, and the written doc INSTANCES for dirtiness marking. Assembled
 * from the commit row and its revision rows — ids and scope keys only,
 * never payloads (values travel on the ordinary session-sync path).
 */
export type CommitFeedRecord = {
  seq: number;
  branch: BranchName;
  class: CommitClass;
  holder: string | null;
  sessionId: string;
  writes: Array<{ id: EntityId; scopeKey: string }>;
};

/**
 * The accepted-commit feed's catch-up read (protocol.md §3: "the
 * SpaceServer subscribes to the whole space's accepted-commit feed from a
 * seq"; serving-loop.md §6 step 2: "subscribe from the head the index scan
 * ran against; later commits arrive as ordinary input"). Returns commits
 * with seq > fromSeq in seq order. Direct-engine read on the co-hosted
 * plane — never wire, never pushed to clients.
 */
export const selectCommitsSince = (
  engine: Engine,
  options: { fromSeq: number; branch?: BranchName; limit?: number },
): CommitFeedRecord[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const commits = engine.database.prepare(`
SELECT seq, branch, class, holder, session_id
FROM "commit"
WHERE seq > :from_seq AND branch = :branch
ORDER BY seq
LIMIT :limit
`).all({
      from_seq: options.fromSeq,
      branch,
      limit: options.limit ?? Number.MAX_SAFE_INTEGER,
    }) as Array<{
      seq: number;
      branch: string;
      class: CommitClass;
      holder: string | null;
      session_id: string;
    }>;
  const writesFor = engine.database.prepare(`
SELECT DISTINCT id, scope_key FROM revision
WHERE commit_seq = :commit_seq
`);
  return commits.map((row) => ({
    seq: row.seq,
    branch: row.branch,
    class: row.class,
    holder: row.holder,
    sessionId: row.session_id,
    writes: (writesFor.all({ commit_seq: row.seq }) as Array<
      { id: string; scope_key: string }
    >).map((write) => ({ id: write.id, scopeKey: write.scope_key })),
  }));
};

/** One basis-row overwrite unit of a wave commit (serving-loop.md §3b):
 * `seq: null` marks an in-wave read, filled with the wave's own commit
 * seq at write time. */
export type WaveBasisInstance = {
  action: string;
  actionScopeKey: string;
  rows: ReadonlyArray<{
    entitySpace: string;
    entity: string;
    entityScopeKey: string;
    seq: number | null;
  }>;
};

/**
 * The wave commit's store transaction (server-execution v2 stage D,
 * serving-loop.md §3b–§3d): per-doc CAS re-verification against the
 * wave's basis, the commit apply (admission included — the derived-class
 * lease check, annotation keying, consequenceOf carriage), and the basis-
 * index overwrites, all in ONE engine transaction. This is what makes the
 * accumulator's sink contract implementable: between the wave's own head
 * query and this call the engine may admit concurrent commits, and the
 * re-verification here — inside the transaction — is the load-bearing
 * concurrency check (§3d forbids blind derived writes). On conflict it
 * throws {@link WaveCommitConflictError} naming the moved docs, and
 * nothing is applied.
 */
export const applyWaveCommit = (
  engine: Engine,
  options: ApplyCommitOptions & {
    waveBasis: {
      /** The wave's input snapshot seq (per-doc CAS basis). */
      basisSeq: number;
      /** Per doc-instance key (`${id} ${scopeKey}`): the head the wave's
       * rebase decision observed. Re-verification requires these docs to
       * sit at EXACTLY that head — §3d's re-CAS against the new head; a
       * further move invalidates the field-level merge. */
      rebasedHeads: ReadonlyArray<{ doc: string; head: number }>;
    };
    basisInstances?: readonly WaveBasisInstance[];
  },
): AppliedCommit => {
  return engine.database.transaction(
    (txEngine: Engine, txOptions: typeof options) => {
      const { waveBasis, basisInstances, ...applyOptions } = txOptions;
      const rebasedHeads = new Map(
        waveBasis.rebasedHeads.map(({ doc, head }) => [doc, head]),
      );
      const scopeKeyByOp = new Map<number, string>();
      for (const annotation of applyOptions.annotations ?? []) {
        if (annotation.scopeKey !== undefined) {
          scopeKeyByOp.set(annotation.op, annotation.scopeKey);
        }
      }
      const conflicted = new Set<string>();
      const checked = new Set<string>();
      for (
        const [opIndex, operation] of applyOptions.commit.operations.entries()
      ) {
        if (operation.op === "sqlite") continue;
        // A space-declared op never takes an annotated key: the apply
        // below refuses such an annotation as a ProtocolError, and keying
        // this pre-check by the DECLARED scope keeps that refusal — not a
        // phantom, resolvable-looking conflict — the error the wave sees.
        const annotated = normalizeScope(operation.scope) === "space"
          ? undefined
          : scopeKeyByOp.get(opIndex);
        const scopeKey = annotated ??
          resolveScopeKey(operation.scope, {
            principal: applyOptions.principal,
            sessionId: applyOptions.sessionId,
          });
        const key = `${operation.id} ${scopeKey}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const head = selectDocHead(txEngine, {
          branch: applyOptions.commit.branch,
          id: operation.id,
          scopeKey,
        });
        const rebasedAt = rebasedHeads.get(key);
        if (rebasedAt !== undefined) {
          // A rebased write: sound only against the exact head its
          // field-level merge was decided at.
          if (head !== rebasedAt) conflicted.add(key);
        } else if (head > waveBasis.basisSeq) {
          conflicted.add(key);
        }
      }
      if (conflicted.size > 0) {
        throw new WaveCommitConflictError([...conflicted]);
      }
      // Preconditions pre-checked ONE BY ONE so a failure names its
      // index: the shared validator throws on the first failure without
      // saying which, and the wave commit step needs per-owner
      // resolution (WavePreconditionError above). The synthetic
      // single-precondition commit reuses the validator unchanged; the
      // apply below re-runs the full set inside this same transaction,
      // which — having passed here — cannot fail there.
      const failedPreconditions: number[] = [];
      let firstDetail = "";
      const sessionKey = resolveCommitSessionKey(
        applyOptions.sessionId,
        applyOptions.principal,
      );
      const branch = applyOptions.commit.branch ?? DEFAULT_BRANCH;
      for (
        const [index, precondition] of (
          applyOptions.commit.preconditions ?? []
        ).entries()
      ) {
        try {
          validateCommitPreconditions(txEngine, sessionKey, branch, {
            ...applyOptions.commit,
            preconditions: [precondition],
          }, {
            principal: applyOptions.principal,
            sessionId: applyOptions.sessionId,
          });
        } catch (error) {
          if (error instanceof PreconditionFailedError) {
            failedPreconditions.push(index);
            if (firstDetail === "") {
              firstDetail = error.message;
            }
          } else {
            throw error;
          }
        }
      }
      if (failedPreconditions.length > 0) {
        throw new WavePreconditionError(failedPreconditions, firstDetail);
      }
      const applied = applyCommitTransaction(txEngine, applyOptions);
      for (const instance of basisInstances ?? []) {
        replaceSchedulerBasisRows(txEngine, {
          branch,
          action: instance.action,
          actionScopeKey: instance.actionScopeKey,
          rows: instance.rows.map((row) => ({
            entitySpace: row.entitySpace,
            entity: row.entity,
            entityScopeKey: row.entityScopeKey,
            seq: row.seq ?? applied.seq,
          })),
        });
      }
      return applied;
    },
  ).immediate(engine, options);
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
    annotations,
    consequenceOf,
    derivedThrough,
    delegated,
  }: ApplyCommitOptions,
): AppliedCommit => {
  // The derived-class admission rule (serving-loop.md §2, protocol.md §2's
  // `derived` row): the producer holds the space's live `execution_lease` —
  // ONE equality check against the row's holder, not admission machinery.
  // Enforced only under EXPERIMENTAL_SERVER_EXECUTION; off the flag the
  // class stays unclaimable in this arm too, because `derived` names the
  // single-deriver posture and nothing outside the flag may claim it
  // (protocol.md §1). Liveness is judged by THIS process's clock — the
  // memory server's own, never the holder's: the select excludes expired
  // rows, so an expired lease matches nobody and a derived commit under one
  // is rejected even before any successor acquires.
  if (commitClass === "derived") {
    if (!getServerExecutionConfig()) {
      throw new ProtocolError(
        "derived-class commits are unclaimable while " +
          "EXPERIMENTAL_SERVER_EXECUTION is off (protocol.md §1)",
      );
    }
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
    // Derived-envelope defense-in-depth (protocol.md §2, RULED 2026-08-05):
    // the commit's producing SESSION must be the lease holder's OWN service
    // session. The engine-side operand mapping (stage F design): the
    // holder's service session is the engine session whose resolved commit
    // session key EQUALS the holder identity — the wave sink commits with
    // `sessionId === holder` and no principal, so the envelope principal IS
    // the lease holder, read literally (protocol.md §1). A derived commit
    // arriving under a user session — or any session other than the
    // declared holder's — is REFUSED even though it named the right holder,
    // closing the "single honest internal caller" gap before stage F
    // multiplies the callers of the co-hosted engine plane. This mirrors
    // the executable model's `admitDerived`, which compares the envelope
    // principal to `holderId`.
    if (resolveCommitSessionKey(sessionId, principal) !== holder) {
      throw new ProtocolError(
        "derived-class commit rejected: producing session is not the " +
          "lease holder's own service session (protocol.md §2, RULED " +
          "2026-08-05)",
      );
    }
    if (delegated !== undefined) {
      throw new ProtocolError(
        "delegated-identity carriage is server-produced AUTHORED " +
          "admission only (protocol.md §2's delegated row); a derived " +
          "commit's identity rides its per-write annotations",
      );
    }
  } else if (
    annotations !== undefined || consequenceOf !== undefined ||
    derivedThrough !== undefined
  ) {
    // protocol.md §7's closed metadata list: the annotation pair,
    // consequenceOf, and derivedThrough are DERIVED-only carriage. No
    // session-facing path can supply them (`ClientCommit` cannot express
    // any of the three), so reaching here on another class is a
    // server-side plumbing bug, refused loudly.
    throw new ProtocolError(
      "write annotations, consequenceOf, and derivedThrough are " +
        "derived-commit carriage only (protocol.md §1, §7)",
    );
  }
  // The delegated row (protocol.md §2, §2b): server-produced AUTHORED
  // commits carry the originating chain actor + capabilityRef, and
  // admission validates the grant — delegation, never session-identity
  // impersonation. The Phase-1 validation floor: the carriage must be
  // COMPLETE (an actor with no grant, or a grant with no actor, is
  // refused loudly), the class must be authored, and scoped writes key
  // from the CARRIED identity below. Resolving the grant against a
  // per-doc capability store is future hardening the row names
  // (protocol.md §2's anticipated grant-scoped checks); today's ACL
  // model has no per-doc grants to resolve against, so presence +
  // completeness is the whole check — deliberately stated, not implied.
  if (delegated !== undefined) {
    if (commitClass !== "authored") {
      throw new ProtocolError(
        "delegated-identity carriage is authored-class admission only " +
          "(protocol.md §2's delegated row)",
      );
    }
    if (
      delegated.actingPrincipal === undefined ||
      delegated.actingPrincipal === "" ||
      delegated.capabilityRef === undefined ||
      delegated.capabilityRef === ""
    ) {
      throw new ProtocolError(
        "delegated admission requires the acting principal AND the " +
          "capability grant (protocol.md §2's server-produced authored " +
          "row) — partial carriage is refused, never defaulted",
      );
    }
    // A sessionless delegated chain has NO session instance (scopes.md
    // §5: a sessionless actor's session-scoped write is an ERROR —
    // neither falling back to another identity nor minting a session is
    // permitted). Without this refusal the writeOperation fallback
    // below would key such a write from the DELEGATING envelope's
    // session — `session:<actingPrincipal>:<sink session>`, a chimera
    // instance no party ever acted as. Refused at admission, loudly.
    if (
      delegated.actingSession === undefined || delegated.actingSession === ""
    ) {
      for (const operation of commit.operations) {
        if (operation.op === "sqlite") continue;
        if (normalizeScope(operation.scope) === "session") {
          throw new ProtocolError(
            "delegated admission rejected: a sessionless delegated " +
              "batch (no actingSession) carries a session-scoped write " +
              "— a sessionless actor has no session instance " +
              "(scopes.md §5, protocol.md §2's delegated row)",
          );
        }
      }
    }
  }

  // Derived commits key scoped writes by their EXPLICIT annotation
  // scopeKey (protocol.md §1's ADDRESSING): the wave's envelope is the
  // SpaceServer's service identity — no user principal, no session — so
  // deriving keys from it would silently resolve `user:<serviceDID>`, the
  // empty-instance trap protocol.md §2 exists to prevent. Fail closed: a
  // scoped write with no annotated key is rejected, never defaulted.
  const scopeKeyByOpIndex = new Map<number, string>();
  if (commitClass === "derived") {
    for (const annotation of annotations ?? []) {
      if (annotation.scopeKey !== undefined) {
        scopeKeyByOpIndex.set(annotation.op, annotation.scopeKey);
      }
    }
    for (const [opIndex, operation] of commit.operations.entries()) {
      if (operation.op === "sqlite") continue;
      const declared = normalizeScope(operation.scope);
      const annotated = scopeKeyByOpIndex.get(opIndex);
      if (declared === "space") {
        // protocol.md §1's ADDRESSING is one per SCOPED write, and §7's
        // closed list sanctions nothing else: an annotation aimed at a
        // space-scoped op would otherwise be silently APPLIED as the
        // row's key (writeOperation's scopeKeyOverride below), re-keying
        // a space-visible doc into a scoped instance nothing declared.
        // Fail closed, like the missing-annotation branch.
        if (annotated !== undefined) {
          throw new ProtocolError(
            `derived-class commit rejected: scope_key annotation ` +
              `"${annotated}" targets a space-scoped write ` +
              `(op ${opIndex}); addressing is one per SCOPED write ` +
              "(protocol.md §1, §7)",
          );
        }
        continue;
      }
      if (annotated === undefined) {
        throw new ProtocolError(
          `derived-class commit rejected: scoped write (op ${opIndex}, ` +
            `scope "${declared}") carries no explicit scope_key ` +
            "annotation (protocol.md §1)",
        );
      }
      if (scopeOfScopeKey(annotated) !== declared) {
        throw new ProtocolError(
          `derived-class commit rejected: annotated scope_key ` +
            `"${annotated}" does not match the write's declared scope ` +
            `"${declared}" (op ${opIndex})`,
        );
      }
    }
  }
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  const hasPreconditions = (commit.preconditions?.length ?? 0) > 0;
  if (commit.operations.length === 0 && !hasPreconditions) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  // Replay detection first: a commit this session already applied returns
  // its stored result without re-validating preconditions — re-checking
  // entity-absent against the state the original application created would
  // wrongly reject the replay.
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
    annotations: commitClass === "derived" && annotations !== undefined &&
        annotations.length > 0
      ? encodeMemoryBoundary(annotations)
      : null,
    consequence_of: commitClass === "derived" && consequenceOf !== undefined &&
        consequenceOf.length > 0
      ? encodeMemoryBoundary(consequenceOf)
      : null,
    derived_through: commitClass === "derived" && derivedThrough !== undefined
      ? derivedThrough
      : null,
    acting_principal: delegated?.actingPrincipal ?? null,
    acting_session: delegated?.actingSession ?? null,
    capability_ref: delegated?.capabilityRef ?? null,
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
      // A delegated commit's scoped writes key from the validated CARRIED
      // identity (protocol.md §2's delegated row; scopes.md §5 —
      // consequences land in the ACTOR's instances, never the delegating
      // envelope's; stamping from the envelope would be the
      // silent-empty-instance trap, cross-space edition). The
      // `?? sessionId` fallback is safe ONLY because admission above
      // refuses a sessionless delegated batch carrying a session-scoped
      // op: for the ops that reach here under a sessionless delegation,
      // no session component enters the key.
      principal: delegated?.actingPrincipal ?? principal,
      sessionId: delegated?.actingSession ?? sessionId,
      scopeKeyOverride: scopeKeyByOpIndex.get(opIndex),
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
    /** The explicit scope_key of a derived commit's scoped write
     * (protocol.md §1's ADDRESSING): admission validated it against the
     * declared scope; when present it keys the row instead of a
     * session-derived resolution — the service envelope has no session to
     * resolve from. */
    scopeKeyOverride?: string;
  },
): AppliedRevision => {
  const { branch, seq, opIndex, operation, principal, sessionId } = options;
  const scope = normalizeScope(operation.scope);
  const scopeKey = options.scopeKeyOverride ??
    resolveScopeKey(operation.scope, { principal, sessionId });
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
      scope: scopeOfScopeKey(row.scope_key),
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
      : applyPatchDocument(document, revision.patches ?? []);
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
): EntityDocument => applyPatch(document, patches) as EntityDocument;

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
