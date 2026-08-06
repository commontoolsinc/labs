import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  type CellScope,
  type EntitySnapshot,
  type GraphQuery,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  type SessionSync,
  type SessionSyncUpsert,
  type WatchSpec,
} from "../v2.ts";
import { toDirtyKey } from "./query.ts";

/**
 * A session's cached snapshot of one tracked doc INSTANCE. `scopeKey` is
 * server-internal (the wire upsert keeps the scope NAME — a client's
 * instances resolve from its session, protocol.md §1): it keys the cache
 * and the tracked-id set per instance (scopes.md §7 M4, stage F), so two
 * principals' instances of one doc never collapse to one entry.
 */
export type SessionCacheEntry = SessionSyncUpsert & {
  scope: CellScope;
  scopeKey: ScopeKey;
};

const DEFAULT_SCOPE: CellScope = "space";

export const cacheKeyForEntity = (
  branch: string,
  id: string,
  scopeKey: ScopeKey = "space",
): string => `${branch}\0${scopeKey}\0${id}`;

export const sameSnapshot = (
  left: SessionCacheEntry | undefined,
  right: SessionCacheEntry | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.branch === right.branch &&
    left.id === right.id &&
    left.scopeKey === right.scopeKey &&
    left.seq === right.seq &&
    left.deleted === right.deleted;
};

export const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0;

/**
 * Build a session cache entry for one tracked instance. The instance key
 * is the TRACKED one — passed by callers that walked a graph state's
 * instance-keyed entries — falling back to the session identity's own
 * resolution for the entity's declared scope (the two agree everywhere a
 * root did not name an explicit foreign instance).
 */
export const toCacheEntry = (
  entity: EntitySnapshot,
  identity: ScopeKeyIdentity,
  scopeKey?: ScopeKey,
): SessionCacheEntry => {
  const scope = entity.scope ?? DEFAULT_SCOPE;
  const instanceKey = scopeKey ?? resolveScopeKey(scope, identity);
  if (entity.document === null) {
    return {
      branch: entity.branch,
      id: entity.id,
      scope,
      scopeKey: instanceKey,
      seq: entity.seq,
      deleted: true,
    };
  }
  return {
    branch: entity.branch,
    id: entity.id,
    scope,
    scopeKey: instanceKey,
    seq: entity.seq,
    doc: entity.document,
  };
};

export const trackedIdsFromEntries = (
  entries: Iterable<SessionCacheEntry>,
): Set<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(toDirtyKey(entry.id, entry.scopeKey));
  }
  return ids;
};

/**
 * The wire form of a cache entry: the server-internal `scopeKey` is
 * STRIPPED — the wire carries scope NAMES, and a client's instances
 * resolve from its authenticated session (protocol.md §1; clients never
 * receive keys). Every path that puts cache entries into a `SessionSync`
 * frame goes through this, so the instance keying stays server-internal
 * and the OFF-arm wire is byte-identical.
 */
export const toWireUpsert = (
  entry: SessionCacheEntry,
): SessionSyncUpsert => {
  // Field order matches the pre-instance-keying cache entry exactly
  // (branch, id, scope, seq, then deleted|doc), so serialized frames are
  // byte-identical to before the re-key.
  if (entry.deleted === true) {
    return {
      branch: entry.branch,
      id: entry.id,
      scope: entry.scope,
      seq: entry.seq,
      deleted: true,
    };
  }
  return {
    branch: entry.branch,
    id: entry.id,
    scope: entry.scope,
    seq: entry.seq,
    ...(entry.doc === undefined ? {} : { doc: entry.doc }),
  };
};

const compareSyncAddress = (
  left: { branch: string; id: string; scope?: CellScope },
  right: { branch: string; id: string; scope?: CellScope },
): number =>
  left.branch.localeCompare(right.branch) ||
  (left.scope ?? DEFAULT_SCOPE).localeCompare(right.scope ?? DEFAULT_SCOPE) ||
  left.id.localeCompare(right.id);

export const groupedQueries = (
  watches: readonly WatchSpec[],
): Map<string, GraphQuery> => {
  const grouped = new Map<string, GraphQuery>();
  for (const watch of watches) {
    const branch = watch.query.branch ?? "";
    const existing = grouped.get(branch);
    if (existing === undefined) {
      grouped.set(branch, {
        branch,
        roots: [...watch.query.roots],
      });
      continue;
    }
    existing.roots.push(...watch.query.roots);
  }
  return grouped;
};

export const mergeWatchesById = (
  current: readonly WatchSpec[],
  added: readonly WatchSpec[],
): WatchSpec[] => {
  const merged = new Map(current.map((watch) => [watch.id, watch] as const));
  for (const watch of added) {
    merged.set(watch.id, watch);
  }
  return [...merged.values()];
};

const watchRootIdentity = (root: GraphQuery["roots"][number]): string =>
  JSON.stringify([
    root.id,
    root.scope ?? DEFAULT_SCOPE,
    root.selector.path,
    root.selector.schema === undefined
      ? ""
      : internSchemaAsTaggedHashString(root.selector.schema),
  ]);

const watchQueryIdentity = (watch: WatchSpec): string =>
  JSON.stringify({
    branch: watch.query.branch ?? "",
    atSeq: watch.query.atSeq ?? null,
    excludeSent: watch.query.excludeSent === true,
    roots: watch.query.roots.map(watchRootIdentity).toSorted(),
  });

export const sameWatchSpec = (
  left: WatchSpec,
  right: WatchSpec,
): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  watchQueryIdentity(left) === watchQueryIdentity(right);

export const buildFullSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
): SessionSync => {
  const removes = [...previous.values()]
    .filter((entry) =>
      !next.has(
        cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
      )
    )
    .map((entry) => ({
      branch: entry.branch,
      id: entry.id,
      scope: entry.scope,
    }))
    .sort(compareSyncAddress);
  const upserts = [...next.values()].sort(compareSyncAddress)
    .map(toWireUpsert);
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts,
    removes,
  };
};

export const buildDiffSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
): SessionSync => {
  const upserts: SessionCacheEntry[] = [];
  for (const [key, current] of next.entries()) {
    if (!sameSnapshot(previous.get(key), current)) {
      upserts.push(current);
    }
  }
  const removes = [...previous.entries()]
    .filter(([key]) => !next.has(key))
    .map(([, entry]) => ({
      branch: entry.branch,
      id: entry.id,
      scope: entry.scope,
    }))
    .sort(compareSyncAddress);
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts: upserts.toSorted(compareSyncAddress).map(toWireUpsert),
    removes,
  };
};
