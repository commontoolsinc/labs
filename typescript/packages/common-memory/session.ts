import {
  MemorySpace,
  SpaceSession,
  Selector,
  TransactionResult,
  QueryResult,
  Query,
  Transaction,
  Session,
  CloseResult,
  Principal,
  SubscriptionCommand,
  SubscriberCommand,
  Subscriber,
  FactSelection,
  Changes,
} from "./interface.ts";
import * as QueryBuilder from "./query.ts";
import * as TransactionBuilder from "./transaction.ts";
import * as Socket from "./socket.ts";
import * as Delta from "./changes.ts";
import * as Fact from "./fact.ts";

export type LocalConnection<Space extends MemorySpace> = {
  subject: Space;
  as: Principal;
  session: SpaceSession<Space>;
};

export type RemoteConnection<Space extends MemorySpace> = {
  subject: Space;
  as: Principal;
  url: URL;
  fetch?: (request: Request) => Promise<Response>;
  connect?: (url: URL) => WebSocket;
};

export type Address<Space extends MemorySpace> =
  | { local: LocalConnection<Space>; remote?: undefined }
  | { remote: RemoteConnection<Space>; local?: undefined };

export interface AgentSession<Space extends MemorySpace = MemorySpace> {
  transact(changes: Changes<Space>): TransactionResult<Space>;
  query(source: { select: Selector; since?: number }): QueryResult<Space>;
  close(): CloseResult;
}

export const open = <Space extends MemorySpace>(address: Address<Space>) =>
  address.local
    ? new Agent(address.local.subject, address.local.as, address.local.session)
    : new Agent(address.remote.subject, address.remote.as, new RemoteSession(address.remote));

class RemoteSession<Space extends MemorySpace> implements Session<Space> {
  subject: Space;
  url: URL;
  fetch: Required<RemoteConnection<Space>>["fetch"];
  connect: Required<RemoteConnection<Space>>["connect"];
  controller: AbortController;
  socket: WebSocket | null;

  constructor({
    subject,
    url,
    fetch = globalThis.fetch,
    connect = (url: URL) => new globalThis.WebSocket(url),
  }: RemoteConnection<Space>) {
    this.subject = subject;
    this.url = url;
    this.fetch = fetch;
    this.connect = connect;

    this.controller = new AbortController();
    this.socket = null;
  }

  async query(source: Query<Space>) {
    const response = await this.fetch(
      new Request(this.url, {
        method: "post",
        body: JSON.stringify(source),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        signal: this.controller.signal,
      }),
    );

    const result = await response.json();

    return result as QueryResult;
  }
  async transact(source: Transaction<Space>) {
    const response = await this.fetch(
      new Request(this.url, {
        method: "patch",
        body: JSON.stringify(source),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        signal: this.controller.signal,
      }),
    );

    const result = await response.json();

    return result as TransactionResult<Space>;
  }

  subscribe(subscriber: Subscriber) {
    this.socket = this.connect(this.url);
    subscriber.readable
      .pipeThrough(Socket.from<SubscriptionCommand, SubscriberCommand>(this.socket))
      .pipeTo(subscriber.writable);
  }

  close(): CloseResult {
    this.controller.abort();
    if (this.socket) {
      this.socket.close();
    }
    return { ok: {} };
  }
}

class Agent<Space extends MemorySpace> implements AgentSession<Space> {
  constructor(public subject: Space, public as: Principal, public session: Session<Space>) {}
  async query({ select, since }: { select: Selector; since?: number }) {
    const query = QueryBuilder.create({
      issuer: this.as,
      subject: this.subject,
      select,
      since,
    });

    return this.session.query(query);
  }
  async transact(changes: Changes<Space>) {
    const transaction = TransactionBuilder.create({
      issuer: this.as,
      subject: this.subject,
      changes,
    });

    return this.session.transact(transaction);
  }

  close() {
    return this.session.close();
  }
}

class MemoryAgent<Space extends MemorySpace> {
  constructor(
    public as: Principal,
    public session: Session<Space>,
    public spaces: Map<Space, Agent<Space>>,
  ) {}

  use<Subject extends Space>(space: Subject) {
    return new Agent(space, this.as, this.session);
  }

  watch({ select, since, space }: { space: Space; select: Selector; since?: number }) {
    const query = QueryBuilder.create({
      issuer: this.as,
      subject: space,
      select,
      since,
    });

    this.session;
  }
  unwatch({ select, since, space }: { space: Space; select: Selector; since?: number }) {
    const query = QueryBuilder.create({
      issuer: this.as,
      subject: space,
      select,
      since,
    });
  }
}

class QuerySubscription<Space extends MemorySpace> extends ReadableStream<FactSelection> {
  controller: ReadableStreamDefaultController<FactSelection> | undefined;
  constructor(public query: Query<Space>, public selection: FactSelection) {
    super({
      start: (controller) => this.open(controller),
    });
  }
  open(controller: ReadableStreamDefaultController<FactSelection>) {
    this.controller = controller;
  }
  transact(transaction: Transaction) {
    const selection = this.selection;
    const changed = {};
    for (const [of, attributes] of Object.entries(transaction.args.changes)) {
      for (const [the, changes] of Object.entries(attributes)) {
        const [[cause, change]] = Object.entries(changes);
        if (change !== true) {
          const state = Object.entries(selection?.[of]?.[the] ?? {});
          const [current] = state.length > 0 ? state[0] : [];
          if (cause !== current) {
            Delta.set(changed, [of, the], cause, change);
            Delta.set(selection, [of, the], cause, change);
          }
        }
      }
    }

    if (Object.keys(changed).length > 0) {
      this.integrate(changed);
    }
  }
  [Symbol.iterator]() {
    return Fact.iterate(this.selection);
  }
  integrate(differential: FactSelection) {
    this.controller?.enqueue(differential);
  }
}
