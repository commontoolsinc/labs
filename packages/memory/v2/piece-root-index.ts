import { Database } from "@db/sqlite";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { hashOf } from "@commonfabric/data-model/value-hash";
import type { CellScope, FabricValue } from "@commonfabric/api";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { patchOpChangesParentKeySet, touchedPointerPaths } from "./patch.ts";
import { isPrefixPath, pathsOverlap } from "./path.ts";
import type {
  BranchName,
  EntityDocument,
  EntityId,
  PatchOp,
  PieceRootCursor,
  PieceRootEntry,
} from "../v2.ts";
import { decodeMemoryBoundary } from "../v2.ts";

const DEFAULT_BRANCH = "";
const SPACE_SCOPE_KEY = "space";
const INDEX_VERSION = 9;
const REBUILD_PAGE_SIZE = 256;
const CATCH_UP_PAGE_SIZE = 256;
const DEPENDENT_ROOT_MERGE_BUFFER_SIZE = 8_192;
const NAME = "$NAME";
const DEFAULT_APP_PATTERN_SOURCE = "/api/patterns/system/default-app.tsx";
const MAX_LINK_RESOLUTION_HOPS = 100;
const pieceRootOrderEncoder = new TextEncoder();

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
};

type ReadDocument = (address: {
  branch: BranchName;
  id: EntityId;
  scopeKey: string;
}) => EntityDocument | null;

export type PieceRootIndexAddress = {
  branch: BranchName;
  id: EntityId;
  scopeKey: string;
};

export type PieceRootIndexChange = PieceRootIndexAddress & {
  document?: EntityDocument | null;
  patches?: readonly PatchOp[];
};

type StoredAddress = PieceRootIndexAddress & {
  space: string;
  path: string[];
};

type RegistryDependencyKind =
  | "control"
  | "default"
  | "link"
  | "terminal"
  | "unresolved";

type RegistryDependency = {
  address: StoredAddress;
  kind: RegistryDependencyKind;
};

type PieceRootRow = {
  id: EntityId;
  canonical_id: string;
  order_key: string;
  scope_key: string;
  name: string | null;
  pattern_identity: string | null;
  pattern_symbol: string | null;
  pattern_repository: string | null;
  pattern_source: string | null;
  pattern_entry: string | null;
  registry_position: number | null;
  scope_rank: number;
};

export type IndexedPieceRoot = {
  entry: PieceRootEntry;
  cursor: PieceRootCursor;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const taggedHash = (cause: string): string =>
  hashOf({ causal: cause }).taggedHashString;

const entityIdForCause = (cause: string): EntityId => `of:${taggedHash(cause)}`;

const scopeFromKey = (scopeKey: string): CellScope => {
  if (scopeKey.startsWith("session:")) return "session";
  if (scopeKey.startsWith("user:")) return "user";
  return "space";
};

const canonicalPieceId = (id: EntityId): string => {
  if (id.startsWith("of:")) return id.slice("of:".length);
  if (id.startsWith("computed:")) return id.slice("computed:".length);
  if (id.startsWith("data:")) return hashOf(id).toString();
  return id;
};

const pieceRootEntityKind = (
  id: EntityId,
): PieceRootEntry["entityKind"] | undefined =>
  id.startsWith("of:")
    ? undefined
    : id.includes(":")
    ? id.slice(0, id.indexOf(":"))
    : "raw";

const pieceRootOrderKey = (id: EntityId): string =>
  toUnpaddedBase64url(sha256(pieceRootOrderEncoder.encode(id)));

const linkSchemaDeclaresStream = (value: unknown): boolean => {
  if (!isLinkRef(value)) return false;
  const payload = linkRefPayload(value);
  if (!isRecord(payload) || !isRecord(payload.schema)) return false;
  const asCell = payload.schema.asCell;
  return Array.isArray(asCell) && asCell.at(0) === "stream";
};

const userScopeKeyFromSession = (scopeKey: string): string | undefined => {
  if (!scopeKey.startsWith("session:")) return undefined;
  const parts = scopeKey.split(":");
  return parts.length === 3 ? `user:${parts[1]}` : undefined;
};

const scopeKeyForLink = (
  scope: unknown,
  baseScopeKey: string,
): string | undefined => {
  if (scope === undefined || scope === "inherit") return baseScopeKey;
  if (scope === "space") return SPACE_SCOPE_KEY;
  if (scope === "user") {
    if (baseScopeKey.startsWith("user:")) return baseScopeKey;
    return userScopeKeyFromSession(baseScopeKey);
  }
  if (scope === "session") {
    return baseScopeKey.startsWith("session:") ? baseScopeKey : undefined;
  }
  return undefined;
};

const linkAddress = (
  value: unknown,
  base: StoredAddress,
): StoredAddress | undefined => {
  if (!isLinkRef(value)) return undefined;
  const payload = linkRefPayload(value);
  if (!isRecord(payload)) return undefined;
  const id = payload.id === undefined
    ? base.id
    : typeof payload.id === "string" && payload.id.length > 0
    ? payload.id
    : undefined;
  const space = payload.space === undefined
    ? base.space
    : typeof payload.space === "string" && payload.space.length > 0
    ? payload.space
    : undefined;
  const scopeKey = scopeKeyForLink(payload.scope, base.scopeKey);
  const path = payload.path === undefined ? [] : Array.isArray(payload.path) &&
      payload.path.every((part) => typeof part === "string")
    ? payload.path
    : undefined;
  if (
    id === undefined || space === undefined || scopeKey === undefined ||
    path === undefined
  ) {
    return undefined;
  }
  return {
    branch: base.branch,
    id: id as EntityId,
    scopeKey,
    space,
    path,
  };
};

const isStructurallyValidLink = (value: unknown): boolean => {
  if (!isLinkRef(value)) return false;
  const payload = linkRefPayload(value);
  if (!isRecord(payload)) return false;
  return (payload.id === undefined ||
    (typeof payload.id === "string" && payload.id.length > 0)) &&
    (payload.space === undefined ||
      (typeof payload.space === "string" && payload.space.length > 0)) &&
    (payload.scope === undefined ||
      payload.scope === "inherit" ||
      payload.scope === "space" ||
      payload.scope === "user" ||
      payload.scope === "session") &&
    (payload.path === undefined ||
      (Array.isArray(payload.path) &&
        payload.path.every((part) => typeof part === "string")));
};

const addressKey = (address: PieceRootIndexAddress): string =>
  JSON.stringify([address.branch, address.id, address.scopeKey]);

const resolutionKey = (address: StoredAddress): string =>
  JSON.stringify([
    address.branch,
    address.id,
    address.scopeKey,
    address.path,
  ]);

const valueAtPath = (
  value: FabricValue | undefined,
  path: readonly string[],
): {
  value: unknown;
  consumed: number;
} => {
  let current: unknown = value;
  let consumed = 0;
  while (consumed < path.length) {
    if (isLinkRef(current)) break;
    if (!isRecord(current) && !Array.isArray(current)) {
      return { value: undefined, consumed: path.length };
    }
    current = (current as Record<string, unknown>)[path[consumed]];
    consumed++;
  }
  return { value: current, consumed };
};

const resolveStoredValue = (
  start: StoredAddress,
  readDocument: ReadDocument,
  dependencies: Map<string, PieceRootIndexAddress>,
  registryDependencies?: Map<string, RegistryDependency>,
): {
  address: StoredAddress;
  value: unknown;
  resolved: boolean;
  streamTyped: boolean;
} => {
  let address = start;
  const seen = new Set<string>();
  let hops = 0;
  let streamTyped = false;

  for (;;) {
    if (hops++ >= MAX_LINK_RESOLUTION_HOPS) {
      return { address, value: undefined, resolved: false, streamTyped };
    }
    const key = resolutionKey(address);
    if (seen.has(key)) {
      return { address, value: undefined, resolved: false, streamTyped };
    }
    seen.add(key);
    dependencies.set(addressKey(address), {
      branch: address.branch,
      id: address.id,
      scopeKey: address.scopeKey,
    });

    const document = readDocument(address);
    if (document === null) {
      registryDependencies?.set(key, {
        address,
        kind: "unresolved",
      });
      return { address, value: undefined, resolved: false, streamTyped };
    }
    const result = valueAtPath(document.value, address.path);
    streamTyped ||= linkSchemaDeclaresStream(result.value);
    const target = linkAddress(result.value, address);
    if (target === undefined) {
      const dependencyAddress = isLinkRef(result.value)
        ? {
          ...address,
          path: address.path.slice(0, result.consumed),
        }
        : address;
      registryDependencies?.set(resolutionKey(dependencyAddress), {
        address: dependencyAddress,
        kind: isLinkRef(result.value) ? "unresolved" : "terminal",
      });
      return { address, value: result.value, resolved: true, streamTyped };
    }
    const sourceAddress = {
      ...address,
      path: address.path.slice(0, result.consumed),
    };
    registryDependencies?.set(resolutionKey(sourceAddress), {
      address: sourceAddress,
      kind: "link",
    });
    if (target.space !== address.space) {
      return {
        address: target,
        value: undefined,
        resolved: false,
        streamTyped,
      };
    }
    const sourcePath = address.path.slice(0, result.consumed);
    const nextAddress = {
      ...target,
      path: [...target.path, ...address.path.slice(result.consumed)],
    };
    if (
      nextAddress.id === address.id &&
      nextAddress.scopeKey === address.scopeKey &&
      nextAddress.path.length > sourcePath.length &&
      sourcePath.every((part, index) => nextAddress.path[index] === part)
    ) {
      return {
        address: nextAddress,
        value: undefined,
        resolved: false,
        streamTyped,
      };
    }
    address = nextAddress;
  }
};

const patternIdentity = (
  document: EntityDocument,
): { identity: string; symbol: string } | undefined => {
  const raw = document.patternIdentity;
  return isRecord(raw) &&
      typeof raw.identity === "string" &&
      typeof raw.symbol === "string"
    ? { identity: raw.identity, symbol: raw.symbol }
    : undefined;
};

const isPieceRoot = (document: EntityDocument): boolean =>
  patternIdentity(document) !== undefined ||
  isStructurallyValidLink(document.argument);

const createSchema = (database: Database): void => {
  database.exec(`
CREATE TABLE IF NOT EXISTS pragma_piece_root (
  id                  TEXT    NOT NULL,
  canonical_id        TEXT    NOT NULL,
  order_key           TEXT    NOT NULL,
  scope_key           TEXT    NOT NULL,
  name                TEXT,
  pattern_identity    TEXT,
  pattern_symbol      TEXT,
  pattern_repository  TEXT,
  pattern_source      TEXT,
  pattern_entry       TEXT,
  registry_position   INTEGER,
  PRIMARY KEY (id, scope_key)
)
WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_piece_root_registry_position
  ON pragma_piece_root (registry_position)
  WHERE registry_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_piece_root_unregistered_scope_listing
  ON pragma_piece_root (
    scope_key,
    canonical_id,
    order_key
  )
  WHERE registry_position IS NULL;

CREATE TABLE IF NOT EXISTS pragma_piece_root_dependency (
  piece_id               TEXT NOT NULL,
  piece_scope_key        TEXT NOT NULL,
  dependency_id          TEXT NOT NULL,
  dependency_scope_key   TEXT NOT NULL,
  PRIMARY KEY (
    piece_id,
    piece_scope_key,
    dependency_id,
    dependency_scope_key
  )
)
WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_piece_root_dependency_target
  ON pragma_piece_root_dependency (
    dependency_id,
    dependency_scope_key
  );

CREATE TABLE IF NOT EXISTS pragma_piece_registry_dependency (
  dependency_id         TEXT NOT NULL,
  dependency_scope_key  TEXT NOT NULL,
  dependency_path       TEXT NOT NULL,
  dependency_kind       TEXT NOT NULL,
  PRIMARY KEY (
    dependency_id,
    dependency_scope_key,
    dependency_path
  )
)
WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pragma_piece_root_index_state (
  singleton           INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  version             INTEGER NOT NULL,
  indexed_commit_seq  INTEGER,
  registry_space      TEXT,
  registry_id         TEXT,
  registry_scope_key  TEXT,
  registry_path       TEXT,
  registry_length     INTEGER
);
`);
};

const hasColumn = (
  database: Database,
  table: string,
  column: string,
): boolean =>
  (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string }
  >).some((entry) => entry.name === column);

