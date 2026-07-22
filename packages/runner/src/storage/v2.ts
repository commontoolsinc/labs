import {
  cloneIfNecessary,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
} from "@commonfabric/data-model/fabric-value";
import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import type { Entity } from "@commonfabric/memory/interface";
import type { RuntimeTelemetryMarker } from "../telemetry.ts";
import {
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type MemorySpace,
  type MIME,
  type Signer,
  type Transaction,
  type TransactionError,
  type URI,
} from "@commonfabric/memory/interface";
import { assert, unclaimed } from "@commonfabric/memory/fact";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  type CellScope,
  type ClientCommit,
  type CommitPrecondition,
  type DocumentPath,
  type EntityDocument,
  getCommitPreconditionsConfig,
  getPersistentSchedulerStateConfig,
  type PatchOp,
  type SchedulerActionSnapshotQuery,
  type SchedulerObservationCommit,
  type SchedulerSnapshotListResult,
  type SessionSync,
  type SqliteDbRef,
  type SqliteOperation,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import { parentPath } from "../../../memory/v2/path.ts";
import {
  patchOpIsStructural,
  touchedPointerPaths,
} from "../../../memory/v2/patch.ts";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import { getLogger } from "@commonfabric/utils/logger";
import {
  isObject,
  isPlainContainer,
  isRecord,
} from "@commonfabric/utils/types";
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
import { recordCommitLocalSeq } from "./commit-identity.ts";
import * as Differential from "./differential.ts";
import type {
  IMemoryAddress,
  IMemorySpaceAddress,
  IMergedChanges,
  IPreconditionFailedError,
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageManager,
  IStorageNotification,
  IStorageProviderWithReplica,
  IStorageSubscription,
  IStorageTransaction,
  NativeStorageCommit,
  PullError,
  PushError,
  Result,
  State,
  StorageNotification,
  StorageTransactionRejected,
  Unit,
} from "./interface.ts";
import { SelectorTracker } from "./selector-tracker.ts";
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
import { toTransactionDocumentValue } from "./v2-document.ts";
import {
  hasValueAtPath,
  isArrayIndexSegment,
  readValueAtPath,
} from "./v2-path.ts";
import {
  compactWatchEntries,
  normalizeSyncEntries,
  watchIdForEntry,
} from "./v2-watch.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
  type SessionFactory,
} from "./v2-remote-session.ts";
import * as V2Transaction from "./v2-transaction.ts";
import { normalizeCellScope } from "../scope.ts";

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
// touched ids until the server catches it up. Two modes gate what we do with a
// new commit whose reads land on a still-catching-up id:
//
//   "preempt" (coarse): assume it will conflict and pre-empt it locally (revert
//     + re-run after catch-up) without sending. Measured NET-NEGATIVE on the
//     lunch-poll workload: the stale floor taints every id a losing tx touched
//     (incl. write targets), so it pre-empts commits that would have SUCCEEDED,
//     turning them into extra revert+re-run cycles. 5x5 server conflicts rose
//     ~1380 -> ~1600 (plus pre-empts), wall time flat (conflicts are cheap).
//
//   "hold" (precise): hold the commit until the catch-up is applied, then run
//     the server's precondition check LOCALLY against the now-current confirmed
//     seqs. Locally revert only the commits that are genuinely stale; SEND the
//     rest. Eliminates the coarse mode's false pre-empts and stops sending
//     knowingly-doomed commits to the server.
//
//     Measured NEUTRAL (safe but no win) on lunch-poll: heldRevert ~= 0,
//     heldSent ~= 70, conflicts ~= baseline. The reason is fundamental — the
//     staleness here is SERVER-side, not locally knowable: when the action
//     runs it reads the latest LOCAL confirmed value, which looks current
//     (read.seq == local confirmed seq), so the local check cannot tell the
//     commit is behind the server. Only the server (or a not-yet-received sync)
//     knows. So the precise check correctly SENDS the held commits (no false
//     pre-empts, unlike coarse) but cannot prevent the server conflict. This
//     mode only pays off where a client routinely holds commits built against
//     data its own later syncs have already superseded.
//
// Default off. Do NOT enable without re-measuring on the target workload.
// Catalogued in docs/development/EXPERIMENTAL_OPTIONS.md (conflictAdmissionMode).
type ConflictAdmissionMode = "off" | "preempt" | "hold";
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
    if (value === "hold") return "hold";
    if (value === "preempt" || value === "1" || value === "true") {
      return "preempt";
    }
    return "off";
  } catch {
    return "off";
  }
}
const dataURISyncCache = new Map<string, Promise<Cell<any>>>();
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
  if (!isObject(value)) {
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
  localSeq: number;
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

const isPathPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const replayPathForPendingPatchTarget = (
  base: EntityDocument | undefined,
  pendingValue: EntityDocument,
  path: readonly string[],
): string[] => {
  if (path.length === 0) {
    return [...path];
  }
  const parent = parentPath(path);
  if (
    Array.isArray(readValueAtPath(base, parent)) ||
    Array.isArray(readValueAtPath(pendingValue, parent))
  ) {
    return parent;
  }
  return [...path];
};

const changedPathsForPendingPatch = (
  base: EntityDocument | undefined,
  pendingValue: EntityDocument,
  patches: readonly PatchOp[],
): string[][] =>
  patches.flatMap((patch) => {
    const leaves = touchedPointerPaths(patch);
    // Structural ops (add/remove/move) may target a slot whose position shifts
    // as the pending value is rebuilt from `base`, so resolve each against live
    // state; value-only ops keep their exact leaf path.
    return patchOpIsStructural(patch)
      ? leaves.map((path) =>
        replayPathForPendingPatchTarget(base, pendingValue, path)
      )
      : leaves;
  });

// Finds the first existing prefix in `base` that blocks a pending nested write.
// cloneWithValueAtPath can create missing containers when applying the selected
// write path.
const firstExistingPrefixThatBlocksPendingPath = (
  base: EntityDocument | undefined,
  path: readonly string[],
): string[] | undefined => {
  for (let length = 1; length < path.length; length += 1) {
    const prefix = path.slice(0, length);
    if (!hasValueAtPath(base, prefix)) {
      // Once a prefix is missing, by definition everything else in the path
      // can be written, so nothing is blocking it.
      return undefined;
    }
    const value = readValueAtPath(base, prefix);
    const nextSegment = path[length]!;
    if (
      !isPlainContainer(value) ||
      (Array.isArray(value) && !isArrayIndexSegment(nextSegment))
    ) {
      return prefix;
    }
  }
  return undefined;
};

const pendingSetPathForBase = (
  base: EntityDocument | undefined,
  pendingValue: EntityDocument,
  path: readonly string[],
): readonly string[] => {
  const prefix = firstExistingPrefixThatBlocksPendingPath(base, path);
  if (!prefix || !hasValueAtPath(pendingValue, prefix)) {
    return path;
  }
  return prefix;
};

const compactChangedPaths = (paths: readonly string[][]): string[][] => {
  const sorted = [...paths].sort((left, right) => left.length - right.length);
  const retained: string[][] = [];
  for (const path of sorted) {
    if (retained.some((existing) => isPathPrefix(existing, path))) {
      continue;
    }
    retained.push(path);
  }
  return retained;
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
      return cloneIfNecessary(pending.value as FabricValue) as EntityDocument;
    case "patch": {
      let next = base;
      for (
        const path of compactChangedPaths(
          changedPathsForPendingPatch(base, pending.value, pending.patches),
        )
      ) {
        if (hasValueAtPath(pending.value, path)) {
          const setPath = pendingSetPathForBase(next, pending.value, path);
          if (!isSamePath(setPath, path)) {
            pendingPatchLogger.warn("pending-branch-replace", () => [
              "pending patch visibility replaced data at an existing branch that blocked the nested write",
              {
                space: logContext.space,
                id: logContext.id,
                scope: normalizeCellScope(logContext.scope),
                localSeq: pending.localSeq,
                path,
                replacementPath: setPath,
              },
            ]);
          }
          next = cloneWithValueAtPath(
            next,
            setPath,
            readValueAtPath(pending.value, setPath),
          ) as EntityDocument;
          continue;
        }
        next = cloneWithoutValueAtPath(next, path) as
          | EntityDocument
          | undefined;
      }
      return next;
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
   * the full endpoint.
   */
  memoryHost: URL;
  /**
   * Optional space DID → host base URL overrides. A space listed here
   * opens its storage connection against that host; absent map or
   * absent entry resolves to `memoryHost`. The map is fixed for the
   * manager's lifetime (the per-space provider cache assumes space →
   * host never changes).
   */
  spaceHostMap?: Record<string, string>;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  /** Space authority used only for fresh named-space ACL genesis. The durable
   *  replica session still authenticates as `as`. */
  spaceIdentity?: Signer;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

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

    if (
      "localSeq" in left && "localSeq" in right &&
      left.localSeq !== right.localSeq
    ) {
      return left.localSeq - right.localSeq;
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
    const dependencyKey = "seq" in candidate
      ? `confirmed:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.seq}`
      : `pending:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.localSeq}`;
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

    if (
      "localSeq" in left && "localSeq" in right &&
      left.localSeq !== right.localSeq
    ) {
      return left.localSeq - right.localSeq;
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
  // In-flight commits, registered synchronously by the transaction layer at
  // commit() entry (see IStorageManager.trackPendingCommit). This is the
  // write-durability barrier: distinct from #crossSpacePromises, which also
  // carries cross-space READ work (link-target loads) and so must not gate
  // "are there unconfirmed writes" questions.
  #pendingCommits = new Set<Promise<unknown>>();
  #pendingCommitsSubscribers = new Set<(pending: boolean) => void>();
  #sessionFactory: SessionFactory;
  #spaceIdentities = new Map<MemorySpace, Signer>();
  /** Seed map from Options — fixed for the manager's lifetime. */
  #seedHosts: Record<string, string>;
  /** Late-bound host hints; see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();
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
    this.#settings = options.settings ?? defaultSettings;
    this.#sessionFactory = sessionFactory;
    if (options.spaceIdentity) {
      this.registerSpaceIdentity(options.spaceIdentity);
    }
    // Snapshot + freeze: the resolver snapshotted its own copy at
    // open(), so refusal logic must see the same fixed facts — a
    // caller mutating their map object must not desynchronize them.
    this.#seedHosts = Object.freeze({ ...(options.spaceHostMap ?? {}) });
  }

  /**
   * Record a runtime-learned host hint for a space (e.g. from the
   * home-space site table). Returns true when the hint is (now) in
   * effect for the space's storage connection. Refusals, by design:
   *
   * - The seed map wins: a seeded space cannot be re-pointed.
   * - An already-OPENED space keeps its connection — a hint must never
   *   silently re-point live storage (re-pointing requires an explicit
   *   close, which is lifecycle follow-up work).
   *
   * Idempotent when the hint matches what is already in effect.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    let normalized: string;
    try {
      normalized = new URL(host).toString();
    } catch (cause) {
      throw new Error(
        `Invalid host for space ${space}: "${host}"`,
        { cause },
      );
    }
    const seeded = this.#seedHosts[space];
    if (seeded !== undefined) {
      return new URL(seeded).toString() === normalized;
    }
    const existing = this.#dynamicHosts.get(space);
    if (this.#providers.has(space)) {
      // Connection already established — only confirmable, not changeable.
      return existing !== undefined &&
        new URL(existing).toString() === normalized;
    }
    this.#dynamicHosts.set(space, host);
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

  open(space: MemorySpace): IStorageProviderWithReplica {
    let provider = this.#providers.get(space);
    if (!provider) {
      // Session principal drives user/session scoped storage. Even when we have
      // a derived space key for named spaces, the connection must authenticate
      // as the active user.
      const signer = this.as;
      provider = new Provider({
        as: signer,
        space,
        settings: this.#settings,
        subscription: this.#subscription,
        createSession: this.#sessionFactory.supportsAclBootstrap === true
          ? () => this.#createInitializedSession(space, signer)
          : () =>
            this.#sessionFactory.create(space, signer, {
              sessionId: this.#sessionId,
            }),
        getTelemetry: () => this.#telemetry,
      });
      this.#providers.set(space, provider);
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
  ): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    const normal = await this.#sessionFactory.create(space, signer, {
      sessionId: this.#sessionId,
    });
    if (this.#sessionFactory.supportsAclBootstrap !== true) return normal;
    const isHomeSpace = signer.did() === space;
    const spaceIdentity = isHomeSpace
      ? signer
      : this.#spaceIdentities.get(space);
    if (spaceIdentity === undefined) return normal;

    const openedServerSeq = normal.session.serverSeq;
    const aclId = `of:${space}`;
    const aclResult = await normal.session.queryGraph({
      roots: [{ id: aclId, selector: { path: [], schema: false } }],
    });
    const aclSnapshot = aclResult.entities.find((entity) =>
      entity.id === aclId && (entity.scope ?? "space") === "space"
    );
    const aclNeverCreated = aclSnapshot?.seq === 0 &&
      aclSnapshot.document === null;
    if (!aclNeverCreated || (!isHomeSpace && openedServerSeq !== 0)) {
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
    await normal.client.close();
    let bootstrapSessionId = crypto.randomUUID();
    while (bootstrapSessionId === this.#sessionId) {
      bootstrapSessionId = crypto.randomUUID();
    }
    const bootstrap = await this.#sessionFactory.create(
      space,
      spaceIdentity,
      { sessionId: bootstrapSessionId },
    );
    try {
      const current = await bootstrap.session.queryGraph({
        roots: [{ id: aclId, selector: { path: [], schema: false } }],
      });
      const snapshot = current.entities.find((entity) =>
        entity.id === aclId && (entity.scope ?? "space") === "space"
      );
      // Recheck emptiness in the authority session. In `off` mode an unrelated
      // writer can still populate the space between the first inspection and
      // bootstrap; that turns it into the named legacy-public case and must
      // not be claimed. Home remains the explicit exception.
      const aclStillNeverCreated = snapshot?.seq === 0 &&
        snapshot.document === null;
      if (aclStillNeverCreated && (isHomeSpace || current.serverSeq === 0)) {
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
      await bootstrap.client.close();
    }

    return await this.#sessionFactory.create(space, signer, resumeNormal);
  }

  async close(): Promise<void> {
    if (this.#providers.size === 0) {
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroy()),
    );
    this.#providers.clear();
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
    if (id.startsWith("data:")) {
      return false;
    }
    const key = `${space}\0${docKey(id, scope)}`;
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
    this.#docPullKicks.delete(`${space}\0${docKey(id, scope)}`);
  }

  addCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.add(promise);
  }

  removeCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.delete(promise);
  }

  // In-flight document loads keyed `space/scope/id` (the scheduler's
  // entityKey format). Refcounted: concurrent syncCell calls for the same
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

  private registerPendingLoad(
    address: { space: MemorySpace; scope: CellScope; id: URI },
  ): (failure?: unknown) => void {
    const key = `${address.space}/${address.scope}/${address.id}`;
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

    if (id.startsWith("data:")) {
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
  ): Promise<unknown> {
    const cfc = isRecord(document?.cfc) ? document.cfc : undefined;
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

  private syncDataURICell<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
  ): Promise<Cell<T>> {
    const pathStr = JSON.stringify(cell.path);
    const schemaStr = schema ? hashStringOf(schema) : "";
    const cacheKey = `${id}|${schemaStr}|${pathStr}|${space}|${
      normalizeCellScope(scope)
    }`;
    const existing = dataURISyncCache.get(cacheKey);
    if (existing) {
      return existing as Promise<Cell<T>>;
    }
    const promise = this.syncDataURICellUncached(
      cell,
      space,
      id,
      schema,
      scope,
    );
    if (dataURISyncCache.size >= DATA_URI_SYNC_CACHE_MAX) {
      dataURISyncCache.clear();
    }
    dataURISyncCache.set(cacheKey, promise);
    return promise;
  }

  private async syncDataURICellUncached<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
  ): Promise<Cell<T>> {
    let value: unknown = valueFromDataUri(id);
    for (const segment of [...cell.path.map(String)]) {
      if (!isRecord(value) && !Array.isArray(value)) {
        return cell;
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
      new ContextualFlowControl(),
      promises,
      new Set(),
    );
    if (promises.length > 0) {
      await Promise.all(promises);
    }
    return cell;
  }

  private collectLinkedCellSyncs(
    value: unknown,
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    cfc: ContextualFlowControl,
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
      if (link.id && !link.id.startsWith("data:")) {
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
          ? cfc.getSchemaAtPath(schema, [String(i)])
          : undefined;
        this.collectLinkedCellSyncs(
          item,
          base,
          itemSchema,
          cfc,
          promises,
          seen,
        );
      }
      return;
    }

    if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (
          child === null || child === undefined || typeof child !== "object"
        ) {
          continue;
        }
        const childSchema = schema
          ? cfc.getSchemaAtPath(schema, [key])
          : undefined;
        this.collectLinkedCellSyncs(
          child,
          base,
          childSchema,
          cfc,
          promises,
          seen,
        );
      }
    }
  }
}

type ProviderOptions = {
  as: Signer;
  space: MemorySpace;
  settings: IRemoteStorageProviderSettings;
  subscription: IStorageSubscription;
  createSession: () => Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  /** Late-bound: resolves to the Runtime's telemetry bus once attached. */
  getTelemetry?: () => TelemetrySink | undefined;
};

/**
 * Minimal marker sink — structurally the Runtime's `RuntimeTelemetry`.
 * Kept structural (type-only import) so the storage layer takes no runtime
 * dependency on the telemetry module.
 */
type TelemetrySink = { submit(marker: RuntimeTelemetryMarker): void };

class Provider implements IStorageProviderWithReplica {
  readonly replica: SpaceReplica;
  #destroyed = false;

  constructor(
    readonly options: ProviderOptions,
  ) {
    this.replica = new SpaceReplica(options);
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
    return this.replica.sync(uri, selector, scope) as Promise<
      Result<Unit, Error>
    >;
  }

  synced(): Promise<void> {
    return this.replica.synced();
  }

  listEntityIds(): Promise<string[] | undefined> {
    return this.replica.listEntityIds();
  }

  listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    return this.replica.listSchedulerActionSnapshots(query);
  }

  areSchedulerAddressesCurrentAtOrBelow(
    addresses: readonly IMemorySpaceAddress[],
    seq: number,
  ): boolean {
    return this.replica.areSchedulerAddressesCurrentAtOrBelow(addresses, seq);
  }

  schedulerHasPendingWriteOverlapping(
    addresses: readonly IMemorySpaceAddress[],
  ): boolean {
    return this.replica.schedulerHasPendingWriteOverlapping(addresses);
  }

  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    return this.replica.sqliteQuery(db, sql, params);
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
    await this.replica.close();
  }

  async destroyNow(): Promise<void> {
    if (!this.#destroyed) {
      this.#destroyed = true;
    }
    await this.replica.closeNow();
  }

  getReplica(): string | undefined {
    return this.options.space;
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

type SchedulerObservationBatchEntry = {
  commit: SchedulerObservationCommit;
  pending: PromiseWithResolvers<Result<Unit, StorageTransactionRejected>>;
};

const docKey = (id: URI, scope?: CellScope): string =>
  `${normalizeCellScope(scope)}\0${id}`;

class SpaceReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #subscription: IStorageSubscription;
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
  readonly #docs = new Map<string, DocumentRecord>();
  readonly #syncTasks = new Map<string, SyncTask>();
  readonly #commitPromises = new Set<
    Promise<Result<Unit, StorageTransactionRejected>>
  >();
  readonly #schedulerObservationBatch: SchedulerObservationBatchEntry[] = [];
  #schedulerObservationFlushScheduled = false;
  #schedulerObservationFlushPromise:
    | Promise<Result<Unit, StorageTransactionRejected>>
    | undefined;
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
  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  #watchedIds = new Set<string>();
  #nextLocalSeq = 1;
  #closed = false;
  #getTelemetry: () => TelemetrySink | undefined;
  #caughtUpLocalSeq = 0;
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
  #watchRefreshFlushing = false;

  constructor(options: ProviderOptions) {
    this.#space = options.space;
    this.#subscription = options.subscription;
    this.#createSession = options.createSession;
    this.#getTelemetry = options.getTelemetry ?? (() => undefined);
  }

  did(): MemorySpace {
    return this.#space;
  }

  get(entry: IMemoryAddress): State | undefined {
    return this.getState(entry.id as URI, entry.scope);
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, PullError>> {
    return await this.pull([[
      { id: uri, type: DOCUMENT_MIME as MIME, scope },
      selector,
    ]]);
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
    if (
      this.#schedulerObservationBatch.length > 0 ||
      this.#schedulerObservationFlushPromise
    ) {
      await this.flushSchedulerObservationBatch();
    }
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    const { session } = await this.sessionHandle();
    return await session.sqliteQuery(db, sql, params);
  }

  async listEntityIds(): Promise<string[] | undefined> {
    const { client, session } = await this.sessionHandle();
    if (client.serverFlags?.entityIdListing !== true) {
      return undefined;
    }
    return (await session.listEntityIds())?.ids;
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
    const { session } = await this.sessionHandle();
    return await session.registerSqliteDiskSource(id, path);
  }

  async listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    if (!getPersistentSchedulerStateConfig()) {
      return { serverSeq: 0, snapshots: [] };
    }
    const { client, session } = await this.sessionHandle();
    // Optional capability, negotiated at hello: a server that did not
    // advertise `persistentSchedulerState` keeps no scheduler rows (and an
    // older build may not know the message at all) — treat as "no snapshots"
    // so the resume path degrades to running fresh, instead of depending on
    // a capability-specific RPC the server never offered.
    if (client.serverFlags?.persistentSchedulerState !== true) {
      return { serverSeq: 0, snapshots: [] };
    }
    return await session.listSchedulerActionSnapshots(query);
  }

  areSchedulerAddressesCurrentAtOrBelow(
    addresses: readonly IMemorySpaceAddress[],
    seq: number,
  ): boolean {
    for (const address of addresses) {
      if (address.space !== this.#space) return false;
      const record = this.#docs.get(
        docKey(address.id as URI, address.scope as CellScope | undefined),
      );
      // Missing/unconfirmed docs cannot prove either the observation's inputs
      // or its committed output surface are present in this replica.
      if (record === undefined || record.confirmed.seq === 0) return false;
      if (record.confirmed.seq > seq) return false;
    }
    return true;
  }

  schedulerHasPendingWriteOverlapping(
    addresses: readonly IMemorySpaceAddress[],
  ): boolean {
    for (const address of addresses) {
      if (address.space !== this.#space) continue;
      const record = this.#docs.get(
        docKey(address.id as URI, address.scope as CellScope | undefined),
      );
      if (record !== undefined && record.pending.length > 0) return true;
    }
    return false;
  }

  getDocument(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.visibleDocument(uri, scope);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.resetConflictAdmissionState();
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    // Settle any queued (not-yet-sent) watch refresh first so its pull promise
    // cannot outlive close(); `#closed` also makes refreshWatchSet fail closed
    // for any refresh already in flight.
    this.cancelQueuedWatchRefresh();
    // Send any batched scheduler observations so they reach the server, but do
    // not await commit confirmation here. A commit whose response is withheld
    // past dispose — the server holding it for a gated read that never arrives —
    // never settles on its own, so awaiting it before the client teardown below
    // would deadlock close(), just as awaiting an in-flight read would. Kicking
    // the flush issues the observation commit into `#commitPromises`; the client
    // teardown rejects every in-flight request, reads and commits alike, and the
    // post-teardown drain settles them.
    const observationFlush = (this.#schedulerObservationBatch.length > 0 ||
        this.#schedulerObservationFlushPromise)
      ? this.flushSchedulerObservationBatch()
      : undefined;
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
    // resolves.
    await Promise.allSettled([
      ...(observationFlush ? [observationFlush] : []),
      ...this.#commitPromises,
    ]);
    await Promise.allSettled([...this.#syncPromises]);
    await Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  }

  private resetConflictAdmissionState(): void {
    this.#caughtUpLocalSeq = 0;
    this.#staleFloor.clear();
  }

  private noteCaughtUpLocalSeq(localSeq: number | undefined): void {
    if (localSeq === undefined) {
      return;
    }
    this.#caughtUpLocalSeq = Math.max(this.#caughtUpLocalSeq, localSeq);
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
    // their read pulls too so no transport promise is left pending.
    void Promise.allSettled([...this.#syncPromises]);
    void Promise.allSettled([...this.#updatePromises]);
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
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
      changes: Differential.load(known),
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
    const cfc = new ContextualFlowControl();
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
          cfc,
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
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const schedulerObservation = getPersistentSchedulerStateConfig()
      ? transaction.schedulerObservation
      : undefined;
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
      operations.length === 0 && schedulerObservation === undefined &&
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
          schedulerObservation,
          preconditions,
          sqliteOps,
        ),
    );
  }

  reset(): void {
    this.#docs.clear();
    this.#watchedIds.clear();
    this.resetConflictAdmissionState();
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica reset"));
    this.cancelQueuedWatchRefresh();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
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
      const { session } = await this.sessionHandle();
      const rawEntries = [...entries];
      const watchEntries = compactWatchEntries(rawEntries);
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
            }
          });
        this.#updatePromises.add(updates);
      }
      return { ok: {} };
    } catch (error) {
      return { error: toConnectionError(error) };
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

  private scheduleWatchRefreshFlush(): void {
    if (
      this.#queuedWatchRefresh === null ||
      this.#queuedWatchRefreshScheduled ||
      this.#watchRefreshFlushing
    ) {
      return;
    }
    this.#queuedWatchRefreshScheduled = true;
    queueMicrotask(() => {
      this.#queuedWatchRefreshScheduled = false;
      if (this.#watchRefreshFlushing || this.#queuedWatchRefresh === null) {
        return;
      }
      const batch = this.#queuedWatchRefresh;
      this.#queuedWatchRefresh = null;
      this.#watchRefreshFlushing = true;
      void this.flushWatchRefreshBatch(batch);
    });
  }

  private async flushWatchRefreshBatch(
    batch: WatchRefreshBatch,
  ): Promise<void> {
    try {
      batch.pending.resolve(
        await this.refreshWatchSet(batch.entries.values(), batch.type),
      );
    } catch (error) {
      batch.pending.resolve({ error: toConnectionError(error) });
    } finally {
      this.#watchRefreshFlushing = false;
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
      if (next.done) {
        return;
      }
      this.applySessionSync(next.value, "integrate");
    }
  }

  private enqueueSchedulerObservationCommit(
    schedulerObservation: unknown,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    if (!getPersistentSchedulerStateConfig()) {
      return Promise.resolve({ ok: {} });
    }
    // Known-unsupported server (hello already negotiated): drop the
    // observation without batching. The flush-time gate below is the
    // authoritative check; this just spares every action commit the
    // batch/flush round once the session has established that scheduler
    // payloads have nowhere to go.
    if (
      this.#sessionClient !== undefined &&
      this.#sessionClient.serverFlags?.persistentSchedulerState !== true
    ) {
      return Promise.resolve({ ok: {} });
    }
    const localSeq = this.#nextLocalSeq++;
    const pending = Promise.withResolvers<
      Result<Unit, StorageTransactionRejected>
    >();
    this.#schedulerObservationBatch.push({
      commit: {
        localSeq,
        reads: this.buildReads(source, localSeq),
        schedulerObservation,
      },
      pending,
    });
    this.scheduleSchedulerObservationFlush();
    return pending.promise;
  }

  private scheduleSchedulerObservationFlush(): void {
    if (this.#schedulerObservationFlushScheduled) {
      return;
    }
    this.#schedulerObservationFlushScheduled = true;
    queueMicrotask(() => {
      this.#schedulerObservationFlushScheduled = false;
      void this.flushSchedulerObservationBatch();
    });
  }

  private async flushSchedulerObservationBatch(): Promise<
    Result<Unit, StorageTransactionRejected>
  > {
    let lastResult: Result<Unit, StorageTransactionRejected> = { ok: {} };
    while (true) {
      if (this.#schedulerObservationFlushPromise) {
        lastResult = await this.#schedulerObservationFlushPromise;
        if (
          this.#schedulerObservationBatch.length === 0 ||
          "error" in lastResult
        ) {
          return lastResult;
        }
        continue;
      }

      if (this.#schedulerObservationBatch.length === 0) {
        return lastResult;
      }

      lastResult = await this.startSchedulerObservationBatchFlush();
      if ("error" in lastResult) {
        return lastResult;
      }
    }
  }

  private startSchedulerObservationBatchFlush(): Promise<
    Result<Unit, StorageTransactionRejected>
  > {
    const entries = this.#schedulerObservationBatch.splice(0);
    const localSeq = this.#nextLocalSeq++;
    const commit: ClientCommit = {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: entries.map((entry) => entry.commit),
    };
    const promise = (async (): Promise<
      Result<Unit, StorageTransactionRejected>
    > => {
      // Persistent scheduler state is an OPTIONAL capability negotiated at
      // hello (memory/v2.ts `compatibleMemoryProtocolFlags`): peers with
      // different scheduler flags must still share memory data. A server that
      // did not advertise it strips scheduler payloads at `transact`, so this
      // observation-only commit would arrive as zero operations and be
      // TERMINALLY rejected ("memory v2 commit requires at least one
      // operation") — and the flush-before-semantic-commit ordering in
      // pushCommit would then spread that rejection to every subsequent
      // semantic commit (event handlers drop their writes without retry;
      // the whole session's writes starve). Fail closed instead: drop the
      // observations — the feature degrades to flag-off semantics (resumes
      // re-run fresh) while semantic traffic proceeds untouched.
      const { client } = await this.sessionHandle();
      if (client.serverFlags?.persistentSchedulerState !== true) {
        return { ok: {} };
      }
      return await this.pushCommit(localSeq, [], commit, undefined);
    })()
      .then((result) => {
        for (const entry of entries) {
          entry.pending.resolve(result);
        }
        return result;
      }, (error) => {
        const rejection = toRejectedError(error, commit, this.#space);
        const result = { error: rejection };
        for (const entry of entries) {
          entry.pending.resolve(result);
        }
        return result;
      });
    this.#schedulerObservationFlushPromise = promise;
    this.#commitPromises.add(promise);
    promise.finally(() => {
      this.#commitPromises.delete(promise);
      if (this.#schedulerObservationFlushPromise === promise) {
        this.#schedulerObservationFlushPromise = undefined;
      }
    });
    return promise;
  }

  private async commitOperations(
    operations: NativeCommitOperation[],
    source?: IStorageTransaction,
    schedulerObservation?: unknown,
    preconditions: readonly CommitPrecondition[] = [],
    sqliteOps: readonly SqliteOperation[] = [],
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const activePreconditions = activeCommitPreconditions(preconditions);
    if (
      operations.length === 0 && sqliteOps.length === 0 &&
      activePreconditions.length === 0
    ) {
      if (schedulerObservation === undefined) {
        return { ok: {} };
      }
      return await this.enqueueSchedulerObservationCommit(
        schedulerObservation,
        source,
      );
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
        ...(schedulerObservation !== undefined ? { schedulerObservation } : {}),
        ...(activePreconditions.length > 0
          ? { preconditions: [...activePreconditions] }
          : {}),
      }),
    );
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
        ),
    );
    this.#commitPromises.add(promise);
    const result = await promise;
    this.#commitPromises.delete(promise);
    return result;
  }

  private async pushCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // Strategy 1: a commit whose read set lands on a still-catching-up id.
    const admissionMode = conflictAdmissionMode();
    if (admissionMode !== "off") {
      const threshold = this.preemptThreshold(commit);
      if (threshold !== undefined) {
        if (admissionMode === "hold") {
          const rejection = this.makePreemptRejection(commit, threshold);
          // Precise mode: hold until the catch-up is applied, then run the
          // server's stale-read check locally. Revert only the genuinely stale
          // commits; fall through to send the ones whose reads still hold.
          try {
            await this.waitForCaughtUpLocalSeq(threshold);
          } catch {
            // Session/replica closing or reset: do not open/send a new session
            // while shutdown is in progress. Finalize the held rejection so the
            // optimistic write is dropped and close can drain promptly.
            return await this.finalizeRejection(
              localSeq,
              operations,
              source,
              rejection,
            );
          }
          if (!this.#closed && this.commitReadsStaleLocally(commit)) {
            logger.debug("commit-held-revert", () => [
              `held commit reverted (locally stale) at caughtUpLocalSeq>=${threshold}`,
              { localSeq, operations: operations.length },
            ]);
            return await this.finalizeRejection(
              localSeq,
              operations,
              source,
              rejection,
            );
          }
          logger.debug("commit-held-sent", () => [
            `held commit sent after catch-up (reads still valid)`,
            { localSeq, operations: operations.length },
          ]);
          // fall through to send
        } else {
          // Coarse mode: assume conflict and pre-empt without sending.
          const rejection = this.makePreemptRejection(commit, threshold);
          logger.debug("commit-preempted", () => [
            `commit preempted: stale until caughtUpLocalSeq>=${threshold}`,
            { localSeq, operations: operations.length },
          ]);
          return await this.finalizeRejection(
            localSeq,
            operations,
            source,
            rejection,
          );
        }
      }
    }
    // The push marker window covers observation flush + (re)dial + send +
    // confirm: the full client-side cost of durably landing this commit.
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
      if (
        operations.length > 0 &&
        (this.#schedulerObservationBatch.length > 0 ||
          this.#schedulerObservationFlushPromise)
      ) {
        const flushResult = await this.flushSchedulerObservationBatch();
        const rejection = flushResult.error;
        if (rejection !== undefined) {
          const error = new Error(rejection.message);
          error.name = rejection.name ?? "TransactionError";
          throw error;
        }
      }
      const { session } = await this.sessionHandle();
      const applied = await session.transact(commit);
      this.confirmPending(localSeq, operations, applied);
      telemetry?.submit({
        type: "storage.push.complete",
        id: pushOpId,
        sessionId: session.sessionId,
      });
      return { ok: {} };
    } catch (error) {
      const rejection = toRejectedError(error, commit, this.#space);
      telemetry?.submit({
        type: "storage.push.error",
        id: pushOpId,
        error: rejection.name ?? "TransactionError",
      });
      this.attachProviderReadyToRetry(rejection, localSeq);
      if (admissionMode !== "off" && rejection.name === "ConflictError") {
        this.recordStaleFloor(commit, localSeq);
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
      return await this.finalizeRejection(
        localSeq,
        operations,
        source,
        rejection,
      );
    }
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
      )
      : undefined;
    await this.waitForConflictReadRepair(rejection);
    this.dropPending(localSeq);
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
      const pendingLocalSeq = record?.pending
        .filter((version) => version.localSeq < localSeq)
        .at(-1)?.localSeq;
      const shape = nonRecursive ? { nonRecursive: true } : {};
      if (pendingLocalSeq !== undefined) {
        pending.push({ id, scope, path, localSeq: pendingLocalSeq, ...shape });
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
        read.id.startsWith("data:")
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
      if (
        opPaths !== undefined &&
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
    const hasAdoptionObservations = type === "integrate" &&
      sync.observations !== undefined &&
      sync.observations.length > 0 &&
      getPersistentSchedulerStateConfig();
    if (
      sync.upserts.length === 0 &&
      sync.removes.length === 0 &&
      !hasAdoptionObservations
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
      )
      : undefined;

    for (const upsert of sync.upserts) {
      const record = this.record(upsert.id as URI, upsert.scope);
      // Watch refreshes can arrive after local confirmations. Never move the
      // confirmed base backwards; pending replay depends on monotonic bases.
      if (upsert.seq < record.confirmed.seq) {
        continue;
      }
      record.confirmed = confirmedVersion(
        upsert.seq,
        upsert.deleted === true ? undefined : upsert.doc,
      );
      record.materialized = undefined;
      this.#watchedIds.add(docKey(upsert.id as URI, upsert.scope));
    }
    for (const remove of sync.removes) {
      const id = remove.id as URI;
      const record = this.record(id, remove.scope);
      record.confirmed = confirmedVersion(0, undefined);
      record.materialized = undefined;
      this.#watchedIds.delete(docKey(id, remove.scope));
    }

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
    // Subscription-carried scheduler observations — other clients' committed
    // action runs for this sync window. Handed to the scheduler AFTER the
    // integrate invalidation above (same synchronous turn, before the
    // deferred dispatch), so adoption clears exactly the dirt these writes
    // caused. See incremental-observation-adoption.md §4.
    if (hasAdoptionObservations) {
      this.#subscription.next({
        type: "scheduler-observations",
        space: this.#space,
        observations: sync.observations!,
        seqCurrentAtOrBelow: (addresses, seq) =>
          this.areSchedulerAddressesCurrentAtOrBelow(addresses, seq),
        hasPendingWriteOverlapping: (addresses) =>
          this.schedulerHasPendingWriteOverlapping(addresses),
      } as StorageNotification);
    }
    this.noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);
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

  // The server's stale-read precondition check, run LOCALLY against the current
  // confirmed seqs (use after catch-up has been applied). Returns true only when
  // a confirmed read is PROVABLY behind our local confirmed base — i.e. the
  // commit is genuinely going to conflict. Anything we cannot prove stale
  // (unknown id, no local record, or only pending reads) returns false so the
  // commit is still sent and the server stays the source of truth.
  private commitReadsStaleLocally(commit: ClientCommit): boolean {
    for (const read of commit.reads.confirmed) {
      const record = this.#docs.get(docKey(read.id as URI, read.scope));
      const confirmedSeq = record?.confirmed.seq ?? 0;
      if (read.seq < confirmedSeq) {
        return true;
      }
    }
    return false;
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
      transaction: commit as unknown as Transaction,
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

  private confirmPending(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
  ): void {
    const keys = new Map(
      operations.map((operation) => [
        docKey(operation.id, operation.scope),
        { id: operation.id, scope: operation.scope },
      ]),
    );
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
  }

  private dropPending(localSeq: number): void {
    for (const record of this.#docs.values()) {
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
    if (this.#sessionHandle === undefined) {
      // Defer the factory call until after #sessionHandle is installed. Session
      // setup can synchronously re-enter provider work (notably home-space ACL
      // bootstrap); calling the factory inline leaves a window where that work
      // starts a second mount with the same explicit session id and revokes the
      // first mount before it can commit.
      const handle = Promise.resolve().then(() => this.#createSession()).then(
        (resolved) => {
          this.#sessionClient = resolved.client;
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

const toRejectedError = (
  error: unknown,
  commit: unknown,
  space: MemorySpace,
): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error
    ? error.name
    : (error as { name?: unknown })?.name;
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
    const firstOperation = (commit as Partial<NativeStorageCommit>)
      .operations?.[0];
    const rejected: IConflictError = {
      name: "ConflictError",
      message,
      transaction: commit as Transaction,
      // Conflict descriptor: for stale-read conflicts `of` is authoritative
      // (the memory engine names the conflicted entity structurally), so a
      // retrier can pull exactly that doc before re-running (CT-1824).
      // `the`/`expected`/`actual` remain placeholders.
      conflict: {
        space,
        the: DOCUMENT_MIME,
        of: ((typeof staleReadOf === "string" ? staleReadOf : undefined) ??
          firstOperation?.id ?? "of:unknown") as Entity,
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

  // A terminal commit rejection (a deterministic server-side refusal of the
  // committed data — today `RowLabelCommitError`, storage/rejection.ts
  // `isTerminalRejection`): preserve the wire name so the scheduler classifies
  // it as non-retryable instead of collapsing it into a generic, bounded-retry
  // TransactionError. Re-running the identical handler recomputes the identical
  // refused write, so the doomed re-runs would only starve sibling commits.
  if (name === "RowLabelCommitError") {
    return {
      name,
      message,
      cause: { name: "SystemError", message, code: 500 },
      transaction: commit as Transaction,
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
    transaction: commit as Transaction,
  } as unknown as TransactionError;
};
