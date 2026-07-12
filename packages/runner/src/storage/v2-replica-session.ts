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

/** Worker-local view of a replica update stream. */
export interface ReplicaWatchView {
  close(): void;
  subscribeSync(): AsyncIterator<SessionSync>;
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
  queryGraph(query: GraphQuery): Promise<GraphQueryResult>;
  watchAddSync(watches: WatchSpec[]): Promise<{
    view: ReplicaWatchView;
    sync: SessionSync;
  }>;
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
  ): Promise<SchedulerSnapshotListResult>;
  writersForTargets(
    query: SchedulerWritersForTargetsQuery,
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
