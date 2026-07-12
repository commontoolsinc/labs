import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  encodeMemoryBoundary,
  type EntitySnapshot,
  type GraphQuery,
  type GraphQueryResult,
  type HelloOkMessage,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerActionSnapshotResult,
  type SchedulerSnapshotListResult,
  type SchedulerWritersForTargetsQuery,
  type SchedulerWritersForTargetsResult,
  type SessionOpenRequest,
  type SessionSync,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  type V2Error,
  type WatchSpec,
  type WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type AcceptedCommitEvent,
  type ExecutionLeaseHandle,
  parseClientMessage,
  type Server,
} from "@commonfabric/memory/v2/server";
import type { BranchName } from "@commonfabric/memory/v2";
import {
  type ActionTransactionRouter,
  type Options,
  type SessionFactory,
  StorageManager,
} from "./v2.ts";
import type { ReplicaSession } from "./v2-replica-session.ts";

export interface AcceptedCommitNotice {
  space: string;
  branch: BranchName;
  order: number;
  dataSeq: number;
  deliverySeq: number;
  originSessionId?: string;
  revisions: {
    branch: BranchName;
    id: string;
    scope?: string;
    seq: number;
  }[];
  schedulerUpdateIds: number[];
}

type ProviderPortMessage =
  | { type: "memory"; payload: string }
  | { type: "accepted-commit"; notice: AcceptedCommitNotice }
  | { type: "close"; message?: string };

interface HostProviderChannelBaseOptions {
  server: Server;
  space: MemorySpace;
  branch?: BranchName;
  /** Defense in depth: reject any Worker transaction escaping shadow storage. */
  shadowWrites?: boolean;
}

interface UnleasedHostProviderChannelOptions {
  /** Host-owned grant creation. This callback and its credentials never cross
   *  the MessagePort into the Worker. */
  authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory;
  executionLease?: never;
}

interface LeasedHostProviderChannelOptions {
  /** Exact host-only authority bound before the memory handshake. The handle
   * remains in this realm and is never encoded onto the MessagePort. */
  executionLease: ExecutionLeaseHandle;
  authorizeSessionOpen?: never;
}

export type HostProviderChannelOptions =
  & HostProviderChannelBaseOptions
  & (UnleasedHostProviderChannelOptions | LeasedHostProviderChannelOptions);

export interface HostProviderChannel {
  /** Opaque endpoint transferred to the executor Worker. */
  readonly port: MessagePort;
  dispose(): Promise<void>;
}

const responseError = (
  requestId: string,
  name: string,
  message: string,
): ResponseMessage<never> => ({
  type: "response",
  requestId,
  error: { name, message },
});

const requestIdOf = (message: unknown): string =>
  typeof message === "object" && message !== null &&
    "requestId" in message &&
    typeof (message as { requestId?: unknown }).requestId === "string"
    ? (message as { requestId: string }).requestId
    : "host-provider";

const messageSpace = (message: ReturnType<typeof parseClientMessage>) =>
  message !== null && "space" in message ? message.space : undefined;

const hasExecutionClaimAssertion = (commit: ClientCommit): boolean => {
  const observation = commit.schedulerObservation;
  return typeof observation === "object" && observation !== null &&
    !Array.isArray(observation) &&
    typeof (observation as Record<string, unknown>)
        .executionClaimAssertion === "object";
};

const toAcceptedCommitNotice = (
  event: AcceptedCommitEvent,
): AcceptedCommitNotice => ({
  space: event.space,
  branch: event.branch,
  order: event.order,
  dataSeq: event.dataSeq,
  deliverySeq: event.deliverySeq,
  ...(event.originSessionId !== undefined
    ? { originSessionId: event.originSessionId }
    : {}),
  revisions: event.revisions.map((revision) => ({
    branch: revision.branch,
    id: revision.id,
    ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
    seq: revision.seq,
  })),
  schedulerUpdateIds: [...event.schedulerUpdateIds],
});