const migrateSchema = (database: Database): void => {
  database.exec(`
DROP TABLE IF EXISTS piece_root_dependency;
DROP TABLE IF EXISTS piece_registry_dependency;
DROP TABLE IF EXISTS piece_root;
DROP TABLE IF EXISTS piece_root_index_state;
DROP INDEX IF EXISTS idx_piece_root_listing;
DROP INDEX IF EXISTS idx_piece_root_unregistered_listing;
DROP INDEX IF EXISTS idx_piece_root_scope;
DROP INDEX IF EXISTS idx_piece_registry_dependency_target;
`);
  const hasPieceRoot = database.prepare(`
SELECT 1 AS present
FROM sqlite_master
WHERE type = 'table' AND name = 'pragma_piece_root'
`).get() !== undefined;
  const pieceRootSchema = database.prepare(`
SELECT sql
FROM sqlite_master
WHERE type = 'table' AND name = 'pragma_piece_root'
`).get() as { sql: string } | undefined;
  if (
    hasPieceRoot &&
    (
      hasColumn(database, "pragma_piece_root", "branch") ||
      !pieceRootSchema?.sql.includes("WITHOUT ROWID")
    )
  ) {
    database.exec(`
DROP TABLE IF EXISTS pragma_piece_root_dependency;
DROP TABLE IF EXISTS pragma_piece_registry_dependency;
DROP TABLE IF EXISTS pragma_piece_root;
DROP TABLE IF EXISTS pragma_piece_root_index_state;
`);
    return;
  }
  if (
    hasPieceRoot && !hasColumn(database, "pragma_piece_root", "canonical_id")
  ) {
    database.exec(`ALTER TABLE pragma_piece_root ADD COLUMN canonical_id TEXT`);
  }
  if (hasPieceRoot && !hasColumn(database, "pragma_piece_root", "order_key")) {
    database.exec(`ALTER TABLE pragma_piece_root ADD COLUMN order_key TEXT`);
  }
  const hasRegistryDependency = database.prepare(`
SELECT 1 AS present
FROM sqlite_master
WHERE type = 'table' AND name = 'pragma_piece_registry_dependency'
`).get() !== undefined;
  if (
    hasRegistryDependency &&
    (
      !hasColumn(
        database,
        "pragma_piece_registry_dependency",
        "dependency_path",
      ) ||
      !hasColumn(
        database,
        "pragma_piece_registry_dependency",
        "dependency_kind",
      )
    )
  ) {
    database.exec(`DROP TABLE pragma_piece_registry_dependency`);
  }
  const hasState = database.prepare(`
SELECT 1 AS present
FROM sqlite_master
WHERE type = 'table' AND name = 'pragma_piece_root_index_state'
`).get() !== undefined;
  for (
    const [column, type] of [
      ["indexed_commit_seq", "INTEGER"],
      ["registry_id", "TEXT"],
      ["registry_scope_key", "TEXT"],
      ["registry_path", "TEXT"],
      ["registry_length", "INTEGER"],
    ] as const
  ) {
    if (
      hasState && !hasColumn(database, "pragma_piece_root_index_state", column)
    ) {
      database.exec(
        `ALTER TABLE pragma_piece_root_index_state ADD COLUMN ${column} ${type}`,
      );
    }
  }
};

type PieceRootIndexState = {
  version: number;
  indexed_commit_seq: number | null;
  registry_space: string | null;
  registry_id: EntityId | null;
  registry_scope_key: string | null;
  registry_path: string | null;
  registry_length: number | null;
};

const indexState = (
  database: Database,
): PieceRootIndexState | undefined =>
  database.prepare(`
SELECT
  version,
  indexed_commit_seq,
  registry_space,
  registry_id,
  registry_scope_key,
  registry_path,
  registry_length
FROM pragma_piece_root_index_state
WHERE singleton = 1
`).get() as PieceRootIndexState | undefined;

const currentCommitSeq = (database: Database): number =>
  (database.prepare(`
SELECT COALESCE(MAX(seq), 0) AS seq
FROM "commit"
`).get() as { seq: number }).seq;

export const pieceRootIndexIsCurrent = (
  database: Database,
  {
    space,
    targetCommitSeq = currentCommitSeq(database),
  }: {
    space?: string;
    targetCommitSeq?: number;
  } = {},
): boolean => {
  const state = indexState(database);
  const indexSpace = space ?? state?.registry_space ?? "";
  return state?.version === INDEX_VERSION &&
    state.indexed_commit_seq === targetCommitSeq &&
    state.registry_space === indexSpace;
};

const markCommitIndexed = (
  database: Database,
  indexedCommitSeq: number,
): void => {
  database.prepare(`
UPDATE pragma_piece_root_index_state
SET indexed_commit_seq = :indexed_commit_seq
WHERE singleton = 1
`).run({ indexed_commit_seq: indexedCommitSeq });
};

const addressPairsJson = (
  addresses: readonly PieceRootIndexAddress[],
): string =>
  JSON.stringify(
    [...new Map(addresses.map((address) => [
      addressKey(address),
      [address.id, address.scopeKey],
    ])).values()],
  );

