import * as FS from "@std/fs";
import * as Path from "@std/path";
import { hashSchema } from "@commontools/data-model/schema-hash";
import { resolveSpaceStoreUrl } from "../memory.ts";
import type { Protocol, Provider } from "../provider.ts";
import {
  type Blob,
  type ClientCommit,
  type ClientMessage,
  decodeMemoryV2Boundary,
  encodeMemoryV2Boundary,
  type EntitySnapshot,
  getMemoryV2Flags,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
  isMemoryV2Flags,
  MEMORY_V2_PROTOCOL,
  type Reference,
  type ResponseMessage,
  sameMemoryV2Flags,
  type ServerMessage,
  type SessionAckRequest,
  type SessionAckResult,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenRequest,
  type SessionOpenResult,
  type SessionRevokedMessage,
  type SessionSync,
  type SessionSyncUpsert,
  type SessionToken,
  type TransactRequest,
  type V2Error,
  type WatchAddRequest,
  type WatchAddResult,
  type WatchSetRequest,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import * as Engine from "./engine.ts";
import {
  cloneTrackedGraphState,
  extendTrackedGraph,
  queryGraph,
  type QueryGraphReuseContext,
  refreshTrackedGraph,
  type TrackedGraphState,
  trackGraph,
} from "./query.ts";

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
type SessionCacheEntry = SessionSyncUpsert;

type SessionState = {
  id: string;
  space: string;
  sessionToken: SessionToken;
  seenSeq: number;
  lastSyncedSeq: number;
  watches: WatchSpec[];
  graphs: Map<string, TrackedGraphState>;
  entities: Map<string, SessionCacheEntry>;
  trackedIds: Set<string>;
  expiresAt: number | null;
  ownerConnectionId: string | null;
  principal?: string;
};

type OpenSessionState = SessionOpenResult & {
  revokedConnectionId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toError = (name: string, message: string): V2Error => ({
  name,
  message,
});

const respondTypedError = <Result>(
  requestId: string,
  error: V2Error,
): ResponseMessage<Result> => ({
  type: "response",
  requestId,
  error,
});

const cacheKeyForEntity = (branch: string, id: string): string =>
  `${branch}\0${id}`;

const sameSnapshot = (
  left: SessionCacheEntry | undefined,
  right: SessionCacheEntry | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.branch === right.branch &&
    left.id === right.id &&
    left.seq === right.seq &&
    left.deleted === right.deleted;
};

const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0;

const sessionKey = (space: string, sessionId: string): string =>
  `${space}\0${sessionId}`;

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const revokedError = (message: string): Error =>
  Object.assign(new Error(message), { name: "SessionRevokedError" });

const nextSessionToken = (): SessionToken =>
  crypto.randomUUID() as SessionToken;

const toCacheEntry = (
  entity: EntitySnapshot,
): SessionCacheEntry => {
  if (entity.document === null) {
    return {
      branch: entity.branch,
      id: entity.id,
      seq: entity.seq,
      deleted: true,
    };
  }
  return {
    branch: entity.branch,
    id: entity.id,
    seq: entity.seq,
    doc: entity.document,
  };
};

const trackedIdsFromEntries = (
  entries: Iterable<SessionCacheEntry>,
): Set<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
  }
  return ids;
};

const groupedQueries = (
  watches: readonly WatchSpec[],
): Map<string, GraphQuery> => {
  const grouped = new Map<string, GraphQuery>();
  for (const watch of watches) {
    const branch = watch.query.branch ?? "";
    const existing = grouped.get(branch);
    if (existing === undefined) {
      grouped.set(branch, {
        branch,
        roots: [...watch.query.roots],
      });
      continue;
    }
    existing.roots.push(...watch.query.roots);
  }
  return grouped;
};

const mergeWatchesById = (
  current: readonly WatchSpec[],
  added: readonly WatchSpec[],
): WatchSpec[] => {
  const merged = new Map(current.map((watch) => [watch.id, watch] as const));
  for (const watch of added) {
    merged.set(watch.id, watch);
  }
  return [...merged.values()];
};