/**
 * Normalize every branch-bearing request onto the host-owned lane. Messages
 * without a branch surface (session lifecycle and SQLite v1) remain bound by
 * the exact space and authenticated connection.
 */
const pinBranch = (
  message: NonNullable<ReturnType<typeof parseClientMessage>>,
  branch: BranchName,
): NonNullable<ReturnType<typeof parseClientMessage>> => {
  switch (message.type) {
    case "transact":
      return {
        ...message,
        commit: { ...message.commit, branch },
      };
    case "graph.query":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.snapshot.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "scheduler.writer.list":
      return {
        ...message,
        query: { ...message.query, branch },
      };
    case "session.watch.set":
    case "session.watch.add":
      return {
        ...message,
        watches: message.watches.map((watch) => ({
          ...watch,
          query: { ...watch.query, branch },
        })),
      };
    default:
      return message;
  }
};

/**
 * Create the host half of an executor provider. All memory frames still enter
 * through Server.connect/Connection.receive, preserving handshake ordering,
 * session ownership, ACL/CFC/conflict checks, and post-commit hooks. The host
 * Unleased compatibility channels overwrite session.open authorization with
 * their host-owned grant callback. Lease-bound executor channels instead bind
 * exact host authority before the handshake and never request a Worker grant.
 */
export function createHostProviderChannel(
  options: HostProviderChannelOptions,
): HostProviderChannel {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const branch = options.branch ?? "";
  let authContext: MemoryClient.SessionOpenAuthContext | null = null;
  let disposed = false;
  let receiving = Promise.resolve();
  let unsubscribeAcceptedCommits = () => {};

  const connection = options.server.connect((message) => {
    if (disposed) return;
    if (message.type === "hello.ok") {
      const hello = message as HelloOkMessage;
      if (hello.sessionOpen !== undefined) {
        authContext = hello.sessionOpen;
      }
    }
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(message),
      } satisfies ProviderPortMessage,
    );
  });
  if (options.executionLease !== undefined) {
    connection.bindExecutionLease(options.executionLease);
  }

  const closeHost = (message?: string) => {
    if (disposed) return;
    disposed = true;
    unsubscribeAcceptedCommits();
    connection.close();
    try {
      hostPort.postMessage(
        {
          type: "close",
          ...(message !== undefined ? { message } : {}),
        } satisfies ProviderPortMessage,
      );
    } catch {
      // The Worker may already have closed its transferred endpoint.
    }
    hostPort.close();
  };

  const sendError = (requestId: string, error: V2Error) => {
    if (disposed) return;
    hostPort.postMessage(
      {
        type: "memory",
        payload: encodeMemoryBoundary(
          responseError(requestId, error.name, error.message),
        ),
      } satisfies ProviderPortMessage,
    );
  };

  const receive = async (payload: string): Promise<void> => {
    const parsed = parseClientMessage(payload);
    if (parsed === null) {
      // Let the canonical parser produce its normal InvalidMessageError.
      await connection.receive(payload);
      return;
    }
    const requestedSpace = messageSpace(parsed);
    if (requestedSpace !== undefined && requestedSpace !== options.space) {
      sendError(requestIdOf(parsed), {
        name: "AuthorizationError",
        message: `executor provider is bound to ${options.space}`,
      });
      return;
    }
    if (parsed.type === "session.execution.demand.set") {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message: "executor providers cannot originate client execution demand",
      });
      return;
    }
    if (
      parsed.type === "session.execution.legacy-background.acquire" ||
      parsed.type === "session.execution.legacy-background.renew" ||
      parsed.type === "session.execution.legacy-background.release"
    ) {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message:
          "executor providers cannot control legacy background execution",
      });
      return;
    }
    if (
      options.shadowWrites === true && parsed.type === "transact" &&
      !hasExecutionClaimAssertion(parsed.commit)
    ) {
      sendError(parsed.requestId, {
        name: "AuthorizationError",
        message:
          "shadow executor providers require an exact claimed action assertion",
      });
      return;
    }
    if (parsed.type === "session.open") {
      if (options.executionLease !== undefined) {
        await connection.receive(encodeMemoryBoundary(parsed));
        return;
      }
      if (authContext === null) {
        sendError(parsed.requestId, {
          name: "ProtocolError",
          message: "executor provider has no active session challenge",
        });
        return;
      }
      let auth: MemoryClient.SessionOpenAuth | undefined;
      try {
        auth = await options.authorizeSessionOpen(
          parsed.space,
          parsed.session,
          authContext,
        );
      } catch (error) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (auth === undefined) {
        sendError(parsed.requestId, {
          name: "AuthorizationError",
          message: "executor provider host did not grant the session",
        });
        return;
      }
      const authenticated: SessionOpenRequest = {
        ...parsed,
        invocation: auth.invocation,
        authorization: auth
          .authorization as SessionOpenRequest["authorization"],
      };
      await connection.receive(encodeMemoryBoundary(authenticated));
      return;
    }
    await connection.receive(encodeMemoryBoundary(pinBranch(parsed, branch)));
  };

  hostPort.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<ProviderPortMessage>;
    if (message.type === "close") {
      closeHost();
      return;
    }
    if (message.type !== "memory" || typeof message.payload !== "string") {
      closeHost("invalid executor provider message");
      return;
    }
    receiving = receiving.then(
      () => receive(message.payload!),
      () => receive(message.payload!),
    ).catch((error) => {
      closeHost(error instanceof Error ? error.message : String(error));
    });
  });
  hostPort.addEventListener("messageerror", () => {
    closeHost("executor provider message decoding failed");
  });
  hostPort.start();

  // Register before returning the Worker endpoint. MessagePort queues notices
  // until its peer starts, which closes the initial point-read race without a
  // server graph watch.
  unsubscribeAcceptedCommits = options.server.subscribeAcceptedCommits(
    options.space,
    (event) => {
      if (disposed || event.branch !== branch) return;
      hostPort.postMessage(
        {
          type: "accepted-commit",
          notice: toAcceptedCommitNotice(event),
        } satisfies ProviderPortMessage,
      );
    },
  );

  return {
    port: channel.port2,
    dispose() {
      closeHost();
      // Connection.close detaches the authenticated session and suppresses any
      // late response. A read already executing inside the Server may still
      // unwind, but disposal must not wait for that non-cancellable work or a
      // terminated Worker could strand its host lease/channel indefinitely.
      void receiving.catch(() => undefined);
      return Promise.resolve();
    },
  };
}

class MessagePortTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #closed = false;
  #acceptedCommitReceiver: ((notice: AcceptedCommitNotice) => void) | null =
    null;
  #bufferedAcceptedCommits: AcceptedCommitNotice[] = [];

  constructor(private readonly port: MessagePort) {
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as Partial<ProviderPortMessage>;
      if (message.type === "memory" && typeof message.payload === "string") {
        this.#receiver(message.payload);
      } else if (
        message.type === "accepted-commit" && message.notice !== undefined
      ) {
        if (this.#acceptedCommitReceiver === null) {
          this.#bufferedAcceptedCommits.push(message.notice);
        } else {
          this.#acceptedCommitReceiver(message.notice);
        }
      } else if (message.type === "close") {
        this.closeFromHost(message.message);
      } else {
        this.closeFromHost("invalid host provider message");
      }
    });
    port.addEventListener("messageerror", () => {
      this.closeFromHost("host provider message decoding failed");
    });
    port.start();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  setAcceptedCommitReceiver(
    receiver: (notice: AcceptedCommitNotice) => void,
  ): void {
    this.#acceptedCommitReceiver = receiver;
    const buffered = this.#bufferedAcceptedCommits;
    this.#bufferedAcceptedCommits = [];
    for (const notice of buffered) receiver(notice);
  }

  send(payload: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("executor provider transport closed"));
    }
    this.port.postMessage(
      { type: "memory", payload } satisfies ProviderPortMessage,
    );
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    try {
      this.port.postMessage({ type: "close" } satisfies ProviderPortMessage);
    } finally {
      this.port.close();
    }
    return Promise.resolve();
  }

  private closeFromHost(message?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.port.close();
    this.#closeReceiver(new Error(message ?? "executor provider host closed"));
  }
}

