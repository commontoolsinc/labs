import * as Access from "./access.ts";
import {
  AsyncResult,
  Await,
  CloseResult,
  Commit,
  ConnectionError,
  ConsumerCommandInvocation,
  ConsumerInvocationFor,
  ConsumerResultFor,
  EnhancedCommit,
  Fact,
  FactAddress,
  Invocation,
  InvocationURL,
  MemorySession,
  MemorySpace,
  Proto,
  Protocol,
  ProviderCommand,
  ProviderCommandFor,
  ProviderSession,
  Query,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaQuery,
  Selection,
  Subscribe,
  Subscriber,
  Transaction,
  UCAN,
} from "./interface.ts";
import * as SelectionBuilder from "./selection.ts";
import * as Memory from "./memory.ts";
import { refer } from "./reference.ts";
import { redactCommitData } from "./space.ts";
import * as Subscription from "./subscription.ts";
import * as FactModule from "./fact.ts";
import { setRevision } from "@commontools/memory/selection";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("memory-provider", {
  enabled: true,
  level: "info",
});

export * as Error from "./error.ts";
export * from "./interface.ts";
export * as Memory from "./memory.ts";
export * as Space from "./space.ts";
export * as Subscription from "./subscription.ts";
export * from "./util.ts";

// Convenient shorthand so I don't need this long type for this string
type JobId = InvocationURL<Reference<ConsumerCommandInvocation<Protocol>>>;
export type Options = Memory.Options;

export const open = async (
  options: Options,
): AsyncResult<Provider<Protocol>, ConnectionError> => {
  const result = await Memory.open(options);
  if (result.error) {
    return result;
  }

  return { ok: new MemoryProvider(result.ok) };
};

/**
 * Creates an ephemeral memory provider. It does not persist anything
 * and it's primary use is in testing.
 */
export const emulate = (options: Memory.ServiceOptions): Provider<Protocol> =>
  new MemoryProvider(Memory.emulate(options));