const watchRootIdentity = (root: GraphQuery["roots"][number]): string =>
  JSON.stringify([
    root.id,
    root.selector.path,
    root.selector.schema === undefined
      ? ""
      : hashSchema(root.selector.schema).toString(),
  ]);

const watchQueryIdentity = (watch: WatchSpec): string =>
  JSON.stringify({
    branch: watch.query.branch ?? "",
    atSeq: watch.query.atSeq ?? null,
    excludeSent: watch.query.excludeSent === true,
    roots: watch.query.roots.map(watchRootIdentity).toSorted(),
  });

const sameWatchSpec = (
  left: WatchSpec,
  right: WatchSpec,
): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  watchQueryIdentity(left) === watchQueryIdentity(right);

const buildFullSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
): SessionSync => {
  const removes = [...previous.values()]
    .filter((entry) => !next.has(cacheKeyForEntity(entry.branch, entry.id)))
    .map((entry) => ({ branch: entry.branch, id: entry.id }))
    .sort((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    );
  const upserts = [...next.values()].sort((left, right) =>
    left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
  );
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts,
    removes,
  };
};

const buildDiffSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
): SessionSync => {
  const upserts: SessionCacheEntry[] = [];
  for (const [key, current] of next.entries()) {
    if (!sameSnapshot(previous.get(key), current)) {
      upserts.push(current);
    }
  }
  const removes = [...previous.entries()]
    .filter(([key]) => !next.has(key))
    .map(([, entry]) => ({ branch: entry.branch, id: entry.id }))
    .sort((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    );
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts: upserts.toSorted((left, right) =>
      left.branch.localeCompare(right.branch) || left.id.localeCompare(right.id)
    ),
    removes,
  };
};

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  #prune(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
  }

  open(
    space: string,
    session: SessionDescriptor,
    serverSeq: number,
    ownerConnectionId = "session-registry",
    principal?: string,
  ): OpenSessionState {
    this.#prune();
    const sessionId = session.sessionId ?? crypto.randomUUID();
    const key = sessionKey(space, sessionId);
    const existing = this.#sessions.get(key);
    if (
      existing?.principal !== undefined &&
      principal !== existing.principal
    ) {
      throw authorizationError(
        `session ${sessionId} is already bound to ${existing.principal}`,
      );
    }
    if (
      existing !== undefined &&
      session.sessionToken !== existing.sessionToken
    ) {
      throw revokedError(
        `session ${sessionId} resume token is no longer valid`,
      );
    }
    const seenSeq = Math.max(
      existing?.seenSeq ?? 0,
      session.seenSeq ?? 0,
    );
    const sessionToken = nextSessionToken();
    const revokedConnectionId = existing?.ownerConnectionId !== undefined &&
        existing.ownerConnectionId !== null &&
        existing.ownerConnectionId !== ownerConnectionId
      ? existing.ownerConnectionId
      : undefined;
    this.#sessions.set(key, {
      id: sessionId,
      space,
      sessionToken,
      seenSeq,
      lastSyncedSeq: existing?.lastSyncedSeq ?? seenSeq,
      watches: existing?.watches ?? [],
      graphs: existing?.graphs ?? new Map(),
      entities: existing?.entities ?? new Map(),
      trackedIds: existing?.trackedIds ??
        trackedIdsFromEntries(existing?.entities?.values() ?? []),
      expiresAt: null,
      ownerConnectionId,
      principal: existing?.principal ?? principal,
    });
    return {
      sessionId,
      sessionToken,
      serverSeq,
      ...(existing !== undefined ? { resumed: true } : {}),
      ...(revokedConnectionId ? { revokedConnectionId } : {}),
    };
  }

  get(space: string, sessionId: string): SessionState | null {
    this.#prune();
    return this.#sessions.get(sessionKey(space, sessionId)) ?? null;
  }

  updateSeenSeq(
    space: string,
    sessionId: string,
    seenSeq: number,
  ): SessionState | null {
    const session = this.get(space, sessionId);
    if (session === null) {
      return null;
    }
    session.seenSeq = Math.max(session.seenSeq, seenSeq);
    return session;
  }

  detach(space: string, sessionId: string, ownerConnectionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session?.ownerConnectionId === ownerConnectionId) {
      session.ownerConnectionId = null;
      session.expiresAt = Date.now() + this.#ttlMs;
    }
  }
}

