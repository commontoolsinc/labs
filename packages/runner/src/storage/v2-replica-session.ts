import type {
  ClientCommit,
  ExecutionClaim,
  ExecutionControlEvent,
  GraphQuery,
  GraphQueryResult,
  LegacyBackgroundExclusion,
  LegacyBackgroundExclusionStatus,
  MemoryProtocolFlags,
  SchedulerActionSnapshotQuery,
  SchedulerSnapshotListResult,
  SchedulerWritersForTargetsQuery,
  SchedulerWritersForTargetsResult,
  SessionSync,
  SqliteDbRef,
  SqliteParamsWire,
  SqliteQueryResult,
  SqliteRegisterDiskSourceResult,
  WatchSpec,
} from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type {
  GraphQueryTrigger,
  SchedulerExecutionContextKey,
} from "@commonfabric/memory/v2";

/** Worker-local view of a replica update stream. */
export interface ReplicaWatchView {
  close(): void;
  subscribeSync(): AsyncIterator<SessionSync>;
}

/**
 * Per-request read options (C1.4b lane-scoped read seam, threaded by
 * C1.5b): a lease-bound executor session resolves scoped addresses under
 * `actingContext` — validated host-side against the live lane grant BEFORE
 * any scope key resolves. Space-lane readers omit it.
 */
export interface ReplicaReadOptions {
  actingContext?: SchedulerExecutionContextKey;
  /** FA5/FB12 trigger attribution for graph queries (wave-triggered refresh
   * vs demand-triggered pull). Accounting only; optional. */
  trigger?: GraphQueryTrigger;
}

/**
 * The authenticated storage operations SpaceReplica needs from its backend.
 * Remote memory sessions and the executor MessagePort backend both implement
 * this interface; the synchronous replica/cache remains in the Worker.
 */
export interface ReplicaSession {
  readonly sessionId: string;
  readonly sessionToken: string | undefined;
  readonly serverSeq: number;
  transact(commit: ClientCommit): Promise<AppliedCommit>;
  /** Advance execution settlement gating only after the local replica has
   * applied/confirmed the accepted commit data. */
  noteAppliedCommit?(seq: number): void;
  queryGraph(
    query: GraphQuery,
    options?: ReplicaReadOptions,
  ): Promise<GraphQueryResult>;
  watchAddSync(
    watches: WatchSpec[],
    options?: ReplicaReadOptions,
  ): Promise<{
    view: ReplicaWatchView;
    sync: SessionSync;
  }>;
  /**
   * Replace the whole session watch set (F4 client closure export). Optional:
   * executor host-provider sessions never register client doc-set watches, so
   * they may omit it, and the client replica falls back to graph watches when a
   * session does not implement it. Replaces `watchAddSync`'s growth-only set,
   * which is how the space-lane graph watches are demoted make-before-break and
   * how a shrunken membership retracts an evicted doc's server-side source.
   */
  watchSetSync?(
    watches: WatchSpec[],
    options?: ReplicaReadOptions,
  ): Promise<{
    view: ReplicaWatchView;
    sync: SessionSync;
  }>;
  /**
   * C1.9/FB13 lane-drain watch lifecycle: retire (or re-key onto the
   * context-free/sponsor read path) every watch this session holds under the
   * drained lane's acting context, so a dead lane grant stops keying
   * point-read groups and cold refreshes — a read issued under a drained
   * lane's context is rejected by the host (`laneReadRejection`) forever.
   * Optional: only the executor host-provider session maintains lane-keyed
   * watches; remote/scripted sessions omit it.
   */
  pruneLaneWatches?(lane: SchedulerExecutionContextKey): void;
  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult>;
  registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult>;
  listSchedulerActionSnapshots(
    query?: SchedulerActionSnapshotQuery,
    options?: ReplicaReadOptions,
  ): Promise<SchedulerSnapshotListResult>;
  writersForTargets(
    query: SchedulerWritersForTargetsQuery,
    options?: ReplicaReadOptions,
  ): Promise<SchedulerWritersForTargetsResult>;
  /** Client-only execution-control surface. Executor provider sessions omit
   *  these methods so a Worker cannot manufacture client demand. */
  readonly executionClaims?: readonly ExecutionClaim[];
  /** Highest ordered execution-control feed sequence already reflected in
   * `executionClaims`. Lets a replica seed atomically before consuming deltas. */
  readonly executionFeedSeq?: number;
  setExecutionDemand?(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
  acquireLegacyBackgroundExclusion?(
    branch: string,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined>;
  renewLegacyBackgroundExclusion?(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined>;
  releaseLegacyBackgroundExclusion?(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusion | null | undefined>;
  subscribeExecutionControl?(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
}

/** Connection lifecycle and negotiated capabilities used by SpaceReplica. */
export interface ReplicaClient {
  readonly serverFlags: MemoryProtocolFlags | null;
  close(): Promise<void>;
}

export interface ReplicaSessionHandle {
  client: ReplicaClient;
  session: ReplicaSession;
}
