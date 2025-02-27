import * as Memory from "./memory.ts";
import type {
  AsyncResult,
  ConnectionError,
  Transaction,
  MemorySession,
  Query,
  Protocol as Protocol,
  ProviderCommand,
  ConsumerCommandInvocation,
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
  UCAN,
  Invocation,
  Proto,
  MemorySpace,
  ProviderCommandFor,
} from "./interface.ts";
import * as Subscription from "./subscription.ts";

export * from "./interface.ts";
export * from "./util.ts";
export * as Error from "./error.ts";
export * as Space from "./space.ts";
export * as Memory from "./memory.ts";
export * as Subscription from "./subscription.ts";
import { refer } from "./reference.ts";
import * as Access from "./access.ts";

export const open = async (
  options: Memory.Options,
): AsyncResult<Provider<Protocol>, ConnectionError> => {
  const result = await Memory.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new MemoryProvider(result.ok) };
};

export interface Provider<Protocol extends Proto> {
  fetch(request: Request): Promise<Response>;

  session(): ProviderSession<Protocol>;

  close(): CloseResult;

  transact(transaction: Transaction): TransactionResult;
  query(source: Query): QueryResult;
}

interface Session {
  memory: MemorySession;
}

class MemoryProvider<Space extends MemorySpace, MemoryProtocol extends Protocol<Space>>
  implements Provider<MemoryProtocol>
{
  sessions: Set<ProviderSession<MemoryProtocol>> = new Set();
  constructor(public memory: MemorySession) {}
  subscribe(subscriber: Subscriber) {
    return subscribe(this, subscriber);
  }

  transact(source: Transaction<Space>) {
    return transact(this, source);
  }
  query(source: Query<Space>) {
    return query(this, source);
  }
  fetch(request: Request) {
    return fetch(this, request);
  }
  session(): ProviderSession<MemoryProtocol> {
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

class MemoryProviderSession<Space extends MemorySpace, MemoryProtocol extends Protocol<Space>>
  implements ProviderSession<MemoryProtocol>, Subscriber
{
  readable: ReadableStream<ProviderCommand<MemoryProtocol>>;
  writable: WritableStream<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>;
  controller: ReadableStreamDefaultController<ProviderCommand<MemoryProtocol>> | undefined;

  channels: Map<InvocationURL<Reference<Subscribe>>, Set<string>> = new Map();

  constructor(
    public memory: MemorySession,
    public sessions: null | Set<ProviderSession<MemoryProtocol>>,
  ) {
    this.readable = new ReadableStream<ProviderCommand<MemoryProtocol>>({
      start: (controller) => this.open(controller),
      cancel: () => this.cancel(),
    });
    this.writable = new WritableStream<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>({
      write: async (command) => {
        await this.invoke(command as UCAN<ConsumerCommandInvocation<Protocol>>);
      },
      abort: async () => {
        await this.close();
      },
      close: async () => {
        await this.close();
      },
    });
  }
  perform<Ability extends string>(command: ProviderCommandFor<Ability, MemoryProtocol>) {
    this.controller?.enqueue(command as ProviderCommand<MemoryProtocol>);
    return { ok: {} };
  }
  open(controller: ReadableStreamDefaultController<ProviderCommand<MemoryProtocol>>) {
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
  async invoke({ invocation, authorization }: UCAN<ConsumerCommandInvocation<Protocol>>) {
    const { error } = await Access.claim(invocation, authorization);
    if (error) {
      return this.perform({
        the: "task/return",
        of: `job:${refer(invocation)}` as InvocationURL<
          Reference<ConsumerCommandInvocation<MemoryProtocol>>
        >,
        is: { error },
      });
    }

    const of = `job:${refer(invocation)}` as InvocationURL<
      Reference<ConsumerCommandInvocation<Protocol>>
    >;

    switch (invocation.cmd) {
      case "/memory/query": {
        return this.perform({
          the: "task/return",
          of,
          is: (await this.memory.query(invocation)) as Result<Selection<Space>, QueryError>,
        });
      }
      case "/memory/transact": {
        return this.perform({
          the: "task/return",
          of,
          is: await this.memory.transact(invocation),
        });
      }
      case "/memory/query/subscribe": {
        this.channels.set(
          of,
          new Set(Subscription.channels(invocation.sub, invocation.args.select)),
        );
        return this.memory.subscribe(this);
      }
      case "/memory/query/unsubscribe": {
        this.channels.delete(of);
        if (this.channels.size === 0) {
          this.memory.unsubscribe(this);
        }

        // End subscription call
        this.perform({
          the: "task/return",
          of: invocation.args.source,
          is: { ok: {} },
        });

        // End unsubscribe call
        return this.perform({
          the: "task/return",
          of,
          is: { ok: {} },
        });
      }
      default: {
        return {
          error: new RangeError(`Unknown command ${(invocation as Invocation).cmd}`),
        };
      }
    }
  }

  transact(transaction: Transaction<Space>) {
    for (const [id, channels] of this.channels) {
      if (Subscription.match(transaction, channels)) {
        // Note that we intentionally exit on the first match because we do not
        // want to send same transaction multiple times to the same consumer.
        // Consumer does it's own bookkeeping of all the subscriptions and will
        // distribute transaction to all of them locally.
        return this.perform({
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
    return await patch(session, request);
  } else if (request.method === "POST") {
    return await post(session, request);
  } else {
    return new Response(null, { status: 501 });
  }
};

export const patch = async (session: Session, request: Request) => {
  try {
    const transaction = (await request.json()) as Transaction;
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
