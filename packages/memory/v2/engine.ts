import { Database } from "@db/sqlite";
import { fromDigest } from "merkle-reference";
import { refer } from "../reference.ts";
import type { JSONValue } from "../interface.ts";
import { sha256 } from "../hash-impl.ts";
import { applyPatch } from "./patch.ts";
import {
  type Blob,
  type BranchName,
  type ClientCommit,
  DEFAULT_BRANCH,
  EMPTY_VALUE_REF,
  type EntityDocument,
  type EntityId,
  isSourceLink,
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

CREATE TABLE IF NOT EXISTS value (
  hash  TEXT NOT NULL PRIMARY KEY,
  data  JSON
);
INSERT OR IGNORE INTO value (hash, data) VALUES ('__empty__', NULL);

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
  hash               TEXT    NOT NULL,
  branch             TEXT    NOT NULL DEFAULT '',
  session_id         TEXT    NOT NULL,
  local_seq          INTEGER NOT NULL,
  invocation_ref     TEXT    NOT NULL,
  authorization_ref  TEXT    NOT NULL,
  original           JSON    NOT NULL,
  resolution         JSON    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);
CREATE INDEX IF NOT EXISTS idx_commit_hash ON "commit" (hash);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON "commit" (branch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_session_local_seq
  ON "commit" (session_id, local_seq);
DROP INDEX IF EXISTS idx_commit_invocation_ref;
CREATE INDEX IF NOT EXISTS idx_commit_invocation_ref
  ON "commit" (invocation_ref);

CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  branch      TEXT    NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL,
  commit_seq  INTEGER NOT NULL,
  fact_type   TEXT    NOT NULL,
  FOREIGN KEY (value_ref) REFERENCES value(hash),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_fact_seq ON fact (seq);
CREATE INDEX IF NOT EXISTS idx_fact_id ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_seq ON fact (id, seq);
CREATE INDEX IF NOT EXISTS idx_fact_commit ON fact (commit_seq);
CREATE INDEX IF NOT EXISTS idx_fact_branch ON fact (branch);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  fact_hash TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  PRIMARY KEY (branch, id),
  FOREIGN KEY (fact_hash) REFERENCES fact(hash)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  id         TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  value_ref  TEXT    NOT NULL,
  branch     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (branch, id, seq),
  FOREIGN KEY (value_ref) REFERENCES value(hash)
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

CREATE VIEW IF NOT EXISTS state AS
SELECT h.branch, h.id, f.fact_type, f.seq, v.data AS value
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref;

COMMIT;
`;

const INSERT_VALUE = `
INSERT OR IGNORE INTO value (hash, data)
VALUES (:hash, :data)
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
  hash,
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
  :hash,
  :branch,
  :session_id,
  :local_seq,
  :invocation_ref,
  :authorization_ref,
  :original,
  :resolution
)
`;

const INSERT_FACT = `
INSERT INTO fact (
  hash,
  id,
  value_ref,
  parent,
  branch,
  seq,
  commit_seq,
  fact_type
)
VALUES (
  :hash,
  :id,
  :value_ref,
  :parent,
  :branch,
  :seq,
  :commit_seq,
  :fact_type
)
`;

const UPSERT_HEAD = `
INSERT INTO head (branch, id, fact_hash, seq)
VALUES (:branch, :id, :fact_hash, :seq)
ON CONFLICT (branch, id) DO UPDATE
SET fact_hash = :fact_hash, seq = :seq
`;

const INSERT_SNAPSHOT = `
INSERT OR REPLACE INTO snapshot (id, seq, value_ref, branch)
VALUES (:id, :seq, :value_ref, :branch)
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
SET head_seq = :seq
WHERE name = :branch
  AND status = 'active'
`;

const SELECT_HEAD = `
SELECT fact_hash, seq
FROM head
WHERE branch = :branch AND id = :id
`;

const SELECT_CURRENT = `
SELECT f.hash, f.fact_type, f.seq, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = :branch AND h.id = :id
`;

const SELECT_AT_SEQ = `
SELECT f.hash, f.fact_type, f.seq, v.data
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.branch = :branch
  AND f.id = :id
  AND f.seq <= :seq