type PreparedStatement = ReturnType<Database["prepare"]>;

type PieceRootStatements = {
  deleteDependencies: PreparedStatement;
  deleteRoot: PreparedStatement;
  firstDependentRootPage: PreparedStatement;
  insertDependency: PreparedStatement;
  nextDependentRootPage: PreparedStatement;
  upsertRoot: PreparedStatement;
};

const preparePieceRootStatements = (
  database: Database,
): PieceRootStatements => ({
  deleteDependencies: database.prepare(`
DELETE FROM pragma_piece_root_dependency
WHERE piece_id = :id
  AND piece_scope_key = :scope_key
`),
  deleteRoot: database.prepare(`
DELETE FROM pragma_piece_root
WHERE id = :id
  AND scope_key = :scope_key
`),
  firstDependentRootPage: database.prepare(`
SELECT piece_id, piece_scope_key
FROM pragma_piece_root_dependency AS dependency
  INDEXED BY idx_piece_root_dependency_target
WHERE dependency_id = :dependency_id
  AND dependency_scope_key = :dependency_scope_key
  AND (
    :exclude_pending_roots = 0 OR
    NOT EXISTS (
      SELECT 1
      FROM head AS pending_root
      WHERE pending_root.branch = :branch
        AND pending_root.id = dependency.piece_id
        AND pending_root.scope_key = dependency.piece_scope_key
        AND pending_root.seq > :after_seq
        AND pending_root.seq <= :target_seq
    )
  )
ORDER BY piece_id, piece_scope_key
LIMIT :limit
`),
  insertDependency: database.prepare(`
INSERT OR IGNORE INTO pragma_piece_root_dependency (
  piece_id,
  piece_scope_key,
  dependency_id,
  dependency_scope_key
)
VALUES (
  :piece_id,
  :piece_scope_key,
  :dependency_id,
  :dependency_scope_key
)
`),
  nextDependentRootPage: database.prepare(`
SELECT piece_id, piece_scope_key
FROM pragma_piece_root_dependency AS dependency
  INDEXED BY idx_piece_root_dependency_target
WHERE dependency_id = :dependency_id
  AND dependency_scope_key = :dependency_scope_key
  AND (
    :exclude_pending_roots = 0 OR
    NOT EXISTS (
      SELECT 1
      FROM head AS pending_root
      WHERE pending_root.branch = :branch
        AND pending_root.id = dependency.piece_id
        AND pending_root.scope_key = dependency.piece_scope_key
        AND pending_root.seq > :after_seq
        AND pending_root.seq <= :target_seq
    )
  )
  AND (piece_id, piece_scope_key) > (:after_id, :after_scope_key)
ORDER BY piece_id, piece_scope_key
LIMIT :limit
`),
  upsertRoot: database.prepare(`
INSERT INTO pragma_piece_root (
  id,
  canonical_id,
  order_key,
  scope_key,
  name,
  pattern_identity,
  pattern_symbol,
  pattern_repository,
  pattern_source,
  pattern_entry,
  registry_position
)
VALUES (
  :id,
  :canonical_id,
  :order_key,
  :scope_key,
  :name,
  :pattern_identity,
  :pattern_symbol,
  :pattern_repository,
  :pattern_source,
  :pattern_entry,
  :registry_position
)
ON CONFLICT (id, scope_key) DO UPDATE SET
  canonical_id = excluded.canonical_id,
  order_key = excluded.order_key,
  name = excluded.name,
  pattern_identity = excluded.pattern_identity,
  pattern_symbol = excluded.pattern_symbol,
  pattern_repository = excluded.pattern_repository,
  pattern_source = excluded.pattern_source,
  pattern_entry = excluded.pattern_entry
`),
});

const finalizePieceRootStatements = (
  statements: PieceRootStatements,
): void => {
  for (const statement of Object.values(statements)) {
    statement.finalize();
  }
};

const deletePieceRoot = (
  statements: PieceRootStatements,
  address: PieceRootIndexAddress,
): void => {
  const parameters = {
    id: address.id,
    scope_key: address.scopeKey,
  };
  statements.deleteDependencies.run(parameters);
  statements.deleteRoot.run(parameters);
};

const insertDependencies = (
  statements: PieceRootStatements,
  root: PieceRootIndexAddress,
  dependencies: Iterable<PieceRootIndexAddress>,
): void => {
  for (const dependency of dependencies) {
    statements.insertDependency.run({
      piece_id: root.id,
      piece_scope_key: root.scopeKey,
      dependency_id: dependency.id,
      dependency_scope_key: dependency.scopeKey,
    });
  }
};

const refreshRoot = (
  statements: PieceRootStatements,
  root: PieceRootIndexAddress,
  space: string,
  readDocument: ReadDocument,
  knownDocument?: EntityDocument | null,
): boolean => {
  const address: StoredAddress = {
    ...root,
    space,
    path: [],
  };
  const document = knownDocument === undefined
    ? readDocument(root)
    : knownDocument;
  if (document === null || !isPieceRoot(document)) {
    return false;
  }

  const dependencies = new Map<string, PieceRootIndexAddress>();
  const readSummaryDocument: ReadDocument = (candidate) =>
    addressKey(candidate) === addressKey(root)
      ? document
      : readDocument(candidate);
  const resolvedName = resolveStoredValue(
    { ...address, path: [NAME] },
    readSummaryDocument,
    dependencies,
  ).value;
  const name = typeof resolvedName === "string" ? resolvedName : null;
  const pattern = patternIdentity(document);
  const repository = typeof document.patternRepository === "string"
    ? document.patternRepository
    : null;
  const source = typeof document.patternSource === "string"
    ? document.patternSource
    : null;

  let entry: string | null = null;
  if (pattern !== undefined) {
    const sourceAddress = {
      branch: root.branch,
      id: entityIdForCause(`pattern:${pattern.identity}`),
      scopeKey: SPACE_SCOPE_KEY,
    };
    dependencies.set(addressKey(sourceAddress), sourceAddress);
    const sourceDocument = readSummaryDocument(sourceAddress);
    const sourceValue = sourceDocument?.value;
    if (
      isRecord(sourceValue) &&
      sourceValue.kind === "source" &&
      sourceValue.identity === pattern.identity &&
      typeof sourceValue.filename === "string"
    ) {
      entry = sourceValue.filename;
    }
  }

  statements.upsertRoot.run({
    id: root.id,
    canonical_id: canonicalPieceId(root.id),
    order_key: pieceRootOrderKey(root.id),
    scope_key: root.scopeKey,
    name,
    pattern_identity: pattern?.identity ?? null,
    pattern_symbol: pattern?.symbol ?? null,
    pattern_repository: repository,
    pattern_source: source,
    pattern_entry: entry,
    registry_position: null,
  });

  statements.deleteDependencies.run({
    id: root.id,
    scope_key: root.scopeKey,
  });
  dependencies.delete(addressKey(root));
  insertDependencies(statements, root, dependencies.values());
  return true;
};

