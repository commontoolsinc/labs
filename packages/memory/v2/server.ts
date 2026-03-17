import type { JSONValue } from "../interface.ts";
import { refer } from "../reference.ts";
import { resolveSpaceStoreUrl } from "../memory.ts";
import type { Protocol, Provider } from "../provider.ts";
import { getLogger } from "@commontools/utils/logger";
import {
  isPrimitiveCellLink,
  isSigilWriteRedirectLink,
} from "../../runner/src/link-types.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import {
  type Blob,
  type ClientCommit,
  type ClientMessage,
  type EntitySnapshot,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
  isSourceLink,
  type LegacyServerMessage,
  MEMORY_V2_PROTOCOL,
  type Reference,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenRequest,
  type SessionOpenResult,
  type TransactRequest,
  type V2Error,
} from "../v2.ts";
import * as Engine from "./engine.ts";
import { queryGraph, type QueryGraphReuseContext } from "./query.ts";

const logger = getLogger("memory-v2-server", {
  enabled: true,
  level: "warn",
});

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
const MEMORY_QUERY_STATS = typeof Deno !== "undefined" &&
  Deno.env.get("CT_MEMORY_QUERY_STATS") === "1";

const formatTopQueryShapes = (counts: ReadonlyMap<string, number>): string => {
  const top = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([shape, count]) => `${shape}:${count}`);
  return `[${top.join(", ")}]`;
};

type SessionState = {
  id: string;
  space: string;
  seenSeq: number;
  cachedSubscriptions: Map<string, CachedSubscription>;
  expiresAt: number | null;
};

type SubscriptionState = {
  id: string;
  space: string;
  sessionId: string;
  query: GraphQuery;
  entities: EntitySnapshot[];
  serverSeq: number;
  trackedIds: ReadonlySet<string>;
};

type CachedSubscription = {
  query: GraphQuery;
  result: GraphQueryResult;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toError = (name: string, message: string): V2Error => ({
  name,
  message,
});

const respondError = (
  requestId: string,
  error: V2Error,
): ResponseMessage<unknown> => ({
  type: "response",
  requestId,
  error,
});

const respondTypedError = <Result>(
  requestId: string,
  error: V2Error,
): ResponseMessage<Result> =>
  respondError(requestId, error) as ResponseMessage<Result>;

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  #prune(now = Date.now()): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  open(
    space: string,
    session: SessionDescriptor,
    serverSeq: number,
  ): SessionOpenResult {
    this.#prune();
    const sessionId = session.sessionId ?? crypto.randomUUID();
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined && existing.space !== space) {
      throw new Error(
        `session ${sessionId} is already bound to ${existing.space}`,
      );
    }
    const seenSeq = session.seenSeq ?? existing?.seenSeq ?? 0;
    const state = {
      id: sessionId,
      space,
      seenSeq,
      cachedSubscriptions: existing?.space === space
        ? existing.cachedSubscriptions
        : new Map(),
      expiresAt: null,
    };
    this.#sessions.set(sessionId, state);
    return { sessionId, serverSeq };
  }

  get(space: string, sessionId: string): SessionState | null {
    this.#prune();
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.space !== space) {
      return null;
    }
    return session;
  }

  cacheSubscriptions(
    space: string,
    sessionId: string,
    subscriptions: Iterable<SubscriptionState>,
  ): void {
    const session = this.get(space, sessionId);
    if (session === null) {
      return;
    }

    session.cachedSubscriptions.clear();
    for (const subscription of subscriptions) {
      session.cachedSubscriptions.set(queryCacheKey(subscription.query), {
        query: subscription.query,
        result: {
          serverSeq: subscription.serverSeq,
          entities: subscription.entities,
        },
      });
    }
    session.expiresAt = Date.now() + this.#ttlMs;
  }

  getCachedQuery(
    space: string,
    sessionId: string,
    query: GraphQuery,
    serverSeq: number,
  ): GraphQueryResult | null {
    const session = this.get(space, sessionId);
    if (session === null) {
      return null;
    }

    const cached = session.cachedSubscriptions.get(queryCacheKey(query));
    if (cached === undefined || cached.result.serverSeq !== serverSeq) {
      return null;
    }
    return cached.result;
  }
}

type Send = (message: ServerMessage) => void;

