import {
  type ClientCommit,
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntitySnapshot,
  getMemoryProtocolFlags,
  getPersistentSchedulerStateConfig,
  type GraphQuery,
  type GraphQueryResult,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerSnapshotListResult,
  type SessionEffectMessage,
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
} from "../v2.ts";
import type { Server } from "./server.ts";
import type { AppliedCommit } from "./engine.ts";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";

export interface Transport {
  send(payload: string): Promise<void>;
  close(): Promise<void>;
  setReceiver(receiver: (payload: string) => void): void;
  setCloseReceiver?(receiver: (error?: Error) => void): void;
}

export interface ConnectOptions {
  transport: Transport;
}

export interface MountOptions {
  sessionId?: string;
  seenSeq?: number;
  sessionToken?: string;
}

export interface SessionOpenAuth {
  invocation: Record<string, unknown>;
  authorization: unknown;
}

export type SessionOpenAuthFactory = (
  space: string,
  session: MountOptions,
) => Promise<SessionOpenAuth | undefined> | SessionOpenAuth | undefined;

export interface WatchMutationResult {
  view: WatchView;
  sync: SessionSync;
}

const RECONNECT_BASE_DELAY_MS = 25;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

export class Client {
  #pending = new Map<string, PromiseWithResolvers<unknown>>();
  #spaces = new Set<SpaceSession>();
  #nextRequest = 1;
  #helloPending: PromiseWithResolvers<void> | null = null;
  #reconnecting: Promise<void> | null = null;
  #connected = false;
  #closed = false;

  private constructor(private readonly transport: Transport) {
    this.transport.setReceiver((payload) => this.onMessage(payload));
    this.transport.setCloseReceiver?.((error) => this.onClose(error));
  }

  static async connect(options: ConnectOptions): Promise<Client> {
    const client = new Client(options.transport);
    await client.hello();
    return client;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
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
    const auth = await openAuthFactory?.(space, options);
    const result = await this.openSession(space, options, auth);
    const session = new SpaceSession(
      this,
      space,
      result.sessionId,
      result.sessionToken,
      result.serverSeq,
      openAuthFactory,
    );
    this.#spaces.add(session);
    return session;
  }

  forgetSession(session: SpaceSession): void {
    this.#spaces.delete(session);
  }

