import {
  cloneIfNecessary,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
} from "@commonfabric/data-model/fabric-value";
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
  type Transaction,
  type TransactionError,
  type URI,
} from "@commonfabric/memory/interface";
import { assert, unclaimed } from "@commonfabric/memory/fact";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ActionSettlement,
  actionSettlementFromFrontier,
  type BranchName,
  canonicalActionClaimKey,
  type CellScope,
  type ClientCommit,
  type CommitPrecondition,
  type DocReadAddress,
  type DocSetWatchSpec,
  type DocumentPath,
  type EntityDocument,
  type EntityIdListOptions,
  type EntityIdListResult,
  type ExecutionClaim,
  executionClaimIncarnationKey,
  type ExecutionControlEvent,
  type ExecutionFeedBatch,
  type ExecutionNavigateEvent,
  getCommitPreconditionsConfig,
  getPersistentSchedulerStateConfig,
  getServerPrimaryExecutionConfig,
  getServerPrimaryExecutionDocSetWatchConfig,
  type LegacyBackgroundExclusion,
  type LegacyBackgroundExclusionStatus,
  mergeInputBasisVectors,
  parseSessionExecutionContextKey,
  type PatchOp,
  type PendingRead,
  type SchedulerActionSnapshotQuery,
  type SchedulerExecutionContextKey,
  type SchedulerObservationCommit,
  type SchedulerSnapshotListResult,
  type SchedulerWritersForTargetsResult,
  type SessionSync,
  type SessionSyncRemove,
  type SessionSyncUpsert,
  type SqliteDbRef,
  type SqliteOperation,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  toDocumentPath,
  userExecutionContextKey,
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
  ExecutionRoutingActionDiagnostics,
  ExecutionRoutingBranchTotals,
  ExecutionRoutingDiagnostics,
  ExecutionRoutingDiagnosticsQuery,
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
  SchedulerWritersForTargetsProviderQuery,
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
import {
  DUAL_CHAIN_CLAIM_MATCH_DIAGNOSTIC,
  routeClientActionTransaction,
} from "../client-execution/action-transaction-router.ts";
import { isSchedulerActionObservation } from "../scheduler/persistent-observation.ts";
import {
  actionClaimChainMapKey,
  actionClaimKeyFromObservation,
  executionClaimMatchesActionChain,
  ownChainContextKeys,
} from "../scheduler/servability.ts";

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
import type {
  ReplicaClient,
  ReplicaReadOptions,
  ReplicaSession,
  ReplicaSessionHandle,
  ReplicaWatchView,
} from "./v2-replica-session.ts";

export { watchIdForEntry } from "./v2-watch.ts";
export type { SessionFactory } from "./v2-remote-session.ts";
export type {
  ReplicaClient,
  ReplicaSession,
  ReplicaSessionHandle,
  ReplicaWatchView,
} from "./v2-replica-session.ts";

// These protocol records contain only FabricValue-compatible fields. Keep the
// cast at this boundary so cloning preserves Fabric primitives and the normal
// immutable snapshot semantics instead of using the native structured clone.
const cloneExecutionClaim = (claim: ExecutionClaim): ExecutionClaim =>
  cloneIfNecessary(
    claim as unknown as FabricValue,
  ) as unknown as ExecutionClaim;

const cloneActionSettlement = (
  settlement: ActionSettlement,
): ActionSettlement =>
  cloneIfNecessary(
    settlement as unknown as FabricValue,
  ) as unknown as ActionSettlement;

/**
 * Successful-settlement frontier merge for one action family (identity +
 * acting lane; see `executionOverlayFamilyKey`) — the runner-side settlement
 * coalescer (used by the early-settlement cache and pending-settlement
 * coalescing). The merged record carries `next`'s claim, which is the newer
 * of the two. Scalar basis takes the max; the
 * accepted-data barrier keeps every contributing gate (max acceptedCommitSeq
 * survives); and since C3.5 the vector basis merges per component under the
 * C3A15 vacuous union (`mergeInputBasisVectors`) — a component either side
 * lacks rides through, never zeroes (C3A14: this fresh literal is a
 * settlement CARRIER; dropping the vector here would strand or prematurely
 * drop held foreign-read overlays). Exported for tests — the merged vector
 * is not client-observable until C3.9's drop rule consumes it.
 */
export const mergeSuccessfulExecutionSettlementRecords = (
  current: ActionSettlement,
  next: ActionSettlement,
): ActionSettlement => {
  const inputBasisSeq = current.inputBasisSeq > next.inputBasisSeq
    ? current.inputBasisSeq
    : next.inputBasisSeq;
  const inputBasis = mergeInputBasisVectors(
    current.inputBasis,
    next.inputBasis,
  );
  const currentAcceptedCommitSeq = current.outcome === "committed"
    ? current.acceptedCommitSeq
    : undefined;
  const nextAcceptedCommitSeq = next.outcome === "committed"
    ? next.acceptedCommitSeq
    : undefined;
  const requiredAcceptedCommitSeq = currentAcceptedCommitSeq === undefined
    ? nextAcceptedCommitSeq
    : nextAcceptedCommitSeq === undefined ||
        currentAcceptedCommitSeq > nextAcceptedCommitSeq
    ? currentAcceptedCommitSeq
    : nextAcceptedCommitSeq;
  return requiredAcceptedCommitSeq === undefined
    ? {
      branch: next.branch,
      claim: next.claim,
      inputBasisSeq,
      ...(inputBasis !== undefined ? { inputBasis } : {}),
      outcome: "no-op",
      ...(next.diagnosticCode === undefined
        ? {}
        : { diagnosticCode: next.diagnosticCode }),
    }
    : {
      branch: next.branch,
      claim: next.claim,
      inputBasisSeq,
      ...(inputBasis !== undefined ? { inputBasis } : {}),
      outcome: "committed",
      acceptedCommitSeq: requiredAcceptedCommitSeq,
    };
};

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

/** Owning-lane tag on every pending version (amendment A16): a lane's reads
 * materialize confirmed state plus ONLY its own lane's pending versions.
 * Absent means the space lane, keeping the lanes-free shape untouched. */
type PendingVersionLane = { lane?: SchedulerExecutionContextKey };

type PendingVersion =
  | ({
    localSeq: number;
    op: "set";
    value: EntityDocument;
  } & PendingVersionLane)
  | ({
    localSeq: number;
    op: "patch";
    patches: PatchOp[];
    value: EntityDocument;
  } & PendingVersionLane)
  | ({
    localSeq: number;
    op: "delete";
  } & PendingVersionLane);

const pendingVersionLane = (
  version: PendingVersion,
): SchedulerExecutionContextKey => version.lane ?? "space";

type ConfirmedVersion = MaterializedVersion & {
  seq: number;
};

type PendingMaterializedPrefix = MaterializedVersion & {
  localSeq: number;
};

type PendingMaterializationCache = {
  confirmed: ConfirmedVersion;
  /** Lane the prefixes were materialized for (A16: the prefix cache is
   * lane-keyed). One slot suffices: a foreign-lane read recomputes and
   * replaces it, and the lanes-free world only ever stores "space". */
  lane: SchedulerExecutionContextKey;
  prefixes: PendingMaterializedPrefix[];
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
  materialized?: PendingMaterializationCache;
  /**
   * The DECLARED address this record is held under (F4 doc-set membership).
   * `#docs` IS the replica doc set, so exported membership derives from these
   * addresses directly (FA4) rather than from a filtered read log — a doc
   * written but never read still carries its address here and is a member.
   * Declared scope only (never a resolved scopeKey); the owning lane selects
   * the acting context the `docs` watch registers under. Set once at record
   * creation and invariant for the record's life (the docKey it is keyed by is
   * a pure function of these three).
   */
  readonly address: DocSetMemberAddress;
};

/** Declared address of a held replica doc: the F4 membership unit (FA4). */
type DocSetMemberAddress = {
  id: URI;
  scope?: CellScope;
  lane: SchedulerExecutionContextKey;
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

const isPathPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/** Paths whose new value fully replaces every descendant. Structural and
 * mergeable patch operations deliberately do not qualify. */
const dominatingPendingPaths = (
  pending: PendingVersion,
): string[][] | undefined => {
  if (pending.op === "set" || pending.op === "delete") return [[]];
  if (
    pending.patches.length === 0 ||
    pending.patches.some((patch) => patch.op !== "replace")
  ) return undefined;
  return pending.patches.flatMap(touchedPointerPaths);
};

const pendingVersionDominatedBy = (
  pending: PendingVersion,
  dominatingPaths: readonly (readonly string[])[],
): boolean => {
  if (pending.op === "set" || pending.op === "delete") {
    return dominatingPaths.some((path) => path.length === 0);
  }
  if (
    pending.patches.length === 0 ||
    pending.patches.some((patch) => patch.op !== "replace")
  ) return false;
  return pending.patches.flatMap(touchedPointerPaths).every((path) =>
    dominatingPaths.some((prefix) => isPathPrefix(prefix, path))
  );
};

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
      return cloneIfNecessary(pending.value) as EntityDocument;
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
  lane: SchedulerExecutionContextKey,
): PendingMaterializationCache => {
  const existing = record.materialized;
  if (
    existing && existing.confirmed === record.confirmed &&
    existing.lane === lane
  ) {
    return existing;
  }
  const cache: PendingMaterializationCache = {
    confirmed: record.confirmed,
    lane,
    prefixes: [],
  };
  record.materialized = cache;
  return cache;
};

/**
 * Materialize confirmed state plus the pending prefix `[0, pendingCount)` as
 * seen by `lane`. Prefixes stay indexed by FULL pending-array position so
 * every caller's index math is lane-agnostic; a foreign lane's version is
 * carried forward untouched (amendment A16: a lane's reads materialize
 * confirmed state plus ONLY its own lane's pending versions).
 */
const materializedVersionThroughPending = (
  record: DocumentRecord,
  logContext: PendingPatchLogContext,
  pendingCount = record.pending.length,
  lane: SchedulerExecutionContextKey = "space",
): MaterializedVersion => {
  if (pendingCount <= 0) {
    return record.confirmed;
  }

  const cache = ensurePendingMaterializationCache(record, lane);
  while (cache.prefixes.length < pendingCount) {
    const nextIndex = cache.prefixes.length;
    const base = nextIndex === 0
      ? record.confirmed
      : cache.prefixes[nextIndex - 1]!;
    const pending = record.pending[nextIndex]!;
    cache.prefixes.push(
      pendingVersionLane(pending) === lane
        ? {
          localSeq: pending.localSeq,
          value: applyPendingVersion(base.value, pending, logContext),
          transactionValue: UNCACHED_TRANSACTION_VALUE,
        }
        : {
          // Foreign-lane version: invisible to this lane, value unchanged.
          localSeq: pending.localSeq,
          value: base.value,
          transactionValue: base.transactionValue,
        },
    );
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

export interface ActionTransactionRouteInput {
  readonly space: MemorySpace;
  readonly commit: ClientCommit;
  /** Exact scheduler action object when this transaction came from a run. */
  readonly sourceAction?: object;
  /** Owning execution lane of this commit (C1.9c), captured at commit entry
   * exactly as the replica keys the commit's optimistic structures. A router
   * serving several lanes uses it to select the claim THIS commit runs
   * under; absent means the space lane (pre-lane callers). */
  readonly lane?: SchedulerExecutionContextKey;
}

export type ActionTransactionCommitResult = Result<
  Unit,
  StorageTransactionRejected
>;

export type ActionTransactionRoute =
  | {
    readonly disposition: "upstream";
    /** Called after the router result is accepted by storage and before the
     * upstream commit begins. Used for exact claimed-attempt readiness. */
    readonly afterRouteSelected?: () => void;
    readonly onFirewallRejected?: (diagnosticCode: string) => void;
    /** Exact result of this routed attempt, after the provider has either
     * accepted it upstream or completed its rejection path. */
    readonly onCommitSettled?: (
      result: ActionTransactionCommitResult,
    ) => void;
  }
  | {
    readonly disposition: "local";
    readonly kind: "executor-shadow";
    /** Publish host-visible readiness only after this optimistic transaction
     * is applied and indexed for exact source-action discard. */
    readonly afterLocalApply?: () => void;
  }
  | {
    readonly disposition: "local";
    readonly kind: "claimed-overlay";
    readonly claim: ExecutionClaim;
  }
  | {
    readonly disposition: "unserved";
    readonly diagnosticCode: string;
    readonly afterRouteSelected?: () => void;
    readonly onSettled?: () => void;
  };

export type ActionTransactionRouter = (
  input: ActionTransactionRouteInput,
) => ActionTransactionRoute | Promise<ActionTransactionRoute>;

/**
 * Reduce a rejected claimed action to the only canonical state needed for an
 * unserved settlement: its read basis and exact claim observation. Rejected
 * writes, preconditions, batches, and branch-merge metadata must not get a
 * second chance to block the observation-only settlement.
 */
export function toCanonicalExecutionUnservedCommit(
  commit: ClientCommit,
  localSeq: number,
  diagnosticCode: string,
): ClientCommit {
  const observation = commit.schedulerObservation as Record<string, unknown>;
  return {
    localSeq,
    reads: commit.reads,
    operations: [],
    ...(commit.branch !== undefined ? { branch: commit.branch } : {}),
    ...(commit.codeCID !== undefined ? { codeCID: commit.codeCID } : {}),
    schedulerObservation: {
      ...observation,
      executionUnservedAttempt: { diagnosticCode },
    },
  };
}

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
  /**
   * Executor validation mode: keep optimistic document results in this
   * replica, but never send semantic, scheduler, precondition, or SQLite
   * operations upstream. HostStorageManager is the production caller; normal
   * client storage must leave this false.
   */
  shadowWrites?: boolean;
  /**
   * Whole-action authority router. Executor runtimes use this to keep
   * unclaimed transactions local while sending only an exact claimed rerun
   * upstream. The same seam later hosts client claimed overlays.
   */
  actionTransactionRouter?: ActionTransactionRouter;
  /**
   * C1.5b per-lane acting context: resolve a source action's owning
   * execution lane (the executor Worker consults the action's live claim).
   * Absent on client storage — the space lane stays the only lane.
   */
  executionLaneForAction?: (
    action: object,
  ) => SchedulerExecutionContextKey | undefined;
}

export const defaultSettings: IRemoteStorageProviderSettings = {
  maxSubscriptionsPerSpace: 50_000,
  connectionTimeout: 30_000,
};

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

/** Every in-flight commit a pending read's view sat on. A scalar is the
 * single-layer form of the same thing (CT-1872 1c). */
const pendingReadLayers = (localSeq: number | number[]): number[] =>
  Array.isArray(localSeq) ? localSeq : [localSeq];

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
  const needsCommit = hasStack(commit.reads.pending);
  const needsBatch =
    commit.schedulerObservationBatch?.some((entry) =>
      hasStack(entry.reads.pending)
    ) === true;
  if (!needsCommit && !needsBatch) {
    return commit;
  }
  return {
    ...commit,
    ...(needsCommit
      ? {
        reads: {
          confirmed: commit.reads.confirmed,
          pending: scalarizeReads(commit.reads.pending),
        },
      }
      : {}),
    ...(needsBatch
      ? {
        schedulerObservationBatch: commit.schedulerObservationBatch!.map(
          (entry) =>
            hasStack(entry.reads.pending)
              ? {
                ...entry,
                reads: {
                  confirmed: entry.reads.confirmed,
                  pending: scalarizeReads(entry.reads.pending),
                },
              }
              : entry,
        ),
      }
      : {}),
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
  // FA4/FB7: layers above the manager (the Runtime's missing-doc kick set)
  // hold their own lifetime pull-dedup latches keyed by (space, scope, id);
  // they register here so a membership-retraction eviction clears them in
  // the same step as the replica record (see subscribeDocEvictions).
  #docEvictionSubscribers = new Set<
    (space: MemorySpace, id: URI, scope?: CellScope) => void
  >();
  // In-flight commits, registered synchronously by the transaction layer at
  // commit() entry (see IStorageManager.trackPendingCommit). This is the
  // write-durability barrier: distinct from #crossSpacePromises, which also
  // carries cross-space READ work (link-target loads) and so must not gate
  // "are there unconfirmed writes" questions.
  #pendingCommits = new Set<Promise<unknown>>();
  #pendingCommitsSubscribers = new Set<(pending: boolean) => void>();
  #sessionFactory: SessionFactory;
  readonly #shadowWrites: boolean;
  readonly #actionTransactionRouter?: ActionTransactionRouter;
  readonly #executionLaneForAction?: (
    action: object,
  ) => SchedulerExecutionContextKey | undefined;
  #executionActionKeys = new WeakMap<object, ActionClaimKey>();
  readonly #executionActionsByKey = new Map<string, Set<object>>();
  readonly #clientExecutionEffects = new WeakMap<object, number>();
  #executionActionUnregisterHook: ((action: object) => void) | undefined;
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

  /** C1.8 lane lifecycle: prune a closed user lane's replica records
   * (#executionLanes/#localSeqLanes). No-op for unopened spaces. */
  pruneExecutionLane(
    space: MemorySpace,
    lane: SchedulerExecutionContextKey,
  ): void {
    this.#providers.get(space)?.replica.pruneExecutionLane(lane);
  }

  /**
   * C3.9: the cross-replica read the vector overlay basis needs — the confirmed
   * input revision (and any pending-source translation) each foreign read space
   * contributes, read from that space's OWN replica. `homeSpace` reads are
   * dropped (the home component is the scalar basis); a foreign space the
   * client never opened contributes no component (the overlay simply tracks no
   * basis for it — vacuously covered at the drop rule). This is the
   * StorageManager as the only holder of multiple SpaceReplicas (§5): the
   * per-space vector correlation lives here.
   */
  private captureForeignExecutionBasis(
    homeSpace: MemorySpace,
    reads: readonly ForeignReadRef[],
  ): ForeignExecutionBasisCapture {
    const bySpace = new Map<string, ForeignReadRef[]>();
    for (const read of reads) {
      if (read.space === homeSpace) continue;
      let list = bySpace.get(read.space);
      if (list === undefined) {
        list = [];
        bySpace.set(read.space, list);
      }
      list.push(read);
    }
    const resolved = new Map<string, number>();
    const unresolved = new Map<string, Set<number>>();
    for (const [space, spaceReads] of bySpace) {
      const provider = this.#providers.get(space as MemorySpace);
      if (provider === undefined) continue;
      const contribution = provider.replica.confirmedExecutionBasisForReads(
        spaceReads,
      );
      resolved.set(space, contribution.seq);
      if (contribution.unresolved.size > 0) {
        unresolved.set(space, contribution.unresolved);
      }
    }
    return { resolved, unresolved };
  }

  /**
   * C3.9: broadcast a confirmed source commit to sibling replicas so a foreign
   * (space-B) confirmation resolves the unresolved B component of a cross-space
   * overlay held in another (space-A) replica. Bounded by the open-space count;
   * a replica holding no overlay tracking that space's pending source no-ops.
   */
  private propagateForeignSourceConfirmation(
    space: MemorySpace,
    localSeq: number,
    seq: number,
  ): void {
    for (const [otherSpace, provider] of this.#providers) {
      if (otherSpace === space) continue;
      provider.replica.noteForeignSourceConfirmed(space, localSeq, seq);
    }
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
    this.#shadowWrites = options.shadowWrites === true;
    this.#actionTransactionRouter = options.actionTransactionRouter;
    this.#executionLaneForAction = options.executionLaneForAction;
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

  registerExecutionAction(action: object, key: ActionClaimKey): void {
    this.removeExecutionAction(action);
    this.#executionActionKeys.set(action, key);
    // Chain-scoped registration (context-lattice §2, amendment A15): the
    // client cannot reproduce the server's lane choice, so the action index
    // keys by the ActionClaimKey minus contextKey. A claim or revoke naming
    // any context on the client's own chain must find this action.
    const mapKey = actionClaimChainMapKey(key);
    let actions = this.#executionActionsByKey.get(mapKey);
    if (actions === undefined) {
      actions = new Set();
      this.#executionActionsByKey.set(mapKey, actions);
    }
    actions.add(action);
  }

  unregisterExecutionAction(action: object): void {
    this.removeExecutionAction(action);
    this.#clientExecutionEffects.delete(action);
    this.#executionActionUnregisterHook?.(action);
  }

  /**
   * Observe scheduler action unregistration. The executor Worker uses this to
   * release the exact claim of an action stopped by a demand change, so a
   * shrink only surrenders authority the scheduler actually retired; an action
   * kept live by another demand root never reaches this hook.
   */
  setExecutionActionUnregisterHook(
    hook: ((action: object) => void) | undefined,
  ): void {
    this.#executionActionUnregisterHook = hook;
  }

  private removeExecutionAction(action: object): void {
    const previous = this.#executionActionKeys.get(action);
    if (previous !== undefined) {
      const mapKey = actionClaimChainMapKey(previous);
      const actions = this.#executionActionsByKey.get(mapKey);
      actions?.delete(action);
      if (actions?.size === 0) this.#executionActionsByKey.delete(mapKey);
    }
    this.#executionActionKeys.delete(action);
  }

  private executionActionsForClaimKey(key: ActionClaimKey): readonly object[] {
    return [
      ...this.#executionActionsByKey.get(actionClaimChainMapKey(key)) ?? [],
    ];
  }

  private clearExecutionActions(): void {
    this.#executionActionKeys = new WeakMap();
    this.#executionActionsByKey.clear();
  }

  hasLiveExecutionClaimForAction(action: object): boolean {
    if (
      !getServerPrimaryExecutionConfig() || this.#shadowWrites ||
      this.#actionTransactionRouter !== undefined
    ) {
      return false;
    }
    const key = this.#executionActionKeys.get(action);
    if (key === undefined || key.actionKind !== "computation") return false;
    return this.#providers.get(key.space as MemorySpace)?.replica
      .executionClaimForActionKey(key) !== undefined;
  }

  captureExecutionClaim(
    action: object | undefined,
  ): ExecutionClaim | undefined {
    if (action === undefined || !getServerPrimaryExecutionConfig()) {
      return undefined;
    }
    const key = this.#executionActionKeys.get(action);
    if (key === undefined || key.actionKind !== "effect") return undefined;
    return this.#providers.get(key.space as MemorySpace)?.replica
      .executionClaimForActionKey(key, true);
  }

  beginClientExecutionEffect(action: object): void {
    this.#clientExecutionEffects.set(
      action,
      (this.#clientExecutionEffects.get(action) ?? 0) + 1,
    );
  }

  endClientExecutionEffect(action: object): void {
    const current = this.#clientExecutionEffects.get(action) ?? 0;
    if (current <= 1) this.#clientExecutionEffects.delete(action);
    else this.#clientExecutionEffects.set(action, current - 1);
  }

  getExecutionRoutingDiagnostics(
    query: ExecutionRoutingDiagnosticsQuery,
  ): ExecutionRoutingDiagnostics {
    const replica = this.#providers.get(query.space)?.replica;
    if (replica === undefined) {
      throw new Error(
        `Execution diagnostics space ${query.space} has not been opened`,
      );
    }
    return replica.getExecutionRoutingDiagnostics(query);
  }

  private clientExecutionEffectInFlight(action: object): boolean {
    return (this.#clientExecutionEffects.get(action) ?? 0) > 0;
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
        shadowWrites: this.#shadowWrites,
        actionTransactionRouter: this.#actionTransactionRouter,
        executionLaneForAction: this.#executionLaneForAction,
        clientExecutionEffectInFlight: (action) =>
          this.clientExecutionEffectInFlight(action),
        executionActionsForClaimKey: (key) =>
          this.executionActionsForClaimKey(key),
        captureForeignExecutionBasis: (reads) =>
          this.captureForeignExecutionBasis(space, reads),
        onSourceCommitConfirmed: (localSeq, seq) =>
          this.propagateForeignSourceConfirmation(space, localSeq, seq),
        supportsExecutionDemand:
          this.#sessionFactory.supportsExecutionDemand === true,
        createSession: this.#sessionFactory.supportsAclBootstrap === true
          ? () => this.#createInitializedSession(space, signer)
          : () =>
            this.#sessionFactory.create(space, signer, {
              sessionId: this.#sessionId,
            }),
        getTelemetry: () => this.#telemetry,
        onDocEvicted: (id, scope) => this.handleDocEviction(space, id, scope),
      });
      this.#providers.set(space, provider);
    }
    return provider;
  }

  /** Remove optimistic executor-shadow versions produced by one live action
   * before rerunning that action under an authoritative claim. */
  discardShadowWritesForAction(space: MemorySpace, action: object): void {
    this.#providers.get(space)?.replica.discardShadowWritesForAction(action);
  }

  /**
   * Run `fn` with `lane` as the space's ambient acting lane (C1.5b): its
   * synchronous reads and commits resolve documents under that lane's
   * effective scope keys, and its pulls register their watches under the
   * lane's per-request acting context (C1.4b). The executor Worker wraps a
   * claimed action's run; everything else stays on the space lane.
   */
  runWithExecutionLane<T>(
    space: MemorySpace,
    lane: SchedulerExecutionContextKey,
    fn: () => T,
  ): T {
    this.open(space);
    return this.#providers.get(space)!.replica.runWithExecutionLane(lane, fn);
  }

  /**
   * The lane a run in `space` is acting as right now — see
   * `IStorageManager.actingExecutionLane`. Read-only: it never opens a
   * provider (an unopened space has no lane by construction) and never
   * registers one.
   */
  actingExecutionLane(
    space: MemorySpace,
    sourceAction?: object,
  ): SchedulerExecutionContextKey {
    return this.#providers.get(space)?.replica.actingExecutionLane(
      sourceAction,
    ) ?? "space";
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
  ): Promise<ReplicaSessionHandle> {
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
      this.clearExecutionActions();
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroy()),
    );
    this.#providers.clear();
    this.clearExecutionActions();
    this.#sessionId = crypto.randomUUID();
  }

  async closeNow(): Promise<void> {
    if (this.#providers.size === 0) {
      this.clearExecutionActions();
      return;
    }
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.destroyNow()),
    );
    this.#providers.clear();
    this.clearExecutionActions();
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

  /** See IStorageManager.subscribeDocEvictions. */
  subscribeDocEvictions(
    callback: (space: MemorySpace, id: URI, scope?: CellScope) => void,
  ): () => void {
    this.#docEvictionSubscribers.add(callback);
    return () => this.#docEvictionSubscribers.delete(callback);
  }

  /**
   * Same-step latch release on membership retraction (FA4/FB7): a space
   * replica evicting a held doc reports it here. The pull-kick latches exist
   * because "the first pull registers a server-side watch that keeps the doc
   * flowing afterwards" — the retraction just ended that watch coverage, so
   * both the manager's own reservation and any subscribed runtime-side kick
   * latch must be handed back or the next read of the doc is deduped into
   * silent staleness instead of re-pulling.
   */
  private handleDocEviction(
    space: MemorySpace,
    id: URI,
    scope?: CellScope,
  ): void {
    this.retractDocPullKick(space, id, scope);
    for (const callback of this.#docEvictionSubscribers) {
      try {
        callback(space, id, scope);
      } catch (error) {
        console.error("doc-eviction subscriber threw:", error);
      }
    }
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
  // Sync failures already logged, keyed by (space, error identity). A denied
  // space repeats the identical failure for every doc pulled from it; one line
  // per distinct failure keeps the surfacing readable. Bounded: at the cap the
  // set resets, trading a repeated line for an unbounded set.
  #loggedSyncFailures = new Set<string>();

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
  shadowWrites: boolean;
  actionTransactionRouter?: ActionTransactionRouter;
  clientExecutionEffectInFlight: (action: object) => boolean;
  executionActionsForClaimKey: (key: ActionClaimKey) => readonly object[];
  /** C1.5b: resolve a source action's owning execution lane (the executor
   * Worker consults its live claim). Absent everywhere the space lane is the
   * only lane. */
  executionLaneForAction?: (
    action: object,
  ) => SchedulerExecutionContextKey | undefined;
  supportsExecutionDemand: boolean;
  createSession: () => Promise<ReplicaSessionHandle>;
  /**
   * C3.9 cross-space overlay basis (StorageManager-mediated): capture each
   * foreign read space's confirmed input revision from that space's OWN replica
   * at overlay creation. Absent everywhere the space lane is the only cross-
   * replica context (single-space managers, executor storage); a same-space
   * overlay never calls it, so the vector path stays inert and byte-identical.
   */
  captureForeignExecutionBasis?: (
    reads: readonly ForeignReadRef[],
  ) => ForeignExecutionBasisCapture;
  /**
   * C3.9: announce a confirmed home-space source commit so the manager can
   * correlate it into foreign-read overlays held in SIBLING replicas (a
   * space-B confirmation resolving an unresolved B component of an overlay held
   * in space A's replica). Absent leaves the confirmation local-only.
   */
  onSourceCommitConfirmed?: (localSeq: number, seq: number) => void;
  /**
   * The client end of the navigateTo seam (navigate-to-server-side.md §2c): a
   * `session.execution.navigate` event this session received. Absent leaves the
   * event inert, which is the right posture for any replica with no view to
   * actuate (the executor Worker's own included).
   */
  onExecutionNavigate?: (event: ExecutionNavigateEvent) => void;
  /** Late-bound: resolves to the Runtime's telemetry bus once attached. */
  getTelemetry?: () => TelemetrySink | undefined;
  /** FA4/FB7: same-step latch release on membership retraction — the manager
   * clears its lifetime pull-dedup latches (its own shouldPullDoc reservation
   * plus subscribed runtime-side kick latches) for each doc the replica
   * evicts, so the next read re-pulls instead of going silently stale. */
  onDocEvicted?: (id: URI, scope?: CellScope) => void;
};