const snapshotKey = (snapshot: {
  branch: string;
  id: string;
  scope?: string;
}): string =>
  `${snapshot.branch}\0${snapshot.scope ?? "space"}\0${snapshot.id}`;

const dirtyEntityKey = (snapshot: {
  id: string;
  scope?: string;
}): string => `${snapshot.scope ?? "space"}\0${snapshot.id}`;

const syncUpsert = (snapshot: EntitySnapshot) => ({
  branch: snapshot.branch,
  id: snapshot.id,
  ...(snapshot.scope !== undefined ? { scope: snapshot.scope } : {}),
  seq: snapshot.seq,
  ...(snapshot.document === null
    ? { deleted: true as const }
    : { doc: snapshot.document }),
});

/**
 * Worker-side session facade. Authenticated operations still use the ordinary
 * memory session, while graph subscriptions are replaced by host-pushed
 * accepted-commit notices and exact point reads.
 */
class HostReplicaSession implements ReplicaSession {
  #watches = new Map<string, WatchSpec>();
  #watchEntities = new Map<string, Map<string, EntitySnapshot>>();
  #view: MemoryClient.WatchView | null = null;
  #mutation = Promise.resolve();
  #appliedSeq: number;
  #acceptedOrder = 0;
  #schedulerDeliverySeq: number;
  #seenObservationVersions = new Map<number, string>();
  #closed = false;

