import * as FS from "@std/fs";
import * as Path from "@std/path";
import { resolveSpaceStoreUrl } from "./storage-path.ts";
import {
  type CellScope,
  type ClientCommit,
  type ClientMessage,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  getPersistentSchedulerStateConfig,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
  type Operation,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type SchedulerSnapshotListRequest,
  type SchedulerSnapshotListResult,
  type ServerMessage,
  type SessionAckRequest,
  type SessionAckResult,
  type SessionEffectMessage,
  type SessionOpenRequest,
  type SessionOpenResult,
  type SessionRevokedMessage,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryRequest,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceRequest,
  type SqliteRegisterDiskSourceResult,
  type TransactRequest,
  type V2Error,
  type WatchAddRequest,
  type WatchAddResult,
  type WatchSetRequest,
  type WatchSetResult,
  type WatchSpec,
  type WireMemoryProtocolFlags,
} from "../v2.ts";
import * as Engine from "./engine.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
  setQueryOnly,
} from "./sqlite/exec.ts";
import type { TableSchema } from "./sqlite/schema.ts";
import { DiskSourceRegistry } from "./sqlite/disk-source.ts";
import {
  cloneTrackedGraphState,
  extendTrackedGraph,
  isGraphQueryCoveredByState,
  queryGraph,
  type QueryGraphReuseContext,
  refreshTrackedGraph,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "./query.ts";
import { respondToHello } from "./handshake.ts";
import {
  buildDiffSync,
  buildFullSync,
  cacheKeyForEntity,
  groupedQueries,
  isEmptySync,
  mergeWatchesById,
  sameSnapshot,
  sameWatchSpec,
  type SessionCacheEntry,
  toCacheEntry,
  trackedIdsFromEntries,
} from "./server-sync.ts";
import { SessionRegistry, type SessionState } from "./session-registry.ts";

export { SessionRegistry } from "./session-registry.ts";

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
const MIN_REFRESH_QUEUE_DRAIN_WAIT_MS = 500;
const SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_BUFFER_SIZE = 100;

// Memory v2 wire values may omit scope for default-space entries; storage and
// watch keys need an explicit declared scope.
const declaredScope = (scope: CellScope | undefined): CellScope =>
  scope ?? "space";

export interface SlowQuery {
  timestamp: number;
  elapsed: number;
  operation: string;
  space: string;
  roots?: number;
  watches?: number;
}

const slowQueries: SlowQuery[] = [];

const recordSlowQuery = (entry: SlowQuery): void => {
  slowQueries.push(entry);
  if (slowQueries.length > SLOW_QUERY_BUFFER_SIZE) {
    slowQueries.shift();
  }
};

const recordSlowQueryDuration = (
  operation: string,
  space: string,
  startedAt: number,
  details: Omit<SlowQuery, "timestamp" | "elapsed" | "operation" | "space"> =
    {},
): void => {
  const elapsed = performance.now() - startedAt;
  if (elapsed <= SLOW_QUERY_THRESHOLD_MS) {
    return;
  }
  recordSlowQuery({
    timestamp: Date.now(),
    elapsed,
    operation,
    space,
    ...details,
  });
};

/** Returns the last N slow query/watch operations (>100ms). */
export const getSlowQueries = (): readonly SlowQuery[] => slowQueries;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const schedulerObservationFromValue = (
  observation: unknown,
): Engine.SchedulerActionObservation | undefined => {
  if (
    !isRecord(observation) ||
    observation.version !== 1 ||
    typeof observation.pieceId !== "string" ||
    typeof observation.actionId !== "string" ||
    typeof observation.processGeneration !== "number" ||
    !Array.isArray(observation.reads) ||
    !Array.isArray(observation.shallowReads)
  ) {
    return undefined;
  }
  return observation as unknown as Engine.SchedulerActionObservation;
};

type CommitSchedulerObservation = {
  localSeq: number;
  observation: Engine.SchedulerActionObservation;
};

const schedulerObservationsFromCommit = (
  commit: ClientCommit,
): CommitSchedulerObservation[] => {
  const single = schedulerObservationFromValue(commit.schedulerObservation);
  if (single) {
    return [{ localSeq: commit.localSeq, observation: single }];
  }

  const batch = commit.schedulerObservationBatch ?? [];
  const observations: CommitSchedulerObservation[] = [];
  for (const item of batch) {
    const observation = schedulerObservationFromValue(
      item.schedulerObservation,
    );
    if (!observation) {
      continue;
    }
    observations.push({ localSeq: item.localSeq, observation });
  }
  return observations;
};

const toError = (name: string, message: string): V2Error => ({
  name,
  message,
});

/** Deterministic, collision-resistant-enough token for a filename component
 *  (FNV-1a 32-bit + length). Used to derive cell-db file names from (space,id). */
function hashToken(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}${s.length.toString(16)}`;
}

const respondTypedError = <Result>(
  requestId: string,
  error: V2Error,
): ResponseMessage<Result> => ({
  type: "response",
  requestId,
  error,
});

const sessionKey = (space: string, sessionId: string): string =>
  `${space}\0${sessionId}`;

type Send = (message: ServerMessage) => void;

type SessionHandle = {
  space: string;
  sessionId: string;
};

type DirtyOrigin = {
  sessionId: string;
  seq: number;
};

class Connection {
  #ready = false;
  #closed = false;
  #sessions = new Map<string, SessionHandle>();
  #receiving: Promise<void> = Promise.resolve();
  #pendingReceives = 0;
  #receiveIdle: PromiseWithResolvers<void> | null = null;

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
    this.#pendingReceives += 1;
    try {
      const previous = this.#receiving;
      const current = previous.catch(() => undefined).then(() =>
        this.receiveOrdered(payload)
      );
      this.#receiving = current.then(() => undefined, () => undefined);
      return await current;
    } finally {
      this.#pendingReceives = Math.max(0, this.#pendingReceives - 1);
      if (this.#pendingReceives === 0) {
        this.#receiveIdle?.resolve();
        this.#receiveIdle = null;
      }
    }
  }

  hasPendingReceives(): boolean {
    return this.#pendingReceives > 0;
  }

  async waitForReceiveQueueToDrain(deadlineMs: number): Promise<boolean> {
    while (this.#pendingReceives > 0) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      if (this.#receiveIdle === null) {
        this.#receiveIdle = Promise.withResolvers<void>();
      }
      const idle = this.#receiveIdle.promise.then(() => true);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), remainingMs);
      });
      const drained = await Promise.race([idle, timeout]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (!drained) {
        return this.#pendingReceives === 0;
      }
    }
    return true;
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
          "Unable to parse memory message",
        ),
      });
      return;
    }

    if (!this.#ready) {
      if (parsed.type !== "hello") {
        this.send({
          type: "response",
          requestId: "handshake",
          error: toError("ProtocolError", "memory hello is required first"),
        });
        return;
      }
      const response = respondToHello(parsed);
      this.send(response);
      if (response.type !== "hello.ok") {
        return;
      }
      this.#ready = true;
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
      case "sqlite.query":
        if (
          !this.requireSession(parsed.requestId, parsed.space, parsed.sessionId)
        ) {
          return;
        }
        this.send(await this.server.sqliteQuery(parsed));
        return;
      case "sqlite.register-disk-source":
        if (
          !this.requireSession(parsed.requestId, parsed.space, parsed.sessionId)
        ) {
          return;
        }
        this.send(await this.server.sqliteRegisterDiskSource(parsed));
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
      case "scheduler.snapshot.list":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        this.send(await this.server.listSchedulerActionSnapshots(parsed));
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
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
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
        dirtyOrigins,
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
  // Synthesized session state for direct out-of-band document writes, such as blob uploads.
  #directSessionId = `server:${crypto.randomUUID()}`;
  #directLocalSeq = 0;
  #dirtySpaces = new Set<string>();
  #dirtyDocsBySpace = new Map<string, Set<string>>();
  #dirtyOriginsBySpace = new Map<string, Map<string, DirtyOrigin>>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> | null = null;
  #lastRefreshDurationMs = 0;
  #store?: URL;
  // Injected on-disk SQLite sources (Phase 7), keyed by handle cell id. A
  // registered id is attached read-only from its descriptor path instead of the
  // cell-derived per-(space,id) file. v1 in-memory; persistence is deferred (see
  // docs/specs/sqlite-builtin/plans/on-disk-source.md).
  #diskSources = new DiskSourceRegistry();

  constructor(
    readonly options: {
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

  /**
   * Drains any in-flight or scheduled subscription refresh, returning when
   * the server has no pending work. Tests use this to drain the
   * module-level singleton's `#refreshTimer` between cases so it doesn't
   * leak across the Deno test boundary -- the singleton survives across
   * tests but its pending timer must not.
   *
   * `flushSessions()` (called with no `spaces` argument) cancels any
   * pending timer, runs the refresh loop to completion, and intentionally
   * does not reschedule, so a single call is sufficient.
   */
  async idle(): Promise<void> {
    if (this.#refreshTimer !== null || this.#refreshing !== null) {
      await this.flushSessions();
    }
  }

  async readDocument(
    space: string,
    id: string,
  ): Promise<EntityDocument | null> {
    const engine = await this.openEngine(space);
    return Engine.read(engine, { id });
  }

  async writeDocument(
    space: string,
    id: string,
    value: EntityDocument["value"],
  ): Promise<Engine.AppliedCommit> {
    const engine = await this.openEngine(space);
    const commit = Engine.applyCommit(engine, {
      sessionId: this.#directSessionId,
      space,
      commit: {
        localSeq: ++this.#directLocalSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: { value },
        }],
      },
    });
    await this.runPostCommitSchedulerSideEffects(
      space,
      commit,
      [],
      new Map(),
      undefined,
    );
    this.markSpaceDirty(space, [toDirtyKey(id)]);
    return commit;
  }

  /**
   * Run `op` against a cell-derived SQLite database: ATTACH it (under an alias
   * derived from the db id), additively create its declared tables, run `op`
   * synchronously, then DETACH in `finally`.
   *
   * Attach-one-at-a-time (rather than keeping dbs attached) is deliberate: it
   * guarantees a pattern's unqualified table names resolve to *this* db (SQLite
   * resolves unqualified names against attached dbs in order, so multiple
   * simultaneously-attached cell-dbs would alias each other), and it sidesteps
   * the connection's `SQLITE_MAX_ATTACHED` limit. `op` MUST be synchronous: the
   * attach→op→detach block must not `await` (the engine connection is shared and
   * single-threaded; an await between attach and detach could interleave another
   * op's attach and reintroduce the ambiguity). ATTACH/DETACH require no open
   * transaction — true on this RPC path. File-backed cell-dbs persist across
   * detach.
   */
  async #onCellDb<T>(
    space: string,
    db: SqliteDbRef,
    op: (engine: Engine.Engine) => T,
  ): Promise<T> {
    const engine = await this.openEngine(space);
    const alias = aliasForDbId(db.id);

    // Phase 7: an injected on-disk source is attached READ-ONLY from its
    // registered path instead of the cell-derived file, and we do NOT run
    // ensureTables against it (v1 does not migrate external files). Read-only is
    // enforced for the synchronous attach→op→detach window via PRAGMA query_only
    // (the connection is single-threaded; `op` must not await — see below).
    const disk = this.#diskSources.get(space, db.id);
    if (disk) {
      attachDatabase(engine.database, alias, disk.path, { readOnly: true });
      setQueryOnly(engine.database, true);
      try {
        return op(engine); // synchronous — see doc comment
      } finally {
        setQueryOnly(engine.database, false);
        detachDatabase(engine.database, alias);
      }
    }

    attachDatabase(
      engine.database,
      alias,
      this.#cellDbPath(engine, space, db.id),
    );
    try {
      if (db.tables) {
        ensureTables(
          engine.database,
          db.tables as Record<string, TableSchema>,
          alias,
        );
      }
      return op(engine); // synchronous — see doc comment
    } finally {
      detachDatabase(engine.database, alias);
    }
  }

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1) for
   * `(space, id)`. After this, `#onCellDb` attaches the canonical `path`
   * (read-only) for that `(space, id)` instead of the cell-derived db. The
   * descriptor is server-side state — never the cell value.
   *
   * The path is validated here because it arrives over the wire (untrusted): it
   * must be absolute and must exist, and is `realpath`-canonicalized and then
   * rejected if it resolves INSIDE the engine's store directory — otherwise a
   * caller could point a handle at another space's (or a cell-derived) `.sqlite`
   * file and read it cross-tenant. (Confining injected sources to an operator
   * allowlist, and gating the verb to an operator capability rather than any
   * session, awaits CFC labels — see plans/on-disk-source.md and
   * 08-open-questions Q12/Q15.)
   */
  async registerDiskSource(
    space: string,
    id: string,
    path: string,
  ): Promise<void> {
    if (!Path.isAbsolute(path)) {
      throw new Engine.ProtocolError(
        `disk source path must be absolute: ${path}`,
      );
    }
    let canonical: string;
    try {
      canonical = await Deno.realPath(path);
    } catch {
      throw new Engine.ProtocolError(`disk source path not found: ${path}`);
    }
    const engine = await this.openEngine(space);
    if (engine.url.protocol === "file:") {
      const storeDir = Path.dirname(Path.fromFileUrl(engine.url));
      const rel = Path.relative(storeDir, canonical);
      const insideStore = rel === "" ||
        (!rel.startsWith("..") && !Path.isAbsolute(rel));
      if (insideStore) {
        throw new Engine.ProtocolError(
          "disk source path may not resolve inside the store directory",
        );
      }
    }
    this.#diskSources.register(space, id, { path: canonical });
  }

  /**
   * Attach the cell-db(s) referenced by a commit's `sqlite` ops and create their
   * tables, returning a dbId→alias map for `Engine.applyCommit`. Must run BEFORE
   * applyCommit (ATTACH can't run in a transaction); the caller detaches after.
   * Enforces ≤1 cell-db per commit so unqualified names stay unambiguous
   * (decision 1.3.A in plans/atomic-writes.md).
   */
  #attachCommitSqliteDbs(
    engine: Engine.Engine,
    space: string,
    operations: readonly Operation[],
  ): Map<string, string> {
    const map = new Map<string, string>();
    const tablesById = new Map<string, Record<string, unknown> | undefined>();
    for (const op of operations) {
      if (op.op !== "sqlite") continue;
      const id = op.db.id;
      // Phase 7: injected on-disk sources are read-only in v1 — a folded write to
      // one is rejected before it can join the commit (Q13/Q14).
      if (this.#diskSources.has(space, id)) {
        throw new Engine.ProtocolError(
          "injected on-disk SQLite sources are read-only in v1 (db.exec rejected)",
        );
      }
      if (map.has(id)) continue;
      if (map.size >= 1) {
        throw new Engine.ProtocolError(
          "a commit may write to at most one sqlite database",
        );
      }
      map.set(id, aliasForDbId(id));
      tablesById.set(id, op.db.tables);
    }
    // Attach + create tables. If `ensureTables` throws (e.g. a malformed/hostile
    // `db.tables` payload — DDL validation rejects it), DETACH everything
    // attached so far before rethrowing. This helper runs BEFORE the caller's
    // attach→commit→detach try/finally, and the engine connection is reused per
    // space, so a leaked attachment would make later writes/queries for the same
    // alias fail ("already in use") and corrupt unqualified name resolution.
    const attached: string[] = [];
    try {
      for (const [id, alias] of map) {
        attachDatabase(
          engine.database,
          alias,
          this.#cellDbPath(engine, space, id),
        );
        attached.push(alias);
        const tables = tablesById.get(id);
        if (tables) {
          ensureTables(
            engine.database,
            tables as Record<string, TableSchema>,
            alias,
          );
        }
      }
    } catch (error) {
      for (const alias of attached) {
        try {
          detachDatabase(engine.database, alias);
        } catch { /* best-effort cleanup on the error path */ }
      }
      throw error;
    }
    return map;
  }

  /** Path for a cell-derived db file. Sibling of the space db for file stores;
   *  a deterministic temp file for in-memory stores (so it survives the
   *  connection, unlike an `:memory:` attach). The space + id are hashed into
   *  the filename so distinct (space, id) pairs never collide. */
  #cellDbPath(engine: Engine.Engine, space: string, id: string): string {
    const tag = `${hashToken(space)}-${hashToken(id)}`;
    if (engine.url.protocol === "file:") {
      const dir = Path.dirname(Path.fromFileUrl(engine.url));
      return Path.join(dir, `cell-${tag}.sqlite`);
    }
    return Path.join(Deno.env.get("TMPDIR") ?? "/tmp", `cf-cell-${tag}.sqlite`);
  }

  async sqliteQuery(
    message: SqliteQueryRequest,
  ): Promise<ResponseMessage<SqliteQueryResult>> {
    if (this.#sessions.get(message.space, message.sessionId) === null) {
      return respondTypedError<SqliteQueryResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    try {
      const rows = await this.#onCellDb(
        message.space,
        message.db,
        (engine) => runQuery(engine.database, message.sql, message.params),
      );
      return { type: "response", requestId: message.requestId, ok: { rows } };
    } catch (error) {
      return respondTypedError<SqliteQueryResult>(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "SqliteError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // No `sqliteExecute` handler: there is no standalone SQLite write RPC. Writes
  // arrive as a `sqlite` op inside a `transact` commit and are applied by the
  // engine atomically with the cell ops (#attachCommitSqliteDbs + applyCommit) —
  // which is also where an injected on-disk source's read-only rejection lives.
  // `runWrite` remains the engine helper used by that commit-fold path.

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
   * link <piece> <field> sqlite:<absPath>` issues this so subsequent reads for the
   * handle id resolve against the on-disk file (attached read-only) instead of the
   * cell-derived db. The descriptor is server-side state — never the cell value.
   */
  async sqliteRegisterDiskSource(
    message: SqliteRegisterDiskSourceRequest,
  ): Promise<ResponseMessage<SqliteRegisterDiskSourceResult>> {
    if (this.#sessions.get(message.space, message.sessionId) === null) {
      return respondTypedError<SqliteRegisterDiskSourceResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    try {
      await this.registerDiskSource(message.space, message.id, message.path);
    } catch (error) {
      return respondTypedError<SqliteRegisterDiskSourceResult>(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "SqliteError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    return {
      type: "response",
      requestId: message.requestId,
      ok: { registered: true },
    };
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
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<Engine.AppliedCommit>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const schedulerStateEnabled = getPersistentSchedulerStateConfig();
      const commitPayload = schedulerStateEnabled ? message.commit : {
        ...message.commit,
        schedulerObservation: undefined,
        schedulerObservationBatch: undefined,
      };
      const schedulerObservations = schedulerStateEnabled
        ? schedulerObservationsFromCommit(commitPayload)
        : [];
      const previousReadSpaces = new Map<number, Set<string>>();
      for (const { localSeq, observation } of schedulerObservations) {
        previousReadSpaces.set(
          localSeq,
          this.schedulerObservationReadSpaces(
            Engine.getLatestSchedulerActionSnapshot(engine, {
              branch: message.commit.branch ?? "",
              ownerSpace: message.space,
              pieceId: observation.pieceId,
              processGeneration: observation.processGeneration,
              actionId: observation.actionId,
            })?.observation,
          ),
        );
      }
      // Fold-in SQLite writes: ATTACH their cell-db(s) BEFORE applyCommit (ATTACH
      // cannot run inside a transaction); the engine executes them inside the
      // commit txn (atomic with cell ops). Detach in finally.
      const sqliteAttachments = this.#attachCommitSqliteDbs(
        engine,
        message.space,
        commitPayload.operations,
      );
      let commit: Engine.AppliedCommit;
      try {
        commit = Engine.applyCommit(engine, {
          sessionId: message.sessionId,
          space: message.space,
          principal: session.principal,
          commit: commitPayload,
          sqliteAttachments,
        });
      } finally {
        // Detach BEFORE any await. `engine.database` is shared per space, so
        // holding a cell-db attached across the post-commit await would let a
        // concurrent connection's commit attach a SECOND cell-db — breaking the
        // ≤1-attached invariant that unqualified-name resolution relies on
        // (B1). `applyCommit` is synchronous and is the only step that needs the
        // attachments.
        for (const alias of sqliteAttachments.values()) {
          detachDatabase(engine.database, alias);
        }
      }
      await this.runPostCommitSchedulerSideEffects(
        message.space,
        commit,
        schedulerObservations,
        previousReadSpaces,
        session,
      );
      this.markSpaceDirty(
        message.space,
        message.commit.operations
          .filter((operation) => operation.op !== "sqlite")
          .map((operation) =>
            toDirtyKey(operation.id, declaredScope(operation.scope))
          ),
        {
          sessionId: message.sessionId,
          seq: commit.seq,
        },
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
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
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
        ok: await this.evaluateGraphQuery(
          message.space,
          message.query,
          undefined,
          undefined,
          {
            principal: session.principal,
            sessionId: message.sessionId,
          },
        ),
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

  async listSchedulerActionSnapshots(
    message: SchedulerSnapshotListRequest,
  ): Promise<ResponseMessage<SchedulerSnapshotListResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<SchedulerSnapshotListResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      if (!getPersistentSchedulerStateConfig()) {
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq: Engine.serverSeq(engine),
            snapshots: [],
          },
        };
      }
      const page = Engine.listSchedulerActionSnapshots(
        engine,
        message.query,
      );
      const snapshots = page.snapshots.map((snapshot) => ({
        observationId: snapshot.observationId,
        commitSeq: snapshot.commitSeq,
        observedAtSeq: snapshot.observedAtSeq,
        observation: snapshot.observation,
        ...(snapshot.directDirtySeq !== undefined
          ? { directDirtySeq: snapshot.directDirtySeq }
          : {}),
        ...(snapshot.staleSeq !== undefined
          ? { staleSeq: snapshot.staleSeq }
          : {}),
        ...(snapshot.unknownReason !== undefined
          ? { unknownReason: snapshot.unknownReason }
          : {}),
      }));
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          snapshots,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      };
    } catch (error) {
      return respondTypedError<SchedulerSnapshotListResult>(
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
        undefined,
        {
          principal: session.principal,
          sessionId: message.sessionId,
        },
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
      const startedAt = performance.now();
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
            undefined,
            {
              principal: session.principal,
              sessionId: message.sessionId,
            },
          );
          graphs.set(branch, tracked.state);
          for (const entity of tracked.state.entities.values()) {
            const entry = toCacheEntry(entity);
            updates.set(
              cacheKeyForEntity(
                entry.branch,
                entry.id,
                declaredScope(entry.scope),
              ),
              entry,
            );
          }
          continue;
        }

        if (isGraphQueryCoveredByState(message.space, existing, query)) {
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
          updates.set(
            cacheKeyForEntity(
              entry.branch,
              entry.id,
              declaredScope(entry.scope),
            ),
            entry,
          );
        }
      }

      const upserts: SessionCacheEntry[] = [];
      for (const [key, entry] of updates) {
        const previous = session.entities.get(key);
        session.entities.set(key, entry);
        session.trackedIds.add(
          toDirtyKey(entry.id, declaredScope(entry.scope)),
        );
        if (!sameSnapshot(previous, entry)) {
          upserts.push(entry);
        }
      }

      const serverSeq = Engine.serverSeq(engine);
      const fromSeq = session.lastSyncedSeq;
      session.graphs = graphs;
      session.watches = nextWatches;
      session.lastSyncedSeq = serverSeq;
      recordSlowQueryDuration(
        "session.watch.add",
        message.space,
        startedAt,
        { watches: message.watches.length },
      );
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
    scopeContext: { principal?: string; sessionId?: string } = {},
  ): Promise<GraphQueryResult> {
    const startedAt = performance.now();
    const result = queryGraph(
      space,
      engine ?? await this.openEngine(space),
      query,
      reuse,
      scopeContext,
    );
    recordSlowQueryDuration("graph.query", space, startedAt, {
      roots: query.roots.length,
    });
    return result;
  }

  async evaluateWatchSet(
    space: string,
    watches: readonly WatchSpec[],
    engine?: Engine.Engine,
    scopeContext: { principal?: string; sessionId?: string } = {},
  ): Promise<{
    serverSeq: number;
    graphs: Map<string, TrackedGraphState>;
    entities: Map<string, SessionCacheEntry>;
  }> {
    const startedAt = performance.now();
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
        scopeContext,
      );
      serverSeq = result.serverSeq;
      graphs.set(branch, result.state);
      for (const entity of result.state.entities.values()) {
        const entry = toCacheEntry(entity);
        const key = cacheKeyForEntity(
          entry.branch,
          entry.id,
          declaredScope(entry.scope),
        );
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

    recordSlowQueryDuration("session.watch.set", space, startedAt, {
      watches: watches.length,
    });
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
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
  ): Promise<SessionEffectMessage | null> {
    const session = this.#sessions.get(space, sessionId);
    if (session === null || session.watches.length === 0) {
      return null;
    }
    if (dirtyIds !== undefined) {
      const startedAt = performance.now();
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
          updates.set(
            cacheKeyForEntity(
              entry.branch,
              entry.id,
              declaredScope(entry.scope),
            ),
            entry,
          );
        }
      }

      if (updates.size === 0) {
        return null;
      }

      const upserts: SessionCacheEntry[] = [];
      for (const [key, entry] of updates) {
        const previous = session.entities.get(key);
        session.entities.set(key, entry);
        session.trackedIds.add(
          toDirtyKey(entry.id, declaredScope(entry.scope)),
        );
        if (!sameSnapshot(previous, entry)) {
          const dirtyKey = toDirtyKey(entry.id, declaredScope(entry.scope));
          const origin = dirtyOrigins?.get(dirtyKey);
          if (
            origin === undefined ||
            origin.sessionId !== sessionId ||
            origin.seq !== entry.seq
          ) {
            upserts.push(entry);
          }
        }
      }
      const toSeq = Engine.serverSeq(engine);
      session.lastSyncedSeq = toSeq;
      if (upserts.length === 0) {
        return null;
      }
      recordSlowQueryDuration("session.watch.refresh", space, startedAt, {
        watches: session.watches.length,
      });
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
      undefined,
      {
        principal: session.principal,
        sessionId,
      },
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

  markSpaceDirty(
    space: string,
    dirtyIds?: Iterable<string>,
    origin?: DirtyOrigin,
  ): void {
    if (dirtyIds !== undefined) {
      let ids = this.#dirtyDocsBySpace.get(space);
      if (ids === undefined) {
        ids = new Set();
        this.#dirtyDocsBySpace.set(space, ids);
      }
      let origins = this.#dirtyOriginsBySpace.get(space);
      if (origin !== undefined && origins === undefined) {
        origins = new Map();
        this.#dirtyOriginsBySpace.set(space, origins);
      }
      for (const id of dirtyIds) {
        ids.add(id);
        if (origin === undefined) {
          origins?.delete(id);
        } else {
          origins?.set(id, origin);
        }
      }
      if (origins?.size === 0) {
        this.#dirtyOriginsBySpace.delete(space);
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
      if (operation.op === "sqlite") continue; // no entity id
      ids.add(toDirtyKey(operation.id, declaredScope(operation.scope)));
    }
    for (const read of commit.reads.confirmed) {
      ids.add(toDirtyKey(read.id, declaredScope(read.scope)));
    }
    for (const read of commit.reads.pending) {
      ids.add(toDirtyKey(read.id, declaredScope(read.scope)));
    }
    this.markSpaceDirty(space, ids);
  }

  async flushSessions(spaces?: Iterable<string>): Promise<void> {
    this.cancelScheduledRefresh();
    const run = async () => {
      const refreshStart = Date.now();
      try {
        await this.refreshLoop(
          spaces === undefined ? undefined : new Set(spaces),
        );
      } finally {
        this.#lastRefreshDurationMs = Math.max(
          0,
          Date.now() - refreshStart,
        );
        if (spaces !== undefined && this.#dirtySpaces.size > 0) {
          this.scheduleRefresh();
        }
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
        void this.flushScheduledSessions();
      },
      this.options.subscriptionRefreshDelayMs ?? SUBSCRIPTION_REFRESH_DELAY_MS,
    );
  }

  private async flushScheduledSessions(): Promise<void> {
    await this.waitForConnectionQueuesToDrain(
      Math.max(
        MIN_REFRESH_QUEUE_DRAIN_WAIT_MS,
        this.#lastRefreshDurationMs * 2,
      ),
    );
    await this.flushSessions();
  }

  private async waitForConnectionQueuesToDrain(
    maxWaitMs: number,
  ): Promise<void> {
    const deadlineMs = Date.now() + maxWaitMs;
    while (true) {
      const pending = [...this.#connections.values()].filter((connection) =>
        connection.hasPendingReceives()
      );
      if (pending.length === 0) {
        return;
      }
      if (Date.now() >= deadlineMs) {
        return;
      }
      const drained = await Promise.all(
        pending.map((connection) =>
          connection.waitForReceiveQueueToDrain(deadlineMs)
        ),
      );
      if (drained.every(Boolean)) {
        return;
      }
      if (Date.now() >= deadlineMs) {
        return;
      }
    }
  }

  private cancelScheduledRefresh(): void {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (this.#connections.size === 0) {
      this.#dirtySpaces.clear();
      this.#dirtyDocsBySpace.clear();
      this.#dirtyOriginsBySpace.clear();
    }
  }

  private async refreshLoop(initial?: Set<string>): Promise<void> {
    let pending = initial;
    while (true) {
      if (initial === undefined && this.#dirtySpaces.size > 0) {
        await this.waitForConnectionQueuesToDrain(
          Math.max(
            MIN_REFRESH_QUEUE_DRAIN_WAIT_MS,
            this.#lastRefreshDurationMs * 2,
          ),
        );
      }
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
        const dirtyOrigins = this.#dirtyOriginsBySpace.get(space);
        if (dirtyOrigins !== undefined) {
          this.#dirtyOriginsBySpace.delete(space);
        }
        for (const connection of this.#connections.values()) {
          await connection.refreshDirty(space, dirtyIds, dirtyOrigins);
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
      return Promise.resolve(encodeMemoryBoundary(respondToHello(parsed)));
    }
    return Promise.resolve(null);
  }

  private async mirrorSchedulerObservation(
    ownerSpace: string,
    observation: Engine.SchedulerActionObservation,
    commit: Engine.AppliedCommit,
    previousReadSpaces: ReadonlySet<string>,
    session: SessionState | undefined,
  ): Promise<void> {
    const mirrorSpaces = this.schedulerObservationReadSpaces(observation);
    for (const space of previousReadSpaces) {
      mirrorSpaces.add(space);
    }
    mirrorSpaces.delete(ownerSpace);

    for (const space of mirrorSpaces) {
      if (
        !previousReadSpaces.has(space) &&
        !this.canMirrorSchedulerObservationToSpace(space, session)
      ) {
        continue;
      }
      const engine = await this.openEngine(space);
      Engine.upsertSchedulerObservation(engine, {
        branch: commit.branch,
        ownerSpace,
        observedAtSeq: commit.seq,
        observation,
      });
    }
  }

  private async runPostCommitSchedulerSideEffects(
    ownerSpace: string,
    commit: Engine.AppliedCommit,
    observations: readonly CommitSchedulerObservation[],
    previousReadSpaces: ReadonlyMap<number, ReadonlySet<string>>,
    session: SessionState | undefined,
  ): Promise<void> {
    if (!getPersistentSchedulerStateConfig()) {
      return;
    }

    try {
      await this.propagateSchedulerDirtyToOwnerSpaces(ownerSpace, commit);
      const keptObservationLocalSeqs = commit.schedulerObservationResults
        ? new Set(
          commit.schedulerObservationResults
            .filter((result) => result.status === "kept")
            .map((result) => result.localSeq),
        )
        : undefined;
      for (const { localSeq, observation } of observations) {
        if (
          keptObservationLocalSeqs &&
          !keptObservationLocalSeqs.has(localSeq)
        ) {
          continue;
        }
        await this.mirrorSchedulerObservation(
          ownerSpace,
          observation,
          commit,
          previousReadSpaces.get(localSeq) ?? new Set(),
          session,
        );
      }
    } catch (error) {
      console.warn(
        "Post-commit scheduler state update failed after semantic commit:",
        error,
      );
    }
  }

  private canMirrorSchedulerObservationToSpace(
    readSpace: string,
    session: SessionState | undefined,
  ): boolean {
    if (!this.options.authorizeSessionOpen) {
      return true;
    }
    if (!session) {
      return false;
    }
    return this.#sessions.hasOpenSessionForPrincipal(
      readSpace,
      session.principal,
    );
  }

  private async propagateSchedulerDirtyToOwnerSpaces(
    writeSpace: string,
    commit: Engine.AppliedCommit,
  ): Promise<void> {
    const readersByOwner = new Map<
      string,
      Engine.SchedulerReaderIndexEntry[]
    >();
    for (const reader of commit.schedulerDirtiedReaders ?? []) {
      if (!reader.ownerSpace || reader.ownerSpace === writeSpace) {
        continue;
      }
      let readers = readersByOwner.get(reader.ownerSpace);
      if (!readers) {
        readers = [];
        readersByOwner.set(reader.ownerSpace, readers);
      }
      readers.push(reader);
    }

    for (const [ownerSpace, readers] of readersByOwner) {
      const engine = await this.openEngine(ownerSpace);
      Engine.markSchedulerActionsDirectDirty(engine, {
        branch: commit.branch,
        ownerSpace,
        dirtySeq: commit.seq,
        actions: readers,
      });
    }
  }

  private schedulerObservationReadSpaces(
    observation: Engine.SchedulerActionObservation | undefined,
  ): Set<string> {
    const spaces = new Set<string>();
    if (!observation) {
      return spaces;
    }
    for (const read of [...observation.reads, ...observation.shallowReads]) {
      spaces.add(read.space);
    }
    return spaces;
  }

  private openEngine(space: string): Promise<Engine.Engine> {
    const existing = this.#engines.get(space);
    if (existing !== undefined) {
      return existing;
    }

    const url = this.#store
      ? resolveSpaceStoreUrl(
        this.#store,
        space as `did:${string}:${string}`,
      )
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

export const parseClientMessage = (
  payload: string,
): ClientMessage | null => {
  let parsed: unknown;
  try {
    parsed = decodeMemoryBoundary(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (
    parsed.type === "hello" &&
    typeof parsed.protocol === "string"
  ) {
    if (parseMemoryProtocolFlags(parsed.flags) === null) {
      return null;
    }
    return {
      type: "hello",
      protocol: parsed.protocol as HelloMessage["protocol"],
      flags: parsed.flags as WireMemoryProtocolFlags,
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
    parsed.type === "sqlite.query" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.sql === "string" &&
    parsed.sql.length <= 100_000 &&
    isRecord(parsed.db) &&
    typeof parsed.db.id === "string" &&
    parsed.db.id.length > 0 && parsed.db.id.length <= 256 &&
    (parsed.db.tables === undefined ||
      (isRecord(parsed.db.tables) &&
        Object.keys(parsed.db.tables).length <= 256))
  ) {
    const db = {
      id: parsed.db.id,
      tables: isRecord(parsed.db.tables) ? parsed.db.tables : undefined,
    };
    const params = Array.isArray(parsed.params) || isRecord(parsed.params)
      ? parsed.params as SqliteParamsWire
      : undefined;
    return {
      type: parsed.type,
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      db,
      sql: parsed.sql,
      params,
    } as SqliteQueryRequest;
  }

  if (
    parsed.type === "sqlite.register-disk-source" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.id === "string" &&
    parsed.id.length > 0 && parsed.id.length <= 256 &&
    typeof parsed.path === "string" &&
    parsed.path.length > 0 && parsed.path.length <= 4096
  ) {
    return {
      type: "sqlite.register-disk-source",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      id: parsed.id,
      path: parsed.path,
    } as SqliteRegisterDiskSourceRequest;
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
    parsed.type === "scheduler.snapshot.list" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isRecord(parsed.query)
  ) {
    return {
      type: "scheduler.snapshot.list",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      query: parsed.query as SchedulerSnapshotListRequest["query"],
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
