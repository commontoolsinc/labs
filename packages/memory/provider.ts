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
import {
  type ContentId,
  fromString as causeFromString,
  refer,
} from "./reference.ts";
import {
  redactCommitData,
  selectFact,
  type Session as SpaceSession,
} from "./space.ts";
import { evaluateDocumentLinks, ServerObjectManager } from "./space-schema.ts";
import * as Subscription from "./subscription.ts";
import * as FactModule from "./fact.ts";
import { setRevision } from "@commontools/memory/selection";
import { getLogger } from "@commontools/utils/logger";
import { ACL_TYPE, isACL } from "./acl.ts";
import { createSchemaMemo, MapSet } from "@commontools/runner/traverse";
import { deepEqual } from "@commontools/runner";
import type { SchemaPathSelector } from "./consumer.ts";

const logger = getLogger("memory-provider", {
  enabled: true,
  level: "warn",
});

const SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_BUFFER_SIZE = 100;

export interface SlowQuery {
  timestamp: number;
  elapsed: number;
  operation: string;
  space: string;
  selectorCount: number;
  subscribe: boolean;
  selector: unknown;
  /** Doc IDs from the selectSchema keys */
  docs?: string[];
  // Detailed stats from selectSchema (when available)
  factCount?: number;
  trackerKeys?: number;
  trackerVals?: number;
  docsLoaded?: number;
  sqliteReads?: number;
  sqliteMs?: number;
  sqliteCacheHits?: number;
  sharedMemoSize?: number;
}

const slowQueries: SlowQuery[] = [];

function recordSlowQuery(entry: SlowQuery) {
  slowQueries.push(entry);
  if (slowQueries.length > SLOW_QUERY_BUFFER_SIZE) {
    slowQueries.shift();
  }
  logger.warn(
    "slow-query",
    () => [
      `${entry.operation} ${entry.elapsed.toFixed(0)}ms`,
      `space=${entry.space}`,
      `selectors=${entry.selectorCount}`,
      `subscribe=${entry.subscribe}`,
      ...(entry.factCount !== undefined
        ? [
          `facts=${entry.factCount}`,
          `trackerKeys=${entry.trackerKeys}`,
          `trackerVals=${entry.trackerVals}`,
          `docsLoaded=${entry.docsLoaded}`,
          `sqliteReads=${entry.sqliteReads}`,
          `sqliteMs=${entry.sqliteMs?.toFixed(1)}`,
          `sqliteCacheHits=${entry.sqliteCacheHits}`,
          `sharedMemo=${entry.sharedMemoSize}`,
        ]
        : []),
      `selector=${JSON.stringify(entry.selector)}`,
    ],
  );
}

/** Returns the last N slow queries (>100ms). */
export function getSlowQueries(): readonly SlowQuery[] {
  return slowQueries;
}

export * as Error from "./error.ts";
export * from "./interface.ts";
export * as Memory from "./memory.ts";
export * as Space from "./space.ts";
export * as Subscription from "./subscription.ts";
export * from "./util.ts";