class Connection {
  #subscriptions = new Map<string, SubscriptionState>();
  #subscriptionsByTrackedId = new Map<string, Set<string>>();
  #ready = false;
  #closed = false;
  #queryStats = {
    refreshCalls: 0,
    subscriptionsConsidered: 0,
    refreshQueries: 0,
    refreshQueryMs: 0,
    directPatchHits: 0,
    sharedResultCacheHits: 0,
    refreshQueryShapes: new Map<string, number>(),
    directPatchShapes: new Map<string, number>(),
    topologySkips: new Map<string, number>(),
    patchNullReasons: new Map<string, number>(),
  };

  constructor(private readonly server: Server, private readonly send: Send) {}

  async receive(payload: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    const parsed = parseClientMessage(payload);
    if (parsed === null) {
      this.send({
        type: "response",
        requestId: "invalid",
        error: toError(
          "InvalidMessageError",
          "Unable to parse memory/v2 message",
        ),
      });
      return;
    }

    if (!this.#ready) {
      if (parsed.type !== "hello") {
        this.send({
          type: "response",
          requestId: "handshake",
          error: toError("ProtocolError", "memory/v2 hello is required first"),
        });
        return;
      }
      if (parsed.protocol !== MEMORY_V2_PROTOCOL) {
        this.send({
          type: "response",
          requestId: "handshake",
          error: toError(
            "UnsupportedProtocol",
            `Unsupported protocol: ${parsed.protocol}`,
          ),
        });
        return;
      }
      this.#ready = true;
      this.send({
        type: "hello.ok",
        protocol: MEMORY_V2_PROTOCOL,
      });
      return;
    }

    switch (parsed.type) {
      case "hello":
        this.send({
          type: "response",
          requestId: "handshake",
          error: toError("ProtocolError", "hello may only be sent once"),
        });
        return;
      case "session.open":
        this.send(await this.server.openSession(parsed));
        return;
      case "transact":
        this.send(await this.server.transact(parsed));
        return;
      case "graph.query": {
        const response = await this.server.graphQuery(parsed);
        this.send(response);
        if (response.ok?.subscriptionId) {
          this.trackSubscription({
            id: response.ok.subscriptionId,
            space: parsed.space,
            sessionId: parsed.sessionId,
            query: parsed.query,
            entities: response.ok.entities,
            serverSeq: response.ok.serverSeq,
            trackedIds: trackedIdsForSubscription(
              parsed.query,
              response.ok.entities,
            ),
          });
        }
        return;
      }
      case "graph.unsubscribe": {
        this.untrackSubscription(parsed.subscriptionId);
        this.send({
          type: "response",
          requestId: parsed.requestId,
          ok: {},
        });
        return;
      }
    }
  }

  subscriptionsForSpace(space: string): readonly SubscriptionState[] {
    return [...this.#subscriptions.values()].filter((subscription) =>
      subscription.space === space
    );
  }

  subscriptionsForDirtyIds(
    space: string,
    dirtyIds: ReadonlySet<string>,
  ): readonly SubscriptionState[] {
    const matches = new Map<string, SubscriptionState>();
    for (const dirtyId of dirtyIds) {
      const tracked = this.#subscriptionsByTrackedId.get(dirtyId);
      if (tracked === undefined) {
        continue;
      }
      for (const subscriptionId of tracked) {
        const subscription = this.#subscriptions.get(subscriptionId);
        if (subscription !== undefined && subscription.space === space) {
          matches.set(subscriptionId, subscription);
        }
      }
    }
    return [...matches.values()];
  }

  async refresh(space: string): Promise<void> {
    return await this.refreshMatching(space, undefined);
  }

  async refreshMatching(
    space: string,
    dirtyIds: ReadonlySet<string> | undefined,
  ): Promise<void> {
    if (this.#closed) {
      return;
    }
    logger.timeStart("refresh-space");
    try {
      const reuse: QueryGraphReuseContext = {
        managers: new Map(),
        sharedMemos: new Map(),
      };
      const directCache = new Map<string, EntitySnapshot>();
      const queryResults = new Map<string, GraphQueryResult>();
      const pendingUpdates = new Map<string, {
        result: GraphQueryResult;
        subscriptionIds: string[];
      }>();
      const subscriptions = dirtyIds === undefined
        ? this.subscriptionsForSpace(space)
        : this.subscriptionsForDirtyIds(space, dirtyIds);
      this.#queryStats.refreshCalls++;
      this.#queryStats.subscriptionsConsidered += subscriptions.length;
      this.server.recordRefreshCall(subscriptions.length);
      for (const subscription of subscriptions) {
        logger.debug("subscription-refresh/considered");
        if (
          dirtyIds !== undefined &&
          !subscriptionTouchesIds(subscription, dirtyIds)
        ) {
          logger.debug("subscription-refresh/skipped-clean");
          continue;
        }
        const patched = await this.server.patchSubscriptionEntities(
          space,
          subscription,
          dirtyIds,
          directCache,
        );
        if (patched.result !== null) {
          this.#queryStats.directPatchHits++;
          const shape = graphQueryShapeKey(subscription.query);
          this.#queryStats.directPatchShapes.set(
            shape,
            (this.#queryStats.directPatchShapes.get(shape) ?? 0) + 1,
          );
          this.server.recordDirectPatch();
          logger.debug("subscription-refresh/direct-patch");
          logger.debug(
            `subscription-refresh/direct-patch-shape/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
        } else {
          const shape = graphQueryShapeKey(subscription.query);
          const key = `${patched.nullReason}:${shape}`;
          this.#queryStats.patchNullReasons.set(
            key,
            (this.#queryStats.patchNullReasons.get(key) ?? 0) + 1,
          );
        }
        const state = patched.result ?? await (async () => {
          const key = queryCacheKey(subscription.query);
          const cached = queryResults.get(key);
          if (cached !== undefined) {
            this.#queryStats.sharedResultCacheHits++;
            this.server.recordRefreshReuseHit();
            logger.debug("subscription-refresh/full-query-cache-hit");
            logger.debug(
              `subscription-refresh/full-query-cache-hit-shape/${
                graphQueryShapeKey(subscription.query)
              }`,
            );
            return cached;
          }
          logger.debug("subscription-refresh/full-query");
          logger.debug(
            `subscription-refresh/full-query-shape/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
          const t0 = performance.now();
          const evaluated = await this.server.evaluateGraphQuery(
            space,
            subscription.query,
            undefined,
            reuse,
          );
          const elapsed = performance.now() - t0;
          this.#queryStats.refreshQueries++;
          this.#queryStats.refreshQueryMs += elapsed;
          const shape = graphQueryShapeKey(subscription.query);
          this.#queryStats.refreshQueryShapes.set(
            shape,
            (this.#queryStats.refreshQueryShapes.get(shape) ?? 0) + 1,
          );
          this.server.recordRefreshQuery(elapsed);
          queryResults.set(key, evaluated);
          return evaluated;
        })();
        if (sameEntities(state.entities, subscription.entities)) {
          logger.debug("subscription-refresh/no-change");
          continue;
        }
        subscription.entities = state.entities;
        subscription.serverSeq = state.serverSeq;
        this.retrackSubscription(subscription);
        const result = {
          ...state,
          subscriptionId: subscription.id,
        };
        const key = graphUpdateKey(result);
        const grouped = pendingUpdates.get(key);
        if (grouped) {
          grouped.subscriptionIds.push(subscription.id);
          continue;
        }
        pendingUpdates.set(key, {
          result,
          subscriptionIds: [subscription.id],
        });
      }
      for (const grouped of pendingUpdates.values()) {
        this.send({
          type: "graph.update",
          subscriptionId: grouped.subscriptionIds[0],
          subscriptionIds: grouped.subscriptionIds,
          space,
          result: grouped.result,
        });
      }
    } finally {
      logger.timeEnd("refresh-space");
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.reportQueryStats();
    this.server.cacheSubscriptions(this.#subscriptions.values());
    for (const subscriptionId of [...this.#subscriptions.keys()]) {
      this.untrackSubscription(subscriptionId);
    }
    this.server.disconnect(this);
  }

  private reportQueryStats(): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    const stats = this.#queryStats;
    if (
      stats.refreshCalls === 0 && stats.refreshQueries === 0 &&
      stats.directPatchHits === 0 && stats.sharedResultCacheHits === 0
    ) {
      return;
    }
    logger.warn(
      "query-stats",
      () => [
        `refreshCalls=${stats.refreshCalls}`,
        `subscriptions=${stats.subscriptionsConsidered}`,
        `refreshQueries=${stats.refreshQueries}/${
          stats.refreshQueryMs.toFixed(1)
        }ms`,
        `directPatch=${stats.directPatchHits}`,
        `sharedResultCache=${stats.sharedResultCacheHits}`,
        `fullShapes=${formatTopQueryShapes(stats.refreshQueryShapes)}`,
        `patchShapes=${formatTopQueryShapes(stats.directPatchShapes)}`,
        `topologySkips=${formatTopQueryShapes(stats.topologySkips)}`,
        `patchNull=${formatTopQueryShapes(stats.patchNullReasons)}`,
      ],
    );
  }

  private trackSubscription(subscription: SubscriptionState): void {
    this.#subscriptions.set(subscription.id, subscription);
    for (const trackedId of subscription.trackedIds) {
      let subscriptions = this.#subscriptionsByTrackedId.get(trackedId);
      if (subscriptions === undefined) {
        subscriptions = new Set();
        this.#subscriptionsByTrackedId.set(trackedId, subscriptions);
      }
      subscriptions.add(subscription.id);
    }
  }

  private retrackSubscription(subscription: SubscriptionState): void {
    const nextTrackedIds = trackedIdsForSubscription(
      subscription.query,
      subscription.entities,
    );
    if (setEquals(subscription.trackedIds, nextTrackedIds)) {
      return;
    }
    this.untrackSubscription(subscription.id);
    this.trackSubscription({
      ...subscription,
      trackedIds: nextTrackedIds,
    });
  }

  private untrackSubscription(subscriptionId: string): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription === undefined) {
      return;
    }
    this.#subscriptions.delete(subscriptionId);
    for (const trackedId of subscription.trackedIds) {
      const subscriptions = this.#subscriptionsByTrackedId.get(trackedId);
      if (subscriptions === undefined) {
        continue;
      }
      subscriptions.delete(subscriptionId);
      if (subscriptions.size === 0) {
        this.#subscriptionsByTrackedId.delete(trackedId);
      }
    }
  }
}