  async request<Result>(message: Record<string, unknown>): Promise<Result> {
    await this.ensureConnected();
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
      throw error;
    }
    return result.ok as Result;
  }

  async openSession(
    space: string,
    session: MountOptions,
    auth?: SessionOpenAuth,
  ): Promise<SessionOpenResult> {
    return await this.request<SessionOpenResult>({
      type: "session.open",
      requestId: this.nextRequestId(),
      space,
      session,
      ...(auth ? auth : {}),
    });
  }

  isConnected(): boolean {
    return this.#connected;
  }

  async restoreConnection(): Promise<void> {
    await this.ensureConnected();
  }

  private async hello(): Promise<void> {
    const ack = Promise.withResolvers<void>();
    this.#helloPending = ack;
    await this.transport.send(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
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
        const expectedFlags = getMemoryProtocolFlags();
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
          for (const session of this.#spaces) {
            await session.restore();
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

  private async waitForReconnectDelay(delayMs: number): Promise<void> {
    for (
      let remaining = delayMs;
      remaining > 0 && !this.#closed;
      remaining -= RECONNECT_BASE_DELAY_MS
    ) {
      await sleep(Math.min(RECONNECT_BASE_DELAY_MS, remaining));
    }
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
  #pendingAckSeq = 0;
  #ackScheduled = false;
  #ackFlushing = false;
  #background = new Set<Promise<void>>();
  #watchMutation: Promise<void> = Promise.resolve();
  #closed = false;
  #closeError: Error | null = null;
  #readyOnConnection = true;
  #restoring = false;
  #serverSeqWaiters: {
    seq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];

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
      this.scheduleAck(result.serverSeq);
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
      this.scheduleAck(result.serverSeq);
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
    if (!this.client.isConnected() || seenSeq <= this.#ackedSeq) {
      this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
      return;
    }
    await this.client.request({
      type: "session.ack",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      seenSeq,
    });
    this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
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
    this.scheduleAck(effect.toSeq);
  }

  async restore(): Promise<void> {
    if (this.#closed) {
      return;
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
          return;
        }
        throw error;
      }
      if (this.#closed) {
        return;
      }
      this.#readyOnConnection = true;
      replayedThroughLocalSeq = Math.max(
        0,
        ...this.#outstandingCommits.keys(),
      );
      const replayTasks = [...this.#outstandingCommits.entries()].map((
        [localSeq, pendingCommit],
      ) =>
        this.sendOutstandingCommit(localSeq, pendingCommit, {
          throwOnConnectionError: true,
        })
      );
      if (restored.sync) {
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(restored.sync);
        } else {
          this.#watchView.applySync(restored.sync, false);
        }
        if (!isEmptySync(restored.sync)) {
          this.#watchView.emit(restored.sync);
        }
        this.scheduleAck(restored.serverSeq);
      } else if (restored.resumed === true && this.#watchSpecs.length > 0) {
        this.scheduleAck(restored.serverSeq);
      }
      if (restored.resumed !== true && this.#watchSpecs.length > 0) {
        const { view, sync } = await this.watchSetSync(this.#watchSpecs);
        if (!isEmptySync(sync)) {
          view.emit(sync);
        }
      }
      await Promise.all(replayTasks);
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
    this.#closed = true;
    this.#closeError = new Error("memory session closed");
    this.#readyOnConnection = false;
    this.client.forgetSession(this);
    const background = [...this.#background];
    this.#background.clear();
    await Promise.allSettled(background);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(new Error("memory session closed"));
    }
    this.rejectServerSeqWaiters(this.#closeError);
    this.#outstandingCommits.clear();
    this.#watchSpecs = [];
    this.#watchView?.close();
    this.#watchView = null;
  }

  handleRevoked(reason: SessionRevokedMessage["reason"]): void {
    if (this.#closed) {
      return;
    }
    const error = new Error(`memory session revoked: ${reason}`);
    error.name = "SessionRevokedError";
    this.#closed = true;
    this.#closeError = error;
    this.#readyOnConnection = false;
    this.client.forgetSession(this);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(error);
    }
    this.rejectServerSeqWaiters(error);
    this.#outstandingCommits.clear();
    this.#watchSpecs = [];
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

  private scheduleAck(seenSeq: number): void {
    if (this.#closed) {
      return;
    }
    this.#pendingAckSeq = Math.max(this.#pendingAckSeq, seenSeq);
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
            this.#pendingAckSeq > this.#ackedSeq &&
            !this.#closed &&
            this.client.isConnected()
          ) {
            this.scheduleAck(this.#pendingAckSeq);
          }
        }
      })(),
    );
  }

  private async flushScheduledAcks(): Promise<void> {
    while (true) {
      const target = this.#pendingAckSeq;
      if (
        this.#closed || target <= this.#ackedSeq || !this.client.isConnected()
      ) {
        this.#ackedSeq = Math.max(this.#ackedSeq, target);
        return;
      }
      await this.client.request({
        type: "session.ack",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        seenSeq: target,
      });
      this.#ackedSeq = Math.max(this.#ackedSeq, target);
      if (this.#pendingAckSeq <= this.#ackedSeq) {
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
    const ready: PromiseWithResolvers<void>[] = [];
    this.#serverSeqWaiters = this.#serverSeqWaiters.filter((waiter) => {
      if (waiter.seq <= this.#serverSeq) {
        ready.push(waiter.pending);
        return false;
      }
      return true;
    });
    for (const pending of ready) {
      pending.resolve();
    }
  }

  private waitForServerSeq(seq: number): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        this.#closeError ?? new Error("memory session closed"),
      );
    }
    if (this.#serverSeq >= seq) {
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    this.#serverSeqWaiters.push({ seq, pending });
    return pending.promise;
  }

  private rejectServerSeqWaiters(error: Error | null): void {
    const waiters = this.#serverSeqWaiters;
    this.#serverSeqWaiters = [];
    for (const waiter of waiters) {
      waiter.pending.reject(error ?? new Error("memory session closed"));
    }
  }

  private async reopen(): Promise<SessionOpenResult> {
    const oldSessionId = this.#sessionId;
    const session = {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
      sessionToken: this.#sessionToken,
    };
    const auth = await this.openAuthFactory?.(this.space, session);
    const restored = await this.client.openSession(this.space, {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
      sessionToken: this.#sessionToken,
    }, auth);
    this.#sessionId = restored.sessionId;
    this.#sessionToken = restored.sessionToken ?? this.#sessionToken;
    this.noteResult(restored.serverSeq);

    if (restored.sessionId !== oldSessionId) {
      for (const pending of this.#outstandingCommits.values()) {
        pending.pending.reject(
          new Error(
            `session changed: ${oldSessionId} -> ${restored.sessionId}`,
          ),
        );
      }
      this.#outstandingCommits.clear();
    }

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
          error.readyToRetry = () => this.waitForServerSeq(error.retryAfterSeq);
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

const parseHelloOk = (
  message: unknown,
): { flags: MemoryProtocolFlags } | null => {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const obj = message as {
    type?: unknown;
    protocol?: unknown;
    flags?: unknown;
  };
  if (obj.type !== "hello.ok" || obj.protocol !== MEMORY_PROTOCOL) {
    return null;
  }
  const parsed = parseMemoryProtocolFlags(obj.flags);
  if (parsed === null) {
    return null;
  }
  return { flags: parsed };
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