const parseStoredPath = (value: string): string[] | undefined => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) &&
        parsed.every((part) => typeof part === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const registryNeedsRefresh = (
  database: Database,
  changes: readonly PieceRootIndexChange[],
  readDocument: ReadDocument,
): boolean => {
  const firstPage = database.prepare(`
SELECT dependency_path, dependency_kind
FROM pragma_piece_registry_dependency
WHERE dependency_id = :dependency_id
  AND dependency_scope_key = :dependency_scope_key
ORDER BY dependency_path
LIMIT :limit
`);
  const nextPage = database.prepare(`
SELECT dependency_path, dependency_kind
FROM pragma_piece_registry_dependency
WHERE dependency_id = :dependency_id
  AND dependency_scope_key = :dependency_scope_key
  AND dependency_path > :after_path
ORDER BY dependency_path
LIMIT :limit
`);
  type DependencyRow = {
    dependency_path: string;
    dependency_kind: RegistryDependencyKind;
  };
  try {
    for (const change of changes) {
      const patches = change.patches;
      const touched = patches?.map((patch) => ({
        patch,
        paths: touchedPointerPaths(patch),
      }));
      const touchesRootClassification = touched?.some(({ paths }) =>
        paths.some((path) =>
          pathsOverlap(["patternIdentity"], path) ||
          pathsOverlap(["argument"], path)
        )
      ) ?? false;
      const touchesDefaultPatternSource = touched?.some(({ paths }) =>
        paths.some((path) =>
          pathsOverlap(["patternSource"], path)
        )
      ) ?? false;
      let afterPath: string | undefined;
      let currentDocument = change.document;
      let readCurrentDocument = currentDocument !== undefined;
      for (;;) {
        const rows = (afterPath === undefined ? firstPage : nextPage).all({
          dependency_id: change.id,
          dependency_scope_key: change.scopeKey,
          limit: CATCH_UP_PAGE_SIZE,
          ...(afterPath === undefined ? {} : { after_path: afterPath }),
        }) as DependencyRow[];
        if (rows.length === 0) break;
        if (change.document === null || patches === undefined) return true;
        if (touchesRootClassification) return true;
        for (const dependency of rows) {
          if (
            dependency.dependency_kind === "default" &&
            touchesDefaultPatternSource
          ) {
            return true;
          }
          const dependencyPath = parseStoredPath(dependency.dependency_path);
          if (
            dependencyPath === undefined ||
            (dependency.dependency_kind !== "control" &&
              dependency.dependency_kind !== "default" &&
              dependency.dependency_kind !== "link" &&
              dependency.dependency_kind !== "terminal" &&
              dependency.dependency_kind !== "unresolved")
          ) {
            return true;
          }
          const documentPath = ["value", ...dependencyPath];
          let terminalTraversalMayHaveChanged = false;
          for (const { patch, paths } of touched!) {
            for (const touchedPath of paths) {
              if (dependency.dependency_kind !== "terminal") {
                if (pathsOverlap(documentPath, touchedPath)) {
                  return true;
                }
                const parentPath = touchedPath.slice(0, -1);
                if (
                  parentPath.length > 0 &&
                  patchOpChangesParentKeySet(patch) &&
                  isPrefixPath(parentPath, documentPath)
                ) {
                  return true;
                }
                continue;
              }
              if (isPrefixPath(touchedPath, documentPath)) {
                return true;
              }
              const parentPath = touchedPath.slice(0, -1);
              if (
                parentPath.length > 0 &&
                parentPath.length < documentPath.length &&
                patchOpChangesParentKeySet(patch) &&
                isPrefixPath(parentPath, documentPath)
              ) {
                return true;
              }
              terminalTraversalMayHaveChanged ||= touchedPath.at(0) === "value";
            }
          }
          if (terminalTraversalMayHaveChanged) {
            if (!readCurrentDocument) {
              currentDocument = readDocument(change);
              readCurrentDocument = true;
            }
            if (
              currentDocument === undefined ||
              currentDocument === null ||
              isLinkRef(
                valueAtPath(currentDocument.value, dependencyPath).value,
              )
            ) {
              return true;
            }
          }
        }
        afterPath = rows.at(-1)!.dependency_path;
        if (rows.length < CATCH_UP_PAGE_SIZE) break;
      }
    }
    return false;
  } finally {
    firstPage.finalize();
    nextPage.finalize();
  }
};

const changedRegistryDependencyAddresses = (
  database: Database,
  changes: readonly PieceRootIndexChange[],
): PieceRootIndexAddress[] => {
  if (changes.length === 0) return [];
  const rows = database.prepare(`
SELECT
  dependency.dependency_id,
  dependency.dependency_scope_key
FROM json_each(:changes) AS changed
CROSS JOIN pragma_piece_registry_dependency AS dependency
WHERE dependency.dependency_id = changed.value ->> 0
  AND dependency.dependency_scope_key = changed.value ->> 1
GROUP BY dependency.dependency_id, dependency.dependency_scope_key
`).all({
      changes: addressPairsJson(changes),
    }) as Array<{
      dependency_id: EntityId;
      dependency_scope_key: string;
    }>;
  return rows.map((row) => ({
    branch: DEFAULT_BRANCH,
    id: row.dependency_id,
    scopeKey: row.dependency_scope_key,
  }));
};

const rebuildRegistry = (
  database: Database,
  space: string,
  readDocument: ReadDocument,
  indexedCommitSeq: number,
): void => {
  const dependencies = new Map<string, PieceRootIndexAddress>();
  const registryDependencies = new Map<string, RegistryDependency>();
  const controlDependencies: StoredAddress[] = [];
  const spaceCell = {
    branch: DEFAULT_BRANCH,
    id: entityIdForCause(space),
    scopeKey: SPACE_SCOPE_KEY,
    space,
    path: ["defaultPattern"],
  } satisfies StoredAddress;
  const defaultPattern = resolveStoredValue(
    spaceCell,
    readDocument,
    dependencies,
    registryDependencies,
  );

  const registryAt = (key: "pieceRegistry" | "allPieces" | "addPiece") => {
    const address = {
      ...defaultPattern.address,
      path: [...defaultPattern.address.path, key],
    };
    return !defaultPattern.resolved || defaultPattern.address.space !== space
      ? { address, value: undefined, resolved: false, streamTyped: false }
      : resolveStoredValue(
        address,
        readDocument,
        dependencies,
        registryDependencies,
      );
  };
  let registry = registryAt("pieceRegistry");
  if (!Array.isArray(registry.value)) {
    const pieceRegistryDependency = registryDependencies.get(
      resolutionKey(registry.address),
    );
    if (pieceRegistryDependency?.kind === "terminal") {
      controlDependencies.push(registry.address);
    }
    const allPieces = registryAt("allPieces");
    const addPiece = registryAt("addPiece");
    const addPieceDependency = registryDependencies.get(
      resolutionKey(addPiece.address),
    );
    if (addPieceDependency?.kind === "terminal") {
      controlDependencies.push(addPiece.address);
    }
    const defaultDocument = defaultPattern.resolved
      ? readDocument(defaultPattern.address)
      : null;
    const rawPieceRegistry = defaultDocument === null
      ? undefined
      : valueAtPath(defaultDocument.value, [
        ...defaultPattern.address.path,
        "pieceRegistry",
      ]).value;
    const source = defaultDocument?.patternSource;
    const legacyRegistryEligible = defaultPattern.resolved &&
      defaultDocument !== null &&
      patternIdentity(defaultDocument) !== undefined &&
      (source === undefined || source === DEFAULT_APP_PATTERN_SOURCE) &&
      rawPieceRegistry === undefined &&
      allPieces.resolved &&
      Array.isArray(allPieces.value) &&
      (addPiece.streamTyped ||
        (addPiece.resolved &&
          isRecord(addPiece.value) &&
          addPiece.value.$stream === true));
    if (legacyRegistryEligible) {
      registry = allPieces;
    }
  }

  database.prepare(`
UPDATE pragma_piece_root
SET registry_position = NULL
WHERE registry_position IS NOT NULL
`).run();

  database.prepare(`
DELETE FROM pragma_piece_registry_dependency
`).run();
  const insertDependency = database.prepare(`
INSERT INTO pragma_piece_registry_dependency (
  dependency_id,
  dependency_scope_key,
  dependency_path,
  dependency_kind
)
VALUES (
  :dependency_id,
  :dependency_scope_key,
  :dependency_path,
  :dependency_kind
)
ON CONFLICT (
  dependency_id,
  dependency_scope_key,
  dependency_path
) DO UPDATE SET dependency_kind = excluded.dependency_kind
`);
  const writeDependencies = (
    pending: Iterable<RegistryDependency>,
  ): void => {
    for (const dependency of pending) {
      insertDependency.run({
        dependency_id: dependency.address.id,
        dependency_scope_key: dependency.address.scopeKey,
        dependency_path: JSON.stringify(dependency.address.path),
        dependency_kind: dependency.kind,
      });
    }
  };
  let update: PreparedStatement | undefined;
  try {
    writeDependencies(registryDependencies.values());

    if (Array.isArray(registry.value)) {
      update = database.prepare(`
UPDATE pragma_piece_root
SET registry_position = :registry_position
WHERE id = :id
  AND scope_key = :scope_key
  AND registry_position IS NULL
`);
      for (const [position, item] of registry.value.entries()) {
        const target = linkAddress(item, registry.address);
        if (target === undefined || target.space !== space) continue;
        const itemDependencies = new Map<string, PieceRootIndexAddress>();
        const itemRegistryDependencies = new Map<
          string,
          RegistryDependency
        >();
        const resolved = resolveStoredValue(
          target,
          readDocument,
          itemDependencies,
          itemRegistryDependencies,
        );
        writeDependencies(itemRegistryDependencies.values());
        const canonical = resolved.address;
        if (
          !resolved.resolved ||
          canonical.space !== space ||
          canonical.scopeKey !== SPACE_SCOPE_KEY
        ) {
          continue;
        }
        update.run({
          id: canonical.id,
          scope_key: SPACE_SCOPE_KEY,
          registry_position: position,
        });
      }
    }
    const finalDependencies = new Map<string, RegistryDependency>();
    for (const address of controlDependencies) {
      finalDependencies.set(resolutionKey(address), {
        address,
        kind: "control",
      });
    }
    if (defaultPattern.resolved && defaultPattern.address.space === space) {
      finalDependencies.set(resolutionKey(defaultPattern.address), {
        address: defaultPattern.address,
        kind: "default",
      });
    }
    writeDependencies(finalDependencies.values());
  } finally {
    update?.finalize();
    insertDependency.finalize();
  }
  const indexedRegistry = registry.resolved &&
      registry.address.space === space &&
      Array.isArray(registry.value)
    ? { address: registry.address, length: registry.value.length }
    : undefined;
  database.prepare(`
INSERT INTO pragma_piece_root_index_state (
  singleton,
  version,
  indexed_commit_seq,
  registry_space,
  registry_id,
  registry_scope_key,
  registry_path,
  registry_length
)
VALUES (
  1,
  :version,
  :indexed_commit_seq,
  :registry_space,
  :registry_id,
  :registry_scope_key,
  :registry_path,
  :registry_length
)
ON CONFLICT (singleton) DO UPDATE SET
  version = excluded.version,
  indexed_commit_seq = excluded.indexed_commit_seq,
  registry_space = excluded.registry_space,
  registry_id = excluded.registry_id,
  registry_scope_key = excluded.registry_scope_key,
  registry_path = excluded.registry_path,
  registry_length = excluded.registry_length
`).run({
      version: INDEX_VERSION,
      indexed_commit_seq: indexedCommitSeq,
      registry_space: space,
      registry_id: indexedRegistry?.address.id ?? null,
      registry_scope_key: indexedRegistry?.address.scopeKey ?? null,
      registry_path: indexedRegistry === undefined
        ? null
        : JSON.stringify(indexedRegistry.address.path),
      registry_length: indexedRegistry?.length ?? null,
    });
};

const jsonPointer = (parts: readonly string[]): string =>
  `/${
    parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join(
      "/",
    )
  }`;

const isRegistryAppendPatch = (
  patch: PatchOp,
  registryPath: readonly string[],
): boolean =>
  patch.op === "append" &&
  patch.path === jsonPointer(["value", ...registryPath]);

const isRegistryTailPatch = (
  patch: PatchOp,
  registryPath: readonly string[],
): boolean =>
  (patch.op === "append" || patch.op === "add-unique") &&
  patch.path === jsonPointer(["value", ...registryPath]);

const extendRegistry = (
  database: Database,
  {
    changes,
    space,
    readDocument,
  }: {
    changes: readonly PieceRootIndexChange[];
    space: string;
    readDocument: ReadDocument;
  },
): boolean => {
  const state = indexState(database);
  if (
    state?.registry_space !== space ||
    state.registry_id === null ||
    state.registry_scope_key === null ||
    state.registry_path === null ||
    state.registry_length === null ||
    !Number.isSafeInteger(state.registry_length) ||
    state.registry_length < 0
  ) {
    return false;
  }
  const registryPath = parseStoredPath(state.registry_path)!;
  const registryAddress = {
    branch: DEFAULT_BRANCH,
    id: state.registry_id,
    scopeKey: state.registry_scope_key,
    space,
    path: registryPath,
  } satisfies StoredAddress;
  const hasUnsupportedRegistryDocumentDependency = database.prepare(`
SELECT 1 AS present
FROM pragma_piece_registry_dependency
WHERE dependency_id = :id
  AND dependency_scope_key = :scope_key
  AND dependency_kind <> 'default'
  AND (
    dependency_path <> :registry_path OR
    dependency_kind <> 'terminal'
  )
LIMIT 1
`).get({
      id: registryAddress.id,
      scope_key: registryAddress.scopeKey,
      registry_path: state.registry_path,
    }) !== undefined;
  if (hasUnsupportedRegistryDocumentDependency) {
    return false;
  }
  const patches = changes.flatMap((change) => change.patches!);
  let appendedValues: Iterable<FabricValue>;
  let registryLength: number;
  if (patches.every((patch) => isRegistryAppendPatch(patch, registryPath))) {
    appendedValues = (function* () {
      for (const patch of patches) {
        if (patch.op === "append") yield* patch.values;
      }
    })();
    registryLength = state.registry_length +
      patches.reduce(
        (length, patch) =>
          length + (patch.op === "append" ? patch.values.length : 0),
        0,
      );
  } else {
    const registryChange = changes.at(-1)!;
    const document = registryChange.document === undefined
      ? readDocument(registryAddress)
      : registryChange.document;
    const registry = document === null
      ? undefined
      : valueAtPath(document.value, registryPath).value;
    if (!Array.isArray(registry) || registry.length < state.registry_length) {
      return false;
    }
    appendedValues = (function* () {
      for (
        let index = state.registry_length!;
        index < registry.length;
        index++
      ) {
        yield registry[index];
      }
    })();
    registryLength = registry.length;
  }

  const update = database.prepare(`
UPDATE pragma_piece_root
SET registry_position = :registry_position
WHERE id = :id
  AND scope_key = :scope_key
  AND registry_position IS NULL
`);
  const insertDependency = database.prepare(`
INSERT INTO pragma_piece_registry_dependency (
  dependency_id,
  dependency_scope_key,
  dependency_path,
  dependency_kind
)
VALUES (
  :dependency_id,
  :dependency_scope_key,
  :dependency_path,
  :dependency_kind
)
  ON CONFLICT (
  dependency_id,
  dependency_scope_key,
  dependency_path
) DO UPDATE SET dependency_kind = excluded.dependency_kind
`);
  try {
    let position = state.registry_length;
    for (const value of appendedValues) {
      const target = linkAddress(value, registryAddress);
      if (target === undefined || target.space !== space) {
        position++;
        continue;
      }
      const dependencies = new Map<string, PieceRootIndexAddress>();
      const registryDependencies = new Map<string, RegistryDependency>();
      const resolved = resolveStoredValue(
        target,
        readDocument,
        dependencies,
        registryDependencies,
      );
      for (const dependency of registryDependencies.values()) {
        insertDependency.run({
          dependency_id: dependency.address.id,
          dependency_scope_key: dependency.address.scopeKey,
          dependency_path: JSON.stringify(dependency.address.path),
          dependency_kind: dependency.kind,
        });
      }
      if (
        !resolved.resolved ||
        resolved.address.space !== space ||
        resolved.address.scopeKey !== SPACE_SCOPE_KEY
      ) {
        position++;
        continue;
      }
      update.run({
        id: resolved.address.id,
        scope_key: SPACE_SCOPE_KEY,
        registry_position: position,
      });
      position++;
    }
  } finally {
    update.finalize();
    insertDependency.finalize();
  }
  database.prepare(`
UPDATE pragma_piece_root_index_state
SET registry_length = :registry_length
WHERE singleton = 1
`).run({ registry_length: registryLength });
  return true;
};

const rebuildAllRoots = (
  database: Database,
  space: string,
  readDocument: ReadDocument,
  indexedCommitSeq: number,
  statements: PieceRootStatements,
): void => {
  database.exec(`
DELETE FROM pragma_piece_root_dependency;
DELETE FROM pragma_piece_registry_dependency;
DELETE FROM pragma_piece_root;
`);
  const firstPage = database.prepare(`
SELECT id, scope_key
FROM head
WHERE branch = :branch
  AND op <> 'delete'
ORDER BY id, scope_key
LIMIT :limit
`);
  const nextPage = database.prepare(`
SELECT id, scope_key
FROM head
WHERE branch = :branch
  AND op <> 'delete'
  AND (id, scope_key) > (:after_id, :after_scope_key)
ORDER BY id, scope_key
LIMIT :limit
`);
  type HeadRow = {
    id: EntityId;
    scope_key: string;
  };
  let after: HeadRow | undefined;
  try {
    for (;;) {
      const rows = (after === undefined ? firstPage : nextPage).all({
        branch: DEFAULT_BRANCH,
        limit: REBUILD_PAGE_SIZE,
        ...(after === undefined ? {} : {
          after_id: after.id,
          after_scope_key: after.scope_key,
        }),
      }) as HeadRow[];
      for (const row of rows) {
        refreshRoot(
          statements,
          {
            branch: DEFAULT_BRANCH,
            id: row.id,
            scopeKey: row.scope_key,
          },
          space,
          readDocument,
        );
      }
      after = rows.at(-1);
      if (rows.length < REBUILD_PAGE_SIZE) break;
    }
  } finally {
    firstPage.finalize();
    nextPage.finalize();
  }
  rebuildRegistry(database, space, readDocument, indexedCommitSeq);
};

export const initializePieceRootIndex = (
  database: Database,
): void => {
  migrateSchema(database);
  createSchema(database);
};

const refreshOrDeleteRoot = (
  {
    root,
    space,
    readDocument,
    statements,
    knownDocument,
  }: {
    root: PieceRootIndexAddress;
    space: string;
    readDocument: ReadDocument;
    statements: PieceRootStatements;
    knownDocument?: EntityDocument | null;
  },
): void => {
  if (
    !refreshRoot(
      statements,
      root,
      space,
      readDocument,
      knownDocument,
    )
  ) {
    deletePieceRoot(statements, root);
  }
};

const refreshDirectRoots = (
  {
    changes,
    space,
    readDocument,
    statements,
  }: {
    changes: readonly PieceRootIndexChange[];
    space: string;
    readDocument: ReadDocument;
    statements: PieceRootStatements;
  },
): void => {
  const directChanges = new Map(
    changes.map((change) => [addressKey(change), change]),
  );
  for (const change of directChanges.values()) {
    refreshOrDeleteRoot({
      root: change,
      space,
      readDocument,
      statements,
      knownDocument: change.document,
    });
  }
};

const refreshDependentRoots = (
  {
    changes,
    directChanges,
    afterSeq,
    targetSeq,
    space,
    readDocument,
    statements,
  }: {
    changes: readonly PieceRootIndexChange[];
    directChanges?: readonly PieceRootIndexChange[];
    afterSeq: number;
    targetSeq: number;
    space: string;
    readDocument: ReadDocument;
    statements: PieceRootStatements;
  },
): void => {
  if (changes.length === 0) return;
  const dependencyChanges = new Map(
    changes.map((change) => [addressKey(change), change]),
  );
  const directChangeKeys = new Set(
    directChanges?.map((change) => addressKey(change)) ?? [],
  );
  type DependentRootRow = {
    piece_id: EntityId;
    piece_scope_key: string;
  };
  type DependentRootCursor = {
    change: PieceRootIndexChange;
    rows: DependentRootRow[];
    offset: number;
    after?: DependentRootRow;
    finalPage: boolean;
  };
  const loadDependentRootPage = (
    cursor: DependentRootCursor,
    limit: number,
  ): void => {
    const rows = (
      cursor.after === undefined
        ? statements.firstDependentRootPage
        : statements.nextDependentRootPage
    ).all({
      dependency_id: cursor.change.id,
      dependency_scope_key: cursor.change.scopeKey,
      branch: DEFAULT_BRANCH,
      after_seq: afterSeq,
      target_seq: targetSeq,
      exclude_pending_roots: directChanges === undefined ? 1 : 0,
      limit,
      ...(cursor.after === undefined ? {} : {
        after_id: cursor.after.piece_id,
        after_scope_key: cursor.after.piece_scope_key,
      }),
    }) as DependentRootRow[];
    cursor.rows = rows;
    cursor.offset = 0;
    cursor.after = cursor.rows.at(-1) ?? cursor.after;
    cursor.finalPage = rows.length < limit;
  };
  const cursors: DependentRootCursor[] = [];
  for (const change of dependencyChanges.values()) {
    const cursor: DependentRootCursor = {
      change,
      rows: [],
      offset: 0,
      finalPage: false,
    };
    loadDependentRootPage(cursor, 1);
    if (cursor.rows.length > 0) {
      cursors.push(cursor);
    }
  }
  const dependentPageSize = Math.max(
    1,
    Math.min(
      CATCH_UP_PAGE_SIZE,
      Math.floor(DEPENDENT_ROOT_MERGE_BUFFER_SIZE / cursors.length),
    ),
  );
  const currentRoot = (
    cursor: DependentRootCursor,
  ): DependentRootRow | undefined => {
    if (cursor.offset < cursor.rows.length) {
      return cursor.rows[cursor.offset];
    }
    if (cursor.finalPage) return undefined;
    loadDependentRootPage(cursor, dependentPageSize);
    return cursor.rows[0];
  };
  if (cursors.length === 1) {
    const [cursor] = cursors;
    for (;;) {
      const nextRoot = currentRoot(cursor);
      if (nextRoot === undefined) return;
      cursor.offset++;
      const root = {
        branch: DEFAULT_BRANCH,
        id: nextRoot.piece_id,
        scopeKey: nextRoot.piece_scope_key,
      };
      if (!directChangeKeys.has(addressKey(root))) {
        refreshOrDeleteRoot({ root, space, readDocument, statements });
      }
    }
  }
  type DependentRootHeapEntry = {
    cursor: DependentRootCursor;
    root: DependentRootRow;
    pieceIdOrder: Uint8Array;
    pieceScopeKeyOrder: Uint8Array;
  };
  const heapEntry = (
    cursor: DependentRootCursor,
    root: DependentRootRow,
  ): DependentRootHeapEntry => ({
    cursor,
    root,
    pieceIdOrder: pieceRootOrderEncoder.encode(root.piece_id),
    pieceScopeKeyOrder: pieceRootOrderEncoder.encode(root.piece_scope_key),
  });
  const compareHeapEntries = (
    left: DependentRootHeapEntry,
    right: DependentRootHeapEntry,
  ): number =>
    compareBytes(left.pieceIdOrder, right.pieceIdOrder) ||
    compareBytes(left.pieceScopeKeyOrder, right.pieceScopeKeyOrder);
  const heap: DependentRootHeapEntry[] = [];
  const pushHeap = (entry: DependentRootHeapEntry): void => {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareHeapEntries(heap[parent], entry) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = entry;
  };
  const popHeap = (): DependentRootHeapEntry => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length &&
          compareHeapEntries(heap[right], heap[left]) < 0
        ? right
        : left;
      if (compareHeapEntries(last, heap[child]) <= 0) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
    return first;
  };
  const sameRoot = (
    left: DependentRootRow,
    right: DependentRootRow,
  ): boolean =>
    left.piece_id === right.piece_id &&
    left.piece_scope_key === right.piece_scope_key;
  const advanceCursor = (entry: DependentRootHeapEntry): void => {
    entry.cursor.offset++;
    const root = currentRoot(entry.cursor);
    if (root !== undefined) {
      pushHeap(heapEntry(entry.cursor, root));
    }
  };
  for (const cursor of cursors) {
    const root = currentRoot(cursor);
    if (root !== undefined) {
      pushHeap(heapEntry(cursor, root));
    }
  }

  while (heap.length > 0) {
    const first = popHeap();
    const nextRoot = first.root;
    advanceCursor(first);
    while (heap.length > 0 && sameRoot(heap[0].root, nextRoot)) {
      advanceCursor(popHeap());
    }
    const root = {
      branch: DEFAULT_BRANCH,
      id: nextRoot.piece_id,
      scopeKey: nextRoot.piece_scope_key,
    };
    if (!directChangeKeys.has(addressKey(root))) {
      refreshOrDeleteRoot({ root, space, readDocument, statements });
    }
  }
};