type Send = (message: ServerMessage) => void;

type SessionHandle = {
  space: string;
  sessionId: string;
};

class Connection {
  #ready = false;
  #closed = false;
  #sessions = new Map<string, SessionHandle>();
  #receiving: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    private readonly server: Server,
    private readonly send: Send,
  ) {}

  hasSession(space: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(space, sessionId));
  }

  addSession(space: string, sessionId: string): void {
    const key = sessionKey(space, sessionId);
    if (this.#sessions.has(key)) {
      return;
    }
    this.#sessions.set(key, { space, sessionId });
  }

  revokeSession(
    space: string,
    sessionId: string,
    reason: SessionRevokedMessage["reason"],
  ): void {
    const key = sessionKey(space, sessionId);
    if (!this.#sessions.delete(key) || this.#closed) {
      return;
    }
    this.send({
      type: "session/revoked",
      space,
      sessionId,
      reason,
    });
  }

  async receive(payload: string): Promise<void> {
    const previous = this.#receiving;
    const current = previous.catch(() => undefined).then(() =>
      this.receiveOrdered(payload)
    );
    this.#receiving = current.then(() => undefined, () => undefined);
    return await current;
  }

  private requireSession(
    requestId: string,
    space: string,
    sessionId: string,
  ): boolean {
    if (this.hasSession(space, sessionId)) {
      return true;
    }
    this.send({
      type: "response",
      requestId,
      error: toError(
        "SessionError",
        "Session is not open on this connection",
      ),
    });
    return false;
  }

  private async receiveOrdered(payload: string): Promise<void> {
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
      const expectedFlags = getMemoryV2Flags();
      if (!sameMemoryV2Flags(parsed.flags, expectedFlags)) {
        this.send({
          type: "response",
          requestId: "handshake",
          error: toError(
            "ProtocolError",
            `memory/v2 flag mismatch: client=${
              JSON.stringify(parsed.flags)
            } server=${JSON.stringify(expectedFlags)}`,
          ),
        });
        return;
      }
      this.#ready = true;
      this.send({
        type: "hello.ok",
        protocol: MEMORY_V2_PROTOCOL,
        flags: expectedFlags,
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
      case "session.open": {
        const response = await this.server.openSession(parsed, this);
        if (response.ok?.sessionId) {
          this.addSession(parsed.space, response.ok.sessionId);
        }
        this.send(response);
        return;
      }
      case "transact":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.transact(parsed));
        return;
      case "graph.query":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.graphQuery(parsed));
        return;
      case "session.watch.set":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.watchSet(parsed));
        return;
      case "session.watch.add":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.watchAdd(parsed));
        return;
      case "session.ack":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.ackSession(parsed));
        return;
    }
  }

  async refreshDirty(
    space: string,
    dirtyIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (this.#closed) {
      return;
    }

    for (const { sessionId } of this.#sessions.values()) {
      if (this.#closed) {
        return;
      }
      const effect = await this.server.syncSessionForConnection(
        space,
        sessionId,
        dirtyIds,
      );
      if (this.#closed) {
        return;
      }
      if (effect !== null) {
        this.send(effect);
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const { space, sessionId } of this.#sessions.values()) {
      this.server.detachSession(space, sessionId, this.id);
    }
    this.server.disconnect(this);
  }
}

