import {
  MEMORY_V2_PROTOCOL,
  type ClientCommit,
  type EntitySnapshot,
  type GraphQuery,
  type GraphQueryResult,
  type GraphUpdateMessage,
  type ResponseMessage,
  type ServerMessage,
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

export class Client {
  #pending = new Map<string, PromiseWithResolvers<unknown>>();
  #subscriptions = new Map<string, {
    session: SpaceSession;
    view: QueryView;
  }>();
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
    await this.transport.close();
  }

  async mount(space: string, options: MountOptions = {}): Promise<SpaceSession> {
    const result = await this.openSession(space, options);
    const session = new SpaceSession(this, space, result.sessionId, result.serverSeq);
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

  registerSubscription(id: string, session: SpaceSession, view: QueryView): void {
    this.#subscriptions.set(id, { session, view });
  }

  unregisterSubscription(id: string | null | undefined): void {
    if (id) {
      this.#subscriptions.delete(id);
    }
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
    if (isGraphUpdate(message)) {
      const subscription = this.#subscriptions.get(message.subscriptionId);
      if (subscription) {
        subscription.session.noteResult(message.result);
        subscription.view.push(message.result);
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
    this.rejectPending(error ?? new Error("memory/v2 transport closed"));
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory/v2 client is closed");
    }
    if (this.#reconnecting) {
      return await this.#reconnecting;
    }
    this.#reconnecting = (async () => {
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
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();

    try {
      await this.#reconnecting;
    } finally {
      this.#reconnecting = null;
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
  #subscriptions = new Set<{
    query: GraphQuery;
    subscriptionId: string | null;
    view: QueryView;
  }>();
  #sessionId: string;
  #serverSeq: number;

  constructor(
    private readonly client: Client,
    readonly space: string,
    sessionId: string,
    serverSeq: number,
  ) {
    this.#sessionId = sessionId;
    this.#serverSeq = serverSeq;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  async transact(commit: ClientCommit): Promise<AppliedCommit> {
    const applied = await this.client.request<AppliedCommit>({
      type: "transact",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      commit,
    });
    this.#serverSeq = Math.max(this.#serverSeq, applied.seq);
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

    this.noteResult(result);
    const view = new QueryView(result);
    if (result.subscriptionId) {
      this.#subscriptions.add({
        query,
        subscriptionId: result.subscriptionId,
        view,
      });
      this.client.registerSubscription(result.subscriptionId, this, view);
    }
    return view;
  }

  noteResult(result: GraphQueryResult): void {
    this.#serverSeq = Math.max(this.#serverSeq, result.serverSeq);
  }

  async restore(): Promise<void> {
    const restored = await this.client.openSession(this.space, {
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
    });
    this.#sessionId = restored.sessionId;
    this.#serverSeq = Math.max(this.#serverSeq, restored.serverSeq);

    for (const subscription of this.#subscriptions) {
      this.client.unregisterSubscription(subscription.subscriptionId);
      const result = await this.client.request<GraphQueryResult>({
        type: "graph.query",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        query: {
          ...subscription.query,
          subscribe: true,
        },
      });
      this.noteResult(result);
      subscription.subscriptionId = result.subscriptionId ?? null;
      if (subscription.subscriptionId) {
        this.client.registerSubscription(
          subscription.subscriptionId,
          this,
          subscription.view,
        );
      }
      subscription.view.reconnect(result);
    }
  }
}

export class QueryView {
  #queue: GraphQueryResult[] = [];
  #pending = new Set<PromiseWithResolvers<IteratorResult<GraphQueryResult>>>();
  entities: EntitySnapshot[];
  serverSeq: number;

  constructor(initial: GraphQueryResult) {
    this.entities = initial.entities;
    this.serverSeq = initial.serverSeq;
  }

  subscribe(): AsyncIterator<GraphQueryResult> {
    return {
      next: async () => {
        const queued = this.#queue.shift();
        if (queued) {
          return { done: false, value: queued };
        }
        const pending = Promise.withResolvers<IteratorResult<GraphQueryResult>>();
        this.#pending.add(pending);
        return await pending.promise;
      },
    };
  }

  push(result: GraphQueryResult): void {
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
    if (sameQueryResult(this, result)) {
      this.entities = result.entities;
      this.serverSeq = result.serverSeq;
      return;
    }
    this.push(result);
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
    async close() {},
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
};

const isHelloOk = (message: unknown): message is Extract<ServerMessage, { type: "hello.ok" }> => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "hello.ok";
};

const isGraphUpdate = (message: unknown): message is GraphUpdateMessage => {
  return typeof message === "object" && message !== null &&
    (message as { type?: string }).type === "graph.update";
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
      entity.id === other.id &&
      entity.seq === other.seq &&
      entity.hash === other.hash &&
      JSON.stringify(entity.document) === JSON.stringify(other.document);
  });
};