  constructor(
    private readonly session: MemoryClient.SpaceSession,
    transport: MessagePortTransport,
    private readonly branch: BranchName,
    private readonly onAcceptedCommitIntegrated?: (
      notice: AcceptedCommitNotice,
    ) => void,
  ) {
    this.#appliedSeq = session.serverSeq;
    this.#schedulerDeliverySeq = session.serverSeq;
    transport.setAcceptedCommitReceiver((notice) => {
      const refresh = this.#mutation.then(
        () => this.refreshAndNotifyAcceptedCommit(notice),
        () => this.refreshAndNotifyAcceptedCommit(notice),
      );
      this.#mutation = refresh.catch((error) => {
        if (
          !(error instanceof Error) ||
          (!error.message.includes("memory session closed") &&
            !error.message.includes("memory client closed") &&
            !error.message.includes("memory client is closed") &&
            !error.message.includes("transport closed"))
        ) {
          console.warn("executor accepted-commit refresh failed", error);
        }
      });
    });
  }

  /** Wait until every accepted-commit notice already delivered by the host has
   * refreshed the replica, then return the integrated data watermark. */
  acceptedCommitsSettled(): Promise<number> {
    return this.#mutation.then(() => this.#appliedSeq);
  }

  private async refreshAndNotifyAcceptedCommit(
    notice: AcceptedCommitNotice,
  ): Promise<void> {
    if (!await this.refreshAcceptedCommit(notice)) return;
    try {
      this.onAcceptedCommitIntegrated?.(notice);
    } catch (error) {
      // The replica is already integrated and the commit durable. A selective
      // wake observer is diagnostic/control-plane work and cannot roll either
      // fact back or poison later accepted notices.
      console.warn("executor accepted-commit observer failed", error);
    }
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionToken(): string | undefined {
    return this.session.sessionToken;
  }

  get serverSeq(): number {
    return this.session.serverSeq;
  }

  async transact(commit: ClientCommit) {
    try {
      return await this.session.transact({ ...commit, branch: this.branch });
    } catch (error) {
      const readyToRetry = (error as { readyToRetry?: unknown })
        ?.readyToRetry;
      if (
        error instanceof Error && error.name === "ConflictError" &&
        typeof readyToRetry === "function"
      ) {
        (error as Error & { readyToRetry: () => Promise<void> }).readyToRetry =
          async () => {
            await Promise.resolve(readyToRetry.call(error));
            this.#view?.applySync({
              type: "sync",
              fromSeq: this.session.serverSeq,
              toSeq: this.session.serverSeq,
              caughtUpLocalSeq: commit.localSeq,
              upserts: [],
              removes: [],
            }, true);
          };
      }
      throw error;
    }
  }

  noteAppliedCommit(seq: number): void {
    this.session.noteAppliedCommit(seq);
  }

  queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    return this.session.queryGraph({ ...query, branch: this.branch });
  }

  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    return this.session.sqliteQuery(db, sql, params);
  }

  registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    return this.session.registerSqliteDiskSource(id, path);
  }

  async listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    const result = await this.session.listSchedulerActionSnapshots({
      ...query,
      branch: this.branch,
    });
    for (const snapshot of result.snapshots) {
      this.#seenObservationVersions.set(
        snapshot.observationId,
        encodeMemoryBoundary(snapshot),
      );
      if (snapshot.commitSeq !== null) {
        this.#schedulerDeliverySeq = Math.max(
          this.#schedulerDeliverySeq,
          snapshot.commitSeq,
        );
      }
    }
    return result;
  }

  writersForTargets(
    query: SchedulerWritersForTargetsQuery,
  ): Promise<SchedulerWritersForTargetsResult> {
    return this.session.writersForTargets({
      ...query,
      branch: this.branch,
    });
  }

  watchAddSync(watches: WatchSpec[]): Promise<{
    view: MemoryClient.WatchView;
    sync: SessionSync;
  }> {
    let result!: { view: MemoryClient.WatchView; sync: SessionSync };
    this.#mutation = this.#mutation.then(async () => {
      if (this.#closed) throw new Error("executor provider session closed");
      for (const watch of watches) this.#watches.set(watch.id, watch);
      const fromSeq = this.#appliedSeq;
      await this.refreshWatches(watches.map((watch) => watch.id));
      const sync = this.fullSync(fromSeq, this.#appliedSeq);
      if (this.#view === null) {
        this.#view = MemoryClient.WatchView.fromSync(sync);
      } else {
        this.#view.applySync(sync, false);
      }
      result = { view: this.#view, sync };
    });
    return this.#mutation.then(() => result);
  }

  private async refreshAcceptedCommit(
    notice: AcceptedCommitNotice,
  ): Promise<boolean> {
    if (
      this.#closed || notice.space !== this.session.space ||
      notice.branch !== this.branch || notice.order <= this.#acceptedOrder
    ) {
      return false;
    }
    const fromSeq = this.#appliedSeq;
    let observations: SchedulerActionSnapshotResult[] = [];
    if (
      notice.originSessionId !== this.sessionId &&
      notice.schedulerUpdateIds.length > 0
    ) {
      try {
        observations = await this.adoptionObservations(
          notice.deliverySeq,
          new Set(notice.schedulerUpdateIds),
        );
      } catch (error) {
        // Scheduler adoption is optional. Keep its cursor unchanged and still
        // deliver the required document invalidation for this accepted commit.
        console.warn("executor scheduler adoption failed", error);
      }
    }
    if (this.#watches.size === 0) {
      this.#acceptedOrder = notice.order;
      this.#appliedSeq = Math.max(this.#appliedSeq, notice.dataSeq);
      return true;
    }
    const dirty = new Set(notice.revisions.map(dirtyEntityKey));
    const affected: string[] = [];
    for (const [watchId, watch] of this.#watches) {
      const previous = this.#watchEntities.get(watchId);
      const rootDirty = watch.query.roots.some((root) =>
        dirty.has(dirtyEntityKey({
          id: root.id,
          scope: root.scope,
        }))
      );
      const trackedDirty = previous !== undefined &&
        [...previous.values()].some((snapshot) =>
          dirty.has(dirtyEntityKey(snapshot))
        );
      if (rootDirty || trackedDirty) affected.push(watchId);
    }
    if (notice.dataSeq <= this.#appliedSeq || affected.length === 0) {
      this.#acceptedOrder = notice.order;
      this.#appliedSeq = Math.max(this.#appliedSeq, notice.dataSeq);
      if (observations.length > 0) {
        this.#view?.applySync({
          type: "sync",
          fromSeq,
          toSeq: this.#appliedSeq,
          upserts: [],
          removes: [],
          observations,
        }, true);
        // WatchView delivery resumes the replica's async iterator in a queued
        // microtask. Cross that hand-off before reporting integration.
        await Promise.resolve();
      }
      return true;
    }

    const before = this.allEntities();
    await this.refreshWatches(affected, notice.dataSeq);
    this.#acceptedOrder = notice.order;
    this.#appliedSeq = Math.max(this.#appliedSeq, notice.dataSeq);
    const after = this.allEntities();
    const sync: SessionSync = {
      type: "sync",
      fromSeq,
      toSeq: this.#appliedSeq,
      upserts: [...after.values()].map(syncUpsert),
      removes: [...before.values()]
        .filter((snapshot) => !after.has(snapshotKey(snapshot)))
        .map((snapshot) => ({
          branch: snapshot.branch,
          id: snapshot.id,
          ...(snapshot.scope !== undefined ? { scope: snapshot.scope } : {}),
        })),
      ...(observations.length > 0 ? { observations } : {}),
    };
    this.#view?.applySync(sync, true);
    // `applySync(..., true)` resolves the replica consumer's pending iterator;
    // its continuation applies the sync synchronously in the next microtask.
    await Promise.resolve();
    return true;
  }

  private async adoptionObservations(
    throughSeq: number,
    allowedObservationIds: ReadonlySet<number>,
  ): Promise<SchedulerActionSnapshotResult[]> {
    const snapshots: SchedulerActionSnapshotResult[] = [];
    const nextVersions = new Map<number, string>();
    const sinceCommitSeq = throughSeq <= this.#schedulerDeliverySeq
      ? Math.max(-1, throughSeq - 1)
      : this.#schedulerDeliverySeq;
    let cursor: SchedulerActionSnapshotQuery["cursor"];
    do {
      const page = await this.session.listSchedulerActionSnapshots({
        branch: this.branch,
        sinceCommitSeq,
        throughCommitSeq: throughSeq,
        limit: 1_000,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const snapshot of page.snapshots) {
        if (!allowedObservationIds.has(snapshot.observationId)) continue;
        const version = encodeMemoryBoundary(snapshot);
        if (
          this.#seenObservationVersions.get(snapshot.observationId) === version
        ) continue;
        nextVersions.set(snapshot.observationId, version);
        snapshots.push(snapshot);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const [observationId, version] of nextVersions) {
      this.#seenObservationVersions.set(observationId, version);
    }
    this.#schedulerDeliverySeq = Math.max(
      this.#schedulerDeliverySeq,
      throughSeq,
    );
    return snapshots;
  }

  private async refreshWatches(
    watchIds: readonly string[],
    atSeq?: number,
  ): Promise<void> {
    for (const watchId of watchIds) {
      const watch = this.#watches.get(watchId);
      if (watch === undefined) continue;
      const result = await this.queryGraph({
        ...watch.query,
        ...(atSeq !== undefined ? { atSeq } : {}),
      });
      if (atSeq === undefined) {
        this.#appliedSeq = Math.max(this.#appliedSeq, result.serverSeq);
      }
      this.#watchEntities.set(
        watchId,
        new Map(result.entities.map((snapshot) => [
          snapshotKey(snapshot),
          snapshot,
        ])),
      );
    }
  }

  private allEntities(): Map<string, EntitySnapshot> {
    const entities = new Map<string, EntitySnapshot>();
    for (const snapshots of this.#watchEntities.values()) {
      for (const [key, snapshot] of snapshots) {
        const previous = entities.get(key);
        if (previous === undefined || previous.seq <= snapshot.seq) {
          entities.set(key, snapshot);
        }
      }
    }
    return entities;
  }

  private fullSync(fromSeq: number, toSeq: number): SessionSync {
    return {
      type: "sync",
      fromSeq,
      toSeq,
      upserts: [...this.allEntities().values()].map(syncUpsert),
      removes: [],
    };
  }
}

