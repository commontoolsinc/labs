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
import { COMMIT_LOG_TYPE } from "./commit.ts";
import { createSchemaMemo, MapSet } from "@commontools/runner/traverse";
import type { SchemaPathSelector } from "./consumer.ts";

const logger = getLogger("memory-provider", {
  enabled: true,
  level: "warn",
});

const DOC_KEY_PATTERN = /([^/]+)\/([^/]+)\/(.+)/;
const SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_BUFFER_SIZE = 100;
const SCHEMA_FLUSH_LOG_INTERVAL_MS = 60_000;

/** Tracks schema flush statistics across all sessions. */
const schemaFlushStats = {
  /** Total flushes triggered (all sources) */
  flushes: 0,
  /** Flushes where batching deferred at least one commit */
  batched: 0,
  /** Flushes triggered synchronously before returning a ConflictError */
  conflictFlushes: 0,
  /** Total commits accumulated across all flushes */
  totalCommitsAccumulated: 0,
  /** Distribution of batch sizes (commits per flush) */
  batchSizes: new Map<number, number>(),
  /** Total elapsed ms across all flushes */
  totalFlushMs: 0,

  record(commitCount: number, isConflict: boolean, elapsedMs: number) {
    this.flushes++;
    this.totalCommitsAccumulated += commitCount;
    this.totalFlushMs += elapsedMs;
    if (commitCount > 1) this.batched++;
    if (isConflict) this.conflictFlushes++;
    const bucket = commitCount >= 10 ? 10 : commitCount;
    this.batchSizes.set(bucket, (this.batchSizes.get(bucket) ?? 0) + 1);
  },

  report(): string[] {
    if (this.flushes === 0) return [];
    const avg = (this.totalCommitsAccumulated / this.flushes).toFixed(1);
    const avgMs = (this.totalFlushMs / this.flushes).toFixed(1);
    const dist = [...this.batchSizes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([size, count]) => `${size === 10 ? "10+" : size}:${count}`)
      .join(" ");
    return [
      `flushes=${this.flushes}`,
      `batched=${this.batched}`,
      `conflictFlushes=${this.conflictFlushes}`,
      `avgBatch=${avg}`,
      `avgMs=${avgMs}`,
      `dist=[${dist}]`,
    ];
  },

  reset() {
    this.flushes = 0;
    this.batched = 0;
    this.conflictFlushes = 0;
    this.totalCommitsAccumulated = 0;
    this.batchSizes.clear();
    this.totalFlushMs = 0;
  },
};

let lastSchemaFlushReport = 0;