export class Server {
  #sessions: SessionRegistry;
  #connections = new Set<Connection>();
  #engines = new Map<string, Promise<Engine.Engine>>();
  #dirtySpaces = new Set<string>();
  #dirtyDocsBySpace = new Map<string, Set<string>>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> | null = null;
  #store?: URL;
  #queryStats = {
    initialQueries: 0,
    initialQueryMs: 0,
    refreshQueries: 0,
    refreshQueryMs: 0,
    directPatchHits: 0,
    refreshCalls: 0,
    subscriptionsConsidered: 0,
    sessionCacheHits: 0,
    sharedResultCacheHits: 0,
    topologySkips: new Map<string, number>(),
    patchNullReasons: new Map<string, number>(),
  };

  constructor(
    readonly options: {
      memory?: Provider<Protocol>;
      sessions?: SessionRegistry;
      serverSeq?: () => number;
      store?: URL;
      subscriptionRefreshDelayMs?: number;
    } = {},
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#store = options.store;
  }

  connect(send: Send): Connection {
    const connection = new Connection(this, send);
    this.#connections.add(connection);
    return connection;
  }

  disconnect(connection: Connection): void {
    this.#connections.delete(connection);
    if (this.#connections.size === 0) {
      this.cancelScheduledRefresh();
    }
  }

  recordInitialQuery(elapsedMs: number, usedSessionCache: boolean): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    if (usedSessionCache) {
      this.#queryStats.sessionCacheHits++;
      return;
    }
    this.#queryStats.initialQueries++;
    this.#queryStats.initialQueryMs += elapsedMs;
  }

  recordRefreshQuery(elapsedMs: number): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    this.#queryStats.refreshQueries++;
    this.#queryStats.refreshQueryMs += elapsedMs;
  }

  recordRefreshReuseHit(): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    this.#queryStats.sharedResultCacheHits++;
  }

  recordDirectPatch(): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    this.#queryStats.directPatchHits++;
  }

  recordRefreshCall(subscriptionCount: number): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    this.#queryStats.refreshCalls++;
    this.#queryStats.subscriptionsConsidered += subscriptionCount;
  }

  recordPatchNullReason(reason: string, shape: string): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    const key = `${reason}:${shape}`;
    this.#queryStats.patchNullReasons.set(
      key,
      (this.#queryStats.patchNullReasons.get(key) ?? 0) + 1,
    );
  }

  private reportQueryStats(): void {
    if (!MEMORY_QUERY_STATS) {
      return;
    }
    const stats = this.#queryStats;
    if (
      stats.initialQueries === 0 && stats.refreshQueries === 0 &&
      stats.directPatchHits === 0 && stats.refreshCalls === 0 &&
      stats.sessionCacheHits === 0 && stats.sharedResultCacheHits === 0
    ) {
      return;
    }
    logger.warn(
      "query-stats",
      () => [
        `initial=${stats.initialQueries}/${stats.initialQueryMs.toFixed(1)}ms`,
        `refresh=${stats.refreshQueries}/${stats.refreshQueryMs.toFixed(1)}ms`,
        `directPatch=${stats.directPatchHits}`,
        `refreshCalls=${stats.refreshCalls}`,
        `subscriptions=${stats.subscriptionsConsidered}`,
        `sessionCache=${stats.sessionCacheHits}`,
        `sharedResultCache=${stats.sharedResultCacheHits}`,
        `topologySkips=${formatTopQueryShapes(stats.topologySkips)}`,
        `patchNull=${formatTopQueryShapes(stats.patchNullReasons)}`,
      ],
    );
  }

  cacheSubscriptions(subscriptions: Iterable<SubscriptionState>): void {
    const bySession = new Map<string, SubscriptionState[]>();
    for (const subscription of subscriptions) {
      let bucket = bySession.get(subscription.sessionId);
      if (!bucket) {
        bucket = [];
        bySession.set(subscription.sessionId, bucket);
      }
      bucket.push(subscription);
    }

    for (const [sessionId, group] of bySession) {
      const first = group[0];
      if (!first) {
        continue;
      }
      this.#sessions.cacheSubscriptions(first.space, sessionId, group);
    }
  }

  async close(): Promise<void> {
    this.cancelScheduledRefresh();
    await this.#refreshing;
    this.reportQueryStats();
    for (const engine of this.#engines.values()) {
      Engine.close(await engine);
    }
    this.#engines.clear();
    this.#connections.clear();
  }

  async openSession(
    message: SessionOpenRequest,
  ): Promise<ResponseMessage<SessionOpenResult>> {
    const engine = await this.openEngine(message.space);
    return {
      type: "response",
      requestId: message.requestId,
      ok: this.#sessions.open(
        message.space,
        message.session,
        Engine.headSeq(engine),
      ),
    };
  }

  async transact(
    message: TransactRequest,
  ): Promise<ResponseMessage<Engine.AppliedCommit>> {
    if (this.#sessions.get(message.space, message.sessionId) === null) {
      return respondTypedError<Engine.AppliedCommit>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const commit = Engine.applyCommit(engine, {
        sessionId: message.sessionId,
        invocation: toInvocationRecord(message),
        authorization: message.authorization ?? {},
        commit: message.commit,
      });
      this.markSpaceDirty(
        message.space,
        message.commit.operations.map((operation) => operation.id),
      );
      return {
        type: "response",
        requestId: message.requestId,
        ok: commit,
      };
    } catch (error) {
      if (error instanceof Engine.ConflictError) {
        this.stageConflictRefreshDirtyIds(message.space, message.commit);
        await this.flushSubscriptions([message.space]);
      }
      return respondTypedError<Engine.AppliedCommit>(
        message.requestId,
        toError(
          error instanceof Engine.ConflictError
            ? "ConflictError"
            : "TransactionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async graphQuery(
    message: GraphQueryRequest,
  ): Promise<ResponseMessage<GraphQueryResult>> {
    if (this.#sessions.get(message.space, message.sessionId) === null) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const serverSeq = Engine.headSeq(engine);
      const t0 = performance.now();
      const cached = message.query.subscribe === true
        ? this.#sessions.getCachedQuery(
          message.space,
          message.sessionId,
          message.query,
          serverSeq,
        )
        : null;
      const result = cached ??
        await this.evaluateGraphQuery(message.space, message.query, engine);
      this.recordInitialQuery(performance.now() - t0, cached !== null);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          ...result,
          ...(message.query.subscribe === true
            ? { subscriptionId: crypto.randomUUID() }
            : {}),
        },
      };
    } catch (error) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async evaluateGraphQuery(
    space: string,
    query: GraphQuery,
    engine?: Engine.Engine,
    reuse?: QueryGraphReuseContext,
  ) {
    logger.timeStart("graph-query");
    try {
      return queryGraph(
        space,
        engine ?? await this.openEngine(space),
        query,
        reuse,
      );
    } finally {
      logger.timeEnd("graph-query");
    }
  }

  async patchSubscriptionEntities(
    space: string,
    subscription: SubscriptionState,
    dirtyIds: ReadonlySet<string> | undefined,
    cache: Map<string, EntitySnapshot>,
  ): Promise<
    { result: GraphQueryResult; nullReason?: undefined } | {
      result: null;
      nullReason: string;
    }
  > {
    if (dirtyIds === undefined) {
      this.recordPatchNullReason(
        "no-dirty-ids",
        graphQueryShapeKey(subscription.query),
      );
      logger.debug("subscription-refresh/patch-skip/no-dirty-ids");
      return { result: null, nullReason: "no-dirty-ids" };
    }

    const branch = subscription.query.branch ?? "";
    const touchedIds = collectTouchedSubscriptionIds(subscription, dirtyIds);
    if (touchedIds.length === 0) {
      this.recordPatchNullReason(
        "no-touched-ids",
        graphQueryShapeKey(subscription.query),
      );
      logger.debug("subscription-refresh/patch-skip/no-touched-ids");
      return { result: null, nullReason: "no-touched-ids" };
    }

    const previousById = new Map(
      subscription.entities.map((entity) => [entity.id, entity]),
    );
    const nextById = new Map(previousById);
    const engine = await this.openEngine(space);
    const sourcePatched = canPatchPlainRootSourceQuery(subscription.query)
      ? recomputePlainRootSourceQueryResult(
        space,
        subscription.query,
        engine,
        cache,
      )
      : null;

    for (const id of touchedIds) {
      const previous = previousById.get(id);
      const current = getOrLoadEntitySnapshot(cache, engine, id, branch);
      const topologyChange = queryHasRoot(subscription.query, id)
        ? documentTopologyChangeReasonForRootQuery(
          subscription.query,
          id,
          previous?.document,
          current.document,
        )
        : documentTopologyChangeReason(
          previous?.document,
          current.document,
        );
      if (topologyChange !== null) {
        if (topologyChange === "source" && sourcePatched !== null) {
          logger.debug("subscription-refresh/direct-patch/topology-source");
          logger.debug(
            `subscription-refresh/direct-patch/topology-source/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
          return { result: sourcePatched };
        }
        if (
          topologyChange === "sigil" &&
          queryIgnoresSigilTopology(subscription.query) &&
          !documentHasRootSigilRedirect(previous?.document) &&
          !documentHasRootSigilRedirect(current.document)
        ) {
          logger.debug(
            "subscription-refresh/patch-skip/topology-change/ignored",
          );
          logger.debug(
            `subscription-refresh/patch-skip/topology-change/ignored/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
        } else {
          const shape = graphQueryShapeKey(subscription.query);
          const key = `${topologyChange}:${shape}`;
          this.#queryStats.topologySkips.set(
            key,
            (this.#queryStats.topologySkips.get(key) ?? 0) + 1,
          );
          this.recordPatchNullReason(
            `topology-${topologyChange}`,
            shape,
          );
          logger.debug("subscription-refresh/patch-skip/topology-change");
          logger.debug(
            `subscription-refresh/patch-skip/topology-change/${topologyChange}`,
          );
          logger.debug(
            `subscription-refresh/patch-skip/topology-change-shape/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
          logger.debug(
            `subscription-refresh/patch-skip/topology-change-shape/${topologyChange}/${
              graphQueryShapeKey(subscription.query)
            }`,
          );
          return {
            result: null,
            nullReason: `topology-${topologyChange}`,
          };
        }
      }

      if (current.document === null && !queryHasRoot(subscription.query, id)) {
        nextById.delete(id);
        continue;
      }
      nextById.set(id, current);
    }

    return {
      result: {
        serverSeq: Engine.headSeq(engine, branch),
        entities: [...nextById.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
      },
    };
  }

  async putBlob(
    space: string,
    expectedHash: string,
    options: Engine.PutBlobOptions,
  ): Promise<{ created: boolean; blob: Blob }> {
    const engine = await this.openEngine(space);
    const actualHash = Engine.hashBlobBytes(options.value);
    if (actualHash !== expectedHash) {
      throw new Error("blob hash mismatch");
    }

    const existing = Engine.getBlob(engine, actualHash);
    const blob = Engine.putBlob(engine, options);
    return { created: existing === null, blob };
  }

  async getBlob(space: string, hash: string): Promise<Blob | null> {
    const engine = await this.openEngine(space);
    return Engine.getBlob(engine, hash as Reference);
  }

  markSpaceDirty(space: string, dirtyIds?: Iterable<string>): void {
    if (dirtyIds !== undefined) {
      let ids = this.#dirtyDocsBySpace.get(space);
      if (ids === undefined) {
        ids = new Set();
        this.#dirtyDocsBySpace.set(space, ids);
      }
      for (const id of dirtyIds) {
        ids.add(id);
      }
    }
    this.#dirtySpaces.add(space);
    this.scheduleRefresh();
  }

  private stageConflictRefreshDirtyIds(
    space: string,
    commit: ClientCommit,
  ): void {
    const ids = collectCommitTrackedIds(commit);
    if (ids.size === 0) {
      return;
    }
    let dirty = this.#dirtyDocsBySpace.get(space);
    if (dirty === undefined) {
      dirty = new Set();
      this.#dirtyDocsBySpace.set(space, dirty);
    }
    for (const id of ids) {
      dirty.add(id);
    }
  }

  async flushSubscriptions(spaces?: Iterable<string>): Promise<void> {
    logger.timeStart("schema-flush");
    this.cancelScheduledRefresh();

    const run = async () => {
      await this.refreshLoop(
        spaces === undefined ? undefined : new Set(spaces),
      );
      if (spaces !== undefined && this.#dirtySpaces.size > 0) {
        this.scheduleRefresh();
      }
    };

    const queued = this.#refreshing?.then(run, run) ?? run();
    this.#refreshing = queued.finally(() => {
      if (this.#refreshing === queued) {
        this.#refreshing = null;
      }
    });
    try {
      await this.#refreshing;
    } finally {
      logger.timeEnd("schema-flush");
    }
  }

  private scheduleRefresh(): void {
    if (this.#dirtySpaces.size === 0 || this.#refreshTimer !== null) {
      return;
    }
    this.#refreshTimer = setTimeout(
      () => {
        this.#refreshTimer = null;
        void this.flushSubscriptions();
      },
      this.options.subscriptionRefreshDelayMs ??
        SUBSCRIPTION_REFRESH_DELAY_MS,
    );
  }

  private cancelScheduledRefresh(): void {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (this.#connections.size === 0) {
      this.#dirtySpaces.clear();
      this.#dirtyDocsBySpace.clear();
    }
  }

  private async refreshLoop(initial?: Set<string>): Promise<void> {
    let pending = initial;
    while (true) {
      const spaces = pending ? [...pending] : [...this.#dirtySpaces];
      if (spaces.length === 0) {
        return;
      }

      for (const space of spaces) {
        this.#dirtySpaces.delete(space);
      }
      pending = undefined;

      for (const space of spaces) {
        const dirtyIds = this.#dirtyDocsBySpace.get(space);
        if (dirtyIds !== undefined) {
          this.#dirtyDocsBySpace.delete(space);
        }
        for (const connection of this.#connections) {
          await connection.refreshMatching(space, dirtyIds);
        }
      }

      if (initial !== undefined) {
        return;
      }
    }
  }

  async respond(payload: string): Promise<string | null> {
    const hello = parseHelloMessage(payload);
    if (hello !== null) {
      return JSON.stringify(
        {
          type: "hello.ok",
          protocol: MEMORY_V2_PROTOCOL,
        } satisfies ServerMessage,
      );
    }

    const legacy = parseLegacySessionOpen(payload);
    if (legacy === null) {
      return null;
    }

    const engine = await this.openEngine(legacy.space);
    const result = this.#sessions.open(
      legacy.space,
      legacy.session,
      Engine.headSeq(engine),
    );
    return JSON.stringify(
      {
        the: "task/return",
        of: legacy.id as LegacyServerMessage["of"],
        is: { ok: result },
      } satisfies LegacyServerMessage,
    );
  }

  private openEngine(space: string): Promise<Engine.Engine> {
    const existing = this.#engines.get(space);
    if (existing !== undefined) {
      return existing;
    }

    const opened = Engine.open({
      url: this.#store
        ? resolveSpaceStoreUrl(this.#store, space as any, "v2")
        : new URL(`memory:///${encodeURIComponent(space)}`),
    });
    opened.catch(() => {
      if (this.#engines.get(space) === opened) {
        this.#engines.delete(space);
      }
    });
    this.#engines.set(space, opened);
    return opened;
  }
}

const toInvocationRecord = (message: TransactRequest) => {
  const invocation = message.invocation;
  if (isRecord(invocation)) {
    return {
      iss: typeof invocation.iss === "string" ? invocation.iss : message.space,
      aud: typeof invocation.aud === "string" ? invocation.aud : null,
      cmd: typeof invocation.cmd === "string"
        ? invocation.cmd
        : "/memory/transact",
      sub: typeof invocation.sub === "string" ? invocation.sub : message.space,
      ...invocation,
    };
  }

  return {
    iss: message.space,
    aud: null,
    cmd: "/memory/transact",
    sub: message.space,
    args: {
      localSeq: message.commit.localSeq,
    },
  };
};

const collectCommitTrackedIds = (commit: ClientCommit): Set<string> => {
  const ids = new Set<string>();
  for (const operation of commit.operations) {
    ids.add(operation.id);
  }
  for (const read of commit.reads.confirmed) {
    ids.add(read.id);
  }
  for (const read of commit.reads.pending) {
    ids.add(read.id);
  }
  return ids;
};

const sameEntities = (
  left: readonly EntitySnapshot[],
  right: readonly EntitySnapshot[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entity, index) => {
    const other = right[index];
    return other !== undefined &&
      entity.id === other.id &&
      entity.seq === other.seq &&
      entity.hash === other.hash;
  });
};

const setEquals = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
};

const trackedIdsForSubscription = (
  query: GraphQuery,
  entities: readonly EntitySnapshot[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const root of query.roots) {
    ids.add(root.id);
  }
  for (const entity of entities) {
    ids.add(entity.id);
  }
  return ids;
};

const subscriptionTouchesIds = (
  subscription: SubscriptionState,
  dirtyIds: ReadonlySet<string>,
): boolean => {
  for (const root of subscription.query.roots) {
    if (dirtyIds.has(root.id)) {
      return true;
    }
  }
  for (const entity of subscription.entities) {
    if (dirtyIds.has(entity.id)) {
      return true;
    }
  }
  return false;
};

const collectTouchedSubscriptionIds = (
  subscription: SubscriptionState,
  dirtyIds: ReadonlySet<string>,
): string[] => {
  const touched = new Set<string>();
  for (const root of subscription.query.roots) {
    if (dirtyIds.has(root.id)) {
      touched.add(root.id);
    }
  }
  for (const entity of subscription.entities) {
    if (dirtyIds.has(entity.id)) {
      touched.add(entity.id);
    }
  }
  return [...touched];
};

const queryHasRoot = (query: GraphQuery, id: string): boolean =>
  query.roots.some((root) => root.id === id);

const queryIgnoresSigilTopology = (query: GraphQuery): boolean =>
  query.roots.every((root) => root.selector.schema === false);

const canPatchPlainRootSourceQuery = (query: GraphQuery): boolean =>
  query.roots.every((root) =>
    root.selector.schema === false && root.selector.path.length === 0
  );

const documentHasRootSigilRedirect = (document: unknown): boolean => {
  if (document === null || typeof document !== "object") {
    return false;
  }
  const value = (document as { value?: unknown }).value;
  return isSigilWriteRedirectLink(value);
};

const documentSourceId = (document: unknown): string | null => {
  if (!isRecord(document) || !isRecord(document.source)) {
    return null;
  }
  const shortId = document.source["/"];
  return typeof shortId === "string" ? `of:${shortId}` : null;
};

const documentPatternId = (document: unknown, space: string): string | null => {
  if (!isRecord(document) || !isRecord(document.value)) {
    return null;
  }
  const value = document.value;
  if (typeof value.$TYPE === "string") {
    const shortId = refer({
      causal: { patternId: value.$TYPE, type: "pattern" },
    }).toJSON()["/"];
    return `of:${shortId}`;
  }
  if (!isPrimitiveCellLink(value.spell)) {
    return null;
  }
  const parsed = parseLink(value.spell, {
    space: space as any,
    id: "" as any,
    type: "application/json",
    path: [],
  });
  if (
    parsed?.space !== space ||
    typeof parsed.id !== "string" ||
    (parsed.type ?? "application/json") !== "application/json"
  ) {
    return null;
  }
  return parsed.id;
};

const cacheKeyForEntity = (branch: string, id: string): string =>
  `${branch}\0${id}`;

const getOrLoadEntitySnapshot = (
  cache: Map<string, EntitySnapshot>,
  engine: Engine.Engine,
  id: string,
  branch: string,
): EntitySnapshot => {
  const key = cacheKeyForEntity(branch, id);
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const state = Engine.readState(engine, { id, branch });
  const snapshot: EntitySnapshot = {
    id,
    seq: state?.seq ?? 0,
    hash: state?.hash,
    document: state?.document ?? null,
  };
  cache.set(key, snapshot);
  return snapshot;
};

const recomputePlainRootSourceQueryResult = (
  space: string,
  query: GraphQuery,
  engine: Engine.Engine,
  cache: Map<string, EntitySnapshot>,
): GraphQueryResult | null => {
  const branch = query.branch ?? "";
  const entities = new Map<string, EntitySnapshot>();
  const pending = [...new Set(query.roots.map((root) => root.id))];
  const rootIds = new Set(pending);
  const visited = new Set<string>();

  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);

    const snapshot = getOrLoadEntitySnapshot(cache, engine, id, branch);
    if (rootIds.has(id) || snapshot.document !== null) {
      entities.set(id, snapshot);
    }
    if (snapshot.document === null) {
      continue;
    }
    if (rootIds.has(id) && documentHasRootSigilRedirect(snapshot.document)) {
      return null;
    }
    const patternId = documentPatternId(snapshot.document, space);
    if (patternId !== null) {
      pending.push(patternId);
    }
    const sourceId = documentSourceId(snapshot.document);
    if (sourceId !== null) {
      pending.push(sourceId);
    }
  }

  return {
    serverSeq: Engine.headSeq(engine, branch),
    entities: [...entities.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  };
};