const pendingDependencyTargets = (
  database: Database,
  {
    afterSeq,
    targetSeq,
    limit,
  }: {
    afterSeq: number;
    targetSeq: number;
    limit: number;
  },
): PieceRootIndexChange[] => {
  const statement = database.prepare(`
SELECT pending.id, pending.scope_key
FROM head AS pending INDEXED BY idx_head_branch_sequence
WHERE pending.branch = :branch
  AND pending.seq > :after_seq
  AND pending.seq <= :target_seq
  AND EXISTS (
    SELECT 1
    FROM pragma_piece_root_dependency AS dependency
      INDEXED BY idx_piece_root_dependency_target
    WHERE dependency.dependency_id = pending.id
      AND dependency.dependency_scope_key = pending.scope_key
      AND NOT EXISTS (
        SELECT 1
        FROM head AS pending_root
        WHERE pending_root.branch = :branch
          AND pending_root.id = dependency.piece_id
          AND pending_root.scope_key = dependency.piece_scope_key
          AND pending_root.seq > :after_seq
          AND pending_root.seq <= :target_seq
      )
  )
ORDER BY pending.seq, pending.rowid
LIMIT :limit
`);
  try {
    return (statement.all({
      branch: DEFAULT_BRANCH,
      after_seq: afterSeq,
      target_seq: targetSeq,
      limit,
    }) as Array<{ id: EntityId; scope_key: string }>).map((row) => ({
      branch: DEFAULT_BRANCH,
      id: row.id,
      scopeKey: row.scope_key,
    }));
  } finally {
    statement.finalize();
  }
};