class HostSessionFactory implements SessionFactory {
  #session: HostReplicaSession | null = null;

  constructor(
    private readonly port: MessagePort,
    private readonly space: MemorySpace,
    private readonly branch: BranchName,
    private readonly protocolFlags?: Partial<WireMemoryProtocolFlags>,
    private readonly onAcceptedCommitIntegrated?: (
      notice: AcceptedCommitNotice,
    ) => void,
  ) {}

  acceptedCommitsSettled(): Promise<number> {
    return this.#session?.acceptedCommitsSettled() ?? Promise.resolve(0);
  }

  async create(
    space: MemorySpace,
    _signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (space !== this.space) {
      throw new Error(`executor provider is bound to ${this.space}`);
    }
    const transport = new MessagePortTransport(this.port);
    const client = await MemoryClient.connect({
      transport,
      ...(this.protocolFlags ? { protocolFlags: this.protocolFlags } : {}),
    });
    // This transferred channel is a lease-bound one-shot transport, not a
    // reconnectable network endpoint. A host close is terminal: close the
    // client so pending requests reject without starting the generic memory
    // client's reconnect loop against an already-disposed MessagePort.
    transport.setCloseReceiver(() => {
      void client.close().catch(() => undefined);
    });
    const session = await client.mount(space, mountOptions);
    const replica = new HostReplicaSession(
      session,
      transport,
      this.branch,
      this.onAcceptedCommitIntegrated,
    );
    this.#session = replica;
    return {
      client,
      session: replica,
    };
  }
}

