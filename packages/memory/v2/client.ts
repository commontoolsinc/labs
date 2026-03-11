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
  #subscriptions = new Map<string, QueryView>();
  #nextRequest = 1;

  private constructor(private readonly transport: Transport) {
    this.transport.setReceiver((payload) => this.onMessage(payload));
  }

  static async connect(options: ConnectOptions): Promise<Client> {
    const client = new Client(options.transport);
    await client.hello();
    return client;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async mount(space: string, options: MountOptions = {}): Promise<SpaceSession> {
    const result = await this.request<{ sessionId: string; serverSeq: number }>({
      type: "session.open",
      requestId: this.nextRequestId(),
      space,
      session: options,
    });

    return new SpaceSession(this, space, result.sessionId, result.serverSeq);
  }

  async request<Result>(message: Record<string, unknown>): Promise<Result> {
    const requestId = message.requestId as string;
    const pending = Promise.withResolvers<unknown>();
    this.#pending.set(requestId, pending);
    await this.transport.send(JSON.stringify(message));
    const result = await pending.promise as ResponseMessage<Result>;
    if (result.error) {
      throw new Error(result.error.message);
    }
    return result.ok as Result;
  }

  registerSubscription(id: string, view: QueryView): void {
    this.#subscriptions.set(id, view);
  }

  private async hello(): Promise<void> {
    const ack = Promise.withResolvers<void>();
    const requestId = this.nextRequestId();
    this.#pending.set(requestId, {
      resolve(message) {
        if ((message as ServerMessage).type === "hello.ok") {
          ack.resolve();
        } else {
          ack.reject(new Error("Expected hello.ok"));
        }
      },
      reject: ack.reject,
      promise: ack.promise,
    } as PromiseWithResolvers<unknown>);
    await this.transport.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
      requestId,
    }));
    await ack.promise;
    this.#pending.delete(requestId);
  }

  private onMessage(payload: string): void {
    const message = JSON.parse(payload) as unknown;
    if (isHelloOk(message)) {
      const pending = this.#pending.values().next().value;
      pending?.resolve(message);
      return;
    }
    if (isGraphUpdate(message)) {
      this.#subscriptions.get(message.subscriptionId)?.push(message.result);
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
}

export class SpaceSession {
  constructor(
    private readonly client: Client,
    readonly space: string,
    readonly sessionId: string,
    readonly serverSeq: number,
  ) {}

  async transact(commit: ClientCommit): Promise<AppliedCommit> {
    return await this.client.request<AppliedCommit>({
      type: "transact",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.sessionId,
      commit,
    });
  }

  async queryGraph(query: GraphQuery): Promise<QueryView> {
    const result = await this.client.request<GraphQueryResult>({
      type: "graph.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.sessionId,
      query,
    });

    const view = new QueryView(result);
    if (result.subscriptionId) {
      this.client.registerSubscription(result.subscriptionId, view);
    }
    return view;
  }
}

export class QueryView {
  #queue: GraphQueryResult[] = [];
  #pending = new Set<PromiseWithResolvers<IteratorResult<GraphQueryResult>>>();
  entities: EntitySnapshot[];

  constructor(initial: GraphQueryResult) {
    this.entities = initial.entities;
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
    const pending = this.#pending.values().next().value;
    if (pending) {
      this.#pending.delete(pending);
      pending.resolve({ done: false, value: result });
      return;
    }
    this.#queue.push(result);
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