const refreshPendingDependentRootsByRootScan = (
  database: Database,
  {
    afterSeq,
    targetSeq,
    space,
    readDocument,
    statements,
  }: {
    afterSeq: number;
    targetSeq: number;
    space: string;
    readDocument: ReadDocument;
    statements: PieceRootStatements;
  },
): void => {
  const pendingFilter = `
  EXISTS (
    SELECT 1
    FROM head AS changed_dependency
    WHERE changed_dependency.branch = :branch
      AND changed_dependency.id = dependency.dependency_id
      AND changed_dependency.scope_key = dependency.dependency_scope_key
      AND changed_dependency.seq > :after_seq
      AND changed_dependency.seq <= :target_seq
  )
  AND NOT EXISTS (
    SELECT 1
    FROM head AS pending_root
    WHERE pending_root.branch = :branch
      AND pending_root.id = dependency.piece_id
      AND pending_root.scope_key = dependency.piece_scope_key
      AND pending_root.seq > :after_seq
      AND pending_root.seq <= :target_seq
  )`;
  const firstPage = database.prepare(`
SELECT dependency.piece_id, dependency.piece_scope_key
FROM pragma_piece_root_dependency AS dependency
WHERE ${pendingFilter}
GROUP BY dependency.piece_id, dependency.piece_scope_key
ORDER BY dependency.piece_id, dependency.piece_scope_key
LIMIT :limit
`);
  const nextPage = database.prepare(`
SELECT dependency.piece_id, dependency.piece_scope_key
FROM pragma_piece_root_dependency AS dependency
WHERE (dependency.piece_id, dependency.piece_scope_key) >
    (:after_id, :after_scope_key)
  AND ${pendingFilter}
GROUP BY dependency.piece_id, dependency.piece_scope_key
ORDER BY dependency.piece_id, dependency.piece_scope_key
LIMIT :limit
`);
  type DependentRootRow = {
    piece_id: EntityId;
    piece_scope_key: string;
  };
  let after: DependentRootRow | undefined;
  try {
    for (;;) {
      const rows = (after === undefined ? firstPage : nextPage).all({
        branch: DEFAULT_BRANCH,
        after_seq: afterSeq,
        target_seq: targetSeq,
        limit: CATCH_UP_PAGE_SIZE,
        ...(after === undefined ? {} : {
          after_id: after.piece_id,
          after_scope_key: after.piece_scope_key,
        }),
      }) as DependentRootRow[];
      for (const row of rows) {
        refreshOrDeleteRoot({
          root: {
            branch: DEFAULT_BRANCH,
            id: row.piece_id,
            scopeKey: row.piece_scope_key,
          },
          space,
          readDocument,
          statements,
        });
      }
      after = rows.at(-1);
      if (rows.length < CATCH_UP_PAGE_SIZE) break;
    }
  } finally {
    firstPage.finalize();
    nextPage.finalize();
  }
};