/**
 * Minimal marker sink — structurally the Runtime's `RuntimeTelemetry`.
 * Kept structural (type-only import) so the storage layer takes no runtime
 * dependency on the telemetry module.
 */
type TelemetrySink = { submit(marker: RuntimeTelemetryMarker): void };

class Provider implements IStorageProviderWithReplica {
  readonly replica: SpaceReplica;
  readonly setExecutionDemand?: (
    branch: BranchName,
    pieces: readonly string[],
  ) => Promise<boolean>;
  #destroyed = false;

  constructor(
    readonly options: ProviderOptions,
  ) {
    this.replica = new SpaceReplica(options);
    if (options.supportsExecutionDemand) {
      this.setExecutionDemand = (branch, pieces) =>
        this.replica.setExecutionDemand(branch, pieces);
    }
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

  authorizationError(): Error | undefined {
    return this.replica.authorizationError();
  }

  ensureSession(): Promise<void> {
    return this.replica.ensureSession();
  }

  listEntityIds(): Promise<string[] | undefined> {
    return this.replica.listEntityIds();
  }

  listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    return this.replica.listEntityIdPage(options);
  }

  entityIdExists(id: string): Promise<boolean | undefined> {
    return this.replica.entityIdExists(id);
  }

  listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    return this.replica.listSchedulerActionSnapshots(query);
  }

  writersForTargets(
    query: SchedulerWritersForTargetsProviderQuery,
  ): Promise<SchedulerWritersForTargetsResult> {
    return this.replica.writersForTargets(query);
  }

  acquireLegacyBackgroundExclusion(
    branch: string,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    return this.replica.acquireLegacyBackgroundExclusion(branch);
  }

  renewLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    return this.replica.renewLegacyBackgroundExclusion(
      branch,
      exclusionGeneration,
    );
  }

  releaseLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusion | null | undefined> {
    return this.replica.releaseLegacyBackgroundExclusion(
      branch,
      exclusionGeneration,
    );
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
    options?: ReplicaReadOptions,
  ): Promise<SqliteQueryResult> {
    return this.replica.sqliteQuery(db, sql, params, options);
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
  /** Acting lane the batch's watches register under (C1.4b read seam):
   * batches never mix lanes — one request carries one acting context. */
  lane: SchedulerExecutionContextKey;
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

type ClaimedOverlayGeneration = {
  readonly localSeq: number;
  readonly claim: ExecutionClaim;
  readonly sourceAction: object;
  /** Owning lane of the overlay's commit (C1.5b) — keys its touched-document
   * lookups. Client overlays stay on the space lane: the claim's contextKey
   * partitions HOST authority, not this client-local replica. */
  readonly lane: SchedulerExecutionContextKey;
  readonly createdAt: number;
  /** Home-space component of the input basis (the scalar basis, as pre-C3.9). */
  basisSeq: number;
  readonly unresolvedBasisLocalSeqs: Set<number>;
  /**
   * C3.9 vector basis: the FOREIGN components of the overlay's per-space input
   * basis (space DID → confirmed input revision), captured at overlay creation
   * from each foreign read space's OWN replica (StorageManager-mediated). Empty
   * for a same-space overlay — the vector path is then inert and every drop
   * decision is byte-identical to the pre-C3.9 scalar rule.
   */
  readonly foreignBasis: Map<string, number>;
  /**
   * C3.9: foreign components still awaiting a pending-source translation
   * (space DID → the foreign replica's unconfirmed source localSeqs). The
   * cross-replica analog of {@link unresolvedBasisLocalSeqs}: the foreign
   * read consumed a client-local pending write in that space, so the true
   * basis is that write's eventual confirmed seq. StorageManager correlates
   * the foreign replica's confirmation stream in and resolves it. An overlay
   * with any non-empty set is not yet coverable (its foreign basis can still
   * rise above a settlement's component).
   */
  readonly unresolvedForeignBasis: Map<string, Set<number>>;
  readonly touched: readonly { id: URI; scope?: CellScope }[];
};

/**
 * THE SUCCESSFUL OVERLAY DROP'S CARRIER (`claim-deletion-scope.md` §2b, the
 * "successful overlay drop" row): the ACTION FAMILY a speculative overlay and
 * a server settlement share — **action identity + the acting lane**, and
 * nothing else.
 *
 * It used to be {@link executionClaimIncarnationKey}, which is this key plus
 * `leaseGeneration` and `claimGeneration`. Those two components answer *who is
 * authorised to run this action* — pure arbitration, and they disappear with
 * the claim mechanism. The question this index has to answer is *which local
 * speculation does the server's canonical value replace*, and the ordering
 * half of that answer was never carried by the generations: it is carried by
 * the SEQ comparisons, which are unchanged below —
 * {@link SpaceReplica.settlementCoversOverlay} (`basisSeq` vs the settlement's
 * `inputBasisSeq` plus every present foreign component) and the accepted-data
 * barrier (`#executionAppliedSeq` vs `acceptedCommitSeq`). So the carrier is
 * `(action identity, acting lane, seq)` with the seq exactly where it already
 * was, and the generations simply drop out.
 *
 * PRECISION IS NOT LOST. Two overlays of one family never carry two
 * incarnations at the same instant: every incarnation change drops the
 * previous incarnation's overlays before installing the new claim
 * (`claim-generation-replaced`, `claim-snapshot-replaced`, `claim-revoked`),
 * and an overlay minted against a claim that is no longer live is dropped at
 * creation (`captured-claim-no-longer-live`). Partitioning by family is
 * therefore the SAME partition the incarnation key produced — pinned by
 * "one action family holds at most one overlay generation" in
 * `client-execution-overlay.test.ts`.
 *
 * `contextKey` IS the acting lane (`space`, `user:<enc>`, `session:<enc>:<enc>`
 * — the same canonical encoding `laneScopeKeyForActingContext` consumes on the
 * host), so the family key partitions lanes apart exactly as before: a user
 * lane's settlement can never retire a session lane's speculation.
 */
const executionOverlayFamilyKey = (claim: ActionClaimKey): string =>
  actionClaimMapKey(claim);

/**
 * C3.9 (C3A19): the computable divergence comparand, surfaced as a
 * routeDiagnostics code. Incremented at an authoritative overlay drop for each
 * tracked foreign space whose settlement component STRICTLY exceeds the
 * overlay's captured foreign basis — the revealed home value reflects foreign
 * state newer than what the client's own foreign replica had confirmed when the
 * overlay was created. The §5 vector divergence window (the analog of §B.4's
 * scalar window) is ACCEPTED, brief, self-healing, and COUNTED — never blocked.
 *
 * Owner ruling (C3A19, recorded not resolved): the settlement-metadata channel
 * is DECLARED and counted — a settlement's foreign {space, seq} components reach
 * every session the home delivery predicate matches, so this counter measures a
 * real (accepted) exposure window. The alternative — STRIPPING foreign
 * components from settlements delivered to sessions whose principal lacks READ
 * on that space (a delivery-time filter in the session-registry's
 * `#sessionAcceptsClaim` settlement arm, accepting scalar-only reconciliation
 * for those sessions) — is intentionally NOT taken here; that filter lives in
 * the host session registry (out of the runner's scope) and would be the
 * owner's to flip.
 */
const CROSS_SPACE_BASIS_DIVERGENCE_DIAGNOSTIC = "cross-space-basis-divergence";

/** C3.9: one foreign read address to capture an input-basis component for. */
type ForeignReadRef = { space: string; id: URI; scope?: CellScope };

/**
 * C3.9: the foreign input-basis components captured for one overlay at
 * creation. `resolved` is the max confirmed input revision per foreign space;
 * `unresolved` is the pending-source localSeqs whose confirmed seq is the true
 * basis (see {@link ClaimedOverlayGeneration.unresolvedForeignBasis}).
 */
type ForeignExecutionBasisCapture = {
  resolved: Map<string, number>;
  unresolved: Map<string, Set<number>>;
};

type ExecutionRoutingDiagnosticRecord = {
  readonly key: ActionClaimKey;
  upstreamRoutes: number;
  claimedOverlayRoutes: number;
  readonly settlements: {
    committed: number;
    noOp: number;
    failed: number;
    unserved: number;
  };
  basisCoveredOverlayDrops: number;
  nonAuthoritativeOverlayDrops: number;
  lastSettlement?: ActionSettlement;
};

type MutableExecutionRoutingBranchTotals = {
  upstreamRoutes: number;
  claimedOverlayRoutes: number;
  readonly settlements: {
    committed: number;
    noOp: number;
    failed: number;
    unserved: number;
  };
  basisCoveredOverlayDrops: number;
  nonAuthoritativeOverlayDrops: number;
  readonly settlementDiagnostics: Record<string, number>;
  readonly routeDiagnostics: Record<string, number>;
};

const emptyExecutionRoutingBranchTotals =
  (): MutableExecutionRoutingBranchTotals => ({
    upstreamRoutes: 0,
    claimedOverlayRoutes: 0,
    settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
    basisCoveredOverlayDrops: 0,
    nonAuthoritativeOverlayDrops: 0,
    settlementDiagnostics: {},
    routeDiagnostics: {},
  });

const EXECUTION_ROUTING_DIAGNOSTIC_ACTION_LIMIT = 128;

type SchedulerObservationBatchEntry = {
  commit: SchedulerObservationCommit;
  /** Asserting lane, captured at enqueue: one flush commit carries exactly
   * one lane's observations (A6 one-commit-one-lane, client side). */
  lane: SchedulerExecutionContextKey;
  pending: PromiseWithResolvers<Result<Unit, StorageTransactionRejected>>;
};

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

/** Memoized user-chain collapse of one session lane key (CA3): the
 * canonical `user:<principal>` member of the lane's own chain, derived from
 * the session key's principal segment through the canonical helpers only.
 * `null` records a non-canonical key so it is parsed once. The map grows by
 * one tiny entry per distinct session lane key this process ever sees —
 * bounded by session-lane churn, never by document count. */
const sessionLaneUserCollapse = new Map<string, string | null>();
const userChainKeyOfSessionLane = (lane: string): string | undefined => {
  let collapsed = sessionLaneUserCollapse.get(lane);
  if (collapsed === undefined) {
    const parsed = parseSessionExecutionContextKey(lane);
    collapsed = parsed === undefined
      ? null
      : userExecutionContextKey(parsed.principal);
    sessionLaneUserCollapse.set(lane, collapsed);
  }
  return collapsed ?? undefined;
};

/**
 * Effective replica scope key of one document instance (C1.5b, context-lattice
 * §2/§7): the intra-replica confidentiality boundary between execution lanes.
 *
 * - The space lane keys by the DECLARED scope — byte-identical to the
 *   pre-lane keys, so a lanes-free replica (the flag-off world) behaves
 *   exactly as today.
 * - A non-space lane shares broad ("space"-declared) instances with every
 *   other lane, and keys scoped instances by the lane's resolved scope key
 *   (the canonical context key — a colon-bearing string no declared scope
 *   can collide with).
 * - A BROADER-but-in-chain declared scope collapses to the broadest chain
 *   member that owns it (C2.5, review CA3): `user` under a
 *   `session:<p>:<s>` lane keys `user:<p>` — matching the host stamp, which
 *   resolves user scope principal-wide and ignores the session id — so a
 *   session lane reading a user input shares ONE instance with the
 *   principal's user lane instead of minting a phantom session-keyed
 *   duplicate. (`space` under any lane is the same rule; it collapses
 *   above.) The collapse changes only WHICH record a lane resolves — the
 *   A16 pending-visibility boundary is per-version (`PendingVersionLane`)
 *   and per-localSeq (`#localSeqLanes`), both exact-lane comparisons the
 *   collapse never touches, so chain siblings sharing a record still never
 *   see each other's pending versions.
 * - A declared scope the lane cannot resolve — NARROWER than the lane
 *   ("session" under a user lane, host-rejected at C1.4b) or under a
 *   non-canonical lane key — still gets a collision-free per-lane key; this
 *   only keeps local keying total.
 */
const laneScopeKey = (
  scope: CellScope,
  lane: SchedulerExecutionContextKey,
): string => {
  if (lane === "space" || scope === "space") return scope;
  if (scope === "user" && lane.startsWith("user:")) return lane;
  if (lane.startsWith("session:")) {
    if (scope === "session") return lane;
    // scope === "user": the broader-in-chain collapse (CA3).
    const collapsed = userChainKeyOfSessionLane(lane);
    if (collapsed !== undefined) return collapsed;
  }
  return `${lane}\0${scope}`;
};

const docKey = (
  id: URI,
  scope?: CellScope,
  lane: SchedulerExecutionContextKey = "space",
): string => `${laneScopeKey(normalizeCellScope(scope), lane)}\0${id}`;

class SpaceReplica implements ISpaceReplica {
  readonly #space: MemorySpace;
  readonly #as: Signer;
  readonly #subscription: IStorageSubscription;
  readonly #createSession: () => Promise<ReplicaSessionHandle>;
  readonly #shadowWrites: boolean;
  readonly #actionTransactionRouter?: ActionTransactionRouter;
  readonly #clientExecutionEffectInFlight: (action: object) => boolean;
  readonly #executionActionsForClaimKey: (
    key: ActionClaimKey,
  ) => readonly object[];
  /** C3.9: capture foreign read spaces' confirmed input revisions at overlay
   * creation (StorageManager-mediated cross-replica read). */
  readonly #captureForeignExecutionBasis?: (
    reads: readonly ForeignReadRef[],
  ) => ForeignExecutionBasisCapture;
  /** C3.9: announce a confirmed source commit for cross-replica correlation. */
  readonly #onSourceCommitConfirmed?: (localSeq: number, seq: number) => void;
  /**
   * The client end of the navigateTo seam (navigate-to-server-side.md §2c): a
   * `session.execution.navigate` event delivered to THIS session, handed on for
   * actuation. Absent on any replica whose host has no shell to navigate — the
   * executor Worker's own replica included — and absent is correct there, not a
   * dropped message: the server half of navigateTo is the decision, and a
   * process with no view has nothing to actuate.
   *
   * Deliberately typed as the raw event rather than a resolved Cell. The
   * payload is exactly the four `NormalizedFullLink` fields the shell already
   * round-trips through `postMessage` today, and resolving it into a Cell is
   * the consumer's job (and may require sync), not this replica's.
   */
  readonly #onExecutionNavigate?: (event: ExecutionNavigateEvent) => void;
  /** Owning lane of a source action's transactions (C1.5b): the executor
   * Worker resolves a claimed action to its claim's contextKey so commits
   * assert exactly one lane (A6) and key their documents by it. */
  readonly #executionLaneForAction?: (
    action: object,
  ) => SchedulerExecutionContextKey | undefined;
  /** Ambient acting lane for reads/commits without a lane-resolvable source
   * action. "space" (the only lane of the flag-off world) by default. */
  #actingLane: SchedulerExecutionContextKey = "space";
  /** Every non-space lane ever engaged on this replica. Sync-frame
   * attribution assigns an upsert to a lane instance only when its resolved
   * scopeKey names a member; per-lane lifecycle (drains) is C1.8's. */
  readonly #executionLanes = new Set<string>();
  /** Owning lane of every locally allocated non-space-lane commit localSeq.
   * Another lane's localSeqs are host-unresolvable for a commit (A16), the
   * same way shadow and claimed-overlay versions are. Empty while only the
   * space lane exists. */
  readonly #localSeqLanes = new Map<number, SchedulerExecutionContextKey>();
  readonly #shadowLocalSeqsByAction = new WeakMap<object, Set<number>>();
  // Every executor-shadow local commit, across all actions. A shadow version
  // never reaches the host, so an upstream commit's pending read must never
  // name one (see rebaseUnresolvablePendingReads).
  readonly #shadowLocalSeqs = new Set<number>();
  readonly #executionClaims = new Map<string, ExecutionClaim>();
  readonly #claimedOverlays = new Map<number, ClaimedOverlayGeneration>();
  // A fast server settlement can beat the client's bounded speculative run.
  // Retain one latest settlement per live claim incarnation so a later local
  // overlay still observes the same basis/data barriers and cannot get stuck.
  readonly #earlyExecutionSettlements = new Map<string, ActionSettlement>();
  readonly #executionRoutingDiagnostics = new Map<
    string,
    ExecutionRoutingDiagnosticRecord
  >();
  readonly #executionRoutingBranchTotals = new Map<
    BranchName,
    MutableExecutionRoutingBranchTotals
  >();
  #truncatedExecutionRoutingDiagnosticRecords = 0;
  readonly #confirmedSeqByLocalSeq = new Map<number, number>();
  #pendingExecutionSettlements: ActionSettlement[] = [];
  #executionFeedSeq = 0;
  #executionAppliedSeq = 0;
  #executionClaimRouting = false;
  #executionBuiltinPassivity = false;
  /**
   * The client's own lattice chain accept set (context-lattice §2, A10):
   * {space, user:<myDid>, session:<myDid>:<mySessionId>} in canonical
   * encoding, captured from the provider signer and the exact live session
   * when execution control initializes. Consulted only while
   * #executionClaimRouting is on.
   */
  #executionOwnContextKeys: ReadonlySet<string> = new Set(["space"]);
  #executionSnapshotRequired = false;
  #executionWatchHandoffComplete = false;
  /**
   * F4 client closure export latch: the server advertises the doc-set watch
   * subcapability AND this build's own dial is on. Recomputed on every attach
   * (like the other subcapability latches), so a takeover onto a connection
   * that lost the capability downgrades the session back to graph watches.
   * When false the entire export path is inert and byte-identical to flag-off.
   */
  #docSetWatchActive = false;
  /**
   * Monotone version counter for the space-lane `docs` watch id. Each reconcile
   * mints a FRESH id: the server's watch.set drops the sources of docs watches
   * the new set no longer carries (register-new-first, so surviving members
   * keep their lastSentSeq), so a fresh id is how a SHRUNKEN membership retracts
   * an evicted doc's source while re-adding every survivor (FA8 make-before-
   * break). A stable id could only grow the served set.
   */
  #docSetWatchIdSeq = 0;
  /** The space-lane `docs` watch id currently registered on the session, or
   * undefined while the space lane is still on graph watches. */
  #docSetWatchId: string | undefined;
  /** docKeys of the members in the currently-registered space `docs` watch, so
   * a reconcile can skip a redundant watch.set when membership is unchanged. */
  #docSetRegisteredKeys: ReadonlySet<string> = new Set();
  /** Microtask debounce so a burst of same-turn membership changes (closure
   * growth, speculative writes, retractions) issues a single watch.set. */
  #docSetReconcileScheduled = false;
  /**
   * RPC serialization for the membership reconcile (the 2026-07-24 composed-
   * browser finding): at most ONE watch.set is ever in flight. Without this,
   * a membership change landing while a reconcile awaited its round-trip
   * started a SECOND concurrent reconcile; two watch.sets with different
   * member snapshots interleave at the server (replace semantics, last write
   * wins), so an OLDER snapshot could land last and retract the docs only the
   * newer one carried — manufacturing remove/evict/re-pull churn on the hot
   * path. A change arriving mid-flight sets the dirty latch instead; the
   * loop in {@link runSpaceDocSetReconcile} re-reconciles with the then-
   * current membership after the in-flight call resolves, so a burst of
   * changes coalesces into one trailing watch.set rather than a stampede.
   */
  #docSetReconcileInFlight = false;
  #docSetReconcileDirty = false;
  #sessionHandle?: Promise<ReplicaSessionHandle>;
  /** The client of the last RESOLVED session handle — for synchronous
   *  capability reads (`sqliteServerCommitRowLabelEval`). */
  #sessionClient?: ReplicaClient;
  /** The session of the last RESOLVED handle — read synchronously so
   *  `authorizationError()` can observe a denial that terminated the session
   *  during reconnect, which closes its watch view without a fresh watch result
   *  to record. */
  #sessionSession?: ReplicaSession;
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
  #watchView: ReplicaWatchView | null = null;
  // The specific view instance that `consumeUpdates` is iterating. This can
  // diverge from `#watchView` (the client may hand back a fresh view instance
  // on a later refresh while the original consumer keeps running), so teardown
  // must close *this* view to settle the consumer's pending `next()`. Closing
  // only `#watchView` can leave the consumer's view open, hanging dispose() on
  // `Promise.allSettled([...#updatePromises])`.
  #subscribedWatchView: ReplicaWatchView | null = null;
  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
  #watchedIds = new Set<string>();
  #nextLocalSeq = 1;
  #closed = false;
  #getTelemetry: () => TelemetrySink | undefined;
  /** FA4/FB7 latch release on eviction; see ProviderOptions.onDocEvicted. */
  readonly #onDocEvicted?: (id: URI, scope?: CellScope) => void;
  #caughtUpLocalSeq = 0;
  #caughtUpLocalSeqWaiters: {
    localSeq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];
  // docKey -> required caughtUpLocalSeq. An entry means "this id conflicted and
  // is stale until we observe caughtUpLocalSeq >= value". Pruned as the runner
  // catches up; only populated while conflict admission control is enabled.
  #staleFloor = new Map<string, number>();
  /** One queued refresh batch per acting lane: a lane's watches register
   * under its own per-request acting context and cannot share a request
   * with another lane's. */
  readonly #queuedWatchRefreshes = new Map<
    SchedulerExecutionContextKey,
    WatchRefreshBatch
  >();
  /** Lanes whose queued batch already has a flush microtask pending. Same role
   * as the pre-lane `#queuedWatchRefreshScheduled` boolean, per lane. */
  readonly #scheduledWatchRefreshLanes = new Set<
    SchedulerExecutionContextKey
  >();
  /** FB13 lane-drain coverage lifecycle: the (address, selector) pairs a
   * non-space lane registered under a PER-LANE selector-tracker key (scoped
   * roots — `laneScopeKey` differs from the declared scope). When the lane
   * drains, its host-side scoped watches are retired, so this coverage must
   * go with them or the lane's next hydration would be a covered no-op
   * against a watch that no longer exists. Broad entries key shared
   * coverage and are deliberately NOT recorded: their watch is re-keyed
   * context-free on drain, so the coverage stays valid. */
  readonly #laneScopedSelectorEntries = new Map<
    SchedulerExecutionContextKey,
    {
      address: { id: URI; type: MIME; scope?: CellScope };
      selector: SchemaPathSelector;
    }[]
  >();
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

  #settings: IRemoteStorageProviderSettings;

  constructor(options: ProviderOptions) {
    this.#space = options.space;
    this.#as = options.as;
    this.#subscription = options.subscription;
    this.#createSession = options.createSession;
    this.#getTelemetry = options.getTelemetry ?? (() => undefined);
    this.#onDocEvicted = options.onDocEvicted;
    this.#shadowWrites = options.shadowWrites;
    this.#actionTransactionRouter = options.actionTransactionRouter;
    this.#clientExecutionEffectInFlight = options.clientExecutionEffectInFlight;
    this.#executionActionsForClaimKey = options.executionActionsForClaimKey;
    this.#captureForeignExecutionBasis = options.captureForeignExecutionBasis;
    this.#onSourceCommitConfirmed = options.onSourceCommitConfirmed;
    this.#onExecutionNavigate = options.onExecutionNavigate;
    this.#executionLaneForAction = options.executionLaneForAction;
    this.#settings = options.settings;
  }

  did(): MemorySpace {
    return this.#space;
  }

  /**
   * Run `fn` with `lane` as the ambient acting lane (C1.5b per-lane acting
   * context). The ambient covers the SYNCHRONOUS extent of `fn` plus any
   * lane capture points inside it (pull entry, commit entry); a commit whose
   * source action resolves through `executionLaneForAction` does not need
   * the ambient. Nesting restores the outer lane on exit.
   */
  runWithExecutionLane<T>(
    lane: SchedulerExecutionContextKey,
    fn: () => T,
  ): T {
    this.registerExecutionLane(lane);
    const previous = this.#actingLane;
    this.#actingLane = lane;
    try {
      return fn();
    } finally {
      this.#actingLane = previous;
    }
  }

  private registerExecutionLane(lane: SchedulerExecutionContextKey): void {
    if (lane !== "space") this.#executionLanes.add(lane);
  }

  /** C1.8 lane lifecycle (the C1.5b follow-on): forget one CLOSED lane's
   * records. The caller has already cancelled the lane's claimed attempts,
   * so no new work arrives under it. localSeq attributions whose commits
   * are still pending on any document are retained — A16's cross-lane
   * unresolvability must keep holding for those stragglers until they
   * settle; a later prune (or replica teardown) collects them. */
  pruneExecutionLane(lane: SchedulerExecutionContextKey): void {
    if (lane === "space") return;
    this.#executionLanes.delete(lane);
    // FB13 watch lifecycle: a drained lane's grant is gone server-side, so
    // every read re-sending its acting context rejects forever. Retire (or
    // re-key onto the sponsor path) the lane's host-side watches…
    const sessionHandle = this.#sessionHandle;
    if (sessionHandle !== undefined) {
      sessionHandle
        .then(({ session }) => session.pruneLaneWatches?.(lane))
        .catch(() => {
          // The session never opened cleanly; there is nothing to prune.
        });
    }
    // …drop the lane's scoped selector coverage so its NEXT hydration
    // re-pulls instead of no-oping against a retired watch…
    const scopedEntries = this.#laneScopedSelectorEntries.get(lane);
    if (scopedEntries !== undefined) {
      this.#laneScopedSelectorEntries.delete(lane);
      for (const { address, selector } of scopedEntries) {
        this.#watchSelectorTracker.delete(address, selector);
      }
    }
    // …and cancel any not-yet-flushed registration batch queued under the
    // lane: flushing it would register fresh watches under the dead context.
    const queued = this.#queuedWatchRefreshes.get(lane);
    if (queued !== undefined) {
      this.#queuedWatchRefreshes.delete(lane);
      queued.pending.resolve({
        error: toConnectionError(new Error("execution lane drained")),
      });
    }
    if (this.#localSeqLanes.size === 0) return;
    const stillPending = new Set<number>();
    for (const record of this.#docs.values()) {
      for (const entry of record.pending) stillPending.add(entry.localSeq);
    }
    for (const [localSeq, seqLane] of [...this.#localSeqLanes]) {
      if (seqLane === lane && !stillPending.has(localSeq)) {
        this.#localSeqLanes.delete(localSeq);
      }
    }
  }

  /** Owning lane of a commit: the source action's resolved lane when the
   * provider can name one, else the ambient acting lane. Captured
   * synchronously at each commit/read entry — never across an await. */
  private commitLane(
    source?: IStorageTransaction,
  ): SchedulerExecutionContextKey {
    const lane = this.actingExecutionLane(source?.sourceAction);
    this.registerExecutionLane(lane);
    return lane;
  }

  /**
   * The lane a run is ACTING AS, by the same resolution `commitLane` uses —
   * the source action's pinned lane when the provider can name one, else the
   * ambient acting lane — but WITHOUT registering it. The read-only half is
   * what callers outside the commit path need (a builtin asking "which user
   * am I running for?"); registration is a commit-path obligation and must
   * not be a side effect of asking.
   *
   * Like every lane capture, this must be read synchronously inside the run's
   * own extent: `runWithExecutionLane` restores the previous ambient lane on
   * synchronous exit, so a post-await read sees the space lane.
   */
  actingExecutionLane(
    sourceAction?: object,
  ): SchedulerExecutionContextKey {
    return (sourceAction === undefined
      ? undefined
      : this.#executionLaneForAction?.(sourceAction)) ?? this.#actingLane;
  }

  /**
   * The per-commit acting context this commit sends on the wire (C1.4b's
   * write-side twin, slice 1 of the claim deletion): the lane the commit was
   * ENTERED under, recorded at `commitOperations` entry. The host validates it
   * against the live lane grant and makes it the commit's sole acting context
   * — the engine no longer re-derives one from the claims the observation
   * asserts, and no longer fences the two computations against each other.
   *
   * Space-lane commits (the entire ordinary-client population, and the
   * executor's own space-rank runs) send nothing and stay byte-identical.
   */
  private commitActingContext(
    localSeq: number,
  ): { actingContext: SchedulerExecutionContextKey } | undefined {
    const lane = this.#localSeqLanes.get(localSeq);
    return lane === undefined || lane === "space"
      ? undefined
      : { actingContext: lane };
  }

  /** Replica document key of `(id, scope)` as seen by the acting lane. */
  private actingDocKey(id: URI, scope?: CellScope): string {
    return docKey(id, scope, this.#actingLane);
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
    await this.sessionHandle();
  }

  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    options?: ReplicaReadOptions,
  ): Promise<SqliteQueryResult> {
    const { session } = await this.sessionHandle();
    // The lane is NOT read from `#actingLane` here, unlike every other read
    // verb: this call happens in a post-commit flush, after the action's
    // synchronous extent, when `runWithExecutionLane` has already restored the
    // previous ambient lane. The caller captures it inside the run and passes
    // it in (`sqlite-builtins.ts`, `actingExecutionLane`).
    return await session.sqliteQuery(db, sql, params, options);
  }

  async acquireLegacyBackgroundExclusion(
    branch: string,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    const { session } = await this.sessionHandle();
    return await session.acquireLegacyBackgroundExclusion?.(branch);
  }

  async renewLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    const { session } = await this.sessionHandle();
    return await session.renewLegacyBackgroundExclusion?.(
      branch,
      exclusionGeneration,
    );
  }

  async releaseLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusion | null | undefined> {
    const { session } = await this.sessionHandle();
    return await session.releaseLegacyBackgroundExclusion?.(
      branch,
      exclusionGeneration,
    );
  }

  async listEntityIds(): Promise<string[] | undefined> {
    const { client, session } = await this.sessionHandle();
    if (client.serverFlags?.entityIdListing !== true) {
      return undefined;
    }
    if (client.serverFlags.entityIdPagination !== true) {
      return (await session.listEntityIds?.())?.ids;
    }

    const ids: string[] = [];
    let after: string | undefined;
    let expectedServerSeq: number | undefined;
    for (;;) {
      const page = await session.listEntityIds?.({
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
    const { client, session } = await this.sessionHandle();
    if (
      client.serverFlags?.entityIdListing !== true ||
      client.serverFlags.entityIdPagination !== true
    ) {
      return undefined;
    }
    return await session.listEntityIds?.(options);
  }

  async entityIdExists(id: string): Promise<boolean | undefined> {
    const { client, session } = await this.sessionHandle();
    if (client.serverFlags?.entityIdLookup !== true) {
      return undefined;
    }
    return (await session.entityIdExists?.(id))?.exists;
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
    // Captured synchronously: the acting lane rides the request as the
    // C1.4b per-request acting context.
    const lane = this.#actingLane;
    const { client, session } = await this.sessionHandle();
    // Optional capability, negotiated at hello: a server that did not
    // advertise `persistentSchedulerState` keeps no scheduler rows (and an
    // older build may not know the message at all) — treat as "no snapshots"
    // so the resume path degrades to running fresh, instead of depending on
    // a capability-specific RPC the server never offered.
    if (client.serverFlags?.persistentSchedulerState !== true) {
      return { serverSeq: 0, snapshots: [] };
    }
    return await session.listSchedulerActionSnapshots(
      query,
      lane === "space" ? undefined : { actingContext: lane },
    );
  }

  async writersForTargets(
    query: SchedulerWritersForTargetsProviderQuery,
  ): Promise<SchedulerWritersForTargetsResult> {
    if (
      !getPersistentSchedulerStateConfig() ||
      query.targets.some((target) => target.space !== this.#space)
    ) {
      return { serverSeq: 0, writers: [] };
    }
    const lane = this.#actingLane;
    const { client, session } = await this.sessionHandle();
    if (client.serverFlags?.schedulerWriterLookup !== true) {
      return { serverSeq: 0, writers: [] };
    }
    return await session.writersForTargets({
      ...(query.branch !== undefined ? { branch: query.branch } : {}),
      targets: query.targets.map((target) => ({
        id: target.id,
        ...(target.scope !== undefined ? { scope: target.scope } : {}),
        path: toDocumentPath([...target.path]),
      })),
    }, lane === "space" ? undefined : { actingContext: lane });
  }

  async setExecutionDemand(
    branch: BranchName,
    pieces: readonly string[],
  ): Promise<boolean> {
    const { session } = await this.sessionHandle();
    return await session.setExecutionDemand?.(branch, pieces) ?? false;
  }

  areSchedulerAddressesCurrentAtOrBelow(
    addresses: readonly IMemorySpaceAddress[],
    seq: number,
  ): boolean {
    for (const address of addresses) {
      if (address.space !== this.#space) return false;
      const record = this.#docs.get(
        this.actingDocKey(
          address.id as URI,
          address.scope as CellScope | undefined,
        ),
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
    const lane = this.#actingLane;
    for (const address of addresses) {
      if (address.space !== this.#space) continue;
      const record = this.#docs.get(
        docKey(
          address.id as URI,
          address.scope as CellScope | undefined,
          lane,
        ),
      );
      // Only the acting lane's own pending versions exist for it (A16).
      if (
        record !== undefined &&
        record.pending.some((version) => pendingVersionLane(version) === lane)
      ) {
        return true;
      }
    }
    return false;
  }

  getDocument(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.visibleDocument(uri, scope);
  }

  executionClaimForActionKey(
    key: ActionClaimKey,
    requireBuiltinPassivity = false,
  ): ExecutionClaim | undefined {
    if (
      !this.#executionClaimRouting ||
      (requireBuiltinPassivity && !this.#executionBuiltinPassivity)
    ) {
      return undefined;
    }
    // Chain-scoped lookup (context-lattice §2, A10/A15): accept a live claim
    // whose key matches minus contextKey and whose contextKey is on the own
    // chain. Two such claims are the state issuance-side disjointness makes
    // impossible; per amendment A3 the lookup then picks NEITHER — the
    // caller falls open to client execution — and counts the observation.
    let match: ExecutionClaim | undefined;
    for (const candidate of this.#executionClaims.values()) {
      if (
        !executionClaimMatchesActionChain(
          candidate,
          key,
          this.#executionOwnContextKeys,
        )
      ) {
        continue;
      }
      if (match !== undefined) {
        this.noteExecutionRouteDiagnostic(
          key.branch,
          DUAL_CHAIN_CLAIM_MATCH_DIAGNOSTIC,
        );
        return undefined;
      }
      match = candidate;
    }
    return match;
  }

  getExecutionRoutingDiagnostics(
    query: ExecutionRoutingDiagnosticsQuery,
  ): ExecutionRoutingDiagnostics {
    if (query.space !== this.#space) {
      throw new TypeError(
        `Execution diagnostics for ${query.space} requested from ${this.#space}`,
      );
    }
    if (query.resetCounters === true) {
      this.#executionRoutingDiagnostics.clear();
      this.#executionRoutingBranchTotals.clear();
      this.#truncatedExecutionRoutingDiagnosticRecords = 0;
    }

    const matchesQuery = (key: ActionClaimKey): boolean =>
      key.space === query.space && key.branch === query.branch &&
      (query.pieceId === undefined || key.pieceId === query.pieceId) &&
      (query.actionId === undefined || key.actionId === query.actionId);
    // The per-action view joins every source by the chain key (A15): one
    // logical action stays one record whatever context its claims name. The
    // exposed key is the chain representative; `claims` and `liveClaim`
    // carry the true contextKeys.
    const actionKeys = new Map<string, ActionClaimKey>();
    const addActionKey = (key: ActionClaimKey): void => {
      if (!matchesQuery(key)) return;
      actionKeys.set(
        actionClaimChainMapKey(key),
        canonicalActionClaimKey({ ...key, contextKey: "space" }),
      );
    };

    for (const record of this.#executionRoutingDiagnostics.values()) {
      addActionKey(record.key);
    }
    for (const liveClaim of this.#executionClaims.values()) {
      addActionKey(liveClaim);
    }
    for (const overlay of this.#claimedOverlays.values()) {
      addActionKey(overlay.claim);
    }
    for (const settlement of this.#pendingExecutionSettlements) {
      addActionKey(settlement.claim);
    }

    const claims = [...this.#executionClaims.values()]
      .filter(matchesQuery)
      .sort((left, right) =>
        actionClaimMapKey(left).localeCompare(actionClaimMapKey(right))
      )
      .map(cloneExecutionClaim);
    const actions: ExecutionRoutingActionDiagnostics[] = [...actionKeys]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([mapKey, key]) => {
        const record = this.#executionRoutingDiagnostics.get(mapKey);
        const liveClaim = [...this.#executionClaims.values()]
          .filter((candidate) => actionClaimChainMapKey(candidate) === mapKey)
          .sort((left, right) =>
            actionClaimMapKey(left).localeCompare(actionClaimMapKey(right))
          )[0];
        const overlays = [...this.#claimedOverlays.values()].filter((overlay) =>
          actionClaimChainMapKey(overlay.claim) === mapKey
        );
        const pendingSettlements = this.#pendingExecutionSettlements.filter(
          (settlement) => actionClaimChainMapKey(settlement.claim) === mapKey,
        );
        const lastSettlement = record?.lastSettlement ??
          pendingSettlements.at(-1);
        return {
          key,
          ...(liveClaim !== undefined
            ? { liveClaim: cloneExecutionClaim(liveClaim) }
            : {}),
          upstreamRoutes: record?.upstreamRoutes ?? 0,
          claimedOverlayRoutes: record?.claimedOverlayRoutes ?? 0,
          settlements: record === undefined
            ? { committed: 0, noOp: 0, failed: 0, unserved: 0 }
            : { ...record.settlements },
          basisCoveredOverlayDrops: record?.basisCoveredOverlayDrops ?? 0,
          nonAuthoritativeOverlayDrops: record?.nonAuthoritativeOverlayDrops ??
            0,
          pendingOverlayCount: overlays.length,
          unresolvedBasisOverlayCount: overlays.filter((overlay) =>
            overlay.unresolvedBasisLocalSeqs.size > 0
          ).length,
          pendingSettlementCount: pendingSettlements.length,
          ...(lastSettlement !== undefined
            ? { lastSettlement: cloneActionSettlement(lastSettlement) }
            : {}),
        };
      });

    return {
      space: this.#space,
      branch: query.branch,
      executionFeedSeq: this.#executionFeedSeq,
      executionAppliedSeq: this.#executionAppliedSeq,
      snapshotRequired: this.#executionSnapshotRequired,
      claims,
      actions,
      branchTotals: this.cloneExecutionRoutingBranchTotals(query.branch),
      truncatedActionRecords: this.#truncatedExecutionRoutingDiagnosticRecords,
    };
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
        | ReplicaSessionHandle
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
      ...(observationFlush ? [observationFlush] : []),
      ...this.#commitPromises,
      ...this.#suppressedVerdicts,
    ]);
    await Promise.allSettled([...this.#syncPromises]);
    await Promise.allSettled([...this.#updatePromises]);
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
    this.#laneScopedSelectorEntries.clear();
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
    // their read pulls too so no transport promise is left pending. Suppressed
    // verdicts settle off the same teardown rejection.
    void Promise.allSettled([...this.#syncPromises]);
    void Promise.allSettled([...this.#updatePromises]);
    void Promise.allSettled([...this.#suppressedVerdicts]);
    this.rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
    this.#laneScopedSelectorEntries.clear();
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

    // The acting lane is captured synchronously at pull entry (C1.5b): a
    // lane's pull registers its watch under that lane's acting context and
    // never dedupes onto another lane's identical-looking pull — the same
    // address resolves to a different instance per lane.
    const lane = this.#actingLane;
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
        laneScopeKey(normalizeCellScope(address.scope), lane) ?? null,
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
        // Lane-effective scope: selector coverage never crosses lanes.
        scope: laneScopeKey(
          normalizeCellScope(address.scope),
          lane,
        ) as CellScope,
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
    const fetchPromise = this.enqueueWatchRefresh("pull", newEntries, lane);
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
        // Lane-effective scope: selector coverage never crosses lanes.
        scope: laneScopeKey(
          normalizeCellScope(address.scope),
          lane,
        ) as CellScope,
      };
      // The tracker promise is what FUTURE pulls covered by these selectors
      // await: their data is available once THIS fetch lands, independent of
      // this batch's own covered set — so register the raw fetch promise.
      this.#watchSelectorTracker.add(
        baseAddress,
        selector,
        fetchPromise,
      );
      // A per-lane-keyed entry (scoped root under a non-space lane) is
      // recorded for the FB13 lane-drain coverage prune; broad entries stay
      // shared coverage and survive the drain via the re-keyed watch.
      if (baseAddress.scope !== normalizeCellScope(address.scope)) {
        const scopedEntries = this.#laneScopedSelectorEntries.get(lane);
        const entry = { address: baseAddress, selector };
        if (scopedEntries !== undefined) scopedEntries.push(entry);
        else this.#laneScopedSelectorEntries.set(lane, [entry]);
      }
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
            // Lane-effective scope: selector coverage never crosses lanes.
            scope: laneScopeKey(
              normalizeCellScope(address.scope),
              lane,
            ) as CellScope,
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
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>();
    this.#laneScopedSelectorEntries.clear();
    this.#subscription.next({
      type: "reset",
      space: this.#space,
    });
  }

  /**
   * TEST-ONLY (C3.12.0 diagnostic, adversarial-review CR7). Observable snapshot
   * of this replica's standing-watch liveness — the count of in-flight
   * update-consumption promises, whether a subscribed watch view is live, and
   * the active doc-set membership watch id. WHY it exists: WO-0's three-way
   * verdict must split "the foreign read replica's standing watch was torn down"
   * (B1-client) from "the watch is alive but the origin pushes no third-party
   * commit" (B1-server), and both live behind hard-private `#` fields a Deno
   * test cannot read. This is a pure read of existing state — no behavior
   * change, no lifecycle effect — and exists solely for the diagnostic;
   * production code must not depend on it.
   */
  crossSpaceWatchDiagnostics(): {
    updatePromiseCount: number;
    hasSubscribedWatch: boolean;
    docSetWatchId: string | undefined;
  } {
    return {
      updatePromiseCount: this.#updatePromises.size,
      hasSubscribedWatch: this.#subscribedWatchView !== null,
      docSetWatchId: this.#docSetWatchId,
    };
  }

  private async refreshWatchSet(
    entries: Iterable<
      [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector]
    >,
    type: "pull" | "integrate" = "pull",
    lane: SchedulerExecutionContextKey = "space",
  ): Promise<Result<Unit, PullError>> {
    try {
      const { session } = await this.sessionHandle();
      // Per-session (no global): mirror the storage setting onto the session so
      // its watch-mutation family (set + add) uses the ordered-issue concurrent
      // path. Idempotent; cheap to re-assert each refresh. Optional-chained so
      // lightweight session doubles in tests (which never opt into concurrency)
      // are unaffected.
      session.setConcurrentWatchRefresh?.(
        this.#settings.experimentalConcurrentWatchRefresh === true,
      );
      const rawEntries = [...entries];
      const watchEntries = compactWatchEntries(rawEntries);
      if (watchEntries.length === 0) {
        return { ok: {} };
      }

      const watches = watchEntries.map(([address, selector]) => ({
        id: watchIdForEntry(address, selector, "", lane),
        kind: "graph" as const,
        query: {
          roots: [{
            id: address.id,
            scope: normalizeCellScope(address.scope),
            selector,
          }],
        },
      }));

      // C1.4b read seam: a non-space lane's watch registration carries the
      // lane as a per-request acting context, so the host resolves every
      // scoped root under the LANE principal (validated against the live
      // lane grant), never the sponsor.
      const { view, sync } = await session.watchAddSync(
        watches,
        lane === "space" ? undefined : { actingContext: lane },
      );

      if (this.#closed) {
        view.close();
        return { error: toConnectionError(new Error("memory replica closed")) };
      }

      const firstExecutionWatch = !this.#executionWatchHandoffComplete;
      if (firstExecutionWatch) {
        this.handoffClientExecutionControlToFirstWatch(session);
      }
      this.#watchView = view;
      this.applySessionSync(sync, type);
      if (firstExecutionWatch) {
        this.#executionWatchHandoffComplete = true;
      }
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
      // F4b boot-root demotion (make-before-break): the graph watch above did
      // its cold-discovery job — its closure is now HELD in `#docs`, applied by
      // applySessionSync. Replace the subscribing graph watch with doc-set
      // membership covering the whole held closure, so accepted-commit waves
      // fan out as point reads rather than per-wave schema-graph traversal. The
      // server registers the new members BEFORE dropping the graph watch's
      // tracked set (watch.set register-first), so no delivery gap opens; F3's
      // cross-kind folding means a doc briefly covered by both kinds is still
      // delivered once per wave under one watermark. Debounced so a burst of
      // per-root pulls collapses into one membership registration.
      if (lane === "space") this.scheduleSpaceDocSetReconcile();
      return { ok: {} };
    } catch (error) {
      return { error: toPullError(error) };
    }
  }

  /**
   * Declared-address membership of the space-lane replica doc set (FA4): every
   * doc `#docs` holds for the space lane, across the confirmed and pending/
   * overlay layers. Because `#docs` records are created for reads, writes,
   * speculative overlays and framework/system access alike, this includes
   * WRITTEN-NOT-READ docs (claimed chain intermediates, cross-doc backlink
   * write targets) that a read-log or pulled-doc derivation would strand as
   * permanently stale — and the settlement gate would then clear their overlays
   * against undelivered bases. Serving the closure pre-emptively rather than
   * pulling those docs on demand is therefore a CORRECTNESS choice, not a mere
   * latency trade: a written-not-read member must be delivered before/with the
   * sync whose toSeq covers its settlement's acceptedCommitSeq.
   */
  /**
   * Whether a record still HOLDS doc state in any layer (FA4's membership
   * unit): a pending/overlay version (speculative write target, framework
   * read in flight) or confirmed state. Confirmed "deleted as of seq N"
   * (seq > 0, value undefined) IS held state — the replica can serve the
   * absence, matching F3's absent-false member semantics. What does NOT
   * qualify is a fully emptied record — confirmed reset to (0, undefined)
   * with no pending versions — e.g. after a rejected commit drops a
   * written-not-read doc's only overlay, or after a retraction remove
   * applied outside the engaged doc-set surface. The replica cannot serve
   * any read from such a husk, so it must not be exported (FB27): otherwise
   * an aged session's member set grows without bound and never equals a
   * fresh session's.
   */
  private recordHoldsDocState(record: DocumentRecord): boolean {
    return record.pending.length > 0 ||
      record.confirmed.seq > 0 ||
      record.confirmed.value !== undefined;
  }

  private spaceLaneDocSetMembers(): DocReadAddress[] {
    const members: DocReadAddress[] = [];
    for (const record of this.#docs.values()) {
      if (record.address.lane !== "space") continue;
      if (!this.recordHoldsDocState(record)) continue;
      members.push({
        id: record.address.id,
        // Declared scope only — the wire never carries a resolved scope key
        // (FA2); the server resolves it under the registration acting context.
        scope: record.address.scope,
      });
    }
    return members;
  }

  /** Membership keys of the space-lane replica doc set (its docKeys), used to
   * detect whether a reconcile would actually change the served set. Must
   * apply the same held-state filter as spaceLaneDocSetMembers, or a released
   * doc would keep the unchanged-membership guard from ever re-registering. */
  private spaceLaneDocSetKeys(): Set<string> {
    const keys = new Set<string>();
    for (const record of this.#docs.values()) {
      if (record.address.lane !== "space") continue;
      if (!this.recordHoldsDocState(record)) continue;
      keys.add(docKey(record.address.id, record.address.scope, "space"));
    }
    return keys;
  }

  /**
   * Debounce a space-lane membership reconcile onto a microtask. Scheduled
   * whenever the replica doc set changes — closure growth delivered by a cold
   * graph watch, a speculative write target entering the overlay, or a
   * retraction evicting a member — so a burst of same-turn changes issues a
   * single watch.set carrying the whole current membership.
   */
  private scheduleSpaceDocSetReconcile(): void {
    if (!this.#docSetWatchActive) return;
    // A reconcile is mid-round-trip: latch the request instead of starting a
    // concurrent one (see #docSetReconcileInFlight). The in-flight loop
    // re-runs with fresh membership once the current watch.set resolves.
    if (this.#docSetReconcileInFlight) {
      this.#docSetReconcileDirty = true;
      return;
    }
    if (this.#docSetReconcileScheduled) return;
    this.#docSetReconcileScheduled = true;
    queueMicrotask(() => {
      this.#docSetReconcileScheduled = false;
      void this.runSpaceDocSetReconcile();
    });
  }

  /** Serialized reconcile driver: one watch.set in flight at a time, with a
   * trailing re-run while membership kept changing under it. */
  private async runSpaceDocSetReconcile(): Promise<void> {
    if (this.#docSetReconcileInFlight) {
      this.#docSetReconcileDirty = true;
      return;
    }
    this.#docSetReconcileInFlight = true;
    try {
      do {
        this.#docSetReconcileDirty = false;
        await this.reconcileSpaceDocSetWatch();
      } while (this.#docSetReconcileDirty && !this.#closed);
    } finally {
      this.#docSetReconcileInFlight = false;
    }
  }

  /**
   * Register (or re-register) the space lane's single `docs` membership watch
   * to cover exactly the held replica doc set, replacing any subscribing
   * schema-graph watches make-before-break (F4b boot-root demotion). Space-lane
   * only: a client SpaceReplica's watch surface is single-acting-context (the
   * server rejects a watch.add whose acting context differs from the registered
   * set, and a watch.set re-resolves the whole set under one context), so the
   * owned-set replace is sound only for the sponsor's own space. Non-space
   * execution lanes keep the graph-watch path unchanged (byte-identical to
   * flag-off). A fresh watch id each reconcile is how a SHRUNKEN membership
   * retracts an evicted doc's server-side source while every survivor is
   * re-registered first (FA8 make-before-break); an unchanged set is skipped.
   */
  private async reconcileSpaceDocSetWatch(): Promise<void> {
    if (!this.#docSetWatchActive || this.#closed) return;
    const members = this.spaceLaneDocSetMembers();
    const memberKeys = this.spaceLaneDocSetKeys();
    // Nothing to serve and nothing registered: stay on graph watches — dropping
    // them with an empty docs watch would leave the closure uncovered.
    if (memberKeys.size === 0 && this.#docSetWatchId === undefined) return;
    // Membership unchanged since the last registration: no watch.set needed.
    if (
      memberKeys.size === this.#docSetRegisteredKeys.size &&
      [...memberKeys].every((key) => this.#docSetRegisteredKeys.has(key))
    ) return;
    let session: ReplicaSessionHandle["session"];
    try {
      ({ session } = await this.sessionHandle());
    } catch {
      return;
    }
    // A session without the replace verb (e.g. an executor host-provider
    // session) stays on graph watches — sound, just undemoted.
    if (session.watchSetSync === undefined || this.#closed) return;
    const docsWatch: DocSetWatchSpec = {
      id: `docset:space:${++this.#docSetWatchIdSeq}`,
      kind: "docs",
      docs: members,
    };
    // Engage the surface BEFORE the round-trip so a retraction racing the
    // in-flight registration still evicts (the id is a sentinel; every reconcile
    // mints a fresh one regardless). `#docSetRegisteredKeys` is committed only on
    // success below, so a failed watch.set re-registers on the next reconcile
    // rather than being masked by the unchanged-membership guard.
    this.#docSetWatchId = memberKeys.size === 0 ? undefined : docsWatch.id;
    let view: ReplicaWatchView;
    let sync: SessionSync;
    try {
      ({ view, sync } = await session.watchSetSync([docsWatch]));
    } catch {
      return;
    }
    this.#docSetRegisteredKeys = memberKeys;
    if (this.#closed) {
      view.close();
      return;
    }
    this.#watchView = view;
    this.applySessionSync(sync, "integrate");
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
  }

  /**
   * Same-step replica eviction on retraction (FA4/FA8): delete the held
   * records so the next read misses and re-pulls, and drop watch-coverage
   * bookkeeping so that pull is not deduped away. Returns whether anything was
   * actually removed. A record carrying PENDING local writes is never evicted —
   * a speculative write target stays a member until its commit settles.
   */
  private evictHeldSpaceDocsSync(
    evicted: Iterable<{ id: URI; scope?: CellScope }>,
  ): boolean {
    if (!this.#docSetWatchActive || this.#docSetWatchId === undefined) {
      return false;
    }
    let removedAny = false;
    for (const { id, scope } of evicted) {
      const key = docKey(id, scope, "space");
      const record = this.#docs.get(key);
      if (record === undefined || record.pending.length > 0) continue;
      this.#docs.delete(key);
      this.#watchedIds.delete(key);
      removedAny = true;
      // FB7: hand back the manager/runtime pull-dedup latches in the SAME
      // step. Those latches encode "the first pull left a live server-side
      // watch behind, so a re-kick is never needed" — the retraction being
      // applied here is precisely that watch coverage ending, so without the
      // release the next runtime-path read (traversal -> ensureLinkedDocLoaded
      // -> shouldPullDoc) is deduped away and the reader goes silently stale.
      this.#onDocEvicted?.(id, scope);
      // Clear selector coverage so `sync()` re-fetches instead of treating the
      // evicted doc as already covered by a live watch.
      const baseAddress = {
        id,
        type: DOCUMENT_MIME,
        scope: laneScopeKey(normalizeCellScope(scope), "space") as CellScope,
      };
      for (const selector of [...this.#watchSelectorTracker.get(baseAddress)]) {
        this.#watchSelectorTracker.delete(baseAddress, selector);
      }
    }
    return removedAny;
  }

  private enqueueWatchRefresh(
    type: "pull" | "integrate",
    entries: [{ id: URI; type: MIME; scope?: CellScope }, SchemaPathSelector][],
    lane: SchedulerExecutionContextKey = "space",
  ): Promise<Result<Unit, PullError>> {
    const queued = this.#queuedWatchRefreshes.get(lane);
    if (queued !== undefined) {
      for (const [address, selector] of entries) {
        queued.entries.set(
          watchIdForEntry(address, selector, "", lane),
          [address, selector],
        );
      }
      return queued.pending.promise;
    }

    const batch: WatchRefreshBatch = {
      type,
      lane,
      entries: new Map(entries.map(([address, selector]) => [
        watchIdForEntry(address, selector, "", lane),
        [address, selector] as [
          { id: URI; type: MIME; scope?: CellScope },
          SchemaPathSelector,
        ],
      ])),
      pending: Promise.withResolvers<Result<Unit, PullError>>(),
    };
    this.#queuedWatchRefreshes.set(lane, batch);
    this.scheduleWatchRefreshFlush(lane);
    return batch.pending.promise;
  }

  /**
   * Max watch-refresh round trips allowed in flight at once. 1 preserves the
   * historical strict single-flight behavior; with
   * `experimentalConcurrentWatchRefresh` on, refreshes overlap up to a bounded
   * window so traversal-discovered waves fan out WITHOUT an unbounded number of
   * outstanding requests (backpressure).
   *
   * The window is per PROVIDER, not per lane: it exists to bound requests on
   * the wire, and every lane's refresh rides the same connection.
   */
  #maxWatchRefreshInFlight(): number {
    return this.#settings.experimentalConcurrentWatchRefresh === true
      ? CONCURRENT_WATCH_REFRESH_WINDOW
      : 1;
  }

  /**
   * Flush queued batches while slots are free. Same-tick coalescing (the
   * per-lane scheduled set plus the merge in `enqueueWatchRefresh`) is
   * unchanged; the window bounds cross-RTT concurrency (1 = single-flight).
   * With `lane` given only that lane is considered; without it every queued
   * lane is, which is how the flush's `finally` drains the backlog.
   */
  private scheduleWatchRefreshFlush(
    lane?: SchedulerExecutionContextKey,
  ): void {
    const lanes = lane === undefined
      ? [...this.#queuedWatchRefreshes.keys()]
      : [lane];
    for (const candidate of lanes) {
      if (
        !this.#queuedWatchRefreshes.has(candidate) ||
        this.#scheduledWatchRefreshLanes.has(candidate)
      ) {
        continue;
      }
      if (this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()) {
        return;
      }
      this.#scheduledWatchRefreshLanes.add(candidate);
      queueMicrotask(() => {
        this.#scheduledWatchRefreshLanes.delete(candidate);
        const batch = this.#queuedWatchRefreshes.get(candidate);
        if (
          batch === undefined ||
          this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()
        ) {
          return;
        }
        this.#queuedWatchRefreshes.delete(candidate);
        this.#watchRefreshInFlight += 1;
        void this.flushWatchRefreshBatch(batch);
        // If the window admits more and another batch has already coalesced,
        // schedule it now; otherwise the flush's `finally` re-schedules as
        // slots free.
        this.scheduleWatchRefreshFlush();
      });
    }
  }

  private async flushWatchRefreshBatch(
    batch: WatchRefreshBatch,
  ): Promise<void> {
    try {
      const result = await this.refreshWatchSet(
        batch.entries.values(),
        batch.type,
        batch.lane,
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
    this.#scheduledWatchRefreshLanes.clear();
    for (const [lane, batch] of this.#queuedWatchRefreshes) {
      batch.pending.resolve({
        error: toConnectionError(new Error("memory replica closed")),
      });
      this.#queuedWatchRefreshes.delete(lane);
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
    schedulerObservation: FabricValue,
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
    const lane = this.commitLane(source);
    const localSeq = this.#nextLocalSeq++;
    if (lane !== "space") this.#localSeqLanes.set(localSeq, lane);
    const pending = Promise.withResolvers<
      Result<Unit, StorageTransactionRejected>
    >();
    this.#schedulerObservationBatch.push({
      commit: {
        localSeq,
        reads: this.buildReads(source, localSeq, lane),
        schedulerObservation,
      },
      lane,
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
    // ONE-LANE-PER-COMMIT CONTRACT (memory C1.4, Worker/client side C1.5b):
    // the host rejects any commit — this batch shape included — whose claim
    // assertions name more than one execution lane (`mixed-lane-commit`).
    // Partition by asserted lane: drain exactly the FIRST queued entry's
    // lane per flush; flushSchedulerObservationBatch's drain loop re-invokes
    // until every lane's entries have flushed as their own commit.
    const queued = this.#schedulerObservationBatch.splice(0);
    const flushLane = queued[0]?.lane ?? "space";
    const entries = queued.filter((entry) => entry.lane === flushLane);
    this.#schedulerObservationBatch.push(
      ...queued.filter((entry) => entry.lane !== flushLane),
    );
    const localSeq = this.#nextLocalSeq++;
    if (flushLane !== "space") this.#localSeqLanes.set(localSeq, flushLane);
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
      // Same fail-closed degradation for the OTHER capability gap: against a
      // server without `pendingReadStacks`, an observation whose read sat on
      // MORE than one pending layer cannot be expressed soundly — the scalar
      // wire would omit lower layers, and the old server could persist an
      // observation that observed a dropped write (data commits get the
      // pushCommit hold instead; observations are droppable bookkeeping, so
      // dropping beats holding — a held envelope would chain verdict latency
      // into every semantic commit awaiting this flush). Resolve the dropped
      // entries {ok} and send the rest.
      let wireEntries = entries;
      if (client.serverFlags?.pendingReadStacks !== true) {
        const expressible = (entry: SchedulerObservationBatchEntry): boolean =>
          entry.commit.reads.pending.every((read) =>
            !Array.isArray(read.localSeq) || read.localSeq.length <= 1
          );
        wireEntries = entries.filter(expressible);
        for (const entry of entries) {
          if (!expressible(entry)) {
            entry.pending.resolve({ ok: {} });
          }
        }
        if (wireEntries.length === 0) {
          return { ok: {} };
        }
      }
      const wireBatch: ClientCommit = wireEntries === entries ? commit : {
        ...commit,
        schedulerObservationBatch: wireEntries.map((entry) => entry.commit),
      };
      return await this.pushCommit(localSeq, [], wireBatch, undefined);
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
    schedulerObservation?: FabricValue,
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
      if (this.#actionTransactionRouter === undefined) {
        if (this.#shadowWrites) {
          return { ok: {} };
        }
        return await this.enqueueSchedulerObservationCommit(
          schedulerObservation,
          source,
        );
      }
    }

    // One commit, one lane (A6): the owning lane is captured synchronously
    // at entry — from the source action's live claim when the provider can
    // resolve one, else the ambient acting lane — and keys every optimistic
    // structure this commit touches.
    const lane = this.commitLane(source);
    const localSeq = this.#nextLocalSeq++;
    if (lane !== "space") this.#localSeqLanes.set(localSeq, lane);
    const commit = withCommitTiming(
      ["commitOperations", "buildCommit"],
      (): ClientCommit => ({
        localSeq,
        reads: this.buildReads(source, localSeq, lane),
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
    // Preserve the storage contract that ordinary client commits install their
    // optimistic versions synchronously before commit() returns its promise.
    // Awaiting even an already-resolved fallback here inserts a microtask gap;
    // callers can then start a piece or issue a second transaction before the
    // first transaction is locally visible. Only executor/overlay providers
    // have a router and need the asynchronous authority decision.
    const route = this.#actionTransactionRouter === undefined
      ? (this.#shadowWrites
        ? { disposition: "local", kind: "executor-shadow" } as const
        : this.routeClientActionTransaction(commit, source))
      : await this.routeActionTransaction(commit, source, lane);
    this.noteExecutionTransactionRoute(commit, route, source?.sourceAction);
    const routedObservation = commit.schedulerObservation;
    if (
      route.disposition === "upstream" && !this.#shadowWrites &&
      this.#actionTransactionRouter === undefined &&
      isSchedulerActionObservation(routedObservation) &&
      routedObservation.transactionKind === "action-run" &&
      (routedObservation.actionKind === "computation" ||
        routedObservation.actionKind === "effect")
    ) {
      logger.debug("execution-client-derived-upstream-commit", () => [
        "Client derived action transaction sent upstream",
        {
          actionId: routedObservation.actionId,
          actionKind: routedObservation.actionKind,
          operations: commit.operations.length,
        },
      ]);
    }
    if (
      route.disposition !== "local" &&
      route.afterRouteSelected !== undefined
    ) {
      try {
        route.afterRouteSelected();
      } catch (error) {
        logger.warn("execution-route", () => [
          "Action transaction route-selection callback failed",
          error,
        ]);
      }
    }
    if (route.disposition !== "local") {
      this.rebaseUnresolvablePendingReads(commit);
    }
    if (route.disposition === "unserved") {
      return await this.publishUnservedAttempt(commit, route);
    }
    if (source !== undefined) {
      recordCommitLocalSeq(source, this.#space, localSeq);
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
    // Snapshot, apply, and diff under the COMMIT's lane: the optimistic
    // change is visible exactly to that lane (A16), so its notification must
    // be computed from that lane's materialization.
    const before = withCommitTiming(
      ["commitOperations", "snapshotBefore"],
      () =>
        shouldNotifySubscribers
          ? this.runWithExecutionLane(lane, () =>
            Differential.checkout(
              this,
              touched.map(({ id, scope }) => snapshotState(this, id, scope)),
            ))
          : undefined,
    );

    withCommitTiming(["commitOperations", "applyPending"], () => {
      for (const operation of operations) {
        this.applyPending(operation, localSeq, lane);
      }
    });

    withCommitTiming(["commitOperations", "notifyOptimistic"], () => {
      if (before !== undefined) {
        const optimistic = this.runWithExecutionLane(
          lane,
          () => before.compare(this),
        );
        this.#subscription.next({
          type: "commit",
          space: this.#space,
          changes: optimistic,
          source,
        });
        if (shouldNotifySinks) {
          this.runWithExecutionLane(lane, () => this.notifySinks(optimistic));
        }
      } else if (shouldNotifySinks) {
        this.runWithExecutionLane(lane, () => this.notifySinksForIds(touched));
      }
    });

    // Local routes are deliberately not confirmed: executor validation needs
    // the optimistic values to discover the graph, while claimed client
    // overlays need the same layering until an ordered settlement arrives.
    // In both cases the whole action remains local and no scheduler,
    // precondition, SQLite, or semantic operation reaches the host.
    if (route.disposition === "local") {
      if (route.kind === "executor-shadow" && operations.length > 0) {
        this.#shadowLocalSeqs.add(localSeq);
      }
      if (
        route.kind === "executor-shadow" && operations.length > 0 &&
        source?.sourceAction !== undefined
      ) {
        let localSeqs = this.#shadowLocalSeqsByAction.get(source.sourceAction);
        if (localSeqs === undefined) {
          localSeqs = new Set();
          this.#shadowLocalSeqsByAction.set(source.sourceAction, localSeqs);
        }
        localSeqs.add(localSeq);
      } else if (
        route.kind === "claimed-overlay" && source?.sourceAction !== undefined
      ) {
        const overlay = this.recordClaimedOverlay(
          localSeq,
          route.claim,
          source.sourceAction,
          commit,
          touched,
          lane,
        );
        const live = this.#executionClaims.get(actionClaimMapKey(route.claim));
        if (
          live === undefined ||
          executionClaimIncarnationKey(live) !==
            executionClaimIncarnationKey(route.claim)
        ) {
          this.dropClaimedOverlays(
            (overlay) => overlay.localSeq === localSeq,
            {
              dirtyProducer: true,
              diagnosticCode: "captured-claim-no-longer-live",
            },
          );
        } else {
          this.compactDominatedClaimedPendingVersions(overlay);
          this.reconcileEarlyExecutionSettlement(route.claim);
        }
      }
      if (
        route.kind === "executor-shadow" &&
        route.afterLocalApply !== undefined
      ) {
        try {
          route.afterLocalApply();
        } catch (error) {
          logger.warn("execution-route", () => [
            "Executor shadow post-apply callback failed",
            error,
          ]);
        }
      }
      return { ok: {} };
    }

    const promise = withCommitTiming(
      ["commitOperations", "pushCommitStart"],
      () =>
        this.pushCommit(
          localSeq,
          operations,
          commit,
          source,
          route,
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
  ): InFlightCommit | undefined {
    if (commit.reads.pending.length === 0) {
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

  private async routeActionTransaction(
    commit: ClientCommit,
    source?: IStorageTransaction,
    lane?: SchedulerExecutionContextKey,
  ): Promise<ActionTransactionRoute> {
    const fallback: ActionTransactionRoute = this.#shadowWrites
      ? { disposition: "local", kind: "executor-shadow" }
      : { disposition: "upstream" };
    if (this.#actionTransactionRouter === undefined) return fallback;
    try {
      const route = await this.#actionTransactionRouter({
        space: this.#space,
        commit,
        ...(source?.sourceAction !== undefined
          ? { sourceAction: source.sourceAction }
          : {}),
        ...(lane !== undefined ? { lane } : {}),
      });
      if (route.disposition === "upstream") return route;
      if (
        route.disposition === "unserved" &&
        route.diagnosticCode.length > 0
      ) {
        return route;
      }
      if (
        route.disposition === "local" &&
        (route.kind === "executor-shadow" ||
          route.kind === "claimed-overlay")
      ) {
        return route;
      }
    } catch (error) {
      logger.warn("execution-route", () => [
        `Action transaction routing failed for ${this.#space}`,
        error,
      ]);
    }
    return fallback;
  }

  private routeClientActionTransaction(
    commit: ClientCommit,
    source?: IStorageTransaction,
  ): ActionTransactionRoute {
    const sourceAction = source?.sourceAction;
    if (
      source?.executionEffectAuthority === "client" ||
      (sourceAction !== undefined &&
        this.#clientExecutionEffectInFlight(sourceAction))
    ) {
      return { disposition: "upstream" };
    }
    if (!this.#executionClaimRouting || this.#executionSnapshotRequired) {
      // During a reconnect/feed gap, existing claims remain authoritative. The
      // snapshot-required state freezes the last integrated view rather than
      // interpreting missing control data as authority return.
      if (!this.#executionClaimRouting) return { disposition: "upstream" };
    }
    const capturedClaim = source?.executionEffectAuthority === "server"
      ? source.executionClaim
      : undefined;
    return routeClientActionTransaction({
      space: this.#space,
      commit,
      ...(source?.sourceAction !== undefined
        ? { sourceAction: source.sourceAction }
        : {}),
    }, {
      claims: capturedClaim !== undefined
        ? [capturedClaim]
        : [...this.#executionClaims.values()],
      ownContextKeys: this.#executionOwnContextKeys,
      builtinPassivity: this.#executionBuiltinPassivity,
      onDiagnostic: ({ diagnosticCode, claim }) => {
        // Every client fail-open is a named counter (amendment A3 requires
        // this for dual-chain-claim-match in particular), not only a log.
        this.noteExecutionRouteDiagnostic(claim.branch, diagnosticCode);
        logger.warn("execution-client-route", () => [
          `Claimed action failed open: ${diagnosticCode}`,
          { actionId: claim.actionId, branch: claim.branch },
        ]);
      },
    });
  }

  private noteExecutionTransactionRoute(
    commit: ClientCommit,
    route: ActionTransactionRoute,
    sourceAction: object | undefined,
  ): void {
    if (
      sourceAction === undefined ||
      (route.disposition !== "upstream" &&
        (route.disposition !== "local" ||
          route.kind !== "claimed-overlay"))
    ) {
      return;
    }
    const observation = commit.schedulerObservation;
    if (!isSchedulerActionObservation(observation)) return;
    const key = actionClaimKeyFromObservation(observation);
    if (key === undefined || key.space !== this.#space) return;
    const record = this.executionRoutingDiagnosticRecord(key);
    const totals = this.executionRoutingBranchTotals(key.branch);
    if (route.disposition === "upstream") {
      record.upstreamRoutes++;
      totals.upstreamRoutes++;
    } else {
      record.claimedOverlayRoutes++;
      totals.claimedOverlayRoutes++;
    }
  }

  private async publishUnservedAttempt(
    commit: ClientCommit,
    route: Extract<ActionTransactionRoute, { disposition: "unserved" }>,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const observation = commit.schedulerObservation;
    if (
      typeof observation !== "object" || observation === null ||
      Array.isArray(observation)
    ) {
      return {
        error: executionFirewallRejection(
          commit,
          route.diagnosticCode,
          "unserved attempt has no action observation",
        ),
      };
    }
    const localSeq = this.#nextLocalSeq++;
    const unservedCommit = toCanonicalExecutionUnservedCommit(
      commit,
      localSeq,
      route.diagnosticCode,
    );
    // The unserved marker acts as the ORIGINAL attempt's lane (it carries that
    // attempt's claim assertion): the marker's own localSeq is minted here and
    // was never registered, so read the lane off the attempt's.
    const unservedActingContext = this.commitActingContext(commit.localSeq);
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
      const { session } = await this.sessionHandle();
      const applied = await session.transact(
        unservedCommit,
        unservedActingContext,
      );
      session.noteAppliedCommit?.(applied.seq);
      telemetry?.submit({
        type: "storage.push.complete",
        id: pushOpId,
        sessionId: session.sessionId,
      });
      try {
        route.onSettled?.();
      } catch (error) {
        logger.warn("execution-route", () => [
          "Unserved action callback failed after canonical settlement",
          error,
        ]);
      }
      return {
        error: executionFirewallRejection(
          commit,
          route.diagnosticCode,
          `claimed action settled unserved: ${route.diagnosticCode}`,
        ),
      };
    } catch (error) {
      const rejection = toRejectedError(error, unservedCommit, this.#space);
      telemetry?.submit({
        type: "storage.push.error",
        id: pushOpId,
        error: rejection.name ?? "TransactionError",
      });
      return { error: rejection };
    }
  }

  discardShadowWritesForAction(action: object): void {
    const localSeqs = this.#shadowLocalSeqsByAction.get(action);
    if (localSeqs === undefined || localSeqs.size === 0) return;
    for (const record of this.#docs.values()) {
      const next = record.pending.filter((entry) =>
        !localSeqs.has(entry.localSeq)
      );
      if (next.length === record.pending.length) continue;
      record.pending = next;
      record.materialized = undefined;
    }
    this.#shadowLocalSeqsByAction.delete(action);
  }

  private async pushCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    route?: Extract<ActionTransactionRoute, { disposition: "upstream" }>,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // Register BEFORE any await: commitOperations calls pushCommit
    // synchronously after applyPending, so registration is atomic with the
    // optimistic write — a dependency drop can never slip between the two.
    // Registering here rather than inside pushCommitAttempt keeps the
    // settlement paired with the whole attempt, route callback included.
    const inFlight = this.registerInFlightCommit(
      localSeq,
      operations,
      commit,
      source,
    );
    let result: Result<Unit, StorageTransactionRejected>;
    try {
      result = await this.pushCommitAttempt(
        localSeq,
        operations,
        commit,
        source,
        route,
        inFlight,
      );
    } finally {
      this.settleInFlightCommit(localSeq);
    }
    if (route?.onCommitSettled !== undefined) {
      try {
        route.onCommitSettled(result);
      } catch (error) {
        logger.warn("execution-route", () => [
          "Executor upstream settlement callback failed",
          error,
        ]);
      }
    }
    return result;
  }

  private async pushCommitAttempt(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    route?: Extract<ActionTransactionRoute, { disposition: "upstream" }>,
    inFlight?: InFlightCommit,
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
          if (inFlight?.localRejectionValue !== undefined) {
            // A pending dependency was dropped while we held for catch-up;
            // the commit is provably doomed — finalize without sending.
            return await this.finalizeRejection(
              localSeq,
              operations,
              source,
              inFlight.localRejectionValue,
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
      const { client, session } = await this.sessionHandle();
      // A rejection or claimed-overlay recording during the awaits above may
      // have doomed a localSeq this commit's pending reads still name.
      this.rebaseUnresolvablePendingReads(commit);
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
        return await this.finalizeRejection(
          localSeq,
          operations,
          source,
          inFlight.localRejectionValue,
        );
      }
      const actingContext = this.commitActingContext(commit.localSeq);
      if (inFlight === undefined) {
        // No pending reads → no dependency that can be dropped from under
        // this commit; keep the direct await.
        const applied = await session.transact(wireCommit, actingContext);
        this.confirmPending(localSeq, operations, applied);
        this.noteSourceCommitConfirmed(localSeq, applied.seq);
        session.noteAppliedCommit?.(applied.seq);
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
      const verdict = session.transact(wireCommit, actingContext);
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
        return await this.finalizeRejection(
          localSeq,
          operations,
          source,
          outcome.rejection,
        );
      }
      this.confirmPending(localSeq, operations, outcome.applied);
      this.noteSourceCommitConfirmed(localSeq, outcome.applied.seq);
      session.noteAppliedCommit?.(outcome.applied.seq);
      telemetry?.submit({
        type: "storage.push.complete",
        id: pushOpId,
        sessionId: session.sessionId,
      });
      return { ok: {} };
    } catch (error) {
      const diagnosticCode = executionFirewallDiagnostic(error);
      let rejection = toRejectedError(error, commit, this.#space);
      telemetry?.submit({
        type: "storage.push.error",
        id: pushOpId,
        error: rejection.name ?? "TransactionError",
      });
      if (diagnosticCode !== undefined && route !== undefined) {
        const unserved = await this.publishUnservedAttempt(commit, {
          disposition: "unserved",
          diagnosticCode,
          ...(route.onFirewallRejected
            ? { onSettled: () => route.onFirewallRejected!(diagnosticCode) }
            : {}),
        });
        if (
          unserved.error !== undefined &&
          (unserved.error as { name?: string }).name !==
            "ExecutionActionFirewallError"
        ) {
          rejection = unserved.error;
        }
      }
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
    // The dropped optimistic write was visible only to its own lane (A16);
    // diff the revert under that lane's materialization.
    const lane = this.#localSeqLanes.get(localSeq) ?? "space";
    const before = shouldNotifySubscribers
      ? this.runWithExecutionLane(lane, () =>
        Differential.checkout(
          this,
          touched.map(({ id, scope }) => snapshotState(this, id, scope)),
        ))
      : undefined;
    await this.waitForConflictReadRepair(rejection);
    this.dropPending(localSeq);
    this.noteSourceCommitRejected(localSeq);
    // Every drop funnels through here (server conflict, preempt, cascade,
    // reset — this is dropPending's only call site), so scanning right after
    // the drop catches every dependant; transitivity emerges from recursion
    // (a victim's own finalizeRejection lands back here with its localSeq).
    this.cascadeDroppedDependency(localSeq);
    if (before !== undefined) {
      const changes = this.runWithExecutionLane(
        lane,
        () => before.compare(this),
      );
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
        this.runWithExecutionLane(lane, () => this.notifySinks(changes));
      }
    } else if (shouldNotifySinks) {
      this.runWithExecutionLane(lane, () => this.notifySinksForIds(touched));
    }
    return { error: rejection };
  }

  private buildReads(
    source: IStorageTransaction | undefined,
    localSeq: number,
    lane: SchedulerExecutionContextKey = "space",
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
      const record = this.#docs.get(docKey(id, scope, lane));
      // The read's materialized view sat on EVERY lower pending layer, not
      // just the nearest one: name them ALL (ascending; the last element is
      // the doc's top-of-stack below this commit) so a dropped deeper layer
      // still dooms this commit (server: pending-dependency resolution;
      // client: cascade). Servers that honor `basisSeq` scan staleness from
      // it with predecessor-only own-session exclusion (CT-1910); legacy
      // servers base staleness at the highest element only — a lower-layer
      // basis WITHOUT that exclusion would false-conflict with the
      // session's own later stacked writes (CT-1872 1c).
      //
      // A16: a commit baselines only against its OWN lane's in-flight
      // versions. Another lane's pending version is invisible to this
      // lane's reads and host-unresolvable for its pending-read naming.
      const layers = [
        ...new Set(
          record?.pending
            .filter((version) =>
              version.localSeq < localSeq &&
              pendingVersionLane(version) === lane
            )
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
    const hasAdoptionObservations = type === "integrate" &&
      sync.observations !== undefined &&
      sync.observations.length > 0 &&
      getPersistentSchedulerStateConfig();
    if (
      sync.upserts.length === 0 &&
      sync.removes.length === 0 &&
      !hasAdoptionObservations
    ) {
      this.applyReplicaExecutionSync(sync);
      this.noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);
      return;
    }

    // C1.5b sync-frame attribution (FA6 consumption half): an upsert or
    // remove belongs to a lane instance exactly when its host-resolved
    // scopeKey (stamped since C1.4b; on removes since F2) names a REGISTERED
    // lane — directly, or through the CA3 broader-in-chain collapse: a
    // `user:<p>` stamp with no registered user lane still belongs to a
    // registered session lane of principal `<p>`, whose user-scoped reads
    // key exactly that collapsed instance (`laneScopeKey`). Everything else
    // — no scopeKey (older host), or a scope key no lane owns (e.g. the
    // sponsor's own scoped instance read through the space lane) — lands on
    // the declared space-lane key, byte-identical to the pre-lane replica.
    if (this.#executionLanes.size === 0) {
      this.applyAttributedSessionSync(
        sync.upserts,
        sync.removes,
        type,
        "space",
      );
    } else {
      // user:<p> -> the (deterministically first) registered session lane
      // whose chain owns it. Exact lane registrations win below; this map
      // only catches stamps no exact lane claims.
      let chainOwners: Map<string, SchedulerExecutionContextKey> | undefined;
      const chainOwnerOf = (
        scopeKey: string,
      ): SchedulerExecutionContextKey | undefined => {
        if (chainOwners === undefined) {
          chainOwners = new Map();
          for (const lane of [...this.#executionLanes].sort()) {
            const collapsed = lane.startsWith("session:")
              ? userChainKeyOfSessionLane(lane)
              : undefined;
            if (collapsed !== undefined && !chainOwners.has(collapsed)) {
              chainOwners.set(
                collapsed,
                lane as SchedulerExecutionContextKey,
              );
            }
          }
        }
        return chainOwners.get(scopeKey);
      };
      const laneOf = (scopeKey: string | undefined) =>
        scopeKey === undefined
          ? "space"
          : this.#executionLanes.has(scopeKey)
          ? scopeKey as SchedulerExecutionContextKey
          : chainOwnerOf(scopeKey) ?? "space";
      const groups = new Map<
        SchedulerExecutionContextKey,
        { upserts: SessionSyncUpsert[]; removes: SessionSyncRemove[] }
      >();
      const groupFor = (lane: SchedulerExecutionContextKey) => {
        const existing = groups.get(lane);
        if (existing !== undefined) return existing;
        const created = {
          upserts: [] as SessionSyncUpsert[],
          removes: [] as SessionSyncRemove[],
        };
        groups.set(lane, created);
        return created;
      };
      for (const upsert of sync.upserts) {
        groupFor(laneOf(upsert.scopeKey)).upserts.push(upsert);
      }
      for (const remove of sync.removes) {
        groupFor(laneOf(remove.scopeKey)).removes.push(remove);
      }
      const spaceGroup = groups.get("space") ??
        { upserts: [], removes: [] };
      groups.delete("space");
      this.applyAttributedSessionSync(
        spaceGroup.upserts,
        spaceGroup.removes,
        type,
        "space",
      );
      for (const [lane, group] of groups) {
        this.applyAttributedSessionSync(
          group.upserts,
          group.removes,
          type,
          lane,
        );
      }
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
    this.applyReplicaExecutionSync(sync);
    this.noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);
  }

  /** Apply one lane's slice of a session sync: confirmed bases update under
   * the lane's document keys and the notification diff is computed from that
   * lane's materialization (the change is invisible to other lanes, A16). */
  private applyAttributedSessionSync(
    upserts: readonly SessionSyncUpsert[],
    removes: readonly SessionSyncRemove[],
    type: "pull" | "integrate",
    lane: SchedulerExecutionContextKey,
  ): void {
    if (upserts.length === 0 && removes.length === 0) return;
    // F4/FA8: retractions delivered as graph-diff removes (a doc left the read
    // closure — e.g. an unlink) evict the held record in the same step so the
    // next read re-pulls; collected here and re-registered once after the apply.
    let evictedSpaceDoc = false;
    this.runWithExecutionLane(lane, () => {
      const touched = [
        ...upserts.map((upsert) => ({
          id: upsert.id as URI,
          scope: upsert.scope,
        })),
        ...removes.map((remove) => ({
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

      for (const upsert of upserts) {
        const record = this.record(upsert.id as URI, upsert.scope, lane);
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
        this.#watchedIds.add(docKey(upsert.id as URI, upsert.scope, lane));
      }
      for (const remove of removes) {
        const id = remove.id as URI;
        const key = docKey(id, remove.scope, lane);
        // Make-before-break gap guard (the 2026-07-24 composed-browser
        // finding): a remove for a doc we STILL HOLD that was never part of
        // the last registered membership is registration lag, not surface
        // shrink — a demand pull delivered the doc after the reconcile's
        // member snapshot was taken, and the replacing watch.set dropped the
        // pull's graph watch, so the server diffed the doc out (FW1's member
        // suppression can't see it: it wasn't a member yet). Evicting here is
        // what turned one race into a storm: the evicted doc read undefined
        // mid-derivation (pattern crash), re-pulled, changed membership, and
        // orphaned the NEXT in-flight pull. Keep the doc and reconcile so it
        // becomes a member. Registered members pass through: the real server
        // never removes a current member (FW1), so a member remove reaching
        // this path is a genuine scripted/legacy retraction and evicts as
        // before (FA4).
        if (
          lane === "space" && this.#docSetWatchActive &&
          this.#docSetWatchId !== undefined &&
          !this.#docSetRegisteredKeys.has(key)
        ) {
          const held = this.#docs.get(key);
          if (held !== undefined && this.recordHoldsDocState(held)) {
            this.scheduleSpaceDocSetReconcile();
            continue;
          }
        }
        // Same-step eviction when the space-lane doc-set surface is engaged and
        // the doc carries no pending local writes (evictHeldSpaceDocsSync's own
        // guard): drop the record entirely rather than resetting it to absent,
        // so it also leaves the exported membership on re-registration.
        if (
          lane === "space" && this.#docSetWatchActive &&
          this.#docSetWatchId !== undefined &&
          this.evictHeldSpaceDocsSync([{ id, scope: remove.scope }])
        ) {
          evictedSpaceDoc = true;
          continue;
        }
        const record = this.record(id, remove.scope, lane);
        record.confirmed = confirmedVersion(0, undefined);
        record.materialized = undefined;
        this.#watchedIds.delete(key);
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
    });
    if (evictedSpaceDoc) this.scheduleSpaceDocSetReconcile();
  }

  // Mark every id this conflicted commit touched (reads + writes) stale until
  // the runner observes caughtUpLocalSeq >= the commit's localSeq — the seq the
  // server stages as the post-conflict catch-up point for these ids.
  private recordStaleFloor(commit: ClientCommit, localSeq: number): void {
    const lane = this.#localSeqLanes.get(commit.localSeq) ?? "space";
    const mark = (id: string, scope?: CellScope) => {
      const key = docKey(id as URI, scope, lane);
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
    const lane = this.#localSeqLanes.get(commit.localSeq) ?? "space";
    const consider = (id: string, scope?: CellScope) => {
      const floor = this.#staleFloor.get(docKey(id as URI, scope, lane));
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
    const lane = this.#localSeqLanes.get(commit.localSeq) ?? "space";
    for (const read of commit.reads.confirmed) {
      const record = this.#docs.get(docKey(read.id as URI, read.scope, lane));
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

  private record(
    id: URI,
    scope?: CellScope,
    lane: SchedulerExecutionContextKey = "space",
  ): DocumentRecord {
    const key = docKey(id, scope, lane);
    let record = this.#docs.get(key);
    if (!record) {
      record = {
        confirmed: confirmedVersion(0, undefined),
        pending: [],
        materialized: undefined,
        // Capture the declared address so the replica doc set can be re-exported
        // as `docs` watch membership (FA4) without a parallel bookkeeping map.
        address: { id, scope, lane },
      };
      this.#docs.set(key, record);
      // A newly held space-lane doc grows the exported membership: a read-closure
      // doc, a speculative write target, or a framework read all enter here and
      // must become members (FA4). Debounced; inert unless the surface is
      // engaged. A member already covered by the registered set is skipped by
      // the reconcile's unchanged-membership guard.
      if (lane === "space") this.scheduleSpaceDocSetReconcile();
    }
    return record;
  }

  private applyPending(
    operation: NativeCommitOperation,
    localSeq: number,
    lane: SchedulerExecutionContextKey = "space",
  ): void {
    const { id, scope, ...pending } = operation;
    const record = this.record(id, scope, lane);
    const version = pendingVersion(localSeq, pending);
    // Owning-lane tag (A16); omitted for the space lane so the lanes-free
    // pending shape stays byte-identical.
    if (lane !== "space") version.lane = lane;
    record.pending.push(version);
  }

  private confirmPending(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
  ): void {
    const lane = this.#localSeqLanes.get(localSeq) ?? "space";
    const keys = new Map(
      operations.map((operation) => [
        docKey(operation.id, operation.scope, lane),
        { id: operation.id, scope: operation.scope },
      ]),
    );
    // Merge-rebase adoption (C2.10 defect-1 root fix): when the engine
    // applied one of this commit's PATCH ops onto a head another session
    // authored, the local pending materialization below replays the patch
    // over a base that never contained that head — a value the server does
    // not hold. The engine marks exactly those revisions by carrying the
    // authoritative post-apply `document` (the doc's LAST revision in the
    // commit carries it), and the FA14 echo suppression means no later
    // delivery will repair a wrong local promotion — the divergence would be
    // permanent (the C2.10 lunch-poll second-voter staleness). Adopt the
    // server's document as the confirmed value instead, and notify, since —
    // unlike the local-replay promotion — adoption can CHANGE the visible
    // value (the merged base becomes visible beneath this doc's remaining
    // pending versions).
    const authoritativeLastRevisionByKey = new Map<
      string,
      EntityDocument | undefined
    >();
    for (const revision of applied.revisions) {
      authoritativeLastRevisionByKey.set(
        docKey(revision.id as URI, revision.scope, lane),
        revision.op === "patch" ? revision.document : undefined,
      );
    }
    const adoptable = [...keys.entries()].filter(([key]) =>
      authoritativeLastRevisionByKey.get(key) !== undefined
    ).map(([, entry]) => entry);
    const shouldNotifySubscribers = adoptable.length > 0 &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = adoptable.length > 0 &&
      this.hasSinkSubscribers(adoptable);
    const before = shouldNotifySubscribers || shouldNotifySinks
      ? this.runWithExecutionLane(lane, () =>
        Differential.checkout(
          this,
          adoptable.map(({ id, scope }) => snapshotState(this, id, scope)),
        ))
      : undefined;
    for (const { id, scope } of keys.values()) {
      const record = this.record(id, scope, lane);
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

      const authoritativeDocument = authoritativeLastRevisionByKey.get(
        docKey(id, scope, lane),
      );
      if (record.confirmed.seq < applied.seq) {
        if (authoritativeDocument !== undefined) {
          // The engine merge-rebased this doc's patch: the local replay below
          // would promote a value the server does not hold. Adopt the
          // accepted post-apply document (the same shape the subscription
          // upsert path applies).
          promoted = confirmedVersion(applied.seq, authoritativeDocument);
        } else if (firstPendingIndex === 0) {
          const prefix = materializedVersionThroughPending(
            record,
            { space: this.#space, id, scope },
            lastPendingIndex + 1,
            lane,
          );
          const cache = ensurePendingMaterializationCache(record, lane);
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
            lane,
            prefixes: reusedSuffix,
          }
          : undefined;
        continue;
      }

      dropMaterializedSuffix(record, firstPendingIndex);
    }

    // Merge-rebase adoption is the one confirmation path whose visible value
    // can differ from the local pending materialization it replaces — notify
    // exactly like a server-side integrate delivery would have (the delivery
    // the echo suppression withholds).
    if (before !== undefined) {
      const changes = this.runWithExecutionLane(
        lane,
        () => before.compare(this),
      );
      if ([...changes].length > 0) {
        if (shouldNotifySubscribers) {
          this.#subscription.next({
            type: "integrate",
            space: this.#space,
            changes,
          } as StorageNotification);
        }
        if (shouldNotifySinks) {
          this.runWithExecutionLane(lane, () => this.notifySinks(changes));
        }
      }
    }
  }

  private dropPending(localSeq: number): void {
    let releasedSpaceDoc = false;
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
      if (
        record.address.lane === "space" && !this.recordHoldsDocState(record)
      ) {
        releasedSpaceDoc = true;
      }
    }
    // FB27 (FA8's client half): dropping a rejected commit's overlay can empty
    // a written-not-read doc's record entirely — the replica no longer holds
    // the doc, so the export must shrink within one reconcile cycle rather
    // than serve the husk forever. Inert while the doc-set surface is off
    // (the schedule below is gated on it), keeping flag-off byte-identical.
    if (releasedSpaceDoc) this.scheduleSpaceDocSetReconcile();
  }

  private visibleVersion(id: URI, scope?: CellScope): {
    record: DocumentRecord;
    version: MaterializedVersion;
  } | undefined {
    const lane = this.#actingLane;
    const record = this.#docs.get(docKey(id, scope, lane));
    if (!record) {
      return undefined;
    }
    return {
      record,
      version: materializedVersionThroughPending(
        record,
        {
          space: this.#space,
          id,
          scope,
        },
        record.pending.length,
        lane,
      ),
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

  private initializeClientExecutionControl(
    handle: ReplicaSessionHandle,
  ): void {
    // Recomputed on every attach so a takeover onto a connection without the
    // subcapability downgrades the session back to graph watches. Defaults off
    // and is only raised once the base capability below is confirmed — the F4
    // doc-set surface is layered strictly above server-primary execution.
    this.#docSetWatchActive = false;
    const enabled = getServerPrimaryExecutionConfig() &&
      handle.client.serverFlags?.serverPrimaryExecutionV1 === true &&
      handle.client.serverFlags?.serverPrimaryExecutionClaimRoutingV1 === true;
    if (!enabled) return;
    this.#executionClaimRouting = true;
    // F4 own-side gate ∧ negotiated peer flag. Both must hold; a mixed fleet
    // where either side lacks the subcapability keeps its graph watches.
    this.#docSetWatchActive = getServerPrimaryExecutionDocSetWatchConfig() &&
      handle.client.serverFlags?.serverPrimaryExecutionDocSetWatchV1 === true;
    // The own chain (A10) anchors to the provider signer and the exact live
    // session id — the identities scoped claims would be issued under. Both
    // segments are canonically encoded by the helpers (A18); the session
    // member stays inert until C2 issues session-context claims.
    this.#executionOwnContextKeys = ownChainContextKeys(
      this.#as.did(),
      handle.session.sessionId,
    );
    this.#executionBuiltinPassivity =
      handle.client.serverFlags?.serverPrimaryExecutionBuiltinPassivityV1 ===
        true;
    this.#executionFeedSeq = handle.session.executionFeedSeq ?? 0;
    this.#executionClaims.clear();
    this.#earlyExecutionSettlements.clear();
    for (const claim of handle.session.executionClaims ?? []) {
      this.#executionClaims.set(actionClaimMapKey(claim), claim);
    }
  }

  /**
   * SpaceSession owns execution control before its first WatchView exists. A
   * claim can advance there after session initialization but before
   * watchAddSync returns, so no view event exists for SpaceReplica to consume.
   * Once watchAddSync has created the view, atomically adopt the session's
   * current cursor and claims before applying the returned incremental batch.
   * Later watch additions must stay incremental: reseeding them could erase
   * already-applied settlements or speculative overlays.
   */
  private handoffClientExecutionControlToFirstWatch(
    session: ReplicaSessionHandle["session"],
  ): void {
    if (!this.#executionClaimRouting) return;
    const executionFeedSeq = session.executionFeedSeq ?? 0;
    if (executionFeedSeq < this.#executionFeedSeq) return;
    this.#executionFeedSeq = executionFeedSeq;
    this.#executionClaims.clear();
    for (const claim of session.executionClaims ?? []) {
      this.#executionClaims.set(actionClaimMapKey(claim), claim);
    }
    this.#executionSnapshotRequired = false;
  }

  private executionRoutingDiagnosticRecord(
    key: ActionClaimKey,
  ): ExecutionRoutingDiagnosticRecord {
    // One record per logical action: keyed by the chain key (ActionClaimKey
    // minus contextKey, amendment A15) so route notes, overlay drops, and
    // revoke-path diagnostics stay on a single record across lane moves. The
    // stored key is the chain representative (contextKey pinned "space");
    // live claims alongside carry their true contexts.
    const mapKey = actionClaimChainMapKey(key);
    const existing = this.#executionRoutingDiagnostics.get(mapKey);
    if (existing !== undefined) {
      // Refresh insertion order so inactive actions are evicted first.
      this.#executionRoutingDiagnostics.delete(mapKey);
      this.#executionRoutingDiagnostics.set(mapKey, existing);
      return existing;
    }
    if (
      this.#executionRoutingDiagnostics.size >=
        EXECUTION_ROUTING_DIAGNOSTIC_ACTION_LIMIT
    ) {
      const oldest = this.#executionRoutingDiagnostics.keys().next().value;
      if (oldest !== undefined) {
        this.#executionRoutingDiagnostics.delete(oldest);
        this.#truncatedExecutionRoutingDiagnosticRecords++;
      }
    }
    const record: ExecutionRoutingDiagnosticRecord = {
      key: canonicalActionClaimKey({ ...key, contextKey: "space" }),
      upstreamRoutes: 0,
      claimedOverlayRoutes: 0,
      settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
      basisCoveredOverlayDrops: 0,
      nonAuthoritativeOverlayDrops: 0,
    };
    this.#executionRoutingDiagnostics.set(mapKey, record);
    return record;
  }

  private executionRoutingBranchTotals(
    branch: BranchName,
  ): MutableExecutionRoutingBranchTotals {
    let totals = this.#executionRoutingBranchTotals.get(branch);
    if (totals === undefined) {
      totals = emptyExecutionRoutingBranchTotals();
      this.#executionRoutingBranchTotals.set(branch, totals);
    }
    return totals;
  }

  private cloneExecutionRoutingBranchTotals(
    branch: BranchName,
  ): ExecutionRoutingBranchTotals {
    const totals = this.#executionRoutingBranchTotals.get(branch) ??
      emptyExecutionRoutingBranchTotals();
    return {
      upstreamRoutes: totals.upstreamRoutes,
      claimedOverlayRoutes: totals.claimedOverlayRoutes,
      settlements: { ...totals.settlements },
      basisCoveredOverlayDrops: totals.basisCoveredOverlayDrops,
      nonAuthoritativeOverlayDrops: totals.nonAuthoritativeOverlayDrops,
      settlementDiagnostics: { ...totals.settlementDiagnostics },
      routeDiagnostics: { ...totals.routeDiagnostics },
    };
  }

  /** Count one named client routing fail-open (amendment A3: observed
   * fail-opens are counters, never silent branches). */
  private noteExecutionRouteDiagnostic(
    branch: BranchName,
    diagnosticCode: string,
  ): void {
    const totals = this.executionRoutingBranchTotals(branch);
    totals.routeDiagnostics[diagnosticCode] =
      (totals.routeDiagnostics[diagnosticCode] ?? 0) + 1;
  }

  private noteExecutionSettlement(settlement: ActionSettlement): void {
    const record = this.executionRoutingDiagnosticRecord(settlement.claim);
    const totals = this.executionRoutingBranchTotals(settlement.branch);
    if (settlement.outcome === "no-op") {
      record.settlements.noOp++;
      totals.settlements.noOp++;
    } else {
      record.settlements[settlement.outcome]++;
      totals.settlements[settlement.outcome]++;
    }
    if (settlement.diagnosticCode !== undefined) {
      totals.settlementDiagnostics[settlement.diagnosticCode] =
        (totals.settlementDiagnostics[settlement.diagnosticCode] ?? 0) + 1;
    }
    record.lastSettlement = cloneActionSettlement(settlement);
  }

  private mergeSuccessfulExecutionSettlements(
    current: ActionSettlement,
    next: ActionSettlement,
  ): ActionSettlement {
    return cloneActionSettlement(
      mergeSuccessfulExecutionSettlementRecords(current, next),
    );
  }

  private retainEarlyExecutionSettlement(
    settlement: ActionSettlement,
  ): void {
    if (
      settlement.outcome !== "committed" && settlement.outcome !== "no-op"
    ) {
      return;
    }
    const family = executionOverlayFamilyKey(settlement.claim);
    const current = this.#earlyExecutionSettlements.get(family);
    if (current === undefined) {
      this.#earlyExecutionSettlements.set(
        family,
        cloneActionSettlement(settlement),
      );
      return;
    }

    // This cache is a successful-settlement frontier, not merely the latest
    // event. A newer no-op may advance the covered input basis, but it cannot
    // erase an accepted-data barrier contributed by an earlier commit. §2b: it
    // is coherence machinery, so it is indexed by the action FAMILY — a claim
    // generation advancing says nothing about whether the server's accepted
    // data has reached this replica.
    this.#earlyExecutionSettlements.set(
      family,
      this.mergeSuccessfulExecutionSettlements(current, settlement),
    );
  }

  private coalescePendingSuccessfulExecutionSettlement(
    settlement: ActionSettlement,
  ): ActionSettlement {
    const family = executionOverlayFamilyKey(settlement.claim);
    let frontier = settlement;
    this.#pendingExecutionSettlements = this.#pendingExecutionSettlements
      .filter((current) => {
        if (
          executionOverlayFamilyKey(current.claim) !== family ||
          (current.outcome !== "committed" && current.outcome !== "no-op")
        ) {
          return true;
        }
        frontier = this.mergeSuccessfulExecutionSettlements(current, frontier);
        return false;
      });
    return frontier;
  }

  private reconcileEarlyExecutionSettlement(claim: ExecutionClaim): void {
    const family = executionOverlayFamilyKey(claim);
    const settlement = this.#earlyExecutionSettlements.get(family);
    if (settlement === undefined) return;
    this.#earlyExecutionSettlements.delete(family);
    const frontier = this.coalescePendingSuccessfulExecutionSettlement(
      settlement,
    );
    if (
      this.settlementAddressesLocalSpeculation(frontier) &&
      this.reconcileExecutionSettlement(frontier)
    ) {
      this.#pendingExecutionSettlements.push(frontier);
    }
  }

  /**
   * Rebase pending reads that name host-unresolvable local versions onto the
   * confirmed base beneath them before a transaction leaves this replica.
   *
   * Two version classes never receive a server resolution for their
   * localSeq: executor-shadow commits (Worker discovery runs, local-only)
   * and claimed-overlay commits (client speculation for a server-claimed
   * action, deliberately never sent). A pending read naming either fails
   * apply with "pending dependency not resolved" on every retry until the
   * inputs move — measured as the dominant executor conflict storm, and as
   * a client hang once real product actions stayed claimed (a handler
   * reading a claimed list overlay could never land its source write).
   * Reading the confirmed base instead is exactly the §B.3 contract:
   * conflict detection compares against committed state, and the accepted
   * optimistic window self-heals through the server's recompute.
   */
  private rebaseUnresolvablePendingReads(commit: ClientCommit): void {
    if (
      this.#shadowLocalSeqs.size === 0 && this.#claimedOverlays.size === 0 &&
      this.#localSeqLanes.size === 0
    ) {
      return;
    }
    // A16: another lane's local versions are host-unresolvable for this
    // commit exactly like shadow and claimed-overlay versions — the host
    // resolves a pending read only against the asserting lane's own chain.
    const commitLane = this.#localSeqLanes.get(commit.localSeq) ?? "space";
    const retained: PendingRead[] = [];
    let rebased = 0;
    for (const read of commit.reads.pending) {
      // Every named layer must be host-resolvable and on this lane: one
      // unresolvable layer dooms the whole read, so rebase it onto confirmed.
      if (
        pendingReadLayers(read.localSeq).every((layer) =>
          !this.#shadowLocalSeqs.has(layer) &&
          !this.#claimedOverlays.has(layer) &&
          (this.#localSeqLanes.get(layer) ?? "space") === commitLane
        )
      ) {
        retained.push(read);
        continue;
      }
      const record = this.#docs.get(
        docKey(read.id as URI, read.scope, commitLane),
      );
      commit.reads.confirmed.push({
        id: read.id,
        scope: read.scope,
        path: read.path,
        seq: record?.confirmed.seq ?? 0,
        ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
      });
      rebased++;
    }
    if (rebased > 0) {
      commit.reads.pending = retained;
      logger.debug("execution-unresolvable-read-rebased", () => [
        "Rebased host-unresolvable pending reads onto their confirmed base",
        { localSeq: commit.localSeq, rebased },
      ]);
    }
  }

  private recordClaimedOverlay(
    localSeq: number,
    claim: ExecutionClaim,
    sourceAction: object,
    commit: ClientCommit,
    touched: readonly { id: URI; scope?: CellScope }[],
    lane: SchedulerExecutionContextKey,
  ): ClaimedOverlayGeneration {
    let basisSeq = commit.reads.confirmed.reduce(
      (maximum, read) => Math.max(maximum, read.seq),
      0,
    );
    const unresolvedBasisLocalSeqs = new Set<number>();
    for (const read of commit.reads.pending) {
      for (const layer of pendingReadLayers(read.localSeq)) {
        if (this.#claimedOverlays.has(layer)) {
          // A claimed-overlay dependency never receives a
          // confirmation-assigned sequence of its own. Settlement basis is
          // deliberately direct (not a transitive causal frontier), so retain
          // only the confirmed base that the server can read beneath that
          // overlay. Importing the upstream overlay's source dependencies
          // would make chained overlays wait forever and would exceed the v1
          // scalar-basis contract.
          basisSeq = Math.max(
            basisSeq,
            this.#docs.get(docKey(read.id as URI, read.scope, lane))?.confirmed
              .seq ?? 0,
          );
          continue;
        }
        const confirmed = this.#confirmedSeqByLocalSeq.get(layer);
        if (confirmed === undefined) {
          unresolvedBasisLocalSeqs.add(layer);
        } else {
          basisSeq = Math.max(basisSeq, confirmed);
        }
      }
    }
    const { foreignBasis, unresolvedForeignBasis } = this
      .captureOverlayForeignBasis(commit);
    const overlay: ClaimedOverlayGeneration = {
      localSeq,
      claim,
      sourceAction,
      lane,
      createdAt: performance.now(),
      basisSeq,
      unresolvedBasisLocalSeqs,
      foreignBasis,
      unresolvedForeignBasis,
      touched: [...new Map(touched.map((entry) => [
        docKey(entry.id, entry.scope, lane),
        entry,
      ])).values()],
    };
    this.#claimedOverlays.set(localSeq, overlay);
    logger.debug("execution-client-derived-suppressed", () => [
      "Claimed client action retained as a local overlay",
      { actionId: claim.actionId, localSeq, basisSeq },
    ]);
    logger.debug("execution-overlay-created", () => [
      "Claimed overlay created",
      { actionId: claim.actionId, localSeq, basisSeq },
    ]);
    return overlay;
  }

  /**
   * C3.9: capture the FOREIGN components of a cross-space-read overlay's input
   * basis from each foreign read space's OWN replica at overlay creation
   * (StorageManager-mediated). A same-space overlay reads no foreign space, so
   * this returns empty maps and the overlay stays scalar-only — the drop rule
   * is then byte-identical to pre-C3.9. Foreign reads are space-scoped only (v1
   * decision #3), so every captured component keys the space lane / space scope.
   */
  private captureOverlayForeignBasis(
    commit: ClientCommit,
  ): {
    foreignBasis: Map<string, number>;
    unresolvedForeignBasis: Map<string, Set<number>>;
  } {
    const foreignBasis = new Map<string, number>();
    const unresolvedForeignBasis = new Map<string, Set<number>>();
    const capture = this.#captureForeignExecutionBasis;
    if (capture === undefined) return { foreignBasis, unresolvedForeignBasis };
    const observation = commit.schedulerObservation;
    if (!isSchedulerActionObservation(observation)) {
      return { foreignBasis, unresolvedForeignBasis };
    }
    const foreignReads: ForeignReadRef[] = [];
    for (const read of observation.reads) {
      const space = read.space;
      if (space === undefined || space === this.#space) continue;
      foreignReads.push({ space, id: read.id as URI, scope: "space" });
    }
    if (foreignReads.length === 0) {
      return { foreignBasis, unresolvedForeignBasis };
    }
    const captured = capture(foreignReads);
    for (const [space, seq] of captured.resolved) foreignBasis.set(space, seq);
    for (const [space, localSeqs] of captured.unresolved) {
      if (localSeqs.size > 0) {
        unresolvedForeignBasis.set(space, new Set(localSeqs));
      }
    }
    return { foreignBasis, unresolvedForeignBasis };
  }

  /**
   * C3.9: the confirmed input-basis contribution of `reads` in THIS replica's
   * space — the max confirmed input revision plus any newest pending SOURCE
   * localSeqs (unresolved until the host confirms them; the cross-replica
   * analog of the home pending-source translation). Called by the
   * StorageManager on a FOREIGN replica while a sibling captures a cross-space
   * overlay's vector basis. Shadow and claimed-overlay pending versions never
   * receive a confirmation-assigned seq, so they are excluded — importing them
   * would strand the overlay's foreign component forever.
   */
  confirmedExecutionBasisForReads(
    reads: readonly ForeignReadRef[],
  ): { seq: number; unresolved: Set<number> } {
    let seq = 0;
    const unresolved = new Set<number>();
    for (const read of reads) {
      const record = this.#docs.get(docKey(read.id, read.scope, "space"));
      if (record === undefined) continue;
      seq = Math.max(seq, record.confirmed.seq);
      for (let index = record.pending.length - 1; index >= 0; index--) {
        const localSeq = record.pending[index]!.localSeq;
        if (
          this.#shadowLocalSeqs.has(localSeq) ||
          this.#claimedOverlays.has(localSeq)
        ) {
          continue;
        }
        // The newest genuine pending source on this address gates the basis.
        unresolved.add(localSeq);
        break;
      }
    }
    return { seq, unresolved };
  }

  /**
   * C3.9: a FOREIGN replica confirmed one of its source commits. Resolve any
   * overlay foreign component that was waiting on it (the cross-replica analog
   * of {@link noteSourceCommitConfirmed}) and re-drive settlement
   * reconciliation, so a settlement that was awaiting the foreign translation
   * can now cover and drop. No-op for a replica holding no overlay tracking
   * that space's pending source — the common case for the broadcast.
   */
  noteForeignSourceConfirmed(
    space: string,
    localSeq: number,
    seq: number,
  ): void {
    let changed = false;
    for (const overlay of this.#claimedOverlays.values()) {
      const pending = overlay.unresolvedForeignBasis.get(space);
      if (pending === undefined || !pending.delete(localSeq)) continue;
      overlay.foreignBasis.set(
        space,
        Math.max(overlay.foreignBasis.get(space) ?? 0, seq),
      );
      if (pending.size === 0) overlay.unresolvedForeignBasis.delete(space);
      changed = true;
    }
    if (changed) this.reconcilePendingExecutionSettlements();
  }

  /**
   * Compact only physical pending versions that a newer resolved overlay
   * completely overwrites. Logical overlay generations remain independent so
   * settlement bases, rejection handling, held-time telemetry, and route/drop
   * diagnostics retain their exact cardinality.
   */
  private compactDominatedClaimedPendingVersions(
    next: ClaimedOverlayGeneration,
  ): void {
    if (next.unresolvedBasisLocalSeqs.size > 0) return;
    const nextIncarnation = executionClaimIncarnationKey(next.claim);
    let removed = 0;

    for (const { id, scope } of next.touched) {
      const record = this.#docs.get(docKey(id, scope, next.lane));
      if (record === undefined) continue;
      const nextPending = record.pending.filter((entry) =>
        entry.localSeq === next.localSeq
      );
      if (nextPending.length !== 1) continue;
      const coverage = dominatingPendingPaths(nextPending[0]!);
      if (coverage === undefined) continue;

      const retained = record.pending.filter((entry) => {
        if (entry.localSeq === next.localSeq) return true;
        const previous = this.#claimedOverlays.get(entry.localSeq);
        if (
          previous === undefined ||
          previous.sourceAction !== next.sourceAction ||
          executionClaimIncarnationKey(previous.claim) !== nextIncarnation ||
          previous.unresolvedBasisLocalSeqs.size > 0 ||
          previous.basisSeq > next.basisSeq ||
          !pendingVersionDominatedBy(entry, coverage)
        ) {
          return true;
        }
        removed++;
        return false;
      });
      if (retained.length !== record.pending.length) {
        record.pending = retained;
        record.materialized = undefined;
      }
    }

    if (removed > 0) {
      logger.debug("execution-overlay-pending-versions-compacted", () => [
        "Dominated claimed-overlay pending versions compacted",
        { actionId: next.claim.actionId, versions: removed },
      ]);
    }
  }

  private noteSourceCommitConfirmed(localSeq: number, seq: number): void {
    this.#confirmedSeqByLocalSeq.set(localSeq, seq);
    let changed = false;
    for (const overlay of this.#claimedOverlays.values()) {
      if (!overlay.unresolvedBasisLocalSeqs.delete(localSeq)) continue;
      overlay.basisSeq = Math.max(overlay.basisSeq, seq);
      changed = true;
    }
    if (changed) this.reconcilePendingExecutionSettlements();
    // C3.9: announce every confirmed source commit for cross-replica
    // correlation — a space-B confirmation resolves the unresolved B component
    // of a cross-space-read overlay held in a sibling (home-space) replica.
    this.#onSourceCommitConfirmed?.(localSeq, seq);
  }

  private noteSourceCommitRejected(localSeq: number): void {
    this.#confirmedSeqByLocalSeq.delete(localSeq);
    if (this.#actionTransactionRouter !== undefined) {
      // A rejected commit's localSeq can never resolve on the host. A routed
      // commit built while this one was still pending may reference it; the
      // pre-send rebase resolves such reads onto the confirmed base.
      this.#shadowLocalSeqs.add(localSeq);
    }
    this.dropClaimedOverlays(
      (overlay) => overlay.unresolvedBasisLocalSeqs.has(localSeq),
      { dirtyProducer: true, diagnosticCode: "source-basis-rejected" },
    );
    this.reconcilePendingExecutionSettlements();
  }

  private applyReplicaExecutionSync(sync: SessionSync): void {
    this.#executionAppliedSeq = Math.max(this.#executionAppliedSeq, sync.toSeq);
    const batch = sync.execution;
    if (batch !== undefined && this.#executionClaimRouting) {
      this.applyExecutionFeedBatch(batch);
    }
    this.reconcilePendingExecutionSettlements();
  }

  private applyExecutionFeedBatch(batch: ExecutionFeedBatch): void {
    if (batch.snapshot === undefined) {
      if (batch.toFeedSeq <= this.#executionFeedSeq) return;
      if (
        this.#executionSnapshotRequired ||
        batch.fromFeedSeq !== this.#executionFeedSeq
      ) {
        // Never turn missing authority data into an upstream write. Retain the
        // last integrated claim view until a full reconnect snapshot arrives.
        this.#executionSnapshotRequired = true;
        return;
      }
      for (const event of batch.events) this.applyExecutionControlEvent(event);
      this.#executionFeedSeq = batch.toFeedSeq;
      return;
    }

    // A snapshot is authoritative even when a replaced session restarts its
    // feed sequence below the previous session's cursor. Apply claim changes
    // before the snapshot, then reconcile settlements against its exact live
    // incarnation map.
    for (const event of batch.events) {
      if (event.type !== "session.execution.settlement") {
        this.applyExecutionControlEvent(event);
      }
    }
    const next = new Map(
      batch.snapshot.claims.map((claim) => [actionClaimMapKey(claim), claim]),
    );
    for (const [key, previous] of this.#executionClaims) {
      const replacement = next.get(key);
      if (
        replacement === undefined ||
        executionClaimIncarnationKey(replacement) !==
          executionClaimIncarnationKey(previous)
      ) {
        // §2b row 6: the early-settlement frontier SURVIVES this. It records
        // that the server has accepted data for this action family which this
        // replica has not applied yet — a fact about data, not about who was
        // authorised to produce it. Clearing it here erased a live
        // accepted-data barrier and let the next speculation be retired before
        // its replacement had landed (D5: HOLD, never flicker).
        const invalidated = this.dropClaimedOverlays(
          (overlay) =>
            executionClaimIncarnationKey(overlay.claim) ===
              executionClaimIncarnationKey(previous),
          { dirtyProducer: true, diagnosticCode: "claim-snapshot-replaced" },
        );
        this.invalidateRegisteredExecutionActions(
          previous,
          "claim-snapshot-replaced",
          invalidated,
        );
      }
    }
    this.#executionClaims.clear();
    for (const [key, value] of next) this.#executionClaims.set(key, value);
    this.#executionFeedSeq = batch.toFeedSeq;
    this.#executionSnapshotRequired = false;
    for (const frontier of batch.snapshot.settlementFrontiers ?? []) {
      this.applyExecutionControlEvent({
        type: "session.execution.settlement",
        settlement: actionSettlementFromFrontier(frontier),
      });
    }
    for (const event of batch.events) {
      if (event.type === "session.execution.settlement") {
        this.applyExecutionControlEvent(event);
      }
    }
  }

  private applyExecutionControlEvent(event: ExecutionControlEvent): void {
    if (event.type === "session.execution.claim.set") {
      const key = actionClaimMapKey(event.claim);
      const current = this.#executionClaims.get(key);
      if (current !== undefined) {
        if (
          event.claim.leaseGeneration < current.leaseGeneration ||
          (event.claim.leaseGeneration === current.leaseGeneration &&
            event.claim.claimGeneration <= current.claimGeneration)
        ) {
          return;
        }
        const invalidated = this.dropClaimedOverlays(
          (overlay) =>
            executionClaimIncarnationKey(overlay.claim) ===
              executionClaimIncarnationKey(current),
          { dirtyProducer: true, diagnosticCode: "claim-generation-replaced" },
        );
        this.invalidateRegisteredExecutionActions(
          current,
          "claim-generation-replaced",
          invalidated,
        );
        // The early-settlement frontier survives the generation bump — see the
        // snapshot-replace arm above. Same action identity, same acting lane,
        // same implementation and runtime fingerprints: only the arbitration
        // moved, and the server's accepted data is exactly as unapplied as it
        // was a line ago.
      }
      this.#executionClaims.set(key, event.claim);
      return;
    }

    if (event.type === "session.execution.claim.revoke") {
      const key = actionClaimMapKey(event.claim);
      const current = this.#executionClaims.get(key);
      if (
        current === undefined ||
        current.leaseGeneration !== event.leaseGeneration ||
        current.claimGeneration !== event.claimGeneration
      ) {
        return;
      }
      this.#executionClaims.delete(key);
      // The early-settlement frontier survives the revoke — see the
      // snapshot-replace arm above. A revoke retires an authority; it does not
      // un-accept data the server already committed.
      const invalidated = this.dropClaimedOverlays(
        (overlay) =>
          executionClaimIncarnationKey(overlay.claim) ===
            executionClaimIncarnationKey(current),
        { dirtyProducer: true, diagnosticCode: "claim-revoked" },
      );
      this.invalidateRegisteredExecutionActions(
        current,
        "claim-revoked",
        invalidated,
      );
      return;
    }

    if (event.type === "session.execution.navigate") {
      // The SEAM's client end (navigate-to-server-side.md §2c). This arm must
      // return before the settlement tail below: that tail is only reached
      // because the other three variants are exhaustive, so a fourth variant
      // without an explicit return would read `event.settlement` off an event
      // that has none. That is §6 item 4's piggyback falsifier, and it is why
      // "add a fourth variant" is not automatically free.
      //
      // Deliberately NOT a claim mutation: a navigate is an addressing use of
      // its claim, so nothing here touches `#executionClaims`, the claimed
      // overlays, or the registered-action index. Applying one twice changes no
      // client state.
      this.#onExecutionNavigate?.(event);
      return;
    }

    const hasOverlay = this.hasClaimedOverlaysInFamily(
      executionOverlayFamilyKey(event.settlement.claim),
    );
    if (
      this.settlementAddressesLocalSpeculation(event.settlement, hasOverlay)
    ) {
      this.noteExecutionSettlement(event.settlement);
      if (!hasOverlay) {
        this.retainEarlyExecutionSettlement(event.settlement);
        return;
      }
      const settlement = event.settlement.outcome === "committed" ||
          event.settlement.outcome === "no-op"
        ? this.coalescePendingSuccessfulExecutionSettlement(event.settlement)
        : event.settlement;
      if (this.reconcileExecutionSettlement(settlement)) {
        this.#pendingExecutionSettlements.push(settlement);
      }
    }
  }

  /** True while any local speculation for this action family is still held. */
  private hasClaimedOverlaysInFamily(family: string): boolean {
    for (const overlay of this.#claimedOverlays.values()) {
      if (executionOverlayFamilyKey(overlay.claim) === family) return true;
    }
    return false;
  }

  /**
   * Does this settlement speak to speculation THIS replica is holding?
   *
   * §2b row 6: the successful drop is keyed by the action family, so the
   * admission test is family-shaped too — **do I hold an overlay this
   * settlement's action ran?** When the answer is yes the seq comparisons
   * below decide everything else, and they are the only things that can: two
   * settlements of one family carry the same `implementationFingerprint` and
   * `runtimeFingerprint` (both are components of the family key), so at equal
   * input basis they name the same value. A claim generation cannot change
   * what the server computed — it only ever said who was allowed to compute
   * it, which is the arbitration this arc deletes.
   *
   * The claim check survives only on the OTHER arm, where nothing local is at
   * stake: a settlement with no overlay to retire is merely cached as an early
   * frontier, and while claims still exist there is no reason to cache one the
   * client is not deferring to. That arm is the last claim term on this path;
   * once claims stop being minted the family arm is the whole predicate.
   */
  private settlementAddressesLocalSpeculation(
    settlement: ActionSettlement,
    hasOverlay?: boolean,
  ): boolean {
    const family = executionOverlayFamilyKey(settlement.claim);
    if (hasOverlay ?? this.hasClaimedOverlaysInFamily(family)) return true;
    const current = this.#executionClaims.get(family);
    return current !== undefined &&
      executionClaimIncarnationKey(current) ===
        executionClaimIncarnationKey(settlement.claim);
  }

  /** Returns true only while this exact settlement still awaits a local basis
   * translation or accepted-data application barrier. */
  private reconcileExecutionSettlement(settlement: ActionSettlement): boolean {
    const family = executionOverlayFamilyKey(settlement.claim);
    const matching = [...this.#claimedOverlays.values()].filter((overlay) =>
      executionOverlayFamilyKey(overlay.claim) === family
    );
    if (matching.length === 0) return false;
    if (settlement.outcome === "failed") return false;
    if (settlement.outcome === "unserved") {
      // §1f / CP1: the fail-open, client-authoritative arm. It keeps its exact
      // claim-incarnation predicate — an unserved settlement is a statement
      // about ONE claim attempt, not about the action's value, so it must not
      // inherit the family widening above. Today the two predicates select the
      // same overlays (one family holds one incarnation at a time), so this is
      // the same set it always dropped.
      const incarnation = executionClaimIncarnationKey(settlement.claim);
      this.dropClaimedOverlays(
        (overlay) =>
          executionClaimIncarnationKey(overlay.claim) === incarnation,
        { dirtyProducer: true, diagnosticCode: "claim-unserved" },
      );
      return false;
    }

    const unresolved = matching.some((overlay) =>
      this.overlayHasUnresolvedBasis(overlay)
    );
    // C3.9 (C3A15): the drop compare generalizes per component. An overlay is
    // covered only when EVERY component of the settlement's vector covers the
    // overlay's basis for that space — the HOME component (the scalar
    // inputBasisSeq, always present) AND every PRESENT foreign component. An
    // absent settlement component vacuously covers (it names no requirement, so
    // a rerun that dropped a foreign read still drops on home coverage); a
    // present-but-older foreign component never covers (it blocks). Scalar-only
    // settlements carry no `inputBasis`, so the vector loop is empty and the
    // decision is byte-identical to the pre-C3.9 rule.
    const covered = matching.filter((overlay) =>
      this.settlementCoversOverlay(settlement, overlay)
    );
    if (covered.length === 0) {
      logger.debug("execution-overlay-retained", () => [
        unresolved
          ? "Settlement awaits pending-source basis translation"
          : "Settlement input basis does not cover the overlay",
        {
          actionId: settlement.claim.actionId,
          reason: unresolved ? "pending-source-basis" : "older-basis",
        },
      ]);
      return unresolved;
    }
    if (
      settlement.outcome === "committed" &&
      this.#executionAppliedSeq < settlement.acceptedCommitSeq
    ) {
      logger.debug("execution-overlay-retained", () => [
        "Settlement awaits accepted data application",
        {
          actionId: settlement.claim.actionId,
          appliedSeq: this.#executionAppliedSeq,
          acceptedCommitSeq: settlement.acceptedCommitSeq,
        },
      ]);
      return true;
    }
    // C3A19: count the accepted vector divergence window at the authoritative
    // drop, before the overlay is gone (the comparand needs the overlay's
    // captured foreign basis).
    for (const overlay of covered) {
      this.noteExecutionVectorDivergence(settlement, overlay);
    }
    const coveredSeqs = new Set(covered.map((overlay) => overlay.localSeq));
    this.dropClaimedOverlays(
      (overlay) => coveredSeqs.has(overlay.localSeq),
      { dirtyProducer: false, diagnosticCode: `claim-${settlement.outcome}` },
    );
    return unresolved;
  }

  /** C3.9: true while any component of the overlay's vector basis — the home
   * pending sources OR any foreign pending-source translation — is still
   * unresolved. Such an overlay is not yet coverable: its basis can still rise
   * above a settlement component once the pending source confirms. */
  private overlayHasUnresolvedBasis(
    overlay: ClaimedOverlayGeneration,
  ): boolean {
    if (overlay.unresolvedBasisLocalSeqs.size > 0) return true;
    for (const pending of overlay.unresolvedForeignBasis.values()) {
      if (pending.size > 0) return true;
    }
    return false;
  }

  /**
   * C3.9 (C3A15) drop coverage: does this settlement's vector cover the
   * overlay's basis on EVERY component? The home component is the unchanged
   * scalar compare. For the vector, iterate the SETTLEMENT'S components (§5:
   * "every component of the settlement's vector covers the overlay's basis for
   * that space") — a present foreign component must be >= the overlay's
   * captured basis for that space (present-but-older blocks); a foreign space
   * the overlay tracked but the settlement OMITS imposes no requirement (absent
   * vacuously covers). A space the settlement names but the overlay never read
   * is vacuously covered from the overlay side. Foreign seqs are per-space
   * domains — never compared across spaces or against the home scalar.
   */
  private settlementCoversOverlay(
    settlement: ActionSettlement,
    overlay: ClaimedOverlayGeneration,
  ): boolean {
    if (this.overlayHasUnresolvedBasis(overlay)) return false;
    if (overlay.basisSeq > settlement.inputBasisSeq) return false;
    const homeSpace = settlement.claim.space;
    for (const component of settlement.inputBasis ?? []) {
      if (component.space === homeSpace) continue;
      const overlayForeign = overlay.foreignBasis.get(component.space);
      // Absent overlay component: the overlay never read this space (vacuous).
      if (overlayForeign === undefined) continue;
      // Present-but-older: the settlement read this space STALER than the
      // overlay's speculative run — it cannot supersede the overlay yet.
      if (overlayForeign > component.seq) return false;
    }
    return true;
  }

  /**
   * C3.9 (C3A19): count the accepted vector divergence window at an
   * authoritative drop — a settlement foreign component STRICTLY newer than the
   * overlay's captured basis for that space means the revealed home value
   * reflects foreign state the client's own foreign replica had not confirmed
   * when the overlay was created (the §5 window, the analog of §B.4's scalar
   * window). Surfaced as a routeDiagnostics code; accepted, brief,
   * self-healing, and never a block on the drop.
   */
  private noteExecutionVectorDivergence(
    settlement: ActionSettlement,
    overlay: ClaimedOverlayGeneration,
  ): void {
    const homeSpace = settlement.claim.space;
    for (const component of settlement.inputBasis ?? []) {
      if (component.space === homeSpace) continue;
      const overlayForeign = overlay.foreignBasis.get(component.space);
      if (overlayForeign !== undefined && component.seq > overlayForeign) {
        this.noteExecutionRouteDiagnostic(
          settlement.branch,
          CROSS_SPACE_BASIS_DIVERGENCE_DIAGNOSTIC,
        );
      }
    }
  }

  private reconcilePendingExecutionSettlements(): void {
    if (this.#pendingExecutionSettlements.length === 0) return;
    const pending = this.#pendingExecutionSettlements;
    this.#pendingExecutionSettlements = [];
    for (const settlement of pending) {
      const hasOverlay = this.hasClaimedOverlaysInFamily(
        executionOverlayFamilyKey(settlement.claim),
      );
      if (!this.settlementAddressesLocalSpeculation(settlement, hasOverlay)) {
        continue;
      }
      if (
        !hasOverlay &&
        (settlement.outcome === "committed" || settlement.outcome === "no-op")
      ) {
        // The prior overlay may disappear for a non-authoritative reason (for
        // example, a pending source commit was rejected). Preserve the server's
        // successful frontier so a later speculative run cannot bypass its
        // accepted-data barrier.
        this.retainEarlyExecutionSettlement(settlement);
      } else if (this.reconcileExecutionSettlement(settlement)) {
        this.#pendingExecutionSettlements.push(settlement);
      }
    }
  }

  private dropClaimedOverlays(
    predicate: (overlay: ClaimedOverlayGeneration) => boolean,
    options: { dirtyProducer: boolean; diagnosticCode: string },
  ): ReadonlySet<object> {
    const dropped = [...this.#claimedOverlays.values()].filter(predicate);
    if (dropped.length === 0) return new Set();
    const basisCovered = options.diagnosticCode === "claim-committed" ||
      options.diagnosticCode === "claim-no-op";
    for (const overlay of dropped) {
      const record = this.executionRoutingDiagnosticRecord(overlay.claim);
      const totals = this.executionRoutingBranchTotals(overlay.claim.branch);
      if (basisCovered) {
        record.basisCoveredOverlayDrops++;
        totals.basisCoveredOverlayDrops++;
      } else if (options.dirtyProducer) {
        record.nonAuthoritativeOverlayDrops++;
        totals.nonAuthoritativeOverlayDrops++;
      }
    }
    const localSeqs = new Set(dropped.map((overlay) => overlay.localSeq));
    // Touched documents are resolved under each overlay's OWN lane key; the
    // notification diff below intentionally reads under the ambient lane
    // (client overlays are space-lane — see ClaimedOverlayGeneration.lane).
    const touchedByKey = new Map<
      string,
      { id: URI; scope?: CellScope; lane: SchedulerExecutionContextKey }
    >();
    for (const overlay of dropped) {
      for (const entry of overlay.touched) {
        touchedByKey.set(docKey(entry.id, entry.scope, overlay.lane), {
          ...entry,
          lane: overlay.lane,
        });
      }
    }
    const touched = [...touchedByKey.values()];
    const shouldNotifySubscribers = touched.length > 0 &&
      this.hasNotificationSubscribers();
    const shouldNotifySinks = touched.length > 0 &&
      this.hasSinkSubscribers(touched);
    const trackDivergence = options.diagnosticCode === "claim-committed" ||
      options.diagnosticCode === "claim-no-op";
    const before = shouldNotifySubscribers || trackDivergence
      ? Differential.checkout(
        this,
        touched.map(({ id, scope }) => snapshotState(this, id, scope)),
      )
      : undefined;
    // Every pending version owned by these overlays was created from their
    // recorded touched set. Visit only those exact documents: scanning the
    // whole replica for every server settlement makes claimed speculation
    // proportional to unrelated space size.
    for (const { id, scope, lane } of touched) {
      const record = this.#docs.get(docKey(id, scope, lane));
      if (record === undefined) continue;
      if (!record.pending.some((entry) => localSeqs.has(entry.localSeq))) {
        continue;
      }
      record.pending = record.pending.filter((entry) =>
        !localSeqs.has(entry.localSeq)
      );
      record.materialized = undefined;
    }
    for (const overlay of dropped) {
      this.#claimedOverlays.delete(overlay.localSeq);
    }
    const now = performance.now();
    for (const overlay of dropped) {
      logger.time(
        overlay.createdAt,
        now,
        "execution-overlay-held",
      );
    }
    logger.debug("execution-overlay-dropped", () => [
      "Claimed overlay dropped",
      {
        overlays: dropped.length,
        reason: options.diagnosticCode,
        maxAgeMs: Math.max(
          ...dropped.map((overlay) => Math.max(0, now - overlay.createdAt)),
        ),
      },
    ]);
    if (before !== undefined) {
      const changes = before.compare(this);
      const changed = [...changes].length > 0;
      if (changed) {
        if (trackDivergence) {
          logger.debug("execution-overlay-divergence", () => [
            "Authoritative server state replaced a speculative overlay",
            { overlays: dropped.length, reason: options.diagnosticCode },
          ]);
        }
        if (shouldNotifySubscribers) {
          this.#subscription.next({
            type: "integrate",
            space: this.#space,
            changes,
          });
        }
        if (shouldNotifySinks) this.notifySinks(changes);
      }
    } else if (shouldNotifySinks) {
      this.notifySinksForIds(touched);
    }
    const invalidatedActions = options.dirtyProducer
      ? new Set(dropped.map((overlay) => overlay.sourceAction))
      : new Set<object>();
    for (const sourceAction of invalidatedActions) {
      this.#subscription.next({
        type: "execution-claim-invalidation",
        space: this.#space,
        sourceAction,
        diagnosticCode: options.diagnosticCode,
      });
    }
    return invalidatedActions;
  }

  private invalidateRegisteredExecutionActions(
    claim: ActionClaimKey,
    diagnosticCode: string,
    alreadyInvalidated: ReadonlySet<object>,
  ): void {
    for (const sourceAction of this.#executionActionsForClaimKey(claim)) {
      if (alreadyInvalidated.has(sourceAction)) continue;
      this.#subscription.next({
        type: "execution-claim-invalidation",
        space: this.#space,
        sourceAction,
        diagnosticCode,
      });
    }
  }

  private sessionHandle(): Promise<ReplicaSessionHandle> {
    if (this.#sessionHandle === undefined) {
      // Defer the factory call until after #sessionHandle is installed. Session
      // setup can synchronously re-enter provider work (notably home-space ACL
      // bootstrap); calling the factory inline leaves a window where that work
      // starts a second mount with the same explicit session id and revokes the
      // first mount before it can commit.
      const handle = Promise.resolve().then(() => this.#createSession()).then(
        (resolved) => {
          this.#sessionClient = resolved.client;
          this.#sessionSession = resolved.session;
          this.initializeClientExecutionControl(resolved);
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

const executionFirewallDiagnostic = (error: unknown): string | undefined =>
  error instanceof Error && error.name === "ExecutionActionFirewallError" &&
    typeof (error as Error & { diagnosticCode?: unknown }).diagnosticCode ===
      "string"
    ? (error as Error & { diagnosticCode: string }).diagnosticCode
    : undefined;

const executionFirewallRejection = (
  commit: unknown,
  diagnosticCode: string,
  message: string,
): StorageTransactionRejected =>
  ({
    name: "ExecutionActionFirewallError",
    message,
    diagnosticCode,
    cause: { name: "SystemError", message, code: 500 },
    transaction: commit as Transaction,
  }) as unknown as StorageTransactionRejected;

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
  commit: unknown,
  space: MemorySpace,
): StorageTransactionRejected => {
  const structuredMessage = (error as { message?: unknown })?.message;
  const message = typeof structuredMessage === "string"
    ? structuredMessage
    : error instanceof Error
    ? error.message
    : String(error);
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

  // Preserve stable non-retryable wire names instead of collapsing them into a
  // generic, bounded-retry TransactionError. Terminal data refusals recompute
  // the same rejected write; an execution fence asserts a stale lease/claim
  // incarnation that the same attempt can never recover.
  if (name === "ExecutionActionFirewallError") {
    const diagnosticCode = executionFirewallDiagnostic(error) ??
      "unknown-firewall-rejection";
    return executionFirewallRejection(commit, diagnosticCode, message);
  }
  if (name === "AuthorizationError") {
    return {
      name,
      message,
      cause: { name: "SystemError", message, code: 403 },
      transaction: commit as Transaction,
    } as unknown as TransactionError;
  }
  if (name === "RowLabelCommitError") {
    return {
      name,
      message,
      cause: { name: "SystemError", message, code: 500 },
      transaction: commit as Transaction,
    } as unknown as TransactionError;
  }
  if (name === "ExecutionLeaseFenceError") {
    return {
      name,
      message,
      cause: { name: "SystemError", message, code: 409 },
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
