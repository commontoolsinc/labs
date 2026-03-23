import {
  type ClientCommit,
  type EntitySnapshot,
  type GraphQuery,
  type GraphQueryResult,
  MEMORY_V2_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionSync,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import type { Server } from "./server.ts";
import type { AppliedCommit } from "./engine.ts";

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

const watchKey = (branch: string, id: string): string => `${branch}\0${id}`;

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
    this.rejectPending(new Error("memory/v2 client closed"));
    await Promise.all([...this.#spaces].map((space) => space.close()));
    this.#spaces.clear();
    await this.transport.close();
    await this.#reconnecting?.catch(() => undefined);
  }

  async mount(
    space: string,
    options: MountOptions = {},
  ): Promise<SpaceSession> {
    const result = await this.openSession(space, options);
    const session = new SpaceSession(
      this,
      space,
      result.sessionId,
      result.serverSeq,
    );
    this.#spaces.add(session);
    return session;
  }

  async request<Result>(message: Record<string, unknown>): Promise<Result> {
    await this.ensureConnected();
    const requestId = message.requestId as string;
    const pending = Promise.withResolvers<unknown>();
    this.#pending.set(requestId, pending);
    await this.transport.send(JSON.stringify(message));
    const result = await pending.promise as ResponseMessage<Result>;
    if (result.error) {
      const error = new Error(result.error.message);
      error.name = result.error.name;
      throw error;
    }
    return result.ok as Result;
  }

  async openSession(
    space: string,
    session: MountOptions,
  ): Promise<{ sessionId: string; serverSeq: number }> {
    return await this.request<{ sessionId: string; serverSeq: number }>({
      type: "session.open",
      requestId: this.nextRequestId(),
      space,
      session,
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
    await this.transport.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    try {
      await ack.promise;
      this.#connected = true;
    } finally {
      this.#helloPending = null;
    }
  }

  private onMessage(payload: string): void {
    const message = JSON.parse(payload) as unknown;
    if (isHelloOk(message)) {
      this.#helloPending?.resolve();
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
      throw new Error("memory/v2 client is closed");
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
    this.rejectPending(toConnectionError(error));
    void this.reconnect().catch(() => undefined);
  }

  private async reconnect(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory/v2 client is closed");
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
  #flushing: Promise<void> | null = null;
  #watchSpecs: WatchSpec[] = [];
  #watchCache = new Map<string, EntitySnapshot>();
  #watchView: QueryView | null = null;
  #sessionId: string;
  #serverSeq: number;
  #ackedSeq = 0;

  constructor(
    private readonly client: Client,
    readonly space: string,
    sessionId: string,
    serverSeq: number,
  ) {
    this.#sessionId = sessionId;
    this.#serverSeq = serverSeq;
    this.#ackedSeq = serverSeq;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  async transact(commit: ClientCommit): Promise<AppliedCommit> {
    const existing = this.#outstandingCommits.get(commit.localSeq);
    if (existing) {
      return await existing.pending.promise;
    }

    const pending = Promise.withResolvers<AppliedCommit>();
    this.#outstandingCommits.set(commit.localSeq, {
      commit,
      pending,
    });

    if (this.client.isConnected()) {
      void this.flushOutstandingCommits();
    } else {
      void this.client.restoreConnection();
    }

    const applied = await pending.promise;
    await this.#flushing;
    void this.client.restoreConnection().catch(() => undefined);
    return applied;
  }

  async queryGraph(query: GraphQuery): Promise<QueryView> {
    const result = await this.client.request<GraphQueryResult>({
      type: "graph.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      query,
    });

    this.noteResult(result.serverSeq);
    return new QueryView(result);
  }

  async watchSet(watches: WatchSpec[]): Promise<QueryView> {
    const result = await this.client.request<WatchSetResult>({
      type: "session.watch.set",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      watches,
    });
    this.#watchSpecs = watches;
    this.applySync(result.sync, false);
    const snapshot = this.currentWatchResult();
    if (this.#watchView === null) {
      this.#watchView = new QueryView(snapshot);
    } else {
      this.#watchView.reconnect(snapshot);
    }
    void this.ack(result.serverSeq).catch(() => undefined);
    return this.#watchView;
  }

  async ack(seenSeq: number): Promise<void> {
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
    this.applySync(effect, true);
    void this.ack(effect.toSeq).catch(() => undefined);
  }

  async restore(): Promise<void> {
    await this.reopen();
    await this.replayOutstandingCommits();
    if (this.#watchSpecs.length > 0) {
      await this.watchSet(this.#watchSpecs);
    }
  }

  async close(): Promise<void> {
    await this.#flushing;
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(new Error("memory/v2 session closed"));
    }
    this.#outstandingCommits.clear();
    this.#watchView?.close();
    this.#watchView = null;
  }

  private noteResult(serverSeq: number): void {
    this.#serverSeq = Math.max(this.#serverSeq, serverSeq);
  }

  private applySync(sync: SessionSync, emit: boolean): void {
    for (const upsert of sync.upserts) {
      this.#watchCache.set(watchKey(upsert.branch, upsert.id), {
        branch: upsert.branch,
        id: upsert.id,
        seq: upsert.seq,
        document: upsert.doc ?? null,
      });
    }
    for (const remove of sync.removes) {
      this.#watchCache.delete(watchKey(remove.branch, remove.id));
    }
    this.noteResult(sync.toSeq);
    if (emit && this.#watchView !== null) {
      this.#watchView.push(this.currentWatchResult());
    }
  }

  private currentWatchResult(): GraphQueryResult {
    return {
      serverSeq: this.#serverSeq,
      entities: [...this.#watchCache.values()].sort((left, right) =>
        left.branch.localeCompare(right.branch) ||
        left.id.localeCompare(right.id)
      ),
    };
  }

  private async reopen(): Promise<void> {
    const restored = await this.client.openSession(this.space, {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
    });
    this.#sessionId = restored.sessionId;
    this.noteResult(restored.serverSeq);
  }

  private async replayOutstandingCommits(): Promise<void> {
    if (this.#outstandingCommits.size === 0) {
      return;
    }
    await this.flushOutstandingCommits();
  }

  private async flushOutstandingCommits(): Promise<void> {
    if (this.#flushing) {
      return await this.#flushing;
    }
    if (!this.client.isConnected()) {
      return;
    }

    const flush = (async () => {
      while (this.client.isConnected() && this.#outstandingCommits.size > 0) {
        const next = [...this.#outstandingCommits.entries()]
          .sort(([left], [right]) => left - right)[0];
        if (!next) {
          return;
        }

        const [localSeq, pendingCommit] = next;
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
          void this.ack(applied.seq).catch(() => undefined);
        } catch (error) {
          if (isConnectionError(error)) {
            return;
          }
          if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
            this.#outstandingCommits.delete(localSeq);
          }
          pendingCommit.pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    })();

    const flushing = flush.finally(() => {
      if (this.#flushing === flushing) {
        this.#flushing = null;
      }
      if (
        this.client.isConnected() &&
        this.#outstandingCommits.size > 0 &&
        this.#flushing === null
      ) {
        void this.flushOutstandingCommits();
      }
    });
    this.#flushing = flushing;

    return await this.#flushing;
  }
}

export class QueryView {
  #queue: GraphQueryResult[] = [];
  #pending = new Set<PromiseWithResolvers<IteratorResult<GraphQueryResult>>>();
  #closed = false;
  entities: EntitySnapshot[];
  serverSeq: number;

  constructor(initial: GraphQueryResult) {
    this.entities = initial.entities;
    this.serverSeq = initial.serverSeq;
  }

  subscribe(): AsyncIterator<GraphQueryResult> {
    return {
      next: async () => {
        if (this.#closed) {
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
        return await pending.promise;
      },
    };
  }

  push(result: GraphQueryResult): void {
    if (this.#closed) {
      return;
    }
    if (sameQueryResult(this, result)) {
      this.entities = result.entities;
      this.serverSeq = result.serverSeq;
      return;
    }
    this.entities = result.entities;
    this.serverSeq = result.serverSeq;
    const pending = this.#pending.values().next().value;
    if (pending) {
      this.#pending.delete(pending);
      pending.resolve({ done: false, value: result });
      return;
    }
    this.#queue.push(result);
  }

  reconnect(result: GraphQueryResult): void {
    if (this.#closed) {
      return;
    }
    if (sameQueryResult(this, result)) {
      this.entities = result.entities;
      this.serverSeq = result.serverSeq;
      return;
    }
    this.push(result);
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
    this.#queue = [];
  }
}

export const connect = Client.connect;

export const loopback = (server: Server): Transport => {
  let receiver = (_payload: string) => {};
  const connection = server.connect((message) => {
    receiver(JSON.stringify(message));
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
    error?.message ?? "memory/v2 transport closed",
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

const isHelloOk = (
  message: unknown,
): message is Extract<ServerMessage, { type: "hello.ok" }> => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "hello.ok";
};

const isSessionEffect = (
  message: unknown,
): message is SessionEffectMessage => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "session/effect";
};

const isResponse = (message: unknown): message is ResponseMessage<unknown> => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "response" &&
    typeof (message as { requestId?: string }).requestId === "string";
};

const sameQueryResult = (
  current: QueryView,
  next: GraphQueryResult,
): boolean => {
  if (current.serverSeq !== next.serverSeq) {
    return false;
  }
  if (current.entities.length !== next.entities.length) {
    return false;
  }
  return current.entities.every((entity, index) => {
    const other = next.entities[index];
    return other !== undefined &&
      entity.branch === other.branch &&
      entity.id === other.id &&
      entity.seq === other.seq &&
      JSON.stringify(entity.document) === JSON.stringify(other.document);
  });
};
