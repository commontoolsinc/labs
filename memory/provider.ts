import * as Memory from "./memory.ts";
import type {
  AsyncResult,
  Await,
  Cause,
  Changes,
  CloseResult,
  Commit,
  CommitData,
  ConnectionError,
  ConsumerCommandInvocation,
  ConsumerInvocationFor,
  ConsumerResultFor,
  Fact,
  FactSelection,
  Invocation,
  InvocationURL,
  MemorySession,
  MemorySpace,
  Proto,
  Protocol as Protocol,
  ProviderCommand,
  ProviderCommandFor,
  ProviderSession,
  Query,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaQuery,
  Select,
  Selection,
  Subscribe,
  Subscriber,
  The,
  Transaction,
  UCAN,
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
import { Fact as FactModule, SelectionBuilder } from "./lib.ts";
import { assert } from "@std/assert/assert";

// Convenient shorthand so I don't need this long type for this string
type JobId = InvocationURL<Reference<ConsumerCommandInvocation<Protocol>>>;

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

  invoke<Ability>(
    ucan: UCAN<ConsumerInvocationFor<Ability, Protocol>>,
  ): Await<ConsumerResultFor<Ability, Protocol>>;

  close(): CloseResult;
}

interface Session {
  memory: MemorySession;
}

class MemoryProvider<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> implements Provider<MemoryProtocol> {
  sessions: Set<ProviderSession<MemoryProtocol>> = new Set();
  #localSession: MemoryProviderSession<Space, MemoryProtocol> | null = null;
  constructor(public memory: MemorySession) {}

  invoke<Ability>(
    ucan: UCAN<ConsumerInvocationFor<Ability, MemoryProtocol>>,
  ): Await<ConsumerResultFor<Ability, MemoryProtocol>> {
    let session = this.#localSession;
    if (!session) {
      session = new MemoryProviderSession(this.memory, null);
    }

    return session.invoke(
      ucan as unknown as UCAN<ConsumerCommandInvocation<Protocol>>,
    );
  }

  fetch(request: Request) {
    return fetch(this, request);
  }

