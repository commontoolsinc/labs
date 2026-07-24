import * as FS from "@std/fs";
import * as Path from "@std/path";
import { resolveSpaceStoreUrl } from "./storage-path.ts";
import {
  type CellScope,
  type ClientCommit,
  type ClientMessage,
  dbNeedsColumnProvenance,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityIdListRequest,
  type EntityIdListResult,
  type EntityIdLookupRequest,
  type EntityIdLookupResult,
  getPersistentSchedulerStateConfig,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
  MAX_ENTITY_ID_BYTES,
  MAX_ENTITY_ID_PAGE_BYTES,
  MAX_ENTITY_ID_PAGE_SIZE,
  type Operation,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerExecutionContextKey,
  type SchedulerSnapshotListRequest,
  type SchedulerSnapshotListResult,
  type ServerMessage,
  type SessionAckRequest,
  type SessionAckResult,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenChallenge,
  type SessionOpenRequest,
  type SessionOpenResult,
  type SessionRevokedMessage,
  type SessionSync,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryRequest,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceRequest,
  type SqliteRegisterDiskSourceResult,
  type SqliteResultColumn,
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

const protocolTextEncoder = new TextEncoder();

function entityIdUtf8Bytes(id: string): number {
  return protocolTextEncoder.encode(id).length;
}

function takeBoundedEntityIdPage(
  rows: readonly string[],
  limit: number,
): { ids: string[]; hasMore: boolean } {
  const ids: string[] = [];
  let serializedBytes = 2; // JSON array brackets.
  for (const id of rows) {
    const rawBytes = entityIdUtf8Bytes(id);
    if (rawBytes > MAX_ENTITY_ID_BYTES) {
      throw new RangeError(
        `entity identifier is ${rawBytes} bytes; maximum is ${MAX_ENTITY_ID_BYTES}`,
      );
    }
    const entryBytes = protocolTextEncoder.encode(JSON.stringify(id)).length +
      (ids.length === 0 ? 0 : 1);
    if (
      ids.length >= limit ||
      serializedBytes + entryBytes > MAX_ENTITY_ID_PAGE_BYTES
    ) {
      break;
    }
    ids.push(id);
    serializedBytes += entryBytes;
  }
  return { ids, hasMore: ids.length < rows.length };
}
import {
  ANYONE_USER,
  type Capability,
  hasConcreteOwner,
  isACL,
  isCapable,
} from "../acl.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
} from "./sqlite/exec.ts";
import { assertReadOnly } from "./sqlite/guard.ts";
import { RowLabelCommitError } from "./sqlite/commit-eval.ts";
import type { TableSchema } from "./sqlite/schema.ts";
import { DiskSourceRegistry } from "./sqlite/disk-source.ts";
import { ReadConnectionPool } from "./sqlite/read-pool.ts";
import {
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "./sqlite/column-origin.ts";
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
import { compressServerMessageSchemas } from "./sync-schema-table.ts";
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
import { authorizationError } from "./session-open-auth.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";

export { SessionRegistry } from "./session-registry.ts";

// Global OTel API tracer. Interface-only and inert when no provider is
// registered, so this is a no-op unless the host process (toolshed) has an
// OTLP SDK installed. Spans created here are purely additive observability and
// do not affect write/fan-out behavior.
const tracer = trace.getTracer("memory-server", "1.0.0");

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
const MIN_REFRESH_QUEUE_DRAIN_WAIT_MS = 500;
const SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_BUFFER_SIZE = 100;
const DEFAULT_SESSION_OPEN_CHALLENGE_TTL_SECONDS = 300;
const SESSION_OPEN_CHALLENGE_BYTES = 32;
// SQLite resource caps (mirror the `sqlite.query` wire-parse caps; also applied
// to the folded-write path, which is parsed loosely as part of a `transact`).
const MAX_SQLITE_SQL_LENGTH = 100_000;
const MAX_SQLITE_TABLES = 256;

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

const randomHex = (bytes: number): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const schedulerApplicableContextKeys = (
  principal: string | undefined,
  sessionId: string,
): SchedulerExecutionContextKey[] => {
  const keys: SchedulerExecutionContextKey[] = ["space"];
  if (principal === undefined) return keys;
  keys.push(
    Engine.resolveScopeKey("user", {
      principal,
    }) as SchedulerExecutionContextKey,
    Engine.resolveScopeKey("session", {
      principal,
      sessionId,
    }) as SchedulerExecutionContextKey,
  );
  return keys;
};

type CommitSchedulerObservation = {
  localSeq: number;
  observation: Engine.SchedulerActionObservation;
};

const schedulerObservationsFromCommit = (
  commit: ClientCommit,
): CommitSchedulerObservation[] => {
  const single = Engine.schedulerObservationFromValue(
    commit.schedulerObservation,
  );
  if (single) {
    return [{ localSeq: commit.localSeq, observation: single }];
  }

  const batch = commit.schedulerObservationBatch ?? [];
  const observations: CommitSchedulerObservation[] = [];
  for (const item of batch) {
    const observation = Engine.schedulerObservationFromValue(
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

const toPreconditionFailedError = (
  error: unknown,
  message: string,
): V2Error | undefined => {
  if (
    error instanceof Engine.PreconditionFailedError ||
    (error instanceof Error &&
      error.name === "PreconditionFailedError" &&
      typeof (error as { precondition?: unknown }).precondition === "string")
  ) {
    return {
      name: "PreconditionFailedError",
      message,
      precondition: (error as unknown as { precondition: string })
        .precondition,
    };
  }
  return undefined;
};

export type MemoryAclMode = "off" | "observe" | "enforce";

type AclState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; acl: Record<string, Capability | undefined> };

/** Engine doc id of a space's ACL document: the doc whose entity id is the
 *  space DID itself, as managed by the runner's `ACLManager` / `cf acl`
 *  (runner `toURI` prefixes bare ids with `of:`). */
const aclDocId = (space: string): string => `of:${space}`;

const commitTouchesAclDoc = (
  operations: readonly Operation[],
  space: string,
): boolean => {
  const id = aclDocId(space);
  return operations.some((operation) =>
    "id" in operation && operation.id === id
  );
};

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

/** Extract the table name from a SQLite "no such table: <name>" error, or
 *  undefined if the error is not that shape. SQLite reports the *unquoted* name,
 *  which may itself contain spaces or dots (e.g. `CREATE TABLE "my notes"`), so
 *  we take the whole remainder of the message. Only a real `main.`/`temp.`
 *  schema prefix is stripped — a bare table literally named `a.b` is preserved,
 *  so the result matches a declared-table key exactly. */
function missingTableName(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /no such table:\s*(.+)$/i.exec(message);
  if (match === null) return undefined;
  const ref = match[1].trim();
  const dot = ref.indexOf(".");
  if (dot !== -1) {
    const schema = ref.slice(0, dot).toLowerCase();
    if (schema === "main" || schema === "temp") return ref.slice(dot + 1);
  }
  return ref;
}

/** Whether `name` matches a declared table key, using the SAME case-folding
 *  SQLite uses to resolve table identifiers: **ASCII-only** (A–Z ↔ a–z). A
 *  full-Unicode `toLowerCase()` would over-match — SQLite treats e.g. `Ü` and
 *  `ü` as distinct tables, so folding them together here would mask a genuine
 *  "no such table" error as an empty result. */

function isDeclaredTable(
  tables: Record<string, unknown> | undefined,
  name: string,
): boolean {
  if (tables === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(tables, name)) return true;
  const asciiFold = (value: string): string =>
    value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const lowered = asciiFold(name);
  for (const key of Object.keys(tables)) {
    if (asciiFold(key) === lowered) return true;
  }
  return false;
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

type SessionOpenAuthContext = {
  audience: string;
  challenge: SessionOpenChallenge;
};

type SessionOpenChallengeState = SessionOpenChallenge & {
  consumed: boolean;
};

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
  #syncSchemaTable = false;
  // Negotiated persistentSchedulerState: when both sides carry the flag,
  // subscription sync pushes to this connection include the scheduler
  // observation rows of the sync window, so its runtimes can ADOPT other
  // clients' action runs instead of re-running them
  // (docs/specs/scheduler-v2/incremental-observation-adoption.md §4).
  #persistentSchedulerState = false;
  #sessions = new Map<string, SessionHandle>();
  #sessionOpenChallenge: SessionOpenChallengeState | null = null;
  #receiving: Promise<void> = Promise.resolve();
  #pendingReceives = 0;
  #receiveIdle: PromiseWithResolvers<void> | null = null;

  constructor(
    readonly id: string,
    private readonly server: Server,
    private readonly sendRaw: Send,
  ) {}

  private send(message: ServerMessage): void {
    this.sendRaw(
      this.#syncSchemaTable ? compressServerMessageSchemas(message) : message,
    );
  }

  hasSession(space: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(space, sessionId));
  }

  private shouldSuppressSessionSend(
    space: string,
    sessionId: string,
  ): boolean {
    return this.server.isAclActive() &&
      (!this.hasSession(space, sessionId) ||
        !this.server.isSessionAttached(space, sessionId, this.id));
  }

  private sendSessionResponse(
    space: string,
    sessionId: string,
    requestId: string,
    response: ServerMessage,
  ): void {
    if (this.shouldSuppressSessionSend(space, sessionId)) {
      // session/revoked is a lifecycle notification; it does not settle the
      // generic request promise. Always pair suppression of an in-flight RPC
      // result with a typed response error carrying the original request id.
      this.send({
        type: "response",
        requestId,
        error: toError(
          "SessionRevokedError",
          "Session was revoked while the request was in flight",
        ),
      });
      return;
    }
    this.send(response);
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

  issueSessionOpenAuth(): SessionOpenAuthMetadata {
    const sessionOpen = this.server.sessionOpenHandshake();
    this.#sessionOpenChallenge = {
      ...sessionOpen.challenge,
      consumed: false,
    };
    return sessionOpen;
  }

  sessionOpenAuthContext(message: SessionOpenRequest): SessionOpenAuthContext {
    const audience = this.server.sessionOpenAudience();
    const invocation = isRecord(message.invocation) ? message.invocation : null;
    if (invocation === null || typeof invocation.aud !== "string") {
      throw authorizationError("memory session.open requires audience");
    }
    if (invocation.aud !== audience) {
      throw authorizationError("memory session.open audience mismatch");
    }

    const challenge = this.#sessionOpenChallenge;
    if (challenge === null) {
      throw authorizationError("memory session.open challenge unavailable");
    }
    if (challenge.consumed) {
      throw authorizationError("memory session.open challenge already used");
    }
    if (challenge.expiresAt <= this.server.nowSeconds()) {
      throw authorizationError("memory session.open challenge expired");
    }
    if (typeof invocation.challenge !== "string") {
      throw authorizationError("memory session.open requires challenge");
    }
    if (invocation.challenge !== challenge.value) {
      throw authorizationError("memory session.open challenge mismatch");
    }

    return {
      audience,
      challenge: {
        value: challenge.value,
        expiresAt: challenge.expiresAt,
      },
    };
  }

  consumeSessionOpenChallenge(challenge: SessionOpenChallenge): void {
    if (this.#sessionOpenChallenge === null) {
      return;
    }
    if (this.#sessionOpenChallenge.value === challenge.value) {
      this.#sessionOpenChallenge.consumed = true;
    }
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
      if (response.type === "hello.ok") {
        response.sessionOpen = this.issueSessionOpenAuth();
      }
      this.send(response);
      if (response.type !== "hello.ok") {
        return;
      }
      const clientFlags = parseMemoryProtocolFlags(parsed.flags);
      const serverFlags = parseMemoryProtocolFlags(response.flags);
      this.#syncSchemaTable = clientFlags?.syncSchemaTableV2 === true &&
        serverFlags?.syncSchemaTableV2 === true;
      this.#persistentSchedulerState =
        clientFlags?.persistentSchedulerState === true &&
        serverFlags?.persistentSchedulerState === true;
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
        {
          const response = await this.server.graphQuery(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "entity-id.list":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.server.listEntityIds(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "entity-id.exists":
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.server.entityIdExists(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "sqlite.query":
        if (
          !this.requireSession(parsed.requestId, parsed.space, parsed.sessionId)
        ) {
          return;
        }
        {
          const response = await this.server.sqliteQuery(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "sqlite.register-disk-source":
        if (
          !this.requireSession(parsed.requestId, parsed.space, parsed.sessionId)
        ) {
          return;
        }
        {
          const response = await this.server.sqliteRegisterDiskSource(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
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
        {
          const response = await this.server.watchSet(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
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
        {
          const response = await this.server.watchAdd(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
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
        {
          const response = await this.server.listSchedulerActionSnapshots(
            parsed,
          );
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
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
        {
          const response = await this.server.ackSession(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
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

    for (const { space: sessionSpace, sessionId } of this.#sessions.values()) {
      if (this.#closed) {
        return;
      }
      // A construction intentionally reuses one authenticated session id in
      // every space. Dirty refresh is still space-specific: syncing that id
      // through a connection mounted in another space would advance the real
      // target session's cursor, then send its effect down the wrong socket.
      if (sessionSpace !== space) {
        continue;
      }
      const effect = await this.server.syncSessionForConnection(
        space,
        sessionId,
        dirtyIds,
        dirtyOrigins,
        { adoptionObservations: this.#persistentSchedulerState },
      );
      if (this.#closed) {
        return;
      }
      // ACL revocation can remove the session while watch evaluation awaits
      // its engine. Never emit the already-computed effect after that removal.
      if (this.shouldSuppressSessionSend(space, sessionId)) {
        continue;
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
  // The owner commit is synchronous, but cross-space scheduler fan-out awaits
  // other engines. Preserve owner apply order across concurrent connections so
  // an older mirror cannot land after a newer one.
  #schedulerSideEffectsByOwnerSpace = new Map<string, Promise<void>>();
  #lastRefreshDurationMs = 0;
  #store?: URL;
  // Injected on-disk SQLite sources (Phase 7), keyed by handle cell id. A
  // registered id is attached read-only from its descriptor path instead of the
  // cell-derived per-(space,id) file. v1 in-memory; persistence is deferred (see
  // docs/specs/sqlite-builtin/plans/on-disk-source.md).
  #diskSources = new DiskSourceRegistry();
  // Pooled read-only connections (keyed by canonical file path) for SQLite
  // reads — injected on-disk sources and cell-derived dbs alike run here,
  // unattached, instead of attach/detach-per-op on the engine connection.
  #readPool = new ReadConnectionPool();
  // Schemas already created on the write path, keyed by `(space, id, schema)`.
  // `ensureTables` (additive `CREATE TABLE IF NOT EXISTS` per declared table)
  // runs only the first time a given schema is seen for a cell-db, not on every
  // write. Bounded LRU; a miss (eviction / restart) just re-runs ensureTables,
  // which is idempotent. Keyed by the full schema JSON so a changed declaration
  // re-ensures (additive migration) with no hash-collision risk.
  #ensuredSchemas = new Map<string, true>();
  #ensuredSchemasMax = 4096;

  #recordSchemaEnsured(key: string): void {
    this.#ensuredSchemas.set(key, true);
    if (this.#ensuredSchemas.size > this.#ensuredSchemasMax) {
      const oldest = this.#ensuredSchemas.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.#ensuredSchemas.delete(oldest);
    }
  }

  constructor(
    readonly options: {
      sessions?: SessionRegistry;
      store?: URL;
      subscriptionRefreshDelayMs?: number;
      authorizeSessionOpen: (
        message: SessionOpenRequest,
        context: SessionOpenAuthContext,
      ) => Promise<string | undefined> | string | undefined;
      /**
       * Authentication data advertised in `hello.ok` and enforced for
       * `session.open` on this server.
       */
      sessionOpenAuth: {
        /** Audience value clients must sign into `session.open` as `aud`. */
        audience: string;
        /** How long a connection challenge may be used, in seconds. */
        challengeTtlSeconds?: number;
        /** Current unix time in seconds. Tests may inject this. */
        nowSeconds?: () => number;
      };
      /**
       * Space access control. `off` (default) preserves the historical
       * any-authenticated-session-may-do-anything behavior. `observe`
       * evaluates ordinary capability decisions, counts and logs
       * would-denies, but allows those decisions. Invalid ACL state and
       * fresh-space genesis violations remain hard failures. `enforce` denies
       * all capability shortfalls as well.
       *
       * Policy: a session principal has implicit OWNER on a space when it
       * IS the space DID or is listed in `serviceDids`; otherwise the
       * space's ACL document (entity id == the space DID, as managed by the
       * runner's `ACLManager` / `cf acl`) grants per-DID or `"*"`
       * capabilities. A missing ACL on a populated legacy space grants every
       * authenticated principal READ and WRITE (never OWNER). A fresh space
       * grants authenticated READ only: its first write must be a valid ACL
       * initialized by the space identity or a service DID.
       *
       * Requirements: session.open, queries, and watches need READ;
       * transact needs WRITE; ACL-document writes and disk-source
       * registration need OWNER. Enforcement is only meaningful when
       * `authorizeSessionOpen` is configured — without it sessions carry no
       * principal and only `"*"` grants can apply.
       */
      acl?: {
        mode: MemoryAclMode;
        serviceDids?: readonly string[];
      };
    },
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#store = options.store;
  }

  nowSeconds(): number {
    return this.options.sessionOpenAuth.nowSeconds?.() ??
      Math.floor(Date.now() / 1000);
  }

  sessionOpenAudience(): string {
    return this.options.sessionOpenAuth.audience;
  }

  sessionOpenHandshake(): SessionOpenAuthMetadata {
    const ttl = this.options.sessionOpenAuth.challengeTtlSeconds ??
      DEFAULT_SESSION_OPEN_CHALLENGE_TTL_SECONDS;
    return {
      audience: this.sessionOpenAudience(),
      challenge: {
        value: randomHex(SESSION_OPEN_CHALLENGE_BYTES),
        expiresAt: this.nowSeconds() + ttl,
      },
    };
  }

  /** Counters for ACL decisions; `wouldDeny` is the observe-mode rollout
   *  signal (a nonzero value on a deployment means flipping to `enforce`
   *  would break that traffic). */
  readonly aclStats = { wouldDeny: 0, denied: 0 };

  /** space → (principal key → capability). Invalidated whenever a commit
   *  touches the space's ACL document. */
  #aclCapabilities = new Map<string, Map<string, Capability | null>>();

  #aclMode(): MemoryAclMode {
    return this.options.acl?.mode ?? "off";
  }

  #isServicePrincipal(principal: string): boolean {
    return this.options.acl?.serviceDids?.includes(principal) ?? false;
  }

  #invalidateAclCapabilities(space: string): void {
    this.#aclCapabilities.delete(space);
  }

  #aclState(engine: Engine.Engine, space: string): AclState {
    const state = Engine.readState(engine, { id: aclDocId(space) });
    if (state === null) return { kind: "missing" };
    // A retracted ACL is not equivalent to a never-created ACL: treating the
    // tombstone as public would turn deletion into an authorization bypass.
    if (state.document === null) return { kind: "invalid" };
    const acl = state.document.value;
    if (!isACL(acl)) return { kind: "invalid" };
    const byPrincipal = acl as Record<string, Capability | undefined>;
    if (!hasConcreteOwner(byPrincipal)) return { kind: "invalid" };
    return { kind: "valid", acl: byPrincipal };
  }

  #resolveCapability(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
  ): Capability | null {
    if (
      principal !== undefined &&
      (principal === space || this.#isServicePrincipal(principal))
    ) {
      return "OWNER";
    }
    const state = this.#aclState(engine, space);
    if (state.kind === "valid") {
      return (principal !== undefined ? state.acl[principal] : undefined) ??
        state.acl[ANYONE_USER] ?? null;
    }
    if (state.kind === "missing" && principal !== undefined) {
      // Temporary pre-launch compatibility: populated spaces without an ACL
      // are public to authenticated principals. Empty spaces remain read-only
      // until their identity (or a service DID) writes a valid genesis ACL.
      return Engine.serverSeq(engine) === 0 ? "READ" : "WRITE";
    }
    // Malformed and ownerless ACLs fail closed. Implicit owners above may
    // still repair them explicitly.
    return null;
  }

  #capabilityFor(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
  ): Capability | null {
    const key = principal ?? "";
    let bySpace = this.#aclCapabilities.get(space);
    if (bySpace !== undefined && bySpace.has(key)) {
      return bySpace.get(key) ?? null;
    }
    const capability = this.#resolveCapability(engine, space, principal);
    if (bySpace === undefined) {
      bySpace = new Map();
      this.#aclCapabilities.set(space, bySpace);
    }
    bySpace.set(key, capability);
    return capability;
  }

  /** Evaluate the ACL policy for a message. Returns `null` when the message
   *  may proceed and a typed error when it must be rejected. In `observe`, an
   *  ordinary capability shortfall is counted and logged; invalid ACL state
   *  still fails closed. */
  #authorizeMessageWithEngine(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
    requirement: Capability,
  ): V2Error | null {
    if (this.#aclMode() === "off") return null;
    const capability = this.#capabilityFor(engine, space, principal);
    if (capability !== null && isCapable(capability, requirement)) {
      return null;
    }
    const principalLabel = principal ?? "<anonymous>";
    if (this.#aclState(engine, space).kind === "invalid") {
      this.aclStats.denied += 1;
      return toError(
        "AuthorizationError",
        `Space ${space} has a malformed, ownerless, or retracted ACL`,
      );
    }
    if (this.#aclMode() === "observe") {
      this.aclStats.wouldDeny += 1;
      console.warn(
        `[memory-acl] would deny ${requirement} on ${space} for ` +
          `${principalLabel} (capability: ${capability ?? "none"})`,
      );
      return null;
    }
    this.aclStats.denied += 1;
    return toError(
      "AuthorizationError",
      `Principal ${principalLabel} lacks ${requirement} on space ${space}`,
    );
  }

  async #authorizeMessage(
    space: string,
    principal: string | undefined,
    requirement: Capability,
  ): Promise<V2Error | null> {
    // Keep off mode's historical async shape: callers await this immediate
    // return, then independently await their read engine/evaluation. Some
    // legacy runtime ordering depends on those two yield points.
    if (this.#aclMode() === "off") return null;
    const engine = await this.openEngine(space);
    return this.#authorizeMessageWithEngine(
      engine,
      space,
      principal,
      requirement,
    );
  }

  #authorizeCurrentSessionWithEngine(
    engine: Engine.Engine,
    space: string,
    sessionId: string,
    session: SessionState,
    requirement: Capability,
  ): V2Error | null {
    if (this.#sessions.get(space, sessionId) !== session) {
      return toError("SessionError", "Unknown session for space");
    }
    return this.#authorizeMessageWithEngine(
      engine,
      space,
      session.principal,
      requirement,
    );
  }

  /** Enforce ACL document shape and fresh-space genesis independently of the
   *  observe/enforce access-decision dial. These are storage invariants: an
   *  invalid ACL or an ordinary first write would make later enforcement
   *  ambiguous or impossible. */
  #validateAclCommit(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
    commit: ClientCommit,
  ): V2Error | null {
    if (this.#aclMode() === "off") return null;

    const state = this.#aclState(engine, space);
    const aclTouched = commitTouchesAclDoc(commit.operations, space);

    if (!aclTouched) {
      if (state.kind === "missing" && Engine.serverSeq(engine) === 0) {
        return toError(
          "AuthorizationError",
          `Space ${space} requires an ACL genesis commit before ordinary writes`,
        );
      }
      return null;
    }

    if (commit.branch !== undefined && commit.branch !== "") {
      return toError(
        "ProtocolError",
        "ACL mutations are only valid on the default branch",
      );
    }
    if (commit.operations.length !== 1) {
      return toError(
        "ProtocolError",
        "ACL mutations must be an ACL-only commit",
      );
    }
    const operation = commit.operations[0];
    if (
      operation.op !== "set" ||
      operation.id !== aclDocId(space) ||
      (operation.scope !== undefined && operation.scope !== "space")
    ) {
      return toError(
        "ProtocolError",
        "ACL mutations must replace the space-scoped ACL document",
      );
    }
    const acl = operation.value?.value;
    if (!isACL(acl) || !hasConcreteOwner(acl)) {
      return toError(
        "ProtocolError",
        "ACL must be valid and retain at least one concrete OWNER",
      );
    }
    if (
      state.kind === "missing" &&
      (principal === undefined ||
        (principal !== space && !this.#isServicePrincipal(principal)))
    ) {
      return toError(
        "AuthorizationError",
        `Only the space identity or a service DID may initialize ${space}`,
      );
    }
    return null;
  }

  /** After an ACL change, drop live sessions whose principal no longer
   *  holds READ (enforce mode only): per-message gating alone would still
   *  let their already-registered subscriptions receive pushes. The owning
   *  connection gets a session/revoked("unauthorized"), which the client
   *  treats as a terminal session close (no reopen loop — a reopen attempt
   *  is denied at session.open). The session that made the triggering ACL
   *  write (`writerSessionId`) is still dropped from the registry — so it
   *  receives no further pushes — but is NOT sent the terminal revocation, so
   *  it gets this transact's response first (a self-removal otherwise reads as
   *  a failure). Its next message fails closed as an unknown session. */
  #revokeDeauthorizedSessions(
    engine: Engine.Engine,
    space: string,
    writerSessionId?: string,
  ): void {
    if (this.#aclMode() !== "enforce") return;
    for (const session of this.#sessions.sessionsForSpace(space)) {
      const capability = this.#capabilityFor(engine, space, session.principal);
      if (capability !== null && isCapable(capability, "READ")) continue;
      // Drop the de-authorized session from the registry: the refresh loop
      // iterates registered sessions, so removal stops all further watch
      // pushes, and its next message fails closed (Unknown session).
      this.#sessions.remove(space, session.id);
      if (session.id === writerSessionId) {
        // The writer's own session — it just removed its own access. Removal
        // already stopped its pushes and denies its next message; do NOT also
        // send the terminal session/revoked, which the client treats as
        // terminal and would turn this transact's successful self-removal into
        // a reported failure.
        continue;
      }
      if (session.ownerConnectionId !== null) {
        this.#connections.get(session.ownerConnectionId)?.revokeSession(
          space,
          session.id,
          "unauthorized",
        );
      }
    }
  }

  connect(send: Send): Connection {
    const connection = new Connection(crypto.randomUUID(), this, send);
    this.#connections.set(connection.id, connection);
    return connection;
  }

  isAclActive(): boolean {
    return this.#aclMode() !== "off";
  }

  isSessionAttached(
    space: string,
    sessionId: string,
    connectionId: string,
  ): boolean {
    return this.#sessions.get(space, sessionId)?.ownerConnectionId ===
      connectionId;
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
    this.#readPool.close();
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
    if (this.#aclMode() !== "off") {
      if (id === aclDocId(space)) {
        throw new Engine.ProtocolError(
          "direct writes may not mutate the ACL document",
        );
      }
      const aclState = this.#aclState(engine, space);
      if (aclState.kind === "invalid") {
        throw new Engine.ProtocolError(
          `space ${space} has invalid ACL state`,
        );
      }
      if (
        aclState.kind === "missing" &&
        Engine.serverSeq(engine) === 0
      ) {
        throw new Engine.ProtocolError(
          `space ${space} requires an ACL genesis commit before direct writes`,
        );
      }
    }
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
   * Read a cell-derived database on a pooled read-only connection — unattached,
   * like injected on-disk sources. (Writes still ATTACH to the engine connection
   * in `#attachCommitSqliteDbs` for commit atomicity.)
   *
   * A cell-db file is created lazily by the first WRITE (its ATTACH), and that
   * write's `ensureTables` creates the declared tables. So a read can find:
   *   - no file yet (never written) → no rows;
   *   - a file without the queried table (e.g. a newly-declared table not yet
   *     created by a write) → no rows.
   * Both map to an empty result, preserving the previous "read a fresh cell-db
   * returns []" contract without the read needing to create anything.
   */
  async #readCellDb(
    space: string,
    db: SqliteDbRef,
    sql: string,
    params: SqliteParamsWire | undefined,
    scopeKey: string,
    wantColumns: boolean,
  ): Promise<{ rows: unknown[]; columns?: SqliteResultColumn[] }> {
    // Apply the statement guard BEFORE the file-existence short-circuit, so a
    // rejected statement (non-SELECT, core-table/qualified ref, ATTACH/PRAGMA,
    // multi-statement) is refused even against a never-written cell-db rather
    // than silently returning [].
    assertReadOnly(sql);
    const engine = await this.openEngine(space);
    const path = this.#cellDbPath(engine, space, db.id, scopeKey);
    // A never-written cell-db has no file yet (its schema is created on the
    // first write, via the attach path). Treat a missing file as an empty
    // result — but ONLY a genuinely-absent file: any other stat failure
    // (permissions, I/O) is a real error and must surface, not masquerade as [].
    try {
      Deno.statSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { rows: [] };
      throw error;
    }
    try {
      return wantColumns
        ? this.#readPool.queryWithOrigins(path, sql, params)
        : { rows: this.#readPool.query(path, sql, params) };
    } catch (error) {
      // The file exists (written at least once, so ensureTables created every
      // table declared at that write). A "no such table" therefore means either:
      //   - a DECLARED table not yet materialized (the schema evolved since the
      //     last write; the next write creates it) → behaves like a fresh,
      //     empty table → [].
      //   - an UNDECLARED table (a typo or otherwise undeclared name) → a real
      //     mistake → rethrow.
      // Scoping to the declared schema preserves create-on-read semantics
      // without masking genuine query/schema errors as empty results.
      // SQLite identifiers are case-insensitive (ASCII), so match the missing
      // name against the declared keys case-insensitively — otherwise a table
      // declared `Notes` but queried `notes` would rethrow before its first
      // write yet succeed after (SQLite case-folds), flipping the contract.
      const missing = missingTableName(error);
      if (missing !== undefined && isDeclaredTable(db.tables, missing)) {
        return { rows: [] };
      }
      throw error;
    }
  }

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1) for
   * `(space, id)`. After this, `sqliteQuery` reads the canonical `path` on the
   * read pool (read-only) for that `(space, id)` instead of the cell-derived db.
   * The descriptor is server-side state — never the cell value.
   *
   * The path is validated here because it arrives over the wire (untrusted): it
   * must be absolute and must exist, and is `realpath`-canonicalized and then
   * rejected if it resolves INSIDE the engine's store directory OR names an
   * internal cell-db file — otherwise a caller could point a handle at another
   * space's (or a cell-derived) `.sqlite` file and read it cross-tenant.
   * (Confining injected sources to an operator allowlist, and gating the verb to
   * an operator capability rather than any session, awaits CFC labels —
   * 08-open-questions Q18.)
   */
  async registerDiskSource(
    space: string,
    id: string,
    path: string,
    beforeRegister?: (engine: Engine.Engine) => void,
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
      // Canonicalize the store dir too (not just the source path): `canonical`
      // is realpath-resolved, so comparing it against a NON-canonical storeDir
      // lets a symlinked store dir produce a `..`-prefixed relative path for a
      // file that actually lives in the store — defeating the jail. With both
      // sides canonical, containment also covers the `<space>.sqlite` store
      // files (not just `cell-*`).
      let storeDir = Path.dirname(Path.fromFileUrl(engine.url));
      try {
        storeDir = await Deno.realPath(storeDir);
      } catch { /* dir may not exist yet; fall back to the raw path */ }
      const rel = Path.relative(storeDir, canonical);
      const insideStore = rel === "" ||
        (!rel.startsWith("..") && !Path.isAbsolute(rel));
      if (insideStore) {
        throw new Engine.ProtocolError(
          "disk source path may not resolve inside the store directory",
        );
      }
    }
    // Internal cell-db files (`cell-<tag>.sqlite` beside a file store's space db;
    // `cf-cell-<tag>.sqlite` under TMPDIR for a memory store — see #cellDbPath)
    // are never valid injected sources. Reject by name so a memory store (which
    // has no on-disk store directory to jail against) can't be pointed at another
    // space's cell-db sitting in TMPDIR.
    if (/^(?:cf-)?cell-[^/]*\.sqlite$/i.test(Path.basename(canonical))) {
      throw new Engine.ProtocolError(
        "disk source path may not be an internal cell-db file",
      );
    }
    // The RPC path uses this synchronous hook to re-authorize beside the
    // registry mutation after the filesystem awaits above. Direct internal
    // callers do not need to provide it.
    beforeRegister?.(engine);
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
    scopeContext: { principal?: string; sessionId: string },
  ): Map<string, string> {
    const map = new Map<string, string>();
    const tablesById = new Map<string, Record<string, unknown> | undefined>();
    // The db's scope qualifies its on-disk file the same way the read path does
    // (so a write and a read of a user/session-scoped db hit the same file).
    const scopeKeyById = new Map<string, string>();
    for (const op of operations) {
      if (op.op !== "sqlite") continue;
      const id = op.db.id;
      // Resource caps for the WRITE path. `sqlite.query` enforces these at parse
      // time, but a folded `sqlite` op rides `transact` (whose commit is parsed
      // loosely), so cap it here — before the guard tokenizes the statement and
      // before ensureTables builds DDL — to bound CPU/DDL work on the shared,
      // single-threaded per-space engine connection.
      if (typeof op.sql === "string" && op.sql.length > MAX_SQLITE_SQL_LENGTH) {
        throw new Engine.ProtocolError(
          "sqlite statement exceeds the maximum length",
        );
      }
      if (
        op.db.tables &&
        Object.keys(op.db.tables).length > MAX_SQLITE_TABLES
      ) {
        throw new Engine.ProtocolError("sqlite db declares too many tables");
      }
      // Phase 7: injected on-disk sources are read-only in v1 — a folded write to
      // one is rejected before it can join the commit (Q13/Q14).
      if (this.#diskSources.has(space, id)) {
        throw new Engine.ProtocolError(
          "injected on-disk SQLite sources are read-only in v1 (db.exec rejected)",
        );
      }
      // Validate the declared scope on the WRITE path too. `sqlite.query`
      // validates scope at parse time, but a folded op rides the loosely-parsed
      // `transact` commit — an invalid value must fail loudly here, not silently
      // degrade to space scoping (which would mis-place the file).
      if (
        op.db.scope !== undefined && op.db.scope !== "space" &&
        op.db.scope !== "user" && op.db.scope !== "session"
      ) {
        throw new Engine.ProtocolError("sqlite op declares an invalid scope");
      }
      const scopeKey = Engine.resolveScopeKey(op.db.scope, {
        principal: scopeContext.principal,
        sessionId: scopeContext.sessionId,
      });
      if (map.has(id)) {
        // Same db id appears twice in one commit: it must resolve to the same
        // scoped file. A differing scope key would mean the second op silently
        // writes into the first op's (different user/session) file — reject it.
        if (scopeKeyById.get(id) !== scopeKey) {
          throw new Engine.ProtocolError(
            "conflicting scope for the same sqlite database in one commit",
          );
        }
        continue;
      }
      if (map.size >= 1) {
        throw new Engine.ProtocolError(
          "a commit may write to at most one sqlite database",
        );
      }
      map.set(id, aliasForDbId(id));
      tablesById.set(id, op.db.tables);
      scopeKeyById.set(id, scopeKey);
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
        const scopeKey = scopeKeyById.get(id) ?? "space";
        attachDatabase(
          engine.database,
          alias,
          this.#cellDbPath(engine, space, id, scopeKey),
        );
        attached.push(alias);
        const tables = tablesById.get(id);
        if (tables) {
          // Run ensureTables only the first time this (space, id, scope, schema)
          // is seen; record AFTER it succeeds so a throw re-ensures next time.
          // The scope key is part of the identity: a user/session-scoped db has
          // a distinct file per principal/session, so each needs its own DDL run
          // even though (space, id, schema) match.
          const key = `${space}\0${id}\0${scopeKey}\0${JSON.stringify(tables)}`;
          if (!this.#ensuredSchemas.has(key)) {
            ensureTables(
              engine.database,
              tables as Record<string, TableSchema>,
              alias,
            );
            this.#recordSchemaEnsured(key);
          }
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
   *  the filename so distinct (space, id) pairs never collide.
   *
   *  `scopeKey` is the resolved scope key (`Engine.resolveScopeKey`): `space`
   *  for the default scope (left out of the name, so existing space-scoped files
   *  keep their path — no migration), or `user:<did>` / `session:<did>:<sid>`
   *  for a scoped db, hashed in so each user/session gets its own file. */
  #cellDbPath(
    engine: Engine.Engine,
    space: string,
    id: string,
    scopeKey: string = "space",
  ): string {
    const scopeTag = scopeKey === "space" ? "" : `-${hashToken(scopeKey)}`;
    const tag = `${hashToken(space)}-${hashToken(id)}${scopeTag}`;
    if (engine.url.protocol === "file:") {
      const dir = Path.dirname(Path.fromFileUrl(engine.url));
      return Path.join(dir, `cell-${tag}.sqlite`);
    }
    return Path.join(Deno.env.get("TMPDIR") ?? "/tmp", `cf-cell-${tag}.sqlite`);
  }

  async sqliteQuery(
    message: SqliteQueryRequest,
  ): Promise<ResponseMessage<SqliteQueryResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<SqliteQueryResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<SqliteQueryResult>(message.requestId, deny);
      }
    }
    try {
      // All reads run unattached on a pooled read-only connection (no ATTACH,
      // real read-only, each file its own `main` namespace). The only
      // per-source difference is path resolution: an injected on-disk source's
      // registered path, else the cell-derived path (which the db's scope
      // qualifies, per the session's principal / id).
      //
      // Capture per-column origin ONLY when the db declares per-column `ifc`
      // (Phase 2) or a per-row label rule (Phase 3 — rule inputs are located
      // by TRUE origin, never output name). Unlabeled dbs — the common case,
      // and all injected on-disk sources — pay nothing.
      const wantColumns = dbNeedsColumnProvenance(message.db.tables);
      // Bind @db/sqlite's column-origin symbols before a labeled read; fail
      // loudly if they can't be bound rather than mislabeling the result.
      if (wantColumns && !(await ensureColumnOriginAvailable())) {
        // The reason names a filesystem path, and this error reaches the query
        // caller, so it goes to the log and the caller gets the bare fact.
        console.warn(
          `[memory-sqlite] column-origin symbols could not be bound: ` +
            `${columnOriginUnavailableReason()}`,
        );
        throw new Error(
          "sqlite: CFC read labeling needs SQLite column-metadata FFI, but " +
            "@db/sqlite's column-origin symbols could not be bound",
        );
      }
      const disk = this.#diskSources.get(message.space, message.db.id);
      const result = disk
        ? (wantColumns
          ? this.#readPool.queryWithOrigins(
            disk.path,
            message.sql,
            message.params,
          )
          : {
            rows: this.#readPool.query(disk.path, message.sql, message.params),
          })
        : await this.#readCellDb(
          message.space,
          message.db,
          message.sql,
          message.params,
          Engine.resolveScopeKey(message.db.scope, {
            principal: session.principal,
            sessionId: message.sessionId,
          }),
          wantColumns,
        );
      // SQLite reads necessarily await filesystem work. Re-check both the
      // session identity and its current ACL immediately before exposing the
      // rows, so a revoke during that I/O cannot leak a late result.
      if (aclEngine !== undefined) {
        const deny = this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
        if (deny) {
          return respondTypedError<SqliteQueryResult>(message.requestId, deny);
        }
      }
      return {
        type: "response",
        requestId: message.requestId,
        ok: { rows: result.rows, columns: result.columns },
      };
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
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<SqliteRegisterDiskSourceResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      // Maps a server filesystem path into the space — operator surface.
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "OWNER",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "OWNER",
        );
      if (deny) {
        return respondTypedError<SqliteRegisterDiskSourceResult>(
          message.requestId,
          deny,
        );
      }
    }
    try {
      await this.registerDiskSource(
        message.space,
        message.id,
        message.path,
        aclEngine === undefined ? undefined : (resolvedEngine) => {
          const deny = this.#authorizeCurrentSessionWithEngine(
            resolvedEngine,
            message.space,
            message.sessionId,
            session,
            "OWNER",
          );
          if (deny) {
            throw Object.assign(new Error(deny.message), { name: deny.name });
          }
        },
      );
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
      const authContext = connection.sessionOpenAuthContext(message);
      const principal = await this.options.authorizeSessionOpen(
        message,
        authContext,
      );
      connection.consumeSessionOpenChallenge(authContext.challenge);
      const engine = await this.openEngine(message.space);
      const deny = this.#authorizeMessageWithEngine(
        engine,
        message.space,
        principal,
        "READ",
      );
      if (deny) {
        return respondTypedError<SessionOpenResult>(message.requestId, deny);
      }
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
      // A resumed session is registered before catch-up, and catch-up awaits
      // graph evaluation. An ACL commit (or takeover) can remove or replace it
      // during that await, before Connection.receiveOrdered has added its local
      // handle. In active ACL modes, never return catch-up data or let the
      // connection add a ghost handle unless this exact token is still owned
      // by this connection. Off mode preserves the legacy session timing.
      const current = this.#sessions.get(message.space, opened.sessionId);
      if (
        this.isAclActive() &&
        (current?.ownerConnectionId !== connection.id ||
          current.sessionToken !== opened.sessionToken)
      ) {
        return respondTypedError<SessionOpenResult>(
          message.requestId,
          toError(
            "SessionRevokedError",
            "Session was revoked while opening",
          ),
        );
      }
      const nextSessionOpen = connection.issueSessionOpenAuth();
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
          serverSeq: opened.serverSeq,
          caughtUpLocalSeq: opened.caughtUpLocalSeq,
          ...(opened.resumed === true ? { resumed: true } : {}),
          ...(catchup ? { sync: catchup.effect } : {}),
          sessionOpen: nextSessionOpen,
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

  transact(
    message: TransactRequest,
  ): Promise<ResponseMessage<Engine.AppliedCommit>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return Promise.resolve(respondTypedError<Engine.AppliedCommit>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      ));
    }

    return tracer.startActiveSpan(
      "memory.transact",
      async (span): Promise<ResponseMessage<Engine.AppliedCommit>> => {
        span.setAttribute("space.did", message.space);
        if (
          session.principal !== undefined &&
          session.principal !== ANYONE_USER
        ) {
          span.setAttribute("user.did", session.principal);
        }
        if (message.requestId !== undefined) {
          span.setAttribute("request.id", message.requestId);
        }
        if (message.commit.branch !== undefined) {
          span.setAttribute("branch", message.commit.branch);
        }
        // (space.did, session.id, commit.local_seq) is the deterministic join
        // to the CLIENT half of this commit (the runner's storage.push span).
        // Unlike request.id — minted per send attempt and re-minted on
        // reconnect resends — localSeq is stable across retries and known
        // before the response, so it also identifies rejected commits.
        if (message.sessionId !== undefined) {
          span.setAttribute("session.id", message.sessionId);
        }
        if (message.commit.localSeq !== undefined) {
          span.setAttribute("commit.local_seq", message.commit.localSeq);
        }
        try {
          const engine = await this.openEngine(message.space);
          // The session may be revoked or replaced while openEngine awaits.
          // Re-check the exact registry object before using the captured
          // principal so an old connection cannot commit after takeover.
          if (
            this.#sessions.get(message.space, message.sessionId) !== session
          ) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              toError("SessionError", "Unknown or replaced session for space"),
            );
          }
          const invalid = this.#validateAclCommit(
            engine,
            message.space,
            session.principal,
            message.commit,
          );
          if (invalid) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              invalid,
            );
          }
          // ACL-document writes change who may access the space — OWNER only.
          const aclTouched = commitTouchesAclDoc(
            message.commit.operations,
            message.space,
          );
          const deny = this.#authorizeMessageWithEngine(
            engine,
            message.space,
            session.principal,
            aclTouched ? "OWNER" : "WRITE",
          );
          if (deny) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              deny,
            );
          }
          // Scheduler ownership is derived from an authenticated principal.
          // An otherwise-authorized anonymous memory session may still commit
          // cell data, but cannot persist scoped scheduler metadata.
          const schedulerStateEnabled = getPersistentSchedulerStateConfig() &&
            session.principal !== undefined;
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
            const previousSnapshots = Engine.listSchedulerActionSnapshots(
              engine,
              {
                branch: message.commit.branch ?? "",
                ownerSpace: message.space,
                pieceId: observation.pieceId,
                processGeneration: observation.processGeneration,
                actionId: observation.actionId,
                applicableExecutionContextKeys: schedulerApplicableContextKeys(
                  session.principal,
                  message.sessionId,
                ),
              },
            ).snapshots;
            previousReadSpaces.set(
              localSeq,
              new Set(
                previousSnapshots.flatMap((
                  snapshot,
                ) => [...this.schedulerObservationReadSpaces(
                  snapshot.observation,
                )]),
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
            { principal: session.principal, sessionId: message.sessionId },
          );
          let commit: Engine.AppliedCommit;
          try {
            commit = tracer.startActiveSpan(
              "memory.commit.persist",
              (persistSpan) => {
                try {
                  return Engine.applyCommit(engine, {
                    sessionId: message.sessionId,
                    space: message.space,
                    principal: session.principal,
                    commit: commitPayload,
                    sqliteAttachments,
                  });
                } finally {
                  persistSpan.end();
                }
              },
            );
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
          if (aclTouched) {
            this.#invalidateAclCapabilities(message.space);
            // Pass the writing session so it isn't sent the terminal revocation
            // before its own transact response (the client treats session/revoked
            // as terminal). It's still dropped from the registry, so a
            // self-deauthorized writer receives no further pushes.
            this.#revokeDeauthorizedSessions(
              engine,
              message.space,
              message.sessionId,
            );
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
          span.setAttribute("commit.seq", commit.seq);
          span.setAttribute(
            "entity.count",
            message.commit.operations.filter((operation) =>
              operation.op !== "sqlite"
            ).length,
          );
          return {
            type: "response",
            requestId: message.requestId,
            ok: commit,
          };
        } catch (error) {
          let retryAfterSeq: number | undefined;
          if (error instanceof Engine.ConflictError) {
            span.setAttribute("ct.conflict", true);
            this.stageConflictRefreshDirtyIds(
              message.space,
              session,
              message.commit,
            );
            const engine = await this.openEngine(message.space);
            retryAfterSeq = Engine.serverSeq(engine);
          }
          const messageText = error instanceof Error
            ? error.message
            : String(error);
          const preconditionError = toPreconditionFailedError(
            error,
            messageText,
          );
          const responseError = preconditionError ? preconditionError : toError(
            error instanceof Engine.ConflictError
              ? "ConflictError"
              : error instanceof Engine.ProtocolError
              ? "ProtocolError"
              // A RowLabelCommitError (Phase 3.c commit-time row-label refusal,
              // sqlite/commit-eval.ts) is TERMINAL: re-running recomputes the
              // identical refused write, so the client must not retry it.
              // Preserve the class name unchanged — the runner classifies by it
              // (storage/rejection.ts `isTerminalRejection`); collapsing it into
              // a generic TransactionError would let the doomed handler burn its
              // retry budget and starve concurrent siblings.
              : error instanceof RowLabelCommitError
              ? "RowLabelCommitError"
              : "TransactionError",
            messageText,
          );
          if (retryAfterSeq !== undefined) {
            responseError.retryAfterSeq = retryAfterSeq;
          }
          span.recordException(
            error instanceof Error ? error : new Error(messageText),
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message: messageText });
          return respondTypedError<Engine.AppliedCommit>(
            message.requestId,
            responseError,
          );
        } finally {
          span.end();
        }
      },
    );
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
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<GraphQueryResult>(message.requestId, deny);
      }
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
          aclEngine,
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

  async listEntityIds(
    message: EntityIdListRequest,
  ): Promise<ResponseMessage<EntityIdListResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<EntityIdListResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const deny = this.#authorizeCurrentSessionWithEngine(
        engine,
        message.space,
        message.sessionId,
        session,
        "READ",
      );
      if (deny) {
        return respondTypedError<EntityIdListResult>(message.requestId, deny);
      }

      const serverSeq = Engine.serverSeq(engine);
      const entitySetSeq = Engine.entitySetSeq(engine);
      if (
        message.expectedEntitySetSeq !== undefined &&
        message.expectedEntitySetSeq !== entitySetSeq
      ) {
        return respondTypedError<EntityIdListResult>(
          message.requestId,
          toError(
            "SnapshotChangedError",
            `entity identifier snapshot changed from entity-set sequence ${message.expectedEntitySetSeq} to ${entitySetSeq}`,
          ),
        );
      }

      if (
        message.after === undefined && message.limit === undefined &&
        message.expectedEntitySetSeq === undefined
      ) {
        const ids = Engine.listEntityIdPage(engine, {
          limit: MAX_ENTITY_ID_PAGE_SIZE + 1,
        });
        const bounded = takeBoundedEntityIdPage(
          ids,
          MAX_ENTITY_ID_PAGE_SIZE,
        );
        if (bounded.hasMore) {
          return respondTypedError<EntityIdListResult>(
            message.requestId,
            toError(
              "ProtocolError",
              `unpaginated entity identifier listing exceeds the ${MAX_ENTITY_ID_PAGE_SIZE}-entry or ${MAX_ENTITY_ID_PAGE_BYTES}-byte page bound; use pagination`,
            ),
          );
        }
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq,
            entitySetSeq,
            ids: bounded.ids,
          },
        };
      }

      const limit = Math.min(
        message.limit ?? MAX_ENTITY_ID_PAGE_SIZE,
        MAX_ENTITY_ID_PAGE_SIZE,
      );
      const rows = Engine.listEntityIdPage(engine, {
        after: message.after,
        limit: limit + 1,
      });
      const bounded = takeBoundedEntityIdPage(rows, limit);
      const nextAfter = bounded.hasMore ? bounded.ids.at(-1) : undefined;

      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          entitySetSeq,
          ids: bounded.ids,
          ...(nextAfter === undefined ? {} : { nextAfter }),
        },
      };
    } catch (error) {
      return respondTypedError<EntityIdListResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async entityIdExists(
    message: EntityIdLookupRequest,
  ): Promise<ResponseMessage<EntityIdLookupResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<EntityIdLookupResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.openEngine(message.space);
      const deny = this.#authorizeCurrentSessionWithEngine(
        engine,
        message.space,
        message.sessionId,
        session,
        "READ",
      );
      if (deny) {
        return respondTypedError<EntityIdLookupResult>(message.requestId, deny);
      }

      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          exists: Engine.entityIdExists(engine, message.id),
        },
      };
    } catch (error) {
      return respondTypedError<EntityIdLookupResult>(
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
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<SchedulerSnapshotListResult>(
          message.requestId,
          deny,
        );
      }
    }

    try {
      const engine = aclEngine ?? await this.openEngine(message.space);
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
        {
          ...message.query,
          applicableExecutionContextKeys: schedulerApplicableContextKeys(
            session.principal,
            message.sessionId,
          ),
        },
      );
      const snapshots = page.snapshots.map((snapshot) => ({
        observationId: snapshot.observationId,
        commitSeq: snapshot.commitSeq,
        observedAtSeq: snapshot.observedAtSeq,
        executionContextKey: snapshot.executionContextKey,
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
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<WatchSetResult>(message.requestId, deny);
      }
    }

    try {
      const { serverSeq, graphs, entities } = await this.evaluateWatchSet(
        message.space,
        message.watches,
        aclEngine,
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
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<WatchAddResult>(message.requestId, deny);
      }
    }

    try {
      const startedAt = performance.now();
      const engine = aclEngine ?? await this.openEngine(message.space);
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

  syncSessionForConnection(
    space: string,
    sessionId: string,
    dirtyIds?: ReadonlySet<string>,
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
    options?: { adoptionObservations?: boolean },
  ): Promise<SessionEffectMessage | null> {
    const session = this.#sessions.get(space, sessionId);
    if (session === null) {
      return Promise.resolve(null);
    }
    return tracer.startActiveSpan(
      "memory.subscriber.sync",
      async (span): Promise<SessionEffectMessage | null> => {
        span.setAttribute("space.did", space);
        if (
          session.principal !== undefined &&
          session.principal !== ANYONE_USER
        ) {
          span.setAttribute("user.did", session.principal);
        }
        span.setAttribute("watch.count", session.watches.length);
        try {
          const pendingCaughtUpLocalSeq = session.pendingCaughtUpLocalSeq;
          const hasPendingCatchUp =
            pendingCaughtUpLocalSeq > session.caughtUpLocalSeq;
          const finishCatchUp = async (
            sync: SessionSync,
          ): Promise<SessionEffectMessage> => {
            if (hasPendingCatchUp) {
              session.caughtUpLocalSeq = Math.max(
                session.caughtUpLocalSeq,
                pendingCaughtUpLocalSeq,
              );
              if (session.pendingCaughtUpLocalSeq <= session.caughtUpLocalSeq) {
                session.pendingCaughtUpLocalSeq = 0;
              }
              sync.caughtUpLocalSeq = session.caughtUpLocalSeq;
            }
            await this.attachAdoptionObservations(
              space,
              sessionId,
              sync,
              options,
            );
            return {
              type: "session/effect",
              space,
              sessionId,
              effect: sync,
            };
          };
          const emptyCatchUp = async (
            fromSeq = session.lastSyncedSeq,
            toSeq?: number,
          ): Promise<SessionEffectMessage | null> => {
            const serverSeq = toSeq ??
              Engine.serverSeq(await this.openEngine(space));
            const mayCarryAdoption = options?.adoptionObservations === true &&
              session.watches.length > 0 &&
              serverSeq > fromSeq;
            if (!hasPendingCatchUp && !mayCarryAdoption) {
              return null;
            }
            session.lastSyncedSeq = Math.max(session.lastSyncedSeq, serverSeq);
            const sync: SessionSync = {
              type: "sync",
              fromSeq,
              toSeq: serverSeq,
              upserts: [],
              removes: [],
            };
            const message = await finishCatchUp(sync);
            // Do not manufacture an empty push solely to probe the adoption
            // window. When a row is present, however, the sync must cross the
            // wire even without a document diff or the session watermark can
            // advance past that row forever.
            if (
              !hasPendingCatchUp &&
              (sync.observations?.length ?? 0) === 0
            ) {
              return null;
            }
            return message;
          };
          if (session.watches.length === 0) {
            return await emptyCatchUp();
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
            span.setAttribute("ct.touched", touched);
            if (!touched) {
              return await emptyCatchUp();
            }

            const engine = await this.openEngine(space);
            const fromSeq = session.lastSyncedSeq;
            const updates = new Map<string, SessionCacheEntry>();

            for (const graph of session.graphs.values()) {
              const refreshed = tracer.startActiveSpan(
                "memory.watch.refresh",
                (watchSpan) => {
                  watchSpan.setAttribute("space.did", space);
                  try {
                    return refreshTrackedGraph(
                      space,
                      engine,
                      graph,
                      dirtyIds,
                    );
                  } finally {
                    watchSpan.end();
                  }
                },
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
              return await emptyCatchUp();
            }

            const upserts: SessionCacheEntry[] = [];
            for (const [key, entry] of updates) {
              const previous = session.entities.get(key);
              session.entities.set(key, entry);
              session.trackedIds.add(
                toDirtyKey(entry.id, declaredScope(entry.scope)),
              );
              if (!sameSnapshot(previous, entry)) {
                const dirtyKey = toDirtyKey(
                  entry.id,
                  declaredScope(entry.scope),
                );
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
            if (upserts.length === 0) {
              // The watched set was re-evaluated current as of toSeq even though it
              // produced no net upserts; advance the watermark so a later default
              // fromSeq is not stale. emptyCatchUp receives the original fromSeq
              // explicitly, so this does not mutate the bounds of this sync (the
              // Cubic fix keeps fromSeq pinned to the pre-refresh value).
              session.lastSyncedSeq = Math.max(session.lastSyncedSeq, toSeq);
              return await emptyCatchUp(fromSeq, toSeq);
            }
            session.lastSyncedSeq = toSeq;
            recordSlowQueryDuration("session.watch.refresh", space, startedAt, {
              watches: session.watches.length,
            });
            return await finishCatchUp({
              type: "sync",
              fromSeq,
              toSeq,
              upserts: upserts.toSorted((left, right) =>
                left.branch.localeCompare(right.branch) ||
                left.id.localeCompare(right.id)
              ),
              removes: [],
            });
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
            return await emptyCatchUp(sync.fromSeq, sync.toSeq);
          }
          return await finishCatchUp(sync);
        } finally {
          span.end();
        }
      },
    );
  }

  // Attach the sync window's scheduler observation rows so the receiving
  // client can ADOPT other clients' committed action runs instead of
  // re-running them (incremental-observation-adoption.md §4). Only for
  // connections that negotiated persistentSchedulerState, on any advancing
  // sync window (including an empty catch-up), and echo-suppressed by the
  // observation writer session.
  // Adoption is an optimization: a failed observation query must never fail
  // the sync push.
  private async attachAdoptionObservations(
    space: string,
    sessionId: string,
    sync: SessionSync,
    options?: { adoptionObservations?: boolean },
  ): Promise<void> {
    if (
      options?.adoptionObservations !== true ||
      !getPersistentSchedulerStateConfig() ||
      sync.toSeq <= sync.fromSeq
    ) {
      return;
    }
    try {
      // Watch-scope the rows exactly like the doc diff: a row whose read set
      // reaches outside this session's tracked docs must not ship. The
      // receiver could never verify those reads current (their changes are
      // never pushed to it), and adopting such a row would skip the very run
      // that loads and subscribes them — a permanently stale action. Dropping
      // the row also keeps observation metadata (doc ids, fingerprints)
      // inside the watch boundary that scopes every other byte of this push.
      const session = this.#sessions.get(space, sessionId);
      if (session === null) return;
      const trackedIds = session.trackedIds;
      const adoptionSurfaceTracked = (
        observation: Engine.SchedulerActionObservation,
      ): boolean =>
        [
          ...(observation.reads ?? []),
          ...(observation.shallowReads ?? []),
          ...(observation.actualChangedWrites ?? []),
          ...(observation.currentKnownWrites ?? []),
        ].every((address) =>
          address.space === space &&
          trackedIds.has(toDirtyKey(address.id, declaredScope(address.scope)))
        );
      const engine = await this.openEngine(space);
      const page = Engine.listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: sync.fromSeq,
        throughCommitSeq: sync.toSeq,
        applicableExecutionContextKeys: schedulerApplicableContextKeys(
          session.principal,
          sessionId,
        ),
      });
      const receiverWriterSessionKey = Engine.resolveCommitSessionKey(
        sessionId,
        session.principal,
      );
      const observations = page.snapshots
        .filter((snapshot) =>
          snapshot.writerSessionId !== receiverWriterSessionKey &&
          adoptionSurfaceTracked(snapshot.observation)
        )
        .map((snapshot) => ({
          observationId: snapshot.observationId,
          commitSeq: snapshot.commitSeq,
          observedAtSeq: snapshot.observedAtSeq,
          executionContextKey: snapshot.executionContextKey,
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
      // A window with more rows than one page (nextCursor set) sends the
      // first page only; receivers degrade to running the remainder.
      if (observations.length > 0) {
        sync.observations = observations;
      }
    } catch (error) {
      console.warn(
        "attachAdoptionObservations failed; sync pushed without observations",
        error,
      );
    }
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
    session: SessionState,
    commit: ClientCommit,
  ): void {
    session.pendingCaughtUpLocalSeq = Math.max(
      session.pendingCaughtUpLocalSeq,
      commit.localSeq,
    );
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
        // Fan-out is a scheduled/batched timer decoupled from transact, so it
        // must be its own root span. `root: true` makes that explicit — the
        // context manager propagates the active context into timer callbacks,
        // so without it this span could parent under whichever memory.transact
        // happened to schedule the refresh.
        await tracer.startActiveSpan(
          "memory.fanout",
          { root: true },
          async (span) => {
            span.setAttribute("space.did", space);
            span.setAttribute("subscriber.count", this.#connections.size);
            span.setAttribute("dirty.count", dirtyIds?.size ?? 0);
            try {
              for (const connection of this.#connections.values()) {
                await connection.refreshDirty(space, dirtyIds, dirtyOrigins);
              }
            } finally {
              span.end();
            }
          },
        );
      }

      if (initial !== undefined) {
        return;
      }
    }
  }

  respond(payload: string): Promise<string | null> {
    const parsed = parseClientMessage(payload);
    if (parsed?.type === "hello") {
      const response = respondToHello(parsed);
      if (response.type !== "hello.ok") {
        return Promise.resolve(encodeMemoryBoundary(response));
      }
      return Promise.resolve(encodeMemoryBoundary({
        type: "response",
        requestId: "handshake",
        error: toError(
          "ProtocolError",
          "memory Server.respond cannot issue session.open authentication metadata",
        ),
      }));
    }
    return Promise.resolve(null);
  }

  private async mirrorSchedulerObservation(
    ownerSpace: string,
    observation: Engine.SchedulerActionObservation,
    originExecutionContextKey: SchedulerExecutionContextKey,
    commit: Engine.AppliedCommit,
    previousReadSpaces: ReadonlySet<string>,
    session: SessionState | undefined,
  ): Promise<void> {
    if (session?.principal === undefined) {
      return;
    }
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
      Engine.upsertMirroredSchedulerObservation(engine, {
        branch: commit.branch,
        ownerSpace,
        observedAtSeq: commit.seq,
        scopeContext: {
          principal: session.principal,
          sessionId: session.id,
        },
        writerSessionId: Engine.resolveCommitSessionKey(
          session.id,
          session.principal,
        ),
        originExecutionContextKey,
        observation,
      });
    }
  }

  private runPostCommitSchedulerSideEffects(
    ownerSpace: string,
    commit: Engine.AppliedCommit,
    observations: readonly CommitSchedulerObservation[],
    previousReadSpaces: ReadonlyMap<number, ReadonlySet<string>>,
    session: SessionState | undefined,
  ): Promise<void> {
    const run = () =>
      this.applyPostCommitSchedulerSideEffects(
        ownerSpace,
        commit,
        observations,
        previousReadSpaces,
        session,
      );
    const previous = this.#schedulerSideEffectsByOwnerSpace.get(ownerSpace);
    const queued = previous?.then(run, run) ?? run();
    const tracked = queued.finally(() => {
      if (this.#schedulerSideEffectsByOwnerSpace.get(ownerSpace) === tracked) {
        this.#schedulerSideEffectsByOwnerSpace.delete(ownerSpace);
      }
    });
    this.#schedulerSideEffectsByOwnerSpace.set(ownerSpace, tracked);
    return tracked;
  }

  private async applyPostCommitSchedulerSideEffects(
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
      const observationResults = commit.schedulerObservationResults
        ? new Map(
          commit.schedulerObservationResults.map((result) => [
            result.localSeq,
            result,
          ]),
        )
        : undefined;
      // A semantic commit replay can outlive an observation that was removed by
      // later context narrowing. There is no active owner context to mirror in
      // that case; replaying the stale payload would resurrect invalid state.
      if (observations.length > 0 && observationResults === undefined) {
        return;
      }
      for (const { localSeq, observation } of observations) {
        const result = observationResults?.get(localSeq);
        if (result === undefined) {
          throw new Error(
            `scheduler observation ${localSeq} missing owner result`,
          );
        }
        if (result.status === "dropped") {
          continue;
        }
        // A kept replay remains idempotently acknowledged even after a later
        // observation replaced or narrowed its owner snapshot. The engine omits
        // the effective context in that case so this stale payload cannot
        // recreate or roll back a mirror.
        if (result.executionContextKey === undefined) {
          continue;
        }
        await this.mirrorSchedulerObservation(
          ownerSpace,
          observation,
          result.executionContextKey,
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

const isSchedulerExecutionContextKey = (
  value: unknown,
): value is SchedulerExecutionContextKey =>
  value === "space" ||
  (typeof value === "string" &&
    (/^user:[^:]+$/.test(value) || /^session:[^:]+:[^:]+$/.test(value)));

const parseSchedulerSnapshotQuery = (
  value: Record<string, unknown>,
): SchedulerActionSnapshotQuery | undefined => {
  // Context is selected only from the authenticated server session. A cursor
  // may carry the last returned context for stable continuation, but the query
  // itself has no arbitrary context selector.
  if (
    "executionContextKey" in value ||
    "execution_context_key" in value ||
    (value.branch !== undefined && typeof value.branch !== "string") ||
    (value.ownerSpace !== undefined && typeof value.ownerSpace !== "string") ||
    (value.pieceId !== undefined && typeof value.pieceId !== "string") ||
    (value.processGeneration !== undefined &&
      !isNonNegativeInteger(value.processGeneration)) ||
    (value.actionId !== undefined && typeof value.actionId !== "string") ||
    (value.sinceCommitSeq !== undefined &&
      !isNonNegativeInteger(value.sinceCommitSeq)) ||
    (value.throughCommitSeq !== undefined &&
      !isNonNegativeInteger(value.throughCommitSeq)) ||
    (value.limit !== undefined && !isNonNegativeInteger(value.limit))
  ) {
    return undefined;
  }
  let cursor: SchedulerActionSnapshotQuery["cursor"];
  if (value.cursor !== undefined) {
    if (
      !isRecord(value.cursor) ||
      (value.cursor.ownerSpace !== undefined &&
        typeof value.cursor.ownerSpace !== "string") ||
      typeof value.cursor.pieceId !== "string" ||
      !isNonNegativeInteger(value.cursor.processGeneration) ||
      typeof value.cursor.actionId !== "string" ||
      !isSchedulerExecutionContextKey(value.cursor.executionContextKey)
    ) {
      return undefined;
    }
    cursor = {
      ...(value.cursor.ownerSpace !== undefined
        ? { ownerSpace: value.cursor.ownerSpace }
        : {}),
      pieceId: value.cursor.pieceId,
      processGeneration: value.cursor.processGeneration,
      actionId: value.cursor.actionId,
      executionContextKey: value.cursor.executionContextKey,
    };
  }
  return {
    ...(value.branch !== undefined ? { branch: value.branch as string } : {}),
    ...(value.ownerSpace !== undefined
      ? { ownerSpace: value.ownerSpace as string }
      : {}),
    ...(value.pieceId !== undefined
      ? { pieceId: value.pieceId as string }
      : {}),
    ...(value.processGeneration !== undefined
      ? { processGeneration: value.processGeneration as number }
      : {}),
    ...(value.actionId !== undefined
      ? { actionId: value.actionId as string }
      : {}),
    ...(value.sinceCommitSeq !== undefined
      ? { sinceCommitSeq: value.sinceCommitSeq as number }
      : {}),
    ...(value.throughCommitSeq !== undefined
      ? { throughCommitSeq: value.throughCommitSeq as number }
      : {}),
    ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
};

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
    parsed.type === "entity-id.list" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    (parsed.after === undefined ||
      (typeof parsed.after === "string" &&
        entityIdUtf8Bytes(parsed.after) <= MAX_ENTITY_ID_BYTES)) &&
    (parsed.limit === undefined ||
      (isNonNegativeInteger(parsed.limit) && parsed.limit > 0)) &&
    (
      (parsed.after === undefined &&
        parsed.expectedEntitySetSeq === undefined) ||
      (typeof parsed.after === "string" &&
        isNonNegativeInteger(parsed.expectedEntitySetSeq))
    )
  ) {
    const base = {
      type: "entity-id.list",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    } as const;
    if (parsed.after === undefined) return base;
    return {
      ...base,
      after: parsed.after,
      expectedEntitySetSeq: parsed.expectedEntitySetSeq as number,
    };
  }

  if (
    parsed.type === "entity-id.exists" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.id === "string" &&
    entityIdUtf8Bytes(parsed.id) <= MAX_ENTITY_ID_BYTES
  ) {
    return {
      type: "entity-id.exists",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      id: parsed.id as EntityIdLookupRequest["id"],
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
        Object.keys(parsed.db.tables).length <= 256)) &&
    (parsed.db.scope === undefined || parsed.db.scope === "space" ||
      parsed.db.scope === "user" || parsed.db.scope === "session")
  ) {
    const db = {
      id: parsed.db.id,
      tables: isRecord(parsed.db.tables) ? parsed.db.tables : undefined,
      scope: parsed.db.scope as CellScope | undefined,
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
    const query = parseSchedulerSnapshotQuery(parsed.query);
    if (query === undefined) return null;
    return {
      type: "scheduler.snapshot.list",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      query,
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
