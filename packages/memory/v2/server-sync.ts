import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  type BranchName,
  type CellScope,
  type EntityId,
  type EntitySnapshot,
  type GraphQuery,
  type SessionSync,
  type SessionSyncUpsert,
  type WatchSpec,
} from "../v2.ts";

export type SessionCacheEntry = SessionSyncUpsert & { scope: CellScope };

/**
 * F3 doc-set membership entry: one exact document a session's doc-set watches
 * subscribe to. Keyed server-side by the RESOLVED scope key (FA2). Carries the
 * per-member `lastSentSeq` so a resumed catch-up is an incremental diff rather
 * than a reseed (FA15), and a `sources` refcount so membership shrink is
 * correct across multiple contributing watches/observations (FA8): a member
 * leaves the served set only when its LAST source drops.
 */
export interface DocSetMember {
  branch: BranchName;
  id: EntityId;
  /** Declared scope of the address (space | user | session). */
  scope: CellScope;
  /** Resolved scope key of the member instance (FA2). */
  scopeKey: string;
  /** Highest member seq already delivered to this session (FA15). */
  lastSentSeq: number;
  /** Contributing sources (watch ids); a member survives while any remain. */
  sources: Set<string>;
}

/** Membership key: the resolved-scopeKey instance identity (FA2). */
export const docSetMemberKey = (
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): string => `${branch}\0${scopeKey}\0${id}`;

const DEFAULT_SCOPE: CellScope = "space";

export const cacheKeyForEntity = (
  branch: string,
  id: string,
  scope: CellScope = DEFAULT_SCOPE,
): string => `${branch}\0${scope}\0${id}`;

export const sameSnapshot = (
  left: SessionCacheEntry | undefined,
  right: SessionCacheEntry | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.branch === right.branch &&
    left.id === right.id &&
    left.scope === right.scope &&
    left.seq === right.seq &&
    left.deleted === right.deleted;
};

export const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0;

export const toCacheEntry = (
  entity: EntitySnapshot,
): SessionCacheEntry => {
  // Resolved scope key rides through to the sync upsert (C1.4b) so a
  // multi-lane receiver can attribute the frame to an instance.
  const scopeKey = entity.scopeKey !== undefined
    ? { scopeKey: entity.scopeKey }
    : {};
  if (entity.document === null) {
    return {
      branch: entity.branch,
      id: entity.id,
      scope: entity.scope ?? DEFAULT_SCOPE,
      ...scopeKey,
      seq: entity.seq,
      deleted: true,
    };
  }
  return {
    branch: entity.branch,
    id: entity.id,
    scope: entity.scope ?? DEFAULT_SCOPE,
    ...scopeKey,
    seq: entity.seq,
    doc: entity.document,
  };
};

export const trackedIdsFromEntries = (
  entries: Iterable<SessionCacheEntry>,
): Set<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(`${entry.scope}\0${entry.id}`);
  }
  return ids;
};

const compareSyncAddress = (
  left: { branch: string; id: string; scope?: CellScope },
  right: { branch: string; id: string; scope?: CellScope },
): number =>
  left.branch.localeCompare(right.branch) ||
  (left.scope ?? DEFAULT_SCOPE).localeCompare(right.scope ?? DEFAULT_SCOPE) ||
  left.id.localeCompare(right.id);

/** Type guard: the graph/query watch kinds carry a `query`; the F3 `docs`
 * kind does not and is handled by the doc-set membership path instead. */
export const isGraphWatchSpec = (
  watch: WatchSpec,
): watch is Exclude<WatchSpec, { kind: "docs" }> => watch.kind !== "docs";

/** Type guard for the F3 doc-set watch kind. */
export const isDocSetWatchSpec = (
  watch: WatchSpec,
): watch is Extract<WatchSpec, { kind: "docs" }> => watch.kind === "docs";

export const groupedQueries = (
  watches: readonly WatchSpec[],
): Map<string, GraphQuery> => {
  const grouped = new Map<string, GraphQuery>();
  for (const watch of watches) {
    // Doc-set watches never enter graph grouping — they are point-read
    // members, not traversal roots.
    if (!isGraphWatchSpec(watch)) continue;
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

const watchQueryIdentity = (watch: WatchSpec): string => {
  if (!isGraphWatchSpec(watch)) {
    // Doc-set watches have no query; identity is their declared address set.
    return JSON.stringify({
      branch: watch.branch ?? "",
      docs: watch.docs
        .map((doc) => JSON.stringify([doc.id, doc.scope ?? DEFAULT_SCOPE]))
        .toSorted(),
    });
  }
  return JSON.stringify({
    branch: watch.query.branch ?? "",
    atSeq: watch.query.atSeq ?? null,
    excludeSent: watch.query.excludeSent === true,
    roots: watch.query.roots.map(watchRootIdentity).toSorted(),
  });
};

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
        cacheKeyForEntity(entry.branch, entry.id, entry.scope),
      )
    )
    .map((entry) => ({
      branch: entry.branch,
      id: entry.id,
      scope: entry.scope,
      // F2/FA6: removes carry the instance's resolved scope key so they evict
      // exactly the instance the matching upsert established.
      ...(entry.scopeKey !== undefined ? { scopeKey: entry.scopeKey } : {}),
    }))
    .sort(compareSyncAddress);
  const upserts = [...next.values()].sort(compareSyncAddress);
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
      // F2/FA6: instance-exact removes (see buildFullSync).
      ...(entry.scopeKey !== undefined ? { scopeKey: entry.scopeKey } : {}),
    }))
    .sort(compareSyncAddress);
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts: upserts.toSorted(compareSyncAddress),
    removes,
  };
};
