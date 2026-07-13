import {
  actionClaimMapKey,
  type ActionSettlement,
  type ClientCommit,
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntitySnapshot,
  type ExecutionClaim,
  type ExecutionControlEvent,
  type ExecutionDemandSetResult,
  getMemoryProtocolFlags,
  getPersistentSchedulerStateConfig,
  type GraphQuery,
  type GraphQueryResult,
  type LegacyBackgroundExclusion,
  type LegacyBackgroundExclusionReleaseResult,
  type LegacyBackgroundExclusionStatus,
  type LegacyBackgroundExclusionStatusResult,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerSnapshotListResult,
  type SchedulerWritersForTargetsQuery,
  type SchedulerWritersForTargetsResult,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenChallenge,
  type SessionOpenResult,
  type SessionRevokedMessage,
  type SessionSync,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  type WatchAddResult,
  type WatchSetResult,
  type WatchSpec,
  type WireMemoryProtocolFlags,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import type { Server } from "./server.ts";
import type { AppliedCommit } from "./engine.ts";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { expandServerMessageSchemas } from "./sync-schema-table.ts";

export interface Transport {
  send(payload: string): Promise<void>;
  close(): Promise<void>;
  setReceiver(receiver: (payload: string) => void): void;
  setCloseReceiver?(receiver: (error?: Error) => void): void;
}

export interface ConnectOptions {
  transport: Transport;
  /** Optional per-client capability override, primarily for skew tests and
   *  hosts whose client and server runtimes use different rollout settings. */
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
}

export interface MountOptions {
  sessionId?: string;
  seenSeq?: number;
  executionFeedSeq?: number;
  sessionToken?: string;
}

export interface SessionOpenAuth {
  invocation: Record<string, unknown>;
  authorization: unknown;
}

export interface SessionOpenAuthContext {
  challenge: SessionOpenChallenge;
  audience: string;
}

export type SessionOpenAuthFactory = (
  space: string,
  session: MountOptions,
  context: SessionOpenAuthContext,
) => Promise<SessionOpenAuth | undefined> | SessionOpenAuth | undefined;

export interface WatchMutationResult {
  view: WatchView;
  sync: SessionSync;
}

const RECONNECT_BASE_DELAY_MS = 25;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

const reconnectDelayMs = (attempt: number): number => {
  const baseDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** attempt,
  );
  return Math.min(
    RECONNECT_MAX_DELAY_MS,
    Math.floor(baseDelay * (1 + Math.random() * RECONNECT_JITTER_RATIO)),
  );
};

const watchKey = (
  branch: string,
  id: string,
  scope: string | undefined,
): string => `${branch}\0${scope ?? "space"}\0${id}`;

const compareEntitySnapshot = (
  left: EntitySnapshot,
  right: EntitySnapshot,
): number =>
  left.branch.localeCompare(right.branch) ||
  (left.scope ?? "space").localeCompare(right.scope ?? "space") ||
  left.id.localeCompare(right.id);

type SessionRestoreResult = "restored" | "fresh-connection-required";

export class Client {
  #pending = new Map<string, PromiseWithResolvers<unknown>>();
  #spaces = new Set<SpaceSession>();
  #nextRequest = 1;
  #helloPending: PromiseWithResolvers<void> | null = null;
  #sessionOpenAuthContext: SessionOpenAuthContext | null = null;
  #serverFlags: MemoryProtocolFlags | null = null;
  #advertisedFlags: MemoryProtocolFlags | null = null;
  #reconnecting: Promise<void> | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #connected = false;
  #closed = false;

  private constructor(
    private readonly transport: Transport,
    private readonly protocolFlags?: Partial<WireMemoryProtocolFlags>,
  ) {
    this.transport.setReceiver((payload) => this.onMessage(payload));
    this.transport.setCloseReceiver?.((error) => this.onClose(error));
  }

  static async connect(options: ConnectOptions): Promise<Client> {
    const client = new Client(options.transport, options.protocolFlags);
    await client.hello();
    return client;
  }

  /** The flags the SERVER advertised in its `hello.ok` (null before the first
   *  handshake). Capability keys an old server never sent parse to `false`, so
   *  optional-capability consumers fail closed by reading this. */
  get serverFlags(): MemoryProtocolFlags | null {
    return this.#serverFlags;
  }

