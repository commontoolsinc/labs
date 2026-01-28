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
  StorableDatum,
  Subscribe,
  Subscriber,
  Transaction,
  UCAN,
} from "./interface.ts";
import * as SelectionBuilder from "./selection.ts";
import * as Memory from "./memory.ts";
import { fromString as causeFromString, refer } from "./reference.ts";
import {
  redactCommitData,
  selectFact,
  type Session as SpaceSession,
} from "./space.ts";
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
  enabled: false,
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
    // True if this is a wildcard query (of: "_") that can't use incremental updates
    public isWildcardQuery: boolean = false,
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
  // Shared schema tracker for all subscriptions
  // Tracks which docs were scanned with which schemas
  // This serves as a watch list, to tell which documents we need to be
  // notified when they change. It also serves as a cache to prevent us
  // from re-running a query or part of a query when the underlying docs
  // haven't changed. In this cache role, it lets us know that we already
  // have the current information.
  sharedSchemaTracker: MapSet<string, SchemaPathSelector> = new MapSet(
    deepEqual,
  );

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
          // Pass existing sharedSchemaTracker to enable early termination when
          // traversing into docs that are already tracked by other subscriptions
          const trackerResult = await Memory.querySchemaWithTracker(
            this.memory as Memory.Memory,
            invocation,
            this.sharedSchemaTracker,
          );
          if ("error" in trackerResult) {
            return this.perform({
              the: "task/return",
              of,
              is: trackerResult,
            });
          }
          const { selection } = trackerResult.ok;
          this.addSchemaSubscription(of, invocation, selection);
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
        logger.debug(
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

  async commit(commit: Commit<Space>, labels?: Memory.FactSelection) {
    // We should really only have one item, but it's technically legal to have
    // multiple transactions in the same commit, so iterate
    for (
      const item of SelectionBuilder.iterate<{ is: Memory.CommitData }>(commit)
    ) {
      // Remove any classified results from our commit before broadcasting.
      const redactedData = redactCommitData(item.value.is, labels);
      if (Subscription.isTransactionReadOnly(redactedData.transaction)) {
        continue;
      }
      // First, check to see if any of our schema queries need to be notified
      // Any queries that lack access are skipped (with a console log)
      const schemaFacts = await this.getSchemaSubscriptionMatches(
        redactedData.transaction,
      );

      // Send commits with revisions to commit log subscriptions
      // The client's startSynchronization() reads revisions to update its heap
      const commitJobIds: InvocationURL<Reference<Subscribe>>[] = [];
      for (const [id, channels] of this.channels) {
        if (Subscription.match(redactedData.transaction, channels)) {
          commitJobIds.push(id);
        }
      }

      if (commitJobIds.length > 0) {
        // The client has a subscription to the space's commit log
        const enhancedCommit: EnhancedCommit<Space> = {
          commit: {
            [item.of]: { [item.the]: { [item.cause]: { is: redactedData } } },
          } as Commit<Space>,
          revisions: this.filterKnownFacts(schemaFacts),
        };

        for (const id of commitJobIds) {
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
      { is?: StorableDatum; since: number }
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
    _result: Selection<Space>,
  ) {
    // Check if this is a wildcard query (of: "_")
    // Wildcard queries can't benefit from incremental updates via schemaTracker
    const isWildcardQuery = this.isWildcardQuery(invocation);

    const subscription = new SchemaSubscription(
      invocation,
      isWildcardQuery,
    );
    this.schemaChannels.set(of, subscription);
    // Note: lastRevision is updated by filterKnownFacts when facts are sent
  }

  /**
   * Check if a schema query contains any wildcard selectors (of: "_").
   * Wildcard queries match based on type rather than specific document IDs.
   */
  private isWildcardQuery<Space extends MemorySpace>(
    invocation: SchemaQuery<Space>,
  ): boolean {
    const selectSchema = invocation.args.selectSchema;
    for (const of of Object.keys(selectSchema)) {
      if (of === "_") return true;
    }
    return false;
  }

  /**
   * For wildcard queries, find changed docs that match the type pattern.
   * Returns affected docs with the schema from the wildcard selector.
   */
  private findAffectedDocsForWildcard<Space extends MemorySpace>(
    changedDocs: Set<string>,
    invocation: SchemaQuery<Space>,
  ): Map<string, Set<SchemaPathSelector>> {
    const affected = new Map<string, Set<SchemaPathSelector>>();
    const selectSchema = invocation.args.selectSchema;

    // Get the wildcard selector's type patterns
    const wildcardSelector = selectSchema["_"];
    if (!wildcardSelector) return affected;

    // Build a map of type -> schemas for matching
    const typeSchemas = new Map<string, Set<SchemaPathSelector>>();
    for (const [the, causes] of Object.entries(wildcardSelector)) {
      const schemas = new Set<SchemaPathSelector>();
      for (const schema of Object.values(causes)) {
        schemas.add(schema as SchemaPathSelector);
      }
      if (schemas.size > 0) {
        typeSchemas.set(the, schemas);
      }
    }

    // Match changed docs against type patterns
    for (const docKey of changedDocs) {
      const parsedKey = this.parseDocKey(docKey);
      if (parsedKey === undefined) continue;
      const { id: _, type } = parsedKey;

      // Check if this type matches a wildcard pattern
      const schemas = typeSchemas.get(type) ?? typeSchemas.get("_");
      if (schemas && schemas.size > 0) {
        affected.set(docKey, new Set(schemas));
      }
    }

    return affected;
  }

  /**
   * Incrementally find schema subscription matches after a transaction.
   *
   * For wildcard queries (of: "_"): Match changed docs against type pattern.
   * For specific document queries: Use schemaTracker to find affected docs.
   *
   * Returns all facts that match any subscription's criteria.
   */
  private async getSchemaSubscriptionMatches<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Promise<Revision<Fact>[]> {
    const space = transaction.sub;

    // Early exit if no schema subscriptions
    if (this.schemaChannels.size === 0) {
      return [];
    }

    // Extract changed document keys from transaction
    const changedDocs = this.extractChangedDocKeys(space, transaction);
    if (changedDocs.size === 0) {
      return [];
    }

    // Get access to the space session for evaluating documents
    const mountResult = await Memory.mount(
      this.memory as Memory.Memory,
      space,
    );
    if (mountResult.error) {
      throw new Error(`Failed to mount space ${space}: ${mountResult.error}`);
    }
    const spaceSession = mountResult.ok as unknown as SpaceSession<Space>;

    // Find affected docs using the shared schemaTracker (for non-wildcard)
    const sharedAffectedDocs = new Map<string, Set<SchemaPathSelector>>();
    for (const docKey of changedDocs) {
      const existingSelectors = this.sharedSchemaTracker.get(docKey);
      if (existingSelectors !== undefined) {
        sharedAffectedDocs.set(docKey, new Set(existingSelectors));
      }
    }

    // Process shared affected docs
    const { newFacts } = this.processIncrementalUpdate(
      spaceSession,
      sharedAffectedDocs,
    );

    // Add facts from wildcard subscriptions
    for (const [_jobId, subscription] of this.schemaChannels) {
      if (subscription.isWildcardQuery) {
        const wildcardDocs = this.findAffectedDocsForWildcard(
          changedDocs,
          subscription.invocation,
        );
        if (wildcardDocs.size > 0) {
          const wildcardResult = this.processIncrementalUpdate(
            spaceSession,
            wildcardDocs,
          );
          for (const [key, fact] of wildcardResult.newFacts) {
            newFacts.set(key, fact);
          }
        }
      }
    }

    return [...newFacts.values()];
  }

  /**
   * Extract document keys (id/type format) from a transaction's changes.
   */
  private extractChangedDocKeys<Space extends MemorySpace>(
    space: MemorySpace,
    transaction: Transaction<Space>,
  ): Set<string> {
    const changedDocs = new Set<string>();
    for (const fact of SelectionBuilder.iterate(transaction.args.changes)) {
      if (fact.value !== true) {
        // Format matches what schemaTracker uses: "id/type" (from BaseObjectManager.toKey)
        changedDocs.add(`${space}/${fact.of}/${fact.the}`);
      }
    }
    return changedDocs;
  }

  /**
   * Process incremental update given affected docs.
   * Re-evaluates each affected doc with its schemas and follows new links.
   * Uses the shared schemaTracker to track discovered links.
   */
  private processIncrementalUpdate<Space extends MemorySpace>(
    spaceSession: SpaceSession<Space>,
    affectedDocs: Map<string, Set<SchemaPathSelector>>,
  ): { newFacts: Map<string, Revision<Fact>> } {
    const newFacts = new Map<string, Revision<Fact>>();
    // Note: classification is not used here since we're processing across all subscriptions
    // TODO(ubik2,seefeld): Make this a per-session classification
    const classification = ["public", "secret"];

    // Purge these docs from the tracker -- we want to re-evaluate the queries
    const staleSchemaTracker = new Map<string, Set<SchemaPathSelector>>();
    for (const [docKey, _schemaSelectors] of affectedDocs) {
      const existingSchemas = this.sharedSchemaTracker.get(docKey);
      if (existingSchemas !== undefined) {
        this.sharedSchemaTracker.delete(docKey);
        staleSchemaTracker.set(docKey, existingSchemas);
      }
    }

    // Check which docs we're watching that didn't just change, so we don't
    // have to reload them to see if we should send them
    const existingDocs = new Set<string>();
    for (const [key, _value] of this.sharedSchemaTracker) {
      existingDocs.add(key);
    }

    // Evaluate each affected doc with each of its schemas
    // evaluateDocumentLinks does a full traversal and finds all linked documents
    for (const [docKey, schemaSelectors] of affectedDocs) {
      const address = this.parseDocKey(docKey);
      if (address === undefined) continue;
      for (const schemaSelector of schemaSelectors) {
        evaluateDocumentLinks(
          spaceSession,
          address,
          schemaSelector,
          classification,
          this.sharedSchemaTracker,
        );
      }
    }

    // Fetch each unique doc once and add to results
    for (const [docKey, _value] of this.sharedSchemaTracker) {
      // Don't bother with anything we already tracked
      if (existingDocs.has(docKey)) {
        continue;
      }

      const address = this.parseDocKey(docKey);
      if (address === undefined) continue;

      const fact = selectFact(spaceSession, {
        of: address.id,
        the: address.type,
      });

      if (!fact || fact.is === undefined) {
        // Document doesn't exist yet - skip
        continue;
      }

      // The format of this key doesn't really matter
      // this uses the watch:// format, but we could use the docKey
      const factKey = this.formatAddress(spaceSession.subject, fact);
      newFacts.set(factKey, {
        of: fact.of,
        the: fact.the,
        cause: causeFromString(fact.cause),
        is: fact.is,
        since: fact.since,
      });
    }

    return { newFacts };
  }

  /** Parse docKey (format "space/id/type") back to space, id, and type */
  private parseDocKey(
    docKey: string,
  ): { space: MemorySpace; id: Memory.URI; type: Memory.MIME } | undefined {
    // Parse docKey back to space, id, and type (format is "space/id/type")
    // Note: type can contain slashes (e.g., "application/json")
    const pattern = new RegExp("([^/]+)/([^/]+)/(.+)");
    const match = pattern.exec(docKey);
    if (match === null) {
      return undefined;
    }
    return {
      space: match[1] as MemorySpace,
      id: match[2] as Memory.URI,
      type: match[3] as Memory.MIME,
    };
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
