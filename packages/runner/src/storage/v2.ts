import { cloneIfNecessary } from "@commonfabric/data-model/fabric-value";
import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import type { Entity } from "@commonfabric/memory/interface";
import type { RuntimeTelemetryMarker } from "../telemetry.ts";
import {
  type AuthorizationError as IAuthorizationError,
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type MemorySpace,
  type MIME,
  type Signer,
  type TransactionError,
  type URI,
} from "@commonfabric/memory/interface";
import { assert, unclaimed } from "@commonfabric/memory/fact";
import { aclDocId } from "@commonfabric/memory/acl";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  type CellScope,
  type ClientCommit,
  type CommitPrecondition,
  DEFAULT_BRANCH,
  type DocumentPath,
  type EntityDocument,
  type EntityIdListOptions,
  type EntityIdListResult,
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  type PatchOp,
  resolveScopeKey,
  type ScopeKeyIdentity,
  type SessionSync,
  type SqliteDbRef,
  type SqliteOperation,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import {
  applyPatchToDocument,
  PatchApplyError,
} from "../../../memory/v2/patch.ts";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import { valueFromDataUri } from "@commonfabric/data-model/data-uri-codec";
import {
  isPrimitiveCellLink,
  type NormalizedLink,
  parseLinkPrimitive,
} from "../link-types.ts";
import type { Cancel } from "../cancel.ts";
import { entityKey } from "../scheduler/keys.ts";
import { recordCommitLocalSeq } from "./commit-identity.ts";
import * as Differential from "./differential.ts";
import type {
  IMemoryAddress,
  IMergedChanges,
  IPreconditionFailedError,
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageManager,
  IStorageNotification,
  IStorageProvider,
  IStorageSubscription,
  IStorageTransaction,
  IStorageTransactionInconsistent,
  NativeStorageCommit,
  PullError,
  PushError,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  State,
  StorageNotification,
  StorageTransactionRejected,
  TransactionCommitOptions,
  Unit,
} from "./interface.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import {
  type EventAppendOutcome,
  EventAppendQueue,
  type EventAppendQueueStore,
  memoryEventAppendQueueStore,
  type QueuedEventAppend,
} from "./event-append-queue.ts";
import * as SubscriptionManager from "./subscription.ts";
import {
  getDirectTransactionMergeableOpAddresses,
  getDirectTransactionReadActivities,
} from "./transaction-inspection.ts";
import {
  getBlindStructuralTarget,
  isMergeableOpRead,
  isReadExcludedFromConflict,
  isReadIgnoredForCommit,
  isReadMarkedAsAttemptedWrite,
  notifyCommitRejected,
  recordCoverageWait,
} from "./reactivity-log.ts";

// A cell's CFC write-policy label lives at ["cfc"]. A mergeable write reads it as
// part of the write; that read is dropped from its conflict set.
const isCfcLabelPath = (path: readonly string[]): boolean =>
  path.length === 1 && path[0] === "cfc";

const isStrictPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length < path.length &&
  prefix.every((segment, index) => path[index] === segment);

const isSamePath = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((segment, index) => b[index] === segment);

// True when `path` is the immediate `length` child of `arrayPath` — i.e. a read
// of that array's own element count. A mergeable append / add-unique /
// remove-by-value changes this count, so such a read is a genuine dependency of
// the writer, not one of the op's own incidental sub-reads.
const isArrayLengthChildPath = (
  arrayPath: readonly string[],
  path: readonly string[],
): boolean =>
  path.length === arrayPath.length + 1 &&
  path[arrayPath.length] === "length" &&
  arrayPath.every((segment, index) => path[index] === segment);
import { toTransactionDocumentValue } from "./v2-document.ts";
import {
  compactWatchEntries,
  normalizeSyncEntries,
  normalizeSyncSelector,
  watchIdForEntry,
} from "./v2-watch.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
  type SessionFactory,
  storageAddressForHost,
  toWebSocketAddress,
} from "./v2-remote-session.ts";
import * as V2Transaction from "./v2-transaction.ts";
import { normalizeCellScope } from "../scope.ts";
import { normalizeSpaceHost, SpaceHostValidationError } from "../space-host.ts";
import { hasDataUriScheme } from "@commonfabric/data-model/data-uri-codec";

export { watchIdForEntry } from "./v2-watch.ts";
export type { SessionFactory } from "./v2-remote-session.ts";

const logger = getLogger("storage.v2", {
  enabled: true,
  level: "error",
});
const pendingPatchLogger = getLogger("storage.v2.pending-patch", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

function withCommitTiming<T>(
  keys: string[],
  fn: () => T,
): T {
  logger.timeStart(...keys);
  try {
    return fn();
  } finally {
    logger.timeEnd(...keys);
  }
}

const DATA_URI_SYNC_CACHE_MAX = 10_000;
// Backstop for the inline conflict read-repair wait. In the connected path the
// caught-up sync arrives within a refresh cycle; this only fires if the sync is
// permanently undelivered on a still-open, never-reconnecting session, so the
// commit cannot hang forever. On expiry we surface the conflict and let the
// scheduler retry path re-gate on readiness.
const CONFLICT_READ_REPAIR_TIMEOUT_MS = 30_000;

// Strategy 1 — client-side conflict admission control (EXPERIMENT, default off).
// Once a commit conflicts, the client knows its read set is behind on the
// touched ids until the server catches it up. "preempt" (coarse) gates what we
// do with a new commit whose reads land on a still-catching-up id: assume it
// will conflict and pre-empt it locally (revert + re-run after catch-up)
// without sending. Measured NET-NEGATIVE on the lunch-poll workload: the stale
// floor taints every id a losing tx touched (incl. write targets), so it
// pre-empts commits that would have SUCCEEDED, turning them into extra
// revert+re-run cycles. 5x5 server conflicts rose ~1380 -> ~1600 (plus
// pre-empts), wall time flat (conflicts are cheap).
//
// A "hold" (precise) mode also existed here: hold the commit until catch-up,
// then run the server's precondition check LOCALLY, sending only the reads
// that still hold. It was removed (#5110 review, CT-1925) — holding one
// commit's send while a later, independent one proceeded violated the
// increasing-localSeq send order required by 04-protocol.md §3.9 (reproduced
// same-session admission order [1, 3, 2] against the real engine), and it
// never showed a measured win (NEUTRAL on lunch-poll: the staleness is only
// knowable on the server, not locally). Do not resurrect a wait-then-send
// admission gate without re-solving the ordering violation.
//
// Default off. Do NOT enable without re-measuring on the target workload.
// Catalogued in docs/development/EXPERIMENTAL_OPTIONS.md (conflictAdmissionMode).
type ConflictAdmissionMode = "off" | "preempt";
let conflictAdmissionModeOverride: ConflictAdmissionMode | undefined;
export function setConflictAdmissionMode(
  mode: ConflictAdmissionMode | undefined,
): void {
  conflictAdmissionModeOverride = mode;
}
// Back-compat for existing tests/callers: true -> coarse preempt, false -> off.
export function setConflictAdmissionEnabled(value: boolean | undefined): void {
  conflictAdmissionModeOverride = value === undefined
    ? undefined
    : (value ? "preempt" : "off");
}
function conflictAdmissionMode(): ConflictAdmissionMode {
  if (conflictAdmissionModeOverride !== undefined) {
    return conflictAdmissionModeOverride;
  }
  try {
    const value = Deno.env.get("CF_CONFLICT_ADMISSION");
    if (value === "preempt" || value === "1" || value === "true") {
      return "preempt";
    }
    return "off";
  } catch {
    return "off";
  }
}
/**
 * Identity of one data-URI pull: the URI, the schema it was read against, the
 * path into it, and where it lives.
 *
 * The result is a hash rather than those parts joined together. A data URI
 * carries its whole value in its id, so the id is the one part that varies
 * without bound — a rendered UI tree reaches tens of kilobytes — and a cache
 * keyed on it directly would cost that much per entry.
 */
export function dataURISyncKey(identity: {
  id: string;
  schema: JSONSchema | undefined;
  path: readonly string[];
  space: MemorySpace;
  scope: CellScope | undefined;
}): string {
  return hashStringOf([
    identity.id,
    identity.schema ? hashStringOf(identity.schema) : "",
    [...identity.path],
    identity.space,
    normalizeCellScope(identity.scope),
  ]);
}

const DOCUMENT_MIME = "application/json" as const;
const UNCACHED_TRANSACTION_VALUE = Symbol("uncachedTransactionValue");

const activeCommitPreconditions = (
  preconditions: readonly CommitPrecondition[] | undefined,
): readonly CommitPrecondition[] =>
  getCommitPreconditionsConfig()
    ? (preconditions ?? [])
    : (preconditions ?? []).filter((precondition) =>
      precondition.kind === "entity-value-hash"
    );

const toExplicitDocument = (value: FabricValue): EntityDocument => {
  if (!isObjectNotArray(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EntityDocument;
};

type CachedTransactionValue =
  | FabricValue
  | typeof UNCACHED_TRANSACTION_VALUE
  | undefined;

type MaterializedVersion = {
  value: EntityDocument | undefined;
  transactionValue: CachedTransactionValue;
};

type PendingVersion =
  | {
    localSeq: number;
    op: "set";
    value: EntityDocument;
  }
  | {
    localSeq: number;
    op: "patch";
    patches: PatchOp[];
    value: EntityDocument;
  }
  | {
    localSeq: number;
    op: "delete";
  };

type ConfirmedVersion = MaterializedVersion & {
  seq: number;
};

type PendingMaterializedPrefix = MaterializedVersion & {
  localSeq: number;
};

type PendingMaterializationCache = {
  confirmed: ConfirmedVersion;
  prefixes: PendingMaterializedPrefix[];
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
  materialized?: PendingMaterializationCache;
};

type PendingPatchLogContext = {
  space: MemorySpace;
  id: URI;
  scope?: CellScope;
};

type ConfirmedCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;
  seq: number;
  nonRecursive?: boolean;
};

type PendingCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;
  /**
   * Every pending layer the read's materialized view sat on, as an array —
   * each must resolve to an accepted commit (server pending-dependency
   * check; client cascade), and the array always includes the doc's
   * top-of-stack layer below the reader (CT-1872 1c; 03-commit-model.md
   * §3.5), whose resolution is the LEGACY staleness basis on servers that
   * ignore `basisSeq`. Scalarized to the top-of-stack element at send time
   * when the server does not advertise `pendingReadStacks` — the pre-stack
   * wire shape — and in that case the send is HELD until every omitted
   * lower dependency settles, so the old server can never durably accept a
   * commit the client cascade-rejects.
   */
  localSeq: number | number[];
  /**
   * The reader's confirmed basis for THIS document, in the SERVER's seq
   * space — the same value the confirmed branch emits as `seq`, which the
   * pre-CT-1910 pending shape discarded. A server that understands it scans
   * staleness over the FULL interval (basisSeq, head], excluding only the
   * session's own predecessor commits (localSeq below the reader's),
   * repairing the pending-read basis over-advance; older servers ignore the
   * field and keep the max-dependency basis. See
   * {@link PendingRead.basisSeq} (memory/v2.ts).
   */
  basisSeq: number;
  nonRecursive?: boolean;
};

const pendingVersion = (
  localSeq: number,
  operation:
    | { op: "set"; value: EntityDocument }
    | { op: "patch"; patches: PatchOp[]; value: EntityDocument }
    | { op: "delete" },
): PendingVersion => ({ localSeq, ...operation });

const confirmedVersion = (
  seq: number,
  value: EntityDocument | undefined,
): ConfirmedVersion => ({
  seq,
  value,
  transactionValue: UNCACHED_TRANSACTION_VALUE,
});

const transactionValueForVersion = (
  version: MaterializedVersion,
): FabricValue | undefined => {
  if (version.transactionValue === UNCACHED_TRANSACTION_VALUE) {
    version.transactionValue = toTransactionDocumentValue(version.value);
  }
  return version.transactionValue;
};

const applyPendingVersion = (
  base: EntityDocument | undefined,
  pending: PendingVersion,
  logContext: PendingPatchLogContext,
): EntityDocument | undefined => {
  switch (pending.op) {
    case "delete":
      return undefined;
    case "set":
      return cloneIfNecessary(pending.value) as EntityDocument;
    case "patch": {
      // Replay the layer's OPS over the base — never combine values. The
      // patch vocabulary is semantic (append / add-unique / increment /
      // splice / ...), so replaying re-folds the layer against whatever
      // base the server delivered, exactly as the server folds it on
      // accept — the client and the server share this applyPatch. Spine
      // materialization comes from the ops that allow it (createMissing),
      // mirroring the server's mergeable disposition, and the ops can only
      // express this layer's own writes, so a dropped sibling's data is
      // unrepresentable in the result (CT-1872 1a).
      try {
        return applyPatchToDocument(
          base,
          pending.patches as PatchOp[],
        ) as EntityDocument;
      } catch (error) {
        if (!(error instanceof PatchApplyError)) {
          // Only genuine inapplicability renders as a skipped layer; an
          // unexpected implementation failure must propagate.
          throw error;
        }
        // An op that cannot apply to this base (e.g. an append onto a
        // scalar a winner wrote) renders WITHOUT this layer: transiently
        // honest — the server rejects the same ops against the same base,
        // or a covering frame retires the layer with server truth. Under
        // strict semantics (CT-1875) this becomes a terminal rejection.
        pendingPatchLogger.debug("pending-replay-skip", () => [
          "pending patch layer skipped: ops do not apply to the current base",
          {
            space: logContext.space,
            id: logContext.id,
            scope: normalizeCellScope(logContext.scope),
            localSeq: pending.localSeq,
            error: String(error),
          },
        ]);
        return base;
      }
    }
  }
};

const ensurePendingMaterializationCache = (
  record: DocumentRecord,
): PendingMaterializationCache => {
  const existing = record.materialized;
  if (existing && existing.confirmed === record.confirmed) {
    return existing;
  }
  const cache: PendingMaterializationCache = {
    confirmed: record.confirmed,
    prefixes: [],
  };
  record.materialized = cache;
  return cache;
};

const materializedVersionThroughPending = (
  record: DocumentRecord,
  logContext: PendingPatchLogContext,
  pendingCount = record.pending.length,
): MaterializedVersion => {
  if (pendingCount <= 0) {
    return record.confirmed;
  }

  const cache = ensurePendingMaterializationCache(record);
  while (cache.prefixes.length < pendingCount) {
    const nextIndex = cache.prefixes.length;
    const base = nextIndex === 0
      ? record.confirmed
      : cache.prefixes[nextIndex - 1]!;
    const pending = record.pending[nextIndex]!;
    cache.prefixes.push({
      localSeq: pending.localSeq,
      value: applyPendingVersion(base.value, pending, logContext),
      transactionValue: UNCACHED_TRANSACTION_VALUE,
    });
  }
  return cache.prefixes[pendingCount - 1]!;
};

const dropMaterializedSuffix = (
  record: DocumentRecord,
  pendingIndex: number,
): void => {
  if (pendingIndex <= 0) {
    record.materialized = undefined;
    return;
  }

  const cache = record.materialized;
  if (!cache) {
    return;
  }
  if (cache.confirmed !== record.confirmed) {
    record.materialized = undefined;
    return;
  }

  cache.prefixes.length = Math.min(cache.prefixes.length, pendingIndex);
  if (cache.prefixes.length === 0) {
    record.materialized = undefined;
  }
};

export interface Options {
  as: Signer;
  /**
   * Base URL of the default memory host. The storage endpoint path
   * (`/api/storage/memory`) is joined internally — pass the host, not
   * the full endpoint. This storage-only route may use HTTP, HTTPS,
   * WebSocket, or secure WebSocket.
   */
  memoryHost: URL;
  /**
   * Optional map from space DIDs to HTTP or HTTPS origin overrides. A space
   * listed here opens its storage connection against that host; absent map or
   * absent entry initially resolves to `memoryHost`. The map is fixed for
   * the manager's lifetime. A first late hint can replace a provisional
   * `memoryHost` route for an unseeded space before that route issues a
   * stateful operation.
   */
  spaceHostMap?: Record<string, string>;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  /** Space authority used only for fresh named-space ACL genesis. The durable
   *  replica session still authenticates as `as`. */
  spaceIdentity?: Signer;
  /** The LT9 event-intent persistence seam (server-execution v2 Phase 3;
   *  events.md §5): where each space's queued-but-undelivered event
   *  appends live across manager lifetimes. Absent = in-memory (the
   *  same persistence class as `sessionId` today — protocol.md §5's
   *  sessionId persistence is itself unbuilt; a host that persists
   *  sessions supplies a durable store through this seam). */
  eventAppendQueueStore?: EventAppendQueueStore;
}

/**
 * Max concurrent watch-refresh round trips per space when
 * `experimentalConcurrentWatchRefresh` is on. Bounds how many requests a
 * traversal-discovered wave may have outstanding at once — high enough to hide
 * per-request latency behind a deep waterfall, low enough to keep the server's
 * receive queue and the client's outstanding-request set bounded.
 */
const CONCURRENT_WATCH_REFRESH_WINDOW = 8;

const comparePath = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    const a = left[index];
    const b = right[index];
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

// Canonical grouping/sort key for a pending read's dependency set: arrays
// are ascending, so the join is order-stable per identical stack.
const localSeqKey = (localSeq: number | number[]): string =>
  Array.isArray(localSeq) ? localSeq.join(",") : String(localSeq);

const compactCommitReads = <
  Read extends ConfirmedCommitRead | PendingCommitRead,
>(
  space: MemorySpace,
  reads: Read[],
): Read[] => {
  const sorted = [...reads].sort((left, right) => {
    const leftScope = normalizeCellScope(left.scope);
    const rightScope = normalizeCellScope(right.scope);
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }

    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
    }

    if ("seq" in left && "seq" in right && left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    if ("localSeq" in left && "localSeq" in right) {
      const leftKey = localSeqKey(left.localSeq);
      const rightKey = localSeqKey(right.localSeq);
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
    }

    if (left.nonRecursive !== right.nonRecursive) {
      return left.nonRecursive === true ? 1 : -1;
    }

    return comparePath(left.path, right.path);
  });

  const grouped = new Map<string, {
    recursiveByPath: Map<string, Read>;
    nonRecursiveByPath: Map<string, Read>;
  }>();
  for (const candidate of sorted) {
    // The dependency key carries every admission-relevant field — seq for
    // confirmed reads, the layer set AND basisSeq for pending reads — so
    // reads with divergent bases never merge: ancestor-path compaction
    // within a group may drop a descendant read, and a surviving ancestor
    // must not claim a higher basis than the dropped read declared.
    const dependencyKey = "seq" in candidate
      ? `confirmed:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.seq}`
      : `pending:${normalizeCellScope(candidate.scope)}:${candidate.id}:${
        localSeqKey(candidate.localSeq)
      }:${candidate.basisSeq}`;
    let group = grouped.get(dependencyKey);
    if (!group) {
      group = {
        recursiveByPath: new Map(),
        nonRecursiveByPath: new Map(),
      };
      grouped.set(dependencyKey, group);
    }
    const pathKey = candidate.path.join("\0");
    if (candidate.nonRecursive === true) {
      if (group.recursiveByPath.has(pathKey)) {
        continue;
      }
      group.nonRecursiveByPath.set(pathKey, candidate);
    } else {
      group.nonRecursiveByPath.delete(pathKey);
      group.recursiveByPath.set(pathKey, candidate);
    }
  }

  const compacted: Read[] = [];
  for (const group of grouped.values()) {
    const compactedRecursive = sortAndCompactPaths(
      [...group.recursiveByPath.values()].map((read) => ({
        space,
        id: read.id,
        scope: read.scope,
        type: DOCUMENT_MIME,
        path: read.path,
      })),
    );
    for (const address of compactedRecursive) {
      const read = group.recursiveByPath.get(address.path.join("\0"));
      if (read) {
        compacted.push(read);
      }
    }
    compacted.push(...group.nonRecursiveByPath.values());
  }

  return compacted.toSorted((left, right) => {
    const leftScope = normalizeCellScope(left.scope);
    const rightScope = normalizeCellScope(right.scope);
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }

    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
    }

    if ("seq" in left && "seq" in right && left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    if ("localSeq" in left && "localSeq" in right) {
      const leftKey = localSeqKey(left.localSeq);
      const rightKey = localSeqKey(right.localSeq);
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
    }

    if (left.nonRecursive !== right.nonRecursive) {
      return left.nonRecursive === true ? -1 : 1;
    }

    return comparePath(left.path, right.path);
  });
};

const toCommitReadPath = (
  path: readonly (string | number)[],
): DocumentPath => toDocumentPath(path.map(String));

// Wire-compat downgrade for servers that do not advertise the
// `pendingReadStacks` hello flag: collapse every array dependency set —
// including those inside batched scheduler observations — to its
// top-of-stack element (the highest localSeq, i.e. the staleness basis).
// The lower-layer dependency check is lost against such servers by design
// (CT-1872 1c stays open there). pushCommit compensates by HOLDING the send
// until every omitted lower dependency settles — without the hold, the old
// server could durably accept a commit the client cascade-rejects (a
// split-brain: caller sees ConflictError for a write that landed).
const scalarizeLocalSeq = (localSeq: number | number[]): number =>
  Array.isArray(localSeq) ? Math.max(...localSeq) : localSeq;

const scalarizePendingReadStacks = (commit: ClientCommit): ClientCommit => {
  const hasStack = (reads: { localSeq: number | number[] }[]): boolean =>
    reads.some((read) => Array.isArray(read.localSeq));
  const scalarizeReads = <Read extends { localSeq: number | number[] }>(
    reads: Read[],
  ): Read[] =>
    reads.map((read) =>
      Array.isArray(read.localSeq)
        ? { ...read, localSeq: scalarizeLocalSeq(read.localSeq) }
        : read
    );
  if (!hasStack(commit.reads.pending)) {
    return commit;
  }
  return {
    ...commit,
    reads: {
      confirmed: commit.reads.confirmed,
      pending: scalarizeReads(commit.reads.pending),
    },
  };
};

export class StorageManager implements IStorageManager {
  readonly id: string;
  readonly as: Signer;