const documentTopologyChangeReason = (
  previous: unknown,
  current: unknown,
): "source" | "sigil" | null => {
  const left = collectTopologyRefs(previous);
  const right = collectTopologyRefs(current);
  if (
    left.source.length !== right.source.length ||
    left.source.some((entry, index) => entry !== right.source[index])
  ) {
    return "source";
  }
  if (
    left.sigil.length !== right.sigil.length ||
    left.sigil.some((entry, index) => entry !== right.sigil[index])
  ) {
    return "sigil";
  }
  return null;
};

const documentTopologyChangeReasonForRootQuery = (
  query: GraphQuery,
  id: string,
  previous: unknown,
  current: unknown,
): "source" | "sigil" | null => {
  const rootSelectors = query.roots
    .filter((root) => root.id === id)
    .map((root) => root.selector);
  if (rootSelectors.length === 0) {
    return documentTopologyChangeReason(previous, current);
  }
  const left = collectRootScopedTopologyRefs(previous, rootSelectors);
  const right = collectRootScopedTopologyRefs(current, rootSelectors);
  if (
    left.source.length !== right.source.length ||
    left.source.some((entry, index) => entry !== right.source[index])
  ) {
    return "source";
  }
  if (
    left.sigil.length !== right.sigil.length ||
    left.sigil.some((entry, index) => entry !== right.sigil[index])
  ) {
    return "sigil";
  }
  return null;
};

