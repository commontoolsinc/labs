import type { JSONValue } from "../interface.ts";
import { resolveSpaceStoreUrl } from "../memory.ts";
import type { Protocol, Provider } from "../provider.ts";
import {
  type Blob,
  type ClientMessage,
  type EntitySnapshot,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
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
import { queryGraph } from "./query.ts";

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
  #ready = false;
  #closed = false;

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
          this.#subscriptions.set(response.ok.subscriptionId, {
            id: response.ok.subscriptionId,
            space: parsed.space,
            sessionId: parsed.sessionId,
            query: parsed.query,
            entities: response.ok.entities,
            serverSeq: response.ok.serverSeq,
          });
        }
        return;
      }
      case "graph.unsubscribe": {
        this.#subscriptions.delete(parsed.subscriptionId);
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

  async refresh(space: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    for (const subscription of this.subscriptionsForSpace(space)) {
      const state = await this.server.evaluateGraphQuery(
        space,
        subscription.query,
      );
      if (sameEntities(state.entities, subscription.entities)) {
        continue;
      }
      subscription.entities = state.entities;
      subscription.serverSeq = state.serverSeq;
      this.send({
        type: "graph.update",
        subscriptionId: subscription.id,
        space,
        result: {
          ...state,
          subscriptionId: subscription.id,
        },
      });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.server.cacheSubscriptions(this.#subscriptions.values());
    this.#subscriptions.clear();
    this.server.disconnect(this);
  }
}

export class Server {
  #sessions: SessionRegistry;
  #connections = new Set<Connection>();
  #engines = new Map<string, Promise<Engine.Engine>>();
  #dirtySpaces = new Set<string>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> | null = null;
  #store?: URL;

  constructor(
    readonly options: {
      memory?: Provider<Protocol>;
      sessions?: SessionRegistry;
      serverSeq?: () => number;
      store?: URL;
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
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    await this.#refreshing;
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
      this.markSpaceDirty(message.space);
      return {
        type: "response",
        requestId: message.requestId,
        ok: commit,
      };
    } catch (error) {
      if (error instanceof Engine.ConflictError) {
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
  ) {
    return queryGraph(space, engine ?? await this.openEngine(space), query);
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

  markSpaceDirty(space: string): void {
    this.#dirtySpaces.add(space);
    this.scheduleRefresh();
  }

  async flushSubscriptions(spaces?: Iterable<string>): Promise<void> {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }

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
    await this.#refreshing;
  }

  private scheduleRefresh(): void {
    if (this.#dirtySpaces.size === 0 || this.#refreshTimer !== null) {
      return;
    }
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.flushSubscriptions();
    }, 0);
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
        for (const connection of this.#connections) {
          await connection.refresh(space);
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
      entity.hash === other.hash &&
      JSON.stringify(entity.document) === JSON.stringify(other.document);
  });
};

const queryCacheKey = (query: GraphQuery): string => JSON.stringify(query);

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