// Convenient shorthand so I don't need this long type for this string
type JobId = InvocationURL<ContentId<ConsumerCommandInvocation<Protocol>>>;
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

  channels: Map<InvocationURL<ContentId<Subscribe>>, Set<string>> = new Map();
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
  // Shared SchemaMemo across all subscription queries on this connection.
  // Traversal results from one subscription are reused by subsequent
  // subscriptions that traverse the same doc+path+schema combos.
  private sharedSchemaMemo = createSchemaMemo();

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
          ContentId<ConsumerCommandInvocation<MemoryProtocol>>
        >,
        is: { error },
      });
    }

    const of = `job:${refer(invocation)}` as InvocationURL<
      ContentId<ConsumerCommandInvocation<Protocol>>
    >;

    switch (invocation.cmd) {
      case "/memory/query": {
        const selectorKeys = Object.keys(invocation.args.select ?? {});
        logger.debug(
          "query",
          () => [
            `space=${invocation.sub}`,
            `selectors=${selectorKeys.length}`,
            `since=${invocation.args.since ?? "none"}`,
          ],
        );
        logger.timeStart("query");
        const queryResult = (await this.memory.query(invocation)) as Result<
          Selection<Space>,
          QueryError
        >;
        const queryElapsed = logger.timeEnd("query") ?? 0;
        logger.debug(
          "query-done",
          () => [
            `space=${invocation.sub}`,
            `ok=${!!queryResult.ok}`,
            `elapsed=${queryElapsed.toFixed(1)}ms`,
          ],
        );
        if (queryElapsed > SLOW_QUERY_THRESHOLD_MS) {
          recordSlowQuery({
            timestamp: Date.now(),
            elapsed: queryElapsed,
            operation: "query",
            space: invocation.sub,
            selectorCount: selectorKeys.length,
            subscribe: false,
            selector: invocation.args.select,
            docs: selectorKeys,
          });
        }
        return this.perform({
          the: "task/return",
          of,
          is: queryResult,
        });
      }
      case "/memory/graph/query": {
        const schemaKeys = Object.keys(invocation.args.selectSchema ?? {});
        logger.debug(
          "graph-query",
          () => [
            `space=${invocation.sub}`,
            `schemas=${schemaKeys.length}`,
            `subscribe=${!!invocation.args.subscribe}`,
            `since=${invocation.args.since ?? "none"}`,
          ],
        );
        // Use querySchemaWithTracker when subscribing to capture the schemaTracker
        // for incremental updates on subsequent commits
        if (invocation.args.subscribe) {
          // Pass existing sharedSchemaTracker to enable early termination when
          // traversing into docs that are already tracked by other subscriptions
          logger.timeStart("graph-query", "subscribe");
          const trackerResult = await Memory.querySchemaWithTracker(
            this.memory as Memory.Memory,
            invocation,
            this.sharedSchemaTracker,
            { sharedMemo: this.sharedSchemaMemo },
          );
          const gqSubElapsed = logger.timeEnd("graph-query", "subscribe");
          if ("error" in trackerResult) {
            logger.warn(
              "graph-query-error",
              () => [
                `space=${invocation.sub}`,
                `elapsed=${gqSubElapsed?.toFixed(1)}ms`,
                `error=`,
                trackerResult.error,
              ],
            );
            return this.perform({
              the: "task/return",
              of,
              is: trackerResult,
            });
          }
          const { selection, stats: schemaStats } = trackerResult.ok;
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
          const gqSubMs = gqSubElapsed ?? 0;
          logger.debug(
            "graph-query-subscribe-done",
            () => [
              `space=${invocation.sub}`,
              `elapsed=${gqSubMs.toFixed(1)}ms`,
              `trackerSize=${this.sharedSchemaTracker.size}`,
              `sharedMemo=${this.sharedSchemaMemo.size}`,
            ],
          );
          if (gqSubMs > SLOW_QUERY_THRESHOLD_MS) {
            recordSlowQuery({
              timestamp: Date.now(),
              elapsed: gqSubMs,
              operation: "graph-query/subscribe",
              space: invocation.sub,
              selectorCount: schemaKeys.length,
              subscribe: true,
              selector: invocation.args.selectSchema,
              docs: schemaKeys,
              ...schemaStats,
            });
          }
          return this.perform({
            the: "task/return",
            of,
            is: { ok: selection },
          });
        }

        // Non-subscribing queries use the regular querySchema
        logger.timeStart("graph-query", "one-shot");
        const result = await this.memory.querySchema(invocation);
        const gqElapsed = logger.timeEnd("graph-query", "one-shot");
        // Filter out any known results
        if (result.ok !== undefined && invocation.args.excludeSent) {
          const space = invocation.sub;
          const factSelection = result.ok[space];
          const factVersions = [...FactModule.iterate(factSelection)];
          result.ok[space] = this.toSelection(
            this.filterKnownFacts(factVersions),
          );
        }
        const gqMs = gqElapsed ?? 0;
        logger.debug(
          "graph-query-done",
          () => [
            `space=${invocation.sub}`,
            `ok=${result.ok !== undefined}`,
            `elapsed=${gqMs.toFixed(1)}ms`,
          ],
        );
        if (gqMs > SLOW_QUERY_THRESHOLD_MS) {
          recordSlowQuery({
            timestamp: Date.now(),
            elapsed: gqMs,
            operation: "graph-query/one-shot",
            space: invocation.sub,
            selectorCount: schemaKeys.length,
            subscribe: false,
            selector: invocation.args.selectSchema,
            docs: schemaKeys,
          });
        }
        return this.perform({
          the: "task/return",
          of,
          is: result,
        });
      }
      case "/memory/transact": {
        const changeKeys = Object.keys(invocation.args.changes ?? {});
        logger.debug(
          "transact",
          () => [
            `space=${invocation.sub}`,
            `changes=${changeKeys.length}`,
          ],
        );
        logger.timeStart("transact");
        const result = await this.memory.transact(invocation);
        const txElapsed = logger.timeEnd("transact");
        if (result.error) {
          logger.warn(
            "transact-error",
            () => [
              `space=${invocation.sub}`,
              `elapsed=${txElapsed?.toFixed(1)}ms`,
              JSON.stringify(result.error, null, 2),
            ],
          );
        } else {
          logger.debug(
            "transact-done",
            () => [
              `space=${invocation.sub}`,
              `elapsed=${txElapsed?.toFixed(1)}ms`,
              `changes=${changeKeys.length}`,
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
    logger.timeStart("commit");
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
      logger.timeStart("commit", "schema-match");
      const schemaFacts = await this.getSchemaSubscriptionMatches(
        redactedData.transaction,
      );
      logger.timeEnd("commit", "schema-match");

      // Send commits with revisions to commit log subscriptions
      // The client's startSynchronization() reads revisions to update its heap
      const commitJobIds: InvocationURL<ContentId<Subscribe>>[] = [];
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
    logger.timeEnd("commit");
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
    const t0 = performance.now();
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
    const tMount = performance.now();

    // Find affected docs using the shared schemaTracker (for non-wildcard)
    const sharedAffectedDocs = new Map<string, Set<SchemaPathSelector>>();
    for (const docKey of changedDocs) {
      const existingSelectors = this.sharedSchemaTracker.get(docKey);
      if (existingSelectors !== undefined) {
        sharedAffectedDocs.set(docKey, new Set(existingSelectors));
      }
    }
    const tLookup = performance.now();

    // Process shared affected docs
    const { newFacts } = this.processIncrementalUpdate(
      spaceSession,
      sharedAffectedDocs,
    );
    const tShared = performance.now();

    // Add facts from wildcard subscriptions
    let wildcardCount = 0;
    for (const [_jobId, subscription] of this.schemaChannels) {
      if (subscription.isWildcardQuery) {
        const wildcardDocs = this.findAffectedDocsForWildcard(
          changedDocs,
          subscription.invocation,
        );
        if (wildcardDocs.size > 0) {
          wildcardCount += wildcardDocs.size;
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
    const tWildcard = performance.now();
    const total = tWildcard - t0;
    if (total > 20) {
      logger.warn("slow-schema-match", () => [
        `${total.toFixed(0)}ms total`,
        `mount=${(tMount - t0).toFixed(0)}ms`,
        `lookup=${(tLookup - tMount).toFixed(0)}ms`,
        `shared=${(tShared - tLookup).toFixed(0)}ms`,
        `wildcard=${(tWildcard - tShared).toFixed(0)}ms`,
        `changedDocs=${changedDocs.size}`,
        `sharedAffected=${sharedAffectedDocs.size}`,
        `wildcardDocs=${wildcardCount}`,
        `schemaChannels=${this.schemaChannels.size}`,
        `newFacts=${newFacts.size}`,
      ]);
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

    // Share one ServerObjectManager across all evaluateDocumentLinks calls
    // so SQLite reads from one doc traversal can be reused by the next.
    const sharedManager = new ServerObjectManager(
      spaceSession,
      new Set<string>(classification),
    );
    // Share one SchemaMemo so traversal results from one doc are reused
    // when traversing linked docs that overlap across affected documents.
    const sharedMemo = createSchemaMemo();

    // Purge these docs from the tracker -- we want to re-evaluate the queries
    const staleSchemaTracker = new Map<string, Set<SchemaPathSelector>>();
    for (const [docKey, _schemaSelectors] of affectedDocs) {
      const existingSchemas = this.sharedSchemaTracker.get(docKey);
      if (existingSchemas !== undefined) {
        this.sharedSchemaTracker.delete(docKey);
        staleSchemaTracker.set(docKey, existingSchemas);
      }
    }

    // Snapshot tracker keys BEFORE traversal so we can diff afterward.
    // Use the tracker's size as a cheap proxy — we only need to find
    // keys that were added during evaluateDocumentLinks.
    const trackerSizeBefore = this.sharedSchemaTracker.size;

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
          sharedManager,
          sharedMemo,
        );
      }
    }

    logger.debug(
      "incremental-update",
      () => [
        `affectedDocs=${affectedDocs.size}`,
        `sqliteReads=${sharedManager.sqliteReads}`,
        `sqliteMs=${sharedManager.sqliteTotalMs.toFixed(1)}`,
        `sqliteCacheHits=${sharedManager.sqliteCacheHits}`,
        `schemaMemo=${sharedMemo.size}`,
      ],
    );

    // Use docs loaded by the manager during traversal as candidates for
    // new facts. This avoids iterating the entire sharedSchemaTracker
    // (which can have thousands of entries) on every commit.
    // The manager already loaded these docs from SQLite, so we have their
    // data without an extra read.
    if (this.sharedSchemaTracker.size > trackerSizeBefore) {
      for (const loaded of sharedManager.getReadDocs()) {
        const docKey =
          `${spaceSession.subject}/${loaded.address.id}/${loaded.address.type}`;
        // Only include docs that weren't already in the tracker before traversal
        if (!staleSchemaTracker.has(docKey) && loaded.value !== undefined) {
          const details = sharedManager.getDetails(loaded.address);
          if (details) {
            const factKey = this.formatAddress(spaceSession.subject, {
              of: loaded.address.id,
              the: loaded.address.type,
            });
            newFacts.set(factKey, {
              of: loaded.address.id,
              the: loaded.address.type,
              cause: causeFromString(details.cause),
              is: loaded.value,
              since: details.since,
            });
          }
        }
      }
    }

    // Also include the affected (changed) docs themselves — their data
    // may have changed even if they were already tracked.
    for (const [docKey, _schemaSelectors] of affectedDocs) {
      const address = this.parseDocKey(docKey);
      if (address === undefined) continue;
      const fact = selectFact(spaceSession, {
        of: address.id,
        the: address.type,
      });
      if (!fact || fact.is === undefined) continue;
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
