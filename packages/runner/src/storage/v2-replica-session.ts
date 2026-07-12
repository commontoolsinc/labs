import type {
  ClientCommit,
  GraphQuery,
  GraphQueryResult,
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