  // One authenticated session identity is shared by every space opened during
  // a manager lifecycle. close() invalidates those server sessions, so a later
  // sequential Runtime reusing this manager must start a fresh identity rather
  // than attempting to resurrect an invalidated token.
  #sessionId: string;
  #settings: IRemoteStorageProviderSettings;
  #providers = new Map<MemorySpace, Provider>();
  #subscription = SubscriptionManager.create();
  #crossSpacePromises = new Set<Promise<void>>();
  // Docs already offered a link-target pull via shouldPullDoc. One entry per
  // (space, scope, id) for the manager's lifetime: the first pull registers a
  // server-side watch that keeps the doc flowing afterwards, so a second kick
  // is never needed — and never re-kicking is what keeps reads of genuinely
  // absent targets (dangling links, deleted docs) from churning the
  // cross-space convergence loop on every read.
  #docPullKicks = new Set<string>();
  // Data URIs whose linked targets this manager has already pulled, keyed by a
  // hash of the URI, schema, path, space, and scope. Per manager rather than
  // per process: a hit skips the pull, and a manager that inherited another
  // manager's hit would leave its own replica without those documents.
  #dataURISyncs = new BoundedKeyMap<string, Promise<void>>(
    DATA_URI_SYNC_CACHE_MAX,
  );
  // In-flight commits, registered synchronously by the transaction layer at
  // commit() entry (see IStorageManager.trackPendingCommit). This is the
  // write-durability barrier: distinct from #crossSpacePromises, which also
  // carries cross-space READ work (link-target loads) and so must not gate
  // "are there unconfirmed writes" questions.
  #pendingCommits = new Set<Promise<unknown>>();
  #pendingCommitsSubscribers = new Set<(pending: boolean) => void>();
  #sessionFactory: SessionFactory;
  #eventAppendQueueStore?: EventAppendQueueStore;
  #spaceIdentities = new Map<MemorySpace, Signer>();
  /** Seed map from Options — fixed for the manager's lifetime. */
  #seedHosts: Record<string, string>;
  /** Late-bound host hints; see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();
  /** Base URL the default storage route is resolved from, held as text so a
   *  caller mutating their URL object cannot move the route. */
  #memoryHost: string;
  /** WebSocket storage endpoint used by an unseeded, unhinted space; read it
   *  through #resolveDefaultStorageRoute(). */
  #defaultStorageRoute?: string;
  /** Whether #defaultStorageRoute holds the result of a resolution attempt.
   *  Separate from the value, which is undefined when resolution failed. */
  #defaultStorageRouteResolved = false;
  /** Late-bound marker sink (the Runtime's telemetry bus); see setTelemetry. */
  #telemetry?: TelemetrySink;

  /**
   * Attach the runtime's telemetry bus so replicas can emit the
   * `storage.push/pull.*` markers. Late-bound and optional: the manager is
   * constructed before (and independently of) the Runtime, and providers read
   * it through a getter so spaces opened earlier still pick it up.
   */
  setTelemetry(telemetry: TelemetrySink): void {
    this.#telemetry = telemetry;
  }

  static open(options: Options) {
    const dynamicHosts = new Map<string, string>();
    const manager = new this(
      options,
      new RemoteSessionFactory(
        createStorageAddressResolver(
          options.memoryHost,
          options.spaceHostMap,
          dynamicHosts,
        ),
        options.as,
      ),
    );
    manager.#dynamicHosts = dynamicHosts;
    return manager;
  }

  protected constructor(
    options: Options,
    sessionFactory: SessionFactory,
  ) {
    this.id = options.id ?? crypto.randomUUID();
    this.#sessionId = this.id;
    this.as = options.as;
    this.#settings = options.settings ?? {};
    this.#sessionFactory = sessionFactory;
    // ONE store per manager even in the in-memory default (verdict
    // blocker, 2026-08-12 / LT9): the store must outlive any single
    // SpaceReplica, or a provisional-replica replacement hands the new
    // queue a FRESH private store and the old queue's undischarged user
    // intents vanish in-process. A host that persists sessions supplies
    // a durable adapter through the same seam (see Options).
    this.#eventAppendQueueStore = options.eventAppendQueueStore ??
      memoryEventAppendQueueStore();
    if (options.spaceIdentity) {
      this.registerSpaceIdentity(options.spaceIdentity);
    }
    // Snapshot + freeze: the resolver snapshotted its own copy at
    // open(), so refusal logic must see the same fixed facts — a
    // caller mutating their map object must not desynchronize them.
    this.#seedHosts = Object.freeze({ ...(options.spaceHostMap ?? {}) });
    this.#memoryHost = String(options.memoryHost);
  }

  /**
   * The WebSocket storage endpoint an unseeded, unhinted space opens against,
   * resolved from the memory host on the first read and kept from then on.
   * registerSpaceHost() is its only reader. A failed resolution is kept as
   * well: a custom session factory may use a non-network memoryHost
   * placeholder, and such a manager has no default route.
   */
  #resolveDefaultStorageRoute(): string | undefined {
    if (!this.#defaultStorageRouteResolved) {
      this.#defaultStorageRouteResolved = true;
      try {
        const resolveDefault = createStorageAddressResolver(
          new URL(this.#memoryHost),
        );
        this.#defaultStorageRoute = toWebSocketAddress(
          resolveDefault("did:key:route-comparison" as MemorySpace),
        ).toString();
      } catch {
        // The route stays undefined; the flag above stops the retry.
      }
    }
    return this.#defaultStorageRoute;
  }

  /**
   * Records a runtime-learned HTTP or HTTPS origin for a space (e.g. from
   * the home-space site table). Returns true when the hint is accepted or
   * confirms a configured or previously accepted route. Refusals:
   *
   * - The seed map wins: a seeded space cannot be re-pointed.
   * - The first accepted late hint remains in effect.
   * - A provider opened through the default route is provisional until its
   *   session accepts a stateful operation. Its first accepted hint replaces
   *   that route and replays its reads.
   * - A different-host hint cannot replace a route after a stateful operation
   *   is issued.
   *
   * Idempotent when the hint matches what is already in effect.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid host for space ${space}`,
        { cause },
      );
    }
    const normalized = route.toString();
    const seeded = this.#seedHosts[space];
    if (seeded !== undefined) {
      return new URL(seeded).toString() === normalized;
    }
    const existing = this.#dynamicHosts.get(space);
    if (existing !== undefined) {
      return existing === normalized;
    }
    const provider = this.#providers.get(space);
    const replacesDefaultRoute = provider !== undefined &&
      this.#resolveDefaultStorageRoute() !==
        toWebSocketAddress(storageAddressForHost(normalized)).toString();
    if (replacesDefaultRoute && !provider.canReplaceProvisionalReplica()) {
      return false;
    }
    this.#dynamicHosts.set(space, normalized);
    if (replacesDefaultRoute) {
      this.trackUntilSettled(provider.replaceProvisionalReplica());
    }
    return true;
  }

  /**
   * Retain a derived space key solely as the authority for that space's first
   * ACL commit. Providers continue to authenticate all ordinary replica work
   * as `this.as`.
   */
  registerSpaceIdentity(identity: Signer): void {
    this.#spaceIdentities.set(identity.did() as MemorySpace, identity);
  }

  /**
   * The manager's own authenticated session identity (IStorageManager
   * contract): every provider session authenticates as `this.as` and mounts
   * with `#sessionId`, so this pair is exactly what the memory server
   * resolves this manager's scoped operations against.
   */
  scopeKeyIdentity(): ScopeKeyIdentity {
    return { principal: this.as.did(), sessionId: this.#sessionId };
  }

  /** IStorageManager (server-execution v2 Phase 4): first-open observer
   * — the flag-ON client effects channel subscribes per space through
   * it. Assigned post-construction by the Runtime; undefined otherwise. */
  spaceOpenObserver?: (space: MemorySpace) => void;

  /** IStorageManager (Phase 4): the currently-open spaces, for the
   * effects channel's construction-time sweep. */
  openedSpaces(): MemorySpace[] {
    return [...this.#providers.keys()];
  }

  open(space: MemorySpace): IStorageProvider {
    let provider = this.#providers.get(space);
    const firstOpen = !provider;
    if (!provider) {
      // Session principal drives user/session scoped storage. Even when we have
      // a derived space key for named spaces, the connection must authenticate
      // as the active user.
      const signer = this.as;
      const routeState: ProviderRouteState = { generation: 0 };
      provider = new Provider({
        as: signer,
        space,
        settings: this.#settings,
        subscription: this.#subscription,
        scopeKeyIdentity: () => this.scopeKeyIdentity(),
        routeState,
        createSession: this.#sessionFactory.supportsAclBootstrap === true
          ? (routeGeneration, routeSignal) =>
            this.#createInitializedSession(
              space,
              signer,
              routeState,
              routeGeneration,
              routeSignal,
            )
          : (_routeGeneration, routeSignal) =>
            this.#sessionFactory.create(space, signer, {
              sessionId: this.#sessionId,
            }, routeSignal),
        syncReplayDependencies: (document) =>
          this.syncCfcSchemaDocument(space, document),
        getTelemetry: () => this.#telemetry,
        eventAppendQueueStore: this.#eventAppendQueueStore,
      });
      this.#providers.set(space, provider);
    }
    if (firstOpen && this.spaceOpenObserver !== undefined) {
      // Deferred a microtask: the observer subscribes cells, which
      // re-enters open() and the sync machinery — never re-entrantly
      // inside the first open call.
      queueMicrotask(() => {
        try {
          this.spaceOpenObserver?.(space);
        } catch (error) {
          console.warn("spaceOpenObserver threw", error);
        }
      });
    }
    return provider;
  }

  /**
   * Mount the normal user session, but serialize fresh-space ACL genesis ahead
   * of any replica work when this manager holds the space key. The temporary
   * bootstrap session authenticates as the space identity; the returned
   * durable session always authenticates as `signer`, preserving user/session
   * scope partitioning.
   *
   * Named-space keys only initialize a truly fresh space, with the active user
   * as OWNER and wildcard WRITE as the rollout default. Populated ACL-less
   * spaces are the temporary public-compatibility case and stay public. The
   * home identity (`signer.did() === space`) is the explicit private exception:
   * it claims a never-created owner-only ACL even when legacy data already
   * exists. A retracted ACL remains a tombstone and must not be recreated.
   */
  async #createInitializedSession(
    space: MemorySpace,
    signer: Signer,
    routeState: ProviderRouteState,
    routeGeneration: number,
    routeSignal: AbortSignal,
  ): Promise<OpenedSpaceSession> {
    const assertCurrentRoute = (): void => {
      if (
        routeSignal.aborted ||
        routeState.generation !== routeGeneration
      ) {
        throw routeSignal.reason instanceof Error
          ? routeSignal.reason
          : new Error("memory replica route replaced");
      }
    };
    const activeClients = new Set<MemoryV2Client.Client>();
    const closeActiveClients = (): void => {
      for (const client of activeClients) {
        void client.close().catch(() => {});
      }
    };
    const track = (opened: OpenedSpaceSession): OpenedSpaceSession => {
      activeClients.add(opened.client);
      assertCurrentRoute();
      return opened;
    };
    routeSignal.addEventListener("abort", closeActiveClients, { once: true });
    let completed = false;

    try {
      assertCurrentRoute();
      const normal = track(
        await this.#sessionFactory.create(
          space,
          signer,
          { sessionId: this.#sessionId },
          routeSignal,
        ),
      );
      if (this.#sessionFactory.supportsAclBootstrap !== true) {
        completed = true;
        return normal;
      }
      const isHomeSpace = signer.did() === space;
      const spaceIdentity = isHomeSpace
        ? signer
        : this.#spaceIdentities.get(space);
      if (spaceIdentity === undefined) {
        completed = true;
        return normal;
      }

      const openedServerSeq = normal.session.serverSeq;
      const aclId = aclDocId(space);
      const aclResult = await normal.session.queryGraph({
        roots: [{ id: aclId, selector: { path: [], schema: false } }],
      });
      assertCurrentRoute();
      const aclSnapshot = aclResult.entities.find((entity) =>
        entity.id === aclId && (entity.scope ?? "space") === "space"
      );
      const aclNeverCreated = aclSnapshot?.seq === 0 &&
        aclSnapshot.document === null;
      if (!aclNeverCreated || (!isHomeSpace && openedServerSeq !== 0)) {
        completed = true;
        return normal;
      }

      // Do not reuse the bootstrap session for replica work: both it and the
      // replica allocate localSeq from 1, and named spaces must switch back from
      // the space signer to the active user before any user-scoped operation.
      // Preserve the normal session token before detaching it so the final user
      // mount resumes the construction-wide manager session instead of trying to
      // replace that still-live id without its token.
      const resumeNormal: MemoryV2Client.MountOptions = {
        sessionId: normal.session.sessionId,
        seenSeq: normal.session.serverSeq,
        ...(normal.session.sessionToken !== undefined
          ? { sessionToken: normal.session.sessionToken }
          : {}),
      };
      activeClients.delete(normal.client);
      await normal.client.close();
      assertCurrentRoute();
      let bootstrapSessionId = crypto.randomUUID();
      while (bootstrapSessionId === this.#sessionId) {
        bootstrapSessionId = crypto.randomUUID();
      }
      const bootstrap = track(
        await this.#sessionFactory.create(
          space,
          spaceIdentity,
          { sessionId: bootstrapSessionId },
          routeSignal,
        ),
      );
      try {
        assertCurrentRoute();
        const current = await bootstrap.session.queryGraph({
          roots: [{ id: aclId, selector: { path: [], schema: false } }],
        });
        assertCurrentRoute();
        const snapshot = current.entities.find((entity) =>
          entity.id === aclId && (entity.scope ?? "space") === "space"
        );
        // Recheck emptiness in the authority session. In `off` mode an
        // unrelated writer can still populate the space between the first
        // inspection and bootstrap; that turns it into the named legacy-public
        // case and must not be claimed. Home remains the explicit exception.
        const aclStillNeverCreated = snapshot?.seq === 0 &&
          snapshot.document === null;
        if (
          aclStillNeverCreated &&
          (isHomeSpace || current.serverSeq === 0)
        ) {
          try {
            const bootstrapAcl = isHomeSpace
              ? { [signer.did()]: "OWNER" }
              : { [signer.did()]: "OWNER", "*": "WRITE" };
            await bootstrap.session.transact({
              localSeq: 1,
              reads: {
                confirmed: [{
                  id: aclId,
                  path: toDocumentPath([]),
                  seq: snapshot?.seq ?? 0,
                }],
                pending: [],
              },
              operations: [{
                op: "set",
                id: aclId,
                value: { value: bootstrapAcl },
              }],
            }, () => {
              assertCurrentRoute();
              routeState.writeIssuedGeneration = routeGeneration;
            });
          } catch (error) {
            // A concurrent space-authorized initializer may win between the
            // point read and commit. Reopening as the user below is the
            // authoritative outcome: it succeeds only if the winning ACL grants
            // access. Other failures are real bootstrap errors.
            if (!(error instanceof Error) || error.name !== "ConflictError") {
              throw error;
            }
          }
        }
      } finally {
        activeClients.delete(bootstrap.client);
        await bootstrap.client.close();
      }

      assertCurrentRoute();
      const resumed = track(
        await this.#sessionFactory.create(
          space,
          signer,
          resumeNormal,
          routeSignal,
        ),
      );
      completed = true;
      return resumed;
    } finally {
      if (!completed) {
        routeSignal.removeEventListener("abort", closeActiveClients);
        await Promise.allSettled(
          [...activeClients].map((client) => client.close()),
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.#providers.size === 0) {
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroy()),
    );
    this.#providers.clear();
    this.#dataURISyncs.clear();
    this.#sessionId = crypto.randomUUID();
  }

  async closeNow(): Promise<void> {
    if (this.#providers.size === 0) {
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroyNow()),
    );
    this.#providers.clear();
    this.#dataURISyncs.clear();
    this.#sessionId = crypto.randomUUID();
  }

  edit(): IStorageTransaction {
    return V2Transaction.V2StorageTransaction.create(this);
  }

  synced(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    Promise.all(
      [...this.#providers.values()].map((provider) => provider.synced()),
    ).finally(() => this.resolveCrossSpace(resolve));
    return promise;
  }

  /**
   * INBOUND settlement only (server-execution v2 stage F): the serving
   * loop's wave-settle barrier. Awaits watch refreshes and update
   * processing across providers, but NOT commit settlement — a sealed
   * commit settles at the wave commit the loop performs after settling,
   * so the full `synced()` would deadlock against it (see
   * SpaceReplica.inputSynced).
   */
  async inputSynced(): Promise<void> {
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.inputSynced()),
    );
  }

  /**
   * A throwable `AuthorizationError` when `space` is under a permanent
   * authorization denial (an ACL shortfall, an audience or protocol mismatch),
   * or undefined when it is authorized or was never opened. Scoped to one space
   * on purpose: `synced()` stays silent so a denied cross-space link does not
   * fail an unrelated caller, and a caller that must access a specific space
   * reads this after `synced()` to surface the real failure.
   */
  authorizationError(space: MemorySpace): Error | undefined {
    return this.#providers.get(space)?.authorizationError();
  }

  trackPendingCommit(promise: Promise<unknown>): void {
    // Normalize so a rejected commit settles the barrier instead of leaking an
    // unhandled rejection; the caller keeps the original promise for results.
    const tracked = promise.then(() => {}, () => {});
    this.#pendingCommits.add(tracked);
    if (this.#pendingCommits.size === 1) {
      this.#notifyPendingCommits(true);
    }
    tracked.finally(() => {
      this.#pendingCommits.delete(tracked);
      if (this.#pendingCommits.size === 0) {
        this.#notifyPendingCommits(false);
      }
    });
  }

  hasPendingCommits(): boolean {
    return this.#pendingCommits.size > 0;
  }

  async pendingCommitsSettled(): Promise<void> {
    await Promise.allSettled([...this.#pendingCommits]);
  }

  /**
   * Observe transitions of the pending-commit state: `true` when the set of
   * unconfirmed commits becomes non-empty, `false` when it drains. Drives the
   * client-side "unconfirmed writes" flag (e.g. the shell's before-unload
   * guard). Returns an unsubscribe function.
   */
  subscribePendingCommits(callback: (pending: boolean) => void): () => void {
    this.#pendingCommitsSubscribers.add(callback);
    return () => this.#pendingCommitsSubscribers.delete(callback);
  }

  #notifyPendingCommits(pending: boolean): void {
    for (const callback of this.#pendingCommitsSubscribers) {
      try {
        callback(pending);
      } catch (error) {
        console.error("pending-commits subscriber threw:", error);
      }
    }
  }

  shouldPullDoc(space: MemorySpace, id: URI, scope?: CellScope): boolean {
    if (hasDataUriScheme(id)) {
      return false;
    }
    const key = `${space}\0${this.#pullKickKey(id, scope)}`;
    if (this.#docPullKicks.has(key)) {
      return false;
    }
    this.#docPullKicks.add(key);
    // State the local replica can already serve needs no pull. getState is
    // undefined both for never-pulled docs and for docs known to hold no
    // value (deleted / genuinely absent) — the second kind gets one harmless
    // kick and is then held off by the kick set above.
    return this.open(space).replica.get({
      id,
      type: DOCUMENT_MIME as MIME,
      scope,
    }) === undefined;
  }

  retractDocPullKick(space: MemorySpace, id: URI, scope?: CellScope): void {
    this.#docPullKicks.delete(`${space}\0${this.#pullKickKey(id, scope)}`);
  }

  /** Pull-kick keys are per scope INSTANCE (key-vocabulary.md §5's
   * M4-coupled list, stage F): name-keyed, A's kick suppressed B's pull
   * and B's doc never loaded at cardinality > 1. Resolved against the
   * manager's own identity — partition-unchanged at cardinality 1
   * (key-vocabulary.md §2). */
  #pullKickKey(id: URI, scope?: CellScope): string {
    return `${resolveScopeKey(scope, this.scopeKeyIdentity())}\0${id}`;
  }

  addCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.add(promise);
  }

  removeCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.delete(promise);
  }

  // In-flight document loads keyed `space/scope_key/id` (the scheduler's
  // entityKey format — one entry per scope INSTANCE, key-vocabulary.md §1
  // site 7: two instances of one doc are two loads, and collapsing them
  // would make one waiter observe another's failure). Keys are BUILT with
  // entityKey so the strings cross-match the scheduler's
  // (collectPendingLoadParkKeys correlates the two maps); both sides
  // resolve against this manager's own session identity.
  // Refcounted: concurrent syncCell calls for the same
  // document share one entry. Waiters resolve when the count returns to zero
  // — whether the load produced a value or found the document absent.
  #pendingLoads = new Map<string, {
    count: number;
    generation: number;
    address: { space: MemorySpace; scope: CellScope; id: URI };
    failure: unknown;
    waiters: Set<(failure: unknown) => void>;
  }>();
  #nextPendingLoadGeneration = 1;
  // Sync failures already logged, keyed by (space, error identity). A denied
  // space repeats the identical failure for every doc pulled from it; one line
  // per distinct failure keeps the surfacing readable. Bounded: at the cap the
  // set resets, trading a repeated line for an unbounded set.
  #loggedSyncFailures = new Set<string>();

  private registerPendingLoad(
    address: { space: MemorySpace; scope: CellScope; id: URI },
  ): (failure?: unknown) => void {
    const key = entityKey(address, this.scopeKeyIdentity());
    const entry = this.#pendingLoads.get(key) ??
      {
        count: 0,
        generation: this.#nextPendingLoadGeneration++,
        address,
        failure: undefined,
        waiters: new Set<(failure: unknown) => void>(),
      };
    entry.count++;
    this.#pendingLoads.set(key, entry);
    return (failure?: unknown) => {
      entry.failure ??= failure;
      entry.count--;
      if (entry.count > 0) return;
      this.#pendingLoads.delete(key);
      for (const waiter of entry.waiters) waiter(entry.failure);
      entry.waiters.clear();
    };
  }

  /** Log a sync failure that would otherwise resolve silently, once per
   * distinct (space, error) pair. The error name and message are the wire
   * server's own words — for an ACL denial that includes the principal and
   * space (`Principal <did> lacks READ on space <did>`), which is exactly
   * what a caller staring at an unexplained `undefined` needs. */
  private logSyncLoadFailure(
    space: MemorySpace,
    id: URI,
    failure: unknown,
  ): void {
    // Pull errors arrive as plain result objects (IConnectionError et al.),
    // not Error instances — read the fields structurally.
    const named = failure as { name?: unknown; message?: unknown } | undefined;
    const name = typeof named?.name === "string" ? named.name : "Error";
    const message = typeof named?.message === "string"
      ? named.message
      : String(failure);
    const key = `${space}|${name}|${message}`;
    if (this.#loggedSyncFailures.has(key)) return;
    if (this.#loggedSyncFailures.size >= 256) this.#loggedSyncFailures.clear();
    this.#loggedSyncFailures.add(key);
    logger.error("sync-load-failure", () => [
      `sync completed without data for ${id} in ${space}: ${name}: ${message}`,
    ]);
  }

  pendingLoadAddresses(): readonly {
    space: MemorySpace;
    scope: CellScope;
    id: URI;
  }[] {
    return [...this.#pendingLoads.values()].map((entry) => entry.address);
  }

  pendingLoadGeneration(key: string): number | undefined {
    return this.#pendingLoads.get(key)?.generation;
  }

  loadsSettled(keys: readonly string[]): Promise<void> {
    // Dedupe up front: `remaining` counts entries, but the shared onSettled is
    // added once per entry's waiter Set and fires once. A duplicated key would
    // inflate `remaining` without a matching callback, hanging the promise.
    const pending = [...new Set(keys)].filter((key) =>
      this.#pendingLoads.has(key)
    );
    if (pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let remaining = pending.length;
      let firstFailure: unknown;
      const onSettled = (failure: unknown) => {
        firstFailure ??= failure;
        remaining--;
        if (remaining !== 0) return;
        if (firstFailure !== undefined) reject(firstFailure);
        else resolve();
      };
      for (const key of pending) {
        this.#pendingLoads.get(key)!.waiters.add(onSettled);
      }
    });
  }

  trackUntilSettled(work: Promise<unknown>): void {
    const tracked = work.finally(() =>
      this.#crossSpacePromises.delete(tracked)
    ) as Promise<void>;
    this.#crossSpacePromises.add(tracked);
  }

  pendingCrossSpacePromiseCount(): number {
    return this.#crossSpacePromises.size;
  }

  crossSpaceSettled(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    void this.resolveCrossSpace(resolve);
    return promise;
  }

  subscribe(subscription: IStorageNotification): void {
    this.#subscription.subscribe(subscription);
  }

  unsubscribe(subscription: IStorageNotification): void {
    this.#subscription.unsubscribe(subscription);
  }

  async syncCell<T>(cell: Cell<T>): Promise<Cell<T>> {
    const { space, id, schema, scope } = cell.getAsNormalizedFullLink();
    if (!space) {
      throw new Error("No space set");
    }

    if (hasDataUriScheme(id)) {
      return this.syncDataURICell(cell, space, id, schema, scope);
    }

    const provider = this.open(space);
    const releaseLoad = this.registerPendingLoad({
      space,
      scope: normalizeCellScope(scope),
      id,
    });
    let loadFailure: unknown;
    try {
      const result = await provider.sync(id, {
        path: cell.path.map((segment) => segment.toString()),
        schema: schema ?? false,
      }, scope);
      loadFailure = result.error;
      const schemaFailure = await this.syncCfcSchemaDocument(
        space,
        (provider as {
          get?: (uri: URI, scope?: CellScope) => EntityDocument | undefined;
        }).get?.(id, scope),
      );
      loadFailure ??= schemaFailure;
      // A pull that "succeeds" while carrying an error (an ACL denial, a
      // transport failure) otherwise resolves this sync() normally and the
      // caller reads the doc as absent — deny, error, and absent all collapse
      // into the same silent undefined. Surface the failure; the pending-load
      // ledger below still carries it to scheduler waiters.
      if (loadFailure !== undefined) {
        this.logSyncLoadFailure(space, id, loadFailure);
      }
      return cell;
    } catch (error) {
      loadFailure = error;
      throw error;
    } finally {
      releaseLoad(loadFailure);
    }
  }

  private async syncCfcSchemaDocument(
    space: MemorySpace,
    document: EntityDocument | undefined,
  ): Promise<Error | undefined> {
    const cfc = isObjectOrArray(document?.cfc) ? document.cfc : undefined;
    const schemaHash = cfc?.schemaHash;
    if (typeof schemaHash !== "string" || schemaHash.length === 0) {
      return undefined;
    }
    const result = await this.open(space).sync(`cid:${schemaHash}` as URI, {
      path: [],
      schema: false,
    });
    return result.error;
  }

  private trackPendingProviderSync(
    address: { space: MemorySpace; scope: CellScope; id: URI },
    start: () => Promise<Result<Unit, Error>>,
  ): Promise<Result<Unit, Error>> {
    const releaseLoad = this.registerPendingLoad(address);
    let work: Promise<Result<Unit, Error>>;
    try {
      work = start();
    } catch (error) {
      releaseLoad(error);
      throw error;
    }
    return work.then(
      (result) => {
        // Same silent-collapse hazard as syncCell: a link-target pull that
        // resolves while carrying an error reads as an absent target.
        if (result.error !== undefined) {
          this.logSyncLoadFailure(address.space, address.id, result.error);
        }
        releaseLoad(result.error);
        return result;
      },
      (error) => {
        releaseLoad(error);
        throw error;
      },
    );
  }

  private resolveCrossSpace(resolve: () => void): Promise<void> {
    const promises = [...this.#crossSpacePromises.values()];
    if (promises.length === 0) {
      queueMicrotask(() => {
        if (this.#crossSpacePromises.size === 0) {
          resolve();
          return;
        }
        void this.resolveCrossSpace(resolve);
      });
      return Promise.resolve();
    }
    return Promise.all(promises)
      .then(() => undefined)
      .finally(() => this.resolveCrossSpace(resolve));
  }

  private async syncDataURICell<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
  ): Promise<Cell<T>> {
    const cacheKey = dataURISyncKey({
      id,
      schema,
      path: cell.path.map(String),
      space,
      scope,
    });
    let work = this.#dataURISyncs.get(cacheKey);
    if (work === undefined) {
      work = this.syncDataURILinkTargets(cell, space, id, schema, scope);
      this.#dataURISyncs.set(cacheKey, work);
    }
    await work;
    return cell;
  }

  private async syncDataURILinkTargets<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
  ): Promise<void> {
    let value: unknown = valueFromDataUri(id);
    for (const segment of [...cell.path.map(String)]) {
      if (!isObjectOrArray(value)) {
        return;
      }
      value = (value as Record<string, unknown>)[segment];
    }

    const base: NormalizedLink = {
      space,
      id: id as any,
      scope: normalizeCellScope(scope),
      path: [],
    };
    const promises: Promise<unknown>[] = [];
    this.collectLinkedCellSyncs(
      value,
      base,
      schema,
      promises,
      new Set(),
    );
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  private collectLinkedCellSyncs(
    value: unknown,
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    promises: Promise<unknown>[],
    seen: Set<unknown>,
  ): void {
    if (value === null || value === undefined || seen.has(value)) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    seen.add(value);

    if (isPrimitiveCellLink(value)) {
      const link = parseLinkPrimitive(value, base);
      if (link.id && !hasDataUriScheme(link.id)) {
        const space = link.space ?? base.space!;
        const scope = normalizeCellScope(
          link.scope as CellScope | undefined,
        );
        promises.push(
          this.trackPendingProviderSync(
            { space, scope, id: link.id },
            () =>
              this.open(space).sync(link.id!, {
                path: link.path.map((segment) => segment.toString()),
                schema: link.schema ?? schema ?? false,
              }, scope),
          ),
        );
      }
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemSchema = schema
          ? ContextualFlowControl.getSchemaAtPath(schema, [String(i)])
          : undefined;
        this.collectLinkedCellSyncs(
          item,
          base,
          itemSchema,
          promises,
          seen,
        );
      }
      return;
    }

    // TODO(danfuzz): `isObjectOrArray` admits a `FabricSpecialObject`, whose
    // `Object.keys` are empty, so a cell link held inside a `FabricInstance`
    // reconstructed from the data URI is never found here and its target
    // document is never synced — the later read finds it absent. (A
    // `FabricPrimitive` ends the walk harmlessly; it is a leaf.)
    if (isObjectOrArray(value)) {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (
          child === null || child === undefined || typeof child !== "object"
        ) {
          continue;
        }
        const childSchema = schema
          ? ContextualFlowControl.getSchemaAtPath(schema, [key])
          : undefined;
        this.collectLinkedCellSyncs(
          child,
          base,
          childSchema,
          promises,
          seen,
        );
      }
    }
  }
}