function maybeReportSchemaFlushStats() {
  const now = Date.now();
  if (now - lastSchemaFlushReport < SCHEMA_FLUSH_LOG_INTERVAL_MS) return;
  lastSchemaFlushReport = now;
  const lines = schemaFlushStats.report();
  if (lines.length > 0) {
    logger.warn("schema-flush-stats", () => lines);
    schemaFlushStats.reset();
  }
}

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
  // Reverse index: watchAddress → Set of channel IDs that watch it.
  // Allows O(changes) commit matching instead of O(channels × changes).
  private watchIndex: Map<string, Set<InvocationURL<ContentId<Subscribe>>>> =
    new Map();
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
    true,
  );
  // Shared SchemaMemo across all subscription queries on this connection.
  // Traversal results from one subscription are reused by subsequent
  // subscriptions that traverse the same doc+path+schema combos.
  private sharedSchemaMemo = createSchemaMemo();
  // Cached SpaceSession per space to avoid Memory.mount overhead on every commit.
  private spaceSessionCache = new Map<MemorySpace, SpaceSession<Space>>();
  // Accumulated doc keys per space for debounced schema matching
  private pendingSchemaChanges = new Map<MemorySpace, Set<string>>();
  // Whether a schema flush is already scheduled
  private schemaFlushScheduled = false;
  // Generation counter: incremented on each commit that accumulates
  // schema changes. Compared across yield points to detect new work.
  private schemaChangeGeneration = 0;
  // Duration of the previous schema flush (ms), for batch logging
  private lastFlushMs = 0;

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
          // Schedule a debounced flush. The 5ms window lets multiple
          // rapid commits (e.g. buffered websocket messages) coalesce
          // into a single schema traversal.
          this.scheduleSchemaFlush();
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
    this.schemaFlushScheduled = false;
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
          // On conflict, flush any pending schema revisions before replying.
          // The client retries immediately on conflict, and may need linked
          // docs (e.g. a new document referenced by a changed pointer) that
          // are only discovered through schema traversal.
          if (
            (result.error as { name?: string }).name === "ConflictError" &&
            this.pendingSchemaChanges.size > 0
          ) {
            await this.flushSchemaChanges(/* isConflict */ true);
          }
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
        const watchAddresses = new Set(
          Subscription.channels(invocation.sub, selector),
        );
        this.channels.set(of, watchAddresses);
        for (const addr of watchAddresses) {
          let ids = this.watchIndex.get(addr);
          if (!ids) {
            ids = new Set();
            this.watchIndex.set(addr, ids);
          }
          ids.add(of);
        }
        return this.memory.subscribe(this);
      }
      case "/memory/query/unsubscribe": {
        this.removeChannel(of);
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

  commit(commit: Commit<Space>, labels?: Memory.FactSelection) {
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
      // Accumulate schema changes for deferred link-traversal evaluation.
      this.accumulateSchemaChanges(redactedData.transaction);

      // Cheaply read current values of directly-changed docs that are already
      // tracked by schema subscriptions. This avoids the expensive
      // evaluateDocumentLinks traversal while still sending the most important
      // revisions (the docs that actually changed) with the commit.
      const directRevisions = this.getDirectChangedRevisions(
        redactedData.transaction,
      );

      // Send commits with revisions to commit log subscriptions
      // The client's startSynchronization() reads revisions to update its heap
      // Use the reverse watchIndex for O(changes) matching instead of O(channels × changes).
      const commitJobIds = this.findMatchingChannels(redactedData.transaction);

      if (commitJobIds.length > 0) {
        // The client has a subscription to the space's commit log
        const enhancedCommit: EnhancedCommit<Space> = {
          commit: {
            [item.of]: { [item.the]: { [item.cause]: { is: redactedData } } },
          } as Commit<Space>,
          revisions: this.filterKnownFacts(directRevisions),
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
    // Schedule a debounced flush (5ms window). Multiple rapid commits
    // coalesce into a single schema traversal.
    this.scheduleSchemaFlush();
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

  /**
   * Find channels matching a transaction using the reverse watchIndex.
   * O(changes × 4) instead of O(channels × changes × 4).
   */
  private findMatchingChannels(
    transaction: Transaction<MemorySpace>,
  ): InvocationURL<ContentId<Subscribe>>[] {
    if (this.watchIndex.size === 0) return [];

    const matched = new Set<InvocationURL<ContentId<Subscribe>>>();
    const space = transaction.sub;

    // Check commit-log watchers first
    this.collectWatchMatches(matched, space, space, COMMIT_LOG_TYPE);

    // Check each changed fact
    for (const fact of SelectionBuilder.iterate(transaction.args.changes)) {
      if (fact.value !== true) {
        this.collectWatchMatches(matched, space, fact.of, fact.the);
      }
    }

    return [...matched];
  }

  /** Look up the 4 watch address variants and add matching channel IDs. */
  private collectWatchMatches(
    matched: Set<InvocationURL<ContentId<Subscribe>>>,
    space: string,
    of: string,
    the: string,
  ) {
    const ANY = Subscription.ANY;
    // exact, wildcard-of, wildcard-the, wildcard-both
    this.addWatchHits(
      matched,
      Subscription.formatAddress({ at: space, of, the }),
    );
    this.addWatchHits(
      matched,
      Subscription.formatAddress({ at: space, of: ANY, the }),
    );
    this.addWatchHits(
      matched,
      Subscription.formatAddress({ at: space, of, the: ANY }),
    );
    this.addWatchHits(
      matched,
      Subscription.formatAddress({ at: space, of: ANY, the: ANY }),
    );
  }

  private addWatchHits(
    matched: Set<InvocationURL<ContentId<Subscribe>>>,
    addr: string,
  ) {
    const ids = this.watchIndex.get(addr);
    if (ids) {
      for (const id of ids) matched.add(id);
    }
  }

  /** Remove a channel and clean up its entries in the watchIndex. */
  private removeChannel(id: InvocationURL<ContentId<Subscribe>>) {
    const addresses = this.channels.get(id);
    if (addresses) {
      for (const addr of addresses) {
        const ids = this.watchIndex.get(addr);
        if (ids) {
          ids.delete(id);
          if (ids.size === 0) this.watchIndex.delete(addr);
        }
      }
      this.channels.delete(id);
    }
  }

  /** Get or cache a SpaceSession, avoiding Memory.mount overhead on repeat calls. */
  private async getSpaceSession(
    space: MemorySpace,
  ): Promise<SpaceSession<Space>> {
    let session = this.spaceSessionCache.get(space);
    if (!session) {
      const mountResult = await Memory.mount(
        this.memory as Memory.Memory,
        space,
      );
      if (mountResult.error) {
        throw new Error(`Failed to mount space ${space}: ${mountResult.error}`);
      }
      session = mountResult.ok as unknown as SpaceSession<Space>;
      this.spaceSessionCache.set(space, session);
    }
    return session;
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
   * Cheaply read current fact values for docs changed in this transaction
   * that are already tracked by schema subscriptions or wildcard queries.
   * No schema traversal — just direct SQLite reads for the changed docs.
   */
  private getDirectChangedRevisions<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): Revision<Fact>[] {
    if (this.schemaChannels.size === 0) return [];

    const space = transaction.sub;
    const spaceSession = this.spaceSessionCache.get(space);
    if (!spaceSession) return [];

    const revisions: Revision<Fact>[] = [];
    const hasWildcard = [...this.schemaChannels.values()].some(
      (s) => s.isWildcardQuery,
    );

    for (const fact of SelectionBuilder.iterate(transaction.args.changes)) {
      if (fact.value === true) continue;
      const docKey = `${space}/${fact.of}/${fact.the}`;
      // Include if tracked by sharedSchemaTracker or any wildcard query exists
      const isTracked = this.sharedSchemaTracker.has(docKey);
      if (!isTracked && !hasWildcard) continue;

      const selected = selectFact(spaceSession, {
        the: fact.the as Memory.MIME,
        of: fact.of as Memory.URI,
      });
      if (!selected) continue;

      revisions.push({
        of: selected.of,
        the: selected.the,
        cause: causeFromString(selected.cause),
        is: selected.is,
        since: selected.since,
      });
    }

    return revisions;
  }

  /**
   * Collect changed doc keys from a transaction into the pending set
   * for batched schema evaluation.
   */
  private accumulateSchemaChanges<Space extends MemorySpace>(
    transaction: Transaction<Space>,
  ): void {
    if (this.schemaChannels.size === 0) return;

    const space = transaction.sub;
    const changedDocs = this.extractChangedDocKeys(space, transaction);
    if (changedDocs.size === 0) return;

    let pending = this.pendingSchemaChanges.get(space);
    if (!pending) {
      pending = new Set<string>();
      this.pendingSchemaChanges.set(space, pending);
    }
    for (const doc of changedDocs) {
      pending.add(doc);
    }
    this.schemaChangeGeneration++;
  }

  /**
   * Schedule a debounced schema flush. Uses a queueMicrotask loop
   * that keeps yielding as long as new schema changes arrive.
   * This naturally batches rapid commits without creating timer
   * resources that leak in tests.
   */
  private scheduleSchemaFlush(): void {
    if (this.schemaFlushScheduled) return;
    if (this.pendingSchemaChanges.size === 0) return;
    this.schemaFlushScheduled = true;
    queueMicrotask(() => this.debouncedFlush());
  }

  private async debouncedFlush(): Promise<void> {
    if (!this.schemaFlushScheduled) return;

    // Keep yielding as long as new changes arrive, up to a limit.
    // This lets the stream pipe drain all buffered messages without
    // starving the flush if commits arrive continuously.
    let gen: number;
    let yields = 0;
    do {
      gen = this.schemaChangeGeneration;
      await Promise.resolve();
      if (!this.schemaFlushScheduled) return;
    } while (this.schemaChangeGeneration !== gen && ++yields < 50);

    this.schemaFlushScheduled = false;
    await this.flushSchemaChanges();
  }

  /**
   * Flush accumulated schema changes: run schema matching once for all
   * coalesced commits and send revisions to active commit-log subscribers.
   */
  private async flushSchemaChanges(
    isConflict = false,
  ): Promise<void> {
    // Cancel any pending debounced flush since we're flushing now
    this.schemaFlushScheduled = false;

    // Guard against flush after session disposal
    if (!this.controller) return;

    // Snapshot and clear pending changes
    const pending = this.pendingSchemaChanges;
    this.pendingSchemaChanges = new Map();

    if (pending.size === 0) return;

    // Count total accumulated doc keys across all spaces
    let commitCount = 0;
    for (const docs of pending.values()) commitCount += docs.size;
    const t0 = performance.now();

    logger.timeStart("schema-flush");

    try {
      for (const [space, changedDocs] of pending) {
        if (changedDocs.size === 0) continue;
        if (this.schemaChannels.size === 0) continue;

        const spaceSession = await this.getSpaceSession(space);

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

        const revisions = this.filterKnownFacts([...newFacts.values()]);
        if (revisions.length === 0) continue;

        // Send revisions to all commit-log channels for this space.
        // Uses an empty commit payload — the consumer handles this as a
        // revision-only delivery (no commit parsing needed).
        const commitJobIds = this.findCommitLogChannels(space);
        if (commitJobIds.length === 0) continue;

        const revisionCommit: EnhancedCommit<MemorySpace> = {
          commit: {} as Commit<MemorySpace>,
          revisions,
        };

        for (const id of commitJobIds) {
          this.perform({
            the: "task/effect",
            of: id,
            is: revisionCommit,
          });
        }
      }
    } catch (error) {
      // The flush fires from a setTimeout and may race with session
      // teardown or store closure. Log and discard — the revisions are
      // best-effort; direct revisions were already sent with the commit.
      logger.warn(
        "schema-flush-error",
        () => ["Deferred schema flush failed:", error],
      );
    }

    logger.timeEnd("schema-flush");
    const flushMs = performance.now() - t0;
    const prevFlushMs = this.lastFlushMs;
    this.lastFlushMs = flushMs;
    schemaFlushStats.record(commitCount, isConflict, flushMs);
    if (commitCount > 1) {
      logger.warn(
        "schema-flush-batch",
        () => [
          `saved=${commitCount - 1}`,
          `flushMs=${flushMs.toFixed(1)}`,
          `prevFlushMs=${prevFlushMs.toFixed(1)}`,
          isConflict ? "conflict" : "",
        ],
      );
    }
    maybeReportSchemaFlushStats();
  }

  /**
   * Find commit-log channels matching a given space.
   * Reuses collectWatchMatches which checks exact + wildcard patterns.
   */
  private findCommitLogChannels(
    space: MemorySpace,
  ): InvocationURL<ContentId<Subscribe>>[] {
    const matched = new Set<InvocationURL<ContentId<Subscribe>>>();
    this.collectWatchMatches(matched, space, space, COMMIT_LOG_TYPE);
    return [...matched];
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

    // Get access to the space session for evaluating documents.
    // Use cached session to avoid Memory.mount async/tracing overhead per commit.
    const spaceSession = await this.getSpaceSession(space);
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
            newFacts.set(docKey, {
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
    // Use sharedManager.load to leverage the cache from traversal above,
    // avoiding redundant SQLite reads vs raw selectFact.
    for (const [docKey, _schemaSelectors] of affectedDocs) {
      const address = this.parseDocKey(docKey);
      if (address === undefined) continue;
      const loaded = sharedManager.load({
        id: address.id,
        type: address.type,
      });
      if (!loaded || loaded.value === undefined) continue;
      const details = sharedManager.getDetails(loaded.address);
      if (!details) continue;
      const factKey = `${spaceSession.subject}/${address.id}/${address.type}`;
      newFacts.set(factKey, {
        of: address.id,
        the: address.type,
        cause: causeFromString(details.cause),
        is: loaded.value,
        since: details.since,
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
    const match = DOC_KEY_PATTERN.exec(docKey);
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