const opaquePrincipal = (principal: MemorySpace): Signer => {
  const unavailable = () => ({
    error: new Error("executor provider principal has no Worker signing key"),
  });
  return {
    did: () => principal,
    sign: unavailable,
    verifier: {
      did: () => principal,
      verify: unavailable,
    },
  } as Signer;
};

export interface HostStorageManagerOptions {
  port: MessagePort;
  principal: MemorySpace;
  space: MemorySpace;
  branch?: BranchName;
  id?: string;
  settings?: Options["settings"];
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
  /** Keep executor-derived writes inside the Worker replica for shadow graph
   * discovery. No transaction or scheduler operation reaches the host. */
  shadowWrites?: boolean;
  /** Worker-local whole-action routing. The host still validates every
   * asserted upstream transaction against its live lease and claim. */
  actionTransactionRouter?: ActionTransactionRouter;
  /** Runs synchronously after an accepted host commit has been point-refreshed
   * and applied to the Worker replica. */
  onAcceptedCommitIntegrated?: (notice: AcceptedCommitNotice) => void;
}

/** StorageManager construction available inside the executor Worker. */
export class HostStorageManager extends StorageManager {
  readonly #hostSessionFactory: HostSessionFactory;

  private constructor(options: Options, factory: HostSessionFactory) {
    super(options, factory);
    this.#hostSessionFactory = factory;
  }

  static connect(options: HostStorageManagerOptions): HostStorageManager {
    const as = opaquePrincipal(options.principal);
    const factory = new HostSessionFactory(
      options.port,
      options.space,
      options.branch ?? "",
      options.protocolFlags,
      options.onAcceptedCommitIntegrated,
    );
    return new HostStorageManager(
      {
        as,
        id: options.id,
        settings: options.settings,
        shadowWrites: options.shadowWrites,
        actionTransactionRouter: options.actionTransactionRouter,
        // The host channel is already pinned to the memory Server.
        memoryHost: new URL("memory://executor-provider"),
      },
      factory,
    );
  }

  /** Drain the host-pushed accepted-commit queue and return the last data seq
   * applied to this Worker replica. */
  acceptedCommitsSettled(): Promise<number> {
    return this.#hostSessionFactory.acceptedCommitsSettled();
  }
}