  session(): ProviderSession<MemoryProtocol> {
    const session = new MemoryProviderSession(
      this.memory,
      this.sessions,
    );
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

export class SchemaSubscription {
  constructor(
    public invocation: SchemaQuery,
    public watchedObjects: Set<string>,
    public since: number = -1,
  ) {}
}

class MemoryProviderSession<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> implements ProviderSession<MemoryProtocol>, Subscriber {
  readable: ReadableStream<ProviderCommand<MemoryProtocol>>;
  writable: WritableStream<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>;
  controller:
    | ReadableStreamDefaultController<ProviderCommand<MemoryProtocol>>
    | undefined;

  channels: Map<InvocationURL<Reference<Subscribe>>, Set<string>> = new Map();
  schemaChannels: Map<JobId, SchemaSubscription> = new Map();

  constructor(
    public memory: MemorySession,
    public sessions: null | Set<ProviderSession<MemoryProtocol>>,
  ) {
    this.readable = new ReadableStream<ProviderCommand<MemoryProtocol>>({
      start: (controller) => this.open(controller),
      cancel: (_reason?) => this.cancel(),
    });
    this.writable = new WritableStream<
      UCAN<ConsumerCommandInvocation<MemoryProtocol>>
    >({
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
  perform<Ability extends string>(
    command: ProviderCommandFor<Ability, MemoryProtocol>,
  ) {
    this.controller?.enqueue(command as ProviderCommand<MemoryProtocol>);
    return { ok: {} };
  }
  open(
    controller: ReadableStreamDefaultController<
      ProviderCommand<MemoryProtocol>
    >,
  ) {
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
  async invoke(
    { invocation, authorization }: UCAN<ConsumerCommandInvocation<Protocol>>,
  ) {
    const { error } = await Access.claim(
      invocation,
      authorization,
      this.memory.serviceDid(),
    );

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
          is: (await this.memory.query(invocation)) as Result<
            Selection<Space>,
            QueryError
          >,
        });
      }
      case "/memory/graph/query": {
        const result = await this.memory.querySchema(invocation);
        if (invocation.args.subscribe && result.ok !== undefined) {
          this.addSchemaSubscription(of, invocation, result.ok);
        }
        return this.perform({
          the: "task/return",
          of,
          is: result,
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
        const selector = ("select") in invocation.args
          ? invocation.args.select
          : invocation.args.selectSchema;
        this.channels.set(
          of,
          new Set(
            Subscription.channels(invocation.sub, selector),
          ),
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
          error: new RangeError(
            `Unknown command ${(invocation as Invocation).cmd}`,
          ),
        };
      }
    }
  }

  async commit(commit: Commit<Space>) {
    // First, check to see if any of our schema queries need to be notified
    const [lastId, maxSince, facts] = await this.getSchemaSubscriptionMatches(
      commit,
    );
    // It doesn't really matter who we say we're responding to as long as we
    // return all the relevant objects, the client will dispatch.
    // It is important that we send it to the right kind of listener.
    if (lastId !== undefined) {
      //this.setCommitData(commit, maxSince, changes);
      console.log("Sending facts", facts, "to", lastId);
      this.perform({
        the: "task/effect",
        of: lastId,
        is: facts,
      });
    }

    for (const [id, channels] of this.channels) {
      if (Subscription.match(commit, channels)) {
        // Note that we don't exit on the first match anymore because we need
        // to keep these subscriptions distinct.
        this.perform({
          the: "task/effect",
          of: id,
          is: commit,
        });
      }
    }

    return { ok: {} };
  }

  private addSchemaSubscription<Space extends MemorySpace>(
    of: JobId,
    invocation: SchemaQuery<Space>,
    result: Selection<Space>,
  ) {
    const factSelection = result[invocation.sub];
    const factVersions = Array.from(FactModule.iterate(factSelection));
    const includedFacts = new Set(
      factVersions.map((fv) => Subscription.formatAddress(fv)),
    );
    const since = factVersions.reduce(
      (acc, cur, _i) => cur.since > acc ? cur.since : acc,
      -1,
    );
    const subscription = new SchemaSubscription(
      invocation,
      includedFacts,
      since,
    );
    this.schemaChannels.set(of, subscription);
  }

  private async getSchemaSubscriptionMatches(
    commit: Commit<Space>,
  ): Promise<[JobId | undefined, number, Selection<Space>]> {
    const schemaMatches = new Map<string, Revision<Fact>>();
    let maxSince = -1;
    let lastId;
    const [[space, _attributes]] = Object.entries(commit);
    // Eventually, we should support multiple spaces, but currently the since handling is per-space
    // Our websockets are also per-space, so there's larger issues involved.
    for (const [id, subscription] of this.schemaChannels) {
      if (Subscription.match(commit, subscription.watchedObjects)) {
        const result = await this.memory.querySchema(subscription.invocation);
        const factSelection = result.ok![space as Space];
        const factVersions = Array.from(FactModule.iterate(factSelection));
        const includedFacts = new Map(
          factVersions.map((fv) => [Subscription.formatAddress(fv), fv]),
        );
        const since = factVersions.reduce(
          (acc, cur, _i) => cur.since > acc ? cur.since : acc,
          -1,
        );
        // We only need to include the facts that are newer than our query
        const newFacts = includedFacts.entries().filter((
          [address, factVersion],
        ) =>
          factVersion.since > subscription.since ||
          !subscription.watchedObjects.has(address)
        );
        for (const [address, factVersion] of newFacts) {
          schemaMatches.set(address, factVersion);
        }
        // Update our subscription
        subscription.watchedObjects = new Set(includedFacts.keys());
        subscription.since = since;
        lastId = id;
        maxSince = since > maxSince ? since : maxSince;
      }
    }
    const selection = SelectionBuilder.from(
      schemaMatches.values().map((item) => [item, item.since]),
    );
    const selectionSpace = { [space]: selection } as Selection<Space>;
    return [lastId, maxSince, selectionSpace];
  }
}

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
    const transaction = await request.json() as Transaction;
    const result = await session.memory.transact(transaction);
    const body = JSON.stringify(result);
    const status = result.ok
      ? 200
      : result.error.name === "ConflictError"
      ? 409
      : 503;

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
    const selector = await request.json() as Query;
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
