import * as Memory from "./memory.ts";
import type {
  AsyncResult,
  ConnectionError,
  Transaction,
  MemorySession,
  Query,
  Protocol as Protocol,
  ProviderCommand,
  ConsumerCommand,
  Subscriber,
  ProviderSession,
  Reference,
  Subscribe,
  CloseResult,
  QueryError,
  Result,
  Selection,
  InvocationURL,
  TransactionResult,
  QueryResult,
} from "./interface.ts";
import * as Subscription from "./subscription.ts";

export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Space from "./space.ts";
export * as Memory from "./memory.ts";
export * as Subscriber from "./subscriber.ts";
export * as Subscription from "./subscription.ts";
import { refer, fromString } from "./reference.ts";

export const open = async (options: Memory.Options): AsyncResult<Provider, ConnectionError> => {
  const result = await Memory.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new MemoryProvider(result.ok) };
};

export interface Provider {
  fetch(request: Request): Promise<Response>;

  session(): ProviderSession<Protocol>;

  close(): CloseResult;

  transact(transaction: Transaction): TransactionResult;
  query(source: Query): QueryResult;
}

interface Session {
  memory: MemorySession;
}

class MemoryProvider implements Provider, Session {
  sessions: Set<ProviderSession<Protocol>> = new Set();
  constructor(public memory: MemorySession) {}
  subscribe(subscriber: Subscriber) {
    return subscribe(this, subscriber);
  }

  transact(source: Transaction) {
    return transact(this as Session, source);
  }
  query(source: Query) {
    return query(this as Session, source);
  }
  fetch(request: Request) {
    return fetch(this as Session, request);
  }
  session(): ProviderSession<Protocol> {
    const session = new MemoryProviderSession(this.memory, this.sessions);
    this.sessions.add(session);
    return session;
  }

  async close() {
    const promises = [];
    for (const session of this.sessions) {
      promises.push(session.close());
    }

    await Promise.all(promises);
    return this.memory.close();
  }
}

class MemoryProviderSession implements ProviderSession<Protocol>, Subscriber {
  readable: ReadableStream<ProviderCommand<Protocol>>;
  writable: WritableStream<ConsumerCommand<Protocol>>;
  controller: ReadableStreamDefaultController<ProviderCommand<Protocol>> | undefined;

  channels: Map<InvocationURL<Reference<Subscribe>>, Set<string>> = new Map();

  constructor(
    public memory: MemorySession,
    public sessions: null | Set<ProviderSession<Protocol>>,
  ) {
    this.readable = new ReadableStream<ProviderCommand<Protocol>>({
      start: (controller) => this.open(controller),
      cancel: () => this.cancel(),
    });
    this.writable = new WritableStream<ConsumerCommand<Protocol>>({
      write: async (command) => {
        await this.invoke(command);
      },
      abort: async () => {
        this.close();
      },
      close: async () => {
        this.close();
      },
    });
  }
  perform(command: ProviderCommand<Protocol>) {
    this.controller?.enqueue(command);
    return { ok: {} };
  }
  open(controller: ReadableStreamDefaultController<ProviderCommand<Protocol>>) {
    this.controller = controller;
  }
  cancel() {
    const promise = this.writable.close();
    this.dispose();
    return promise;
  }
  close() {
    this.controller?.close();
    this.dispose();

    return { ok: {} };
  }
  dispose() {
    this.controller = undefined;
    this.sessions?.delete(this);
    this.sessions = null;
  }
  async invoke(command: ConsumerCommand<Protocol>) {
    switch (command.cmd) {
      case "/memory/query": {
        return this.perform({
          the: "task/return",
          of: `job:${refer(command)}` as InvocationURL<Reference<ConsumerCommand<Protocol>>>,
          is: (await this.memory.query(command)) as Result<Selection, QueryError>,
        });
      }
      case "/memory/transact": {
        return this.perform({
          the: "task/return",
          of: `job:${refer(command)}` as InvocationURL<Reference<ConsumerCommand<Protocol>>>,
          is: await this.memory.transact(command),
        });
      }
      case "/memory/query/subscribe": {
        const id = `job:${refer(command)}` as InvocationURL<Subscribe>;
        this.channels.set(id, new Set(Subscription.channels(command.sub, command.args.select)));
        return this.memory.subscribe(this);
      }
      case "/memory/query/unsubscribe": {
        const id = command.args.source;
        this.channels.delete(id);
        if (this.channels.size === 0) {
          this.memory.unsubscribe(this);
        }

        // End subscription call
        this.perform({
          the: "task/return",
          of: command.args.source,
          is: { ok: {} },
        });

        // End unsubscribe call
        this.perform({
          the: "task/return",
          of: `job:${refer(command)}` as InvocationURL<Reference<ConsumerCommand<Protocol>>>,
          is: { ok: {} },
        });
      }
    }
    return { ok: {} };
  }

  transact(transaction: Transaction) {
    for (const [id, channels] of this.channels) {
      if (Subscription.match(transaction, channels)) {
        this.perform({
          the: "task/effect",
          of: id,
          is: transaction,
        });
      }
    }

    return { ok: {} };
  }
}

export const transact = ({ memory }: Session, transaction: Transaction) =>
  memory.transact(transaction);

export const query = ({ memory }: Session, source: Query) => memory.query(source);

export const subscribe = ({ memory }: Session, subscriber: Subscriber) =>
  memory.subscribe(subscriber);

export const close = ({ memory }: Session) => memory.close();

export const fetch = async (session: Session, request: Request) => {
  if (request.method === "PATCH") {
    return patch(session, request);
  } else if (request.method === "POST") {
    return post(session, request);
  } else {
    return new Response(null, { status: 501 });
  }
};

export const patch = async (session: Session, request: Request) => {
  try {
    const transaction: Transaction = await request.json();
    const result = await session.memory.transact(transaction);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : result.error.name === "ConflictError" ? 409 : 503;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    const error = cause as Partial<Error>;
    return new Response(
      JSON.stringify({
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? "Unable to parse request body",
          stack: error?.stack ?? "",
        },
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};

export const post = async (session: Session, request: Request) => {
  try {
    const selector = (await request.json()) as Query;
    const result = await session.memory.query(selector);
    const body = JSON.stringify(result);
    const status = result.ok ? 200 : 404;

    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    const error = cause as Partial<Error>;
    return new Response(
      JSON.stringify({
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? "Unable to parse request body",
          stack: error?.stack ?? "",
        },
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};