ORDER BY f.seq DESC
LIMIT 1
`;

const SELECT_LATEST_BASE = `
SELECT f.fact_type, f.seq, v.data
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.branch = :branch
  AND f.id = :id
  AND f.fact_type IN ('set', 'delete')
  AND f.seq <= :seq
ORDER BY f.seq DESC
LIMIT 1
`;

const SELECT_LATEST_SNAPSHOT = `
SELECT s.seq, v.data
FROM snapshot s
JOIN value v ON v.hash = s.value_ref
WHERE s.branch = :branch
  AND s.id = :id
  AND s.seq <= :seq
ORDER BY s.seq DESC
LIMIT 1
`;

const SELECT_PATCHES = `
SELECT v.data AS patch_ops, f.seq
FROM fact f
JOIN value v ON v.hash = f.value_ref
WHERE f.branch = :branch
  AND f.id = :id
  AND f.fact_type = 'patch'
  AND f.seq > :base_seq
  AND f.seq <= :seq
ORDER BY f.seq ASC
`;

const SELECT_PATCH_COUNT = `
SELECT COUNT(*) AS count
FROM fact
WHERE branch = :branch
  AND id = :id
  AND fact_type = 'patch'
  AND seq > :after_seq
  AND seq <= :seq
`;

const SELECT_NEXT_SEQ = `
SELECT COALESCE(MAX(seq), 0) + 1 AS seq
FROM "commit"
`;

const SELECT_EXISTING_COMMIT = `
SELECT seq, hash, branch, resolution
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

const SELECT_LATEST_CONFLICT = `
SELECT seq, fact_type, data
FROM fact
JOIN value ON value.hash = fact.value_ref
WHERE branch = :branch
  AND id = :id
  AND seq > :after_seq
ORDER BY seq DESC
`;

const SELECT_PENDING_RESOLUTION = `
SELECT hash, seq
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

const SELECT_COMMIT_FACTS = `
SELECT hash, id, value_ref, parent, branch, seq, commit_seq, fact_type
FROM fact
WHERE commit_seq = :commit_seq
ORDER BY rowid ASC
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

const INSERT_BLOB = `
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size)
`;

const SELECT_BLOB = `
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash
`;

export interface Engine {
  url: URL;
  database: Database;
  snapshotInterval: number;
  snapshotRetention: number;
  statements: PreparedStatements;
}

type PreparedStatement = ReturnType<Database["prepare"]>;

interface PreparedStatements {
  insertAuthorization: PreparedStatement;
  insertBlob: PreparedStatement;
  insertCommit: PreparedStatement;
  insertFact: PreparedStatement;
  insertInvocation: PreparedStatement;
  insertSnapshot: PreparedStatement;
  insertValue: PreparedStatement;
  selectAtSeq: PreparedStatement;
  selectBlob: PreparedStatement;
  selectBranchHeadSeq: PreparedStatement;
  selectBranchStatus: PreparedStatement;
  selectCommitFacts: PreparedStatement;
  selectCurrent: PreparedStatement;
  selectExistingCommit: PreparedStatement;
  selectHead: PreparedStatement;
  selectLatestBase: PreparedStatement;
  selectLatestConflict: PreparedStatement;
  selectLatestSnapshot: PreparedStatement;
  selectNextSeq: PreparedStatement;
  selectPatchCount: PreparedStatement;
  selectPatches: PreparedStatement;
  selectPendingResolution: PreparedStatement;
  upsertHead: PreparedStatement;
  updateBranchHead: PreparedStatement;
  deleteOldSnapshots: PreparedStatement;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
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
  args?: JSONValue;
  [key: string]: unknown;
}

export type AuthorizationRecord = JSONValue;

export interface ApplyCommitOptions {
  sessionId: SessionId;
  invocation: InvocationRecord;
  authorization: AuthorizationRecord;
  commit: ClientCommit;
}