export const create = (memory: MemorySession): Provider<Protocol> =>
  new MemoryProvider(memory);

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
  // Mapping from fact key to since value of the last fact sent to the client
  lastRevision: Map<string, number> = new Map();

  constructor(
    public memory: MemorySession,
    public sessions: null | Set<ProviderSession<MemoryProtocol>>,
  ) {
    this.readable = new ReadableStream<ProviderCommand<MemoryProtocol>>({
      start: (controller) => {
        try {
          return this.open(controller);
        } catch (error) {
          logger.error(() => ["ReadableStream start error:", error]);
          throw error;
        }
      },
      cancel: (reason) => {
        try {
          return this.cancel();
        } catch (error) {
          logger.error(
            () => ["ReadableStream cancel error:", error, "Reason:", reason],
          );
          throw error;
        }
      },
    });
    this.writable = new WritableStream<
      UCAN<ConsumerCommandInvocation<MemoryProtocol>>
    >({
      write: async (command) => {
        try {
          await this.invoke(
            command as UCAN<ConsumerCommandInvocation<Protocol>>,
          );
        } catch (error) {
          logger.error(() => ["WritableStream write error:", error]);
          logger.error(() => ["Failed command:", JSON.stringify(command)]);
          throw error;
        }
      },
      abort: async (reason) => {
        try {
          logger.debug(
            () => ["WritableStream abort called with reason:", reason],
          );
          await this.close();
        } catch (error) {
          logger.error(() => ["WritableStream abort error:", error]);
          throw error;
        }
      },
      close: async () => {
        try {
          logger.debug(() => ["WritableStream close called"]);
          await this.close();
        } catch (error) {
          logger.error(() => ["WritableStream close error:", error]);
          throw error;
        }
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
    this.memory.unsubscribe(this);
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
      logger.error(
        () => [
          "Authorization error:",
          error,
          ", failed invocation:",
          invocation,
        ],
      );
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
        // We maintain subscriptions at this level, but really need more data from the query response
        if (invocation.args.subscribe && result.ok !== undefined) {
          this.addSchemaSubscription(of, invocation, result.ok);
          this.memory.subscribe(this);
        }
        // Filter out any known results
        if (result.ok !== undefined && invocation.args.excludeSent) {
          const space = invocation.sub;
          const factSelection = result.ok[space];
          const factVersions = [...FactModule.iterate(factSelection)];
          result.ok[space] = this.toSelection(
            this.filterKnownFacts(factVersions),
          );
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
    // We should really only have one item, but it's technically legal to have
    // multiple transactions in the same commit, so iterate
    for (
      const item of SelectionBuilder.iterate<{ is: Memory.CommitData }>(commit)
    ) {
      // We need to remove any classified results from our commit.
      // The schema subscription has a classification claim, but these don't.
      const redactedData = redactCommitData(item.value.is);
      if (Subscription.isTransactionReadOnly(redactedData.transaction)) {
        continue;
      }
      // First, check to see if any of our schema queries need to be notified
      // Any queries that lack access are skipped (with a console log)
      const [lastId, maxSince, facts] = await this.getSchemaSubscriptionMatches(
        redactedData.transaction,
      );

      const jobIds: InvocationURL<Reference<Subscribe>>[] = [];
      for (const [id, channels] of this.channels) {
        if (Subscription.match(redactedData.transaction, channels)) {
          jobIds.push(id);
        }
      }

      if (jobIds.length > 0) {
        // The client has a subscription to the space's commit log, but our
        // subscriptions may trigger inclusion of other objects. Add these here.
        const enhancedCommit: EnhancedCommit<Space> = {
          commit: {
            [item.of]: { [item.the]: { [item.cause]: { is: redactedData } } },
          } as Commit<Space>,
          revisions: this.filterKnownFacts(facts),
        };

        for (const id of jobIds) {
          // this is sent to a standard subscription (application/commit+json)
          this.perform({
            the: "task/effect",
            of: id,
            is: enhancedCommit,
          });
        }
      }
    }
    return { ok: {} };
  }

  private filterKnownFacts(
    factVersions: Revision<Fact>[],
  ): Revision<Fact>[] {
    // Filter out any known results
    const newFactsList = [];
    for (const fact of factVersions) {
      const factKey = this.toKey(fact);
      const previous = this.lastRevision.get(factKey);
      if (previous === undefined || previous < fact.since) {
        this.lastRevision.set(factKey, fact.since);
        newFactsList.push(fact);
      }
    }
    return newFactsList;
  }

  private toSelection(factVersions: Revision<Fact>[]) {
    const selection: Memory.OfTheCause<
      { is?: Memory.JSONValue; since: number }
    > = {};
    for (const fact of factVersions) {
      setRevision(selection, fact.of, fact.the, fact.cause.toString(), {
        is: fact.is,
        since: fact.since,
      });
    }
    return selection;
  }

  private formatAddress<Space extends MemorySpace>(
    space: Space,
    fv: Readonly<FactAddress>,
  ) {
    return Subscription.formatAddress({ at: space, the: fv.the, of: fv.of });
  }

  private toKey(fv: Readonly<FactAddress>) {
    return `${fv.of}/${fv.the}`;
  }

  private addSchemaSubscription<Space extends MemorySpace>(
    of: JobId,
    invocation: SchemaQuery<Space>,
    result: Selection<Space>,
  ) {
    const space = invocation.sub;
    const factSelection = result[space];
    const factVersions = [...FactModule.iterate(factSelection)];
    const includedFacts = new Set(
      factVersions.map((fv) => this.formatAddress(space, fv)),
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

  private async getSchemaSubscriptionMatches<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Promise<[JobId | undefined, number, Revision<Fact>[]]> {
    const schemaMatches = new Map<string, Revision<Fact>>();
    const space = transaction.sub;
    let maxSince = -1;
    let lastId;
    // Eventually, we should support multiple spaces, but currently the since handling is per-space
    // Our websockets are also per-space, so there's larger issues involved.
    for (const [id, subscription] of this.schemaChannels) {
      if (
        Subscription.match(transaction, subscription.watchedObjects)
      ) {
        // Re-run our original query, but not as a subscription
        const newArgs = { ...subscription.invocation.args, subscribe: false };
        const newInvocation = { ...subscription.invocation, args: newArgs };
        // We need to bypass the perform queue to avoid a deadlock
        const result = await Memory.querySchema(
          this.memory as Memory.Memory,
          newInvocation,
        );
        if (result.error) {
          console.warn("Encountered querySchema error", result.error);
          continue;
        }
        const factSelection = result.ok![space];
        const factVersions = [...FactModule.iterate(factSelection)];
        const includedFacts = new Map(
          factVersions.map((fv) => [this.formatAddress(space, fv), fv]),
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
    return [lastId, maxSince, [...schemaMatches.values()]];
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
