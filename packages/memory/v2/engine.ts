import { Database } from "@db/sqlite";
import { fromDigest } from "merkle-reference";
import { sha256 } from "@commonfabric/content-hash";
import type { FabricValue } from "../interface.ts";
import { applyPatch } from "./patch.ts";
import { parentPath, parsePointer, pathsOverlap } from "./path.ts";
import {
  type Blob,
  type BranchName,
  type ClientCommit,
  decodeMemoryV2Boundary,
  DEFAULT_BRANCH,
  encodeMemoryV2Boundary,
  type EntityDocument,
  type EntityId,
  isEntityDocument,
  type Operation,
  type PatchOp,
  type Reference,
  type SessionId,
} from "../v2.ts";

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
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_revision_branch_id_seq
  ON revision (branch, id, seq, op_index);
CREATE INDEX IF NOT EXISTS idx_revision_commit
  ON revision (commit_seq);
CREATE INDEX IF NOT EXISTS idx_revision_branch
  ON revision (branch, seq);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  PRIMARY KEY (branch, id)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  branch  TEXT    NOT NULL DEFAULT '',
  id      TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  value   JSON    NOT NULL,
  PRIMARY KEY (branch, id, seq)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, seq);

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
  seq,
  op_index,
  op,
  data,
  commit_seq
)
VALUES (
  :branch,
  :id,
  :seq,
  :op_index,
  :op,
  :data,
  :commit_seq
)
`;

const UPSERT_HEAD = `
INSERT INTO head (branch, id, seq, op_index)
VALUES (:branch, :id, :seq, :op_index)
ON CONFLICT (branch, id) DO UPDATE
SET seq = :seq, op_index = :op_index
`;

const INSERT_SNAPSHOT = `
INSERT OR REPLACE INTO snapshot (branch, id, seq, value)
VALUES (:branch, :id, :seq, :value)
`;

const DELETE_OLD_SNAPSHOTS = `
DELETE FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND seq NOT IN (
    SELECT seq
    FROM snapshot
    WHERE branch = :branch
      AND id = :id
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
WHERE branch = :branch AND id = :id
`;

const SELECT_CURRENT_LOCAL = `
SELECT r.seq, r.op_index, r.op, r.data
FROM head h
JOIN revision r
  ON r.branch = h.branch
 AND r.id = h.id
 AND r.seq = h.seq
 AND r.op_index = h.op_index
WHERE h.branch = :branch AND h.id = :id
`;

const SELECT_AT_SEQ_LOCAL = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND seq <= :seq
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_LATEST_BASE = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
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
  AND seq <= :seq
ORDER BY seq DESC
LIMIT 1
`;

const SELECT_PATCHES = `
SELECT seq, op_index, data
FROM revision
WHERE branch = :branch
  AND id = :id
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
SELECT branch, id, seq, op_index, op, data, commit_seq
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
  invocation?: InvocationRecord;
  invocationPayload?: FabricValue;
  authorization?: AuthorizationRecord;
  commit: ClientCommit;
}

export interface AppliedRevision {
  id: EntityId;
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
}

export interface ReadOptions {
  id: EntityId;
  branch?: BranchName;
  seq?: number;
}

export interface EntityState {
  id: EntityId;
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
  { id, branch = DEFAULT_BRANCH, seq }: ReadOptions,
): EntityDocument | null => {
  return readState(engine, { id, branch, seq })?.document ?? null;
};

export const readState = (
  engine: Engine,
  { id, branch = DEFAULT_BRANCH, seq }: ReadOptions,
): EntityState | null => {
  const targetSeq = seq ?? headSeq(engine, branch);
  const resolved = readRowForBranch(engine, { id, branch, seq: targetSeq });
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
        branch: resolvedBranch,
        seq: row.seq,
        opIndex: row.op_index,
      });
      break;
  }

  return {
    id,
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

export const putBlob = (
  engine: Engine,
  options: PutBlobOptions,
): Blob => {
  const hash = hashBlobBytes(options.value);
  engine.statements.insertBlob.run({
    hash,
    data: options.value,
    content_type: options.contentType,
    size: options.value.byteLength,
  });
  return {
    hash,
    value: new Uint8Array(options.value),
    contentType: options.contentType,
    size: options.value.byteLength,
  };
};

export const getBlob = (engine: Engine, hash: Reference): Blob | null => {
  const row = engine.statements.selectBlob.get({ hash }) as BlobRow | undefined;
  if (!row) {
    return null;
  }
  return {
    hash,
    value: new Uint8Array(row.data),
    contentType: row.content_type,
    size: row.size,
  };
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
    commit,
  }: ApplyCommitOptions,
): AppliedCommit => {
  if (commit.operations.length === 0) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  ensureActiveBranch(engine, branch);

  const existing = engine.statements.selectExistingCommit.get({
    session_id: sessionId,
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

  validateConfirmedReads(engine, branch, commit);
  const resolvedPendingReads = resolvePendingReads(
    engine,
    sessionId,
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
  const original = encodeMemoryV2Boundary(commit);
  const resolution = encodeMemoryV2Boundary(
    resolvedPendingReads.length > 0 ? { seq, resolvedPendingReads } : { seq },
  );

  if (engine.legacyCommitMetadataRefsRequired) {
    engine.statements.insertAuthorization.run({
      ref: LEGACY_EMPTY_AUTHORIZATION_REF,
      authorization: encodeMemoryV2Boundary(LEGACY_EMPTY_AUTHORIZATION),
    });
    engine.statements.insertInvocation.run({
      ref: LEGACY_EMPTY_INVOCATION_REF,
      iss: LEGACY_EMPTY_INVOCATION.iss,
      aud: LEGACY_EMPTY_INVOCATION.aud ?? null,
      cmd: LEGACY_EMPTY_INVOCATION.cmd,
      sub: LEGACY_EMPTY_INVOCATION.sub,
      invocation: encodeMemoryV2Boundary(LEGACY_EMPTY_INVOCATION),
    });
  }
  engine.statements.insertCommit.run({
    seq,
    branch,
    session_id: sessionId,
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
    });
    revisions.push(revision);
  }

  engine.statements.updateBranchHead.run({ branch, seq });
  materializeSnapshots(engine, branch, revisions);

  return { seq, branch, revisions };
};

const writeOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    opIndex: number;
    operation: Operation;
  },
): AppliedRevision => {
  const { branch, seq, opIndex, operation } = options;
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
        seq,
        op_index: opIndex,
        op: "set",
        data: encodeMemoryV2Boundary(operation.value),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
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
        seq,
        op_index: opIndex,
        op: "patch",
        data: encodeMemoryV2Boundary(operation.patches),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
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
        seq,
        op_index: opIndex,
        op: "delete",
        data: null,
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        seq,
        op_index: opIndex,
      });
      return {
        id: operation.id,
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
): void => {
  for (const read of commit.reads.confirmed) {
    const readBranch = read.branch ?? branch;
    ensureReadableBranch(engine, readBranch);
    const conflictSeq = findConflictSeq(
      engine,
      readBranch,
      read.id,
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
  sessionId: SessionId,
  branch: BranchName,
  commit: ClientCommit,
): Array<{ localSeq: number; seq: number }> => {
  const resolutions = new Map<number, { localSeq: number; seq: number }>();

  for (const read of commit.reads.pending) {
    let resolution = resolutions.get(read.localSeq);
    if (!resolution) {
      const row = engine.statements.selectPendingResolution.get({
        session_id: sessionId,
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
  afterSeq: number,
  readPath: readonly string[],
): number | null => {
  const setOrDeleteConflict = engine.statements.selectSetDeleteConflict.get({
    branch,
    id,
    after_seq: afterSeq,
  }) as { seq: number } | undefined;
  if (setOrDeleteConflict !== undefined) {
    return setOrDeleteConflict.seq;
  }

  for (
    const conflict of engine.statements.selectPatchConflicts.iter({
      branch,
      id,
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
    const key = revisionKey(branch, revision.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    maybeMaterializeSnapshot(engine, branch, revision.id);
  }
};

const maybeMaterializeSnapshot = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
): void => {
  const current = readState(engine, { id, branch });
  if (current === null || current.document === null || current.op !== "patch") {
    return;
  }

  const baseSeq = latestMaterializationSeq(engine, branch, id, current.seq);
  const patchCount = (
    engine.statements.selectPatchCount.get({
      branch,
      id,
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
    seq: current.seq,
    value: encodeMemoryV2Boundary(current.document),
  });
  compactSnapshots(engine, branch, id);
};

const compactSnapshots = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
): void => {
  if (engine.snapshotRetention <= 0) {
    return;
  }
  engine.statements.deleteOldSnapshots.run({
    branch,
    id,
    retention: engine.snapshotRetention,
  });
};

const latestMaterializationSeq = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  seq: number,
): number => {
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    seq,
    op_index: Number.MAX_SAFE_INTEGER,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    seq,
  }) as SnapshotRow | undefined;
  return Math.max(baseRow?.seq ?? 0, snapshotRow?.seq ?? 0);
};

const reconstructPatchedDocument = (
  engine: Engine,
  options: {
    id: EntityId;
    branch: BranchName;
    seq: number;
    opIndex: number;
  },
): EntityDocument => {
  const { id, branch, seq, opIndex } = options;
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    seq,
    op_index: opIndex,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
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
      })
      : engine.statements.selectAtSeqLocal.get({
        branch: options.branch,
        id: options.id,
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
  const parsed = decodeMemoryV2Boundary<unknown>(data ?? "null");
  if (!isEntityDocument(parsed)) {
    throw new Error("memory v2 stored documents must be plain object roots");
  }
  return parsed;
};

const decodeStoredPatchList = (data: string | null): PatchOp[] => {
  const parsed = decodeMemoryV2Boundary<unknown>(data ?? "[]");
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
  return stored === encodeMemoryV2Boundary(incoming);
};

const revisionKey = (branch: BranchName, id: EntityId): string =>
  `${branch}\0${id}`;

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

export const hashBlobBytes = (value: Uint8Array): Reference => {
  return fromDigest(sha256(value)).toString() as Reference;
};

const toDatabaseAddress = (url: URL): URL | string => {
  return url.protocol === "file:" ? url : ":memory:";
};