export interface AppliedFact {
  hash: Reference;
  id: EntityId;
  valueRef: string;
  parent: Reference | null;
  branch: BranchName;
  seq: number;
  commitSeq: number;
  factType: Operation["op"];
}

export interface AppliedCommit {
  seq: number;
  hash: Reference;
  branch: BranchName;
  facts: AppliedFact[];
}

export interface ReadOptions {
  id: EntityId;
  branch?: BranchName;
  seq?: number;
}

export interface EntityState {
  id: EntityId;
  branch: BranchName;
  hash: Reference;
  seq: number;
  factType: Operation["op"];
  document: EntityDocument | null;
}

export interface PutBlobOptions {
  value: Uint8Array;
  contentType: string;
}

type HeadRow = {
  fact_hash: string;
  seq: number;
};

type CommitRow = {
  seq: number;
  hash: string;
  branch: string;
  resolution: string;
};

type FactRow = {
  hash: string;
  id: string;
  value_ref: string;
  parent: string | null;
  branch: string;
  seq: number;
  commit_seq: number;
  fact_type: Operation["op"];
};

type ReadRow = {
  hash: string;
  fact_type: Operation["op"];
  seq: number;
  data: string | null;
};

type PatchRow = {
  patch_ops: string;
  seq: number;
};

type SnapshotRow = {
  seq: number;
  data: string | null;
};

type BlobRow = {
  data: Uint8Array;
  content_type: string;
  size: number;
};

export const DEFAULT_SNAPSHOT_INTERVAL = 10;
export const DEFAULT_SNAPSHOT_RETENTION = 2;

const prepareStatements = (database: Database): PreparedStatements => ({
  insertAuthorization: database.prepare(INSERT_AUTHORIZATION),
  insertBlob: database.prepare(INSERT_BLOB),
  insertCommit: database.prepare(INSERT_COMMIT),
  insertFact: database.prepare(INSERT_FACT),
  insertInvocation: database.prepare(INSERT_INVOCATION),
  insertSnapshot: database.prepare(INSERT_SNAPSHOT),
  insertValue: database.prepare(INSERT_VALUE),
  selectAtSeq: database.prepare(SELECT_AT_SEQ),
  selectBlob: database.prepare(SELECT_BLOB),
  selectBranchHeadSeq: database.prepare(SELECT_BRANCH_HEAD_SEQ),
  selectBranchStatus: database.prepare(SELECT_BRANCH_STATUS),
  selectCommitFacts: database.prepare(SELECT_COMMIT_FACTS),
  selectCurrent: database.prepare(SELECT_CURRENT),
  selectExistingCommit: database.prepare(SELECT_EXISTING_COMMIT),
  selectHead: database.prepare(SELECT_HEAD),
  selectLatestBase: database.prepare(SELECT_LATEST_BASE),
  selectLatestConflict: database.prepare(SELECT_LATEST_CONFLICT),
  selectLatestSnapshot: database.prepare(SELECT_LATEST_SNAPSHOT),
  selectNextSeq: database.prepare(SELECT_NEXT_SEQ),
  selectPatchCount: database.prepare(SELECT_PATCH_COUNT),
  selectPatches: database.prepare(SELECT_PATCHES),
  selectPendingResolution: database.prepare(SELECT_PENDING_RESOLUTION),
  upsertHead: database.prepare(UPSERT_HEAD),
  updateBranchHead: database.prepare(UPDATE_BRANCH_HEAD),
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
    statements: prepareStatements(database),
  };
};