const collectTopologyRefs = (
  document: unknown,
): { source: string[]; sigil: string[] } => {
  if (document === null || document === undefined) {
    return { source: [], sigil: [] };
  }
  const source: string[] = [];
  const sigil: string[] = [];
  collectValueTopologyRefs(document, [], true, { source, sigil });
  source.sort();
  sigil.sort();
  return { source, sigil };
};

const collectRootScopedTopologyRefs = (
  document: unknown,
  selectors: ReadonlyArray<{
    path: readonly string[];
    schema?: unknown;
  }>,
): { source: string[]; sigil: string[] } => {
  if (document === null || document === undefined || !isRecord(document)) {
    return { source: [], sigil: [] };
  }

  const source = new Set<string>();
  const sigil = new Set<string>();

  if (isSourceLink(document.source)) {
    source.add(`source=>${document.source["/"]}`);
  }

  const value = document.value;
  if (isRecord(value) && isPrimitiveCellLink(value.spell)) {
    sigil.add(`value.spell=>${JSON.stringify(value.spell)}`);
  }

  for (const selector of selectors) {
    const selected = getValueAtPath(value, selector.path);
    if (selected === undefined) {
      continue;
    }
    collectSchemaScopedValueTopologyRefs(
      selected,
      ["value", ...selector.path],
      selector.schema,
      { source, sigil },
    );
  }

  return {
    source: [...source].sort(),
    sigil: [...sigil].sort(),
  };
};