  get serverPrimaryExecutionV1(): boolean {
    return this.#advertisedFlags?.serverPrimaryExecutionV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionV1 === true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
    this.#cancelReconnectDelay?.();
    this.rejectPending(new Error("memory client closed"));
    await Promise.all([...this.#spaces].map((space) => space.close()));
    this.#spaces.clear();
    await this.transport.close();
    await this.#reconnecting?.catch(() => undefined);
  }

  async mount(
    space: string,
    options: MountOptions = {},
    openAuthFactory?: SessionOpenAuthFactory,
  ): Promise<SpaceSession> {
    const auth = await openAuthFactory?.(
      space,
      options,
      this.sessionOpenAuthContext(),
    );
    const result = await this.openSession(space, options, auth);
    const session = new SpaceSession(
      this,
      space,
      result.sessionId,
      result.sessionToken,
      result.serverSeq,
      openAuthFactory,
    );
    if (result.sync !== undefined) {
      session.initializeSync(result.sync);
    }
    this.#spaces.add(session);
    return session;
  }

  forgetSession(session: SpaceSession): void {
    this.#spaces.delete(session);
  }

  async request<Result>(message: Record<string, unknown>): Promise<Result> {
    await this.ensureConnected();
    return await this.requestConnected(message);
  }

  /**
   * Dispatch only when the active connection advertises the capability.
   * Checking after ensureConnected keeps a reconnect from carrying a cached
   * capable-server decision onto an older peer.
   */
  async requestIfServerSupports<Result>(
    capability: keyof MemoryProtocolFlags,
    message: Record<string, unknown>,
  ): Promise<Result | undefined> {
    await this.ensureConnected();
    if (
      this.#advertisedFlags?.[capability] !== true ||
      this.#serverFlags?.[capability] !== true
    ) {
      return undefined;
    }
    return await this.requestConnected(message);
  }

  private async requestConnected<Result>(
    message: Record<string, unknown>,
  ): Promise<Result> {
    const requestId = message.requestId as string;
    const pending = Promise.withResolvers<unknown>();
    this.#pending.set(requestId, pending);
    await this.transport.send(encodeMemoryBoundary(message));
    const result = await pending.promise as ResponseMessage<Result>;
    if (result.error) {
      const error = new Error(result.error.message);
      error.name = result.error.name;
      if (result.error.precondition !== undefined) {
        (error as Error & { precondition?: string }).precondition =
          result.error.precondition;
      }
      if (result.error.retryAfterSeq !== undefined) {
        (error as Error & { retryAfterSeq?: number }).retryAfterSeq =
          result.error.retryAfterSeq;
      }
      if (result.error.diagnosticCode !== undefined) {
        (error as Error & { diagnosticCode?: string }).diagnosticCode =
          result.error.diagnosticCode;
      }
      throw error;
    }
    return result.ok as Result;
  }

  async openSession(
    space: string,
    session: MountOptions,
    auth?: SessionOpenAuth,
  ): Promise<SessionOpenResult> {
    const result = await this.request<SessionOpenResult>({
      type: "session.open",
      requestId: this.nextRequestId(),
      space,
      session,
      ...(auth ? auth : {}),
    });
    this.updateSessionOpenAuthContext(result.sessionOpen);
    return result;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  sessionOpenAuthContext(): SessionOpenAuthContext {
    if (this.#sessionOpenAuthContext === null) {
      const error = new Error(
        "memory server did not provide session.open authentication metadata",
      );
      error.name = "ProtocolError";
      throw error;
    }
    return this.#sessionOpenAuthContext;
  }

  private updateSessionOpenAuthContext(sessionOpen: unknown): void {
    this.#sessionOpenAuthContext = requireSessionOpenAuthMetadata(sessionOpen);
  }

  async restoreConnection(): Promise<void> {
    await this.ensureConnected();
  }

  private async hello(): Promise<void> {
    const ack = Promise.withResolvers<void>();
    this.#helloPending = ack;
    const flags = parseMemoryProtocolFlags({
      ...wireMemoryProtocolFlags(getMemoryProtocolFlags()),
      ...this.protocolFlags,
    });
    if (flags === null) {
      throw protocolError("memory client protocol flags are malformed");
    }
    this.#advertisedFlags = flags;
    await this.transport.send(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: wireMemoryProtocolFlags(flags),
    }));
    try {
      await ack.promise;
      this.#connected = true;
    } finally {
      this.#helloPending = null;
    }
  }

  private onMessage(payload: string): void {
    let message: unknown;
    try {
      message = decodeMemoryBoundary(payload);
      message = expandServerMessageSchemas(message);
    } catch (cause) {
      const error = new Error("Unable to parse memory server message", {
        cause,
      });
      error.name = "InvalidMessageError";
      if (this.#helloPending !== null) {
        this.#helloPending.reject(error);
      } else {
        this.rejectPending(error);
      }
      return;
    }

    if (this.#helloPending !== null) {
      const helloOk = parseHelloOk(message);
      if (helloOk !== null) {
        const expectedFlags = parseMemoryProtocolFlags({
          ...wireMemoryProtocolFlags(getMemoryProtocolFlags()),
          ...this.protocolFlags,
        })!;
        if (!compatibleMemoryProtocolFlags(helloOk.flags, expectedFlags)) {
          const error = new Error(
            `memory flag mismatch: client=${
              toCompactDebugString(expectedFlags)
            } server=${toCompactDebugString(helloOk.flags)}`,
          );
          error.name = "ProtocolError";
          this.#helloPending.reject(error);
          return;
        }
        // The server's advertised flags (refreshed per hello, so a reconnect
        // to a different server version updates them). Optional-capability
        // consumers (e.g. the runner's sqlite write-gate relaxation) read
        // these; absent-on-old-server keys parse to false — fail closed.
        this.#serverFlags = helloOk.flags;
        try {
          this.#sessionOpenAuthContext = requireSessionOpenAuthMetadata(
            helloOk.sessionOpen,
          );
        } catch (error) {
          this.#helloPending.reject(
            error instanceof Error ? error : protocolError(String(error)),
          );
          return;
        }
        this.#helloPending.resolve();
        return;
      }

      if (isResponse(message) && message.requestId === "handshake") {
        if (message.error) {
          const error = new Error(message.error.message);
          error.name = message.error.name;
          this.#helloPending.reject(error);
        } else {
          const error = new Error("memory handshake failed");
          error.name = "ProtocolError";
          this.#helloPending.reject(error);
        }
        return;
      }

      const error = new Error("memory handshake expected hello.ok");
      error.name = "ProtocolError";
      this.#helloPending.reject(error);
      return;
    }