type PendingRevisionRow = {
  id: EntityId;
  scope_key: string;
  seq: number;
  op_index: number;
  op: "set" | "patch" | "delete";
  data: string | null;
};

const pendingEntityRevisionBatches = function* (
  database: Database,
  {
    afterSeq,
    targetSeq,
    id,
    scopeKey,
  }: {
    afterSeq: number;
    targetSeq: number;
    id: EntityId;
    scopeKey: string;
  },
): Generator<PendingRevisionRow[]> {
  const statement = database.prepare(`
SELECT id, scope_key, seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND seq > :after_seq
  AND seq <= :target_seq
  AND (
    seq > :cursor_seq OR
    (seq = :cursor_seq AND op_index > :cursor_op_index)
  )
  AND id = :id
  AND scope_key = :scope_key
ORDER BY seq, op_index
LIMIT :limit
`);
  let cursorSeq = afterSeq;
  let cursorOpIndex = -1;
  try {
    for (;;) {
      const rows = statement.all({
        branch: DEFAULT_BRANCH,
        after_seq: afterSeq,
        target_seq: targetSeq,
        cursor_seq: cursorSeq,
        cursor_op_index: cursorOpIndex,
        limit: CATCH_UP_PAGE_SIZE,
        id,
        scope_key: scopeKey,
      }) as PendingRevisionRow[];
      if (rows.length === 0) return;
      yield rows;
      const last = rows.at(-1)!;
      cursorSeq = last.seq;
      cursorOpIndex = last.op_index;
      if (rows.length < CATCH_UP_PAGE_SIZE) return;
    }
  } finally {
    statement.finalize();
  }
};

const revisionChange = (
  row: PendingRevisionRow,
): PieceRootIndexChange => {
  const change: PieceRootIndexChange = {
    branch: DEFAULT_BRANCH,
    id: row.id,
    scopeKey: row.scope_key,
  };
  if (row.op === "delete") {
    change.document = null;
  } else if (row.op === "patch") {
    change.patches = decodeMemoryBoundary<PatchOp[]>(
      row.data ?? "fvj1:[]",
    );
  }
  return change;
};

export const catchUpPieceRootIndex = (
  database: Database,
  {
    space,
    readDocument,
    targetCommitSeq = currentCommitSeq(database),
  }: {
    space?: string;
    readDocument: ReadDocument;
    targetCommitSeq?: number;
  },
): void => {
  const state = indexState(database);
  const indexSpace = space ?? state?.registry_space ?? "";
  if (
    state?.version === INDEX_VERSION &&
    state.indexed_commit_seq === targetCommitSeq &&
    state.registry_space === indexSpace
  ) {
    return;
  }
  const statements = preparePieceRootStatements(database);
  try {
    if (
      state?.version !== INDEX_VERSION ||
      state.indexed_commit_seq === null ||
      state.indexed_commit_seq > targetCommitSeq ||
      state.registry_space !== indexSpace
    ) {
      rebuildAllRoots(
        database,
        indexSpace,
        readDocument,
        targetCommitSeq,
        statements,
      );
      return;
    }

    const registryAddress = state.registry_id === null ||
        state.registry_scope_key === null
      ? undefined
      : {
        id: state.registry_id,
        scopeKey: state.registry_scope_key,
      };
    const registryPath = state.registry_path === null
      ? undefined
      : parseStoredPath(state.registry_path);
    let otherRegistryDependencyChanged = false;
    const firstHeadPage = database.prepare(`
SELECT rowid AS row_id, id, scope_key, seq
FROM head INDEXED BY idx_head_branch_sequence
WHERE branch = :branch
  AND seq > :after_seq
  AND seq <= :target_seq
ORDER BY seq, rowid
LIMIT :limit
`);
    const nextHeadPage = database.prepare(`
SELECT rowid AS row_id, id, scope_key, seq
FROM head INDEXED BY idx_head_branch_sequence
WHERE branch = :branch
  AND seq > :after_seq
  AND seq <= :target_seq
  AND (seq, rowid) > (:cursor_seq, :cursor_row_id)
ORDER BY seq, rowid
LIMIT :limit
`);
    type PendingHeadRow = {
      row_id: number;
      id: EntityId;
      scope_key: string;
      seq: number;
    };
    let after: PendingHeadRow | undefined;
    let boundedPendingChanges: PieceRootIndexChange[] | undefined = [];
    try {
      for (;;) {
        const rows = (after === undefined ? firstHeadPage : nextHeadPage).all({
          branch: DEFAULT_BRANCH,
          after_seq: state.indexed_commit_seq,
          target_seq: targetCommitSeq,
          limit: CATCH_UP_PAGE_SIZE,
          ...(after === undefined ? {} : {
            cursor_seq: after.seq,
            cursor_row_id: after.row_id,
          }),
        }) as PendingHeadRow[];
        const changes = rows.map((row) => ({
          branch: DEFAULT_BRANCH,
          id: row.id,
          scopeKey: row.scope_key,
        }));
        if (boundedPendingChanges !== undefined) {
          if (
            boundedPendingChanges.length + changes.length <=
              CATCH_UP_PAGE_SIZE
          ) {
            boundedPendingChanges.push(...changes);
          } else {
            boundedPendingChanges = undefined;
          }
        }
        refreshDirectRoots({
          changes,
          space: indexSpace,
          readDocument,
          statements,
        });
        if (!otherRegistryDependencyChanged) {
          const otherChanges = registryAddress === undefined
            ? changes
            : changes.filter((change) =>
              change.id !== registryAddress.id ||
              change.scopeKey !== registryAddress.scopeKey
            );
          for (
            const dependency of changedRegistryDependencyAddresses(
              database,
              otherChanges,
            )
          ) {
            for (
              const revisions of pendingEntityRevisionBatches(database, {
                afterSeq: state.indexed_commit_seq,
                targetSeq: targetCommitSeq,
                id: dependency.id,
                scopeKey: dependency.scopeKey,
              })
            ) {
              if (
                registryNeedsRefresh(
                  database,
                  revisions.map(revisionChange),
                  readDocument,
                )
              ) {
                otherRegistryDependencyChanged = true;
                break;
              }
            }
            if (otherRegistryDependencyChanged) break;
          }
        }
        after = rows.at(-1);
        if (rows.length < CATCH_UP_PAGE_SIZE) break;
      }
    } finally {
      firstHeadPage.finalize();
      nextHeadPage.finalize();
    }

    const dependencyChanges = pendingDependencyTargets(database, {
      afterSeq: state.indexed_commit_seq,
      targetSeq: targetCommitSeq,
      limit: CATCH_UP_PAGE_SIZE + 1,
    });
    if (dependencyChanges.length <= CATCH_UP_PAGE_SIZE) {
      refreshDependentRoots({
        changes: dependencyChanges,
        directChanges: boundedPendingChanges,
        afterSeq: state.indexed_commit_seq,
        targetSeq: targetCommitSeq,
        space: indexSpace,
        readDocument,
        statements,
      });
    } else {
      refreshPendingDependentRootsByRootScan(database, {
        afterSeq: state.indexed_commit_seq,
        targetSeq: targetCommitSeq,
        space: indexSpace,
        readDocument,
        statements,
      });
    }

    let registryChanged = false;
    let registryTailEligible = registryAddress !== undefined &&
      registryPath !== undefined;
    let registryAddUniqueChange: PieceRootIndexChange | undefined;
    if (registryAddress !== undefined) {
      for (
        const rows of pendingEntityRevisionBatches(database, {
          afterSeq: state.indexed_commit_seq,
          targetSeq: targetCommitSeq,
          id: registryAddress.id,
          scopeKey: registryAddress.scopeKey,
        })
      ) {
        for (const row of rows) {
          registryChanged = true;
          const change = revisionChange(row);
          registryTailEligible &&= change.patches !== undefined &&
            change.patches.length > 0 &&
            change.patches.every((patch) =>
              isRegistryTailPatch(patch, registryPath!)
            );
          if (
            registryAddUniqueChange === undefined &&
            change.patches?.some((patch) => patch.op === "add-unique")
          ) {
            registryAddUniqueChange = change;
          }
        }
      }
    }

    if (registryChanged || otherRegistryDependencyChanged) {
      let extended = false;
      if (
        registryChanged &&
        !otherRegistryDependencyChanged &&
        registryTailEligible &&
        registryAddress !== undefined
      ) {
        if (registryAddUniqueChange !== undefined) {
          extended = extendRegistry(database, {
            changes: [registryAddUniqueChange],
            space: indexSpace,
            readDocument,
          });
        } else {
          extended = true;
          for (
            const rows of pendingEntityRevisionBatches(database, {
              afterSeq: state.indexed_commit_seq,
              targetSeq: targetCommitSeq,
              id: registryAddress.id,
              scopeKey: registryAddress.scopeKey,
            })
          ) {
            extended &&= extendRegistry(database, {
              changes: rows.map(revisionChange),
              space: indexSpace,
              readDocument,
            });
          }
        }
      }
      if (!extended) {
        rebuildRegistry(
          database,
          indexSpace,
          readDocument,
          targetCommitSeq,
        );
      }
    }
    markCommitIndexed(database, targetCommitSeq);
  } finally {
    finalizePieceRootStatements(statements);
  }
};