export const close = (engine: Engine): void => {
  engine.database.close();
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
  const statement = seq === undefined
    ? engine.statements.selectCurrent
    : engine.statements.selectAtSeq;
  const row =
    (seq === undefined
      ? statement.get({ branch, id })
      : statement.get({ branch, id, seq })) as ReadRow | undefined;

  if (!row) {
    return null;
  }

  let document: EntityDocument | null;
  switch (row.fact_type) {
    case "set":
      document = normalizeEntityDocument(
        JSON.parse(row.data ?? "null") as JSONValue,
      );
      break;
    case "delete":
      document = null;
      break;
    case "patch":
      document = reconstructPatchedDocument(engine, {
        id,
        branch,
        seq: row.seq,
      });
      break;
  }

  return {
    id,
    branch,
    hash: row.hash as Reference,
    seq: row.seq,
    factType: row.fact_type,
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
  const row = engine.statements.selectBlob.get({
    hash,
  }) as BlobRow | undefined;
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
  { sessionId, invocation, authorization, commit }: ApplyCommitOptions,
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
    return {
      seq: existing.seq,
      hash: existing.hash as Reference,
      branch: existing.branch,
      facts: selectCommitFacts(engine, existing.seq),
    };
  }

  validateConfirmedReads(engine, branch, commit);
  const resolvedPendingReads = resolvePendingReads(engine, sessionId, commit);

  const seq = (engine.statements.selectNextSeq.get() as { seq: number }).seq;
  const hash = toReference(commit);
  const invocationRef = toReference(invocation);
  const authorizationRef = toReference(authorization);

  engine.statements.insertAuthorization.run({
    ref: authorizationRef,
    authorization: JSON.stringify(authorization),
  });
  engine.statements.insertInvocation.run({
    ref: invocationRef,
    iss: invocation.iss,
    aud: invocation.aud ?? null,
    cmd: invocation.cmd,
    sub: invocation.sub,
    invocation: JSON.stringify(invocation),
  });
  engine.statements.insertCommit.run({
    seq,
    hash,
    branch,
    session_id: sessionId,
    local_seq: commit.localSeq,
    invocation_ref: invocationRef,
    authorization_ref: authorizationRef,
    original: JSON.stringify(commit),
    resolution: JSON.stringify(
      resolvedPendingReads.length > 0 ? { seq, resolvedPendingReads } : { seq },
    ),
  });

  const facts: AppliedFact[] = [];
  const heads = new Map<string, HeadRow | null>();
  for (const operation of commit.operations) {
    const head = resolveHead(engine, heads, branch, operation.id);
    const next = writeOperation(engine, {
      branch,
      seq,
      head,
      operation,
    });
    heads.set(headKey(branch, operation.id), {
      fact_hash: next.hash,
      seq,
    });
    facts.push({
      hash: next.hash,
      id: operation.id,
      valueRef: next.valueRef,
      parent: next.parent,
      branch,
      seq,
      commitSeq: seq,
      factType: next.factType,
    });
  }

  engine.statements.updateBranchHead.run({ branch, seq });
  materializeSnapshots(engine, branch, facts);

  return { seq, hash, branch, facts };
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

const validateConfirmedReads = (
  engine: Engine,
  branch: BranchName,
  commit: ClientCommit,
): void => {
  for (const read of commit.reads.confirmed) {
    const readBranch = read.branch ?? branch;
    ensureActiveBranch(engine, readBranch);
    const conflicts = engine.statements.selectLatestConflict.all({
      branch: readBranch,
      id: read.id,
      after_seq: read.seq,
    }) as Array<{
      seq: number;
      fact_type: Operation["op"];
      data: string | null;
    }>;
    const conflict = conflicts.find((candidate) =>
      factOverlapsRead(candidate, read.path)
    );
    if (conflict !== undefined) {
      throw new ConflictError(
        `stale confirmed read: ${read.id} at seq ${read.seq} conflicted with seq ${conflict.seq}`,
      );
    }
  }
};

const factOverlapsRead = (
  fact: {
    fact_type: Operation["op"];
    data: string | null;
  },
  readPath: readonly string[],
): boolean => {
  switch (fact.fact_type) {
    case "set":
    case "delete":
      return true;
    case "patch":
      return patchOverlapsRead(
        JSON.parse(fact.data ?? "[]") as PatchOp[],
        readPath,
      );
  }
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

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefixPath(left, right) || isPrefixPath(right, left);

const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, index) => path[index] === segment);
};

const parentPath = (path: readonly string[]): string[] => {
  return path.length === 0 ? [] : [...path.slice(0, -1)];
};

const parsePointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${path}`);
  }
  return path.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

const resolvePendingReads = (
  engine: Engine,
  sessionId: SessionId,
  commit: ClientCommit,
): Array<{ localSeq: number; hash: Reference; seq: number }> => {
  const resolutions = new Map<
    number,
    { localSeq: number; hash: Reference; seq: number }
  >();

  for (const read of commit.reads.pending) {
    if (resolutions.has(read.localSeq)) {
      continue;
    }
    const row = engine.statements.selectPendingResolution.get({
      session_id: sessionId,
      local_seq: read.localSeq,
    }) as { hash: string; seq: number } | undefined;
    if (!row) {
      throw new ConflictError(
        `pending dependency not resolved: ${read.localSeq}`,
      );
    }
    resolutions.set(read.localSeq, {
      localSeq: read.localSeq,
      hash: row.hash as Reference,
      seq: row.seq,
    });
  }

  return [...resolutions.values()].sort((a, b) => a.localSeq - b.localSeq);
};

const selectCommitFacts = (
  engine: Engine,
  commitSeq: number,
): AppliedFact[] => {
  const rows = engine.statements.selectCommitFacts.all({
    commit_seq: commitSeq,
  }) as FactRow[];
  return rows.map((row) => ({
    hash: row.hash as Reference,
    id: row.id,
    valueRef: row.value_ref,
    parent: row.parent as Reference | null,
    branch: row.branch,
    seq: row.seq,
    commitSeq: row.commit_seq,
    factType: row.fact_type,
  }));
};

const resolveHead = (
  engine: Engine,
  heads: Map<string, HeadRow | null>,
  branch: BranchName,
  id: EntityId,
): HeadRow | null => {
  const key = headKey(branch, id);
  if (heads.has(key)) {
    return heads.get(key) ?? null;
  }

  const row = engine.statements.selectHead.get({
    branch,
    id,
  }) as HeadRow | undefined;
  const head = row ?? null;
  heads.set(key, head);
  return head;
};

const writeOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    head: HeadRow | null;
    operation: Operation;
  },
): {
  hash: Reference;
  parent: Reference | null;
  valueRef: string;
  factType: Operation["op"];
} => {
  const { branch, seq, head, operation } = options;
  const parent = head?.fact_hash as Reference | undefined;
  const parentRef = parent ?? emptyReferenceFor(operation.id);

  switch (operation.op) {
    case "set": {
      const value = normalizeEntityDocument(operation.value);
      const valueRef = toReference(value);
      engine.statements.insertValue.run({
        hash: valueRef,
        data: JSON.stringify(value),
      });

      const hash = toReference({
        type: "set",
        id: operation.id,
        value,
        parent: parentRef,
      });

      engine.statements.insertFact.run({
        hash,
        id: operation.id,
        value_ref: valueRef,
        parent: parent ?? null,
        branch,
        seq,
        commit_seq: seq,
        fact_type: "set",
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        fact_hash: hash,
        seq,
      });
      return { hash, parent: parent ?? null, valueRef, factType: "set" };
    }
    case "patch": {
      const valueRef = toReference(operation.patches);
      engine.statements.insertValue.run({
        hash: valueRef,
        data: JSON.stringify(operation.patches),
      });

      const hash = toReference({
        type: "patch",
        id: operation.id,
        ops: operation.patches,
        parent: parentRef,
      });
      engine.statements.insertFact.run({
        hash,
        id: operation.id,
        value_ref: valueRef,
        parent: parent ?? null,
        branch,
        seq,
        commit_seq: seq,
        fact_type: "patch",
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        fact_hash: hash,
        seq,
      });
      return { hash, parent: parent ?? null, valueRef, factType: "patch" };
    }
    case "delete": {
      const hash = toReference({
        type: "delete",
        id: operation.id,
        parent: parentRef,
      });
      engine.statements.insertFact.run({
        hash,
        id: operation.id,
        value_ref: EMPTY_VALUE_REF,
        parent: parent ?? null,
        branch,
        seq,
        commit_seq: seq,
        fact_type: "delete",
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        fact_hash: hash,
        seq,
      });
      return {
        hash,
        parent: parent ?? null,
        valueRef: EMPTY_VALUE_REF,
        factType: "delete",
      };
    }
  }
};

const reconstructPatchedDocument = (
  engine: Engine,
  options: {
    id: EntityId;
    branch: BranchName;
    seq: number;
  },
): EntityDocument => {
  const { id, branch, seq } = options;
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    seq,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    seq,
  }) as SnapshotRow | undefined;

  let baseSeq = 0;
  let document = emptyEntityDocument();
  if (snapshotRow && (!baseRow || snapshotRow.seq >= baseRow.seq)) {
    baseSeq = snapshotRow.seq;
    document = normalizeEntityDocument(
      JSON.parse(snapshotRow.data ?? "null") as JSONValue,
    );
  } else if (baseRow) {
    baseSeq = baseRow.seq;
    if (baseRow.fact_type === "set") {
      document = normalizeEntityDocument(
        JSON.parse(baseRow.data ?? "null") as JSONValue,
      );
    }
  }

  const patches = engine.statements.selectPatches.all({
    branch,
    id,
    base_seq: baseSeq,
    seq,
  }) as PatchRow[];

  for (const patch of patches) {
    document = applyPatchDocument(
      document,
      JSON.parse(patch.patch_ops) as PatchOp[],
    );
  }

  return document;
};

const materializeSnapshots = (
  engine: Engine,
  branch: BranchName,
  facts: readonly AppliedFact[],
): void => {
  if (engine.snapshotInterval <= 0) {
    return;
  }

  const seen = new Set<string>();
  for (const fact of facts) {
    const key = headKey(branch, fact.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    maybeMaterializeSnapshot(engine, branch, fact.id);
  }
};

const maybeMaterializeSnapshot = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
): void => {
  const state = readState(engine, { id, branch });
  if (state === null || state.document === null || state.factType !== "patch") {
    return;
  }

  const baseSeq = latestMaterializationSeq(engine, branch, id, state.seq);
  const patchCount = (
    engine.statements.selectPatchCount.get({
      branch,
      id,
      after_seq: baseSeq,
      seq: state.seq,
    }) as { count: number }
  ).count;

  if (patchCount < engine.snapshotInterval) {
    return;
  }

  const valueRef = toReference(state.document);
  engine.statements.insertValue.run({
    hash: valueRef,
    data: JSON.stringify(state.document),
  });
  engine.statements.insertSnapshot.run({
    id,
    seq: state.seq,
    value_ref: valueRef,
    branch,
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
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    seq,
  }) as SnapshotRow | undefined;

  return Math.max(baseRow?.seq ?? 0, snapshotRow?.seq ?? 0);
};

const applyPatchDocument = (
  document: EntityDocument,
  patches: PatchOp[],
): EntityDocument => {
  return {
    ...document,
    value: applyPatch(document.value ?? {}, patches),
  };
};

const normalizeEntityDocument = (
  value: JSONValue | EntityDocument,
): EntityDocument => {
  return isEntityDocument(value) ? value : { value };
};

const emptyEntityDocument = (): EntityDocument => ({ value: {} });

const isEntityDocument = (
  value: JSONValue | EntityDocument,
): value is EntityDocument => {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (
      Object.hasOwn(value, "value") ||
      (
        Object.hasOwn(value, "source") &&
        isSourceLink((value as { source?: unknown }).source)
      )
    );
};

export const hashBlobBytes = (value: Uint8Array): Reference => {
  return fromDigest(sha256(value)).toString() as Reference;
};

const emptyReferenceFor = (id: EntityId): Reference => {
  return toReference({ id });
};

const headKey = (branch: BranchName, id: EntityId): string =>
  `${branch}\0${id}`;

const toReference = (value: unknown): Reference => {
  return refer(value as NonNullable<unknown> | null).toString() as Reference;
};

const toDatabaseAddress = (url: URL): URL | string => {
  return url.protocol === "file:" ? url : ":memory:";
};