type ProviderRouteState = {
  generation: number;
  writeIssuedGeneration?: number;
};

type OpenedSpaceSession = {
  client: MemoryV2Client.Client;
  session: MemoryV2Client.SpaceSession;
};

type ProviderOptions = {
  as: Signer;
  space: MemorySpace;
  settings: IRemoteStorageProviderSettings;
  subscription: IStorageSubscription;
  /**
   * The owning manager's authenticated session identity
   * (IStorageManager.scopeKeyIdentity) — what the replica's notification
   * differentials resolve scoped change addresses against.
   */
  scopeKeyIdentity: () => ScopeKeyIdentity;
  routeState: ProviderRouteState;
  createSession: (
    routeGeneration: number,
    routeSignal: AbortSignal,
  ) => Promise<OpenedSpaceSession>;
  syncReplayDependencies: (
    document: EntityDocument | undefined,
  ) => Promise<Error | undefined>;
  /** Late-bound: resolves to the Runtime's telemetry bus once attached. */
  getTelemetry?: () => TelemetrySink | undefined;
  /** The LT9 event-intent persistence seam (see Options). */
  eventAppendQueueStore?: EventAppendQueueStore;
};

type SpaceReplicaOptions = Omit<ProviderOptions, "createSession"> & {
  routeGeneration: number;
  createSession: () => Promise<OpenedSpaceSession>;
};

type ProviderSyncRequest = {
  uri: URI;
  selector: SchemaPathSelector;
  scope?: CellScope;
};

/**
 * Minimal marker sink — structurally the Runtime's `RuntimeTelemetry`.
 * Kept structural (type-only import) so the storage layer takes no runtime
 * dependency on the telemetry module.
 */
type TelemetrySink = { submit(marker: RuntimeTelemetryMarker): void };

class Provider implements IStorageProvider {
  replica: SpaceReplica;
  // Registered reads to replay when a provisional replica is replaced, keyed
  // by document and then by the normalized selector. A normalized selector is
  // either the shared rejecting selector or an interned canonical instance,
  // and the entry holds it, so structurally equal selectors are the same
  // object here and identity separates them exactly.
  #syncRequests = new Map<
    string,
    Map<SchemaPathSelector, ProviderSyncRequest>
  >();
  #destroyed = false;
  #routeAbort = new AbortController();

  constructor(
    readonly options: ProviderOptions,
  ) {
    this.replica = this.createReplica();
  }

  private createReplica(): SpaceReplica {
    const routeGeneration = this.options.routeState.generation;
    const routeSignal = this.#routeAbort.signal;
    return new SpaceReplica({
      ...this.options,
      routeGeneration,
      createSession: () =>
        this.options.createSession(routeGeneration, routeSignal),
    });
  }

  send(
    batch: { uri: URI; value: EntityDocument | undefined }[],
  ): Promise<Result<Unit, Error>> {
    return this.replica.send(batch.map(({ uri, value }) => ({
      uri,
      document: value,
    }))) as Promise<Result<Unit, Error>>;
  }

  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, Error>> {
    const normalizedSelector = normalizeSyncSelector(selector);
    const key = docKey(uri, scope);
    let requests = this.#syncRequests.get(key);
    if (requests === undefined) {
      requests = new Map();
      this.#syncRequests.set(key, requests);
    }
    requests.set(normalizedSelector, {
      uri,
      selector: normalizedSelector,
      scope,
    });
    return this.replica.sync(uri, normalizedSelector, scope) as Promise<
      Result<Unit, Error>
    >;
  }

  private async replaySync(
    replica: SpaceReplica,
    uri: URI,
    selector: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, PullError>> {
    const result = await replica.sync(uri, selector, scope);
    if (result.error !== undefined || uri.startsWith("cid:")) {
      return result;
    }
    const dependencyFailure = await this.options.syncReplayDependencies(
      replica.getDocument(uri, scope),
    );
    return dependencyFailure === undefined
      ? result
      : { error: dependencyFailure as PullError };
  }

  private followReplacement<T>(
    read: (replica: SpaceReplica) => Promise<T>,
  ): Promise<T> {
    const replica = this.replica;
    return read(replica).then(
      (result) =>
        this.replica !== replica && !this.#destroyed
          ? read(this.replica)
          : result,
      (error) => {
        if (this.replica !== replica && !this.#destroyed) {
          return read(this.replica);
        }
        throw error;
      },
    );
  }

  canReplaceProvisionalReplica(): boolean {
    const { generation, writeIssuedGeneration } = this.options.routeState;
    return writeIssuedGeneration !== generation;
  }

  async replaceProvisionalReplica(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    const previous = this.replica;
    this.#routeAbort.abort(new Error("memory replica route replaced"));
    this.options.routeState.generation++;
    this.#routeAbort = new AbortController();
    const replacement = this.createReplica();
    this.replica = replacement;
    previous.redirectOverlappingReadsTo((uri, selector, scope) =>
      this.replaySync(replacement, uri, selector, scope)
    );
    previous.reset();
    previous.closeNow();
    const requests = [...this.#syncRequests.values()]
      .flatMap((bySelector) => [...bySelector.values()]);
    await Promise.all(
      requests.map(({ uri, selector, scope }) =>
        this.replaySync(replacement, uri, selector, scope)
      ),
    );
  }

  synced(): Promise<void> {
    return this.followReplacement((replica) => replica.synced());
  }

  /** See SpaceReplica.inputSynced (stage F's serving-loop barrier). */
  inputSynced(): Promise<void> {
    return this.followReplacement((replica) => replica.inputSynced());
  }

  authorizationError(): Error | undefined {
    return this.replica.authorizationError();
  }

  ensureSession(): Promise<void> {
    return this.followReplacement((replica) => replica.ensureSession());
  }

  listEntityIds(): Promise<string[] | undefined> {
    return this.followReplacement((replica) => replica.listEntityIds());
  }

  listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    return this.followReplacement((replica) =>
      replica.listEntityIdPage(options)
    );
  }

  entityIdExists(id: string): Promise<boolean | undefined> {
    return this.followReplacement((replica) => replica.entityIdExists(id));
  }

  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    return this.followReplacement((replica) =>
      replica.sqliteQuery(db, sql, params)
    );
  }

  sqliteServerCommitRowLabelEval(): boolean {
    return this.replica.sqliteServerCommitRowLabelEval();
  }

  registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    return this.replica.registerSqliteDiskSource(id, path);
  }

  get(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.replica.getDocument(uri, scope);
  }

  sink(
    uri: URI,
    callback: (value: EntityDocument | undefined) => void,
  ): Cancel {
    return this.replica.sinkDocument(uri, callback);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#routeAbort.abort(new Error("memory replica closed"));
    this.options.routeState.generation++;
    await this.replica.close();
  }

  async destroyNow(): Promise<void> {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#routeAbort.abort(new Error("memory replica closed"));
      this.options.routeState.generation++;
    }
    await this.replica.closeNow();
  }
}

type SyncTask = {
  entries: [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector][];
  promise: Promise<Result<Unit, PullError>>;
};

type WatchRefreshBatch = {
  type: "pull" | "integrate";
  entries: Map<
    string,
    [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector]
  >;
  pending: PromiseWithResolvers<Result<Unit, PullError>>;
};

type NativeCommitOperation =
  | {
    op: "set";
    id: URI;
    scope?: CellScope;
    value: EntityDocument;
  }
  | {
    op: "patch";
    id: URI;
    scope?: CellScope;
    patches: PatchOp[];
    value: EntityDocument;
  }
  | { op: "delete"; id: URI; scope?: CellScope };

class StorageTransactionRejectionError extends Error {
  constructor(readonly rejection: StorageTransactionRejected) {
    super(rejection.message);
    this.name = rejection.name;
  }
}

/**
 * A commit that has been issued (optimistic write applied, verdict not yet
 * settled) and that carries PENDING reads — i.e. its read set depends on
 * another in-flight commit's optimistic state. Tracked in `#inFlightCommits`
 * so that when a dependency's optimistic writes are dropped (`dropPending`),
 * the dependants can be rejected locally instead of waiting for the server's
 * inevitable "pending dependency not resolved" (CT-1872 1b).
 *
 * Commits with NO pending reads are deliberately never registered: a
 * zero-read mergeable/blind commit is DESIGNED to survive a parent drop (the
 * server materializes its spine via createMissing — CT-1872 1a), and the
 * scheduler-observation batch wrapper carries no reads at all. Cascading
 * either would break intended semantics.
 */
type InFlightCommit = {
  readonly localSeq: number;
  /**
   * The unique localSeqs named by `commit.reads.pending` — every in-flight
   * commit this one's read view sits on (resolution-only lower-layer reads
   * carry the same `localSeq` field, so they contribute here too).
   */
  readonly dependencies: ReadonlySet<number>;
  readonly operations: NativeCommitOperation[];
  readonly source?: IStorageTransaction;
  readonly commit: ClientCommit;
  /**
   * Resolves when a rejection is fabricated locally for this commit (a
   * pending dependency was dropped, or the replica reset). Raced against the
   * server verdict in `pushCommit`.
   */
  readonly localRejection: PromiseWithResolvers<StorageTransactionRejected>;
  /**
   * Set synchronously BEFORE `localRejection` resolves, so `pushCommit`'s
   * pre-send checkpoints can observe the rejection without racing the
   * microtask queue. `undefined` means "not locally rejected".
   */
  localRejectionValue?: StorageTransactionRejected;
  /** True once `pushCommit`'s finally ran — the outcome is finalized and the
   * entry can no longer be cascaded. */
  settled: boolean;
};

const docKey = (id: URI, scope?: CellScope): string =>
  `${normalizeCellScope(scope)}\0${id}`;

class SpaceReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #subscription: IStorageSubscription;
  readonly #scopeKeyIdentity: () => ScopeKeyIdentity;
  readonly #createSession: () => Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  #sessionHandle?: Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  /** The client of the last RESOLVED session handle — for synchronous
   *  capability reads (`sqliteServerCommitRowLabelEval`). */
  #sessionClient?: MemoryV2Client.Client;
  /** The session of the last RESOLVED handle — read synchronously so
   *  `authorizationError()` can observe a denial that terminated the session
   *  during reconnect, which closes its watch view without a fresh watch result
   *  to record. */
  #sessionSession?: MemoryV2Client.SpaceSession;
  readonly #docs = new Map<string, DocumentRecord>();
  readonly #syncTasks = new Map<string, SyncTask>();
  readonly #commitPromises = new Set<
    Promise<Result<Unit, StorageTransactionRejected>>
  >();
  // Issued-but-unsettled commits that carry pending reads, keyed by localSeq.
  // Scanned by cascadeDroppedDependency when a dependency's optimistic writes
  // are dropped. See the InFlightCommit doc for why zero-pending-read commits
  // are never registered.
  readonly #inFlightCommits = new Map<number, InFlightCommit>();
  // Every unsettled commit's outcome promise, keyed by localSeq (a superset
  // of #inFlightCommits: zero-read commits appear here too). The old-server
  // scalarization hold awaits these for the OMITTED lower dependencies —
  // entries are removed on settlement, so an absent key means "settled".
  readonly #commitOutcomeBySeq = new Map<
    number,
    Promise<unknown>
  >();
  // Server verdict promises superseded by a local rejection. Kept OUT of
  // #commitPromises so synced() never blocks on a verdict the server may
  // withhold indefinitely; close()/closeNow() drain the set after client
  // teardown rejects every in-flight request.
  readonly #suppressedVerdicts = new Set<Promise<void>>();
  readonly #syncPromises = new Set<Promise<Result<Unit, PullError>>>();
  readonly #updatePromises = new Set<Promise<void>>();
  readonly #sinks = new Map<
    string,
    Set<(document: EntityDocument | undefined) => void>
  >();
  #watchView: MemoryV2Client.WatchView | null = null;
  // The specific view instance that `consumeUpdates` is iterating. This can
  // diverge from `#watchView` (the client may hand back a fresh view instance
  // on a later refresh while the original consumer keeps running), so teardown
  // must close *this* view to settle the consumer's pending `next()`. Closing
  // only `#watchView` can leave the consumer's view open, hanging dispose() on
  // `Promise.allSettled([...#updatePromises])`.
  #subscribedWatchView: MemoryV2Client.WatchView | null = null;
  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
    () => this.#scopeKeyIdentity(),
  );
  #watchedIds = new Set<string>();
  #nextLocalSeq = 1;
  /** The Phase-3 event-intent queue (events.md §5, LT9), created on the
   * first fire into this space. Owns fired-order discharge and the
   * duplicate-as-delivered classification; its entries are the client's
   * offline event queue. */
  #eventAppendQueue?: EventAppendQueue;
  #eventAppendQueueStore?: EventAppendQueueStore;
  #closed = false;
  readonly #closeSignal = Promise.withResolvers<void>();
  #getTelemetry: () => TelemetrySink | undefined;
  #caughtUpLocalSeq = 0;
  // Accepted verdicts PARKED until marker coverage (CT-1927): the server
  // stages a `caughtUpLocalSeq` obligation for every accept, and the client
  // holds the commit's promotion — pending overlay to confirmed mirror —
  // until a frame's marker covers it, so promotion extrapolates over a base
  // that reflects the foreign novelty the accept was applied on top of
  // instead of minting a confirmed state from a stale mirror. Verdicts
  // return inline (the fan-out stays batched); only their state application
  // waits. Applied in ascending localSeq order by noteCaughtUpLocalSeq;
  // cleared on reset (the re-pull re-derives the durable state).
  #parkedAccepts = new Map<number, {
    operations: NativeCommitOperation[];
    applied: AppliedCommit;
    /** Resolves when the parked application runs — the commit promise's
     * resolution point (CT-1950): the caller may then act on its
     * subscribed view as one reflecting the committed write. */
    settled: PromiseWithResolvers<void>;
  }>();
  // Waiters on a parked accept's APPLICATION (server-execution v2 stage
  // G's read-consistency barrier — see `whenApplied`). Resolved when the
  // parked accept promotes (marker coverage, marker-channel death) or
  // dies with the parked set (reset/close — the re-pull re-derives the
  // durable state, so "applied" is moot and the waiter must not hang).
  #appliedWaiters = new Map<number, PromiseWithResolvers<void>>();
  // Foreign novelty whose VISIBILITY is still shadowed by own pending
  // writes (server-execution v2 Phase 2's settle input barrier — see
  // `unappliedForeignSeqFloor` on ISpaceReplica): docKey -> the set of
  // shadowed inbound seqs. A SET, not one extremum (review thread
  // r3739139487): the floor must be the doc's LOWEST hidden seq —
  // every derivation in the wave read the view from before the
  // EARLIEST hidden input, so W may not pass it even when later hidden
  // updates superseded its value (the previous per-doc max let W skip
  // the earlier one) — while the own-echo verdict repair must remove
  // EXACTLY its own mis-recorded seq without disturbing genuine
  // foreign shadows folded around it (a single min would be deleted
  // whole, losing them). A shadowed REMOVE records the sentinel 1 —
  // the wire carries no seq for removes, so the floor holds W entirely
  // until the shadow clears. Entries are pruned lazily when the doc's
  // pending set empties (promotion, drop, rollback); cleared whole on
  // reset.
  readonly #shadowedForeignSeqs = new Map<string, Set<number>>();
  // The settle input barrier's WAKE (ISpaceReplica.shadowFlipObserver):
  // invoked synchronously whenever a confirmPending promotion touched a
  // doc with a standing shadow (flag ON — the flip checkout's own
  // condition), value diff or not: the FLOOR lifts either way, and the
  // floor is what the wake exists for. The SpaceServer installs it at
  // activation so a clamped-then-quiet space's catch-up wave runs at
  // the flip instead of waiting out the idle window — the flip is the
  // one input whose dirtiness arrives WITHOUT a new admitted commit on
  // the host feed (the commit was drained waves ago; only its
  // VISIBILITY changed).
  shadowFlipObserver: (() => void) | undefined;
  // localSeq -> the store seq its accept committed at (server-execution
  // v2 Phase 2, speculation.md §4): the overlay destination's retirement
  // floor is "the origin ACKED and W ≥ that commit's seq", and the ack
  // seq is otherwise consumed by promotion. Bounded (insertion-ordered,
  // oldest pruned) — the overlay only ever asks about recent origins.
  readonly #ackedSeqsByLocalSeq = new Map<number, number>();
  static readonly #MAX_RETAINED_ACK_SEQS = 4096;
  // localSeqs of live SPECULATIVE sealed commits (server-execution v2
  // Phase 2, speculation.md §1/§6): overlay entries exist only in this
  // process — the client never pushes them — so a PUSHED commit whose
  // read basis names one can NEVER have that dependency resolve
  // server-side. commitOperations refuses such an export loudly
  // (RULED 2026-08-13); membership ends when the speculative commit
  // settles (retirement/withdrawal drops its pending layers first, so
  // no stack names a seq after it leaves this set).
  readonly #speculativeLocalSeqs = new Set<number>();
  // The overlay destination's retirement WAKE for origin accepts
  // (ISpaceReplica.speculationAckObserver, speculation.md §4): fired
  // when a pushed commit's accept records its ack seq. Without it, an
  // entry whose sweep ran while its origin's verdict was still in
  // flight (blocked on the unacked layer) — and whose covering
  // watermark event therefore passed — stayed pending forever on a
  // then-quiet space: rejected origins cascade into the entry, but
  // ACCEPTED origins had no client-side wake. Guarded at the call
  // site — an observer throw must not corrupt accept settlement.
  speculationAckObserver: (() => void) | undefined;
  #caughtUpLocalSeqWaiters: {
    localSeq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];
  // docKey -> required caughtUpLocalSeq. An entry means "this id conflicted and
  // is stale until we observe caughtUpLocalSeq >= value". Pruned as the runner
  // catches up; only populated while conflict admission control is enabled.
  #staleFloor = new Map<string, number>();
  #queuedWatchRefresh: WatchRefreshBatch | null = null;
  #queuedWatchRefreshScheduled = false;
  // Number of watch-refresh round trips currently awaiting a response. Capped
  // at `#maxWatchRefreshInFlight()` (1 = single-flight; the concurrent window
  // otherwise) so a large incrementally-discovered wave cannot put an unbounded
  // number of requests on the wire.
  #watchRefreshInFlight = 0;
  // The current PERMANENT authorization denial for this space (an ACL shortfall,
  // an audience or protocol mismatch), or null when the space is authorized. A
  // non-retriable AuthorizationError from a watch refresh sets it; a successful
  // refresh clears it; a retriable auth race and a transient transport error
  // leave it untouched, so a blip or token-refresh window does not register as a
  // denial. `authorizationError()` reports it as a throwable error; `synced()`
  // stays silent so a denied cross-space link remains a silent absent read.
  #lastAuthorizationError: IAuthorizationError | null = null;
  readonly #routeState: ProviderRouteState;
  readonly #routeGeneration: number;
  #replacementRead:
    | ((
      uri: URI,
      selector: SchemaPathSelector,
      scope?: CellScope,
    ) => Promise<Result<Unit, PullError>>)
    | undefined;

  #settings: IRemoteStorageProviderSettings;

  constructor(options: SpaceReplicaOptions) {
    this.#space = options.space;
    this.#subscription = options.subscription;
    this.#scopeKeyIdentity = options.scopeKeyIdentity;
    this.#createSession = options.createSession;
    this.#getTelemetry = options.getTelemetry ?? (() => undefined);
    this.#settings = options.settings;
    this.#routeState = options.routeState;
    this.#routeGeneration = options.routeGeneration;
    this.#eventAppendQueueStore = options.eventAppendQueueStore;
    // Eager queue init (LT9; verdict blocker, 2026-08-12): a persisted
    // backlog — a dead predecessor's intents in the manager-shared
    // store, or a durable adapter's reload survivors — must discharge
    // WITHOUT waiting for a fresh fire. The constructor's load kicks
    // the drain iff rows exist; an empty load is inert (no session is
    // established until something discharges).
    this.#ensureEventAppendQueue();
  }

  did(): MemorySpace {
    return this.#space;
  }

  redirectOverlappingReadsTo(
    replacementRead: (
      uri: URI,
      selector: SchemaPathSelector,
      scope?: CellScope,
    ) => Promise<Result<Unit, PullError>>,
  ): void {
    this.#replacementRead = replacementRead;
  }

  get(entry: IMemoryAddress): State | undefined {
    return this.getState(entry.id as URI, entry.scope);
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, PullError>> {
    const replacementAtStart = this.#replacementRead;
    const result = await this.pull([[
      { id: uri, type: DOCUMENT_MIME as MIME, scope },
      selector,
    ]]);
    const replacement = this.#replacementRead;
    if (replacementAtStart === undefined && replacement !== undefined) {
      return await replacement(
        uri,
        normalizeSyncEntries([[
          { id: uri, type: DOCUMENT_MIME, scope },
          selector,
        ]])[0][1],
        scope,
      );
    }
    return result;
  }

  sinkDocument(
    uri: URI,
    callback: (document: EntityDocument | undefined) => void,
  ): Cancel {
    const key = docKey(uri);
    let subscribers = this.#sinks.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.#sinks.set(key, subscribers);
    }
    subscribers.add(callback);
    void this.sync(uri);
    return () => {
      const current = this.#sinks.get(key);
      current?.delete(callback);
      if (current && current.size === 0) {
        this.#sinks.delete(key);
      }
    };
  }

  async send(
    batch: { uri: URI; document: EntityDocument | undefined }[],
  ): Promise<Result<Unit, PushError>> {
    const operations = batch.map(({ uri, document }) =>
      document === undefined ? { op: "delete" as const, id: uri } : {
        op: "set" as const,
        id: uri,
        value: document,
      }
    );
    return await this.commitOperations(operations, undefined);
  }

  async synced(): Promise<void> {
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  /**
   * INBOUND settlement only (server-execution v2 stage F): outstanding
   * watch refreshes/pulls, EXCLUDING commit settlement AND update
   * processing. The serving loop's wave settle needs "requested input
   * has arrived" — but a SEALED commit's settlement resolves only at
   * the wave commit the loop performs AFTER settling, and update
   * PROCESSING can park behind that same sealed commit (promotion
   * ordering), so awaiting either is a deadlock by construction (broken
   * only by the flush deadline — observed as every first wave of a
   * burst flushing at T_flush). Client code keeps `synced()`:
   * durability is exactly what a client barrier means.
   *
   * The stage-F residual — a foreign authored frame parked behind an
   * own sealed commit could be claimed by W one wave early — is CLOSED
   * as of Phase 2 (the plan's revisit (a)), by exclusion rather than by
   * awaiting: this barrier still never waits on parked applications
   * (the deadlock above), and the wave instead EXCLUDES still-shadowed
   * seqs from its W advance via `unappliedForeignSeqFloor`, with the
   * shadow-flip notification in `confirmPending` registering the
   * dirtiness the moment the parked overlay leaves.
   */
  async inputSynced(): Promise<void> {
    await Promise.all([...this.#syncPromises]);
  }

  /**
   * A real, throwable `AuthorizationError` when this space is under a permanent
   * authorization denial, or undefined when it is authorized. `synced()`
   * deliberately does NOT throw this: a denied cross-space link must stay a
   * silent absent read (the sync-load-failure surfacing contract), and the
   * global sync barrier aggregates every space, so throwing there would fail a
   * whole runtime settle on an incidental unauthorized link. A caller that cares
   * about a SPECIFIC space — the CLI, opening the space it was asked to act on —
   * reads this after `synced()` and surfaces it deliberately.
   *
   * A watch refresh records the denial in most cases. A permanent denial during
   * RECONNECT is the exception: the memory client terminates the session and
   * closes its watch view without another refresh result (see the client's
   * `SpaceSession.restore`), so `#lastAuthorizationError` never captures it and a
   * caller that only reaches `synced()` without a further pull would see the
   * space as authorized. Consult the terminated session directly for that case.
   */
  authorizationError(): Error | undefined {
    if (this.#lastAuthorizationError !== null) {
      return authorizationErrorToThrow(this.#lastAuthorizationError);
    }
    // `terminateSession` stores a permanent AuthorizationError as the session's
    // close error; a graceful close ("memory session closed") or a takeover
    // revocation (SessionRevokedError) carries a different name and is not an
    // authorization denial for this space, so only the AuthorizationError is
    // surfaced here.
    const closeError = this.#sessionSession?.closeError;
    if (closeError !== undefined && closeError.name === "AuthorizationError") {
      return closeError;
    }
    return undefined;
  }

  /**
   * Record the authorization status a watch refresh result implies. A permanent
   * (non-retriable) AuthorizationError becomes the sticky failure
   * `authorizationError()` reports; a successful refresh proves the session is
   * authorized and clears it. A transient connection error or a retriable auth
   * race leaves the last known status unchanged, so a blip does not mask or
   * manufacture a denial.
   */
  private noteAuthorizationStatus(result: Result<Unit, PullError>): void {
    if (result.error) {
      if (
        result.error.name === "AuthorizationError" &&
        (result.error as { retriable?: unknown }).retriable !== true
      ) {
        this.#lastAuthorizationError = result.error as IAuthorizationError;
      }
      return;
    }
    this.#lastAuthorizationError = null;
  }

  async ensureSession(): Promise<void> {
    await this.activeSessionHandle();
  }

  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    const { session } = await this.activeSessionHandle();
    return await session.sqliteQuery(db, sql, params);
  }

  async listEntityIds(): Promise<string[] | undefined> {
    const { client, session } = await this.activeSessionHandle();
    if (client.serverFlags?.entityIdListing !== true) {
      return undefined;
    }
    if (client.serverFlags.entityIdPagination !== true) {
      return (await session.listEntityIds())?.ids;
    }

    const ids: string[] = [];
    let after: string | undefined;
    let expectedServerSeq: number | undefined;
    for (;;) {
      const page = await session.listEntityIds({
        ...(after === undefined ? {} : { after }),
        ...(expectedServerSeq === undefined ? {} : { expectedServerSeq }),
      });
      if (page === undefined) return undefined;
      expectedServerSeq ??= page.serverSeq;
      ids.push(...page.ids);
      if (page.nextAfter === undefined) return ids;
      after = page.nextAfter;
    }
  }

  async listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    const { client, session } = await this.activeSessionHandle();
    if (
      client.serverFlags?.entityIdListing !== true ||
      client.serverFlags.entityIdPagination !== true
    ) {
      return undefined;
    }
    return await session.listEntityIds(options);
  }

  async entityIdExists(id: string): Promise<boolean | undefined> {
    const { client, session } = await this.activeSessionHandle();
    if (client.serverFlags?.entityIdLookup !== true) {
      return undefined;
    }
    return (await session.entityIdExists(id))?.exists;
  }

  /**
   * Whether the server this replica is connected to advertised commit-time
   * row-label evaluation (`sqliteCommitRowLabelEval`) in its handshake.
   * Synchronous — the sqlite write gate runs inside `db.exec` — so it reads
   * the LIVE client of the last resolved session: `false` until a session
   * exists (fail closed; by the time a handler can call `db.exec`, its cells
   * have synced through a session) and refreshed by reconnect handshakes.
   */
  sqliteServerCommitRowLabelEval(): boolean {
    return this.#sessionClient?.serverFlags?.sqliteCommitRowLabelEval === true;
  }

  async registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    const { session } = await this.activeSessionHandle();
    return await session.registerSqliteDiskSource(
      id,
      path,
      () => this.markRouteWriteIssued(),
    );
  }

  getDocument(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.visibleDocument(uri, scope);
  }

  /** Whether an optimistic local write for this doc is still pending — not
   *  yet promoted into the confirmed mirror (a parked accept keeps it
   *  pending until its marker arrives; CT-1927). */
  hasPendingWrite(id: URI, scope?: CellScope): boolean {
    const record = this.#docs.get(docKey(id, scope));
    return record !== undefined && record.pending.length > 0;
  }

  /** ISpaceReplica.speculationRetirementView (server-execution v2
   * Phase 2, speculation.md §4): the doc's confirmed seq plus every
   * pending layer's localSeq — the overlay destination's retirement
   * inputs. */
  speculationRetirementView(
    id: URI,
    scope?: CellScope,
  ): { confirmedSeq: number; pendingLocalSeqs: number[] } {
    const record = this.#docs.get(docKey(id, scope));
    if (record === undefined) {
      return { confirmedSeq: 0, pendingLocalSeqs: [] };
    }
    return {
      confirmedSeq: record.confirmed.seq,
      pendingLocalSeqs: [
        ...new Set(record.pending.map((entry) => entry.localSeq)),
      ],
    };
  }

  /** ISpaceReplica.ackedSeqOf (server-execution v2 Phase 2,
   * speculation.md §4): the store seq a local commit's accept committed
   * at, or undefined while it is unsettled — or if it was rejected, or
   * pruned from the bounded record (both read as "no ack floor": the
   * entry falls back to its confirmed read basis). */
  ackedSeqOf(localSeq: number): number | undefined {
    return this.#ackedSeqsByLocalSeq.get(localSeq);
  }

  /**
   * Resolves when the accepted commit at `localSeq` has been APPLIED to
   * this replica's settled view — immediately when its accept was
   * confirmed at verdict time, else when its PARKED accept promotes
   * (marker coverage via noteCaughtUpLocalSeq, or marker-channel death)
   * or dies with the parked set (reset/close, where the re-pull
   * re-derives the durable state).
   *
   * Server-execution v2 stage G's effect-retirement read barrier
   * (serving-loop.md §4): the outbox holds an effect's in-flight entry
   * until every completion commit's writes are readable, so a stale
   * re-admit of the same key dedupes instead of re-claiming against
   * unabsorbed state and firing a second egress. Since F1a
   * (settleSealedCommit → confirmPending), sealed commits — waves and
   * effect completions alike — confirm at verdict time and never park,
   * so for completions this resolves immediately: the barrier is the
   * BELT over that structural guarantee, and the parked branch below
   * remains for pushed (socket) commits under CT-1927.
   *
   * Callers sequence this AFTER the sealed commit's `settled` promise:
   * the confirm (or, for pushed commits, settleAccept's park-or-confirm
   * decision) runs inside settlement, so consulting the parked set
   * before settlement would race it.
   */
  /**
   * Queue one event append for this space (server-execution v2 Phase 3;
   * events.md §1, §5): the client's ONLY computational commit under the
   * flag. Fired-order discharge with retry across transport loss and
   * session replacement; a duplicate above the stream's dedupe horizon
   * resolves as delivered (`EventAppendDuplicateError` — events.md §5's
   * duplicate-submission rule). The returned promise settles with the
   * delivery outcome; rendering never waits on it (the echo is local).
   */
  enqueueEventAppend(
    append: Omit<QueuedEventAppend, "clientSeq"> & { clientSeq?: number },
  ): Promise<EventAppendOutcome> {
    return this.#ensureEventAppendQueue().enqueue(append);
  }

  /** Pending (undischarged) event intents — the offline queue's live
   * content, bounded by pending-intent count (speculation.md §5). */
  pendingEventAppends(): readonly QueuedEventAppend[] {
    return this.#eventAppendQueue?.pending ?? [];
  }

  #ensureEventAppendQueue(): EventAppendQueue {
    if (this.#eventAppendQueue === undefined) {
      this.#eventAppendQueue = new EventAppendQueue({
        space: this.#space,
        transact: async (commit) => {
          const { session } = await this.activeSessionHandle();
          // The route-write marker rides the SAME beforeIssue hook as
          // ordinary commits (verdict blocker, 2026-08-12): an event
          // append is a stateful operation against this route, so once
          // one has issued, canReplaceProvisionalReplica() must answer
          // false — a late host hint may no longer swap the replica out
          // underneath the queue and strand its traffic on a closed
          // route.
          return await session.transact(
            commit,
            () => this.markRouteWriteIssued(),
          );
        },
        // Allocated at SEND time from the replica's one counter, so the
        // increasing-localSeq send-order discipline (04-protocol §3.9)
        // holds across event appends and ordinary commits alike.
        nextLocalSeq: () => this.#nextLocalSeq++,
        store: this.#eventAppendQueueStore,
      });
    }
    return this.#eventAppendQueue;
  }

  whenApplied(localSeq: number): Promise<void> {
    if (!this.#parkedAccepts.has(localSeq)) return Promise.resolve();
    let waiter = this.#appliedWaiters.get(localSeq);
    if (waiter === undefined) {
      waiter = Promise.withResolvers<void>();
      this.#appliedWaiters.set(localSeq, waiter);
    }
    return waiter.promise;
  }

  private resolveAppliedWaiter(localSeq: number): void {
    const waiter = this.#appliedWaiters.get(localSeq);
    if (waiter !== undefined) {
      this.#appliedWaiters.delete(localSeq);
      waiter.resolve();
    }
  }

  /**
   * ISpaceReplica.unappliedForeignSeqFloor (server-execution v2 Phase 2's
   * settle input barrier): the lowest inbound seq still shadowed by an
   * own pending write, or `undefined` when nothing is. Prunes lazily —
   * an entry whose doc no longer has pending writes has become visible
   * (promotion fired the shadow-flip notification; a drop re-exposes the
   * confirmed value through the rejection path's own re-runs), so it no
   * longer bounds the wave's advance.
   */
  unappliedForeignSeqFloor(): number | undefined {
    if (this.#shadowedForeignSeqs.size === 0) return undefined;
    let floor: number | undefined;
    for (const [key, seqs] of this.#shadowedForeignSeqs) {
      const record = this.#docs.get(key);
      if (
        record === undefined || record.pending.length === 0 ||
        seqs.size === 0
      ) {
        this.#shadowedForeignSeqs.delete(key);
        continue;
      }
      for (const seq of seqs) {
        if (floor === undefined || seq < floor) floor = seq;
      }
    }
    return floor;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closeSignal.resolve();
    this.#eventAppendQueue?.close();
    this.resetConflictAdmissionState();
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    // Settle any queued (not-yet-sent) watch refresh first so its pull promise
    // cannot outlive close(); `#closed` also makes refreshWatchSet fail closed
    // for any refresh already in flight.
    this.cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    // Also close the view the update consumer is bound to, in case it diverged
    // from #watchView; otherwise its pending next() never settles and the
    // `Promise.allSettled([...#updatePromises])` below hangs forever.
    this.#subscribedWatchView?.close();
    this.#subscribedWatchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      let resolved:
        | {
          client: MemoryV2Client.Client;
          session: MemoryV2Client.SpaceSession;
        }
        | undefined;
      try {
        resolved = await sessionHandle;
      } catch {
        resolved = undefined;
      }
      if (resolved !== undefined) {
        // Closing the client rejects every in-flight request (pulls/watch
        // refreshes) with a ConnectionError and closes the session's watch
        // view — the generic drain for any open watch, not just the two views
        // tracked above.
        await resolved.client.close();
      }
    }
    // With the client closed, every in-flight commit and read/watch pull has
    // been rejected and now settles promptly. Awaiting them here can no longer
    // hang and guarantees no transport promise is left pending when close()
    // resolves. Suppressed verdicts (server responses superseded by a local
    // rejection) live outside #commitPromises and join the same drain.
    await Promise.allSettled([
      ...this.#commitPromises,
      ...this.#suppressedVerdicts,
    ]);
    await Promise.allSettled([...this.#syncPromises]);
    await Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
  }

  private resetConflictAdmissionState(): void {
    this.#caughtUpLocalSeq = 0;
    this.#staleFloor.clear();
    // Parked accepts die with the marker space: on reset the re-pull
    // re-derives durable state (which contains the accepted writes), and on
    // close there is nothing left to promote into. Their promises RESOLVE —
    // the commits succeeded durably; a caller must never see a durable
    // success reported as failure (CT-1950).
    for (const entry of this.#parkedAccepts.values()) {
      entry.settled.resolve();
    }
    this.#parkedAccepts.clear();
    // Their applied-waiters resolve rather than hang: the accepted writes
    // now arrive (or died) through the re-pull, so the barrier's question
    // — "has the settled view moved past the accept?" — is answered.
    for (const waiter of this.#appliedWaiters.values()) {
      waiter.resolve();
    }
    this.#appliedWaiters.clear();
    // Shadowed-foreign floors die with the marker space too: the re-pull
    // re-derives the durable state, so nothing stays invisible.
    this.#shadowedForeignSeqs.clear();
    this.#ackedSeqsByLocalSeq.clear();
  }

  private noteCaughtUpLocalSeq(localSeq: number | undefined): void {
    if (localSeq === undefined) {
      return;
    }
    this.#caughtUpLocalSeq = Math.max(this.#caughtUpLocalSeq, localSeq);
    // Apply parked accepts the marker now covers, ascending, BEFORE waking
    // marker waiters: gated code (readyToRetry retries) resumes against a
    // replica where every promotion COVERED BY THIS MARKER is settled.
    // Accepts decided but not yet covered — verdict received, coverage
    // still outstanding (the two moments CT-1950 splits) — remain parked
    // past this wake: their pending overlays stay visible and their
    // settlement promises unresolved until their own marker arrives.
    if (this.#parkedAccepts.size > 0) {
      const due = [...this.#parkedAccepts.keys()]
        .filter((parked) => parked <= this.#caughtUpLocalSeq)
        .sort((left, right) => left - right);
      for (const parked of due) {
        // Re-entrancy guard (Phase 2): confirmPending's flag-ON
        // shadow-flip notification runs subscriber callbacks
        // synchronously, and a callback that re-enters the replica
        // (reset, applyParkedAcceptsNow via a closing watch view) can
        // consume parked entries out from under this loop — so the
        // lookup tolerates an entry another frame already applied.
        const entry = this.#parkedAccepts.get(parked);
        if (entry === undefined) continue;
        this.#parkedAccepts.delete(parked);
        this.confirmPending(parked, entry.operations, entry.applied);
        entry.settled.resolve();
      }
    }
    const ready: PromiseWithResolvers<void>[] = [];
    this.#caughtUpLocalSeqWaiters = this.#caughtUpLocalSeqWaiters.filter(
      (waiter) => {
        if (waiter.localSeq <= this.#caughtUpLocalSeq) {
          ready.push(waiter.pending);
          return false;
        }
        return true;
      },
    );
    for (const pending of ready) {
      pending.resolve();
    }
    // Ids whose staleness has now been caught up are fresh again; stop
    // pre-empting commits that read them.
    if (this.#staleFloor.size > 0) {
      for (const [key, floor] of this.#staleFloor) {
        if (floor <= this.#caughtUpLocalSeq) {
          this.#staleFloor.delete(key);
        }
      }
    }
  }

  private waitForCaughtUpLocalSeq(localSeq: number): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("memory replica closed"));
    }
    if (this.#caughtUpLocalSeq >= localSeq) {
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    this.#caughtUpLocalSeqWaiters.push({ localSeq, pending });
    return pending.promise;
  }

  private rejectCaughtUpLocalSeqWaiters(error: Error): void {
    const waiters = this.#caughtUpLocalSeqWaiters;
    this.#caughtUpLocalSeqWaiters = [];
    for (const waiter of waiters) {
      waiter.pending.reject(error);
    }
  }

  closeNow(): void {
    this.#closed = true;
    this.#closeSignal.resolve();
    this.#eventAppendQueue?.close();
    this.resetConflictAdmissionState();
    this.cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    this.#subscribedWatchView?.close();
    this.#subscribedWatchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      sessionHandle.then(({ client }) => client.close()).catch(() => {
        // The session never opened cleanly; there is nothing to close.
      });
    }
    // The fire-and-forget client.close() above rejects in-flight requests; drain
    // their read pulls too so no transport promise is left pending. Suppressed
    // verdicts settle off the same teardown rejection.
    void Promise.allSettled([...this.#syncPromises]);
    void Promise.allSettled([...this.#updatePromises]);
    void Promise.allSettled([...this.#suppressedVerdicts]);
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
  }

  async load(
    entries: [
      { id: URI; type: MIME; scope?: CellScope },
      SchemaPathSelector | undefined,
    ][],
  ): Promise<Result<Unit, PullError>> {
    const known = entries
      .map(([address]) => this.getState(address.id, address.scope))
      .filter((state): state is State => state !== undefined);
    this.#subscription.next({
      type: "load",
      space: this.#space,
      changes: Differential.load(known, this.#scopeKeyIdentity()),
    });
    return await this.pull(entries);
  }

  async pull(
    entries: [
      { id: URI; type: MIME; scope?: CellScope },
      SchemaPathSelector | undefined,
    ][],
  ): Promise<Result<Unit, PullError>> {
    if (entries.length === 0) {
      return { ok: {} };
    }

    const normalizedEntries = normalizeSyncEntries(entries);
    // Compose the dedup key from per-part hashes instead of hashing a fresh
    // wrapper object: hashOf's frozen-object cache is only consulted at entry
    // level, so embedding the (large, already canonical) selector schema in a
    // fresh wrapper re-walked it on every pull. hashStringOf(schema) hits the
    // identity cache for frozen schemas and costs one walk for mutable ones.
    // JSON.stringify escapes every field, so ids/scopes/path segments
    // containing delimiter characters cannot produce ambiguous keys.
    const key = JSON.stringify(
      normalizedEntries.map(([address, selector]) => [
        address.id,
        normalizeCellScope(address.scope) ?? null,
        selector === undefined ? null : selector.path,
        selector?.schema === undefined ? null : hashStringOf(selector.schema),
      ]),
    );
    const existing = this.#syncTasks.get(key);
    if (existing) {
      return await existing.promise;
    }

    const task: SyncTask = {
      entries: normalizedEntries,
      promise: Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    };
    // Entries covered by an already-registered selector are not re-fetched,
    // but the covering watch may still be IN FLIGHT. A sync's contract is
    // "resolved means the data is locally available", so collect the covering
    // promises and await them — returning early here would let a caller (e.g.
    // handler-input presync) proceed before the doc-carrying response lands.
    // For coverage registered by a long-settled watch the promise is already
    // resolved and the await is a no-op.
    const coveredInFlight: Promise<Result<Unit, PullError>>[] = [];
    const newEntries = normalizedEntries.filter(([address, selector]) => {
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
      };
      const [superset, supersetPromise] = this.#watchSelectorTracker
        .getSupersetSelector(
          baseAddress,
          selector,
        );
      if (superset !== undefined && supersetPromise !== undefined) {
        coveredInFlight.push(supersetPromise);
      }
      return superset === undefined;
    });
    if (newEntries.length === 0) {
      if (coveredInFlight.length === 0) {
        return { ok: {} };
      }
      const results = await Promise.all(coveredInFlight);
      return results.find((result) => result.error) ?? { ok: {} };
    }
    task.entries = newEntries;
    this.#syncTasks.set(key, task);
    const fetchPromise = this.enqueueWatchRefresh("pull", newEntries);
    // Mixed batch: some entries fetched here, others covered by in-flight
    // watches. The pull resolves only when ALL requested docs are locally
    // available, and concurrent same-key callers dedupe onto this COMBINED
    // wait (joining only `fetchPromise` would let them resolve before the
    // covered docs land).
    const combinedPromise = coveredInFlight.length === 0
      ? fetchPromise
      : (async (): Promise<Result<Unit, PullError>> => {
        const result = await fetchPromise;
        if (result.error) {
          return result;
        }
        const covered = await Promise.all(coveredInFlight);
        return covered.find((coveredResult) => coveredResult.error) ?? result;
      })();
    task.promise = combinedPromise;
    for (const [address, selector] of newEntries) {
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
      };
      // The tracker promise is what FUTURE pulls covered by these selectors
      // await: their data is available once THIS fetch lands, independent of
      // this batch's own covered set — so register the raw fetch promise.
      this.#watchSelectorTracker.add(
        baseAddress,
        selector,
        fetchPromise,
      );
    }
    this.#syncPromises.add(combinedPromise);
    try {
      return await combinedPromise;
    } finally {
      this.#syncTasks.delete(key);
      this.#syncPromises.delete(combinedPromise);
      // Tracker cleanup is keyed on THIS batch's fetch result alone: a
      // failure in a covered watch belongs to the pull that registered it,
      // and must not invalidate selectors whose fetch succeeded here.
      const result = await fetchPromise;
      if (result.error) {
        for (const [address, selector] of newEntries) {
          const baseAddress = {
            id: address.id,
            type: DOCUMENT_MIME,
            scope: normalizeCellScope(address.scope),
          };
          this.#watchSelectorTracker.delete(
            baseAddress,
            selector,
          );
        }
      }
    }
  }

  async commitNative(
    transaction: NativeStorageCommit,
    source?: IStorageTransaction,
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const preconditions = activeCommitPreconditions(transaction.preconditions);
    const operations = withCommitTiming(
      ["commitNative", "normalize"],
      () =>
        transaction.operations
          .filter((operation) => operation.type === DOCUMENT_MIME)
          .map((operation) =>
            operation.op === "delete"
              ? {
                op: "delete" as const,
                id: operation.id,
                scope: operation.scope,
              }
              : operation.op === "patch"
              ? {
                op: "patch" as const,
                id: operation.id,
                scope: operation.scope,
                patches: operation.patches,
                value: toExplicitDocument(operation.value),
              }
              : {
                op: "set" as const,
                id: operation.id,
                scope: operation.scope,
                value: toExplicitDocument(operation.value),
              }
          ),
    );

    const sqliteOps = transaction.sqliteOps ?? [];

    if (
      operations.length === 0 &&
      !preconditions?.length &&
      sqliteOps.length === 0
    ) {
      return { ok: {} };
    }

    return await withCommitTiming(
      ["commitNative", "commitOperations"],
      () =>
        this.commitOperations(
          operations,
          source,
          preconditions,
          sqliteOps,
          options,
        ),
    );
  }

  /**
   * Seal a native commit into the optimistic overlay without pushing it
   * (server-execution v2, serving-loop.md §3d): the local half of
   * commitNative — normalize, build the client commit with its read set,
   * apply pending, notify — with the store half deferred to `verdict`. The
   * wave accumulator resolves the verdict at its commit step: `committed`
   * promotes the pending writes at the wave commit's seq, `withdrawn`
   * rolls them back through the same rejection path a refused push takes —
   * EXCEPT the `superseded` variant (speculation.md §4's retirement),
   * which routes through `finalizeSupersededSpeculation`: a
   * SUCCESS-shaped drop that skips the rejection machinery, does not
   * cascade-reject dependants (an authored commit that read the echo is
   * decided by the store's CAS — and since the leg-C export refusal, a
   * dependent basis naming the echo never exports at all), and settles
   * ok. The pending overlay this leaves behind is the wave's layered
   * view — later action runs read the sealed writes through the
   * ordinary read path until the verdict settles them.
   */
  sealNative(
    transaction: NativeStorageCommit,
    source: IStorageTransaction | undefined,
    verdict: Promise<SealedCommitVerdict>,
    options?: { readonly speculative?: boolean },
  ): SealedNativeCommit {
    const preconditions = activeCommitPreconditions(transaction.preconditions);
    const operations = transaction.operations
      .filter((operation) => operation.type === DOCUMENT_MIME)
      .map((operation) =>
        operation.op === "delete"
          ? {
            op: "delete" as const,
            id: operation.id,
            scope: operation.scope,
          }
          : operation.op === "patch"
          ? {
            op: "patch" as const,
            id: operation.id,
            scope: operation.scope,
            patches: operation.patches,
            value: toExplicitDocument(operation.value),
          }
          : {
            op: "set" as const,
            id: operation.id,
            scope: operation.scope,
            value: toExplicitDocument(operation.value),
          }
      );
    return this.sealOperations(
      operations,
      source,
      preconditions,
      transaction.sqliteOps ?? [],
      verdict,
      options,
    );
  }

  private sealOperations(
    operations: NativeCommitOperation[],
    source: IStorageTransaction | undefined,
    preconditions: readonly CommitPrecondition[],
    sqliteOps: readonly SqliteOperation[],
    verdict: Promise<SealedCommitVerdict>,
    options?: { readonly speculative?: boolean },
  ): SealedNativeCommit {
    const localSeq = this.#nextLocalSeq++;
    if (source !== undefined) {
      recordCommitLocalSeq(source, this.#space, localSeq);
    }
    const commit: ClientCommit = {
      localSeq,
      reads: this.buildReads(source, localSeq),
      // Cell ops first, folded SQLite ops last — the same commit shape
      // commitOperations builds, so the wave batch is made of ordinary
      // client commits.
      operations: [
        ...operations.map((operation) => {
          switch (operation.op) {
            case "delete":
              return operation;
            case "patch":
              return {
                op: "patch" as const,
                id: operation.id,
                scope: operation.scope,
                patches: operation.patches,
              };
            case "set":
              return {
                op: "set" as const,
                id: operation.id,
                scope: operation.scope,
                value: operation.value,
              };
          }
        }),
        ...sqliteOps,
      ],
      ...(preconditions.length > 0
        ? { preconditions: [...preconditions] }
        : {}),
    };
    const touched = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        this.#scopeKeyIdentity(),
      )
      : undefined;

    for (const operation of operations) {
      this.applyPending(operation, localSeq);
    }

    if (before !== undefined) {
      const optimistic = before.compare(this);
      this.#subscription.next({
        type: "commit",
        space: this.#space,
        changes: optimistic,
        source,
      });
      if (shouldNotifySinks) {
        this.notifySinks(optimistic);
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }

    const settled = this.settleSealedCommit(
      localSeq,
      operations,
      commit,
      source,
      verdict,
    );
    if (options?.speculative !== true) {
      // Durable sealed commits (the wave's) join the synced() barrier
      // and the ordered-push outcome map as any commit does. A CLIENT
      // SPECULATION entry joins NEITHER (speculation.md §1: the overlay
      // is process-memory only, never synced, never committed): a
      // client settle must not wait on the echo's retirement, and no
      // push ordering ever involves it. Its in-flight registration
      // (inside settleSealedCommit) still happens, so reset sweeps and
      // origin-drop cascades reach the echo.
      this.#commitPromises.add(settled);
      this.#commitOutcomeBySeq.set(
        localSeq,
        settled.catch(() => {}).finally(() => {
          this.#commitOutcomeBySeq.delete(localSeq);
        }),
      );
      settled.finally(() => {
        this.#commitPromises.delete(settled);
      });
    } else {
      // Track the speculative seq for the export refusal (speculation.md
      // §6, RULED 2026-08-13): while any pending stack carries this
      // layer, a pushed commit's read basis naming it is refused in
      // commitOperations. Settlement (retirement or withdrawal) drops
      // the pending layers before `settled` resolves, so removal here
      // never races a stack that still names the seq.
      this.#speculativeLocalSeqs.add(localSeq);
      settled.catch(() => {}).finally(() => {
        this.#speculativeLocalSeqs.delete(localSeq);
      });
    }
    return { localSeq, commit, settled };
  }

  private async settleSealedCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source: IStorageTransaction | undefined,
    verdict: Promise<SealedCommitVerdict>,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // Registered unconditionally — unlike a pushed commit, a sealed commit
    // needs the entry even with zero pending reads: reset() sweeps
    // in-flight entries to reject them locally, and a sealed commit's
    // verdict is held externally by the wave, so without the entry a reset
    // would strand its pending writes until a verdict for a wave that no
    // longer exists.
    const inFlight = this.registerInFlightCommit(
      localSeq,
      operations,
      commit,
      source,
      { alwaysRegister: true },
    )!;
    try {
      const outcome = await Promise.race([
        verdict.then(
          (v) => ({ verdict: v }),
          // The accumulator's contract is to resolve every verdict; a
          // rejection is a wave-machinery bug, mapped to a withdrawal so
          // the pending writes still roll back instead of stranding.
          (reason) => ({
            verdict: {
              withdrawn: {
                message: `wave verdict rejected: ${
                  reason instanceof Error ? reason.message : String(reason)
                }`,
              },
            } satisfies SealedCommitVerdict,
          }),
        ),
        inFlight.localRejection.promise.then((rejection) => ({ rejection })),
      ]);
      if ("rejection" in outcome) {
        // A local rejection (dependency cascade, replica reset) beat the
        // wave's verdict; the eventual verdict is moot. A late `committed`
        // flags a wave that outlived its replica — the analogue of
        // suppressLateVerdict's warn.
        verdict.then((v) => {
          if ("committed" in v) {
            logger.warn("seal-late-commit", () => [
              "wave committed a sealed commit after its local rejection; " +
              "write not promoted",
              { localSeq },
            ]);
          }
        }, () => {});
        return await this.finalizeRejection(
          localSeq,
          operations,
          source,
          outcome.rejection,
        );
      }
      const v = outcome.verdict;
      if ("withdrawn" in v) {
        if (
          (v.withdrawn as { superseded?: true }).superseded === true
        ) {
          // Speculation retirement (server-execution v2 Phase 2,
          // speculation.md §4): a SUCCESS-shaped withdrawal — the
          // authoritative derivation covers the echo, the store wins by
          // construction. Drop the pending writes and notify the
          // visible flip, but do NOT cascade-reject dependants (an
          // authored commit that read the echo is decided by the
          // store's CAS, not by the echo's lifecycle) and settle OK.
          return this.finalizeSupersededSpeculation(
            localSeq,
            operations,
            source,
          );
        }
        return await this.finalizeRejection(
          localSeq,
          operations,
          source,
          this.makeLocalRejection(commit, v.withdrawn.message),
        );
      }
      // Locally-committed verdicts confirm IMMEDIATELY — never parked
      // (F1a, the completion-visibility wedge). A sealed commit's
      // verdict is resolved by the co-hosted executor (wave.ts /
      // space-server.ts) AFTER the engine applied the commit
      // synchronously through the engine-wave sink: the verdict IS the
      // store's answer, and verdict-time extrapolation is exactly as
      // current as this replica can be. CT-1927's parking exists to
      // keep a REMOTE mirror from promoting over missing foreign
      // novelty ordered before its accept — but engine-plane commits
      // bypass the server's transact path, which is the only place
      // catch-up marker obligations are staged (`noteExecutorCommit`
      // stages none), so a parked sealed accept's covering marker can
      // NEVER arrive. Routing through settleAccept therefore parked
      // these forever: `whenApplied` waiters never resolved, the
      // outbox's readability-gated retirement never retired (one
      // permanently-in-flight entry + one unresolved waiter leaked per
      // served effect), and any A→B→A input cycle starved deduping
      // against the dead entry. Residual extrapolation over foreign
      // novelty self-heals through the engine's own dirtiness fan-out
      // (`noteExecutorCommit` → frames), the same reconvergence
      // per-doc-dropped seals already rely on (wave.ts §3d). Pushed
      // (socket) commits keep full settleAccept semantics — remote
      // parking is untouched.
      this.confirmPending(localSeq, operations, {
        seq: v.committed.seq,
        branch: commit.branch ?? DEFAULT_BRANCH,
        revisions: [],
      });
      return { ok: {} };
    } finally {
      this.settleInFlightCommit(localSeq);
    }
  }

  reset(): void {
    // Every unsettled in-flight commit's optimistic pending write is about to
    // be wiped by #docs.clear(); locally reject each so its pushCommit
    // finalizes promptly instead of waiting on a server verdict for state
    // that no longer exists. readyToRetry resolves immediately (nothing to
    // repair — the replica is being rebuilt from scratch).
    for (const entry of [...this.#inFlightCommits.values()]) {
      this.rejectInFlightCommitLocally(
        entry,
        this.makeLocalRejection(entry.commit, "memory replica reset"),
      );
    }
    this.#docs.clear();
    this.#watchedIds.clear();
    this.resetConflictAdmissionState();
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica reset"));
    this.cancelQueuedWatchRefresh();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
    this.#subscription.next({
      type: "reset",
      space: this.#space,
    });
  }

  private async refreshWatchSet(
    entries: Iterable<
      [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector]
    >,
    type: "pull" | "integrate" = "pull",
  ): Promise<Result<Unit, PullError>> {
    try {
      const { session } = await this.activeSessionHandle();
      // Per-session (no global): mirror the storage setting onto the session so
      // its watch-mutation family (set + add) uses the ordered-issue concurrent
      // path. Idempotent; cheap to re-assert each refresh. Optional-chained so
      // lightweight session doubles in tests (which never opt into concurrency)
      // are unaffected.
      session.setConcurrentWatchRefresh?.(
        this.#settings.experimentalConcurrentWatchRefresh === true,
      );
      const rawEntries = [...entries];
      const watchEntries = compactWatchEntries(
        rawEntries,
        this.#scopeKeyIdentity(),
      );
      if (watchEntries.length === 0) {
        return { ok: {} };
      }

      const watches = watchEntries.map(([address, selector]) => ({
        id: watchIdForEntry(address, selector, ""),
        kind: "graph" as const,
        query: {
          roots: [{
            id: address.id,
            scope: normalizeCellScope(address.scope),
            selector,
          }],
        },
      }));

      const { view, sync } = await session.watchAddSync(watches);

      if (this.#closed) {
        view.close();
        return { error: toConnectionError(new Error("memory replica closed")) };
      }

      this.#watchView = view;
      this.applySessionSync(sync, type);
      if (this.#updatePromises.size === 0) {
        this.#subscribedWatchView = view;
        const updates = this.consumeUpdates(view.subscribeSync())
          .finally(() => {
            this.#updatePromises.delete(updates);
            if (this.#subscribedWatchView === view) {
              this.#subscribedWatchView = null;
              this.applyParkedAcceptsNow();
            }
          });
        this.#updatePromises.add(updates);
      }
      return { ok: {} };
    } catch (error) {
      return { error: toPullError(error) };
    }
  }

  private enqueueWatchRefresh(
    type: "pull" | "integrate",
    entries: [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector][],
  ): Promise<Result<Unit, PullError>> {
    if (this.#queuedWatchRefresh !== null) {
      for (const [address, selector] of entries) {
        this.#queuedWatchRefresh.entries.set(
          watchIdForEntry(address, selector, ""),
          [address, selector],
        );
      }
      return this.#queuedWatchRefresh.pending.promise;
    }

    const batch: WatchRefreshBatch = {
      type,
      entries: new Map(entries.map(([address, selector]) => [
        watchIdForEntry(address, selector, ""),
        [address, selector] as [
          { id: URI; type: MIME; scope?: CellScope },
          SchemaPathSelector,
        ],
      ])),
      pending: Promise.withResolvers<Result<Unit, PullError>>(),
    };
    this.#queuedWatchRefresh = batch;
    this.scheduleWatchRefreshFlush();
    return batch.pending.promise;
  }

  /**
   * Max watch-refresh round trips allowed in flight at once. 1 preserves the
   * historical strict single-flight behavior; with
   * `experimentalConcurrentWatchRefresh` on, refreshes overlap up to a bounded
   * window so traversal-discovered waves fan out WITHOUT an unbounded number of
   * outstanding requests (backpressure).
   */
  #maxWatchRefreshInFlight(): number {
    return this.#settings.experimentalConcurrentWatchRefresh === true
      ? CONCURRENT_WATCH_REFRESH_WINDOW
      : 1;
  }

  private scheduleWatchRefreshFlush(): void {
    // Flush the queued batch when a slot is free. Same-tick coalescing (via
    // `#queuedWatchRefreshScheduled` + the merge in `enqueueWatchRefresh`) is
    // unchanged; the window bounds cross-RTT concurrency (1 = single-flight).
    if (
      this.#queuedWatchRefresh === null ||
      this.#queuedWatchRefreshScheduled ||
      this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()
    ) {
      return;
    }
    this.#queuedWatchRefreshScheduled = true;
    queueMicrotask(() => {
      this.#queuedWatchRefreshScheduled = false;
      if (
        this.#queuedWatchRefresh === null ||
        this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()
      ) {
        return;
      }
      const batch = this.#queuedWatchRefresh;
      this.#queuedWatchRefresh = null;
      this.#watchRefreshInFlight += 1;
      void this.flushWatchRefreshBatch(batch);
      // If the window admits more and another batch has already coalesced,
      // schedule it now; otherwise the flush's `finally` re-schedules as slots
      // free.
      this.scheduleWatchRefreshFlush();
    });
  }

  private async flushWatchRefreshBatch(
    batch: WatchRefreshBatch,
  ): Promise<void> {
    try {
      const result = await this.refreshWatchSet(
        batch.entries.values(),
        batch.type,
      );
      this.noteAuthorizationStatus(result);
      batch.pending.resolve(result);
    } catch (error) {
      const result: Result<Unit, PullError> = { error: toPullError(error) };
      this.noteAuthorizationStatus(result);
      batch.pending.resolve(result);
    } finally {
      this.#watchRefreshInFlight -= 1;
      this.scheduleWatchRefreshFlush();
    }
  }

  private cancelQueuedWatchRefresh(): void {
    this.#queuedWatchRefreshScheduled = false;
    if (this.#queuedWatchRefresh !== null) {
      this.#queuedWatchRefresh.pending.resolve({
        error: toConnectionError(new Error("memory replica closed")),
      });
      this.#queuedWatchRefresh = null;
    }
  }

  private async consumeUpdates(
    iterator: AsyncIterator<SessionSync>,
  ): Promise<void> {
    while (true) {
      const next = await iterator.next();
      if (next.done || this.#closed) {
        return;
      }
      this.applySessionSync(next.value, "integrate");
    }
  }

  private async commitOperations(
    operations: NativeCommitOperation[],
    source?: IStorageTransaction,
    preconditions: readonly CommitPrecondition[] = [],
    sqliteOps: readonly SqliteOperation[] = [],
    commitOptions?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const activePreconditions = activeCommitPreconditions(preconditions);
    if (
      operations.length === 0 && sqliteOps.length === 0 &&
      activePreconditions.length === 0
    ) {
      return { ok: {} };
    }

    const localSeq = this.#nextLocalSeq++;
    if (source !== undefined) {
      recordCommitLocalSeq(source, this.#space, localSeq);
    }
    const commit = withCommitTiming(
      ["commitOperations", "buildCommit"],
      (): ClientCommit => ({
        localSeq,
        reads: this.buildReads(source, localSeq),
        // Cell ops first, folded SQLite ops last (applied in array order by the
        // engine; sqlite ops are not entity revisions and carry no id/scope).
        operations: [
          ...operations.map((operation) => {
            switch (operation.op) {
              case "delete":
                return operation;
              case "patch":
                return {
                  op: "patch" as const,
                  id: operation.id,
                  scope: operation.scope,
                  patches: operation.patches,
                };
              case "set":
                return {
                  op: "set" as const,
                  id: operation.id,
                  scope: operation.scope,
                  value: operation.value,
                };
            }
          }),
          ...sqliteOps,
        ],
        ...(activePreconditions.length > 0
          ? { preconditions: [...activePreconditions] }
          : {}),
      }),
    );
    // The export refusal (server-execution v2 Phase 2, speculation.md
    // §6; RULED 2026-08-13): a commit basis naming a SPECULATIVE
    // overlay layer must not reach the wire — the layer exists only in
    // this process, so the server would reject the dependency as
    // unresolved on every attempt (pre-fix: the observed
    // `pending dependency not resolved` convergence-retry loop, ~43
    // attempts across the 30s window per event). Refused HERE, before
    // the optimistic apply, with a terminal-classified error: nothing
    // renders, nothing reverts, nothing retries.
    const speculativeLayers = this.speculativeLayersOf(commit);
    if (speculativeLayers.length > 0) {
      const rejection = this.makeSpeculativeBasisRefusal(
        commit,
        speculativeLayers,
      );
      logger.error("speculative-basis-refused", () => [
        "commit refused before export: read basis names speculative " +
        "overlay layer(s) (speculation.md §6)",
        {
          localSeq,
          speculativeLayers: [...speculativeLayers],
          reads: commit.reads.pending
            .filter((read) => {
              const layers = Array.isArray(read.localSeq)
                ? read.localSeq
                : [read.localSeq];
              return layers.some((layer) => speculativeLayers.includes(layer));
            })
            .map((read) => read.id),
        },
      ]);
      if (source !== undefined) {
        notifyCommitRejected(source, rejection);
      }
      return { error: rejection };
    }
    const touched = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.hasSinkSubscribers(touched);
    const before = withCommitTiming(
      ["commitOperations", "snapshotBefore"],
      () =>
        shouldNotifySubscribers
          ? Differential.checkout(
            this,
            touched.map(({ id, scope }) => snapshotState(this, id, scope)),
            this.#scopeKeyIdentity(),
          )
          : undefined,
    );

    withCommitTiming(["commitOperations", "applyPending"], () => {
      for (const operation of operations) {
        this.applyPending(operation, localSeq);
      }
    });

    withCommitTiming(["commitOperations", "notifyOptimistic"], () => {
      if (before !== undefined) {
        const optimistic = before.compare(this);
        this.#subscription.next({
          type: "commit",
          space: this.#space,
          changes: optimistic,
          source,
        });
        if (shouldNotifySinks) {
          this.notifySinks(optimistic);
        }
      } else if (shouldNotifySinks) {
        this.notifySinksForIds(touched);
      }
    });

    const promise = withCommitTiming(
      ["commitOperations", "pushCommitStart"],
      () =>
        this.pushCommit(
          localSeq,
          operations,
          commit,
          source,
          { commitOptions },
        ),
    );
    this.#commitPromises.add(promise);
    // Keyed registration for the old-server scalarization hold: a later
    // stacked commit awaits its omitted lower dependencies' outcomes here.
    // Removed on settlement (absent key = settled); the .catch keeps the
    // tracking copy from surfacing as an unhandled rejection.
    this.#commitOutcomeBySeq.set(
      localSeq,
      promise.catch(() => {}).finally(() => {
        this.#commitOutcomeBySeq.delete(localSeq);
      }),
    );
    const result = await promise;
    this.#commitPromises.delete(promise);
    return result;
  }

  /**
   * Register a commit in `#inFlightCommits` so a dropped dependency can
   * reject it locally. Returns undefined — no registration — when the commit
   * has no pending reads: with nothing read from another commit's optimistic
   * state there is no dependency to cascade on, and this is the natural
   * exemption for zero-read/mergeable/blind commits and the
   * scheduler-observation batch wrapper (all DESIGNED to survive a parent
   * drop; see the InFlightCommit doc).
   */
  private registerInFlightCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    options: { alwaysRegister?: boolean } = {},
  ): InFlightCommit | undefined {
    if (
      commit.reads.pending.length === 0 && options.alwaysRegister !== true
    ) {
      return undefined;
    }
    const dependencies = new Set<number>();
    for (const read of commit.reads.pending) {
      if (Array.isArray(read.localSeq)) {
        for (const layer of read.localSeq) {
          dependencies.add(layer);
        }
      } else {
        dependencies.add(read.localSeq);
      }
    }
    const entry: InFlightCommit = {
      localSeq,
      dependencies,
      operations,
      source,
      commit,
      localRejection: Promise.withResolvers<StorageTransactionRejected>(),
      settled: false,
    };
    this.#inFlightCommits.set(localSeq, entry);
    return entry;
  }

  /**
   * Mark a commit's outcome as finalized and remove it from the cascade scan
   * set. Idempotent — pushCommit's finally may run after reset() already
   * signalled a local rejection for the same entry.
   */
  private settleInFlightCommit(localSeq: number): void {
    const entry = this.#inFlightCommits.get(localSeq);
    if (entry === undefined) {
      return;
    }
    entry.settled = true;
    this.#inFlightCommits.delete(localSeq);
  }

  /**
   * Signal a locally-fabricated rejection for an in-flight commit. Invariant
   * holder: `localRejectionValue` must be observable synchronously BEFORE
   * `localRejection` resolves — pushCommit's pre-send checkpoints read the
   * field directly; the promise only feeds the transact race.
   */
  private rejectInFlightCommitLocally(
    entry: InFlightCommit,
    rejection: StorageTransactionRejected,
  ): void {
    if (entry.settled || entry.localRejectionValue !== undefined) {
      return;
    }
    entry.localRejectionValue = rejection;
    entry.localRejection.resolve(rejection);
  }

  /**
   * A server verdict superseded by a local rejection: consume it off the
   * books. Late reject is the expected outcome (the server eventually agrees
   * the dependency never resolved) and is swallowed. Late ACCEPT is
   * deterministically impossible once resolution-only pending reads are
   * emitted — the server cannot accept a commit whose pending dependency has
   * no commit row — so it warns to flag a bug; the write is NOT promoted
   * (its pending entries were already dropped by finalizeRejection).
   */
  private suppressLateVerdict(
    verdict: Promise<AppliedCommit>,
    localSeq: number,
  ): void {
    const settled = verdict.then(() => {
      logger.warn("cascade-late-accept", () => [
        "server accepted a commit after its local rejection; write not promoted",
        { localSeq },
      ]);
    }, (error) => {
      logger.debug("cascade-late-reject", () => [
        `late server verdict after local rejection: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { localSeq },
      ]);
    }).finally(() => {
      this.#suppressedVerdicts.delete(settled);
    });
    this.#suppressedVerdicts.add(settled);
  }

  private async pushCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    options: {
      routeSources?: readonly IStorageTransaction[];
      prepareIssue?: (commit: ClientCommit) => boolean;
      commitOptions?: TransactionCommitOptions;
    } = {},
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const routeSources = options.routeSources ??
      (source === undefined ? [] : [source]);
    const resolveAtVerdict = options.commitOptions?.resolveAt === "verdict";
    // Rejection receipt seals the fate for EVERY contributing transaction.
    // finalizeRejection's own notify covers the cascade paths that do not
    // come through here; the once-guard makes the overlap free.
    const notifyRejectionSources = (
      rejection: StorageTransactionRejected,
    ): void => {
      for (const routeSource of routeSources) {
        notifyCommitRejected(routeSource, rejection);
      }
    };
    // Register BEFORE any await: commitOperations calls pushCommit
    // synchronously after applyPending, so registration is atomic with the
    // optimistic write — a dependency drop can never slip between the two.
    const inFlight = this.registerInFlightCommit(
      localSeq,
      operations,
      commit,
      source,
    );
    try {
      // Strategy 1: a commit whose read set lands on a still-catching-up id.
      const admissionMode = conflictAdmissionMode();
      if (admissionMode !== "off") {
        const threshold = this.preemptThreshold(commit);
        if (threshold !== undefined) {
          // Coarse mode: assume conflict and pre-empt without sending.
          const rejection = this.makePreemptRejection(commit, threshold);
          logger.debug("commit-preempted", () => [
            `commit preempted: stale until caughtUpLocalSeq>=${threshold}`,
            { localSeq, operations: operations.length },
          ]);
          notifyRejectionSources(rejection);
          return await this.finalizeRejection(
            localSeq,
            operations,
            source,
            rejection,
          );
        }
      }
      // The push marker window covers (re)dial + send + confirm: the full
      // client-side cost of durably landing this commit.
      // (space.did, commit.local_seq) joins to the server's memory.transact span.
      const telemetry = this.#getTelemetry();
      const pushOpId = `push:${this.#space}:${localSeq}`;
      telemetry?.submit({
        type: "storage.push.start",
        id: pushOpId,
        operation: "transact",
        localSeq,
        spaceDid: this.#space,
      });
      try {
        const { client, session } = await this.activeSessionHandle();
        if (
          options.prepareIssue !== undefined &&
          !options.prepareIssue(commit)
        ) {
          return { ok: {} };
        }
        // Wire-compat: only a server advertising `pendingReadStacks` can
        // resolve array dependency sets — otherwise collapse each to its
        // top-of-stack element before sending.
        const wireCommit = client.serverFlags?.pendingReadStacks === true
          ? commit
          : scalarizePendingReadStacks(commit);
        if (wireCommit !== commit && inFlight !== undefined) {
          // Old-server hold (split-brain guard): the scalarized wire omits
          // the lower layers, so the server could durably ACCEPT a commit
          // this client is about to cascade-reject — the caller would see a
          // ConflictError for a write that landed. Do not send until every
          // omitted dependency settles: a dropped one trips the doom
          // checkpoint below before anything reaches the wire, and
          // all-accepted makes the scalar shape sound (their resolution is
          // already durable). Verdicts arrive in submission order, so this
          // adds at most roughly one verdict round-trip, only against
          // pre-`pendingReadStacks` servers, only for stacked commits.
          const waits: Promise<unknown>[] = [];
          for (const read of commit.reads.pending) {
            if (!Array.isArray(read.localSeq)) continue;
            const top = scalarizeLocalSeq(read.localSeq);
            for (const layer of read.localSeq) {
              if (layer === top) continue;
              const outcome = this.#commitOutcomeBySeq.get(layer);
              if (outcome !== undefined) {
                waits.push(outcome);
              }
            }
          }
          if (waits.length > 0) {
            await Promise.all(waits);
          }
        }
        if (inFlight?.localRejectionValue !== undefined) {
          // A pending dependency was dropped while we awaited the scheduler
          // batch flush or the session handshake — do not send a commit whose
          // doom is already provable.
          telemetry?.submit({
            type: "storage.push.error",
            id: pushOpId,
            sessionId: session.sessionId,
            error: inFlight.localRejectionValue.name ?? "TransactionError",
          });
          notifyRejectionSources(inFlight.localRejectionValue);
          return await this.finalizeRejection(
            localSeq,
            operations,
            source,
            inFlight.localRejectionValue,
          );
        }
        if (inFlight === undefined) {
          // No pending reads → no dependency that can be dropped from under
          // this commit; keep the direct await.
          const applied = await session.transact(
            wireCommit,
            () => this.markRouteWriteIssued(routeSources),
          );
          const settled = this.settleAccept(
            localSeq,
            operations,
            applied,
            resolveAtVerdict,
          );
          // Tx-sourced commits ALWAYS record the coverage wait: the inner
          // settlement promise carries commit callbacks and the
          // pending-commit barrier, which stay on the full timeline even
          // when the caller opted its returned promise into verdict timing.
          // Only the direct path — where the promise returned here IS the
          // caller's promise — honors the verdict opt-out inline.
          if (source !== undefined) {
            recordCoverageWait(source, settled);
          } else if (!resolveAtVerdict) {
            await settled;
          }
          telemetry?.submit({
            type: "storage.push.complete",
            id: pushOpId,
            sessionId: session.sessionId,
          });
          return { ok: {} };
        }
        // Race the server verdict against a locally-fabricated rejection (a
        // dependency dropped mid-flight, or a replica reset). A server
        // rejection wins the race by REJECTING it, landing in the catch below.
        const verdict = session.transact(
          wireCommit,
          () => this.markRouteWriteIssued(routeSources),
        );
        const outcome = await Promise.race([
          verdict.then((applied) => ({ applied })),
          inFlight.localRejection.promise.then((rejection) => ({ rejection })),
        ]);
        if ("rejection" in outcome) {
          // Local rejection won: the eventual server verdict is moot. Do NOT
          // recordStaleFloor — a locally fabricated rejection carries no server
          // catch-up point (parity with the preempt path above).
          this.suppressLateVerdict(verdict, localSeq);
          telemetry?.submit({
            type: "storage.push.error",
            id: pushOpId,
            sessionId: session.sessionId,
            error: outcome.rejection.name ?? "TransactionError",
          });
          notifyRejectionSources(outcome.rejection);
          return await this.finalizeRejection(
            localSeq,
            operations,
            source,
            outcome.rejection,
          );
        }
        const settledRace = this.settleAccept(
          localSeq,
          operations,
          outcome.applied,
          resolveAtVerdict,
        );
        // Same rule as the direct-await branch above: tx-sourced commits
        // always record; only the direct path honors the verdict opt-out.
        if (source !== undefined) {
          recordCoverageWait(source, settledRace);
        } else if (!resolveAtVerdict) {
          await settledRace;
        }
        telemetry?.submit({
          type: "storage.push.complete",
          id: pushOpId,
          sessionId: session.sessionId,
        });
        return { ok: {} };
      } catch (error) {
        let cause = error;
        if (this.#replacementRead !== undefined) {
          const routeConflict = new Error("memory replica route replaced");
          routeConflict.name = "ConflictError";
          cause = routeConflict;
        }
        const schedulerDependencyRejection =
          cause instanceof StorageTransactionRejectionError ? cause : undefined;
        let rejection = schedulerDependencyRejection !== undefined
          ? schedulerDependencyRejection.rejection
          : toRejectedError(cause, commit, this.#space);
        // Leg-C belt (speculation.md §6): a ConflictError whose commit
        // names one of THIS replica's speculative layers can never
        // converge — the dependency never reaches the wire.
        // commitOperations refuses the export up front, so reaching
        // here means a build path slipped through; upgrade to the
        // terminal refusal rather than letting the caller spin its
        // retry window against a dependency that is never coming.
        if (
          schedulerDependencyRejection === undefined &&
          rejection.name === "ConflictError"
        ) {
          const speculativeLayers = this.speculativeLayersOf(commit);
          if (speculativeLayers.length > 0) {
            logger.error("speculative-basis-exported", () => [
              "a commit naming speculative overlay layer(s) reached the " +
              "wire (the build-time refusal should have caught this); " +
              "upgrading the rejection to the terminal refusal",
              { localSeq, speculativeLayers },
            ]);
            rejection = this.makeSpeculativeBasisRefusal(
              commit,
              speculativeLayers,
            );
          }
        }
        telemetry?.submit({
          type: "storage.push.error",
          id: pushOpId,
          error: rejection.name ?? "TransactionError",
        });
        if (schedulerDependencyRejection === undefined) {
          this.attachProviderReadyToRetry(rejection, localSeq);
          if (admissionMode !== "off" && rejection.name === "ConflictError") {
            this.recordStaleFloor(commit, localSeq);
          }
        }
        // Counted (even while silent) so multi-writer churn can be read back via
        // getLoggerCounts(): "commit-conflict" is a stale-seq-basis rejection that
        // drops only the optimistic pending write and re-derives from confirmed
        // state; a non-falling count under load means conflicts ratchet rather
        // than storm.
        logger.debug(
          rejection.name === "ConflictError"
            ? "commit-conflict"
            : "commit-rejected",
          () => [
            `commit ${rejection.name ?? "rejected"}: ${rejection.message}`,
            { localSeq, operations: operations.length },
          ],
        );
        notifyRejectionSources(rejection);
        return await this.finalizeRejection(
          localSeq,
          operations,
          source,
          rejection,
        );
      }
    } finally {
      this.settleInFlightCommit(localSeq);
    }
  }

  private markRouteWriteIssued(
    sources: readonly IStorageTransaction[] = [],
  ): void {
    for (const source of sources) {
      const validation = source.validateReplicaRoutes?.();
      if (validation?.error !== undefined) {
        throw Object.assign(
          new Error(validation.error.message),
          validation.error,
        );
      }
    }
    if (
      this.#closed ||
      this.#routeState.generation !== this.#routeGeneration
    ) {
      throw new Error("memory replica route replaced");
    }
    this.#routeState.writeIssuedGeneration = this.#routeGeneration;
  }

  private assertActiveRoute(): void {
    if (
      this.#closed ||
      this.#routeState.generation !== this.#routeGeneration
    ) {
      throw new Error("memory replica closed");
    }
  }

  private activeSessionHandle(): Promise<OpenedSpaceSession> {
    try {
      this.assertActiveRoute();
    } catch (error) {
      return Promise.reject(error);
    }
    const handle = this.sessionHandle();
    if (this.#sessionClient !== undefined) {
      return handle;
    }
    return Promise.race([
      handle.then((value) => ({ value })),
      this.#closeSignal.promise.then(() => ({ value: undefined })),
    ]).then((opened) => {
      if (opened.value === undefined) {
        throw new Error("memory replica closed");
      }
      this.assertActiveRoute();
      return opened.value;
    });
  }

  /**
   * Speculation retirement (server-execution v2 Phase 2, speculation.md
   * §4): drop a speculative sealed commit's pending writes and notify
   * the visible flip to the authoritative value. finalizeRejection minus
   * two deliberate absences — no conflict-read-repair wait (nothing
   * conflicted) and NO dependency cascade (retirement is success-shaped:
   * an authored commit that read the echo is decided by the store's CAS,
   * and a downstream speculation retires on its own floor). The
   * notification is an ordinary `integrate` (authoritative state became
   * visible), not a `revert` (nothing failed).
   */
  private finalizeSupersededSpeculation(
    localSeq: number,
    operations: NativeCommitOperation[],
    _source: IStorageTransaction | undefined,
  ): Result<Unit, StorageTransactionRejected> {
    const touched = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    this.dropPending(localSeq);
    if (before !== undefined) {
      const changes = before.compare(this);
      if ([...changes].length > 0) {
        this.#subscription.next({
          type: "integrate",
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifySinks) {
          this.notifySinks(changes);
        }
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }
    return { ok: {} };
  }

  // Shared rejection tail for both real conflicts and pre-empted commits: wait
  // for the caught-up read-repair, drop the optimistic pending write, and emit
  // the revert notification reflecting repaired confirmed state.
  private async finalizeRejection(
    localSeq: number,
    operations: NativeCommitOperation[],
    source: IStorageTransaction | undefined,
    rejection: StorageTransactionRejected,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // The fate is sealed here. The verdict-gated effect layer (verdict
    // callbacks, outbox clearing) fires on this notification; the
    // settlement promise and commit callbacks wait out the read-repair
    // gate below, because a retry needs the repaired base.
    if (source !== undefined) {
      notifyCommitRejected(source, rejection);
    }
    const touched = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    await this.waitForConflictReadRepair(rejection);
    this.dropPending(localSeq);
    // Every drop funnels through here (server conflict, preempt, cascade,
    // reset — this is dropPending's only call site), so scanning right after
    // the drop catches every dependant; transitivity emerges from recursion
    // (a victim's own finalizeRejection lands back here with its localSeq).
    this.cascadeDroppedDependency(localSeq);
    if (before !== undefined) {
      const changes = before.compare(this);
      // The revert snapshots CURRENT confirmed state (which already includes
      // any newer seq received by subscription since this commit started) and
      // drops only this commit's pending write — so it should not stomp newer
      // data. Counted to verify reverts stay bounded.
      logger.debug("commit-revert", () => [
        `revert after ${rejection.name ?? "rejection"}`,
      ]);
      this.#subscription.next({
        type: "revert",
        space: this.#space,
        changes,
        reason: rejection,
        source,
      });
      if (shouldNotifySinks) {
        this.notifySinks(changes);
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }
    return { error: rejection };
  }

  private buildReads(
    source: IStorageTransaction | undefined,
    localSeq: number,
  ) {
    const confirmed: ConfirmedCommitRead[] = [];
    const pending: PendingCommitRead[] = [];
    if (!source) {
      return { confirmed, pending };
    }

    const reads = getDirectTransactionReadActivities(source);
    if (!reads) {
      throw new Error(
        "Memory v2 commit tracking requires source.getReadActivities(); " +
          "journal.activity() fallback is unsupported.",
      );
    }

    // For a blind UI-input write, handleCellSet threads the cell's PARENT address
    // here; its `ignoreReadForCommit` reads are dropped below and replaced by one
    // nonRecursive read at this parent (emitted after the loop).
    const structuralTarget = getBlindStructuralTarget(source);

    // Emit one commit read for `id`, baselined against the most recent in-flight
    // local version of that doc below this commit's localSeq if one exists, else
    // the confirmed seq (or an explicit `confirmedSeq` override, e.g. a read that
    // carries its own `meta.seq`). Shared by the per-read loop below and the blind
    // write's structural precondition so the two emission sites stay in lockstep.
    const pushCommitRead = (
      id: URI,
      scope: CellScope | undefined,
      path: DocumentPath,
      nonRecursive: boolean,
      confirmedSeq?: number,
    ) => {
      const record = this.#docs.get(docKey(id, scope));
      // The read's materialized view sat on EVERY lower pending layer, not
      // just the nearest one: name them ALL (ascending; the last element is
      // the doc's top-of-stack below this commit) so a dropped deeper layer
      // still dooms this commit (server: pending-dependency resolution;
      // client: cascade). Servers that honor `basisSeq` scan staleness from
      // it with predecessor-only own-session exclusion (CT-1910); legacy
      // servers base staleness at the highest element only — a lower-layer
      // basis WITHOUT that exclusion would false-conflict with the
      // session's own later stacked writes (CT-1872 1c).
      const layers = [
        ...new Set(
          record?.pending
            .filter((version) => version.localSeq < localSeq)
            .map((version) => version.localSeq) ?? [],
        ),
      ].sort((left, right) => left - right);
      const shape = nonRecursive ? { nonRecursive: true } : {};
      if (layers.length > 0) {
        pending.push({
          id,
          scope,
          path,
          localSeq: layers.length === 1 ? layers[0] : layers,
          // The true confirmed basis this doc's view sat on — the same value
          // the confirmed branch below emits (CT-1910).
          basisSeq: confirmedSeq ?? record?.confirmed.seq ?? 0,
          ...shape,
        });
      } else {
        confirmed.push({
          id,
          scope,
          path,
          seq: confirmedSeq ?? record?.confirmed.seq ?? 0,
          ...shape,
        });
      }
    };

    // A mergeable op resolves against durable state, so it does not depend on
    // the document's prior value. On an entity touched by a mergeable op, the
    // reads the op ITSELF issues are dropped from conflict detection — its own
    // value read (marked `mergeableOpRead`), its write-target reads (marked
    // attempted-write), and the CFC write-policy label at ["cfc"] — so disjoint
    // and stale-base writes merge and the op applies on top of a concurrent
    // whole-entity write. A handler's OWN explicit read of the entity is kept,
    // so a conditional mergeable write (e.g. dedup-then-push) still conflicts
    // and retries. Server-side write authorization is enforced at apply time.
    const mergeableOpPathsByEntity = new Map<string, (readonly string[])[]>();
    for (const op of getDirectTransactionMergeableOpAddresses(source) ?? []) {
      if (op.space !== this.#space) continue;
      const key = `${op.id}\0${normalizeCellScope(op.scope)}`;
      const paths = mergeableOpPathsByEntity.get(key);
      if (paths) {
        paths.push(op.path);
      } else {
        mergeableOpPathsByEntity.set(key, [op.path]);
      }
    }

    for (const read of reads) {
      if (
        read.space !== this.#space ||
        (read.type ?? DOCUMENT_MIME) !== DOCUMENT_MIME ||
        hasDataUriScheme(read.id)
      ) {
        continue;
      }
      // A read tagged `ignoreReadForCommit` (UI-input blind-leaf-write mode) is not
      // a value-equality concurrency precondition: a blind `set` must not lose the
      // own-write race on its own write-target read. Drop it from the conflict set.
      // Its structural replacement — one nonRecursive read at the cell's PARENT — is
      // emitted once after the loop from the threaded `structuralTarget`, since the
      // logical write path is known only at handleCellSet, not from this diff.
      if (isReadIgnoredForCommit(read.meta)) {
        continue;
      }

      // Reference-resolution reads (e.g. asCell argument materialization following
      // a write-redirect to construct the Cell) are tagged excludeReadFromConflict.
      // Scoped to NONRECURSIVE (shape/topology) reads: those resolve a reference,
      // not consume a value, so they must not enter the conflict set (they stay in
      // the journal for reactivity). A RECURSIVE read in the same scope is a real
      // value dependency (a by-value arg) and is kept. Inert unless reads are marked.
      if (isReadExcludedFromConflict(read.meta) && read.nonRecursive === true) {
        continue;
      }

      const scope = normalizeCellScope(read.scope);

      const opPaths = mergeableOpPathsByEntity.get(`${read.id}\0${scope}`);
      // A read of the op array's own `length` is the handler depending on the
      // element count, which a mergeable append / add-unique / remove-by-value
      // changes. The op itself never reads `length` (it reads the array value
      // and its new-element slots), so this read is a genuine dependency and is
      // kept from every drop below: a push whose new element's index or id came
      // from the length conflicts and retries against a concurrent append.
      const readsMergeableOpArrayLength = opPaths !== undefined &&
        opPaths.some((opPath) => isArrayLengthChildPath(opPath, read.path));
      if (
        opPaths !== undefined &&
        !readsMergeableOpArrayLength &&
        (isMergeableOpRead(read.meta) ||
          isReadMarkedAsAttemptedWrite(read.meta) ||
          isCfcLabelPath(read.path) ||
          // Deep reads under the op path (link resolution, element sub-reads) are
          // incidental to the op. A shape-only (nonRecursive) read AT the op path
          // is also incidental — it is the query-result proxy's container read of
          // the array being mutated, which must not false-conflict with a
          // concurrent mergeable op. A RECURSIVE read AT the op path is the
          // handler's explicit read of the collection, and is kept so a
          // conditional mergeable write still conflicts and retries.
          opPaths.some((opPath) =>
            isStrictPrefixPath(opPath, read.path) ||
            (read.nonRecursive === true && isSamePath(opPath, read.path))
          ))
      ) {
        continue;
      }
      pushCommitRead(
        read.id as URI,
        scope,
        toCommitReadPath(read.path),
        read.nonRecursive === true,
        typeof read.meta?.seq === "number" ? read.meta.seq : undefined,
      );
    }
    // The blind UI-input write's single structural existence/shape precondition: a
    // nonRecursive read at the cell's PARENT (threaded from handleCellSet). It
    // conflicts with a concurrent whole-doc delete/replace (TIER-1, path-blind) and
    // with a reshape of the parent or any ancestor (TIER-2 nonRecursive overlap
    // fires at-or-above the read path), but NOT with a write to the cell's own
    // value (which sits below the parent, including array elements) — so the
    // own-write race stays conflict-free.
    if (
      structuralTarget !== undefined &&
      structuralTarget.space === this.#space
    ) {
      pushCommitRead(
        structuralTarget.id as URI,
        normalizeCellScope(
          structuralTarget.scope as Parameters<typeof normalizeCellScope>[0],
        ),
        toCommitReadPath(structuralTarget.path),
        true,
      );
    }
    // Keep the nonRecursive flag on the reads sent to the engine (it was
    // historically stripped here). The engine applies shallow (shape-only)
    // conflict granularity to nonRecursive reads (patchOverlapsNonRecursiveRead),
    // matching how the scheduler reader-dirty index already treats them.
    return {
      confirmed: compactCommitReads(this.#space, confirmed),
      pending: compactCommitReads(this.#space, pending),
    };
  }

  private applySessionSync(
    sync: SessionSync,
    type: "pull" | "integrate",
  ): void {
    if (
      sync.upserts.length === 0 &&
      sync.removes.length === 0
    ) {
      this.noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);
      return;
    }

    const touched = [
      ...sync.upserts.map((upsert) => ({
        id: upsert.id as URI,
        scope: upsert.scope,
      })),
      ...sync.removes.map((remove) => ({
        id: remove.id as URI,
        scope: remove.scope,
      })),
    ];

    const shouldNotifySubscribers = this.hasNotificationSubscribers();
    const shouldNotifySinks = this.hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        this.#scopeKeyIdentity(),
      )
      : undefined;

    for (const upsert of sync.upserts) {
      const record = this.record(upsert.id as URI, upsert.scope);
      // Watch refreshes can arrive after local confirmations. Never move the
      // confirmed base backwards; pending replay depends on monotonic bases.
      if (upsert.seq < record.confirmed.seq) {
        continue;
      }
      const previousConfirmedSeq = record.confirmed.seq;
      record.confirmed = confirmedVersion(
        upsert.seq,
        upsert.deleted === true ? undefined : upsert.doc,
      );
      record.materialized = undefined;
      const key = docKey(upsert.id as URI, upsert.scope);
      this.#watchedIds.add(key);
      // The settle input barrier's shadow case (Phase 2 revisit (a)):
      // a FOREIGN value integrating UNDER an own pending write is
      // invisible through the materialized view — and the change
      // notification below misses it — until the pending entry promotes
      // or drops. Record the seq so the serving loop's W advance
      // excludes it (`unappliedForeignSeqFloor`). Three exemptions,
      // each a non-novelty shape that would otherwise clamp W forever
      // (or one wave behind) on a serving loop:
      // - GENUINE NOVELTY ONLY — the upsert must move confirmed
      //   FORWARD past what was already visible
      //   (`upsert.seq > previousConfirmedSeq`): a same-seq re-upsert
      //   (a watch-refresh replay, or the frame echo of a SEALED
      //   commit that F1a already confirmed at verdict time) carries
      //   nothing the replica has not integrated;
      // - an OWN ECHO — an upsert whose seq IS one of the pending
      //   accepts' ack seqs is the durable copy of the own write
      //   itself (CT-1927's mixed-provenance frame);
      // - a seq-0 ABSENT-DOC marker (the initial watch pull's "no
      //   confirmed version" answer), which carries no novelty at all.
      if (
        upsert.seq > 0 &&
        upsert.seq > previousConfirmedSeq &&
        record.pending.length > 0 &&
        !record.pending.some((entry) =>
          this.#ackedSeqsByLocalSeq.get(entry.localSeq) === upsert.seq
        )
      ) {
        // Record EVERY hidden seq (review thread r3739139487): the
        // floor reads the doc's lowest — the wave's derivations read
        // the materialized view from BEFORE the earliest hidden input,
        // so W must not advance past it. The previous per-doc
        // `Math.max` let a second foreign update under the same
        // pending write raise the floor and pass the first (a
        // derivedThrough claim over input nothing derived over), and
        // buried a standing remove sentinel the same way.
        let seqs = this.#shadowedForeignSeqs.get(key);
        if (seqs === undefined) {
          seqs = new Set();
          this.#shadowedForeignSeqs.set(key, seqs);
        }
        seqs.add(upsert.seq);
      }
    }
    for (const remove of sync.removes) {
      const id = remove.id as URI;
      const record = this.record(id, remove.scope);
      record.confirmed = confirmedVersion(0, undefined);
      record.materialized = undefined;
      const key = docKey(id, remove.scope);
      this.#watchedIds.delete(key);
      if (record.pending.length > 0) {
        // A shadowed remove carries no seq on the wire: the sentinel 1
        // holds W entirely until the shadow clears (see the field doc).
        let seqs = this.#shadowedForeignSeqs.get(key);
        if (seqs === undefined) {
          seqs = new Set();
          this.#shadowedForeignSeqs.set(key, seqs);
        }
        seqs.add(1);
      }
    }

    // Parked accepts apply BEFORE the differential compare: when the frame
    // authoritatively covers a doc the session itself wrote (mixed
    // provenance), the integrated base already CONTAINS the parked write,
    // and the notification must reflect the post-promotion view — not a
    // transient double-apply of a still-standing overlay that the parked
    // application then silently removes.
    this.noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);

    if (before !== undefined) {
      const changes = before.compare(this);
      if (type === "pull" || [...changes].length > 0) {
        this.#subscription.next({
          type,
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifySinks) {
          this.notifySinks(changes);
        }
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }
  }

  // Mark every id this conflicted commit touched (reads + writes) stale until
  // the runner observes caughtUpLocalSeq >= the commit's localSeq — the seq the
  // server stages as the post-conflict catch-up point for these ids.
  private recordStaleFloor(commit: ClientCommit, localSeq: number): void {
    const mark = (id: string, scope?: CellScope) => {
      const key = docKey(id as URI, scope);
      const current = this.#staleFloor.get(key);
      if (current === undefined || current < localSeq) {
        this.#staleFloor.set(key, localSeq);
      }
    };
    for (const operation of commit.operations) {
      if (operation.op === "sqlite") continue; // no entity id
      mark(operation.id, operation.scope);
    }
    for (const read of commit.reads.confirmed) {
      mark(read.id, read.scope);
    }
    for (const read of commit.reads.pending) {
      mark(read.id, read.scope);
    }
  }

  // If any of this commit's reads are still stale (a recorded floor above our
  // current caught-up seq), return the highest such floor — the seq we must
  // reach before a retry can succeed. Only reads gate admission: a stale read
  // precondition is what the server rejects.
  private preemptThreshold(commit: ClientCommit): number | undefined {
    if (this.#staleFloor.size === 0) {
      return undefined;
    }
    let threshold: number | undefined;
    const consider = (id: string, scope?: CellScope) => {
      const floor = this.#staleFloor.get(docKey(id as URI, scope));
      if (floor !== undefined && floor > this.#caughtUpLocalSeq) {
        threshold = threshold === undefined
          ? floor
          : Math.max(threshold, floor);
      }
    };
    for (const read of commit.reads.confirmed) {
      consider(read.id, read.scope);
    }
    for (const read of commit.reads.pending) {
      consider(read.id, read.scope);
    }
    return threshold;
  }

  private makePreemptRejection(
    commit: ClientCommit,
    threshold: number,
  ): StorageTransactionRejected {
    let firstId: URI | undefined;
    for (const operation of commit.operations) {
      if (operation.op !== "sqlite") {
        firstId = operation.id as URI;
        break;
      }
    }
    return {
      name: "ConflictError",
      message:
        `commit preempted: read set stale until caughtUpLocalSeq>=${threshold}`,
      transaction: commit,
      conflict: {
        space: this.#space,
        the: DOCUMENT_MIME,
        of: firstId ?? "of:unknown",
        expected: null,
        actual: null,
        existsInHistory: false,
        history: [],
      },
      // The catch-up that clears `threshold` is already in flight from the
      // earlier conflict; gate the retry directly on it (no provider round trip
      // to wrap, so we do NOT call attachProviderReadyToRetry here).
      readyToRetry: () => this.waitForCaughtUpLocalSeq(threshold),
    };
  }

  // Locally-fabricated rejection for a commit whose doom is provable
  // client-side (dropped pending dependency, or replica reset). Modeled on
  // makePreemptRejection. readyToRetry resolves immediately: the PRIMARY
  // rejection's finalizeRejection already awaited its read repair (or reset
  // wiped the replica outright), so a cascaded victim adds no wait of its own.
  private makeLocalRejection(
    commit: ClientCommit,
    message: string,
  ): StorageTransactionRejected {
    let firstId: URI | undefined;
    for (const operation of commit.operations) {
      if (operation.op !== "sqlite") {
        firstId = operation.id as URI;
        break;
      }
    }
    return {
      name: "ConflictError",
      message,
      transaction: commit,
      conflict: {
        space: this.#space,
        the: DOCUMENT_MIME,
        of: firstId ?? "of:unknown",
        expected: null,
        actual: null,
        existsInHistory: false,
        history: [],
      },
      readyToRetry: () => Promise.resolve(),
    };
  }

  private makeCascadeRejection(
    entry: InFlightCommit,
    droppedLocalSeq: number,
  ): StorageTransactionRejected {
    return this.makeLocalRejection(
      entry.commit,
      `pending dependency dropped locally: localSeq=${droppedLocalSeq}`,
    );
  }

  /** The SPECULATIVE overlay layers a commit's read basis names, if any
   * (server-execution v2 Phase 2, speculation.md §6). Non-empty means
   * the commit must not export: those localSeqs exist only in this
   * process, so as wire pending-read dependencies they can NEVER
   * resolve. */
  private speculativeLayersOf(commit: ClientCommit): number[] {
    if (this.#speculativeLocalSeqs.size === 0) return [];
    const named = new Set<number>();
    for (const read of commit.reads.pending) {
      const layers = Array.isArray(read.localSeq)
        ? read.localSeq
        : [read.localSeq];
      for (const layer of layers) {
        if (this.#speculativeLocalSeqs.has(layer)) named.add(layer);
      }
    }
    return [...named].sort((left, right) => left - right);
  }

  // The loud export refusal (speculation.md §6; RULED 2026-08-13): an
  // authored/pushed commit whose read basis names a speculative overlay
  // layer fails OUTRIGHT — terminal, never retried. Only the client can
  // make this call: it knows which of its layers are speculative, while
  // the server cannot distinguish a dependency that is never coming
  // from one that has not arrived yet. Modeled on toRejectedError's
  // terminal-name arm (RowLabelCommitError): a TransactionError shape
  // whose name is in TERMINAL_REJECTION_NAMES, so the scheduler's
  // disposition is `terminal` instead of a doomed backoff window.
  private makeSpeculativeBasisRefusal(
    commit: ClientCommit,
    speculativeLayers: readonly number[],
  ): StorageTransactionRejected {
    const message =
      `authored commit refused: its read basis names speculative overlay ` +
      `layer(s) ${speculativeLayers.join(", ")} — client speculation ` +
      `entries exist only in this process and can never resolve as wire ` +
      `pending-read dependencies (server-execution v2 speculation.md §6). ` +
      `The write is failed outright instead of retried; re-derivation ` +
      `after the authoritative value lands is the recovery path.`;
    return {
      name: "SpeculativeBasisError",
      message,
      cause: { name: "SystemError", message, code: 409 },
      transaction: commit,
    } as unknown as StorageTransactionRejected;
  }

  /**
   * CT-1872 1b: when a commit's optimistic writes are dropped, every
   * in-flight commit whose pending reads name that localSeq is provably
   * doomed — the dropped commit will never gain a commit row in the
   * per-session commit table, so the server would reject each dependant with
   * "pending dependency not resolved" only after a full round trip (a window
   * of up to 30s+ per commit). Fabricate that rejection locally instead.
   *
   * Commits with no pending reads never enter `#inFlightCommits`, so
   * zero-read mergeable/blind commits are structurally exempt — they are
   * DESIGNED to survive a parent drop (the server materializes their spine
   * via createMissing). Resolving the promises here queues the victims'
   * continuations on later microtasks; each victim snapshots its own revert
   * Differential before its own drop, so the scan itself never re-enters.
   */
  private cascadeDroppedDependency(droppedLocalSeq: number): void {
    for (const entry of [...this.#inFlightCommits.values()]) {
      if (
        entry.settled ||
        entry.localRejectionValue !== undefined ||
        !entry.dependencies.has(droppedLocalSeq)
      ) {
        continue;
      }
      this.rejectInFlightCommitLocally(
        entry,
        this.makeCascadeRejection(entry, droppedLocalSeq),
      );
      logger.debug("commit-cascade-rejected", () => [
        `commit locally rejected: pending dependency localSeq=${droppedLocalSeq} was dropped`,
        { localSeq: entry.localSeq, operations: entry.operations.length },
      ]);
    }
  }

  private attachProviderReadyToRetry(
    rejection: StorageTransactionRejected,
    localSeq: number,
  ): void {
    if (rejection.name !== "ConflictError") {
      return;
    }
    const readyToRetry = rejection.readyToRetry;
    if (readyToRetry === undefined) {
      return;
    }
    rejection.readyToRetry = async () => {
      await readyToRetry();
      await this.waitForCaughtUpLocalSeq(localSeq);
    };
  }

  private async waitForConflictReadRepair(
    rejection: StorageTransactionRejected,
  ): Promise<void> {
    if (rejection.name !== "ConflictError") {
      return;
    }
    const readyToRetry = rejection.readyToRetry;
    if (readyToRetry === undefined) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(
          "conflict-read-repair-timeout",
          "caught-up sync not received within timeout; surfacing conflict",
        );
        resolve();
      }, CONFLICT_READ_REPAIR_TIMEOUT_MS);
    });
    try {
      await Promise.race([readyToRetry(), timedOut]);
    } catch (error) {
      logger.warn(
        "conflict-read-repair",
        "readyToRetry rejected while preserving original conflict result",
        error,
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private record(id: URI, scope?: CellScope): DocumentRecord {
    const key = docKey(id, scope);
    let record = this.#docs.get(key);
    if (!record) {
      record = {
        confirmed: confirmedVersion(0, undefined),
        pending: [],
        materialized: undefined,
      };
      this.#docs.set(key, record);
    }
    return record;
  }

  private applyPending(
    operation: NativeCommitOperation,
    localSeq: number,
  ): void {
    const { id, scope, ...pending } = operation;
    const record = this.record(id, scope);
    record.pending.push(pendingVersion(localSeq, pending));
  }

  // CT-1927 client half: an accept's promotion waits for marker coverage.
  // Immediate application remains for a marker already observed before this
  // replica begins settlement and for servers that predate per-verdict markers
  // (verdictCatchUpMarkers absent: an older server stamps markers only for
  // conflicts, so parking would hang).
  //
  // PUSHED (socket) commits only: sealed commits — engine-plane commits by
  // the co-hosted executor — settle through settleSealedCommit, which
  // confirms immediately (F1a there explains why parking them wedged
  // permanently: no marker is ever staged for an engine-plane commit).
  private settleAccept(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
    resolveAtVerdict = false,
  ): Promise<void> {
    // The retirement floor's ack record (speculation.md §4): known at
    // VERDICT time, before any parking — a parked promotion changes when
    // the value becomes visible, not that the origin acked.
    this.#ackedSeqsByLocalSeq.set(localSeq, applied.seq);
    if (
      this.#ackedSeqsByLocalSeq.size > SpaceReplica.#MAX_RETAINED_ACK_SEQS
    ) {
      const oldest = this.#ackedSeqsByLocalSeq.keys().next();
      if (!oldest.done) this.#ackedSeqsByLocalSeq.delete(oldest.value);
    }
    // The input barrier's own-echo race repair (Phase 2 revisit (a)):
    // the frame can OUTRUN this verdict handler on the same socket, so
    // an own-echo upsert may have been mis-recorded as shadowed foreign
    // novelty before the ack above existed. A shadow whose seq IS this
    // accept's seq on a doc this accept wrote is that mis-record — no
    // foreign commit can share the seq — so lift EXACTLY that seq (the
    // set structure keeps genuine foreign shadows recorded around the
    // echo intact — r3739139487), or a quiet serving loop would clamp
    // W forever against its own echo.
    for (const operation of operations) {
      const key = docKey(operation.id, operation.scope);
      const seqs = this.#shadowedForeignSeqs.get(key);
      if (seqs !== undefined && seqs.delete(applied.seq) && seqs.size === 0) {
        this.#shadowedForeignSeqs.delete(key);
      }
    }
    // The retirement wake for origin accepts (speculation.md §4;
    // leg-C 2026-08-13): a sweep that ran while this verdict was in
    // flight skipped its entries as blocked (unacked layer below), and
    // the covering watermark event has already passed — without this
    // wake a then-quiet space strands them forever. Rejected origins
    // reach the overlay through the dependency cascade; ACCEPTS need
    // this explicit signal. Guarded: an observer throw must not abort
    // accept settlement (same containment posture as notifySinks).
    if (this.speculationAckObserver !== undefined) {
      try {
        this.speculationAckObserver();
      } catch (error) {
        logger.error("speculation-ack-observer-error", () => [
          "speculationAckObserver threw during accept settlement",
          error,
        ]);
      }
    }
    // Parking requires a live marker channel: a server that stages
    // per-verdict markers AND an active sync consumer to deliver them. With
    // no subscribed watch view, no frames arrive at all — there is no
    // novelty stream to order the promotion against, and verdict-time
    // extrapolation is exactly as current as this replica can be.
    const parkable =
      this.#sessionClient?.serverFlags?.verdictCatchUpMarkers === true &&
      this.#subscribedWatchView !== null;
    // Zero-operation commits (scheduler observation batches) carry no state
    // to apply and no view consequences — parking them would only stall
    // synced() on the batch window for nothing.
    //
    // The already-caught-up check is NOT wire-reordering tolerance: since
    // the per-space publication lock (#5529) the marker frame always
    // FOLLOWS its verdict on the socket. It survives for intra-client
    // interleaving — the transact awaiter resumes several microtask hops
    // after its response resolves (request()'s internal awaits), and the
    // marker frame's processing can integrate in that gap — so by the time
    // this runs, the marker may already cover this commit and parking
    // would wait on a frame that has already been consumed.
    if (
      !parkable || operations.length === 0 ||
      this.#caughtUpLocalSeq >= localSeq
    ) {
      this.confirmPending(localSeq, operations, applied);
      return Promise.resolve();
    }
    const settled = Promise.withResolvers<void>();
    this.#parkedAccepts.set(localSeq, { operations, applied, settled });
    // synced() holds on the parked application, not just the verdict: its
    // contract is "storage fully settled", which under parking includes the
    // fan-out of this replica's own accepted writes (CT-1950). The push
    // promise resolves at the verdict, so the barrier needs its own hold.
    // A verdict-resolving commit opts out of the hold — its premise is
    // "accepted but not fanned out", which a synced() that forces the
    // fan-out through would destroy — while its SETTLEMENT timeline still
    // drains coverage; only the caller's returned promise resolves early.
    if (!resolveAtVerdict) {
      const hold: Promise<Result<Unit, StorageTransactionRejected>> = settled
        .promise.then(() => ({ ok: {} }));
      this.#commitPromises.add(hold);
      hold.then(() => this.#commitPromises.delete(hold));
    }
    return settled.promise;
  }

  // The marker channel died (the subscribed view closed): apply everything
  // parked immediately — the legacy verdict-time semantics — so promotions
  // never wait on frames that can no longer arrive.
  private applyParkedAcceptsNow(): void {
    if (this.#parkedAccepts.size === 0) {
      return;
    }
    const due = [...this.#parkedAccepts.keys()].sort((left, right) =>
      left - right
    );
    for (const parked of due) {
      const entry = this.#parkedAccepts.get(parked)!;
      this.#parkedAccepts.delete(parked);
      this.confirmPending(parked, entry.operations, entry.applied);
      entry.settled.resolve();
    }
  }

  private confirmPending(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
  ): void {
    // The accept is being applied (immediately at verdict, or promoted
    // off the parked set): release any read-barrier waiter (whenApplied).
    this.resolveAppliedWaiter(localSeq);
    const keys = new Map(
      operations.map((operation) => [
        docKey(operation.id, operation.scope),
        { id: operation.id, scope: operation.scope },
      ]),
    );
    // The settle input barrier's SHADOW FLIP (Phase 2 revisit (a), flag
    // ON only): when confirmed advanced PAST this accept while it was
    // pending — foreign novelty integrated under the own overlay — the
    // removal below makes the foreign value visible where the overlay
    // was, and NO other path notifies (applySessionSync's differential
    // ran while the overlay still masked the change). Fire the ordinary
    // change notification for exactly the shadowed docs, so scheduler
    // dirtiness registers BEFORE `unappliedForeignSeqFloor` lifts and
    // the serving loop's next wave derives over the foreign value.
    // Flag-gated: the OFF arm keeps today's silent flip byte-for-byte
    // (the residual is self-healing there and the timing delta is not a
    // recorded acceptance — see the Phase-2 PR's Flags).
    const shadowTouched = getServerExecutionConfig()
      ? [...keys.entries()]
        .filter(([key]) => this.#shadowedForeignSeqs.has(key))
        .map(([, address]) => address)
      : [];
    const shouldNotifyShadowSubscribers = shadowTouched.length > 0 &&
      this.hasNotificationSubscribers();
    const shouldNotifyShadowSinks = shadowTouched.length > 0 &&
      this.hasSinkSubscribers(shadowTouched);
    const shadowBefore = shouldNotifyShadowSubscribers
      ? Differential.checkout(
        this,
        shadowTouched.map(({ id, scope }) => snapshotState(this, id, scope)),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    for (const { id, scope } of keys.values()) {
      const record = this.record(id, scope);
      const pendingIndexes = record.pending.flatMap((entry, index) =>
        entry.localSeq === localSeq ? [index] : []
      );
      if (pendingIndexes.length === 0) {
        logger.warn?.(
          `confirmPending: no pending entry for localSeq=${localSeq} on ${id}`,
        );
        continue;
      }
      const firstPendingIndex = pendingIndexes[0]!;
      const lastPendingIndex = pendingIndexes[pendingIndexes.length - 1]!;
      const pending = record.pending[lastPendingIndex]!;
      const previousConfirmed = record.confirmed;
      let promoted: ConfirmedVersion | undefined;
      let reusedSuffix: PendingMaterializedPrefix[] | undefined;

      if (record.confirmed.seq < applied.seq) {
        if (firstPendingIndex === 0) {
          const prefix = materializedVersionThroughPending(
            record,
            { space: this.#space, id, scope },
            lastPendingIndex + 1,
          );
          const cache = ensurePendingMaterializationCache(record);
          promoted = confirmedVersion(
            applied.seq,
            prefix.value,
          );
          promoted.transactionValue = prefix.transactionValue;
          if (cache.confirmed === previousConfirmed) {
            reusedSuffix = cache.prefixes.slice(lastPendingIndex + 1);
          }
        } else {
          promoted = confirmedVersion(
            applied.seq,
            applyPendingVersion(record.confirmed.value, pending, {
              space: this.#space,
              id,
              scope,
            }),
          );
        }
      }

      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );

      if (promoted) {
        record.confirmed = promoted;
        record.materialized = reusedSuffix && reusedSuffix.length > 0
          ? {
            confirmed: promoted,
            prefixes: reusedSuffix,
          }
          : undefined;
        continue;
      }

      dropMaterializedSuffix(record, firstPendingIndex);
    }

    // The shadow-flip notification (see the checkout above): compare the
    // post-removal view and notify exactly the docs whose foreign value
    // just became visible. Same pattern as applySessionSync's integrate
    // notification.
    if (shadowBefore !== undefined) {
      const changes = shadowBefore.compare(this);
      if ([...changes].length > 0) {
        this.#subscription.next({
          type: "integrate",
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifyShadowSinks) {
          this.notifySinks(changes);
        }
      }
    } else if (shouldNotifyShadowSinks) {
      this.notifySinksForIds(shadowTouched);
    }
    // The wake (see the field doc): fired on the flip regardless of
    // notification subscribers AND regardless of a value diff — an
    // echo-equal flip still lifts `unappliedForeignSeqFloor`, which is
    // the state the serving loop's clamped wait is parked on. Guarded:
    // the observer is externally installed (SpaceServer), and a throw
    // here would abort the caller's settlement loop over parked
    // accepts mid-batch — some confirmed, others already deleted from
    // the parked set with unresolved whenApplied waiters (same
    // containment posture as notifySinksForIds' per-subscriber guard).
    if (shadowTouched.length > 0) {
      try {
        this.shadowFlipObserver?.();
      } catch (error) {
        logger.error("shadow-flip-observer-error", () => [
          "shadowFlipObserver threw during promotion",
          error,
        ]);
      }
    }
  }

  private dropPending(localSeq: number): void {
    // A drop can LIFT the shadow floor without a promotion (review
    // thread r3739416417): a rejected/rolled-back own write emptying a
    // shadowed doc's pending set makes the foreign value visible and
    // prunes the floor lazily — but only confirmPending fired the
    // serving loop's wake, so a quiet clamped space stayed asleep
    // until the input-wait timeout. Fire the same flag-gated wake when
    // the drop empties a shadowed doc's pending set.
    let shadowLifted = false;
    for (const [key, record] of this.#docs.entries()) {
      const firstPendingIndex = record.pending.findIndex((entry) =>
        entry.localSeq === localSeq
      );
      if (firstPendingIndex === -1) {
        continue;
      }
      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );
      dropMaterializedSuffix(record, firstPendingIndex);
      if (
        record.pending.length === 0 && this.#shadowedForeignSeqs.has(key)
      ) {
        shadowLifted = true;
      }
    }
    if (shadowLifted && getServerExecutionConfig()) {
      try {
        this.shadowFlipObserver?.();
      } catch (error) {
        logger.error("shadow-flip-observer-error", () => [
          "shadowFlipObserver threw during a pending drop",
          error,
        ]);
      }
    }
  }

  private visibleVersion(id: URI, scope?: CellScope): {
    record: DocumentRecord;
    version: MaterializedVersion;
  } | undefined {
    const record = this.#docs.get(docKey(id, scope));
    if (!record) {
      return undefined;
    }
    return {
      record,
      version: materializedVersionThroughPending(record, {
        space: this.#space,
        id,
        scope,
      }),
    };
  }

  private visibleValue(id: URI, scope?: CellScope): FabricValue | undefined {
    const visible = this.visibleVersion(id, scope);
    if (!visible) {
      return undefined;
    }
    return transactionValueForVersion(visible.version);
  }

  private getState(id: URI, scope?: CellScope): State | undefined {
    const visible = this.visibleVersion(id, scope);
    if (!visible) {
      return undefined;
    }
    const value = transactionValueForVersion(visible.version);
    if (value === undefined) {
      return undefined;
    }
    return {
      ...assert({
        the: DOCUMENT_MIME,
        of: id,
        is: value,
        cause: null,
      }),
      scope: normalizeCellScope(scope),
      since: visible.record.confirmed.seq,
    } as State;
  }

  private visibleDocument(
    id: URI,
    scope?: CellScope,
  ): EntityDocument | undefined {
    return this.visibleVersion(id, scope)?.version.value;
  }

  private notifySinks(changes: IMergedChanges): void {
    const touched = new Map<string, { id: URI; scope?: CellScope }>();
    for (const change of changes) {
      const id = change.address.id as URI;
      const scope = change.address.scope;
      touched.set(docKey(id, scope), { id, scope });
    }
    this.notifySinksForIds(touched.values());
  }

  private notifySinksForIds(
    entries: Iterable<{ id: URI; scope?: CellScope }>,
  ): void {
    for (const { id, scope } of entries) {
      const current = this.visibleDocument(id, scope);
      for (const callback of this.#sinks.get(docKey(id, scope)) ?? []) {
        try {
          callback(current);
        } catch (error) {
          logger.error("sink-error", () => [`storage sink failed: ${error}`]);
        }
      }
    }
  }

  private hasNotificationSubscribers(): boolean {
    const candidate = this.#subscription as IStorageSubscription & {
      hasSubscribers?: () => boolean;
    };
    if (typeof candidate.hasSubscribers === "function") {
      return candidate.hasSubscribers();
    }
    return true;
  }

  private hasSinkSubscribers(
    entries: Iterable<{ id: URI; scope?: CellScope }>,
  ): boolean {
    for (const { id, scope } of entries) {
      if ((this.#sinks.get(docKey(id, scope))?.size ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  private sessionHandle(): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    if (this.#closed) {
      return Promise.reject(new Error("memory replica closed"));
    }
    if (this.#sessionHandle === undefined) {
      // Defer the factory call until after #sessionHandle is installed. Session
      // setup can synchronously re-enter provider work (notably home-space ACL
      // bootstrap); calling the factory inline leaves a window where that work
      // starts a second mount with the same explicit session id and revokes the
      // first mount before it can commit.
      const handle = Promise.resolve().then(() => {
        this.assertActiveRoute();
        return this.#createSession();
      }).then(
        async (resolved) => {
          try {
            this.assertActiveRoute();
          } catch (error) {
            await resolved.client.close();
            throw error;
          }
          this.#sessionClient = resolved.client;
          this.#sessionSession = resolved.session;
          // Session replacement resets the marker epoch: markers for the
          // parked accepts' localSeqs can never arrive from the fresh
          // session, so apply them immediately (the same rule as consumer
          // teardown). Promotion consumes the pending overlays, so the
          // authoritative reinstall sync that follows replaces — never
          // double-applies — their contribution.
          resolved.session.onSessionReplaced = () => {
            this.applyParkedAcceptsNow();
            // A replaced session rejected its outstanding commits; queued
            // event intents re-submit under fresh localSeqs (the target's
            // eventId dedupe keeps a landed original sound — events.md §5).
            this.#eventAppendQueue?.kick();
          };
          return resolved;
        },
      ).catch((error) => {
        if (this.#sessionHandle === handle) {
          this.#sessionHandle = undefined;
        }
        throw error;
      });
      this.#sessionHandle = handle;
    }
    return this.#sessionHandle;
  }
}

const snapshotState = (
  replica: SpaceReplica,
  id: URI,
  scope?: CellScope,
): State => {
  return replica.get({ id, type: DOCUMENT_MIME, path: [], scope }) ??
    ({
      ...unclaimed({ of: id, the: DOCUMENT_MIME }),
      scope: normalizeCellScope(scope),
    } as State);
};

const toConnectionError = (error: unknown): IConnectionError =>
  ({
    name: "ConnectionError",
    message: error instanceof Error ? error.message : String(error),
    address: "",
    cause: {
      name: "SystemError",
      message: error instanceof Error ? error.message : String(error),
      code: 500,
    },
  }) as IConnectionError;

// Preserve a real AuthorizationError (name, message, and the server's retriable
// marker) instead of flattening it to a generic ConnectionError, so a caller can
// tell an authorization denial apart from a transport failure. Everything else
// remains a ConnectionError.
const toPullError = (error: unknown): PullError =>
  error instanceof Error && error.name === "AuthorizationError"
    ? ({
      name: "AuthorizationError",
      message: error.message,
      ...((error as { retriable?: unknown }).retriable === true
        ? { retriable: true }
        : {}),
    }) as unknown as IAuthorizationError
    : toConnectionError(error);

// Rebuild a throwable Error from a stored AuthorizationError result so `synced()`
// rejects with a proper Error instance a caller can match on by name.
const authorizationErrorToThrow = (error: IAuthorizationError): Error =>
  Object.assign(new Error(error.message), { name: "AuthorizationError" });

const toRejectedError = (
  error: unknown,
  commit: ClientCommit,
  space: MemorySpace,
): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error
    ? error.name
    : (error as { name?: unknown })?.name;
  if (name === "StorageTransactionInconsistent") {
    return error as IStorageTransactionInconsistent;
  }
  // `error` may be a primitive or null — never throw while normalizing a
  // commit failure, that would mask the real rejection.
  const precondition = (error as { precondition?: unknown })?.precondition;
  if (
    name === "PreconditionFailedError" &&
    (precondition === "origin-committed" || precondition === "receipt-exists")
  ) {
    return {
      name: "PreconditionFailedError",
      message,
      precondition,
    } as IPreconditionFailedError;
  }
  if (
    name === "ConflictError" ||
    message.includes("stale confirmed read") ||
    message.includes("pending dependency")
  ) {
    const retryAfterSeq = (error as { retryAfterSeq?: unknown })?.retryAfterSeq;
    const readyToRetry = (error as { readyToRetry?: unknown })?.readyToRetry;
    // The conflicted entity: structured field when the error is in-process;
    // parsed from the message when it crossed the wire (Error fields do not
    // survive serialization, the message does — its format is owned by
    // memory/v2/engine.ts's ConflictError construction).
    const staleReadOf = (error as { of?: unknown })?.of ??
      message.match(/stale confirmed read: (\S+) at seq/)?.[1];
    const firstOperation = commit.operations?.[0];
    const firstOperationId = firstOperation && "id" in firstOperation
      ? firstOperation.id
      : undefined;
    const rejected: IConflictError = {
      name: "ConflictError",
      message,
      transaction: commit,
      // Conflict descriptor: for stale-read conflicts `of` is authoritative
      // (the memory engine names the conflicted entity structurally), so a
      // retrier can pull exactly that doc before re-running (CT-1824).
      // `the`/`expected`/`actual` remain placeholders.
      conflict: {
        space,
        the: DOCUMENT_MIME,
        of: ((typeof staleReadOf === "string" ? staleReadOf : undefined) ??
          firstOperationId ?? "of:unknown") as Entity,
        expected: null,
        actual: null,
        existsInHistory: false,
        history: [],
      },
    };
    // retryAfterSeq is carried for diagnostics; retry gating is by caughtUpLocalSeq
    // (readyToRetry), and downstream only uses retryAfterSeq's presence to mark
    // the conflict retryable.
    if (typeof retryAfterSeq === "number") {
      rejected.retryAfterSeq = retryAfterSeq;
    }
    if (typeof readyToRetry === "function") {
      rejected.readyToRetry = () => Promise.resolve(readyToRetry.call(error));
    }
    return rejected;
  }

  // Preserve the wire name the server chose instead of collapsing it into a
  // generic TransactionError. Every classifier downstream — the scheduler's
  // `classifyCommitDisposition`, `Runtime.editWithRetry`'s retry allow-list
  // (storage/rejection.ts) — keys off `error.name`, so flattening here destroys
  // the only evidence they have. The names:
  //
  //  - `RowLabelCommitError`: a deterministic commit-time row-label refusal
  //    (memory/v2/sqlite/commit-eval.ts), classified terminal by
  //    `isTerminalRejection`. Re-running recomputes the identical refused
  //    write, so the doomed re-runs would only starve sibling commits.
  //  - `ProtocolError`: the server refused the commit rather than losing it.
  //    `#validateAclCommit` (memory/v2/server.ts) raises it both for the SHAPE
  //    of an ACL commit (not a whole-document `set`; more than one operation)
  //    and for its VALUE (malformed, or retaining no concrete OWNER). Neither
  //    changes when the identical function is re-run. The name is broader than
  //    those two, though: the engine also raises it for conditions that are a
  //    function of server log state — a pending read whose basis is ahead of
  //    the log, a commit-replay mismatch — and those CAN converge. Treating the
  //    whole name as terminal is a deliberate over-approximation, open on
  //    #5259 pending a decision on marking retriability at the throw site.
  //  - `AuthorizationError`: the server evaluated the request and denied it.
  //    The server's own `retriable` marker (a session-open anti-replay race a
  //    fresh handshake heals) rides along, as it already does on the pull path
  //    (`toPullError` above) — it is what distinguishes the one denial that can
  //    clear from the ones that cannot.
  //  - `SessionError`: the commit was routed to a session the server no longer
  //    knows. Classified TERMINAL by the retry allow-list — not because the
  //    commit was evaluated (it was not), but because nothing on the retry path
  //    remounts the session: `sessionHandle()` memoizes the mount and clears it
  //    only on close. The name still has to survive normalization here, or the
  //    caller sees a generic TransactionError instead of the real cause.
  //  - `InvalidMessageError`: a frame off the wire would not decode, and the
  //    client's `rejectPending` sweep (memory/v2/client.ts `onMessage`) rejected
  //    every in-flight request with it — including this commit, which may never
  //    have been evaluated. That makes it a liveness failure, classified
  //    retryable by `isTransientCommitRejection`; the name has to survive here
  //    or that classification can never fire. It is raised client-side, so
  //    unlike the names above it is not part of the server's wire contract.
  //
  // The memory server MUST keep emitting the server-side names unchanged
  // (server.ts `transact` catch, and the ACL validation errors it returns
  // directly).
  if (
    name === "RowLabelCommitError" || name === "ProtocolError" ||
    name === "AuthorizationError" || name === "SessionError" ||
    name === "InvalidMessageError"
  ) {
    const retriable = (error as { retriable?: unknown })?.retriable === true;
    return {
      name,
      message,
      ...(retriable ? { retriable: true } : {}),
      cause: { name: "SystemError", message, code: 500 },
      transaction: commit,
    } as unknown as TransactionError;
  }

  return {
    name: "TransactionError",
    message,
    cause: {
      name: "SystemError",
      message,
      code: 500,
    },
    transaction: commit,
  } as unknown as TransactionError;
};