    if (isSessionEffect(message)) {
      for (const session of this.#spaces) {
        if (
          session.sessionId === message.sessionId &&
          session.space === message.space
        ) {
          session.handleEffect(message.effect);
        }
      }
      return;
    }
    if (isSessionRevoked(message)) {
      for (const session of this.#spaces) {
        if (
          session.sessionId === message.sessionId &&
          session.space === message.space
        ) {
          session.handleRevoked(message.reason);
        }
      }
      return;
    }
    if (isResponse(message)) {
      const pending = this.#pending.get(message.requestId);
      if (pending) {
        pending.resolve(message);
        this.#pending.delete(message.requestId);
      }
    }
  }

  private nextRequestId(): string {
    return `req:${this.#nextRequest++}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory client is closed");
    }
    if (this.#connected) {
      return;
    }
    await this.reconnect();
  }

  private onClose(error?: Error): void {
    if (this.#closed) {
      return;
    }
    this.#connected = false;
    for (const session of this.#spaces) {
      session.handleDisconnect();
    }
    this.rejectPending(toConnectionError(error));
    void this.reconnect().catch(() => undefined);
  }

  private async reconnect(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory client is closed");
    }
    if (this.#reconnecting) {
      return await this.#reconnecting;
    }
    this.#reconnecting = (async () => {
      let attempt = 0;
      while (!this.#closed) {
        try {
          await this.hello();
          let needsFreshSessionOpenChallenge = false;
          for (const session of this.#spaces) {
            if (await session.restore() === "fresh-connection-required") {
              needsFreshSessionOpenChallenge = true;
              break;
            }
          }
          if (needsFreshSessionOpenChallenge) {
            // session.open authentication challenges are single-use, including
            // when the server rejects the open. Rotate the physical connection
            // after terminalizing that one session so unrelated spaces reopen
            // with a fresh challenge instead of failing authentication too.
            this.#connected = false;
            for (const session of this.#spaces) {
              session.handleDisconnect();
            }
            await this.transport.close();
            continue;
          }
          return;
        } catch (error) {
          this.#connected = false;
          this.rejectPending(
            error instanceof Error ? error : new Error(String(error)),
          );
          await this.waitForReconnectDelay(reconnectDelayMs(attempt));
          attempt += 1;
        }
      }
    })();

    try {
      await this.#reconnecting;
    } finally {
      this.#reconnecting = null;
    }
  }

  // The reconnect attempt is event-driven: `hello()` awaits the transport's
  // real open/error/close. The pause between a failed attempt and the next
  // runs on a timer, since a returning server raises no event to await. The
  // delay bounds the retry rate, and `close()` ends it through the stored
  // canceller.
  private waitForReconnectDelay(delayMs: number): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#cancelReconnectDelay = null;
        resolve();
      }, delayMs);
      this.#cancelReconnectDelay = () => {
        clearTimeout(timer);
        this.#cancelReconnectDelay = null;
        resolve();
      };
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#helloPending?.reject(error);
    this.#helloPending = null;
  }
}

export class SpaceSession {
  #outstandingCommits = new Map<number, {
    commit: ClientCommit;
    pending: PromiseWithResolvers<AppliedCommit>;
  }>();
  #watchSpecs: WatchSpec[] = [];
  #watchView: WatchView | null = null;
  #sessionId: string;
  #sessionToken: string | undefined;
  #serverSeq: number;
  #ackedSeq = 0;
  #ackedExecutionFeedSeq = 0;
  #pendingAckSeq = 0;
  #pendingAckExecutionFeedSeq = 0;
  #ackScheduled = false;
  #ackFlushing = false;
  #background = new Set<Promise<void>>();
  #watchMutation: Promise<void> = Promise.resolve();
  #closed = false;
  #closeError: Error | null = null;
  #readyOnConnection = true;
  #restoring = false;
  #caughtUpLocalSeq = 0;
  // Highest caughtUpLocalSeq already pushed into the WatchView (via a real sync
  // or a synthetic forward). Subscribers such as runner storage only advance
  // their own caught-up seq from emitted syncs, so a resume that promotes
  // caughtUpLocalSeq via the top-level SessionOpenResult field (no sync) must
  // be forwarded explicitly or their conflict-retry waiters strand.
  #forwardedCaughtUpLocalSeq = 0;
  #caughtUpLocalSeqWaiters: {
    localSeq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];
  #executionDemands = new Map<string, readonly string[]>();
  #executionFeedSeq = 0;
  #executionDataSeq = 0;
  #executionClaims = new Map<string, ExecutionClaim>();
  #executionControlListeners = new Set<
    (event: ExecutionControlEvent) => void
  >();
  #pendingSettlements: ActionSettlement[] = [];

  constructor(
    private readonly client: Client,
    readonly space: string,
    sessionId: string,
    sessionToken: string | undefined,
    serverSeq: number,
    private readonly openAuthFactory?: SessionOpenAuthFactory,
  ) {
    this.#sessionId = sessionId;
    this.#sessionToken = sessionToken;
    this.#serverSeq = serverSeq;
    this.#ackedSeq = serverSeq;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get sessionToken(): string | undefined {
    return this.#sessionToken;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  get executionClaims(): readonly ExecutionClaim[] {
    return Object.freeze(
      [...this.#executionClaims.values()].sort((left, right) =>
        left.branch.localeCompare(right.branch) ||
        actionClaimMapKey(left).localeCompare(actionClaimMapKey(right))
      ),
    );
  }

  get executionFeedSeq(): number {
    return this.#executionFeedSeq;
  }

  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void {
    this.#executionControlListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#executionControlListeners.delete(listener);
    };
  }

  /**
   * Called by the replica after it has applied an accepted local commit. The
   * transact response alone is not sufficient: resolving it precedes
   * SpaceReplica.confirmPending(), while settlement must never clear an
   * overlay before that data application barrier.
   */
  noteAppliedCommit(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError("applied commit sequence must be non-negative");
    }
    this.#executionDataSeq = Math.max(this.#executionDataSeq, seq);
    this.#flushPendingSettlements();
  }

  initializeSync(sync: SessionSync): void {
    this.noteResult(sync.toSeq);
    this.#executionDataSeq = Math.max(this.#executionDataSeq, sync.toSeq);
    this.#applyExecution(sync);
    this.scheduleAck(sync.toSeq, sync.execution?.toFeedSeq);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#closeError ?? new Error("memory session closed");
    }
  }

  async transact(commit: ClientCommit): Promise<AppliedCommit> {
    this.#assertOpen();
    const existing = this.#outstandingCommits.get(commit.localSeq);
    if (existing) {
      return await existing.pending.promise;
    }

    const pending = Promise.withResolvers<AppliedCommit>();
    this.#outstandingCommits.set(commit.localSeq, {
      commit,
      pending,
    });

    const outstanding = this.#outstandingCommits.get(commit.localSeq);
    if (
      outstanding !== undefined &&
      this.client.isConnected() &&
      this.#readyOnConnection &&
      !this.#restoring
    ) {
      this.sendOutstandingCommit(commit.localSeq, outstanding);
    } else {
      void this.client.restoreConnection();
    }

    return await pending.promise;
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    this.#assertOpen();
    const result = await this.client.request<GraphQueryResult>({
      type: "graph.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      query,
    });

    this.noteResult(result.serverSeq);
    return result;
  }

  /** Run a server-side read-only SQLite query against a cell-derived db. */
  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<SqliteQueryResult> {
    this.#assertOpen();
    return await this.client.request<SqliteQueryResult>({
      type: "sqlite.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      db,
      sql,
      params,
    });
  }

  // No `sqliteExecute` write RPC: writes go through the commit fold (a `sqlite`
  // op inside `transact`), applied atomically with cell ops — never a standalone
  // non-atomic write request.

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). After
   * this, server-side reads for `id` resolve against the on-disk file at `path`
   * (attached read-only) instead of the cell-derived db; writes are rejected.
   */
  async registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    this.#assertOpen();
    return await this.client.request<SqliteRegisterDiskSourceResult>({
      type: "sqlite.register-disk-source",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      id,
      path,
    });
  }

  async listSchedulerActionSnapshots(
    query: SchedulerActionSnapshotQuery = {},
  ): Promise<SchedulerSnapshotListResult> {
    this.#assertOpen();
    if (!getPersistentSchedulerStateConfig()) {
      return { serverSeq: this.#serverSeq, snapshots: [] };
    }
    const result = await this.client.request<SchedulerSnapshotListResult>({
      type: "scheduler.snapshot.list",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      query,
    });

    this.noteResult(result.serverSeq);
    return result;
  }

  async writersForTargets(
    query: SchedulerWritersForTargetsQuery,
  ): Promise<SchedulerWritersForTargetsResult> {
    this.#assertOpen();
    if (!getPersistentSchedulerStateConfig()) {
      return { serverSeq: this.#serverSeq, writers: [] };
    }
    const result = await this.client
      .requestIfServerSupports<SchedulerWritersForTargetsResult>(
        "schedulerWriterLookup",
        {
          type: "scheduler.writer.list",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          query,
        },
      );
    if (result === undefined) {
      return { serverSeq: this.#serverSeq, writers: [] };
    }

    this.noteResult(result.serverSeq);
    return result;
  }

  async setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean> {
    this.#assertOpen();
    const result = await this.client
      .requestIfServerSupports<ExecutionDemandSetResult>(
        "serverPrimaryExecutionV1",
        {
          type: "session.execution.demand.set",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          branch,
          pieces: [...pieces],
        },
      );
    if (result === undefined) return false;
    this.noteResult(result.serverSeq);
    if (pieces.length === 0) {
      this.#executionDemands.delete(branch);
    } else {
      this.#executionDemands.set(branch, Object.freeze([...pieces]));
    }
    return true;
  }

  async acquireLegacyBackgroundExclusion(
    branch: string,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    this.#assertOpen();
    const result = await this.client.requestIfServerSupports<
      LegacyBackgroundExclusionStatusResult
    >("serverPrimaryExecutionV1", {
      type: "session.execution.legacy-background.acquire",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      branch,
    });
    if (result === undefined) return undefined;
    this.noteResult(result.serverSeq);
    return result.status;
  }

  async renewLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusionStatus | null | undefined> {
    this.#assertOpen();
    const result = await this.client.requestIfServerSupports<
      LegacyBackgroundExclusionStatusResult
    >("serverPrimaryExecutionV1", {
      type: "session.execution.legacy-background.renew",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      branch,
      exclusionGeneration,
    });
    if (result === undefined) return undefined;
    this.noteResult(result.serverSeq);
    return result.status;
  }

  async releaseLegacyBackgroundExclusion(
    branch: string,
    exclusionGeneration: number,
  ): Promise<LegacyBackgroundExclusion | null | undefined> {
    this.#assertOpen();
    const result = await this.client.requestIfServerSupports<
      LegacyBackgroundExclusionReleaseResult
    >("serverPrimaryExecutionV1", {
      type: "session.execution.legacy-background.release",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      branch,
      exclusionGeneration,
    });
    if (result === undefined) return undefined;
    this.noteResult(result.serverSeq);
    return result.released;
  }

  async watchSet(watches: WatchSpec[]): Promise<WatchView> {
    this.#assertOpen();
    const hadView = this.#watchView !== null;
    const result = await this.watchSetSync(watches);
    if (hadView && !isEmptySync(result.sync)) {
      result.view.emit(result.sync);
    }
    return result.view;
  }

  async watchSetSync(watches: WatchSpec[]): Promise<WatchMutationResult> {
    this.#assertOpen();
    return await this.runWatchMutation(async () => {
      const result = await this.client.request<WatchSetResult>({
        type: "session.watch.set",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        watches,
      });
      this.noteResult(result.serverSeq);
      this.#watchSpecs = watches;
      if (this.#watchView === null) {
        this.#watchView = WatchView.fromSync(result.sync);
      } else {
        this.#watchView.applySync(result.sync, false);
      }
      this.#executionDataSeq = Math.max(
        this.#executionDataSeq,
        result.sync.toSeq,
      );
      this.#applyExecution(result.sync);
      this.scheduleAck(result.serverSeq, result.sync.execution?.toFeedSeq);
      return {
        view: this.#watchView,
        sync: result.sync,
      };
    });
  }

  async watchAdd(watches: WatchSpec[]): Promise<WatchView> {
    this.#assertOpen();
    const hadView = this.#watchView !== null;
    const result = await this.watchAddSync(watches);
    if (hadView && !isEmptySync(result.sync)) {
      result.view.emit(result.sync);
    }
    return result.view;
  }

  async watchAddSync(watches: WatchSpec[]): Promise<WatchMutationResult> {
    this.#assertOpen();
    return await this.runWatchMutation(async () => {
      const result = await this.client.request<WatchAddResult>({
        type: "session.watch.add",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        watches,
      });
      this.noteResult(result.serverSeq);
      this.#watchSpecs = [
        ...new Map(
          [...this.#watchSpecs, ...watches].map((watch) => [watch.id, watch]),
        ).values(),
      ];
      if (this.#watchView === null) {
        this.#watchView = WatchView.fromSync(result.sync);
      } else {
        this.#watchView.applySync(result.sync, false);
      }
      this.#executionDataSeq = Math.max(
        this.#executionDataSeq,
        result.sync.toSeq,
      );
      this.#applyExecution(result.sync);
      this.scheduleAck(result.serverSeq, result.sync.execution?.toFeedSeq);
      return {
        view: this.#watchView,
        sync: result.sync,
      };
    });
  }

  async ack(seenSeq: number): Promise<void> {
    if (this.#closed) {
      return;
    }
    const executionFeedSeq = this.#executionFeedSeq;
    if (
      !this.client.isConnected() ||
      (seenSeq <= this.#ackedSeq &&
        executionFeedSeq <= this.#ackedExecutionFeedSeq)
    ) {
      this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
      this.#ackedExecutionFeedSeq = Math.max(
        this.#ackedExecutionFeedSeq,
        executionFeedSeq,
      );
      return;
    }
    await this.client.request({
      type: "session.ack",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      seenSeq,
      executionFeedSeq,
    });
    this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
    this.#ackedExecutionFeedSeq = Math.max(
      this.#ackedExecutionFeedSeq,
      executionFeedSeq,
    );
  }

  handleEffect(effect: SessionSync): void {
    if (this.#closed) {
      return;
    }
    this.noteResult(effect.toSeq);
    if (this.#watchView === null) {
      this.#watchView = WatchView.fromSync(effect);
    } else {
      this.#watchView.applySync(effect, true);
    }
    this.#executionDataSeq = Math.max(this.#executionDataSeq, effect.toSeq);
    this.#applyExecution(effect);
    this.scheduleAck(effect.toSeq, effect.execution?.toFeedSeq);
    this.noteCaughtUpLocalSeq(effect.caughtUpLocalSeq);
  }

  async restore(): Promise<SessionRestoreResult> {
    if (this.#closed) {
      return "restored";
    }
    this.#restoring = true;
    this.#readyOnConnection = false;
    let replayedThroughLocalSeq = 0;
    try {
      let restored: SessionOpenResult;
      try {
        restored = await this.reopen();
      } catch (error) {
        if (isSessionRevokedError(error)) {
          this.handleRevoked("taken-over");
          return "fresh-connection-required";
        }
        if (isProtocolError(error)) {
          this.terminate(error);
          return "fresh-connection-required";
        }
        throw error;
      }
      if (this.#closed) {
        return "restored";
      }
      this.#readyOnConnection = true;
      replayedThroughLocalSeq = Math.max(
        0,
        ...this.#outstandingCommits.keys(),
      );
      if (restored.sync) {
        this.noteCaughtUpLocalSeq(restored.sync.caughtUpLocalSeq);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(restored.sync);
        } else {
          this.#watchView.applySync(restored.sync, false);
        }
        this.#executionDataSeq = Math.max(
          this.#executionDataSeq,
          restored.sync.toSeq,
        );
        this.#applyExecution(restored.sync);
        if (
          !isEmptySync(restored.sync) ||
          restored.sync.caughtUpLocalSeq !== undefined
        ) {
          this.#watchView.emit(restored.sync);
          if (restored.sync.caughtUpLocalSeq !== undefined) {
            this.#forwardedCaughtUpLocalSeq = Math.max(
              this.#forwardedCaughtUpLocalSeq,
              restored.sync.caughtUpLocalSeq,
            );
          }
        }
        this.scheduleAck(
          restored.serverSeq,
          restored.sync.execution?.toFeedSeq,
        );
      } else if (restored.resumed === true && this.#watchSpecs.length > 0) {
        this.scheduleAck(restored.serverSeq);
      }
      this.noteCaughtUpLocalSeq(restored.caughtUpLocalSeq);
      // Forward a top-level-only caught-up marker (resume with no sync) to
      // WatchView subscribers; the guard above suppresses a duplicate when a
      // real sync already carried it.
      this.forwardCaughtUpLocalSeqToWatchers(restored.caughtUpLocalSeq);
      if (restored.resumed !== true && this.#watchSpecs.length > 0) {
        const { view, sync } = await this.watchSetSync(this.#watchSpecs);
        if (!isEmptySync(sync)) {
          view.emit(sync);
        }
      }
      // Demand belongs to the physical connection, not the resumable logical
      // session. Re-establish it after authoritative catch-up and before any
      // retained derived commits are replayed.
      for (const [branch, pieces] of this.#executionDemands) {
        if (!await this.setExecutionDemand(branch, pieces)) break;
      }
      const replayTasks = [...this.#outstandingCommits.entries()].map((
        [localSeq, pendingCommit],
      ) =>
        this.sendOutstandingCommit(localSeq, pendingCommit, {
          throwOnConnectionError: true,
        })
      );
      await Promise.all(replayTasks);
      return "restored";
    } finally {
      this.#restoring = false;
      if (!this.#closed && this.#outstandingCommits.size > 0) {
        this.replayOutstandingCommits(replayedThroughLocalSeq);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (
      this.client.isConnected() && this.#readyOnConnection &&
      this.#executionDemands.size > 0
    ) {
      await Promise.allSettled(
        [...this.#executionDemands.keys()].map((branch) =>
          this.setExecutionDemand(branch, [])
        ),
      );
    }
    this.#closed = true;
    this.#closeError = new Error("memory session closed");
    this.#readyOnConnection = false;
    this.client.forgetSession(this);
    this.rejectCaughtUpLocalSeqWaiters(this.#closeError);
    const background = [...this.#background];
    this.#background.clear();
    await Promise.allSettled(background);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(new Error("memory session closed"));
    }
    this.#outstandingCommits.clear();
    this.#watchSpecs = [];
    this.#executionDemands.clear();
    this.#executionClaims.clear();
    this.#pendingSettlements = [];
    this.#executionControlListeners.clear();
    this.#watchView?.close();
    this.#watchView = null;
  }

  handleRevoked(reason: SessionRevokedMessage["reason"]): void {
    if (this.#closed) {
      return;
    }
    const error = new Error(`memory session revoked: ${reason}`);
    error.name = "SessionRevokedError";
    this.terminate(error);
  }

  private terminate(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeError = error;
    this.#readyOnConnection = false;
    this.client.forgetSession(this);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(error);
    }
    this.rejectCaughtUpLocalSeqWaiters(error);
    this.#outstandingCommits.clear();
    this.#watchSpecs = [];
    this.#executionDemands.clear();
    this.#executionClaims.clear();
    this.#pendingSettlements = [];
    this.#executionControlListeners.clear();
    this.#watchView?.close();
    this.#watchView = null;
  }

  handleDisconnect(): void {
    if (this.#closed) {
      return;
    }
    this.#readyOnConnection = false;
  }

  private queueBackground(task: Promise<void>): void {
    const tracked = task
      .catch(() => undefined)
      .finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  private scheduleAck(seenSeq: number, executionFeedSeq = 0): void {
    if (this.#closed) {
      return;
    }
    this.#pendingAckSeq = Math.max(this.#pendingAckSeq, seenSeq);
    this.#pendingAckExecutionFeedSeq = Math.max(
      this.#pendingAckExecutionFeedSeq,
      executionFeedSeq,
    );
    if (this.#ackScheduled || this.#ackFlushing) {
      return;
    }
    this.#ackScheduled = true;
    this.queueBackground(
      (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.#ackScheduled = false;
        this.#ackFlushing = true;
        try {
          await this.flushScheduledAcks();
        } finally {
          this.#ackFlushing = false;
          if (
            (this.#pendingAckSeq > this.#ackedSeq ||
              this.#pendingAckExecutionFeedSeq >
                this.#ackedExecutionFeedSeq) &&
            !this.#closed &&
            this.client.isConnected()
          ) {
            this.scheduleAck(
              this.#pendingAckSeq,
              this.#pendingAckExecutionFeedSeq,
            );
          }
        }
      })(),
    );
  }

  private async flushScheduledAcks(): Promise<void> {
    while (true) {
      const target = this.#pendingAckSeq;
      const executionTarget = this.#pendingAckExecutionFeedSeq;
      if (
        this.#closed ||
        (target <= this.#ackedSeq &&
          executionTarget <= this.#ackedExecutionFeedSeq) ||
        !this.client.isConnected()
      ) {
        this.#ackedSeq = Math.max(this.#ackedSeq, target);
        this.#ackedExecutionFeedSeq = Math.max(
          this.#ackedExecutionFeedSeq,
          executionTarget,
        );
        return;
      }
      await this.client.request({
        type: "session.ack",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        seenSeq: target,
        executionFeedSeq: executionTarget,
      });
      this.#ackedSeq = Math.max(this.#ackedSeq, target);
      this.#ackedExecutionFeedSeq = Math.max(
        this.#ackedExecutionFeedSeq,
        executionTarget,
      );
      if (
        this.#pendingAckSeq <= this.#ackedSeq &&
        this.#pendingAckExecutionFeedSeq <= this.#ackedExecutionFeedSeq
      ) {
        return;
      }
    }
  }

  private async runWatchMutation<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const previous = this.#watchMutation;
    const current = previous.catch(() => undefined).then(work);
    this.#watchMutation = current.then(() => undefined, () => undefined);
    return await current;
  }

  private noteResult(serverSeq: number): void {
    this.#serverSeq = Math.max(this.#serverSeq, serverSeq);
  }

  #emitExecutionControl(event: ExecutionControlEvent): void {
    for (const listener of this.#executionControlListeners) {
      try {
        listener(event);
      } catch {
        // One consumer must not prevent the authoritative control view from
        // reaching the others.
      }
    }
  }

  #claimMatchesLive(claim: ExecutionClaim): boolean {
    const live = this.#executionClaims.get(actionClaimMapKey(claim));
    return live !== undefined &&
      live.leaseGeneration === claim.leaseGeneration &&
      live.claimGeneration === claim.claimGeneration;
  }

  #deliverOrBufferSettlement(settlement: ActionSettlement): void {
    if (!this.#claimMatchesLive(settlement.claim)) return;
    if (
      settlement.outcome === "committed" &&
      settlement.acceptedCommitSeq > this.#executionDataSeq
    ) {
      this.#pendingSettlements.push(settlement);
      return;
    }
    this.#emitExecutionControl({
      type: "session.execution.settlement",
      settlement,
    });
  }

  #flushPendingSettlements(): void {
    const pending = this.#pendingSettlements;
    this.#pendingSettlements = [];
    for (const settlement of pending) {
      if (!this.#claimMatchesLive(settlement.claim)) continue;
      if (
        settlement.outcome === "committed" &&
        settlement.acceptedCommitSeq > this.#executionDataSeq
      ) {
        this.#pendingSettlements.push(settlement);
      } else {
        this.#emitExecutionControl({
          type: "session.execution.settlement",
          settlement,
        });
      }
    }
  }

  #prunePendingSettlements(): void {
    this.#pendingSettlements = this.#pendingSettlements.filter((settlement) =>
      this.#claimMatchesLive(settlement.claim)
    );
  }

  #applyExecutionEvent(event: ExecutionControlEvent): void {
    switch (event.type) {
      case "session.execution.claim.set": {
        const key = actionClaimMapKey(event.claim);
        const current = this.#executionClaims.get(key);
        if (
          current === undefined ||
          event.claim.claimGeneration > current.claimGeneration
        ) {
          this.#executionClaims.set(key, event.claim);
          this.#prunePendingSettlements();
          this.#emitExecutionControl(event);
        }
        return;
      }
      case "session.execution.claim.revoke": {
        const key = actionClaimMapKey(event.claim);
        const current = this.#executionClaims.get(key);
        if (
          current !== undefined &&
          current.leaseGeneration === event.leaseGeneration &&
          current.claimGeneration === event.claimGeneration
        ) {
          this.#executionClaims.delete(key);
          this.#prunePendingSettlements();
          this.#emitExecutionControl(event);
        }
        return;
      }
      case "session.execution.settlement":
        this.#deliverOrBufferSettlement(event.settlement);
        return;
    }
  }

  #applyExecution(sync: SessionSync): void {
    const batch = sync.execution;
    if (batch === undefined || batch.toFeedSeq <= this.#executionFeedSeq) {
      return;
    }
    if (
      batch.snapshot === undefined &&
      batch.fromFeedSeq !== this.#executionFeedSeq
    ) {
      // A live ordered stream may never skip authority changes. Clear claims
      // fail-open; reconnect will install a full snapshot barrier.
      this.#executionClaims.clear();
      this.#prunePendingSettlements();
      return;
    }
    for (const event of batch.events) {
      this.#applyExecutionEvent(event);
    }
    if (batch.snapshot !== undefined) {
      const next = new Map(
        batch.snapshot.claims.map((claim) => [actionClaimMapKey(claim), claim]),
      );
      const previous = this.#executionClaims;
      this.#executionClaims = next;
      this.#prunePendingSettlements();
      for (const [key, claim] of previous) {
        const replacement = next.get(key);
        if (
          replacement === undefined ||
          replacement.leaseGeneration !== claim.leaseGeneration ||
          replacement.claimGeneration !== claim.claimGeneration
        ) {
          this.#emitExecutionControl({
            type: "session.execution.claim.revoke",
            branch: claim.branch,
            claim,
            leaseGeneration: claim.leaseGeneration,
            claimGeneration: claim.claimGeneration,
          });
        }
      }
      for (const [key, claim] of next) {
        const prior = previous.get(key);
        if (
          prior === undefined ||
          prior.leaseGeneration !== claim.leaseGeneration ||
          prior.claimGeneration !== claim.claimGeneration
        ) {
          this.#emitExecutionControl({
            type: "session.execution.claim.set",
            claim,
          });
        }
      }
    }
    this.#executionFeedSeq = batch.toFeedSeq;
    this.#flushPendingSettlements();
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
  }

  // Forward a caught-up marker to WatchView subscribers when it was delivered
  // out-of-band (top-level SessionOpenResult.caughtUpLocalSeq on resume) rather
  // than via a sync they already observed. Emits an empty caught-up sync so
  // downstream waiters (notably runner storage's read-repair gate) resolve
  // instead of stranding after a reconnect.
  private forwardCaughtUpLocalSeqToWatchers(
    localSeq: number | undefined,
  ): void {
    if (
      localSeq === undefined ||
      localSeq <= this.#forwardedCaughtUpLocalSeq ||
      this.#watchView === null
    ) {
      return;
    }
    this.#forwardedCaughtUpLocalSeq = localSeq;
    this.#watchView.emit({
      type: "sync",
      fromSeq: this.#serverSeq,
      toSeq: this.#serverSeq,
      caughtUpLocalSeq: localSeq,
      upserts: [],
      removes: [],
    });
  }

  private waitForCaughtUpLocalSeq(localSeq: number): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        this.#closeError ?? new Error("memory session closed"),
      );
    }
    if (this.#caughtUpLocalSeq >= localSeq) {
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    this.#caughtUpLocalSeqWaiters.push({ localSeq, pending });
    return pending.promise;
  }

  private rejectCaughtUpLocalSeqWaiters(error: Error | null): void {
    const waiters = this.#caughtUpLocalSeqWaiters;
    this.#caughtUpLocalSeqWaiters = [];
    for (const waiter of waiters) {
      waiter.pending.reject(error ?? new Error("memory session closed"));
    }
  }

  private async reopen(): Promise<SessionOpenResult> {
    const oldSessionId = this.#sessionId;
    const session = {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
      executionFeedSeq: this.#executionFeedSeq,
      sessionToken: this.#sessionToken,
    };
    const auth = await this.openAuthFactory?.(
      this.space,
      session,
      this.client.sessionOpenAuthContext(),
    );
    const restored = await this.client.openSession(this.space, {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
      executionFeedSeq: this.#executionFeedSeq,
      sessionToken: this.#sessionToken,
    }, auth);
    const sessionChanged = restored.sessionId !== oldSessionId;
    const sessionReplaced = sessionChanged || restored.resumed !== true;
    this.#sessionId = restored.sessionId;
    this.#sessionToken = restored.sessionToken ?? this.#sessionToken;
    this.noteResult(restored.serverSeq);

    if (sessionReplaced) {
      const sessionChangedError = new Error(
        sessionChanged
          ? `session changed: ${oldSessionId} -> ${restored.sessionId}`
          : `session replaced without resume: ${restored.sessionId}`,
      );
      if (sessionChanged) {
        for (const pending of this.#outstandingCommits.values()) {
          pending.pending.reject(sessionChangedError);
        }
        this.#outstandingCommits.clear();
      }
      this.#caughtUpLocalSeq = 0;
      this.#forwardedCaughtUpLocalSeq = 0;
      this.#executionFeedSeq = 0;
      this.#ackedExecutionFeedSeq = 0;
      this.#pendingAckExecutionFeedSeq = 0;
      this.#executionClaims.clear();
      this.#pendingSettlements = [];
      this.rejectCaughtUpLocalSeqWaiters(sessionChangedError);
    }
    this.noteCaughtUpLocalSeq(restored.caughtUpLocalSeq);

    return restored;
  }

  private replayOutstandingCommits(minLocalSeqExclusive = 0): void {
    if (
      this.#outstandingCommits.size === 0 ||
      !this.#readyOnConnection ||
      !this.client.isConnected()
    ) {
      return;
    }
    for (
      const [localSeq, pendingCommit] of this.#outstandingCommits.entries()
    ) {
      if (localSeq <= minLocalSeqExclusive) {
        continue;
      }
      this.sendOutstandingCommit(localSeq, pendingCommit);
    }
  }

  private sendOutstandingCommit(
    localSeq: number,
    pendingCommit: {
      commit: ClientCommit;
      pending: PromiseWithResolvers<AppliedCommit>;
    },
    options: {
      throwOnConnectionError?: boolean;
    } = {},
  ): Promise<void> {
    const task = (async () => {
      if (
        this.#closed ||
        !this.#readyOnConnection ||
        !this.client.isConnected()
      ) {
        return;
      }

      try {
        const applied = await this.client.request<AppliedCommit>({
          type: "transact",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          commit: pendingCommit.commit,
        });
        this.noteResult(applied.seq);
        if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
          this.#outstandingCommits.delete(localSeq);
        }
        pendingCommit.pending.resolve(applied);
        if (!this.#closed) {
          void this.ack(applied.seq).catch(() => undefined);
        }
      } catch (error) {
        if (isConnectionError(error) || isSessionRevokedError(error)) {
          if (options.throwOnConnectionError) {
            throw error;
          }
          return;
        }
        if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
          this.#outstandingCommits.delete(localSeq);
        }
        if (isRetryableConflict(error)) {
          error.readyToRetry = () => this.waitForCaughtUpLocalSeq(localSeq);
        }
        pendingCommit.pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
    this.queueBackground(task);
    return task;
  }
}

type RetryableConflictError = Error & {
  name: "ConflictError";
  retryAfterSeq: number;
  readyToRetry?: () => Promise<void>;
};

function isRetryableConflict(error: unknown): error is RetryableConflictError {
  return error instanceof Error && error.name === "ConflictError" &&
    typeof (error as { retryAfterSeq?: unknown }).retryAfterSeq === "number";
}

export class WatchView {
  #queue: GraphQueryResult[] = [];
  #pending = new Set<PromiseWithResolvers<IteratorResult<GraphQueryResult>>>();
  #subscribers = 0;
  #syncQueue: SessionSync[] = [];
  #syncPending = new Set<PromiseWithResolvers<IteratorResult<SessionSync>>>();
  #entities = new Map<string, EntitySnapshot>();
  #orderedEntities: EntitySnapshot[] | null = null;
  #closed = false;
  #serverSeq = 0;

  static fromSync(sync: SessionSync): WatchView {
    const view = new WatchView();
    view.applySync(sync, false);
    return view;
  }

  get entities(): EntitySnapshot[] {
    return [...this.orderedEntities()];
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  subscribe(): AsyncIterator<GraphQueryResult> {
    this.#subscribers += 1;
    let active = true;
    const iteratorPending = new Set<
      PromiseWithResolvers<IteratorResult<GraphQueryResult>>
    >();
    return {
      next: async () => {
        if (this.#closed || !active) {
          return {
            done: true,
            value: undefined as never,
          };
        }
        const queued = this.#queue.shift();
        if (queued) {
          return { done: false, value: queued };
        }
        const pending = Promise.withResolvers<
          IteratorResult<GraphQueryResult>
        >();
        this.#pending.add(pending);
        iteratorPending.add(pending);
        try {
          return await pending.promise;
        } finally {
          iteratorPending.delete(pending);
        }
      },
      return: () => {
        if (active) {
          active = false;
          this.#subscribers = Math.max(0, this.#subscribers - 1);
        }
        for (const pending of iteratorPending) {
          this.#pending.delete(pending);
          pending.resolve({
            done: true,
            value: undefined as never,
          });
        }
        iteratorPending.clear();
        return Promise.resolve({
          done: true,
          value: undefined as never,
        });
      },
    };
  }

  applySync(sync: SessionSync, emit: boolean): void {
    const upserts = new Map<string, EntitySnapshot>();
    for (const upsert of sync.upserts) {
      upserts.set(watchKey(upsert.branch, upsert.id, upsert.scope), {
        branch: upsert.branch,
        id: upsert.id,
        ...(upsert.scope !== undefined ? { scope: upsert.scope } : {}),
        seq: upsert.seq,
        document: upsert.doc ?? null,
      });
    }

    const removeKeys = new Set<string>();
    for (const remove of sync.removes) {
      const key = watchKey(remove.branch, remove.id, remove.scope);
      removeKeys.add(key);
    }

    let changedEntities = false;
    for (const [key, entity] of upserts) {
      if (!removeKeys.has(key)) {
        this.#entities.set(key, entity);
        changedEntities = true;
      }
    }

    for (const key of removeKeys) {
      changedEntities = this.#entities.delete(key) || changedEntities;
    }

    if (changedEntities) {
      this.#orderedEntities = null;
    }

    this.#serverSeq = Math.max(this.#serverSeq, sync.toSeq);
    if (emit) {
      this.emit(sync);
    }
  }

  emit(sync: SessionSync): void {
    this.pushSync(sync);
    if (
      this.#subscribers > 0 || this.#pending.size > 0 || this.#queue.length > 0
    ) {
      this.push(this.snapshot());
    }
  }

  snapshot(): GraphQueryResult {
    return {
      serverSeq: this.#serverSeq,
      entities: [...this.orderedEntities()],
    };
  }

  subscribeSync(): AsyncIterator<SessionSync> {
    return {
      next: async () => {
        if (this.#closed) {
          return {
            done: true,
            value: undefined as never,
          };
        }
        const queued = this.#syncQueue.shift();
        if (queued) {
          return { done: false, value: queued };
        }
        const pending = Promise.withResolvers<IteratorResult<SessionSync>>();
        this.#syncPending.add(pending);
        return await pending.promise;
      },
    };
  }

  push(result: GraphQueryResult): void {
    if (this.#closed) {
      return;
    }
    const pending = this.#pending.values().next().value;
    if (pending) {
      this.#pending.delete(pending);
      pending.resolve({ done: false, value: result });
      return;
    }
    this.#queue.push(result);
  }

  pushSync(sync: SessionSync): void {
    if (this.#closed) {
      return;
    }
    const pending = this.#syncPending.values().next().value;
    if (pending) {
      this.#syncPending.delete(pending);
      pending.resolve({ done: false, value: sync });
      return;
    }
    this.#syncQueue.push(sync);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending) {
      pending.resolve({
        done: true,
        value: undefined as never,
      });
    }
    this.#pending.clear();
    this.#subscribers = 0;
    for (const pending of this.#syncPending) {
      pending.resolve({
        done: true,
        value: undefined as never,
      });
    }
    this.#syncPending.clear();
    this.#queue = [];
    this.#syncQueue = [];
  }

  private orderedEntities(): EntitySnapshot[] {
    if (this.#orderedEntities === null) {
      this.#orderedEntities = [...this.#entities.values()]
        .sort(compareEntitySnapshot);
    }
    return this.#orderedEntities;
  }
}

export const connect = Client.connect;

export const loopback = (server: Server): Transport => {
  let receiver = (_payload: string) => {};
  const connection = server.connect((message) => {
    receiver(encodeMemoryBoundary(message));
  });
  return {
    async send(payload: string) {
      await connection.receive(payload);
    },
    close() {
      connection.close();
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
};

const toConnectionError = (error?: Error): Error => {
  const connectionError = new Error(
    error?.message ?? "memory transport closed",
    error ? { cause: error } : undefined,
  );
  connectionError.name = "ConnectionError";
  return connectionError;
};

const isConnectionError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "ConnectionError" ||
    error.message.includes("transport closed") ||
    error.message.includes("disconnect"));

const protocolError = (message: string): Error => {
  const error = new Error(message);
  error.name = "ProtocolError";
  return error;
};

const requireSessionOpenAuthMetadata = (
  value: unknown,
): SessionOpenAuthMetadata => {
  if (value === undefined) {
    throw protocolError(
      "memory server did not provide session.open authentication metadata",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }

  const sessionOpen = value as {
    audience?: unknown;
    challenge?: unknown;
  };
  if (sessionOpen.challenge === undefined) {
    throw protocolError(
      "memory server did not provide a session.open challenge",
    );
  }
  if (sessionOpen.audience === undefined) {
    throw protocolError(
      "memory server did not provide a session.open audience",
    );
  }
  if (typeof sessionOpen.audience !== "string") {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  if (
    typeof sessionOpen.challenge !== "object" ||
    sessionOpen.challenge === null ||
    Array.isArray(sessionOpen.challenge)
  ) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  const challenge = sessionOpen.challenge as {
    value?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof challenge.value !== "string" ||
    typeof challenge.expiresAt !== "number"
  ) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  return {
    audience: sessionOpen.audience,
    challenge: {
      value: challenge.value,
      expiresAt: challenge.expiresAt,
    },
  };
};

const parseHelloOk = (
  message: unknown,
): {
  flags: MemoryProtocolFlags;
  sessionOpen?: unknown;
} | null => {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const obj = message as {
    type?: unknown;
    protocol?: unknown;
    flags?: unknown;
    sessionOpen?: unknown;
  };
  if (obj.type !== "hello.ok" || obj.protocol !== MEMORY_PROTOCOL) {
    return null;
  }
  const parsed = parseMemoryProtocolFlags(obj.flags);
  if (parsed === null) {
    return null;
  }
  return { flags: parsed, sessionOpen: obj.sessionOpen };
};

const isSessionEffect = (
  message: unknown,
): message is SessionEffectMessage => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "session/effect";
};

const isSessionRevoked = (
  message: unknown,
): message is SessionRevokedMessage => {
  if (typeof message !== "object" || message === null) return false;
  const { type, space, sessionId, reason } = message as {
    type?: string;
    space?: string;
    sessionId?: string;
    reason?: string;
  };
  return type === "session/revoked" &&
    typeof space === "string" &&
    typeof sessionId === "string" &&
    (reason === "taken-over" || reason === "unauthorized");
};

const isResponse = (message: unknown): message is ResponseMessage<unknown> => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "response" &&
    typeof (message as { requestId?: string }).requestId === "string";
};

const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0;

const isSessionRevokedError = (error: unknown): boolean =>
  error instanceof Error && error.name === "SessionRevokedError";

const isProtocolError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "ProtocolError";