export class Server {
  #sessions: SessionRegistry;
  #connections = new Map<string, Connection>();
  #engines = new Map<string, Promise<Engine.Engine>>();
  #dirtySpaces = new Set<string>();
  #dirtyDocsBySpace = new Map<string, Set<string>>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> | null = null;
  #store?: URL;

  constructor(
    readonly options: {
      memory?: Provider<Protocol>;
      sessions?: SessionRegistry;
      store?: URL;
      subscriptionRefreshDelayMs?: number;
      authorizeSessionOpen?: (
        message: SessionOpenRequest,
      ) => Promise<string | undefined> | string | undefined;
    } = {},
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#store = options.store;
  }

  connect(send: Send): Connection {
    const connection = new Connection(crypto.randomUUID(), this, send);
    this.#connections.set(connection.id, connection);
    return connection;
  }

  disconnect(connection: Connection): void {
    this.#connections.delete(connection.id);
    if (this.#connections.size === 0) {
      this.cancelScheduledRefresh();
    }
  }

  detachSession(
    space: string,
    sessionId: string,
    ownerConnectionId: string,
  ): void {
    this.#sessions.detach(space, sessionId, ownerConnectionId);
  }

  async close(): Promise<void> {
    this.cancelScheduledRefresh();
    await this.#refreshing;
    for (const engine of this.#engines.values()) {
      Engine.close(await engine);
    }
    this.#engines.clear();
    this.#connections.clear();
  }

