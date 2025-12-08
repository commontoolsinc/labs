import * as Access from "./access.ts";
import {
  ACL,
  AsyncResult,
  Await,
  CauseString,
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
import { refer, fromString as causeFromString } from "./reference.ts";
import { redactCommitData, selectFact, type Session as SpaceSession } from "./space.ts";
import { evaluateDocumentLinks } from "./space-schema.ts";
import * as Subscription from "./subscription.ts";
import * as FactModule from "./fact.ts";
import { setRevision } from "@commontools/memory/selection";
import { getLogger } from "@commontools/utils/logger";
import { ACL_TYPE, isACL } from "./acl.ts";
import { MapSet } from "@commontools/runner/traverse";
import { deepEqual } from "@commontools/runner";
import type { SchemaPathSelector } from "./consumer.ts";

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
    // Track which docs were scanned with which schemas for incremental updates
    public schemaTracker: MapSet<string, SchemaPathSelector> = new MapSet(
      deepEqual,
    ),
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
          logger.error(
            "stream-error",
            () => ["ReadableStream start error:", error],
          );
          throw error;
        }
      },
      cancel: (reason) => {
        try {
          return this.cancel();
        } catch (error) {
          logger.error(
            "stream-error",
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
          logger.error(
            "stream-error",
            () => ["WritableStream write error:", error],
          );
          logger.error(
            "stream-error",
            () => ["Failed command:", JSON.stringify(command)],
          );
          throw error;
        }
      },
      abort: async (reason) => {
        try {
          logger.debug(
            "stream-abort",
            () => ["WritableStream abort called with reason:", reason],
          );
          await this.close();
        } catch (error) {
          logger.error(
            "stream-error",
            () => ["WritableStream abort error:", error],
          );
          throw error;
        }
      },
      close: async () => {
        try {
          logger.debug("stream-close", () => ["WritableStream close called"]);
          await this.close();
        } catch (error) {
          logger.error(
            "stream-error",
            () => ["WritableStream close error:", error],
          );
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
    const acl = await this.getAcl(invocation.sub);
    const { error } = await Access.claim(
      invocation,
      authorization,
      this.memory.serviceDid(),
      acl,
    );

    if (error) {
      logger.error(
        "auth-error",
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
        // Use querySchemaWithTracker when subscribing to capture the schemaTracker
        // for incremental updates on subsequent commits
        if (invocation.args.subscribe) {
          const trackerResult = await Memory.querySchemaWithTracker(
            this.memory as Memory.Memory,
            invocation,
          );
          if ("error" in trackerResult) {
            return this.perform({
              the: "task/return",
              of,
              is: trackerResult,
            });
          }
          const { selection, schemaTracker } = trackerResult.ok;
          this.addSchemaSubscription(of, invocation, selection, schemaTracker);
          this.memory.subscribe(this);

          // Filter out any known results
          if (invocation.args.excludeSent) {
            const space = invocation.sub;
            const factSelection = selection[space];
            const factVersions = [...FactModule.iterate(factSelection)];
            selection[space] = this.toSelection(
              this.filterKnownFacts(factVersions),
            );
          }
          return this.perform({
            the: "task/return",
            of,
            is: { ok: selection },
          });
        }

        // Non-subscribing queries use the regular querySchema
        const result = await this.memory.querySchema(invocation);
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
        logger.info(
          "server-transact",
          () => [
            "Received transaction:",
            `space: ${invocation.sub}`,
            `changes:`,
            JSON.stringify(invocation.args.changes, null, 2),
          ],
        );
        const result = await this.memory.transact(invocation);
        if (result.error) {
          logger.warn(
            "server-transact-error",
            () => [
              "Transaction failed:",
              JSON.stringify(result.error, null, 2),
            ],
          );
        }
        return this.perform({
          the: "task/return",
          of,
          is: result,
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
      const [_lastId, _maxSince, facts] = await this
        .getSchemaSubscriptionMatches(
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
      setRevision(
        selection,
        fact.of,
        fact.the,
        fact.cause.toString() as CauseString,
        {
          is: fact.is,
          since: fact.since,
        },
      );
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
    schemaTracker?: MapSet<string, SchemaPathSelector>,
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
      schemaTracker ?? new MapSet(deepEqual),
    );
    this.schemaChannels.set(of, subscription);
  }

  /**
   * Incrementally find schema subscription matches after a transaction.
   * Instead of re-running the full query for each subscription, we:
   * 1. Find which changed docs are tracked by each subscription's schemaTracker
   * 2. Re-evaluate just those docs with their schemas to find new links
   * 3. Follow any new links that weren't already tracked
   */
  private async getSchemaSubscriptionMatches<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Promise<[JobId | undefined, number, Revision<Fact>[]]> {
    const schemaMatches = new Map<string, Revision<Fact>>();
    const space = transaction.sub;
    let maxSince = -1;
    let lastId: JobId | undefined;

    // Early exit if no schema subscriptions
    if (this.schemaChannels.size === 0) {
      return [undefined, -1, []];
    }

    // Extract changed document keys from transaction
    const changedDocs = this.extractChangedDocKeys(transaction);
    if (changedDocs.size === 0) {
      return [undefined, -1, []];
    }

    // Get access to the space session for evaluating documents
    const mountResult = await Memory.mount(
      this.memory as Memory.Memory,
      space,
    );
    if (mountResult.error) {
      logger.warn(
        "incremental-mount-error",
        () => ["Failed to mount space for incremental update:", mountResult.error],
      );
      // Fall back to full re-query for all subscriptions
      return this.getSchemaSubscriptionMatchesFallback(transaction);
    }
    const spaceSession = mountResult.ok as unknown as SpaceSession<Space>;

    for (const [id, subscription] of this.schemaChannels) {
      // Find changed docs that are in this subscription's schemaTracker
      const affectedDocs = this.findAffectedDocs(
        changedDocs,
        subscription.schemaTracker,
      );

      if (affectedDocs.length === 0) {
        continue;
      }

      // Process affected docs incrementally
      const result = this.processIncrementalUpdate(
        spaceSession,
        subscription,
        affectedDocs,
        space,
      );

      // Collect new facts
      for (const [address, factVersion] of result.newFacts) {
        if (
          factVersion.since > subscription.since ||
          !subscription.watchedObjects.has(address)
        ) {
          schemaMatches.set(address, factVersion);
          subscription.watchedObjects.add(address);
          if (factVersion.since > subscription.since) {
            subscription.since = factVersion.since;
          }
        }
      }

      if (result.newFacts.size > 0) {
        lastId = id;
        maxSince = Math.max(maxSince, subscription.since);
      }
    }

    return [lastId, maxSince, [...schemaMatches.values()]];
  }

  /**
   * Extract document keys (id/type format) from a transaction's changes.
   */
  private extractChangedDocKeys<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Set<string> {
    const changedDocs = new Set<string>();
    for (const fact of SelectionBuilder.iterate(transaction.args.changes)) {
      if (fact.value !== true) {
        // Format matches what schemaTracker uses: "id\0type"
        changedDocs.add(`${fact.of}\0${fact.the}`);
      }
    }
    return changedDocs;
  }

  /**
   * Find docs in changedDocs that are tracked by the subscription's schemaTracker.
   * Returns list of (docKey, schemas) pairs.
   */
  private findAffectedDocs(
    changedDocs: Set<string>,
    schemaTracker: MapSet<string, SchemaPathSelector>,
  ): Array<{ docKey: string; schemas: Set<SchemaPathSelector> }> {
    const affected: Array<{ docKey: string; schemas: Set<SchemaPathSelector> }> =
      [];
    for (const docKey of changedDocs) {
      const schemas = schemaTracker.get(docKey);
      if (schemas && schemas.size > 0) {
        affected.push({ docKey, schemas: new Set(schemas) });
      }
    }
    return affected;
  }

  /**
   * Process incremental update for a subscription given affected docs.
   * Re-evaluates each affected doc with its schemas and follows new links.
   */
  private processIncrementalUpdate<Space extends MemorySpace>(
    spaceSession: SpaceSession<Space>,
    subscription: SchemaSubscription,
    affectedDocs: Array<{ docKey: string; schemas: Set<SchemaPathSelector> }>,
    space: Space,
  ): { newFacts: Map<string, Revision<Fact>> } {
    const newFacts = new Map<string, Revision<Fact>>();
    const classification = subscription.invocation.args.classification;

    // Queue of (docKey, schema) pairs to process
    const pendingPairs: Array<{ docKey: string; schema: SchemaPathSelector }> =
      [];

    // Initialize with affected docs and their schemas
    for (const { docKey, schemas } of affectedDocs) {
      for (const schema of schemas) {
        pendingPairs.push({ docKey, schema });
      }
    }

    // Process pending pairs - may grow as we discover new links
    const processedPairs = new Set<string>();
    while (pendingPairs.length > 0) {
      const { docKey, schema } = pendingPairs.pop()!;
      const pairKey = `${docKey}|${JSON.stringify(schema)}`;

      // Skip if already processed
      if (processedPairs.has(pairKey)) {
        continue;
      }
      processedPairs.add(pairKey);

      // Parse docKey back to id and type
      const [docId, docType] = docKey.split("\0");
      if (!docId || !docType) {
        continue;
      }

      // Evaluate this document with the schema to find its current links
      const links = evaluateDocumentLinks(
        spaceSession,
        { id: docId, type: docType },
        schema,
        classification,
      );

      if (links === null) {
        // Document not found or retracted - skip (conservative approach)
        continue;
      }

      // Load the fact for this document to include in results
      const fact = selectFact(spaceSession, {
        of: docId as `${string}:${string}`,
        the: docType as `${string}/${string}`,
      });
      if (fact && fact.is !== undefined) {
        const address = this.formatAddress(space, fact);
        newFacts.set(address, {
          of: fact.of,
          the: fact.the,
          cause: causeFromString(fact.cause),
          is: fact.is,
          since: fact.since,
        });
      }

      // Find new links: targets in links that aren't already in subscription.schemaTracker
      for (const [targetDocKey, targetSchemas] of links) {
        for (const targetSchema of targetSchemas) {
          if (!subscription.schemaTracker.hasValue(targetDocKey, targetSchema)) {
            // New link discovered - add to pending and track it
            pendingPairs.push({ docKey: targetDocKey, schema: targetSchema });
            subscription.schemaTracker.add(targetDocKey, targetSchema);
          }
        }
      }
    }

    return { newFacts };
  }

  /**
   * Fallback to full re-query for all subscriptions (original behavior).
   * Used when incremental update cannot proceed (e.g., mount failure).
   */
  private async getSchemaSubscriptionMatchesFallback<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Promise<[JobId | undefined, number, Revision<Fact>[]]> {
    const schemaMatches = new Map<string, Revision<Fact>>();
    const space = transaction.sub;
    let maxSince = -1;
    let lastId: JobId | undefined;

    for (const [id, subscription] of this.schemaChannels) {
      if (Subscription.match(transaction, subscription.watchedObjects)) {
        // Re-run our original query, but not as a subscription
        const newArgs = { ...subscription.invocation.args, subscribe: false };
        const newInvocation = { ...subscription.invocation, args: newArgs };
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
        const newFacts = includedFacts.entries().filter(
          ([address, factVersion]) =>
            factVersion.since > subscription.since ||
            !subscription.watchedObjects.has(address),
        );
        for (const [address, factVersion] of newFacts) {
          schemaMatches.set(address, factVersion);
        }
        subscription.watchedObjects = new Set(includedFacts.keys());
        subscription.since = since;
        lastId = id;
        maxSince = since > maxSince ? since : maxSince;
      }
    }
    return [lastId, maxSince, [...schemaMatches.values()]];
  }

  private async getAcl(space: MemorySpace): Promise<ACL | undefined> {
    try {
      const result = await Memory.mount(this.memory as Memory.Memory, space);

      if (result.error) {
        logger.warn(
          "acl-mount-error",
          () => ["Failed to mount space for ACL lookup:", result.error],
        );
        return undefined;
      }

      const spaceSession = result.ok as unknown as {
        subject: MemorySpace;
        store: any;
      };

      const aclFact = selectFact(spaceSession, {
        the: ACL_TYPE,
        of: space,
      });

      if (
        !aclFact || !aclFact.is || typeof aclFact.is !== "object" ||
        !("value" in aclFact.is)
      ) {
        return undefined;
      }

      if (isACL(aclFact.is.value)) {
        return aclFact.is.value;
      } else {
        logger.warn(
          "acl-format-error",
          () => ["Invalid ACL format in space", space, ":", aclFact.is],
        );
        return undefined;
      }
    } catch (error) {
      logger.error("acl-error", () => ["Error retrieving ACL:", error]);
      return undefined;
    }
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
