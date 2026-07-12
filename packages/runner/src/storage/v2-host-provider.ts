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
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type AcceptedCommitEvent,
  parseClientMessage,
  type Server,
} from "@commonfabric/memory/v2/server";
import type { BranchName } from "@commonfabric/memory/v2";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";
import type { ReplicaSession } from "./v2-replica-session.ts";

interface AcceptedCommitNotice {
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
}

type ProviderPortMessage =
  | { type: "memory"; payload: string }
  | { type: "accepted-commit"; notice: AcceptedCommitNotice }
  | { type: "close"; message?: string };

export interface HostProviderChannelOptions {
  server: Server;
  space: MemorySpace;
  branch?: BranchName;
  /** Host-owned grant creation. This callback and its credentials never cross
   *  the MessagePort into the Worker. */
  authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory;
}

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

const toAcceptedCommitNotice = (
  event: AcceptedCommitEvent,
): AcceptedCommitNotice => ({
  space: event.space,
  branch: event.commit.branch,
  order: event.order,
  dataSeq: event.commit.seq,
  deliverySeq: event.deliverySeq,
  ...(event.originSessionId !== undefined
    ? { originSessionId: event.originSessionId }
    : {}),
  revisions: event.commit.revisions.map((revision) => ({
    branch: revision.branch,
    id: revision.id,
    ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
    seq: revision.seq,
  })),
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
 * overwrites session.open authorization with its own grant callback.
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

  const closeHost = (message?: string) => {
    if (disposed) return;
    disposed = true;
    unsubscribeAcceptedCommits();
    connection.close();
    if (message !== undefined) {
      try {
        hostPort.postMessage(
          { type: "close", message } satisfies ProviderPortMessage,
        );
      } catch {
        // The Worker may already have closed its transferred endpoint.
      }
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
    if (parsed.type === "session.open") {
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
      if (disposed || event.commit.branch !== branch) return;
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
  #seenObservationIds = new Set<number>();
  #closed = false;

  constructor(
    private readonly session: MemoryClient.SpaceSession,
    transport: MessagePortTransport,
    private readonly branch: BranchName,
  ) {
    this.#appliedSeq = session.serverSeq;
    this.#schedulerDeliverySeq = session.serverSeq;
    transport.setAcceptedCommitReceiver((notice) => {
      const refresh = this.#mutation.then(
        () => this.refreshAcceptedCommit(notice),
        () => this.refreshAcceptedCommit(notice),
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
      this.#seenObservationIds.add(snapshot.observationId);
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
  ): Promise<void> {
    if (
      this.#closed || notice.space !== this.session.space ||
      notice.branch !== this.branch || notice.order <= this.#acceptedOrder
    ) {
      return;
    }
    const fromSeq = this.#appliedSeq;
    const observations = notice.originSessionId === this.sessionId
      ? []
      : await this.adoptionObservations(notice.deliverySeq);
    if (this.#watches.size === 0) {
      this.#acceptedOrder = notice.order;
      this.#appliedSeq = Math.max(this.#appliedSeq, notice.dataSeq);
      return;
    }
    const dirty = new Set(notice.revisions.map(snapshotKey));
    const affected: string[] = [];
    for (const [watchId, watch] of this.#watches) {
      const previous = this.#watchEntities.get(watchId);
      const rootDirty = watch.query.roots.some((root) =>
        dirty.has(snapshotKey({
          branch: this.branch,
          id: root.id,
          scope: root.scope,
        }))
      );
      const trackedDirty = previous !== undefined &&
        [...previous.keys()].some((key) => dirty.has(key));
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
      }
      return;
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
  }

  private async adoptionObservations(
    throughSeq: number,
  ): Promise<SchedulerActionSnapshotResult[]> {
    const snapshots: SchedulerActionSnapshotResult[] = [];
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
        if (this.#seenObservationIds.has(snapshot.observationId)) continue;
        this.#seenObservationIds.add(snapshot.observationId);
        snapshots.push(snapshot);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
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
  constructor(
    private readonly port: MessagePort,
    private readonly space: MemorySpace,
    private readonly branch: BranchName,
  ) {}

  async create(
    space: MemorySpace,
    _signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (space !== this.space) {
      throw new Error(`executor provider is bound to ${this.space}`);
    }
    const transport = new MessagePortTransport(this.port);
    const client = await MemoryClient.connect({ transport });
    const session = await client.mount(space, mountOptions);
    return {
      client,
      session: new HostReplicaSession(session, transport, this.branch),
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
}

/** StorageManager construction available inside the executor Worker. */
export class HostStorageManager extends StorageManager {
  static connect(options: HostStorageManagerOptions): HostStorageManager {
    const as = opaquePrincipal(options.principal);
    return new HostStorageManager(
      {
        as,
        id: options.id,
        settings: options.settings,
        // The host channel is already pinned to the memory Server.
        memoryHost: new URL("memory://executor-provider"),
      },
      new HostSessionFactory(
        options.port,
        options.space,
        options.branch ?? "",
      ),
    );
  }
}