  async openSession(
    message: SessionOpenRequest,
    connection: Connection,
  ): Promise<ResponseMessage<SessionOpenResult>> {
    try {
      const engine = await this.openEngine(message.space);
      const principal = await this.options.authorizeSessionOpen?.(message);
      const opened = this.#sessions.open(
        message.space,
        message.session,
        Engine.serverSeq(engine),
        connection.id,
        principal,
      );
      if (opened.revokedConnectionId !== undefined) {
        this.#connections.get(opened.revokedConnectionId)?.revokeSession(
          message.space,
          opened.sessionId,
          "taken-over",
        );
      }
      const catchup = opened.resumed === true
        ? await this.syncSessionForConnection(
          message.space,
          opened.sessionId,
        )
        : null;
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
          serverSeq: opened.serverSeq,
          ...(opened.resumed === true ? { resumed: true } : {}),
          ...(catchup ? { sync: catchup.effect } : {}),
        },
      };
    } catch (error) {
      return respondTypedError<SessionOpenResult>(
        message.requestId,
        toError(
          error instanceof Error && error.name === "AuthorizationError"
            ? "AuthorizationError"
            : error instanceof Error && error.name === "SessionRevokedError"
            ? "SessionRevokedError"
            : "ProtocolError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async ackSession(
    message: SessionAckRequest,
  ): Promise<ResponseMessage<SessionAckResult>> {
    const session = this.#sessions.updateSeenSeq(
      message.space,
      message.sessionId,
      message.seenSeq,
    );
    if (session === null) {
      return respondTypedError<SessionAckResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    try {
      const engine = await this.openEngine(message.space);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
        },
      };
    } catch (error) {
      return respondTypedError<SessionAckResult>(
        message.requestId,
        toError(
          "SessionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
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
      const invocation = toInvocationRecord(message);
      const commit = Engine.applyCommit(engine, {
        sessionId: message.sessionId,
        invocation,
        invocationPayload: isRecord(message.invocation)
          ? message.invocation
          : invocation,
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
        await this.flushSessions([message.space]);
      }
      return respondTypedError<Engine.AppliedCommit>(
        message.requestId,
        toError(
          error instanceof Engine.ConflictError
            ? "ConflictError"
            : error instanceof Engine.ProtocolError
            ? "ProtocolError"
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
    if ((message.query as GraphQuery & { subscribe?: boolean }).subscribe) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError(
          "ProtocolError",
          "live graph.query subscriptions were removed; use session.watch.set",
        ),
      );
    }

    try {
      return {
        type: "response",
        requestId: message.requestId,
        ok: await this.evaluateGraphQuery(message.space, message.query),
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

  async watchSet(
    message: WatchSetRequest,
  ): Promise<ResponseMessage<WatchSetResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<WatchSetResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const { serverSeq, graphs, entities } = await this.evaluateWatchSet(
        message.space,
        message.watches,
      );
      const sync = buildFullSync(
        session.entities,
        entities,
        session.seenSeq,
        serverSeq,
      );
      session.watches = message.watches;
      session.graphs = graphs;
      session.entities = entities;
      session.trackedIds = trackedIdsFromEntries(entities.values());
      session.lastSyncedSeq = serverSeq;
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          sync,
        },
      };
    } catch (error) {
      return respondTypedError<WatchSetResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async watchAdd(
    message: WatchAddRequest,
  ): Promise<ResponseMessage<WatchAddResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<WatchAddResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const existingById = new Map(
        session.watches.map((watch) => [watch.id, watch] as const),
      );
      for (const watch of message.watches) {
        const existing = existingById.get(watch.id);
        if (existing !== undefined && !sameWatchSpec(existing, watch)) {
          return respondTypedError<WatchAddResult>(
            message.requestId,
            toError(
              "ProtocolError",
              "session.watch.add may not replace an existing watch id; use session.watch.set",
            ),
          );
        }
      }

      const newWatches = message.watches.filter((watch) =>
        !existingById.has(watch.id)
      );

      if (newWatches.length === 0) {
        const serverSeq = Engine.serverSeq(engine);
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq,
            sync: {
              type: "sync",
              fromSeq: session.lastSyncedSeq,
              toSeq: serverSeq,
              upserts: [],
              removes: [],
            },
          },
        };
      }

      const nextWatches = mergeWatchesById(session.watches, newWatches);
      const graphs = new Map(session.graphs);

      const updates = new Map<string, SessionCacheEntry>();
      for (const [branch, query] of groupedQueries(newWatches)) {
        const existing = graphs.get(branch);
        if (existing === undefined) {
          const tracked = trackGraph(
            message.space,
            engine,
            query,
          );
          graphs.set(branch, tracked.state);
          for (const entity of tracked.state.entities.values()) {
            const entry = toCacheEntry(entity);
            updates.set(cacheKeyForEntity(entry.branch, entry.id), entry);
          }
          continue;
        }

        const staged = cloneTrackedGraphState(engine, existing);
        graphs.set(branch, staged);
        const extended = extendTrackedGraph(
          message.space,
          engine,
          staged,
          query,
        );
        for (const entity of extended.updates.values()) {
          const entry = toCacheEntry(entity);
          updates.set(cacheKeyForEntity(entry.branch, entry.id), entry);
        }
      }

      const upserts: SessionCacheEntry[] = [];
      for (const [key, entry] of updates) {
        const previous = session.entities.get(key);
        session.entities.set(key, entry);
        session.trackedIds.add(entry.id);
        if (!sameSnapshot(previous, entry)) {
          upserts.push(entry);
        }
      }

      const serverSeq = Engine.serverSeq(engine);
      const fromSeq = session.lastSyncedSeq;
      session.graphs = graphs;
      session.watches = nextWatches;
      session.lastSyncedSeq = serverSeq;
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          sync: {
            type: "sync",
            fromSeq,
            toSeq: serverSeq,
            upserts: upserts.toSorted((left, right) =>
              left.branch.localeCompare(right.branch) ||
              left.id.localeCompare(right.id)
            ),
            removes: [],
          },
        },
      };
    } catch (error) {
      return respondTypedError<WatchAddResult>(
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
  ): Promise<GraphQueryResult> {
    return queryGraph(
      space,
      engine ?? await this.openEngine(space),
      query,
      reuse,
    );
  }

  async evaluateWatchSet(
    space: string,
    watches: readonly WatchSpec[],
    engine?: Engine.Engine,
  ): Promise<{
    serverSeq: number;
    graphs: Map<string, TrackedGraphState>;
    entities: Map<string, SessionCacheEntry>;
  }> {
    const resolvedEngine = engine ?? await this.openEngine(space);
    const reuse: QueryGraphReuseContext = {
      managers: new Map(),
    };
    const graphs = new Map<string, TrackedGraphState>();
    const entities = new Map<string, SessionCacheEntry>();
    let serverSeq = Engine.serverSeq(resolvedEngine);

    for (const [branch, query] of groupedQueries(watches)) {
      const result = trackGraph(
        space,
        resolvedEngine,
        query,
        reuse,
      );
      serverSeq = result.serverSeq;
      graphs.set(branch, result.state);
      for (const entity of result.state.entities.values()) {
        const entry = toCacheEntry(entity);
        const key = cacheKeyForEntity(entry.branch, entry.id);
        const existing = entities.get(key);
        if (
          existing === undefined ||
          entry.seq > existing.seq ||
          (entry.seq === existing.seq && existing.deleted && !entry.deleted)
        ) {
          entities.set(key, entry);
        }
      }
    }

    return {
      serverSeq,
      graphs,
      entities,
    };
  }

  async syncSessionForConnection(
    space: string,
    sessionId: string,
    dirtyIds?: ReadonlySet<string>,
  ): Promise<SessionEffectMessage | null> {
    const session = this.#sessions.get(space, sessionId);
    if (session === null || session.watches.length === 0) {
      return null;
    }
    if (dirtyIds !== undefined) {
      let touched = false;
      for (const dirtyId of dirtyIds) {
        if (session.trackedIds.has(dirtyId)) {
          touched = true;
          break;
        }
      }
      if (!touched) {
        return null;
      }

      const engine = await this.openEngine(space);
      const fromSeq = session.lastSyncedSeq;
      const updates = new Map<string, SessionCacheEntry>();

      for (const graph of session.graphs.values()) {
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          graph,
          dirtyIds,
        );
        if (refreshed === null) {
          continue;
        }
        for (const entity of refreshed.updates.values()) {
          const entry = toCacheEntry(entity);
          updates.set(cacheKeyForEntity(entry.branch, entry.id), entry);
        }
      }

      if (updates.size === 0) {
        return null;
      }

      const upserts: SessionCacheEntry[] = [];
      for (const [key, entry] of updates) {
        const previous = session.entities.get(key);
        session.entities.set(key, entry);
        session.trackedIds.add(entry.id);
        if (!sameSnapshot(previous, entry)) {
          upserts.push(entry);
        }
      }
      const toSeq = Engine.serverSeq(engine);
      session.lastSyncedSeq = toSeq;
      if (upserts.length === 0) {
        return null;
      }
      return {
        type: "session/effect",
        space,
        sessionId,
        effect: {
          type: "sync",
          fromSeq,
          toSeq,
          upserts: upserts.toSorted((left, right) =>
            left.branch.localeCompare(right.branch) ||
            left.id.localeCompare(right.id)
          ),
          removes: [],
        },
      };
    }

    const { serverSeq, graphs, entities } = await this.evaluateWatchSet(
      space,
      session.watches,
    );
    const sync = buildDiffSync(
      session.entities,
      entities,
      session.lastSyncedSeq,
      serverSeq,
    );
    session.graphs = graphs;
    session.entities = entities;
    session.trackedIds = trackedIdsFromEntries(entities.values());
    session.lastSyncedSeq = serverSeq;
    if (isEmptySync(sync)) {
      return null;
    }
    return {
      type: "session/effect",
      space,
      sessionId,
      effect: sync,
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
    this.markSpaceDirty(space, ids);
  }

  async flushSessions(spaces?: Iterable<string>): Promise<void> {
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
    await this.#refreshing;
  }

  private scheduleRefresh(): void {
    if (this.#dirtySpaces.size === 0 || this.#refreshTimer !== null) {
      return;
    }
    this.#refreshTimer = setTimeout(
      () => {
        this.#refreshTimer = null;
        void this.flushSessions();
      },
      this.options.subscriptionRefreshDelayMs ?? SUBSCRIPTION_REFRESH_DELAY_MS,
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
        for (const connection of this.#connections.values()) {
          await connection.refreshDirty(space, dirtyIds);
        }
      }

      if (initial !== undefined) {
        return;
      }
    }
  }

  respond(payload: string): Promise<string | null> {
    const parsed = parseClientMessage(payload);
    if (parsed?.type === "hello") {
      const expectedFlags = getMemoryV2Flags();
      if (parsed.protocol !== MEMORY_V2_PROTOCOL) {
        return Promise.resolve(encodeMemoryV2Boundary(
          {
            type: "response",
            requestId: "handshake",
            error: toError(
              "UnsupportedProtocol",
              `Unsupported protocol: ${parsed.protocol}`,
            ),
          } satisfies ResponseMessage<never>,
        ));
      }
      if (!sameMemoryV2Flags(parsed.flags, expectedFlags)) {
        return Promise.resolve(encodeMemoryV2Boundary(
          {
            type: "response",
            requestId: "handshake",
            error: toError(
              "ProtocolError",
              `memory/v2 flag mismatch: client=${
                JSON.stringify(parsed.flags)
              } server=${JSON.stringify(expectedFlags)}`,
            ),
          } satisfies ResponseMessage<never>,
        ));
      }
      return Promise.resolve(encodeMemoryV2Boundary(
        {
          type: "hello.ok",
          protocol: MEMORY_V2_PROTOCOL,
          flags: expectedFlags,
        } satisfies ServerMessage,
      ));
    }
    return Promise.resolve(null);
  }

  private openEngine(space: string): Promise<Engine.Engine> {
    const existing = this.#engines.get(space);
    if (existing !== undefined) {
      return existing;
    }

    const url = this.#store
      ? resolveSpaceStoreUrl(this.#store, space as any, "v2")
      : new URL(`memory:///${encodeURIComponent(space)}`);
    const opened = (async () => {
      if (url.protocol === "file:") {
        await FS.ensureDir(Path.toFileUrl(Path.dirname(Path.fromFileUrl(url))));
      }
      return await Engine.open({ url });
    })();
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
      ...invocation,
      iss: typeof invocation.iss === "string" ? invocation.iss : message.space,
      aud: typeof invocation.aud === "string" ? invocation.aud : null,
      cmd: typeof invocation.cmd === "string"
        ? invocation.cmd
        : "/memory/transact",
      sub: typeof invocation.sub === "string" ? invocation.sub : message.space,
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

export const parseClientMessage = (
  payload: string,
): ClientMessage | null => {
  let parsed: unknown;
  try {
    parsed = decodeMemoryV2Boundary(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (
    parsed.type === "hello" &&
    typeof parsed.protocol === "string" &&
    isMemoryV2Flags(parsed.flags)
  ) {
    return {
      type: "hello",
      protocol: parsed.protocol as HelloMessage["protocol"],
      flags: parsed.flags,
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
        sessionToken: typeof parsed.session.sessionToken === "string"
          ? parsed.session.sessionToken
          : undefined,
      },
      invocation: isRecord(parsed.invocation) ? parsed.invocation : undefined,
      authorization: parsed
        .authorization as SessionOpenRequest["authorization"],
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
      authorization: parsed.authorization as TransactRequest["authorization"],
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
    parsed.type === "session.watch.set" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    Array.isArray(parsed.watches)
  ) {
    return {
      type: "session.watch.set",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      watches: parsed.watches as WatchSpec[],
    };
  }

  if (
    parsed.type === "session.watch.add" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    Array.isArray(parsed.watches)
  ) {
    return {
      type: "session.watch.add",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      watches: parsed.watches as WatchSpec[],
    };
  }

  if (
    parsed.type === "session.ack" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.seenSeq === "number"
  ) {
    return {
      type: "session.ack",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      seenSeq: parsed.seenSeq,
    };
  }

  return null;
};
