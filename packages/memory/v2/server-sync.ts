import { hashSchema, internSchema } from "@commonfabric/data-model/schema-hash";
import {
  type EntitySnapshot,
  type GraphQuery,
  type SessionSync,
  type SessionSyncUpsert,
  type WatchSpec,
} from "../v2.ts";

export type SessionCacheEntry = SessionSyncUpsert;

export const cacheKeyForEntity = (branch: string, id: string): string =>
  `${branch}\0${id}`;

export const sameSnapshot = (
  left: SessionCacheEntry | undefined,
  right: SessionCacheEntry | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.branch === right.branch &&
    left.id === right.id &&
    left.seq === right.seq &&
    left.deleted === right.deleted;
};

export const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0;

export const toCacheEntry = (
  entity: EntitySnapshot,
): SessionCacheEntry => {
  if (entity.document === null) {
    return {
      branch: entity.branch,
      id: entity.id,
      seq: entity.seq,
      deleted: true,
    };
  }
  return {
    branch: entity.branch,
    id: entity.id,
    seq: entity.seq,
    doc: entity.document,
  };
};

export const trackedIdsFromEntries = (
  entries: Iterable<SessionCacheEntry>,
): Set<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
  }
  return ids;
};

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
    root.selector.path,
    root.selector.schema === undefined
      ? ""
      : hashSchema(internSchema(root.selector.schema)).toString(),
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
    .filter((entry) => !next.has(cacheKeyForEntity(entry.branch, entry.id)))
    .map((entry) => ({ branch: entry.branch, id: entry.id }))
    .sort((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    );
  const upserts = [...next.values()].sort((left, right) =>
    left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
  );
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
    .map(([, entry]) => ({ branch: entry.branch, id: entry.id }))
    .sort((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    );
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts: upserts.toSorted((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    ),
    removes,
  };
};