const cursorParts = (
  cursor: PieceRootCursor,
): {
  id: string;
  scopeRank: number;
  orderKey: string;
} => ({
  id: cursor.id,
  scopeRank: cursor.scope === "space" ? 0 : cursor.scope === "user" ? 1 : 2,
  orderKey: cursor.orderKey,
});

const PIECE_ROOT_SELECT_COLUMNS = `
  id,
  canonical_id,
  order_key,
  scope_key,
  name,
  pattern_identity,
  pattern_symbol,
  pattern_repository,
  pattern_source,
  pattern_entry,
  registry_position`;

const selectRegisteredRoots = (
  database: Database,
  {
    scopeKey,
    afterPosition,
    limit,
  }: {
    scopeKey: string;
    afterPosition?: number;
    limit: number;
  },
): PieceRootRow[] =>
  database.prepare(`
SELECT
  ${PIECE_ROOT_SELECT_COLUMNS},
  0 AS scope_rank
FROM pragma_piece_root
WHERE scope_key = :scope_key
  AND registry_position IS NOT NULL
  ${
    afterPosition === undefined ? "" : "AND registry_position > :after_position"
  }
ORDER BY registry_position
LIMIT :limit
`).all({
      scope_key: scopeKey,
      ...(afterPosition === undefined ? {} : { after_position: afterPosition }),
      limit,
    }) as PieceRootRow[];

const selectUnregisteredRoots = (
  database: Database,
  {
    visibleScopeKeys,
    after,
    limit,
  }: {
    visibleScopeKeys: {
      space: string;
      user: string;
      session: string;
    };
    after?: ReturnType<typeof cursorParts>;
    limit: number;
  },
): PieceRootRow[] => {
  const scopes = [
    { scopeKey: visibleScopeKeys.space, scopeRank: 0 },
    { scopeKey: visibleScopeKeys.user, scopeRank: 1 },
    { scopeKey: visibleScopeKeys.session, scopeRank: 2 },
  ];
  const rows = scopes.flatMap(({ scopeKey, scopeRank }) => {
    const afterFilter = after === undefined
      ? ""
      : scopeRank < after.scopeRank
      ? "AND canonical_id > :after_id"
      : scopeRank > after.scopeRank
      ? "AND canonical_id >= :after_id"
      : `AND (canonical_id, order_key) > (:after_id, :after_order_key)`;
    return database.prepare(`
SELECT
  ${PIECE_ROOT_SELECT_COLUMNS},
  :scope_rank AS scope_rank
FROM pragma_piece_root
  INDEXED BY idx_piece_root_unregistered_scope_listing
WHERE scope_key = :scope_key
  AND registry_position IS NULL
  ${afterFilter}
ORDER BY canonical_id, order_key
LIMIT :limit
`).all({
      scope_key: scopeKey,
      scope_rank: scopeRank,
      ...(after === undefined ? {} : {
        after_id: after.id,
        ...(scopeRank === after.scopeRank
          ? { after_order_key: after.orderKey }
          : {}),
      }),
      limit,
    }) as PieceRootRow[];
  });
  const encoder = new TextEncoder();
  const encoded = new Map<string, Uint8Array>();
  const compareText = (left: string, right: string): number => {
    if (left === right) return 0;
    const leftBytes = encoded.get(left) ?? encoder.encode(left);
    const rightBytes = encoded.get(right) ?? encoder.encode(right);
    encoded.set(left, leftBytes);
    encoded.set(right, rightBytes);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index++) {
      if (leftBytes[index] !== rightBytes[index]) {
        return leftBytes[index] - rightBytes[index];
      }
    }
    return leftBytes.length - rightBytes.length;
  };
  rows.sort((left, right) =>
    compareText(left.canonical_id, right.canonical_id) ||
    left.scope_rank - right.scope_rank ||
    compareText(left.order_key, right.order_key)
  );
  return rows.slice(0, limit);
};

const indexedPieceRoot = (row: PieceRootRow): IndexedPieceRoot => {
  const scope = scopeFromKey(row.scope_key);
  const registered = row.registry_position !== null;
  const entityKind = pieceRootEntityKind(row.id);
  const pattern = row.pattern_identity !== null &&
      row.pattern_symbol !== null
    ? {
      identity: row.pattern_identity,
      symbol: row.pattern_symbol,
      ...(row.pattern_repository === null
        ? {}
        : { repository: row.pattern_repository }),
      ...(row.pattern_source === null ? {} : { origin: row.pattern_source }),
      ...(row.pattern_entry === null ? {} : { entry: row.pattern_entry }),
    }
    : undefined;
  return {
    entry: {
      id: row.canonical_id,
      ...(entityKind === undefined ? {} : { entityKind }),
      scope,
      registered,
      ...(row.name === null ? {} : { name: row.name }),
      ...(pattern === undefined ? {} : { pattern }),
    },
    cursor: {
      id: row.canonical_id,
      orderKey: row.order_key,
      scope,
      registered,
      ...(row.registry_position === null
        ? {}
        : { registryPosition: row.registry_position }),
    },
  };
};

export const listPieceRootPage = (
  database: Database,
  {
    visibleScopeKeys,
    after,
    limit,
    registeredOnly,
  }: {
    visibleScopeKeys: {
      space: string;
      user: string;
      session: string;
    };
    after?: PieceRootCursor;
    limit: number;
    registeredOnly?: boolean;
  },
): IndexedPieceRoot[] => {
  if (after !== undefined && !after.registered) {
    if (registeredOnly === true) return [];
    return selectUnregisteredRoots(database, {
      visibleScopeKeys,
      after: cursorParts(after),
      limit,
    }).map(indexedPieceRoot);
  }

  const registeredRows = selectRegisteredRoots(database, {
    scopeKey: visibleScopeKeys.space,
    afterPosition: after?.registryPosition,
    limit,
  });
  if (registeredOnly === true || registeredRows.length === limit) {
    return registeredRows.map(indexedPieceRoot);
  }
  const unregisteredRows = selectUnregisteredRoots(database, {
    visibleScopeKeys,
    limit: limit - registeredRows.length,
  });
  return [...registeredRows, ...unregisteredRows].map(indexedPieceRoot);
};