const getValueAtPath = (
  value: unknown,
  path: readonly string[],
): unknown => {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const collectSchemaScopedValueTopologyRefs = (
  value: unknown,
  path: readonly (string | number)[],
  schema: unknown,
  entries: { source: Set<string>; sigil: Set<string> },
): void => {
  if (isSourceLink(value)) {
    entries.source.add(`${path.join(".")}=>${value["/"]}`);
    return;
  }
  if (isPrimitiveCellLink(value)) {
    entries.sigil.add(`${path.join(".")}=>${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema) ? schema.items : undefined;
    value.forEach((item, index) => {
      const nextSchema = Array.isArray(itemSchema)
        ? itemSchema[index]
        : itemSchema;
      collectSchemaScopedValueTopologyRefs(
        item,
        [...path, index],
        nextSchema ?? true,
        entries,
      );
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (!isRecord(schema)) {
    if (schema === false) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      collectSchemaScopedValueTopologyRefs(
        nested,
        [...path, key],
        true,
        entries,
      );
    }
    return;
  }

  if (
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.allOf)
  ) {
    for (const [key, nested] of Object.entries(value)) {
      collectSchemaScopedValueTopologyRefs(
        nested,
        [...path, key],
        true,
        entries,
      );
    }
    return;
  }

  const properties = isRecord(schema.properties)
    ? schema.properties
    : undefined;
  const additionalProperties = schema.additionalProperties;
  for (const [key, nested] of Object.entries(value)) {
    const nextSchema = properties?.[key];
    if (nextSchema !== undefined) {
      collectSchemaScopedValueTopologyRefs(
        nested,
        [...path, key],
        nextSchema,
        entries,
      );
      continue;
    }
    if (properties !== undefined && additionalProperties === undefined) {
      continue;
    }
    if (additionalProperties === false) {
      continue;
    }
    collectSchemaScopedValueTopologyRefs(
      nested,
      [...path, key],
      additionalProperties ?? true,
      entries,
    );
  }
};

const collectValueTopologyRefs = (
  value: unknown,
  path: (string | number)[],
  isDocumentRoot: boolean,
  entries: { source: string[]; sigil: string[] },
): void => {
  if (isSourceLink(value)) {
    entries.source.push(`${path.join(".")}=>${value["/"]}`);
    return;
  }
  if (isPrimitiveCellLink(value)) {
    entries.sigil.push(`${path.join(".")}=>${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectValueTopologyRefs(item, [...path, index], false, entries)
    );
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (isDocumentRoot && isSourceLink(record.source)) {
    entries.source.push(`source=>${record.source["/"]}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    collectValueTopologyRefs(nested, [...path, key], false, entries);
  }
};

const queryCacheKey = (query: GraphQuery): string => JSON.stringify(query);

const graphQueryShapeKey = (query: GraphQuery): string =>
  query.roots
    .map((root) =>
      `${encodePath(root.selector.path)}:${
        root.selector.schema === false ? "plain" : "schema"
      }`
    )
    .sort()
    .join("|");

const encodePath = (path: readonly string[]): string =>
  path.length === 0 ? "." : path.join(".");

const graphUpdateKey = (result: GraphQueryResult): string =>
  JSON.stringify({
    serverSeq: result.serverSeq,
    entities: result.entities.map((entity) => ({
      id: entity.id,
      seq: entity.seq,
      hash: entity.hash,
    })),
  });

export const parseClientMessage = (
  payload: string,
): ClientMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.type === "hello" && typeof parsed.protocol === "string") {
    return {
      type: "hello",
      protocol: parsed.protocol as HelloMessage["protocol"],
    };
  }

  if (
    parsed.type === "session.open" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    isRecord(parsed.session)
  ) {
    return {
      type: "session.open",
      requestId: parsed.requestId,
      space: parsed.space,
      session: {
        sessionId: typeof parsed.session.sessionId === "string"
          ? parsed.session.sessionId
          : undefined,
        seenSeq: typeof parsed.session.seenSeq === "number"
          ? parsed.session.seenSeq
          : undefined,
      },
    };
  }

  if (
    parsed.type === "transact" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isRecord(parsed.commit)
  ) {
    return {
      type: "transact",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      commit: parsed.commit as unknown as TransactRequest["commit"],
      invocation: isRecord(parsed.invocation) ? parsed.invocation : undefined,
      authorization: (parsed.authorization ?? undefined) as JSONValue,
    };
  }

  if (
    parsed.type === "graph.query" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isRecord(parsed.query) &&
    Array.isArray(parsed.query.roots)
  ) {
    return {
      type: "graph.query",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      query: parsed.query as unknown as GraphQueryRequest["query"],
    };
  }

  if (
    parsed.type === "graph.unsubscribe" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.subscriptionId === "string"
  ) {
    return {
      type: "graph.unsubscribe",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      subscriptionId: parsed.subscriptionId,
    };
  }

  return null;
};

const parseHelloMessage = (payload: string): HelloMessage | null => {
  const parsed = parseClientMessage(payload);
  return parsed?.type === "hello" ? parsed : null;
};

const parseLegacySessionOpen = (
  payload: string,
): { id: string; space: string; session: SessionDescriptor } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (
    !isRecord(parsed) ||
    parsed.cmd !== "session.open" ||
    typeof parsed.id !== "string" ||
    !isRecord(parsed.args)
  ) {
    return null;
  }

  return {
    id: parsed.id,
    space: "legacy",
    session: {
      sessionId: typeof parsed.args.sessionId === "string"
        ? parsed.args.sessionId
        : undefined,
      seenSeq: typeof parsed.args.seenSeq === "number"
        ? parsed.args.seenSeq
        : undefined,
    },
  };
};

export type { LegacyServerMessage };
