import * as FS from "@std/fs";
import * as Path from "@std/path";
import { resolveSpaceStoreUrl } from "./storage-path.ts";
import {
  type CrossSpaceDeliveryContext,
  CrossSpaceHostRouter,
  type CrossSpaceLaneDemand,
  type CrossSpaceMessage,
  type CrossSpacePointReadAddress,
  CrossSpaceProtocolError,
  type CrossSpaceTransport,
  type ForeignAuthorizationEpochBump,
  type ForeignAuthorizationEpochQuery,
  type ForeignAuthorizationEpochQueryResult,
  type ForeignAuthorizationEpochStamp,
  type ForeignDirtyMark,
  type ForeignObservationMirror,
  type ForeignPointRead,
  type ForeignPointReadResult,
  type ForeignReaderIdentity,
  type ForeignReadersSubscribe,
  type ForeignReadersSubscribeApplied,
  type ForeignReadersUnsubscribe,
  type ForeignStaleReaders,
  InProcessCrossSpaceTransport,
} from "./cross-space.ts";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ActionSettlement,
  type BranchName,
  canonicalActionClaimKey,
  canonicalSchedulerPieceIdForDemandRoot,
  type CellScope,
  type ClientCommit,
  type ClientMessage,
  dbNeedsColumnProvenance,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  type DocSetWatchSpec,
  type DocsReadExecutionClaimRef,
  type DocsReadRequest,
  type DocsReadResult,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  type EntitySnapshot,
  type ExecutionClaim,
  executionClaimIncarnationKey,
  type ExecutionControlEvent,
  type ExecutionDemandSetRequest,
  type ExecutionDemandSetResult,
  type ExecutionLease,
  getMemoryProtocolFlags,
  getPersistentSchedulerStateConfig,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type GraphQueryTrigger,
  type HelloMessage,
  type InputBasisComponent,
  inputBasisComponentForSpace,
  type LegacyBackgroundExclusion,
  type LegacyBackgroundExclusionAcquireRequest,
  type LegacyBackgroundExclusionReleaseRequest,
  type LegacyBackgroundExclusionReleaseResult,
  type LegacyBackgroundExclusionRenewRequest,
  type LegacyBackgroundExclusionStatus,
  type LegacyBackgroundExclusionStatusResult,
  type MemoryProtocolFlags,
  type Operation,
  parseMemoryProtocolFlags,
  type ProvenanceInputBasisComponent,
  type ResponseMessage,
  type SchedulerActionSnapshotQuery,
  type SchedulerExecutionContextKey,
  type SchedulerSnapshotListRequest,
  type SchedulerSnapshotListResult,
  type SchedulerWriterListRequest,
  type SchedulerWritersForTargetsQuery,
  type SchedulerWritersForTargetsResult,
  type ServerMessage,
  serverPrimaryExecutionClaimRankAtLeast,
  serverPrimaryExecutionCrossSpaceReadsEnabled,
  serverPrimaryExecutionGraphRetirementAdmits,
  type SessionAckRequest,
  type SessionAckResult,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenChallenge,
  type SessionOpenRequest,
  type SessionOpenResult,
  type SessionRevokedMessage,
  type SessionSync,
  type SessionToken,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryRequest,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceRequest,
  type SqliteRegisterDiskSourceResult,
  type SqliteResultColumn,
  toDocumentPath,
  toInputBasisSeq,
  type TransactRequest,
  type V2Error,
  type WatchAddRequest,
  type WatchAddResult,
  type WatchSetRequest,
  type WatchSetResult,
  type WatchSpec,
  type WireMemoryProtocolFlags,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import * as Engine from "./engine.ts";
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
import { ensureColumnOriginAvailable } from "./sqlite/column-origin.ts";
import {
  cloneTrackedGraphState,
  extendTrackedGraph,
  fromDirtyKey,
  isGraphQueryCoveredByState,
  queryGraph,
  type QueryGraphReuseContext,
  type QueryTraversalStats,
  refreshTrackedGraph,
  toDirtyKey,
  toDocKey,
  type TrackedGraphState,
  trackGraph,
} from "./query.ts";
import { respondToHello } from "./handshake.ts";
import { compressServerMessageSchemas } from "./sync-schema-table.ts";
import {
  buildDiffSync,
  buildFullSync,
  cacheKeyForEntity,
  type DocSetMember,
  docSetMemberKey,
  groupedQueries,
  isDocSetWatchSpec,
  isEmptySync,
  isGraphWatchSpec,
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
import { getLogger } from "@commonfabric/utils/logger";

export { SessionRegistry } from "./session-registry.ts";

// Global OTel API tracer. Interface-only and inert when no provider is
// registered, so this is a no-op unless the host process (toolshed) has an
// OTLP SDK installed. Spans created here are purely additive observability and
// do not affect write/fan-out behavior.
const tracer = trace.getTracer("memory-server", "1.0.0");
const executionControlLogger = getLogger("execution.control", {
  enabled: false,
});

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
const MIN_REFRESH_QUEUE_DRAIN_WAIT_MS = 500;
const SLOW_QUERY_THRESHOLD_MS = 100;
const SLOW_QUERY_BUFFER_SIZE = 100;
const DEFAULT_SESSION_OPEN_CHALLENGE_TTL_SECONDS = 300;
const SESSION_OPEN_CHALLENGE_BYTES = 32;
const MAX_PENDING_EXECUTION_INVALIDATION_TIMINGS = 10_000;

type ExecutionInvalidationActionKey = {
  branch: BranchName;
  space: string;
  pieceId: string;
  actionId: string;
  contextKey: SchedulerExecutionContextKey;
};

const executionInvalidationActionKey = (
  key: ExecutionInvalidationActionKey,
): string =>
  JSON.stringify([
    key.branch,
    key.space,
    key.pieceId,
    key.actionId,
    key.contextKey,
  ]);

const executionInvalidationTimingKey = (
  key: ExecutionInvalidationActionKey,
  sourceSeq: number,
): string => `${executionInvalidationActionKey(key)}\0${sourceSeq}`;

// SQLite resource caps (mirror the `sqlite.query` wire-parse caps; also applied
// to the folded-write path, which is parsed loosely as part of a `transact`).
const MAX_SQLITE_SQL_LENGTH = 100_000;
const MAX_SQLITE_TABLES = 256;

// Memory v2 wire values may omit scope for default-space entries; storage and
// watch keys need an explicit declared scope.
const declaredScope = (scope: CellScope | undefined): CellScope =>
  scope ?? "space";

// --- F3 doc-set membership module helpers ---

/** Source-id namespace for watch-sourced membership. The FA8 replace-semantics
 * sweep (FB6) re-justifies exactly this namespace against a new watch set;
 * future non-watch sources (served observations) are untouched by it. */
const DOC_SET_WATCH_SOURCE_PREFIX = "watch:";

/** One resolved doc-set member registration, staged before any session
 * mutation (FB24): scope resolution can throw, so it runs to completion
 * BEFORE the watch or any member is installed. */
type StagedDocSetMember = {
  source: string;
  branch: BranchName;
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  key: string;
};

/** Resolve a set of membership keys to their live member records. */
const seedMembers = (
  session: { docSetMembers: ReadonlyMap<string, DocSetMember> },
  keys: Iterable<string>,
): DocSetMember[] => {
  const members: DocSetMember[] = [];
  for (const key of keys) {
    const member = session.docSetMembers.get(key);
    if (member !== undefined) members.push(member);
  }
  return members;
};

/** Fold doc-set member deltas into an existing sync's upserts, keeping the
 * frame a single ordered emission (FA1: one emission point per session per
 * wave). Members and graph docs never collide on identity — a doc covered by
 * both surfaces is deduped by the resolved-scope-key upsert key downstream. */
const appendMemberUpserts = (
  sync: SessionSync,
  memberUpserts: readonly SessionCacheEntry[],
): void => {
  if (memberUpserts.length === 0) return;
  const seen = new Set(
    sync.upserts.map((upsert) =>
      `${upsert.branch}\0${upsert.scopeKey ?? upsert.scope}\0${upsert.id}`
    ),
  );
  for (const upsert of memberUpserts) {
    const key = `${upsert.branch}\0${
      upsert.scopeKey ?? upsert.scope
    }\0${upsert.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sync.upserts.push(upsert);
  }
  sync.upserts.sort((left, right) =>
    left.branch.localeCompare(right.branch) ||
    left.id.localeCompare(right.id)
  );
};

/** FW1 (FB1, FA3 make-before-break): never emit a remove for a doc that is a
 * current doc-set member of this session. A doc moving from graph tracking to
 * membership (the F4b demotion) — or leaving a graph closure while membership
 * still holds it — is delivered once, in this frame, by the member path; a
 * remove would evict the exact instance membership keeps serving (the
 * client's same-frame remove-wins rule makes that destructive). Docs in
 * neither the next graph surface nor the membership pass through as genuine
 * surface-shrink removes. Membership shrink itself never emits removes (FA8);
 * document deletion stays a deleted-upsert. */
const suppressDocSetMemberRemoves = (
  sync: SessionSync,
  members: ReadonlyMap<string, DocSetMember>,
): void => {
  if (members.size === 0 || sync.removes.length === 0) return;
  sync.removes = sync.removes.filter((remove) =>
    !members.has(
      docSetMemberKey(remove.branch, remove.id, remove.scopeKey ?? "space"),
    )
  );
};

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

/** Aggregate traversal work for one server operation (F1 feed observability).
 * Sums the per-call `QueryTraversalStats` that were previously computed and
 * dropped; `calls` counts the evaluations that contributed. */
export interface FeedTraversalOperationStats extends QueryTraversalStats {
  calls: number;
}

const createFeedTraversalOperationStats = (): FeedTraversalOperationStats => ({
  calls: 0,
  managerReads: 0,
  coveredSelectorSkips: 0,
  schemaTraversals: 0,
  pointerTraversals: 0,
  arrayTraversals: 0,
  objectTraversals: 0,
  dagTraversals: 0,
  getDocAtPathCalls: 0,
  schemaMemoHits: 0,
});

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

/**
 * C1.4: the single lane this commit's HOST-RESOLVED claims assert, handed to
 * the engine as `ApplyCommitOptions.actingContext` so host and engine agree
 * on the acting context by construction. Mixed lanes return undefined and
 * are rejected by the engine's lane admission (one commit, one lane); a
 * forged assertion resolves no claim, so the admission fences it before any
 * scoped-state validation.
 */
const executionClaimsActingContext = (
  claims: ReadonlyMap<number, ExecutionClaim> | undefined,
): SchedulerExecutionContextKey | undefined => {
  if (claims === undefined) return undefined;
  let lane: SchedulerExecutionContextKey | undefined;
  for (const claim of claims.values()) {
    if (lane === undefined) lane = claim.contextKey;
    else if (lane !== claim.contextKey) return undefined;
  }
  return lane;
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

/** C1.4b: constant-shape lane-read rejection — the C1.3 fence-cause
 * vocabulary, byte-identical for a dead and an absent grant, never varying
 * with scoped state. */
const laneReadRejection = (): V2Error =>
  toError(
    "ExecutionLeaseFenceError",
    "lane-generation-stale: execution lane grant is fenced or superseded",
  );

/**
 * C3.4/C3A4: constant-shape rejection for a foreign point read whose
 * acting authority is not LIVE home-side — the read-side mirror of the
 * commit fence's `claim-not-live`/`lane-generation-stale` causes. ONE
 * constant for the whole read-authority class, deliberately: a released
 * or rotated lease, a revoked/expired claim, and a drained lane grant
 * (user or session) all reject byte-identically, so no caller can use
 * the shape as an oracle for WHICH authority died (the C1.3 constancy
 * discipline; the commit fence keeps its two distinguishable causes —
 * they are host-stat diagnostics on a path that already holds the
 * authority objects). Thrown as the engine's `ExecutionLeaseFenceError`
 * so the family is literal, with fenceCause `claim-not-live`.
 */
const foreignReadAuthorityRejection = (): Engine.ExecutionLeaseFenceError =>
  new Engine.ExecutionLeaseFenceError(
    "claim-not-live",
    "claim-not-live: foreign point read requires live acting authority " +
      "at the bound generations",
  );

/**
 * C3.4 denied/failed code vocabulary of the foreign-point-read serve
 * arm (the C3.1 result message left the `code` set to this WO). One
 * exported list so C3.6's unservable-code registration and the runner's
 * consumers bind names, not string literals.
 *
 * - `foreign-read-access-denied` — the acting principal lacks READ on
 *   the read space under `#authorizeMessageWithEngine` (the ONLY
 *   authorization denial; matches C3.6's named unservable code).
 * - `foreign-read-scoped-address` — decision #3 (2026-07-17): v1
 *   foreign reads are SPACE-scoped only; a user/session-scoped address
 *   is refused at the send side AND the serve side with this code (see
 *   `answerForeignPointRead` for the v1 scope-resolution rule).
 * - `foreign-read-unhosted` — the addressed space is not hosted by the
 *   answering host (or, home-side, resolvable by no host).
 * - `foreign-read-unavailable` — the read space exists but cannot serve
 *   (genesis-empty seq domain, send/link failure, host shutdown).
 * - `foreign-read-malformed` — the address did not resolve as a
 *   readable document address.
 * - `foreign-read-timeout` — the home host's pending-request timeout
 *   elapsed with no result (fail closed; C3.10b owns link-loss pending
 *   disposition, dated 2026-07-18).
 */
export const FOREIGN_POINT_READ_DENIED_ACCESS = "foreign-read-access-denied";
export const FOREIGN_POINT_READ_SCOPED_ADDRESS = "foreign-read-scoped-address";
export const FOREIGN_POINT_READ_UNHOSTED = "foreign-read-unhosted";
export const FOREIGN_POINT_READ_UNAVAILABLE = "foreign-read-unavailable";
export const FOREIGN_POINT_READ_MALFORMED = "foreign-read-malformed";
export const FOREIGN_POINT_READ_TIMEOUT = "foreign-read-timeout";

/**
 * C3.4: outcome of one executor foreign point read as the home host
 * returns it to the provider channel. `served` carries the read space's
 * stamped covering seq (the read-space seq domain — NEVER merged into
 * home watermarks), the resolved branch (v1: the read space's default
 * branch, decision #4), the document snapshot (null for absent AND
 * deleted — the point-read wire does not distinguish them), and the
 * authorization-epoch stamp for the ACTING principal (C3.2's table,
 * read in the same synchronous engine section as the document — see
 * `answerForeignPointRead`). C3.5's vector input basis consumes
 * (space, seq) — built 2026-07-18: a served result also lands in the
 * host's `#servedForeignReadStamps` ledger, the validation source for
 * Worker-asserted basis stamps; C3.8's apply fence re-validates
 * `authorizationEpoch` by equality (dated 2026-07-18, not built here —
 * the provenance component carries the stamp for it).
 */
export type ExecutorForeignPointReadOutcome =
  | {
    status: "served";
    space: string;
    seq: number;
    branch: BranchName;
    document: EntityDocument | null;
    authorizationEpoch: ForeignAuthorizationEpochStamp;
  }
  | { status: "denied"; code: string }
  | { status: "failed"; code: string };

/**
 * C3.4: the claimed attempt a foreign point read acts under, as the
 * provider channel names it. `space`/`branch` are deliberately absent —
 * the home host derives them from the LEASE the channel is bound to, so
 * a caller cannot point the liveness consult at another lane's claim
 * table entry.
 */
export interface ExecutorForeignPointReadClaimRef {
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: ActionClaimKey["actionKind"];
  implementationFingerprint: string;
  runtimeFingerprint: string;
  leaseGeneration: number;
  claimGeneration: number;
}

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

// C3.2 (2026-07-18): the validity-state type, its classifier, and the
// ACL doc id moved into the engine — the epoch bump inside
// `applyCommitTransaction` computes validity transitions with the SAME
// definition this enforcement path reads, so the two can never drift
// (drift here would under-revoke, the C3A3 class).
type AclState = Engine.AclValidityState;

const aclDocId = Engine.aclDocId;

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

/**
 * F6 delivery-cohort metadata for one refresh wave: dirty key → the RESOLVED
 * scope keys of every revision that dirtied it this wave. The routing layer
 * derives each key's delivery cohort from this set — `space` fans out to every
 * session (today's broadcast, and the fail-open for unattributed producers),
 * `user:<did>` to the principal's interested sessions, `session:<did>:<sid>`
 * to exactly the named live session. Union semantics under wave coalescing:
 * a key dirtied by revisions of several instances carries every instance's
 * scope key, and one unattributed mark widens the key to broadcast — the set
 * only ever widens, never narrows, so a filter miss costs work, not delivery.
 */
type DirtyScopeKeys = ReadonlyMap<string, ReadonlySet<string>>;

/** Broadcast cohort: also the resolved scope key of every space-scoped
 * revision (`Engine.resolveScopeKey` for declared scope `space`). */
const BROADCAST_SCOPE_KEY = "space";

/**
 * F6 per-address scope-key derivation (FA9): the dirty producer derives each
 * key's cohort from the applied revision's RESOLVED `scopeKey` — stamped by
 * the engine under the commit's validated scope context (session, or the
 * C1.4b acting lane for claimed lane commits) — never re-derived from the
 * session or the row key. Revisions and non-sqlite operations are 1:1
 * (`sqlite` ops are never stored as revisions), and one commit resolves every
 * op under a single scope context, so a dirty key maps to one scope key here.
 */
const revisionScopeKeys = (
  commit: Engine.AppliedCommit,
): Map<string, string> => {
  const scopeKeys = new Map<string, string>();
  for (const revision of commit.revisions) {
    scopeKeys.set(
      toDirtyKey(revision.id, declaredScope(revision.scope)),
      revision.scopeKey,
    );
  }
  return scopeKeys;
};

/**
 * Host-only notification emitted after a commit has passed the canonical
 * server transaction path and its scheduler side effects have run. This is
 * deliberately distinct from the dirty-session refresh queue: that queue also
 * carries rejected-commit catch-up and may coalesce several commits.
 */
export interface AcceptedCommitEvent {
  /** Ephemeral per-space host callback order. W0.6 deliberately uses a
   * separate per-logical-session reconnectable feed sequence on the wire. */
  readonly order: number;
  /** Data/adoption window through which this commit is visible. Metadata-only
   *  scheduler observations may reserve a future delivery slot without
   *  advancing the semantic branch head. */
  readonly deliverySeq: number;
  readonly space: string;
  readonly originSessionId?: string;
  readonly branch: BranchName;
  readonly dataSeq: number;
  /** Detached scalar revision metadata; document payloads never enter the
   *  host callback surface. */
  readonly revisions: readonly Readonly<{
    branch: BranchName;
    id: string;
    scope?: CellScope;
    /** RESOLVED scope key of the written instance (C1.4b): per-lane sync
     * frame attribution for the re-keyed Worker replica. */
    scopeKey: string;
    seq: number;
    op: Operation["op"];
  }>[];
  /** Scheduler snapshot rows changed by this accepted transaction, whether by
   *  re-observation or by a semantic write dirtying a reader. */
  readonly schedulerUpdateIds: readonly number[];
  /** Distinct demanded space-context actions made dirty/stale by this commit.
   * Scalar identities only; document and observation payloads stay private to
   * the engine. */
  readonly staleDemandedReaders: readonly Readonly<
    Engine.SchedulerActionState
  >[];
}

export type AcceptedCommitListener = (
  event: AcceptedCommitEvent,
) => void | Promise<void>;

/**
 * C3.3a: a FOREIGN wake — a read-space commit (or a C3A9 window closure
 * at mirror-apply time, or the C3A10 post-ack scan) made home actions
 * with mirrored foreign reads stale. Deliberately NOT an
 * {@link AcceptedCommitEvent}: `readSeq` lives in the READ space's seq
 * domain and must never be compared against, or merged into, any home
 * watermark (`pendingWakeSeq`/`lastSettledSeq` — C3A11). Spurious
 * foreign wakes are safe; missed ones are not. Executor-plane only, like
 * `ForeignStaleReaders` itself (C3A24): no session-delivery leg.
 */
export interface ForeignWakeEvent {
  /** The HOME space whose actions went stale. */
  readonly space: string;
  /** The home branch the stale reader rows live under. */
  readonly branch: BranchName;
  /** The read (committing) space that caused the staleness. */
  readonly readSpace: string;
  /**
   * READ-space seq domain: the causing commit's seq for a notice-driven
   * wake; the last APPLIED foreign-dirt seq for a scan-driven one.
   * Diagnostic only — never a home-domain comparand.
   */
  readonly readSeq: number;
  /** Which leg produced the wake (notice = live path; scan = C3A10
   * post-ack replay of the durable dirt ledger). */
  readonly origin: "notice" | "resubscribe-scan";
  /** Stale home actions at the subscription's lane granularity. Their
   * owner space is `space`; scalar identities only. */
  readonly staleForeignReaders: readonly Readonly<{
    branch: BranchName;
    pieceId: string;
    processGeneration: number;
    actionId: string;
    executionContextKey: SchedulerExecutionContextKey;
  }>[];
}

export type ForeignWakeListener = (
  event: ForeignWakeEvent,
) => void | Promise<void>;

export interface AuthenticatedExecutionDemand {
  readonly space: string;
  readonly branch: BranchName;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly principal: string;
  readonly pieces: readonly string[];
  /** Whether the demanding session negotiated context-lattice-claims-v1 on
   * its current attach (C1.8/A24). The pool may aggregate a principal's
   * demand into a user lane only from negotiating sessions; the field is
   * additive so non-lane consumers observe an unchanged row shape. */
  readonly negotiatesContextLatticeClaims: boolean;
}

export interface ExecutionDemandSnapshot {
  readonly space: string;
  readonly branch: BranchName;
  /** Monotonic host-local publication order across all demand slots. */
  readonly order: number;
  readonly demands: readonly AuthenticatedExecutionDemand[];
}

export type ExecutionDemandListener = (
  snapshot: ExecutionDemandSnapshot,
) => void | Promise<void>;

type ExecutionProtocolCapabilities = Pick<
  MemoryProtocolFlags,
  | "serverPrimaryExecutionV1"
  | "serverPrimaryExecutionClaimRoutingV1"
  | "serverPrimaryExecutionBuiltinPassivityV1"
>;

const missesRequiredExecutionCapability = (
  required: ExecutionProtocolCapabilities,
  actual: ExecutionProtocolCapabilities,
): boolean =>
  (required.serverPrimaryExecutionV1 &&
    !actual.serverPrimaryExecutionV1) ||
  (required.serverPrimaryExecutionClaimRoutingV1 &&
    !actual.serverPrimaryExecutionClaimRoutingV1) ||
  (required.serverPrimaryExecutionBuiltinPassivityV1 &&
    !actual.serverPrimaryExecutionBuiltinPassivityV1);

const requiredExecutionCapabilityNames = (
  required: ExecutionProtocolCapabilities,
): string =>
  [
    required.serverPrimaryExecutionV1
      ? "server-primary-execution-v1"
      : undefined,
    required.serverPrimaryExecutionClaimRoutingV1
      ? "claim-routing-v1"
      : undefined,
    required.serverPrimaryExecutionBuiltinPassivityV1
      ? "builtin-passivity-v1"
      : undefined,
  ].filter((name): name is string => name !== undefined).join(", ");

const executionDemandKey = (
  connectionId: string,
  space: string,
  sessionId: string,
  branch: BranchName,
): string => encodeMemoryBoundary([connectionId, space, sessionId, branch]);

const executionLeaseKey = (space: string, branch: BranchName): string =>
  encodeMemoryBoundary([space, branch]);

const executionLeaseHandleBrand = Symbol("execution-lease-handle");

/**
 * Host-only authority for one lease generation. The serializable fields are a
 * snapshot of the durable row; the exact sponsor session, token, and demand
 * registration remain private Server state keyed by object identity.
 */
export interface ExecutionLeaseHandle extends ExecutionLease {
  readonly [executionLeaseHandleBrand]: true;
}

type OwnedExecutionLease = {
  handle: ExecutionLeaseHandle;
  readonly sponsorConnectionId: string;
  readonly sponsorSessionId: string;
  readonly sponsorSessionToken: SessionToken;
  readonly firstDemandOrder: number;
  readonly claimGenerations: Map<string, number>;
  drainRequested: boolean;
};

type ExecutionClaimInput = ActionClaimKey;

/**
 * C3.6: host-side issuance options for
 * {@link Server.setExecutionClaim}/{@link Server.trySetExecutionClaim} that
 * deliberately do NOT participate in the client/server shared action identity
 * (kept OUT of {@link ExecutionClaimInput} = {@link ActionClaimKey}). Today it
 * carries only the candidate executor's discovered foreign-read surface; the
 * host canonicalizes it ({@link normalizeCrossSpaceReadSpaces}) and, under the
 * cross-space-read stage, binds the acting principal's foreign READ per space
 * before recording the resulting `crossSpaceReadSpaces` on the claim. Absent
 * (or an empty surface) keeps issuance byte-identical to pre-C3.6.
 */
type ExecutionClaimIssueOptions = {
  /**
   * FOREIGN spaces the candidate's action reads (raw, as the runner
   * discovered them — the home space and duplicates are dropped at issuance).
   * The runner supplies this only when the classifier admitted foreign reads
   * under its `serverPrimaryExecutionCrossSpaceReadCandidates` experimental
   * option; an ordinary same-space candidate omits it and every cross-space
   * branch stays dormant.
   */
  readonly foreignReadSpaces?: readonly string[];
};

/**
 * Canonicalize a candidate's raw foreign-read surface into a claim's
 * `crossSpaceReadSpaces` set (C3.6): drop the home space (a same-space read is
 * never cross-space), drop empties/non-strings, dedup, and SORT for a stable
 * key. Returns a frozen array; empty ⇒ an ordinary same-space claim (the
 * caller then omits the field entirely, so the claim stays byte-identical to
 * a pre-C3.6 one). Sorting makes issuance deterministic and keeps C3.7's
 * per-(space, principal, epoch) sidecar key order-independent.
 */
const normalizeCrossSpaceReadSpaces = (
  spaces: readonly string[] | undefined,
  homeSpace: string,
): readonly string[] => {
  if (spaces === undefined || spaces.length === 0) return Object.freeze([]);
  const deduped = new Set<string>();
  for (const space of spaces) {
    if (typeof space === "string" && space.length > 0 && space !== homeSpace) {
      deduped.add(space);
    }
  }
  return Object.freeze([...deduped].sort());
};

type BoundExecutionSession = {
  readonly connectionId: string;
  readonly sessionToken: SessionToken;
  readonly principal: string;
  readonly sponsorSessionId: string;
  readonly lease: ExecutionLeaseHandle;
};

/**
 * Host-derived authority for one user lane (context-lattice §3, C1.3): keyed
 * (space, branch, user:did), anchored on one live CONNECTED session of the
 * lane principal, carrying a host-internal monotonic `laneGeneration` that is
 * never a wire field. Creation and every renewal require the principal's
 * current WRITE capability (C1 review, amendment 2). Disconnect of the
 * anchor drains exactly this lane: the generation fences BEFORE the claim
 * sweep so a racing issuance observes the fence (amendment 12).
 */
export type UserLaneGrant = {
  readonly space: string;
  readonly branch: BranchName;
  readonly contextKey: `user:${string}`;
  readonly principal: string;
  readonly laneGeneration: number;
  readonly anchorSessionId: string;
  readonly anchorConnectionId: string;
  readonly anchorSessionToken: SessionToken;
};

/**
 * Host-derived authority for one session lane (context-lattice §3, C2.3):
 * keyed (space, branch, session:<did>:<sessionId>), anchored on THAT live
 * connected session — the session is its OWN anchor, validated with the
 * bindExecutionSession checks (live session, bound principal, owning
 * connection). Mirrors UserLaneGrant WITHOUT the re-anchor path: session-end
 * is lane-end, so `anchorSessionId` is always the lane's own `sessionId` and
 * a disconnect (or TTL detach) drains the lane instead of migrating it.
 * Creation and every renewal require the session principal's current WRITE
 * capability (amendment 2 at session rank). Drain fences the generation
 * BEFORE the claim sweep (amendment 12), exactly like user lanes.
 */
export type SessionLaneGrant = {
  readonly space: string;
  readonly branch: BranchName;
  readonly contextKey: `session:${string}:${string}`;
  readonly principal: string;
  readonly sessionId: string;
  readonly laneGeneration: number;
  /** Always === sessionId — the session is its own anchor (no re-anchor). */
  readonly anchorSessionId: string;
  readonly anchorConnectionId: string;
  readonly anchorSessionToken: SessionToken;
};

/** Any live lane-grant incarnation — the shape shared by the issuance
 * binding (CA1), the commit fence's laneAuthority lookup, and the drains. */
type ExecutionLaneGrant = UserLaneGrant | SessionLaneGrant;

/** Registry key for one lane of either rank. The canonical contextKey embeds
 * the rank, so user and session lane keys can never collide. */
const laneGrantKey = (
  space: string,
  branch: BranchName,
  contextKey: string,
): string => encodeMemoryBoundary([space, branch, contextKey]);

/**
 * ROUTING-DISJOINTNESS (context-lattice §2, amendment 3): two live claims
 * for one action tuple are chain-compatible when a single client identity
 * could match both under chain-scoped routing — `space` with anything, and
 * `user:p` with `session:p:*`. Distinct principals' scoped claims (and one
 * principal's distinct sessions) are the legitimate fan-out. Callers compare
 * distinct context keys only; exact duplicates are the already-live failure.
 */
const executionClaimChainCompatible = (
  left: SchedulerExecutionContextKey,
  right: SchedulerExecutionContextKey,
): boolean => {
  if (left === "space" || right === "space") return true;
  const leftUser = Engine.principalOfUserContextKey(left);
  if (
    leftUser !== undefined &&
    Engine.principalOfSessionKey(right) === leftUser
  ) {
    return true;
  }
  const rightUser = Engine.principalOfUserContextKey(right);
  return rightUser !== undefined &&
    Engine.principalOfSessionKey(left) === rightUser;
};

/** The (branch, space, pieceId, actionId, fingerprints) tuple of amendment 3:
 * one logical action across lanes, deliberately excluding contextKey. */
const sameActionTupleAcrossLanes = (
  left: ActionClaimKey,
  right: ActionClaimKey,
): boolean =>
  left.branch === right.branch && left.space === right.space &&
  left.pieceId === right.pieceId && left.actionId === right.actionId &&
  left.implementationFingerprint === right.implementationFingerprint &&
  left.runtimeFingerprint === right.runtimeFingerprint;

/** Expected host-authority loss while a lane is changing demand or sponsor.
 * Strict host APIs still reject it; the executor's race-tolerant claim path
 * converts only this class to a non-fatal `null`. */
class ExecutionLeaseAuthorityError extends Error {
  override name = "ExecutionLeaseAuthorityError";
}

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

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
  #clientFlags: MemoryProtocolFlags | null = null;
  #serverFlags: MemoryProtocolFlags | null = null;
  #sessions = new Map<string, SessionHandle>();
  #executionLease: ExecutionLeaseHandle | null = null;
  #sessionOpenChallenge: SessionOpenChallengeState | null = null;
  #receiving: Promise<void> = Promise.resolve();
  #pendingReceives = 0;
  #receiveIdle: PromiseWithResolvers<void> | null = null;

  constructor(
    readonly id: string,
    private readonly server: Server,
    private readonly sendRaw: Send,
  ) {}

  get serverPrimaryExecutionV1(): boolean {
    return this.#clientFlags?.serverPrimaryExecutionV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionV1 === true;
  }

  get serverPrimaryExecutionClaimRoutingV1(): boolean {
    return this.serverPrimaryExecutionV1 &&
      this.#clientFlags?.serverPrimaryExecutionClaimRoutingV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionClaimRoutingV1 === true;
  }

  get serverPrimaryExecutionBuiltinPassivityV1(): boolean {
    return this.serverPrimaryExecutionClaimRoutingV1 &&
      this.#clientFlags?.serverPrimaryExecutionBuiltinPassivityV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionBuiltinPassivityV1 === true;
  }

  /** context-lattice-claims-v1 (C1.7): layered above claim routing — a
   * connection that cannot route space claims can never route scoped ones.
   * Never part of missesRequiredExecutionCapability: a mixed fleet is valid
   * by design and the amendment-11 cohort gate handles it at attach. */
  get serverPrimaryExecutionContextLatticeClaimsV1(): boolean {
    return this.serverPrimaryExecutionClaimRoutingV1 &&
      this.#clientFlags?.serverPrimaryExecutionContextLatticeClaimsV1 ===
        true &&
      this.#serverFlags?.serverPrimaryExecutionContextLatticeClaimsV1 === true;
  }

  /** cross-space-claims-v1 (C3.6b): layered above claim routing — a
   * connection that cannot route space claims can never route cross-space
   * ones. Never part of missesRequiredExecutionCapability: a mixed fleet is
   * valid by design and the A11 cohort gate handles it at attach. */
  get serverPrimaryExecutionCrossSpaceClaimsV1(): boolean {
    return this.serverPrimaryExecutionClaimRoutingV1 &&
      this.#clientFlags?.serverPrimaryExecutionCrossSpaceClaimsV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionCrossSpaceClaimsV1 === true;
  }

  /** doc-set watch (F3): layered above the base feed capability — a connection
   * that cannot run server-primary execution can never register a `docs`
   * watch. Never part of missesRequiredExecutionCapability: a mixed fleet is
   * valid by design, and a non-negotiating session's `docs` registration is
   * rejected at the watch handler rather than at admission. */
  get serverPrimaryExecutionDocSetWatchV1(): boolean {
    return this.serverPrimaryExecutionV1 &&
      this.#clientFlags?.serverPrimaryExecutionDocSetWatchV1 === true &&
      this.#serverFlags?.serverPrimaryExecutionDocSetWatchV1 === true;
  }

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
    return !this.hasSession(space, sessionId) ||
      (this.server.isAclActive() &&
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
    this.server.removeExecutionDemandsForSession(
      this.id,
      space,
      sessionId,
    );
    this.send({
      type: "session/revoked",
      space,
      sessionId,
      reason,
    });
  }

  sendExecutionEffect(
    space: string,
    sessionId: string,
    effect: SessionSync,
  ): void {
    if (this.#closed || this.shouldSuppressSessionSend(space, sessionId)) {
      return;
    }
    this.send({
      type: "session/effect",
      space,
      sessionId,
      effect,
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

  /** Host-only setup for an executor provider connection. The handle remains
   * in this realm and is never encoded onto the memory protocol. */
  bindExecutionLease(lease: ExecutionLeaseHandle): void {
    if (
      this.#ready || this.#sessions.size > 0 || this.#executionLease !== null
    ) {
      throw new Error(
        "execution lease must bind a fresh connection exactly once",
      );
    }
    this.#executionLease = lease;
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
      const response = respondToHello(
        parsed,
        this.server.memoryProtocolFlags(),
      );
      if (response.type === "hello.ok") {
        response.sessionOpen = this.issueSessionOpenAuth();
      }
      this.send(response);
      if (response.type !== "hello.ok") {
        return;
      }
      const clientFlags = parseMemoryProtocolFlags(parsed.flags);
      const serverFlags = parseMemoryProtocolFlags(response.flags);
      this.#clientFlags = clientFlags;
      this.#serverFlags = serverFlags;
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
        const response = this.#executionLease === null
          ? await this.server.openSession(parsed, this)
          : await this.server.openSession(
            parsed,
            this,
            this.#executionLease,
          );
        if (response.ok?.sessionId) {
          this.addSession(parsed.space, response.ok.sessionId);
          if (this.#executionLease !== null) {
            this.server.bindExecutionSession(
              parsed.space,
              response.ok.sessionId,
              this.#executionLease,
            );
          }
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
      case "docs.read":
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
          const response = await this.server.docsRead(parsed);
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
          if (response.ok !== undefined && this.serverPrimaryExecutionV1) {
            response.ok.sync = this.server.attachExecutionFeed(
              parsed.space,
              parsed.sessionId,
              response.ok.sync,
            );
          }
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
          if (response.ok !== undefined && this.serverPrimaryExecutionV1) {
            response.ok.sync = this.server.attachExecutionFeed(
              parsed.space,
              parsed.sessionId,
              response.ok.sync,
            );
          }
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
      case "scheduler.writer.list":
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
          const response = await this.server.writersForTargets(parsed);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "session.execution.demand.set":
        if (!this.serverPrimaryExecutionV1) {
          this.send({
            type: "response",
            requestId: parsed.requestId,
            error: toError(
              "UnsupportedProtocol",
              "memory capability server-primary-execution-v1 was not negotiated",
            ),
          });
          return;
        }
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
          const response = await this.server.setExecutionDemand(parsed, this);
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "session.execution.legacy-background.acquire":
      case "session.execution.legacy-background.renew":
      case "session.execution.legacy-background.release":
        if (!this.serverPrimaryExecutionV1) {
          this.send({
            type: "response",
            requestId: parsed.requestId,
            error: toError(
              "UnsupportedProtocol",
              "memory capability server-primary-execution-v1 was not negotiated",
            ),
          });
          return;
        }
        if (
          !this.requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        if (
          parsed.type === "session.execution.legacy-background.acquire"
        ) {
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            await this.server.acquireLegacyBackgroundExclusion(parsed, this),
          );
        } else if (
          parsed.type === "session.execution.legacy-background.renew"
        ) {
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            await this.server.renewLegacyBackgroundExclusion(parsed, this),
          );
        } else {
          this.sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            await this.server.releaseLegacyBackgroundExclusion(parsed, this),
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
    dirtyScopeKeys?: DirtyScopeKeys,
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
        {
          adoptionObservations: this.#persistentSchedulerState,
          dirtyScopeKeys,
        },
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
        this.send(
          this.serverPrimaryExecutionV1
            ? {
              ...effect,
              effect: this.server.attachExecutionFeed(
                space,
                sessionId,
                effect.effect,
              ),
            }
            : effect,
        );
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
  #openedEngines = new Map<string, Engine.Engine>();
  // Synthesized session state for direct out-of-band document writes, such as blob uploads.
  #directSessionId = `server:${crypto.randomUUID()}`;
  #directLocalSeq = 0;
  #dirtySpaces = new Set<string>();
  #dirtyDocsBySpace = new Map<string, Set<string>>();
  #dirtyOriginsBySpace = new Map<string, Map<string, DirtyOrigin>>();
  /** F6: per-wave cohort metadata (see DirtyScopeKeys). Kept beside — never
   * inside — the dirty set so pre-F6 callers of markSpaceDirty stay valid and
   * fail open to broadcast. */
  #dirtyScopeKeysBySpace = new Map<string, Map<string, Set<string>>>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshing: Promise<void> | null = null;
  // The owner commit is synchronous, but cross-space scheduler fan-out awaits
  // other engines. Preserve owner apply order across concurrent connections so
  // an older mirror cannot land after a newer one.
  #schedulerSideEffectsByOwnerSpace = new Map<string, Promise<void>>();
  #lastRefreshDurationMs = 0;
  #acceptedCommitListeners = new Map<string, Set<AcceptedCommitListener>>();
  #acceptedCommitOrderBySpace = new Map<string, number>();
  #executionDemands = new Map<string, AuthenticatedExecutionDemand>();
  #executionDemandRegistrationOrder = new Map<string, number>();
  #executionDemandSessionTokens = new Map<string, SessionToken>();
  #nextExecutionDemandRegistrationOrder = 0;
  #executionDemandListeners = new Set<ExecutionDemandListener>();
  #executionDemandOrder = 0;
  #executionClaims = new Map<string, ExecutionClaim>();
  #boundExecutionSessions = new Map<string, BoundExecutionSession>();
  /** Live user-lane grants keyed by (space, branch, contextKey). */
  #userLaneGrants = new Map<string, UserLaneGrant>();
  /** Live session-lane grants keyed by (space, branch, contextKey) — the
   * key space is shared with user lanes (laneGrantKey) but can never
   * collide, since the canonical contextKey embeds the rank (C2.3). */
  #sessionLaneGrants = new Map<string, SessionLaneGrant>();
  /** Monotonic per-lane generation counters (user AND session lanes; keys
   * are rank-disjoint); they survive drains so every re-opened lane
   * observably supersedes its predecessor. */
  #laneGenerations = new Map<string, number>();
  /** laneGeneration bound at issuance per live scoped-rank claim
   * (actionClaimMapKey), re-validated by renewal and the commit fence. */
  #executionClaimLaneBindings = new Map<
    string,
    { laneKey: string; laneGeneration: number }
  >();
  #ownedExecutionLeases = new Map<string, OwnedExecutionLease>();
  #executionInvalidationStartedAt = new Map<string, number>();
  #executionLeaseAuthorities = new WeakMap<
    ExecutionLeaseHandle,
    OwnedExecutionLease
  >();
  #executionLeaseTasks = new Set<Promise<void>>();
  #executionClaimExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  #executionLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  #executionHostId: string;
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
  /**
   * C3.1 (2026-07-18): the host-level cross-space seam — the protocol of
   * context-lattice §5 is between engine HOSTS (Server↔Server, standing
   * decision #1; engines stay passive), and this router is where a host's
   * hosted-space knowledge and per-space protocol inboxes live, over the
   * in-process transport as the protocol's first transport.
   *
   * C3.1b (2026-07-18) routed the first real traffic: every space this
   * server SERVES registers a protocol inbox here (`openEngine` on the
   * serve path — see `registerCrossSpaceHostedSpace`), mirror upserts and
   * durable dirt travel as `foreign-observation.mirror` /
   * `foreign-dirty-mark` messages through this router instead of direct
   * peer-engine writes, and the registry is the hosted-space gate: a
   * message for an unhosted space drops at the router with zero side
   * effects, and the peer-write apply path (`openHostedEngine`) refuses
   * to mint an engine for an unhosted space name (the C3A1 blocker's
   * fix).
   *
   * C3.10a (2026-07-18): the transport is injectable
   * (`options.crossSpaceTransport`) — a co-hosted deployment passes a
   * routing transport (cross-space-link.ts) whose space→host table this
   * server consults at three seams: `openEngine` refuses to materialize
   * a peer-routed space (the routing table is the authority for "not
   * mine"), `ensureCrossSpaceHosting` lets sends toward peer-routed
   * spaces ride the link without local registration, and the C3.2 bump
   * fan-out includes link-routed spaces. Default stays the in-process
   * transport — no routing face, byte-identical single-host behavior.
   * Initialized in the constructor (a field initializer cannot see
   * `options`).
   */
  #crossSpaceRouter: CrossSpaceHostRouter;
  /**
   * In-order application of inbound cross-space messages, one promise
   * chain per target space (mirroring `#schedulerSideEffectsByOwnerSpace`
   * so per-space apply order equals per-link arrival order), plus the
   * flat pending set `settleCrossSpaceDeliveries` drains — the same-host
   * application barrier that keeps the C3.1b routing topology-transparent
   * for the in-process transport (a transact that fanned out mirrors/dirt
   * still resolves only after the peer-space engines applied them, as the
   * pre-C3.1b direct writes did).
   */
  #crossSpaceInboundApplyChains = new Map<string, Promise<void>>();
  #pendingCrossSpaceInboundApplies = new Set<Promise<void>>();
  /**
   * C3.10b slot (C3A12 keying): highest applied foreign-dirt seq per
   * `linkId\0fromSpace\0toSpace`. Advanced on every applied
   * `foreign-dirty-mark`; in-process it is never consulted (the link
   * never drops). C3.10b persists it and drives the reconnect resync
   * pull (read-host `scheduler_action_state` rows with `owner_space` =
   * home and `direct_dirty_seq` > cursor) from it.
   */
  // Soft-private (not #-private) so C3.10b's reconnect drill and today's
  // parked-space fixture can observe the advancing value.
  private crossSpaceAppliedDirtCursors = new Map<string, number>();
  /**
   * C3.3a — READ-host side of the demand-joined foreign-wake join: the
   * live `ForeignReadersSubscribe` registrations of remote HOME spaces,
   * outer-keyed by the read space this host serves, inner-keyed by
   * `homeSpace\0homeBranch`. One live registration per stream, replaced
   * only by a strictly higher `subscriptionGeneration` (the C3A10
   * discrimination); an unsubscribe retires exactly its own generation.
   * `#publishAcceptedCommit` consults this to emit `ForeignStaleReaders`.
   *
   * C3.2/C3.7 seam (C3A6, dated 2026-07-18): an authorization-epoch
   * revocation that unsubscribes a home space's demand pairs operates on
   * THIS registry (drop the inner entry) plus the mirrored reader rows —
   * `dropForeignReaderSubscriptionsForHome` below is the intended entry.
   * Soft-private for fixtures.
   */
  private foreignReaderSubscriptionsByReadSpace = new Map<
    string,
    Map<
      string,
      { generation: number; laneDemands: readonly CrossSpaceLaneDemand[] }
    >
  >();
  /**
   * C3.3a — HOME-host side: this host's own outbound subscription state
   * per `homeSpace\0branch\0readSpace`. `nextGeneration` is the
   * monotonic per-stream generation counter; `liveGeneration`/
   * `liveLaneDemandsKey` describe the acked registration; `ackWaiters`
   * carries the C3A10 barrier resolvers keyed by generation (resolved by
   * the inbound `foreign-readers.subscribe-applied` arm, or by close —
   * fail-open teardown, never a hung chain).
   */
  private foreignReaderSubscriptionsByHomeSpace = new Map<
    string,
    {
      nextGeneration: number;
      liveGeneration?: number;
      liveLaneDemandsKey?: string;
      ackWaiters: Map<number, () => void>;
    }
  >();
  /** Coalescing per-(homeSpace, branch) reconcile chains for the foreign
   * subscription registry — at most one in-flight pass per key, with a
   * rerun bit for triggers arriving mid-pass. */
  #foreignSubscriptionReconciles = new Map<
    string,
    { rerun: boolean; chain: Promise<void> }
  >();
  /** Every in-flight piece of C3.3a background work (reconcile passes and
   * detached subscribe-ack continuations) — the settle barrier's set. */
  #pendingForeignSubscriptionWork = new Set<Promise<void>>();
  #foreignSubscriptionsClosed = false;
  #foreignWakeListeners = new Map<string, Set<ForeignWakeListener>>();
  /**
   * C3.2 (2026-07-18): the receiving-side store for REMOTE authorization
   * epochs — what this host remembers about PEER spaces, fed by inbound
   * `foreign-authorization-epoch.bump` pushes and `.query.result`
   * responses. Keyed by `linkId\0authoritySpace` (C3A12 keying: the
   * stable linkId survives reconnects; the authority space is the
   * envelope's `fromSpace` — the C3A13 structural trust rule, a host
   * only ever asserts epochs for spaces it speaks for). Every component
   * max-merges independently (floor and per-principal rows), so
   * redelivery and reordering never regress a value — the C3.1b
   * no-ack discipline's idempotence arm.
   *
   * In-memory on purpose: losing it on restart only widens the UNKNOWN
   * set, and C3A3's comparison discipline makes unknown fail closed
   * (over-revoke, never under-revoke). C3.10b owns persistence questions
   * and the reconnect resync (the epoch query before claim
   * re-issuance).
   *
   * Consumers (dated 2026-07-18, NOT built here): C3.7 claim binding
   * revalidates bound {(space, principal, epoch)} sets by EQUALITY via
   * `effectiveRemoteAuthorizationEpoch` (undefined = unknown = fail
   * closed); C3.8's apply fence consults the same lookup. This WO builds
   * the substrate only — nothing is wired to revoke yet.
   */
  #remoteAuthorizationEpochs = new Map<
    string,
    { floor: number; byPrincipal: Map<string, number> }
  >();

  /**
   * C3.4: in-flight foreign point reads awaiting their result, keyed by
   * `requestId` (unique per issuance — `crypto.randomUUID`). Each entry
   * resolves from the inbound `foreign-point-read.result` arm, from its
   * fail-closed timeout (`foreign-read-timeout`), or from server close
   * (`foreign-read-unavailable`) — never left dangling. `readSpace` binds
   * the ANSWERING space: a result whose `fromSpace` differs from the
   * space this request was addressed to is dropped, on top of the
   * codec's stamp.space === fromSpace rule (C3A13) and C3.10a's
   * link-gate — so even a confused in-process peer cannot satisfy a
   * pending read for a space it does not speak for.
   */
  #pendingForeignPointReads = new Map<string, {
    readSpace: string;
    resolve: (outcome: ExecutorForeignPointReadOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
    /** C3.5: the requesting claim's incarnation key — served results are
     * recorded into `#servedForeignReadStamps` under this key. */
    claimIncarnationKey: string;
    /** C3.5: the requested document id (the result wire carries none). */
    docId: string;
  }>();

  /**
   * C3.5: the home host's OWN record of served foreign point reads — the
   * validation source for Worker-asserted `foreignReadStamps` (C3A13: the
   * engine cannot verify a foreign seq; the Worker cannot be trusted to).
   * Keyed by claim incarnation key → `space\0id` → recent served stamps.
   * Only results that passed the pending-map answering-space check land
   * here, so every recorded stamp arrived over the link authoritative for
   * its space. A bounded window of recent stamps per document (not just
   * the latest) keeps the designed-in mid-run mount refresh (a foreign
   * wake racing a long run) from falsely stripping the run's slightly
   * older — but genuinely served — stamp. Entries die with their claim
   * incarnation (lazy sweep against `#executionClaims`).
   */
  #servedForeignReadStamps = new Map<
    string,
    Map<string, {
      seq: number;
      authorizationEpoch: ForeignAuthorizationEpochStamp;
    }[]>
  >();
  static readonly #SERVED_FOREIGN_STAMPS_PER_DOC = 4;

  /** Drop served-stamp records whose claim incarnation is no longer live.
   * Called from the record and validate paths — the ledger can never
   * outgrow live executor claims by more than the in-flight window. */
  #sweepServedForeignReadStamps(): void {
    if (this.#servedForeignReadStamps.size === 0) return;
    const live = new Set(
      [...this.#executionClaims.values()].map(executionClaimIncarnationKey),
    );
    for (const key of this.#servedForeignReadStamps.keys()) {
      if (!live.has(key)) this.#servedForeignReadStamps.delete(key);
    }
  }

  /** C3.5: record one served foreign point read for later Worker-assertion
   * validation. Bounded per (claim, doc); newest last. */
  #recordServedForeignReadStamp(
    claimIncarnationKey: string,
    readSpace: string,
    docId: string,
    stamp: { seq: number; authorizationEpoch: ForeignAuthorizationEpochStamp },
  ): void {
    this.#sweepServedForeignReadStamps();
    let docs = this.#servedForeignReadStamps.get(claimIncarnationKey);
    if (docs === undefined) {
      docs = new Map();
      this.#servedForeignReadStamps.set(claimIncarnationKey, docs);
    }
    const key = `${readSpace}\0${docId}`;
    let stamps = docs.get(key);
    if (stamps === undefined) {
      stamps = [];
      docs.set(key, stamps);
    }
    if (stamps.some((held) => held.seq === stamp.seq)) return;
    stamps.push(stamp);
    while (stamps.length > Server.#SERVED_FOREIGN_STAMPS_PER_DOC) {
      stamps.shift();
    }
  }

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
      /** Optional per-server protocol override. Rollout hosts use the ambient
       *  runtime flag; tests may model client/server version skew in-process. */
      protocolFlags?: Partial<WireMemoryProtocolFlags>;
      executionControl?: {
        claimTtlMs?: number;
        nowMs?: () => number;
        hostId?: string;
        leaseTtlMs?: number;
        drainTimeoutMs?: number;
        /** C3.4: fail-closed bound on one foreign point read's pending
         * result (default 10s). Timers, not barriers, deliberately: the
         * timeout exists exactly for the case where no answering event
         * will ever arrive (C3.10b owns link-loss disposition). */
        foreignPointReadTimeoutMs?: number;
      };
      /**
       * C3.10a: the cross-space transport this host's router runs over.
       * Default: the in-process transport (single host, the C3.1
       * shape). A co-hosted deployment passes a
       * `CoHostedCrossSpaceTransport` (cross-space-link.ts) — its
       * routing table then gates engine materialization (a peer-routed
       * space is never opened here) and routes cross-space traffic for
       * peer spaces over the real link.
       */
      crossSpaceTransport?: CrossSpaceTransport;
    },
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#store = options.store;
    this.#executionHostId = options.executionControl?.hostId ??
      `host:${crypto.randomUUID()}`;
    this.#crossSpaceRouter = new CrossSpaceHostRouter(
      options.crossSpaceTransport ?? new InProcessCrossSpaceTransport(),
    );
    // C3.10a: deployment-configured local spaces register eagerly, so a
    // configured space's protocol inbox exists before its first serve —
    // inbound mirror/dirt for a configured-but-parked space applies
    // (register + create on demand) instead of dropping, matching the
    // single-host store-materialized story.
    for (
      const space of options.crossSpaceTransport?.routing
        ?.configuredLocalSpaces() ?? []
    ) {
      this.registerCrossSpaceHostedSpace(space);
    }
  }

  nowSeconds(): number {
    return this.options.sessionOpenAuth.nowSeconds?.() ??
      Math.floor(Date.now() / 1000);
  }

  memoryProtocolFlags(): MemoryProtocolFlags {
    if (this.options.protocolFlags === undefined) {
      return getMemoryProtocolFlags();
    }
    const flags = parseMemoryProtocolFlags({
      ...wireMemoryProtocolFlags(getMemoryProtocolFlags()),
      ...this.options.protocolFlags,
    });
    if (flags === null) {
      throw new Error("memory server protocol flags are malformed");
    }
    return flags;
  }

  #assertExecutionClaimCapabilityEnabled(
    claim: Pick<ExecutionClaimInput, "actionKind" | "contextKey">,
  ): void {
    const flags = this.memoryProtocolFlags();
    if (!flags.serverPrimaryExecutionV1) {
      throw new Error("server-primary-execution-v1 is disabled");
    }
    if (
      claim.actionKind === "computation" &&
      !flags.serverPrimaryExecutionClaimRoutingV1
    ) {
      throw new Error("server-primary computation claim routing is disabled");
    }
    if (
      claim.actionKind === "effect" &&
      !flags.serverPrimaryExecutionBuiltinPassivityV1
    ) {
      throw new Error("server-primary builtin passivity is disabled");
    }
    if (!this.#executionClaimRankEnabled(claim)) {
      throw new Error(
        "server-primary execution claim rank is not enabled for this context",
      );
    }
  }

  /** Issuance-side rank dial (context-lattice §6): the host issues claims
   * only up to the enabled context rank, a LADDER — the `session` stage
   * admits user rank too. Space is always issuable; scoped ranks require
   * the dial stage, actionKind `computation` or `effect` (amendment 8's
   * computation-only conjunct was LIFTED by C2.8, 2026-07-18 — scoped-lane
   * builtin egress under the lane grant, context-lattice OQ6/R12; effects
   * additionally require the passivity flag via
   * #assertExecutionClaimCapabilityEnabled, every rank alike), AND the
   * host's own context-lattice-claims-v1 advertisement (C1.7 folds the
   * dial behind the subcapability, amendment 9: a host that does not
   * advertise context-scoped delivery would issue claims deliverable to no
   * session). Session-rank keys must additionally be canonical
   * (#validateExecutionClaimInput rejects malformed shapes before this
   * gate, CA12). Rank enablement gates ISSUANCE and RENEWAL only — the
   * engine's commit-time claim guards are rank-independent. */
  #executionClaimRankEnabled(
    claim: Pick<ExecutionClaimInput, "actionKind" | "contextKey">,
  ): boolean {
    if (claim.contextKey === "space") return true;
    if (claim.actionKind !== "computation" && claim.actionKind !== "effect") {
      return false;
    }
    if (
      !this.memoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1
    ) {
      return false;
    }
    if (Engine.principalOfUserContextKey(claim.contextKey) !== undefined) {
      return serverPrimaryExecutionClaimRankAtLeast("user");
    }
    return Engine.parseSessionExecutionContextKey(claim.contextKey) !==
        undefined && serverPrimaryExecutionClaimRankAtLeast("session");
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

  /** Bounded-cardinality rollout counters for server-primary authority. */
  readonly executionStats = {
    claimsIssued: 0,
    claimsReissued: 0,
    claimsRevoked: 0,
    // F1 claim-coverage evidence: issuance attributed to the claim's context
    // key (space vs per-user lanes). Keyed by live context keys, so
    // cardinality is bounded by the active principals on this host.
    claimsIssuedByContextKey: {} as Record<string, number>,
    acceptedActionAttempts: 0,
    claimedActionConflicts: 0,
    settlementsPublished: 0,
    settlementsCommitted: 0,
    settlementsNoOp: 0,
    settlementsFailed: 0,
    settlementsUnserved: 0,
    leaseFenceRejects: 0,
    // Per-cause breakdown of leaseFenceRejects (ExecutionLeaseFenceError
    // .fenceCause). A fenced commit in a measured run must name itself: a
    // claim-shrink race reads very differently from a lapsed lease heartbeat.
    leaseFenceRejectCauses: {} as Record<string, number>,
    actionFirewallRejects: 0,
    // C3.3b (C3A5, 2026-07-18): observation mirrors withheld at the send
    // gate because the observation's ACTING principal lacked READ on the
    // read space at send time. Denial is a silent drop of the mirror only
    // (the home-side observation is untouched), so this counter is the
    // denial's only footprint — see canMirrorSchedulerObservationToSpace.
    crossSpaceMirrorsWithheld: 0,
    // C3.5 (C3A13, B.4-style counting): Worker-asserted foreign read
    // stamps DROPPED at host validation because no matching served
    // point-read record exists for the asserting claim incarnation — a
    // fabricated seq, a stamp served to another claim, or a record aged
    // out. The strip is silent by design (the attempt still settles,
    // minus the component — vacuous coverage), so this counter is its
    // only footprint.
    foreignBasisAssertionsStripped: 0,
    // C3.5: host-validated foreign basis components handed to the engine
    // (at most one per (attempt, space)).
    foreignBasisComponentsValidated: 0,
    acceptedCommitIndexLookups: 0,
    acceptedCommitIndexTargetCandidates: 0,
    acceptedCommitIndexDemandedPieces: 0,
    acceptedCommitIndexMatches: 0,
    // F1 claim-coverage counters (recordExecutionCandidate*): the executor
    // host reports every candidate outcome here so /api/health/stats — not a
    // console.debug grep — is the coverage evidence channel (the OQ4
    // per-space rollout-gate input). Space and code key cardinality is
    // bounded by active spaces and the fixed diagnostic-code vocabulary.
    candidateClaimReadyBySpace: {} as Record<string, number>,
    candidateUnservedBySpace: {} as Record<string, number>,
    candidateUnservedByCode: {} as Record<string, number>,
    // Distinct offending implementations per code (deduped by
    // implementationFingerprint): "one builtin unserved ×4" must read
    // differently from "four implementations unserved once each".
    candidateUnservedOffendersByCode: {} as Record<string, number>,
  };

  /** Dedupe backing for candidateUnservedOffendersByCode: code → distinct
   * offender fingerprints. Grows with distinct implementations only. */
  #candidateUnservedOffenders = new Map<string, Set<string>>();

  /** F1 feed observability: per-wave delivery and traversal attribution for
   * the subscription refresh loop and graph queries. Counters only — never
   * consulted by delivery decisions. */
  readonly feedStats = {
    /** Space fan-out passes of the refresh loop (one per dirty-set wave). */
    refreshWaves: 0,
    /** Sessions whose tracked ids intersected a wave's dirty set. */
    refreshSessionsTouched: 0,
    /** F6: sessions a wave did NOT touch because every intersecting dirty
     * key's delivery cohort excluded them (the pre-F6 broadcast would have
     * counted them touched and empty-delivered). Makes the cohort filter's
     * silence visible: `touched + cohortSuppressed` per wave equals the
     * pre-F6 touched population. */
    refreshCohortSuppressedSessions: 0,
    /** Tracked graphs a wave re-traversed (refreshTrackedGraph did work). */
    refreshGraphsRefreshed: 0,
    /** Upserts delivered to sessions by wave refreshes. */
    refreshUpsertsPushed: 0,
    /** F3: point-read member deltas delivered from doc-set membership fan-out
     * (never a schema/link traversal). */
    docSetMemberDeliveries: 0,
    /** F3: live doc-set member-set size summed across sessions on the last
     * wave that touched a doc-set surface (FA8 gauge against demand). */
    docSetMembersTracked: 0,
    /** F5/FA13: touched sessions holding a doc-set surface on a wave (doc-set
     * subcapability negotiated ∧ dial-admitted members present). The dial's
     * behavioral authority is at ADMISSION (`#docSetWatchGate`); it is NOT
     * re-consulted here, so shrinking the dial never hides an
     * already-admitted surface from these gauges (FB9). */
    refreshRetirementEligibleSessions: 0,
    /** F5/FA13: eligible sessions whose ENTIRE watch surface was doc-set on a
     * wave — zero residual schema-graph watches, so the graph-refresh loop
     * had nothing to traverse (the zero-traversal property is structural:
     * F3's grouping exclusion + F4b's client demotion). The aggregated form
     * of F5's per-session fully-doc-set boolean. */
    refreshFullyDocSetSessions: 0,
    /** F5/FA3/FA13: residual subscribed schema-graph WATCHES held on an
     * eligible touched session's surface this wave — per-watch classification
     * (two watches sharing a branch group count as 2, FB28), whether or not
     * the wave forced them to traverse. Surface composition: a fully-demoted
     * space holds this at 0; a non-zero delta names surfaces that FAILED OPEN
     * to graph behavior (e.g. a boot root that never demoted). */
    refreshResidualGraphWatches: 0,
    /** F5/FB28: the subset of residual graph watches whose branch group
     * actually re-traversed this wave (`refreshTrackedGraph` did work serving
     * them). This — not the held count above — is the traversal regression
     * signal the OQ4 rollout gate watches: an idle residual watch accrues
     * held counts but never traversed counts. */
    refreshResidualGraphWatchesTraversed: 0,
    /** F5/FB11: DAG traversals attributed to residual graph refreshes on
     * eligible (doc-set-holding) sessions, keyed by space — the numerator of
     * the mixed-mode residual-traversal budget in the F5 measurement
     * protocol (per-space, per-cause: member point reads and demand pulls
     * never land here). Key cardinality is bounded by active spaces. */
    refreshResidualDagTraversalsBySpace: {} as Record<string, number>,
    /** Traversal work summed per server operation ("session.watch.refresh",
     * executor/client "graph.query", "session.watch.set",
     * "session.watch.add"). */
    traversalByOperation: {} as Record<string, FeedTraversalOperationStats>,
  };

  #recordFeedTraversal(operation: string, stats: QueryTraversalStats): void {
    const bucket = this.feedStats.traversalByOperation[operation] ??
      (this.feedStats.traversalByOperation[operation] =
        createFeedTraversalOperationStats());
    bucket.calls += 1;
    bucket.managerReads += stats.managerReads;
    bucket.coveredSelectorSkips += stats.coveredSelectorSkips;
    bucket.schemaTraversals += stats.schemaTraversals;
    bucket.pointerTraversals += stats.pointerTraversals;
    bucket.arrayTraversals += stats.arrayTraversals;
    bucket.objectTraversals += stats.objectTraversals;
    bucket.dagTraversals += stats.dagTraversals;
    bucket.getDocAtPathCalls += stats.getDocAtPathCalls;
    bucket.schemaMemoHits += stats.schemaMemoHits;
  }

  /** F1 claim-coverage evidence: the execution-pool host reports a
   * claim-ready candidate. Counter maintenance only — receiving one never
   * transfers or implies authority. */
  recordExecutionCandidateClaimReady(claimKey: ActionClaimKey): void {
    const stats = this.executionStats;
    stats.candidateClaimReadyBySpace[claimKey.space] =
      (stats.candidateClaimReadyBySpace[claimKey.space] ?? 0) + 1;
  }

  /** F1 claim-coverage evidence: the execution-pool host reports an
   * unserved/unservable candidate diagnostic. Diagnostics without a claim
   * key (e.g. malformed observations) count under "unknown" rather than
   * being dropped. */
  recordExecutionCandidateUnserved(diagnostic: {
    readonly diagnosticCode: string;
    readonly claimKey?: ActionClaimKey;
    readonly claim?: ExecutionClaim;
  }): void {
    const code = diagnostic.diagnosticCode;
    const key = diagnostic.claimKey ?? diagnostic.claim;
    const space = key?.space ?? "unknown";
    const fingerprint = key?.implementationFingerprint ?? "unknown";
    const stats = this.executionStats;
    stats.candidateUnservedByCode[code] =
      (stats.candidateUnservedByCode[code] ?? 0) + 1;
    stats.candidateUnservedBySpace[space] =
      (stats.candidateUnservedBySpace[space] ?? 0) + 1;
    let offenders = this.#candidateUnservedOffenders.get(code);
    if (offenders === undefined) {
      offenders = new Set();
      this.#candidateUnservedOffenders.set(code, offenders);
    }
    offenders.add(fingerprint);
    stats.candidateUnservedOffendersByCode[code] = offenders.size;
  }

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
    // Shared classifier (C3.2): the engine's epoch bump diffs the same
    // states this returns — see `Engine.aclValidityOfEntityState`.
    return Engine.aclValidityOfEntityState(
      Engine.readState(engine, { id: aclDocId(space) }),
    );
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
      if (session.ownerConnectionId !== null) {
        // Demand is physical-connection authority and must disappear even for
        // the response-ordering exception below, where no revocation frame is
        // sent to the writer that removed its own READ access.
        this.removeExecutionDemandsForSession(
          session.ownerConnectionId,
          space,
          session.id,
        );
      }
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
    // C1.3/C2.3: a dead connection can no longer anchor lane authority.
    // Drain (fence, then sweep) exactly the user and session lanes it
    // anchored before demand-based lease drains run, so no lane claim
    // outlives its anchor. For session lanes this IS session-end = lane-end:
    // there is no re-anchor path, mid-settle included — the host, not the
    // Worker, is the revoker of record for a dead session's claims.
    this.#drainLanesForConnection(connection.id);
    this.#removeExecutionDemands({ connectionId: connection.id });
    for (const [key, binding] of this.#boundExecutionSessions) {
      if (binding.connectionId === connection.id) {
        this.#boundExecutionSessions.delete(key);
      }
    }
    if (this.#connections.size === 0) {
      this.cancelScheduledRefresh();
    }
  }

  detachSession(
    space: string,
    sessionId: string,
    ownerConnectionId: string,
  ): void {
    // C1.3/C2.3: detaching the anchor session ends the lane's authority
    // even though the session row survives to its TTL (connected-session
    // anchoring, amendment 17). A detached session's later TTL death
    // therefore never sees a live lane — the drain already ran here.
    this.#drainLanesForSession(space, sessionId, ownerConnectionId);
    this.#sessions.detach(space, sessionId, ownerConnectionId);
    this.#boundExecutionSessions.delete(sessionKey(space, sessionId));
  }

  removeExecutionDemandsForSession(
    connectionId: string,
    space: string,
    sessionId: string,
  ): void {
    this.#removeExecutionDemands({ connectionId, space, sessionId });
    this.#boundExecutionSessions.delete(sessionKey(space, sessionId));
  }

  /**
   * Compare an accepted commit's authenticated origin with the principal this
   * exact host-owned lease executes on behalf of. This deliberately returns a
   * scalar answer: neither the origin principal nor sponsor identity crosses
   * the executor MessagePort.
   */
  executionOriginMatchesLeaseSponsor(
    lease: ExecutionLeaseHandle,
    originSessionId?: string,
  ): boolean {
    if (originSessionId === undefined) return false;
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(lease.space, lease.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      authority.handle !== lease || lease.state === "revoked"
    ) {
      return false;
    }
    const origin = this.#sessions.get(lease.space, originSessionId);
    return origin !== null && origin.principal !== undefined &&
      origin.principal !== ANYONE_USER && origin.ownerConnectionId !== null &&
      this.#connections.has(origin.ownerConnectionId) &&
      origin.principal === lease.onBehalfOf;
  }

  /**
   * Bind one authenticated session to host-owned executor authority. This is a
   * process API, never a protocol message; the Worker receives no sponsor key
   * and cannot select `onBehalfOf`.
   */
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void {
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(lease.space, lease.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      lease.space !== space || authority.handle.leaseGeneration !==
        lease.leaseGeneration ||
      authority.handle.state === "revoked"
    ) {
      throw new Error("execution authority requires a current owned lease");
    }
    const sponsor = this.#sessions.get(space, authority.sponsorSessionId);
    if (
      sponsor === null ||
      sponsor.ownerConnectionId !== authority.sponsorConnectionId ||
      sponsor.sessionToken !== authority.sponsorSessionToken ||
      sponsor.principal !== lease.onBehalfOf ||
      !this.#connections.has(authority.sponsorConnectionId)
    ) {
      throw new Error("execution lease sponsor is no longer attached");
    }
    const session = this.#sessions.get(space, sessionId);
    if (
      session === null || session.principal === undefined ||
      session.principal === ANYONE_USER || session.ownerConnectionId === null ||
      !this.#connections.has(session.ownerConnectionId) ||
      session.principal !== lease.onBehalfOf
    ) {
      throw new Error(
        "execution authority requires a matching authenticated session with a live connection",
      );
    }
    const key = sessionKey(space, sessionId);
    const binding: BoundExecutionSession = Object.freeze({
      connectionId: session.ownerConnectionId,
      sessionToken: session.sessionToken,
      principal: session.principal,
      sponsorSessionId: authority.sponsorSessionId,
      lease,
    });
    this.#boundExecutionSessions.set(key, binding);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Keep the immutable executor classification until Connection.close
      // detaches this exact session. Dropping it early would let a delayed
      // stale executor transaction downgrade into an ordinary client write.
    };
  }

  listExecutionDemands(
    space: string,
    branch: BranchName,
  ): readonly AuthenticatedExecutionDemand[] {
    return Object.freeze(
      [...this.#executionDemands.values()]
        .filter((demand) => demand.space === space && demand.branch === branch)
        .sort((left, right) =>
          left.connectionId.localeCompare(right.connectionId) ||
          left.sessionId.localeCompare(right.sessionId)
        )
        .map((demand) =>
          Object.freeze({
            ...demand,
            pieces: Object.freeze([...demand.pieces]),
          })
        ),
    );
  }

  #executionLeaseTtlMs(): number {
    const ttlMs = this.options.executionControl?.leaseTtlMs ?? 30_000;
    if (!isPositiveSafeInteger(ttlMs)) {
      throw new TypeError("execution lease ttl must be a positive integer");
    }
    return ttlMs;
  }

  #createExecutionLeaseHandle(lease: ExecutionLease): ExecutionLeaseHandle {
    const value = { ...lease } as ExecutionLeaseHandle;
    Object.defineProperty(value, executionLeaseHandleBrand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return Object.freeze(value);
  }

  #sameExecutionLease(
    left: ExecutionLease,
    right: ExecutionLease,
  ): boolean {
    return left.version === right.version && left.space === right.space &&
      left.branch === right.branch &&
      left.leaseGeneration === right.leaseGeneration &&
      left.hostId === right.hostId && left.onBehalfOf === right.onBehalfOf;
  }

  #executionDemandAuthority(
    demand: AuthenticatedExecutionDemand,
  ): { session: SessionState; firstDemandOrder: number } | null {
    const key = executionDemandKey(
      demand.connectionId,
      demand.space,
      demand.sessionId,
      demand.branch,
    );
    if (this.#executionDemands.get(key) !== demand) return null;
    const firstDemandOrder = this.#executionDemandRegistrationOrder.get(key);
    const demandSessionToken = this.#executionDemandSessionTokens.get(key);
    if (firstDemandOrder === undefined || demandSessionToken === undefined) {
      return null;
    }
    const session = this.#sessions.get(demand.space, demand.sessionId);
    if (
      session === null || session.principal === undefined ||
      session.principal === ANYONE_USER ||
      session.principal !== demand.principal ||
      session.sessionToken !== demandSessionToken ||
      session.ownerConnectionId !== demand.connectionId ||
      !this.#connections.has(demand.connectionId) ||
      !session.serverPrimaryExecutionV1
    ) {
      return null;
    }
    return { session, firstDemandOrder };
  }

  #executionSponsorCanWrite(
    engine: Engine.Engine,
    demand: AuthenticatedExecutionDemand,
    session: SessionState,
  ): boolean {
    if (
      !this.memoryProtocolFlags().serverPrimaryExecutionV1 ||
      this.#sessions.get(demand.space, demand.sessionId) !== session ||
      session.ownerConnectionId !== demand.connectionId ||
      session.principal !== demand.principal ||
      !this.#connections.has(demand.connectionId)
    ) {
      return false;
    }
    const capability = this.#resolveCapability(
      engine,
      demand.space,
      session.principal,
    );
    return capability !== null && isCapable(capability, "WRITE");
  }

  /** Revalidate the sponsor captured when a lease was acquired without
   * requiring its demand row to remain present. Explicit demand removal starts
   * a host-coordinated graceful drain; the authenticated session, connection,
   * token, and WRITE capability remain the authority during that bounded
   * settle window. */
  #executionLeaseSponsorCanWrite(
    engine: Engine.Engine,
    authority: OwnedExecutionLease,
    session: SessionState,
  ): boolean {
    const lease = authority.handle;
    if (
      !this.memoryProtocolFlags().serverPrimaryExecutionV1 ||
      this.#sessions.get(lease.space, authority.sponsorSessionId) !== session ||
      session.sessionToken !== authority.sponsorSessionToken ||
      session.ownerConnectionId !== authority.sponsorConnectionId ||
      session.principal !== lease.onBehalfOf ||
      !session.serverPrimaryExecutionV1 ||
      !this.#connections.has(authority.sponsorConnectionId)
    ) {
      return false;
    }
    const capability = this.#resolveCapability(
      engine,
      lease.space,
      session.principal,
    );
    return capability !== null && isCapable(capability, "WRITE");
  }

  #executionSponsorCandidates(
    space: string,
    branch: BranchName,
    preferredOriginSessionId?: string,
  ): readonly Readonly<{
    demand: AuthenticatedExecutionDemand;
    session: SessionState;
    firstDemandOrder: number;
    preferred: boolean;
  }>[] {
    const candidates = [...this.#executionDemands.values()].flatMap(
      (demand) => {
        if (demand.space !== space || demand.branch !== branch) return [];
        const authority = this.#executionDemandAuthority(demand);
        return authority === null ? [] : [{ demand, ...authority }];
      },
    );
    const preferredSession = preferredOriginSessionId === undefined
      ? null
      : this.#sessions.get(space, preferredOriginSessionId);
    const preferredPrincipal = preferredSession?.ownerConnectionId !== null &&
        preferredSession?.ownerConnectionId !== undefined &&
        preferredSession.principal !== undefined &&
        preferredSession.principal !== ANYONE_USER &&
        this.#connections.has(preferredSession.ownerConnectionId)
      ? preferredSession.principal
      : undefined;
    return candidates.map((candidate) => ({
      ...candidate,
      preferred: preferredPrincipal !== undefined &&
        candidate.demand.principal === preferredPrincipal,
    })).sort((left, right) =>
      Number(right.preferred) - Number(left.preferred) ||
      left.firstDemandOrder - right.firstDemandOrder ||
      left.demand.principal.localeCompare(right.demand.principal) ||
      left.demand.connectionId.localeCompare(right.demand.connectionId) ||
      left.demand.sessionId.localeCompare(right.demand.sessionId)
    );
  }

  /** Acquire one durable branch/space lease from an authenticated requesting
   * session while server-primary execution is enabled. */
  async acquireExecutionLease(
    space: string,
    branch: BranchName,
    options: { preferredOriginSessionId?: string } = {},
  ): Promise<ExecutionLeaseHandle | null> {
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) return null;
    const nowMs = () => this.#executionNowMs();
    const engine = await this.openEngine(space);
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) return null;
    const slot = executionLeaseKey(space, branch);
    const owned = this.#ownedExecutionLeases.get(slot);
    if (owned !== undefined) {
      const current = await Engine.currentExecutionLease(engine, {
        space,
        branch,
        nowMs,
      });
      if (
        current !== null && this.#sameExecutionLease(current, owned.handle) &&
        current.state !== "revoked"
      ) {
        if (
          current.state !== owned.handle.state ||
          current.expiresAt !== owned.handle.expiresAt
        ) {
          const handle = this.#createExecutionLeaseHandle(current);
          owned.handle = handle;
          this.#executionLeaseAuthorities.set(handle, owned);
        }
        return owned.handle;
      }
      const expired = Engine.expireExecutionLease(engine, {
        lease: owned.handle,
        nowMs,
      });
      if (
        expired !== null && this.#sameExecutionLease(expired, owned.handle)
      ) {
        this.#releaseOwnedExecutionLease(owned, expired);
      } else {
        this.#abandonOwnedExecutionLease(owned);
      }
    }
    // A live durable row without this exact host-local sponsor anchor belongs
    // to another process incarnation, even when host/user strings happen to
    // match. Never retarget that generation to a different demand session.
    if (
      Engine.currentExecutionLease(engine, { space, branch, nowMs }) !== null
    ) return null;

    for (
      const candidate of this.#executionSponsorCandidates(
        space,
        branch,
        options.preferredOriginSessionId,
      )
    ) {
      if (
        !this.#executionSponsorCanWrite(
          engine,
          candidate.demand,
          candidate.session,
        )
      ) continue;
      const lease = await Engine.acquireExecutionLease(engine, {
        space,
        branch,
        hostId: this.#executionHostId,
        onBehalfOf: candidate.demand.principal,
        nowMs,
        ttlMs: this.#executionLeaseTtlMs(),
        authorizeWrite: (transactionEngine) =>
          this.#executionSponsorCanWrite(
            transactionEngine,
            candidate.demand,
            candidate.session,
          ),
      });
      if (lease === null) return null;
      const handle = this.#createExecutionLeaseHandle(lease);
      const authority: OwnedExecutionLease = {
        handle,
        sponsorConnectionId: candidate.demand.connectionId,
        sponsorSessionId: candidate.demand.sessionId,
        sponsorSessionToken: candidate.session.sessionToken,
        firstDemandOrder: candidate.firstDemandOrder,
        claimGenerations: new Map(),
        drainRequested: false,
      };
      this.#ownedExecutionLeases.set(slot, authority);
      this.#executionLeaseAuthorities.set(handle, authority);
      this.#scheduleExecutionLeaseExpiry();
      return handle;
    }
    return null;
  }

  async currentExecutionLease(
    space: string,
    branch: BranchName,
  ): Promise<ExecutionLease | null> {
    const engine = await this.openEngine(space);
    const nowMs = () => this.#executionNowMs();
    const current = await Engine.currentExecutionLease(engine, {
      space,
      branch,
      nowMs,
    });
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(space, branch),
    );
    if (current === null) {
      if (owned !== undefined) {
        const expired = Engine.expireExecutionLease(engine, {
          lease: owned.handle,
          nowMs,
        });
        if (
          expired !== null && this.#sameExecutionLease(expired, owned.handle)
        ) {
          this.#releaseOwnedExecutionLease(owned, expired);
        } else {
          this.#abandonOwnedExecutionLease(owned);
        }
      }
      return null;
    }
    if (
      owned === undefined || !this.#sameExecutionLease(current, owned.handle)
    ) {
      if (owned !== undefined) this.#abandonOwnedExecutionLease(owned);
      return current;
    }
    if (
      current.state !== owned.handle.state ||
      current.expiresAt !== owned.handle.expiresAt
    ) {
      const handle = this.#createExecutionLeaseHandle(current);
      owned.handle = handle;
      this.#executionLeaseAuthorities.set(handle, owned);
    }
    return owned.handle;
  }

  /** Host-local interlock for the shared executor pool. */
  async legacyBackgroundActive(
    space: string,
    branch: BranchName,
  ): Promise<boolean> {
    const engine = await this.openEngine(space);
    return Engine.currentLegacyBackgroundExclusion(engine, {
      space,
      branch,
      nowMs: () => this.#executionNowMs(),
    }) !== null;
  }

  #fenceOwnedExecutionLeaseForLegacyBackground(
    space: string,
    branch: BranchName,
  ): void {
    const authority = this.#ownedExecutionLeases.get(
      executionLeaseKey(space, branch),
    );
    if (authority === undefined) return;
    // The durable exclusion transaction has already moved this exact lane to
    // draining. Reject every new claim/effect immediately, then let the pool's
    // synchronously awaited demand notification stop and revoke the Worker.
    authority.drainRequested = true;
    this.#revokeExecutionClaimsForLease(authority.handle);
  }

  #executionDrainTimeoutMs(): number {
    const timeoutMs = this.options.executionControl?.drainTimeoutMs ?? 5_000;
    if (!isPositiveSafeInteger(timeoutMs)) {
      throw new TypeError(
        "execution lease drain timeout must be a positive integer",
      );
    }
    return timeoutMs;
  }

  #replaceOwnedExecutionLease(
    authority: OwnedExecutionLease,
    lease: ExecutionLease,
  ): ExecutionLeaseHandle {
    const handle = this.#createExecutionLeaseHandle(lease);
    authority.handle = handle;
    this.#executionLeaseAuthorities.set(handle, authority);
    return handle;
  }

  #trackExecutionLeaseTask(task: Promise<void>): void {
    this.#executionLeaseTasks.add(task);
    void task.then(
      () => this.#executionLeaseTasks.delete(task),
      (error) => {
        this.#executionLeaseTasks.delete(task);
        console.warn("execution lease lifecycle task failed", error);
      },
    );
  }

  async flushExecutionLeaseTasks(): Promise<void> {
    while (this.#executionLeaseTasks.size > 0) {
      await Promise.allSettled([...this.#executionLeaseTasks]);
    }
  }

  #scheduleExecutionLeaseExpiry(): void {
    if (this.#executionLeaseExpiryTimer !== null) {
      clearTimeout(this.#executionLeaseExpiryTimer);
      this.#executionLeaseExpiryTimer = null;
    }
    if (this.#ownedExecutionLeases.size === 0) return;
    const nextExpiry = Math.min(
      ...[...this.#ownedExecutionLeases.values()].map((owned) =>
        owned.handle.expiresAt
      ),
    );
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, nextExpiry - this.#executionNowMs()),
    );
    this.#executionLeaseExpiryTimer = setTimeout(() => {
      this.#executionLeaseExpiryTimer = null;
      this.#trackExecutionLeaseTask(
        this.expireExecutionLeases().then(() => undefined),
      );
    }, delay);
  }

  #revokeExecutionClaimsForLease(lease: ExecutionLease): number {
    let revoked = 0;
    for (const [key, claim] of this.#executionClaims) {
      if (
        claim.space !== lease.space || claim.branch !== lease.branch ||
        claim.leaseGeneration !== lease.leaseGeneration
      ) continue;
      this.#executionClaims.delete(key);
      this.#executionClaimLaneBindings.delete(key);
      this.#publishExecutionClaimRevoke(claim);
      revoked += 1;
    }
    this.#scheduleExecutionClaimExpiry();
    return revoked;
  }

  #releaseOwnedExecutionLease(
    authority: OwnedExecutionLease,
    revoked: ExecutionLease,
  ): void {
    const slot = executionLeaseKey(revoked.space, revoked.branch);
    if (this.#ownedExecutionLeases.get(slot) === authority) {
      this.#ownedExecutionLeases.delete(slot);
    }
    this.#replaceOwnedExecutionLease(authority, revoked);
    this.#revokeExecutionClaimsForLease(revoked);
    authority.claimGenerations.clear();
    this.#scheduleExecutionLeaseExpiry();
  }

  /** Relinquish host-local authority without touching another generation's
   * durable row. This is the stale-host handoff path. */
  #abandonOwnedExecutionLease(authority: OwnedExecutionLease): void {
    const lease = authority.handle;
    const slot = executionLeaseKey(lease.space, lease.branch);
    if (this.#ownedExecutionLeases.get(slot) === authority) {
      this.#ownedExecutionLeases.delete(slot);
    }
    authority.drainRequested = true;
    this.#revokeExecutionClaimsForLease(lease);
    authority.claimGenerations.clear();
    this.#scheduleExecutionLeaseExpiry();
  }

  async renewExecutionLease(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(lease.space, lease.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      authority.drainRequested
    ) return null;
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) {
      await this.beginExecutionLeaseDrain(lease);
      return null;
    }
    const sponsor = this.#sessions.get(lease.space, authority.sponsorSessionId);
    if (sponsor === null) return null;
    const engine = await this.openEngine(lease.space);
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) {
      await this.beginExecutionLeaseDrain(lease);
      return null;
    }
    if (
      this.#executionLeaseAuthorities.get(lease) !== authority ||
      this.#ownedExecutionLeases.get(
          executionLeaseKey(lease.space, lease.branch),
        ) !== authority ||
      authority.drainRequested ||
      this.#sessions.get(lease.space, authority.sponsorSessionId) !== sponsor
    ) {
      return null;
    }
    const renewed = Engine.renewExecutionLease(engine, {
      lease: authority.handle,
      nowMs: () => this.#executionNowMs(),
      ttlMs: this.#executionLeaseTtlMs(),
      authorizeWrite: (transactionEngine) =>
        this.#executionLeaseSponsorCanWrite(
          transactionEngine,
          authority,
          sponsor,
        ),
    });
    if (renewed === null) return null;
    const handle = this.#replaceOwnedExecutionLease(authority, renewed);
    this.#scheduleExecutionLeaseExpiry();
    return handle;
  }

  async beginExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(lease.space, lease.branch),
    );
    if (authority === undefined || authority !== owned) return null;
    authority.drainRequested = true;
    const engine = await this.openEngine(lease.space);
    const draining = Engine.beginExecutionLeaseDrain(engine, {
      lease: authority.handle,
      nowMs: () => this.#executionNowMs(),
      drainTtlMs: this.#executionDrainTimeoutMs(),
    });
    if (draining === null) return null;
    const handle = this.#replaceOwnedExecutionLease(authority, draining);
    this.#scheduleExecutionLeaseExpiry();
    return handle;
  }

  async finishExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null> {
    const authority = this.#executionLeaseAuthorities.get(lease);
    if (authority === undefined) return null;
    const engine = await this.openEngine(lease.space);
    const revoked = Engine.revokeExecutionLease(engine, {
      lease: authority.handle,
      nowMs: () => this.#executionNowMs(),
    });
    if (revoked === null) return null;
    this.#releaseOwnedExecutionLease(authority, revoked);
    return revoked;
  }

  async expireExecutionLeases(nowMs?: number): Promise<number> {
    if (nowMs !== undefined && !Number.isFinite(nowMs)) {
      throw new TypeError("execution lease expiry time must be finite");
    }
    let expired = 0;
    for (const authority of [...this.#ownedExecutionLeases.values()]) {
      const lease = authority.handle;
      const engine = await this.openEngine(lease.space);
      const revoked = Engine.expireExecutionLease(engine, {
        lease,
        nowMs: nowMs ?? (() => this.#executionNowMs()),
      });
      if (revoked === null) {
        const current = await Engine.currentExecutionLease(engine, {
          space: lease.space,
          branch: lease.branch,
          nowMs: nowMs ?? (() => this.#executionNowMs()),
        });
        if (current === null || !this.#sameExecutionLease(current, lease)) {
          this.#abandonOwnedExecutionLease(authority);
        }
        continue;
      }
      this.#releaseOwnedExecutionLease(authority, revoked);
      expired += 1;
    }
    this.#scheduleExecutionLeaseExpiry();
    return expired;
  }

  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void {
    this.#executionDemandListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#executionDemandListeners.delete(listener);
    };
  }

  /**
   * Resolve demanded stale readers for a host execution lane. This is a
   * process API, not a client protocol command: the caller supplies effective
   * scope keys, server-derived execution contexts, and canonical scheduler
   * piece ids.
   */
  async staleReadersForTargets(
    space: string,
    options: Omit<
      Engine.SchedulerStaleReadersForTargetsOptions,
      "ownerSpace"
    >,
  ): Promise<Engine.SchedulerActionState[]> {
    const engine = await this.openEngine(space);
    return Engine.staleReadersForTargets(engine, {
      ...options,
      ownerSpace: space,
    });
  }

  #nextExecutionDemandSnapshot(
    space: string,
    branch: BranchName,
  ): ExecutionDemandSnapshot {
    return Object.freeze({
      space,
      branch,
      order: ++this.#executionDemandOrder,
      demands: this.listExecutionDemands(space, branch),
    });
  }

  #publishExecutionDemands(space: string, branch: BranchName): void {
    const snapshot = this.#nextExecutionDemandSnapshot(space, branch);
    // C3.3a: demand churn re-derives the foreign-reader subscriptions
    // (fire-and-forget; coalesced per (space, branch)).
    this.scheduleForeignReaderSubscriptionReconcile(space, branch);
    for (const listener of this.#executionDemandListeners) {
      try {
        const result = listener(snapshot);
        if (result instanceof Promise) {
          void result.catch((error) =>
            console.warn("execution demand listener failed", error)
          );
        }
      } catch (error) {
        console.warn("execution demand listener failed", error);
      }
    }
  }

  async #publishExecutionDemandsAndWait(
    space: string,
    branch: BranchName,
  ): Promise<void> {
    const snapshot = this.#nextExecutionDemandSnapshot(space, branch);
    // C3.3a: same trigger as the fire-and-forget publish — the await
    // below covers demand listeners only, never the cross-space barrier.
    this.scheduleForeignReaderSubscriptionReconcile(space, branch);
    await Promise.all(
      [...this.#executionDemandListeners].map((listener) =>
        Promise.resolve().then(() => listener(snapshot))
      ),
    );
  }

  #drainExecutionLeasesForDemand(
    connectionId: string,
    space: string,
    sessionId: string,
    branch: BranchName,
  ): void {
    const authority = this.#ownedExecutionLeases.get(
      executionLeaseKey(space, branch),
    );
    if (
      authority === undefined || authority.drainRequested ||
      authority.sponsorConnectionId !== connectionId ||
      authority.sponsorSessionId !== sessionId
    ) return;
    authority.drainRequested = true;
    this.#trackExecutionLeaseTask(
      this.beginExecutionLeaseDrain(authority.handle).then(() => undefined),
    );
  }

  async #drainIneligibleExecutionLeases(
    engine: Engine.Engine,
    space: string,
  ): Promise<ReadonlySet<BranchName>> {
    const affectedBranches = new Set<BranchName>();
    const drains: Promise<void>[] = [];
    for (const authority of this.#ownedExecutionLeases.values()) {
      const lease = authority.handle;
      if (
        lease.space !== space || authority.drainRequested ||
        lease.state !== "active"
      ) continue;
      const sponsor = this.#sessions.get(space, authority.sponsorSessionId);
      if (
        sponsor !== null &&
        this.#executionLeaseSponsorCanWrite(engine, authority, sponsor)
      ) continue;
      authority.drainRequested = true;
      affectedBranches.add(lease.branch);
      const drain = this.beginExecutionLeaseDrain(lease).then(() => undefined);
      this.#trackExecutionLeaseTask(drain);
      drains.push(drain);
    }
    // The ACL commit is already durable, so lifecycle failures remain
    // contained by the tracked-task logger. Successful drains, however, must
    // reach durable `draining` before replacement demand is reconciled.
    await Promise.allSettled(drains);
    return affectedBranches;
  }

  #removeExecutionDemands(match: {
    connectionId: string;
    space?: string;
    sessionId?: string;
  }): void {
    const changed = new Map<string, { space: string; branch: BranchName }>();
    for (const [key, demand] of this.#executionDemands) {
      if (
        demand.connectionId !== match.connectionId ||
        (match.space !== undefined && demand.space !== match.space) ||
        (match.sessionId !== undefined && demand.sessionId !== match.sessionId)
      ) {
        continue;
      }
      this.#executionDemands.delete(key);
      this.#executionDemandRegistrationOrder.delete(key);
      this.#executionDemandSessionTokens.delete(key);
      this.#drainExecutionLeasesForDemand(
        demand.connectionId,
        demand.space,
        demand.sessionId,
        demand.branch,
      );
      changed.set(
        encodeMemoryBoundary([demand.space, demand.branch]),
        { space: demand.space, branch: demand.branch },
      );
    }
    for (const { space, branch } of changed.values()) {
      this.#publishExecutionDemands(space, branch);
    }
  }

  async setExecutionDemand(
    message: ExecutionDemandSetRequest,
    connection: Connection,
  ): Promise<ResponseMessage<ExecutionDemandSetResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (
      session === null || session.ownerConnectionId !== connection.id ||
      session.principal === undefined
    ) {
      return respondTypedError<ExecutionDemandSetResult>(
        message.requestId,
        toError(
          "AuthorizationError",
          "execution demand requires an authenticated attached session",
        ),
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
        return respondTypedError<ExecutionDemandSetResult>(
          message.requestId,
          deny,
        );
      }
      const key = executionDemandKey(
        connection.id,
        message.space,
        message.sessionId,
        message.branch,
      );
      if (message.pieces.length === 0) {
        this.#executionDemands.delete(key);
        this.#executionDemandRegistrationOrder.delete(key);
        this.#executionDemandSessionTokens.delete(key);
      } else {
        if (
          !this.#executionDemandRegistrationOrder.has(key) ||
          this.#executionDemandSessionTokens.get(key) !== session.sessionToken
        ) {
          this.#executionDemandRegistrationOrder.set(
            key,
            ++this.#nextExecutionDemandRegistrationOrder,
          );
        }
        this.#executionDemandSessionTokens.set(key, session.sessionToken);
        this.#executionDemands.set(
          key,
          Object.freeze({
            space: message.space,
            branch: message.branch,
            sessionId: message.sessionId,
            connectionId: connection.id,
            principal: session.principal,
            pieces: Object.freeze([...message.pieces]),
            negotiatesContextLatticeClaims:
              session.serverPrimaryExecutionContextLatticeClaimsV1,
          }),
        );
      }
      this.#publishExecutionDemands(message.space, message.branch);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          references: this.listExecutionDemands(
            message.space,
            message.branch,
          ).length,
        },
      };
    } catch (error) {
      return respondTypedError<ExecutionDemandSetResult>(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "ExecutionDemandError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  #legacyBackgroundSession(
    space: string,
    sessionId: string,
    connection: Connection,
  ): SessionState | null {
    const session = this.#sessions.get(space, sessionId);
    if (
      session === null || session.ownerConnectionId !== connection.id ||
      session.principal === undefined ||
      !session.serverPrimaryExecutionV1 ||
      !this.#isServicePrincipal(session.principal)
    ) {
      return null;
    }
    return session;
  }

  #legacyBackgroundHolderId(session: SessionState): string {
    return [
      "legacy-background",
      encodeURIComponent(this.#executionHostId),
      encodeURIComponent(session.id),
    ].join(":");
  }

  #legacyBackgroundAuthorize(
    space: string,
    session: SessionState,
    connection: Connection,
  ): () => boolean {
    const sessionToken = session.sessionToken;
    const principal = session.principal!;
    return () =>
      this.#sessions.get(space, session.id) === session &&
      session.ownerConnectionId === connection.id &&
      session.sessionToken === sessionToken &&
      session.principal === principal && this.#isServicePrincipal(principal);
  }

  #legacyBackgroundToken(
    message:
      | LegacyBackgroundExclusionRenewRequest
      | LegacyBackgroundExclusionReleaseRequest,
    session: SessionState,
  ): LegacyBackgroundExclusion {
    return {
      version: 1,
      space: message.space,
      branch: message.branch,
      exclusionGeneration: message.exclusionGeneration,
      holderId: this.#legacyBackgroundHolderId(session),
      servicePrincipal: session.principal!,
      // Engine exact-owner matching intentionally ignores the caller snapshot
      // expiry. The server derives every authority-bearing field above.
      expiresAt: 0,
    };
  }

  async #completeLegacyBackgroundTransition(
    engine: Engine.Engine,
    status: LegacyBackgroundExclusionStatus | null,
    session: SessionState,
    connection: Connection,
  ): Promise<LegacyBackgroundExclusionStatus | null> {
    if (status === null) return null;
    this.#fenceOwnedExecutionLeaseForLegacyBackground(
      status.exclusion.space,
      status.exclusion.branch,
    );
    // A ready response is authority: do not release it until every host-local
    // pool listener has finished fencing and stopping its matching Worker.
    await this.#publishExecutionDemandsAndWait(
      status.exclusion.space,
      status.exclusion.branch,
    );
    const refreshed = Engine.renewLegacyBackgroundExclusion(engine, {
      exclusion: status.exclusion,
      nowMs: () => this.#executionNowMs(),
      ttlMs: this.#executionLeaseTtlMs(),
      drainTtlMs: this.#executionDrainTimeoutMs(),
      authorizeService: this.#legacyBackgroundAuthorize(
        status.exclusion.space,
        session,
        connection,
      ),
    });
    if (refreshed === null) {
      throw new Error(
        "legacy background exclusion changed while fencing client execution",
      );
    }
    return refreshed;
  }

  async acquireLegacyBackgroundExclusion(
    message: LegacyBackgroundExclusionAcquireRequest,
    connection: Connection,
  ): Promise<ResponseMessage<LegacyBackgroundExclusionStatusResult>> {
    const session = this.#legacyBackgroundSession(
      message.space,
      message.sessionId,
      connection,
    );
    if (session === null) {
      return respondTypedError(
        message.requestId,
        toError(
          "AuthorizationError",
          "legacy background exclusion requires an attached service principal",
        ),
      );
    }
    try {
      const engine = await this.openEngine(message.space);
      const acquired = Engine.acquireLegacyBackgroundExclusion(engine, {
        space: message.space,
        branch: message.branch,
        holderId: this.#legacyBackgroundHolderId(session),
        servicePrincipal: session.principal!,
        nowMs: () => this.#executionNowMs(),
        ttlMs: this.#executionLeaseTtlMs(),
        drainTtlMs: this.#executionDrainTimeoutMs(),
        authorizeService: this.#legacyBackgroundAuthorize(
          message.space,
          session,
          connection,
        ),
      });
      const status = await this.#completeLegacyBackgroundTransition(
        engine,
        acquired,
        session,
        connection,
      );
      return {
        type: "response",
        requestId: message.requestId,
        ok: { serverSeq: Engine.serverSeq(engine), status },
      };
    } catch (error) {
      return respondTypedError(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "BackgroundExclusionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async renewLegacyBackgroundExclusion(
    message: LegacyBackgroundExclusionRenewRequest,
    connection: Connection,
  ): Promise<ResponseMessage<LegacyBackgroundExclusionStatusResult>> {
    const session = this.#legacyBackgroundSession(
      message.space,
      message.sessionId,
      connection,
    );
    if (session === null) {
      return respondTypedError(
        message.requestId,
        toError(
          "AuthorizationError",
          "legacy background exclusion requires an attached service principal",
        ),
      );
    }
    try {
      const engine = await this.openEngine(message.space);
      const renewed = Engine.renewLegacyBackgroundExclusion(engine, {
        exclusion: this.#legacyBackgroundToken(message, session),
        nowMs: () => this.#executionNowMs(),
        ttlMs: this.#executionLeaseTtlMs(),
        drainTtlMs: this.#executionDrainTimeoutMs(),
        authorizeService: this.#legacyBackgroundAuthorize(
          message.space,
          session,
          connection,
        ),
      });
      const status = await this.#completeLegacyBackgroundTransition(
        engine,
        renewed,
        session,
        connection,
      );
      return {
        type: "response",
        requestId: message.requestId,
        ok: { serverSeq: Engine.serverSeq(engine), status },
      };
    } catch (error) {
      return respondTypedError(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "BackgroundExclusionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async releaseLegacyBackgroundExclusion(
    message: LegacyBackgroundExclusionReleaseRequest,
    connection: Connection,
  ): Promise<ResponseMessage<LegacyBackgroundExclusionReleaseResult>> {
    const session = this.#legacyBackgroundSession(
      message.space,
      message.sessionId,
      connection,
    );
    if (session === null) {
      return respondTypedError(
        message.requestId,
        toError(
          "AuthorizationError",
          "legacy background exclusion requires an attached service principal",
        ),
      );
    }
    try {
      const engine = await this.openEngine(message.space);
      const released = Engine.releaseLegacyBackgroundExclusion(engine, {
        exclusion: this.#legacyBackgroundToken(message, session),
        nowMs: () => this.#executionNowMs(),
        authorizeService: this.#legacyBackgroundAuthorize(
          message.space,
          session,
          connection,
        ),
      });
      if (released !== null) {
        this.#publishExecutionDemands(message.space, message.branch);
      }
      return {
        type: "response",
        requestId: message.requestId,
        ok: { serverSeq: Engine.serverSeq(engine), released },
      };
    } catch (error) {
      return respondTypedError(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "BackgroundExclusionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /**
   * THE delivery predicate (amendment 21): the one filter feeding publish
   * (#publishExecutionControl), reconnect-snapshot claims
   * (#executionClaimsForSession), retained events, and settlement frontiers
   * (attachExecutionFeed). Context-scoped delivery (C1.7): a `user:`/
   * `session:` claim is accepted only by sessions that negotiated
   * context-lattice-claims-v1 on their current attach AND whose principal is
   * the claim's, compared through the canonical key helpers (amendment 18).
   * C2.6 (context-lattice §2, amendment CA4): a `session:` claim is
   * additionally accepted ONLY by the exact session its contextKey names —
   * never a sibling session of the same principal. Sibling delivery is not
   * benign fan-out: the client's registered-action index is CHAIN-keyed
   * (contextKey stripped), so a delivered-then-revoked sibling claim fires
   * `execution-claim-invalidation` on the sibling's own registration of the
   * same logical action — a spurious fail-open rerun on every claim churn,
   * quadratic in a principal's concurrent sessions. The per-session
   * negotiation check needs no principal-wide cohort fence at session rank:
   * a session claim only ever suppresses its named session under the
   * client's own-chain acceptance, and a non-negotiating attach of the SAME
   * session id cannot coexist with a live session lane — the session's
   * negotiation flag is recomputed on every attach and the amendment-11
   * admission fence (#fenceLanesForNonNegotiatingAttach, session leg since
   * C2.3) drains the attaching session's own lane before the open response
   * releases. Space claims keep their pre-C1.7 delivery byte-identically.
   */
  #sessionAcceptsClaim(
    session: SessionState,
    claim: ActionClaimKey & { crossSpaceReadSpaces?: readonly string[] },
  ): boolean {
    if (!session.serverPrimaryExecutionV1) return false;
    // C3.6b delivery gate: a cross-space-read-capable claim (a non-empty
    // `crossSpaceReadSpaces`) delivers ONLY to sessions negotiating
    // cross-space-claims-v1 — the amendment-11 subcapability narrowing,
    // mirroring the context-lattice gate below. A same-space claim (the
    // overwhelming default) has no marker and this is inert, so pre-C3.6
    // delivery stays byte-identical.
    if (
      claim.crossSpaceReadSpaces !== undefined &&
      claim.crossSpaceReadSpaces.length > 0 &&
      !session.serverPrimaryExecutionCrossSpaceClaimsV1
    ) {
      return false;
    }
    if (claim.contextKey !== "space") {
      if (!session.serverPrimaryExecutionContextLatticeClaimsV1) return false;
      const sessionIdentity = Engine.parseSessionExecutionContextKey(
        claim.contextKey,
      );
      if (sessionIdentity !== undefined) {
        if (
          sessionIdentity.principal !== session.principal ||
          sessionIdentity.sessionId !== session.id
        ) {
          return false;
        }
      } else {
        const principal = Engine.principalOfUserContextKey(claim.contextKey);
        if (principal === undefined || principal !== session.principal) {
          return false;
        }
      }
    }
    if (claim.actionKind === "computation") {
      return session.serverPrimaryExecutionClaimRoutingV1;
    }
    if (claim.actionKind === "effect") {
      return session.serverPrimaryExecutionBuiltinPassivityV1;
    }
    return false;
  }

  #eventClaim(
    event: ExecutionControlEvent,
  ): ActionClaimKey & { crossSpaceReadSpaces?: readonly string[] } {
    switch (event.type) {
      case "session.execution.claim.set":
        return event.claim;
      case "session.execution.claim.revoke":
        // C3.6b: fold the revoke's cross-space-read marker back onto the
        // canonical key so the delivery gate narrows the revoke to the same
        // cohort as the claim.set (see #publishExecutionClaimRevoke).
        return event.crossSpaceReadSpaces !== undefined
          ? { ...event.claim, crossSpaceReadSpaces: event.crossSpaceReadSpaces }
          : event.claim;
      case "session.execution.settlement":
        return event.settlement.claim;
    }
  }

  #executionClaimsForSession(session: SessionState): ExecutionClaim[] {
    return [...this.#executionClaims.values()]
      .filter((claim) =>
        claim.space === session.space &&
        this.#sessionAcceptsClaim(session, claim)
      )
      .sort((left, right) =>
        left.branch.localeCompare(right.branch) ||
        actionClaimMapKey(left).localeCompare(actionClaimMapKey(right))
      );
  }

  #boundExecutionSessionForCommit(
    space: string,
    branch: BranchName,
    session: SessionState,
  ): BoundExecutionSession | undefined {
    const binding = this.#boundExecutionSessions.get(
      sessionKey(space, session.id),
    );
    if (binding === undefined) return undefined;
    if (
      session.principal === undefined || session.principal === ANYONE_USER ||
      session.ownerConnectionId === null ||
      binding.connectionId !== session.ownerConnectionId ||
      binding.sessionToken !== session.sessionToken ||
      binding.principal !== session.principal ||
      !this.#connections.has(binding.connectionId)
    ) {
      throw new Engine.ProtocolError(
        "execution authority is not bound to this live session connection",
      );
    }
    if (binding.lease.space !== space || binding.lease.branch !== branch) {
      throw new Engine.ProtocolError(
        "execution authority is not bound to this branch and space",
      );
    }
    return binding;
  }

  #scopeContextForSession(
    space: string,
    session: SessionState,
  ): { principal?: string; sessionId: string } {
    const binding = this.#boundExecutionSessions.get(
      sessionKey(space, session.id),
    );
    if (binding === undefined) {
      return { principal: session.principal, sessionId: session.id };
    }
    if (
      binding.connectionId !== session.ownerConnectionId ||
      binding.sessionToken !== session.sessionToken ||
      binding.principal !== session.principal || binding.lease.space !== space
    ) {
      throw new Engine.ProtocolError(
        "execution scope is not bound to this live session connection",
      );
    }
    return {
      principal: session.principal,
      sessionId: binding.sponsorSessionId,
    };
  }

  /**
   * C1.4b lane-scoped READ seam (context-lattice §3, amendment 1; session
   * lanes since C2.4): a lease-bound executor session may name a per-request
   * acting context; the host validates it against the LIVE lane grant of the
   * binding's (space, branch) BEFORE any scope key resolves — the same
   * live-registry consult the commit fence's laneAuthority makes, so a
   * drained (stale-generation) incarnation rejects identically — with the
   * constant-shape C1.3 fence-cause vocabulary. A USER acting context
   * resolves under (grant.principal, base.sessionId): user scope keys ignore
   * the session id, so the sponsor's id is inert there. A SESSION acting
   * context resolves under the GRANT's OWN (principal, sessionId) — NEVER
   * base.sessionId (amendment CA8): base is the sponsor/executor session, so
   * threading it into session-scope resolution would resolve a DIFFERENT
   * session's instances of the same principal — the cross-session
   * confidentiality trap. A grant for a different session is simply a miss
   * in the live registry (the canonical context key IS the registry key) and
   * rejects in the same constant shape as an absent or fenced grant.
   * Requests without an acting context — and every non-lease session — keep
   * today's session-derived scope context byte-identically.
   */
  #actingReadScopeContext(
    space: string,
    session: SessionState,
    actingContext: SchedulerExecutionContextKey | undefined,
  ):
    | { ok: { principal?: string; sessionId: string }; error?: never }
    | { ok?: never; error: V2Error } {
    const base = this.#scopeContextForSession(space, session);
    if (actingContext === undefined || actingContext === "space") {
      return { ok: base };
    }
    const binding = this.#boundExecutionSessions.get(
      sessionKey(space, session.id),
    );
    if (binding === undefined) {
      return {
        error: toError(
          "ProtocolError",
          "acting contexts require a lease-bound executor session",
        ),
      };
    }
    const principal = Engine.principalOfUserContextKey(actingContext);
    if (principal !== undefined) {
      const grant = this.#userLaneGrants.get(
        laneGrantKey(
          space,
          binding.lease.branch,
          actingContext as `user:${string}`,
        ),
      );
      if (grant === undefined) {
        return { error: laneReadRejection() };
      }
      return { ok: { principal: grant.principal, sessionId: base.sessionId } };
    }
    if (Engine.parseSessionExecutionContextKey(actingContext) === undefined) {
      return {
        error: toError("ProtocolError", "malformed acting context"),
      };
    }
    const grant = this.#sessionLaneGrants.get(
      laneGrantKey(space, binding.lease.branch, actingContext),
    );
    if (grant === undefined) {
      return { error: laneReadRejection() };
    }
    // CA8: the GRANT's session id — never the sponsor-derived base's.
    return { ok: { principal: grant.principal, sessionId: grant.sessionId } };
  }

  /**
   * C1.4b (amendment 1, part 3): a lease-bound executor session's
   * applicable scheduler contexts derive from its OPEN lane grants — never
   * from the sponsor principal, whose own user/session rows stay
   * client-primary. A per-request acting context narrows the set to that
   * one lane (plus the shared space lane). Non-lease sessions keep the
   * principal-derived set byte-identically.
   */
  #schedulerApplicableContextKeysForSession(
    space: string,
    session: SessionState,
    scopeContext: { principal?: string; sessionId: string },
    actingContext?: SchedulerExecutionContextKey,
  ): SchedulerExecutionContextKey[] {
    const binding = this.#boundExecutionSessions.get(
      sessionKey(space, session.id),
    );
    if (binding === undefined) {
      return schedulerApplicableContextKeys(
        scopeContext.principal,
        scopeContext.sessionId,
      );
    }
    if (actingContext !== undefined && actingContext !== "space") {
      return ["space", actingContext];
    }
    const keys: SchedulerExecutionContextKey[] = ["space"];
    for (const grant of this.#userLaneGrants.values()) {
      if (grant.space === space && grant.branch === binding.lease.branch) {
        keys.push(grant.contextKey as SchedulerExecutionContextKey);
      }
    }
    // C2.4: open SESSION lane grants contribute their lanes exactly like
    // user grants — the executor's applicable contexts derive from its open
    // lanes of either rank, never from the sponsor principal.
    for (const grant of this.#sessionLaneGrants.values()) {
      if (grant.space === space && grant.branch === binding.lease.branch) {
        keys.push(grant.contextKey as SchedulerExecutionContextKey);
      }
    }
    return keys;
  }

  #executionLeaseFenceForCommit(
    space: string,
    session: SessionState,
    binding: BoundExecutionSession | undefined,
  ): Engine.ExecutionLeaseFence | undefined {
    if (binding === undefined) return undefined;
    const authority = this.#executionLeaseAuthorities.get(binding.lease);
    const lease = authority?.handle ?? binding.lease;
    return {
      lease,
      nowMs: () => this.#executionNowMs(),
      // C1.3 commit-side lane fencing (session lanes since C2.3): a scoped
      // claim commits only while its lane grant — user or session, resolved
      // through the shared binding — is live at the generation bound at
      // issuance; the engine rejects otherwise with the counted cause
      // `lane-generation-stale`.
      laneAuthority: (claim) => {
        const binding = this.#executionClaimLaneBindings.get(
          actionClaimMapKey(claim),
        );
        return binding !== undefined &&
          this.#liveLaneGrantForKey(binding.laneKey)?.laneGeneration ===
            binding.laneGeneration;
      },
      // C1.4 (amendment 2): the same transaction-time authorize also
      // resolves WRITE for the ACTING principal of a scoped claim, so a
      // mid-run ACL revocation of the lane principal fences the in-flight
      // commit instead of landing rows under her scope.
      authorizeActingPrincipal: (transactionEngine, principal) => {
        const capability = this.#resolveCapability(
          transactionEngine,
          space,
          principal,
        );
        return capability !== null && isCapable(capability, "WRITE");
      },
      authorize: (transactionEngine) => {
        if (
          this.#sessions.get(space, session.id) !== session ||
          this.#boundExecutionSessions.get(sessionKey(space, session.id)) !==
            binding ||
          session.principal !== lease.onBehalfOf
        ) {
          return false;
        }
        const capability = this.#resolveCapability(
          transactionEngine,
          space,
          session.principal,
        );
        return this.memoryProtocolFlags().serverPrimaryExecutionV1 &&
          capability !== null && isCapable(capability, "WRITE");
      },
    };
  }

  #executionClaimsForCommit(
    space: string,
    branch: BranchName,
    binding: BoundExecutionSession | undefined,
    observations: readonly CommitSchedulerObservation[],
  ): ReadonlyMap<number, ExecutionClaim> | undefined {
    if (binding === undefined) return undefined;
    const claims = new Map<number, ExecutionClaim>();
    let claimsExpired = false;
    for (const { localSeq, observation } of observations) {
      if (
        observation.actionKind === "event-handler" ||
        observation.transactionKind !== "action-run"
      ) {
        if (observation.executionClaimAssertion !== undefined) {
          throw new Engine.ProtocolError(
            "execution claim assertions are valid only for action attempts",
          );
        }
        continue;
      }
      const expected = observation.executionClaimAssertion;
      if (expected === undefined) {
        throw new Engine.ProtocolError(
          "bound executor action is missing an execution claim incarnation",
        );
      }
      if (!claimsExpired) {
        this.expireExecutionClaims();
        claimsExpired = true;
      }
      const key: ActionClaimKey = {
        branch,
        space,
        contextKey: expected.contextKey,
        pieceId: observation.pieceId,
        actionId: observation.actionId,
        actionKind: observation.actionKind,
        implementationFingerprint: observation.implementationFingerprint,
        runtimeFingerprint: observation.runtimeFingerprint,
      };
      const live = this.#executionClaims.get(actionClaimMapKey(key));
      if (
        live !== undefined &&
        live.leaseGeneration === binding.lease.leaseGeneration &&
        live.leaseGeneration === expected.leaseGeneration &&
        live.claimGeneration === expected.claimGeneration
      ) {
        claims.set(localSeq, live);
      }
    }
    return claims.size > 0 ? claims : undefined;
  }

  /**
   * C3.5: turn each claimed observation's Worker-asserted
   * `foreignReadStamps` into HOST-VALIDATED provenance components, keyed by
   * localSeq for `ApplyCommitOptions.foreignInputBases`.
   *
   * The validation source is `#servedForeignReadStamps` — the host's own
   * record of what it served THIS claim incarnation over the authenticated
   * link (C3A13): an asserted (space, id, seq) is admitted iff a recorded
   * served stamp matches it EXACTLY; everything else is dropped and counted
   * (`foreignBasisAssertionsStripped`) — the vector analogue of the
   * asserted-scalar strip, failing toward vacuous coverage, never toward a
   * fabricated basis. Per space, the surviving stamps aggregate to one
   * component: seq = max (the covering frontier), epoch = min (C3.8's
   * equality fence must fail if ANY consumed read predates an authorization
   * change; epochs only grow, so min is the strictest stamped value).
   *
   * The engine applies the remaining authority checks (declared-read
   * restriction, home-component authorship, the strip of raw assertions) —
   * this method never touches the commit itself.
   */
  #foreignInputBasesForCommit(
    executionClaims: ReadonlyMap<number, ExecutionClaim> | undefined,
    observations: readonly CommitSchedulerObservation[],
  ):
    | ReadonlyMap<number, readonly ProvenanceInputBasisComponent[]>
    | undefined {
    if (executionClaims === undefined) return undefined;
    let swept = false;
    const bases = new Map<
      number,
      readonly ProvenanceInputBasisComponent[]
    >();
    for (const { localSeq, observation } of observations) {
      const asserted = observation.foreignReadStamps;
      if (asserted === undefined || asserted.length === 0) continue;
      const claim = executionClaims.get(localSeq);
      if (claim === undefined) {
        this.executionStats.foreignBasisAssertionsStripped += asserted.length;
        continue;
      }
      if (!swept) {
        this.#sweepServedForeignReadStamps();
        swept = true;
      }
      const served = this.#servedForeignReadStamps.get(
        executionClaimIncarnationKey(claim),
      );
      const perSpace = new Map<string, {
        seq: number;
        epoch: ForeignAuthorizationEpochStamp;
      }>();
      for (const assertion of asserted) {
        const match = served
          ?.get(`${assertion.space}\0${assertion.id}`)
          ?.find((stamp) => stamp.seq === assertion.seq);
        if (
          match === undefined ||
          match.authorizationEpoch.space !== assertion.space
        ) {
          this.executionStats.foreignBasisAssertionsStripped += 1;
          continue;
        }
        const held = perSpace.get(assertion.space);
        if (held === undefined) {
          perSpace.set(assertion.space, {
            seq: match.seq,
            epoch: match.authorizationEpoch,
          });
          continue;
        }
        if (held.epoch.principal !== match.authorizationEpoch.principal) {
          // Defensive: one claim incarnation resolves ONE acting principal
          // (the lease sponsor or the bound lane grant), so per-space
          // stamps cannot legitimately disagree. Fail the whole space
          // toward vacuous rather than pick a side.
          this.executionStats.foreignBasisAssertionsStripped += 1;
          perSpace.delete(assertion.space);
          continue;
        }
        perSpace.set(assertion.space, {
          seq: Math.max(held.seq, match.seq),
          epoch: held.epoch.epoch <= match.authorizationEpoch.epoch
            ? held.epoch
            : match.authorizationEpoch,
        });
      }
      if (perSpace.size === 0) continue;
      const components = [...perSpace.entries()].map((
        [space, { seq, epoch }],
      ): ProvenanceInputBasisComponent => ({
        space,
        seq: toInputBasisSeq(seq),
        authorizationEpoch: {
          principal: epoch.principal,
          epoch: epoch.epoch,
        },
      }));
      this.executionStats.foreignBasisComponentsValidated += components.length;
      bases.set(localSeq, components);
    }
    return bases.size > 0 ? bases : undefined;
  }

  #executionControlSync(
    session: SessionState,
    event: ExecutionControlEvent,
  ): SessionSync {
    const { fromFeedSeq, toFeedSeq } = this.#sessions.appendExecutionEvent(
      session,
      event,
    );
    return {
      type: "sync",
      fromSeq: session.lastSyncedSeq,
      toSeq: session.lastSyncedSeq,
      upserts: [],
      removes: [],
      execution: {
        fromFeedSeq,
        toFeedSeq,
        events: [event],
      },
    };
  }

  #publishExecutionControl(event: ExecutionControlEvent): void {
    const claim = this.#eventClaim(event);
    for (const session of this.#sessions.sessionsForSpace(claim.space)) {
      if (!this.#sessionAcceptsClaim(session, claim)) continue;
      const sync = this.#executionControlSync(session, event);
      if (session.ownerConnectionId !== null) {
        this.#connections.get(session.ownerConnectionId)?.sendExecutionEffect(
          session.space,
          session.id,
          sync,
        );
      }
    }
  }

  attachExecutionFeed(
    space: string,
    sessionId: string,
    sync: SessionSync,
    options: { snapshotFromFeedSeq?: number } = {},
  ): SessionSync {
    const session = this.#sessions.get(space, sessionId);
    if (session === null || !session.serverPrimaryExecutionV1) return sync;
    this.expireExecutionClaims();
    const snapshotFrom = options.snapshotFromFeedSeq;
    const fromFeedSeq = snapshotFrom === undefined
      ? session.executionFeedSeq
      : Math.max(0, Math.min(snapshotFrom, session.executionFeedSeq));
    const eventEntries = snapshotFrom === undefined
      ? []
      : session.executionEvents
        .filter((entry) =>
          entry.feedSeq > fromFeedSeq &&
          this.#sessionAcceptsClaim(session, this.#eventClaim(entry.event))
        );
    // A reconnect snapshot summarizes successful settlements below. Retained
    // failed/unserved outcomes remain ordinary ordered events; replaying a
    // successful event as well as its frontier would reconcile it twice.
    const events = eventEntries
      .map((entry) => entry.event)
      .filter((event) =>
        event.type !== "session.execution.settlement" ||
        (event.settlement.outcome !== "committed" &&
          event.settlement.outcome !== "no-op")
      );
    const claims = snapshotFrom === undefined
      ? []
      : this.#executionClaimsForSession(session);
    const liveIncarnations = new Set(
      claims.map(executionClaimIncarnationKey),
    );
    const settlementFrontiers = snapshotFrom === undefined
      ? []
      : [...session.executionSettlementFrontiers.values()]
        .filter((frontier) =>
          frontier.throughFeedSeq > fromFeedSeq &&
          liveIncarnations.has(executionClaimIncarnationKey(frontier.claim)) &&
          this.#sessionAcceptsClaim(session, frontier.claim)
        )
        .toSorted((left, right) => left.throughFeedSeq - right.throughFeedSeq);
    const toFeedSeq = session.executionFeedSeq + 1;
    session.executionFeedSeq = toFeedSeq;
    return {
      ...sync,
      execution: {
        fromFeedSeq,
        toFeedSeq,
        ...(snapshotFrom !== undefined
          ? {
            snapshot: {
              claims,
              ...(settlementFrontiers.length > 0
                ? { settlementFrontiers }
                : {}),
            },
          }
          : {}),
        events,
      },
    };
  }

  #validateExecutionClaimInput(claim: ExecutionClaimInput): void {
    if (
      claim.space.length === 0 || claim.space.length > 1024 ||
      claim.branch.length > 256 || claim.pieceId.length === 0 ||
      claim.pieceId.length > 512 || claim.actionId.length === 0 ||
      claim.actionId.length > 512 ||
      claim.implementationFingerprint.length === 0 ||
      claim.implementationFingerprint.length > 1024 ||
      claim.runtimeFingerprint.length === 0 ||
      claim.runtimeFingerprint.length > 1024 ||
      (claim.contextKey !== "space" &&
        // Scoped keys must be canonical (colon-safe encoded segments): user
        // rank per principalOfUserContextKey, session rank per the C2.1
        // canonical parse (CA12 — exactly `session:<enc>:<enc>`, both
        // segments non-empty, decodable, and byte-exact under re-encoding;
        // `session:a:b:c` and `session::` reject here in one place).
        Engine.principalOfUserContextKey(claim.contextKey) === undefined &&
        Engine.parseSessionExecutionContextKey(claim.contextKey) ===
          undefined) ||
      (claim.actionKind !== "computation" && claim.actionKind !== "effect" &&
        claim.actionKind !== "event-handler")
    ) {
      throw new TypeError("invalid execution claim input");
    }
    if (claim.actionKind === "event-handler") {
      throw new TypeError("event-handler execution claims are not supported");
    }
  }

  #executionNowMs(): number {
    return this.options.executionControl?.nowMs?.() ?? Date.now();
  }

  #publishExecutionClaimRevoke(claim: ExecutionClaim): void {
    this.executionStats.claimsRevoked += 1;
    this.#publishExecutionControl(Object.freeze({
      type: "session.execution.claim.revoke",
      branch: claim.branch,
      claim: Object.freeze(canonicalActionClaimKey(claim)),
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
      // C3.6b: carry the cross-space-read marker so the delivery gate reaches
      // exactly the negotiating cohort the claim.set did. Omitted for the
      // same-space default, keeping the revoke byte-identical to pre-C3.6.
      ...(claim.crossSpaceReadSpaces !== undefined &&
          claim.crossSpaceReadSpaces.length > 0
        ? { crossSpaceReadSpaces: claim.crossSpaceReadSpaces }
        : {}),
    }));
  }

  #scheduleExecutionClaimExpiry(): void {
    if (this.#executionClaimExpiryTimer !== null) {
      clearTimeout(this.#executionClaimExpiryTimer);
      this.#executionClaimExpiryTimer = null;
    }
    if (this.#executionClaims.size === 0) return;
    const nextExpiry = Math.min(
      ...[...this.#executionClaims.values()].map((claim) => claim.expiresAt),
    );
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, nextExpiry - this.#executionNowMs()),
    );
    this.#executionClaimExpiryTimer = setTimeout(() => {
      this.#executionClaimExpiryTimer = null;
      this.expireExecutionClaims();
    }, delay);
  }

  /** Expire all claims whose server-authored deadline has passed. Public for
   * deterministic host lifecycle integration/tests; the server also schedules
   * the earliest deadline automatically. */
  expireExecutionClaims(now = this.#executionNowMs()): number {
    if (!Number.isFinite(now)) {
      throw new TypeError("execution claim expiry time must be finite");
    }
    let expired = 0;
    for (const [key, claim] of this.#executionClaims) {
      if (claim.expiresAt > now) continue;
      this.#executionClaims.delete(key);
      this.#executionClaimLaneBindings.delete(key);
      this.#publishExecutionClaimRevoke(claim);
      expired += 1;
    }
    this.#scheduleExecutionClaimExpiry();
    return expired;
  }

  #revokeExecutionClaimsForSpace(space: string): number {
    let revoked = 0;
    for (const [key, claim] of this.#executionClaims) {
      if (claim.space !== space) continue;
      this.#executionClaims.delete(key);
      this.#executionClaimLaneBindings.delete(key);
      this.#publishExecutionClaimRevoke(claim);
      revoked += 1;
    }
    this.#scheduleExecutionClaimExpiry();
    return revoked;
  }

  /**
   * The single principal-cohort seam (amendment 17, FA9): every session of
   * `principal` in `space` that is either attached to a LIVE connection
   * (mirroring #boundExecutionSessionForCommit — never the connection-
   * liveness-blind hasOpenSessionForPrincipal) or TTL-detached awaiting
   * resume. Detached sessions count as present DELIBERATELY (conservative):
   * within its TTL a detached session can resume and transact at any moment,
   * so treating it as absent would let a user lane open (or stay open)
   * beside a client that never negotiated context-scoped claims — exactly
   * the double-execution the cohort gate exists to prevent. A session bound
   * to a connection this server no longer tracks is neither live nor
   * resumable-by-TTL and is excluded. Delivery, reconnect snapshots, the
   * cohort gate, and the F6 feed fan-out all derive from this one predicate.
   */
  sessionsForPrincipal(
    space: string,
    principal: string,
  ): SessionState[] {
    if (principal === ANYONE_USER) return [];
    return this.#sessions.sessionsForSpace(space).filter((session) =>
      session.principal === principal &&
      (session.ownerConnectionId === null ||
        this.#connections.has(session.ownerConnectionId))
    );
  }

  /** Principal-wide cohort predicate (C1.7, consumed by F6): a user lane may
   * exist only while EVERY session of the principal — detached ones included
   * — negotiated context-lattice-claims-v1 on its current attach. */
  principalCohortNegotiatesContextLatticeClaims(
    space: string,
    principal: string,
  ): boolean {
    return this.sessionsForPrincipal(space, principal).every((session) =>
      session.serverPrimaryExecutionContextLatticeClaimsV1
    );
  }

  /** Amendment-11 fence: drain every live user lane of `principal` in
   * `space` (all branches), plus — C2.3 — the attaching session's OWN
   * session lane (a session that stops negotiating context-lattice claims
   * could no longer receive its lane's claims; sibling sessions' lanes are
   * untouched, since their per-session negotiation stands). Synchronous —
   * callers rely on the generation fence and claim revokes landing before
   * they continue. */
  #fenceLanesForNonNegotiatingAttach(
    space: string,
    principal: string | undefined,
    sessionId: string,
  ): void {
    if (principal === undefined || principal === ANYONE_USER) return;
    for (const grant of [...this.#userLaneGrants.values()]) {
      if (grant.space === space && grant.principal === principal) {
        this.#drainUserLane(grant);
      }
    }
    for (const grant of [...this.#sessionLaneGrants.values()]) {
      if (grant.space === space && grant.sessionId === sessionId) {
        this.#drainSessionLane(grant);
      }
    }
  }

  /**
   * C3.6b amendment-11 fence (the cross-space-read analog of
   * `#fenceLanesForNonNegotiatingAttach`): on an attach that does NOT
   * negotiate cross-space-claims-v1, REVOKE every live cross-space-read claim
   * whose delivery cohort this attaching session belongs to — the attaching
   * session can never receive such a claim (delivery gate), so it would run
   * the foreign-reading action client-primary beside the host's claimed run.
   * Cohort membership follows the claim's OWN contextKey rank (C3A18,
   * matching `#crossSpaceReadClaimCohortNegotiates`): a session-lane claim of
   * THIS session id, a user-lane claim of this principal, or — when this
   * session negotiates routing — any space-lane claim of the space. Synchronous
   * (like the lane fence): the revoke publishes before the open response
   * releases and before `attachExecutionFeed` builds this session's snapshot,
   * so the attaching session never observes the fenced claim. */
  #fenceCrossSpaceReadClaimsForNonNegotiatingAttach(
    space: string,
    principal: string | undefined,
    sessionId: string,
    negotiatesRouting: boolean,
  ): void {
    for (const [key, claim] of [...this.#executionClaims]) {
      if (
        claim.space !== space || claim.crossSpaceReadSpaces === undefined ||
        claim.crossSpaceReadSpaces.length === 0
      ) {
        continue;
      }
      const sessionIdentity = Engine.parseSessionExecutionContextKey(
        claim.contextKey,
      );
      const userPrincipal = Engine.principalOfUserContextKey(claim.contextKey);
      const inCohort = sessionIdentity !== undefined
        ? sessionIdentity.sessionId === sessionId
        : userPrincipal !== undefined
        ? principal !== undefined && userPrincipal === principal
        : negotiatesRouting; // space lane: only routing sessions are in cohort
      if (!inCohort) continue;
      this.#executionClaims.delete(key);
      this.#executionClaimLaneBindings.delete(key);
      this.#publishExecutionClaimRevoke(claim);
    }
    this.#scheduleExecutionClaimExpiry();
  }

  /** Connected-session anchoring predicate (amendment 17): sessions attached
   * to a LIVE connection — the stricter subset of sessionsForPrincipal that
   * lane anchoring needs (a detached session cannot anchor a lane). */
  #connectedSessionForPrincipal(
    space: string,
    principal: string,
  ): SessionState | null {
    for (const session of this.sessionsForPrincipal(space, principal)) {
      if (session.ownerConnectionId !== null) return session;
    }
    return null;
  }

  #laneGrantAnchorConnected(grant: ExecutionLaneGrant): boolean {
    const session = this.#sessions.get(grant.space, grant.anchorSessionId);
    return session !== null && session.principal === grant.principal &&
      session.sessionToken === grant.anchorSessionToken &&
      session.ownerConnectionId === grant.anchorConnectionId &&
      this.#connections.has(grant.anchorConnectionId);
  }

  /**
   * Open (or return) the live lane grant for one (space, branch, user:did)
   * lane. Requires a connected session of the principal to anchor on and the
   * principal's current WRITE capability (amendment 2); both are re-sampled
   * after the engine await. A live grant whose anchor died is drained first,
   * so the replacement observably supersedes it under a bumped generation.
   *
   * Host-internal: nothing wires lane demand to this until C1.5a+/C1.7 — in
   * production the registry stays empty and every path guarding on it is
   * dormant.
   */
  async openUserLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
  ): Promise<UserLaneGrant> {
    const contextKey = Engine.userExecutionContextKey(principal);
    const key = laneGrantKey(space, branch, contextKey);
    const existing = this.#userLaneGrants.get(key);
    if (existing !== undefined) {
      if (this.#laneGrantAnchorConnected(existing)) return existing;
      this.#drainUserLane(existing);
    }
    const engine = await this.openEngine(space);
    // The engine open is an authority boundary: re-sample the anchor and the
    // registry after it, exactly like claim issuance re-samples its inputs.
    if (this.#userLaneGrants.get(key) !== undefined) {
      return await this.openUserLaneGrant(space, branch, principal);
    }
    const anchor = this.#connectedSessionForPrincipal(space, principal);
    if (anchor === null || anchor.ownerConnectionId === null) {
      throw new Error(
        "user lane grant requires a connected session of the lane principal",
      );
    }
    const capability = this.#resolveCapability(engine, space, principal);
    if (capability === null || !isCapable(capability, "WRITE")) {
      throw new Error(
        "user lane grant requires the lane principal's current WRITE capability",
      );
    }
    // Principal-wide cohort gate (C1.7): the lane may not open while ANY
    // session of the principal — TTL-detached ones included, see
    // sessionsForPrincipal — lacks the subcapability. Sessions attaching
    // later are handled by the amendment-11 fence in openSession.
    if (!this.principalCohortNegotiatesContextLatticeClaims(space, principal)) {
      throw new Error(
        "user lane grant requires every session of the lane principal to " +
          "negotiate context-lattice-claims-v1",
      );
    }
    const laneGeneration = (this.#laneGenerations.get(key) ?? 0) + 1;
    this.#laneGenerations.set(key, laneGeneration);
    const grant: UserLaneGrant = Object.freeze({
      space,
      branch,
      contextKey,
      principal,
      laneGeneration,
      anchorSessionId: anchor.id,
      anchorConnectionId: anchor.ownerConnectionId,
      anchorSessionToken: anchor.sessionToken,
    });
    this.#userLaneGrants.set(key, grant);
    // C3A17: a lane-grant open re-registers the foreign-reader
    // subscription so the new lane's demand slice joins the foreign
    // lookup (fire-and-forget; the C3A10 barrier lives in the pass).
    this.scheduleForeignReaderSubscriptionReconcile(space, branch);
    return grant;
  }

  /** Re-validate one exact grant incarnation: live registry identity, a
   * connected anchor, current WRITE (amendment 2), and a fully negotiating
   * principal cohort (C1.7 — belt to the attach fence's braces). Any
   * mismatch drains the lane — fence, then sweep — and reports null. */
  async renewUserLaneGrant(
    grant: UserLaneGrant,
  ): Promise<UserLaneGrant | null> {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#userLaneGrants.get(key) !== grant) return null;
    const engine = await this.openEngine(grant.space);
    if (this.#userLaneGrants.get(key) !== grant) return null;
    const capability = this.#resolveCapability(
      engine,
      grant.space,
      grant.principal,
    );
    if (
      !this.#laneGrantAnchorConnected(grant) ||
      capability === null || !isCapable(capability, "WRITE") ||
      !this.principalCohortNegotiatesContextLatticeClaims(
        grant.space,
        grant.principal,
      )
    ) {
      this.#drainUserLane(grant);
      return null;
    }
    return grant;
  }

  /** Read-only accessor for the live grant of one lane, if any. */
  userLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
  ): UserLaneGrant | null {
    return this.#userLaneGrants.get(
      laneGrantKey(space, branch, Engine.userExecutionContextKey(principal)),
    ) ?? null;
  }

  /** Host-side pair of the C1.5a runner dial (C1.8 inertness pin): user
   * lanes may open only while the issuance rank dial admits user rank (the
   * ladder — the `session` stage admits user rank too) AND this host
   * advertises context-lattice-claims-v1. Mirrors
   * #executionClaimRankEnabled's user-rank condition — a lane the host could
   * never issue claims for is pure wake-widening overhead. */
  executionUserLanesEnabled(): boolean {
    return serverPrimaryExecutionClaimRankAtLeast("user") &&
      this.memoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1;
  }

  /** C2.3 pair of executionUserLanesEnabled: session lanes may open only at
   * the `session` dial stage under the same subcapability advertisement. */
  executionSessionLanesEnabled(): boolean {
    return serverPrimaryExecutionClaimRankAtLeast("session") &&
      this.memoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1;
  }

  /** Pool-driven full drain (C1.8 lifecycle): close exactly this grant
   * incarnation when the last demanding session of its principal departs.
   * Returns false when the incarnation is already gone (a concurrent
   * disconnect/ACL drain won). */
  closeUserLaneGrant(grant: UserLaneGrant): boolean {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#userLaneGrants.get(key) !== grant) return false;
    this.#drainUserLane(grant);
    return true;
  }

  /**
   * Open (or return) the live lane grant for one
   * (space, branch, session:<did>:<sessionId>) lane (context-lattice §3,
   * C2.3). The session is its OWN anchor: the grant anchors on exactly the
   * named live connected session, validated with the bindExecutionSession
   * checks — live session, bound principal, owning connection — plus the
   * principal's current WRITE capability (amendment 2 at session rank), all
   * re-sampled after the engine await. Unlike user lanes there is NO cohort
   * gate and NO re-anchor: chain-scoped routing means a session claim only
   * ever suppresses its own session, so only the lane-owning session's
   * current attach must have negotiated context-lattice-claims-v1, and when
   * that session ends, the lane ends (a sibling session of the same
   * principal never inherits the grant).
   *
   * Host-internal: nothing wires session-lane demand to this until C2.7 —
   * in production the registry stays empty and every path guarding on it is
   * dormant.
   */
  async openSessionLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
    sessionId: string,
  ): Promise<SessionLaneGrant> {
    const contextKey = Engine.sessionExecutionContextKey(principal, sessionId);
    const key = laneGrantKey(space, branch, contextKey);
    const existing = this.#sessionLaneGrants.get(key);
    if (existing !== undefined) {
      if (this.#laneGrantAnchorConnected(existing)) return existing;
      this.#drainSessionLane(existing);
    }
    const engine = await this.openEngine(space);
    // The engine open is an authority boundary: re-sample the anchor and the
    // registry after it, exactly like claim issuance re-samples its inputs.
    if (this.#sessionLaneGrants.get(key) !== undefined) {
      return await this.openSessionLaneGrant(
        space,
        branch,
        principal,
        sessionId,
      );
    }
    const anchor = this.#sessions.get(space, sessionId);
    if (
      anchor === null || anchor.principal === undefined ||
      anchor.principal === ANYONE_USER || anchor.principal !== principal ||
      anchor.ownerConnectionId === null ||
      !this.#connections.has(anchor.ownerConnectionId)
    ) {
      throw new Error(
        "session lane grant requires that live connected session of the lane principal",
      );
    }
    const capability = this.#resolveCapability(engine, space, principal);
    if (capability === null || !isCapable(capability, "WRITE")) {
      throw new Error(
        "session lane grant requires the lane principal's current WRITE capability",
      );
    }
    // Per-session delivery gate: the lane-owning session's own attach must
    // have negotiated context-lattice-claims-v1, or the host would issue
    // claims that #sessionAcceptsClaim can never deliver to it. Deliberately
    // NOT the user-lane principal-wide cohort gate — a session claim never
    // suppresses a sibling session under chain-scoped routing.
    if (!anchor.serverPrimaryExecutionContextLatticeClaimsV1) {
      throw new Error(
        "session lane grant requires the lane session to negotiate " +
          "context-lattice-claims-v1",
      );
    }
    const laneGeneration = (this.#laneGenerations.get(key) ?? 0) + 1;
    this.#laneGenerations.set(key, laneGeneration);
    const grant: SessionLaneGrant = Object.freeze({
      space,
      branch,
      contextKey,
      principal,
      sessionId,
      laneGeneration,
      anchorSessionId: sessionId,
      anchorConnectionId: anchor.ownerConnectionId,
      anchorSessionToken: anchor.sessionToken,
    });
    this.#sessionLaneGrants.set(key, grant);
    // C3A17: session-lane churn re-registers like user-lane churn — a
    // grant opened after initial registration must still receive foreign
    // wakes for its demanded pieces.
    this.scheduleForeignReaderSubscriptionReconcile(space, branch);
    return grant;
  }

  /** Re-validate one exact session grant incarnation: live registry
   * identity, the connected owning session, current WRITE (amendment 2 at
   * session rank), and the session's own negotiation. Any mismatch drains
   * the lane — fence, then sweep — and reports null. There is no re-anchor
   * path: a drained incarnation can never be renewed back to life. */
  async renewSessionLaneGrant(
    grant: SessionLaneGrant,
  ): Promise<SessionLaneGrant | null> {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#sessionLaneGrants.get(key) !== grant) return null;
    const engine = await this.openEngine(grant.space);
    if (this.#sessionLaneGrants.get(key) !== grant) return null;
    const capability = this.#resolveCapability(
      engine,
      grant.space,
      grant.principal,
    );
    const anchor = this.#sessions.get(grant.space, grant.anchorSessionId);
    if (
      !this.#laneGrantAnchorConnected(grant) ||
      capability === null || !isCapable(capability, "WRITE") ||
      anchor === null || !anchor.serverPrimaryExecutionContextLatticeClaimsV1
    ) {
      this.#drainSessionLane(grant);
      return null;
    }
    return grant;
  }

  /** Read-only accessor for the live grant of one session lane, if any. */
  sessionLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
    sessionId: string,
  ): SessionLaneGrant | null {
    return this.#sessionLaneGrants.get(
      laneGrantKey(
        space,
        branch,
        Engine.sessionExecutionContextKey(principal, sessionId),
      ),
    ) ?? null;
  }

  /** Pool-driven full drain (C2.3 lifecycle, mirror of closeUserLaneGrant):
   * close exactly this grant incarnation. Returns false when the incarnation
   * is already gone (a concurrent disconnect/ACL drain won). */
  closeSessionLaneGrant(grant: SessionLaneGrant): boolean {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#sessionLaneGrants.get(key) !== grant) return false;
    this.#drainSessionLane(grant);
    return true;
  }

  /** Open lane grants on one (space, branch) — the A4 wake-widening input.
   * Deterministically ordered so per-lane stale-reader lookups and their
   * counters replay stably. */
  #openUserLaneGrantsFor(
    space: string,
    branch: BranchName,
  ): UserLaneGrant[] {
    return [...this.#userLaneGrants.values()]
      .filter((grant) => grant.space === space && grant.branch === branch)
      .sort((left, right) => left.contextKey.localeCompare(right.contextKey));
  }

  /** Open SESSION lane grants on one (space, branch) — the C2.7 leg of the
   * A4 wake-widening input, ordered like the user grants. Each grant pairs
   * with ONLY its owning session's demand in the wake lookup. */
  #openSessionLaneGrantsFor(
    space: string,
    branch: BranchName,
  ): SessionLaneGrant[] {
    return [...this.#sessionLaneGrants.values()]
      .filter((grant) => grant.space === space && grant.branch === branch)
      .sort((left, right) => left.contextKey.localeCompare(right.contextKey));
  }

  /** A2 third leg (C1.8, extended over session lanes by C2.3): after an ACL
   * commit, fence and drain user AND session lanes whose principal lost
   * WRITE or whose anchor session was removed by the ACL reconciliation.
   * Synchronous like the per-lane drains — callers await the demand
   * republish barrier afterwards, exactly the lease-drain
   * publish-before-response discipline. Returns the touched branches. */
  #drainIneligibleLanes(
    engine: Engine.Engine,
    space: string,
  ): Set<BranchName> {
    const branches = new Set<BranchName>();
    const laneEligible = (grant: ExecutionLaneGrant): boolean => {
      const capability = this.#resolveCapability(
        engine,
        space,
        grant.principal,
      );
      return capability !== null && isCapable(capability, "WRITE") &&
        this.#laneGrantAnchorConnected(grant);
    };
    for (const grant of [...this.#userLaneGrants.values()]) {
      if (grant.space !== space || laneEligible(grant)) continue;
      this.#drainUserLane(grant);
      branches.add(grant.branch);
    }
    for (const grant of [...this.#sessionLaneGrants.values()]) {
      if (grant.space !== space || laneEligible(grant)) continue;
      this.#drainSessionLane(grant);
      branches.add(grant.branch);
    }
    return branches;
  }

  /** Shared drain tail: with the generation already fenced (the live grant
   * removed from its registry), revoke exactly that lane's claims. Sibling
   * lanes and the space lane are untouched. */
  #sweepLaneClaims(grant: ExecutionLaneGrant): void {
    for (const [claimKey, claim] of this.#executionClaims) {
      if (
        claim.space !== grant.space || claim.branch !== grant.branch ||
        claim.contextKey !== grant.contextKey
      ) {
        continue;
      }
      this.#executionClaims.delete(claimKey);
      this.#executionClaimLaneBindings.delete(claimKey);
      this.#publishExecutionClaimRevoke(claim);
    }
    this.#scheduleExecutionClaimExpiry();
  }

  /** Drain one user lane: fence its generation FIRST (remove the live
   * grant, so every re-validation — racing issuance, renewal, the commit
   * fence — observes the fence), THEN revoke exactly that lane's claims. */
  #drainUserLane(grant: UserLaneGrant): void {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#userLaneGrants.get(key) !== grant) return;
    this.#userLaneGrants.delete(key);
    this.#sweepLaneClaims(grant);
    // C3A17: lane drain narrows the foreign-lookup join — re-register.
    this.scheduleForeignReaderSubscriptionReconcile(grant.space, grant.branch);
  }

  /** Drain one session lane — §B.8's drain semantics at session
   * granularity (C2.3): fence the generation FIRST, then revoke exactly
   * that lane's claims. Sibling session lanes (the same principal's other
   * sessions included), user lanes, and the space lane are untouched. */
  #drainSessionLane(grant: SessionLaneGrant): void {
    const key = laneGrantKey(grant.space, grant.branch, grant.contextKey);
    if (this.#sessionLaneGrants.get(key) !== grant) return;
    this.#sessionLaneGrants.delete(key);
    this.#sweepLaneClaims(grant);
    // C3A17: lane drain narrows the foreign-lookup join — re-register.
    this.scheduleForeignReaderSubscriptionReconcile(grant.space, grant.branch);
  }

  #drainLanesForConnection(connectionId: string): void {
    for (const grant of [...this.#userLaneGrants.values()]) {
      if (grant.anchorConnectionId === connectionId) {
        this.#drainUserLane(grant);
      }
    }
    for (const grant of [...this.#sessionLaneGrants.values()]) {
      if (grant.anchorConnectionId === connectionId) {
        this.#drainSessionLane(grant);
      }
    }
  }

  #drainLanesForSession(
    space: string,
    sessionId: string,
    ownerConnectionId: string,
  ): void {
    for (const grant of [...this.#userLaneGrants.values()]) {
      if (
        grant.space === space && grant.anchorSessionId === sessionId &&
        grant.anchorConnectionId === ownerConnectionId
      ) {
        this.#drainUserLane(grant);
      }
    }
    for (const grant of [...this.#sessionLaneGrants.values()]) {
      if (
        grant.space === space && grant.anchorSessionId === sessionId &&
        grant.anchorConnectionId === ownerConnectionId
      ) {
        this.#drainSessionLane(grant);
      }
    }
  }

  /** Live lane grant for a scoped-rank claim input, or null for space rank
   * (the CA1 issuance-binding seam). Amendment 12: issuance resolves the
   * grant before its first await and re-validates the same incarnation
   * after every await. */
  #requiredLaneGrantForClaim(
    claimInput: ExecutionClaimInput,
  ): ExecutionLaneGrant | null {
    if (Engine.principalOfUserContextKey(claimInput.contextKey) !== undefined) {
      const grant = this.#userLaneGrants.get(
        laneGrantKey(
          claimInput.space,
          claimInput.branch,
          claimInput.contextKey,
        ),
      );
      if (grant === undefined) {
        throw new ExecutionLeaseAuthorityError(
          "user-rank execution claim requires a live lane grant",
        );
      }
      return grant;
    }
    if (
      Engine.parseSessionExecutionContextKey(claimInput.contextKey) !==
        undefined
    ) {
      const grant = this.#sessionLaneGrants.get(
        laneGrantKey(
          claimInput.space,
          claimInput.branch,
          claimInput.contextKey,
        ),
      );
      if (grant === undefined) {
        throw new ExecutionLeaseAuthorityError(
          "session-rank execution claim requires a live lane grant",
        );
      }
      return grant;
    }
    return null;
  }

  /** Live grant incarnation currently registered under a lane key, of
   * either rank — the one lookup the issuance re-validation, the renewal
   * binding re-check, and the commit fence's laneAuthority closure share.
   * The canonical contextKey embedded in the key picks the registry. */
  #liveLaneGrantForKey(laneKey: string): ExecutionLaneGrant | undefined {
    return this.#userLaneGrants.get(laneKey) ??
      this.#sessionLaneGrants.get(laneKey);
  }

  /** Amendment 3 issuance guard: reject any claim whose action tuple has a
   * live claim chain-compatible with it. Exact-context duplicates are
   * excluded here — they stay the hard already-live failure. */
  #assertExecutionClaimRoutingDisjoint(claimInput: ExecutionClaimInput): void {
    for (const live of this.#executionClaims.values()) {
      if (
        live.contextKey !== claimInput.contextKey &&
        sameActionTupleAcrossLanes(live, claimInput) &&
        executionClaimChainCompatible(live.contextKey, claimInput.contextKey)
      ) {
        throw new ExecutionLeaseAuthorityError(
          "execution claim conflicts with a chain-compatible live claim; " +
            "lane moves are revoke-published-before-issue",
        );
      }
    }
  }

  /**
   * C3.6 issuance preflight (C3A17): bind a cross-space-read claim's authority
   * before it is recorded. Runs ONLY when the candidate declared a non-empty
   * foreign-read surface. Every refusal is a SOFT decline — it throws
   * {@link ExecutionLeaseAuthorityError}, so `trySetExecutionClaim` returns
   * `null` and the client keeps running the foreign-reading action locally
   * under its own authority (no escalation): a stage-off, mixed-cohort, or
   * access-denied issuance fails open exactly like a lost lease.
   *
   * Three gates, in cheapest-first order (no wire traffic until the local
   * ones pass):
   *
   * 1. The cross-space-read STAGE
   *    ({@link serverPrimaryExecutionCrossSpaceReadsEnabled} — the rank dial's
   *    fourth ladder entry) AND the host's own `cross-space-claims-v1`
   *    advertisement must BOTH hold. This is the CA4/C3A17 ordering
   *    invariant: the stage is never live without the C3.6b subcapability
   *    that fences delivery, so a dial-on host that never advertised the
   *    subcapability issues nothing.
   * 2. The delivery COHORT (C3.6b) must uniformly negotiate
   *    `cross-space-claims-v1` — the mixed-version race prevention. A cohort
   *    member that does not negotiate it never receives the claim, so it
   *    would run the same foreign-reading action client-primary beside the
   *    host: refuse to issue rather than race two authorities.
   * 3. Per foreign read space, the ACTING principal must hold READ — resolved
   *    through the SAME `#authorizeMessageWithEngine(READ)` the C3.3b mirror
   *    gate and the C3.4 point read use, on the READ space's own engine
   *    (in-process/co-hosted = the local hosted engine; a peer-routed read
   *    space's link-side binding round-trip is C3.10b, and until it lands a
   *    peer-routed read soft-declines here). The acting principal is supplied
   *    by the caller: the lease sponsor for the space lane (sponsor rotation
   *    flips it), the bound lane grant's principal for user/session lanes.
   *
   * The per-space engine opens are awaits; the caller's re-sample block after
   * this returns is their authority boundary (the `#setExecutionClaim`
   * discipline — a lane that drained inside these awaits is caught there).
   */
  async #assertCrossSpaceReadIssuance(
    claimInput: ExecutionClaimInput,
    foreignReadSpaces: readonly string[],
    actingPrincipal: string,
  ): Promise<void> {
    if (
      !serverPrimaryExecutionCrossSpaceReadsEnabled() ||
      !this.memoryProtocolFlags().serverPrimaryExecutionCrossSpaceClaimsV1
    ) {
      throw new ExecutionLeaseAuthorityError(
        "cross-space-read claim issuance requires the cross-space-read stage " +
          "and the cross-space-claims-v1 advertisement (C3A17 ordering " +
          "invariant)",
      );
    }
    if (!this.#crossSpaceReadClaimCohortNegotiates(claimInput)) {
      throw new ExecutionLeaseAuthorityError(
        "cross-space-read claim issuance requires the delivery cohort to " +
          "uniformly negotiate cross-space-claims-v1 (C3.6b mixed-version " +
          "race)",
      );
    }
    for (const readSpace of foreignReadSpaces) {
      await this.#assertForeignReadAccessForIssuance(
        readSpace,
        actingPrincipal,
      );
    }
  }

  /**
   * C3.6b delivery-cohort gate for a cross-space-read claim, keyed by the
   * claim's OWN contextKey rank (the derivation rule, C3A18 — a cross-space
   * read's derivation is whatever lane context the claim runs under):
   *
   * - `session:<p>:<s>` → the owning session's OWN negotiation only (the C2.3
   *   per-session pattern): a session-lane claim only ever suppresses its
   *   named session, and that session's negotiation flag is recomputed on
   *   every attach, so a sibling session's version can never gate it.
   * - `user:<p>` → the lane principal's whole session cohort (the C1.7
   *   principal-wide pattern, via {@link sessionsForPrincipal}): a user-lane
   *   claim is deliverable to every session of the principal, so all must
   *   negotiate or one would run the action client-primary.
   * - `space` → the (space, branch) routing-negotiating session cohort: a
   *   space-lane claim is deliverable to every routing session in the space,
   *   so every routing session must ALSO negotiate cross-space-claims-v1.
   *   Non-routing (legacy) sessions never suppress ANY claim and are outside
   *   the routed cohort the base system already reasons about — matching
   *   `#sessionAcceptsClaim`, which delivers computation claims only to
   *   routing sessions.
   */
  #crossSpaceReadClaimCohortNegotiates(
    claimInput: ExecutionClaimInput,
  ): boolean {
    const sessionIdentity = Engine.parseSessionExecutionContextKey(
      claimInput.contextKey,
    );
    if (sessionIdentity !== undefined) {
      const session = this.#sessions.get(
        claimInput.space,
        sessionIdentity.sessionId,
      );
      return session !== null &&
        session.serverPrimaryExecutionCrossSpaceClaimsV1;
    }
    const userPrincipal = Engine.principalOfUserContextKey(
      claimInput.contextKey,
    );
    if (userPrincipal !== undefined) {
      return this.sessionsForPrincipal(claimInput.space, userPrincipal).every(
        (session) => session.serverPrimaryExecutionCrossSpaceClaimsV1,
      );
    }
    return this.#sessions.sessionsForSpace(claimInput.space).every((session) =>
      session.ownerConnectionId !== null &&
        !this.#connections.has(session.ownerConnectionId)
        ? true // bound to a connection this server no longer tracks — excluded
        : !session.serverPrimaryExecutionClaimRoutingV1 ||
          session.serverPrimaryExecutionCrossSpaceClaimsV1
    );
  }

  /**
   * Bind the acting principal's foreign READ on one read space at issuance
   * (C3.6), mirroring the C3.3b mirror gate / C3.4 point read resolution:
   * `#authorizeMessageWithEngine(READ)` on the READ space's own engine. A
   * refusal throws (soft decline — see `#assertCrossSpaceReadIssuance`). The
   * read space is soft-declined when it cannot be authority-verified here:
   * unhostable, or peer-routed (whose link-side READ binding round-trip is
   * C3.10b — until it lands, a peer-routed foreign read never issues a claim
   * and the client keeps running locally). In-process/co-hosted read spaces
   * open the local hosted engine, so send host == read host and the local
   * consult IS the read host's check.
   */
  async #assertForeignReadAccessForIssuance(
    readSpace: string,
    actingPrincipal: string,
  ): Promise<void> {
    if (!(await this.ensureCrossSpaceHosting(readSpace))) {
      throw new ExecutionLeaseAuthorityError(
        `cross-space-read claim issuance cannot host read space ${readSpace}`,
      );
    }
    if (
      this.#crossSpaceRouter.transport.routing?.peerHostFor(readSpace) !==
        undefined
    ) {
      throw new ExecutionLeaseAuthorityError(
        `cross-space-read claim issuance defers peer-routed read space ` +
          `${readSpace} to C3.10b's link-side READ binding`,
      );
    }
    const engine = await this.openHostedEngine(readSpace);
    if (
      this.#authorizeMessageWithEngine(
        engine,
        readSpace,
        actingPrincipal,
        "READ",
      ) !== null
    ) {
      throw new ExecutionLeaseAuthorityError(
        `acting principal lacks READ on cross-space read space ${readSpace}`,
      );
    }
  }

  async setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimInput: ExecutionClaimInput,
    options?: ExecutionClaimIssueOptions,
  ): Promise<ExecutionClaim> {
    return await this.#setExecutionClaim(lease, claimInput, options);
  }

  /** Attempt claim admission from a live executor. Demand and lease lifecycle
   * can change while engine setup awaits; that expected authority race is a
   * declined claim, while malformed candidates and duplicate claims remain
   * hard failures. */
  async trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimInput: ExecutionClaimInput,
    options?: ExecutionClaimIssueOptions,
  ): Promise<ExecutionClaim | null> {
    try {
      return await this.#setExecutionClaim(lease, claimInput, options);
    } catch (error) {
      if (error instanceof ExecutionLeaseAuthorityError) return null;
      throw error;
    }
  }

  async #setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimInput: ExecutionClaimInput,
    options?: ExecutionClaimIssueOptions,
  ): Promise<ExecutionClaim> {
    this.#validateExecutionClaimInput(claimInput);
    this.#assertExecutionClaimCapabilityEnabled(claimInput);
    // C3.6: the deduped FOREIGN read spaces this action consumes (the
    // candidate's discovered foreign-read surface, canonicalized here). Empty
    // ⇒ an ordinary same-space claim, and every cross-space branch below is
    // dormant — issuance stays byte-identical to pre-C3.6.
    const foreignReadSpaces = normalizeCrossSpaceReadSpaces(
      options?.foreignReadSpaces,
      claimInput.space,
    );
    // Amendment 12 (session lanes since C2.3, CA1): bind the live lane
    // grant — user or session rank — before the first await; every
    // re-sample below re-validates the same incarnation so a drain fencing
    // the generation mid-issuance declines instead of orphaning a claim.
    const laneGrant = this.#requiredLaneGrantForClaim(claimInput);
    const laneKey = laneGrant === null
      ? undefined
      : laneGrantKey(claimInput.space, claimInput.branch, laneGrant.contextKey);
    const assertLaneGrantCurrent = () => {
      if (
        laneKey !== undefined &&
        this.#liveLaneGrantForKey(laneKey) !== laneGrant
      ) {
        throw new ExecutionLeaseAuthorityError(
          "scoped execution claim lane grant was fenced during issuance",
        );
      }
    };
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(claimInput.space, claimInput.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      authority.drainRequested || lease.space !== claimInput.space ||
      lease.branch !== claimInput.branch
    ) {
      throw new ExecutionLeaseAuthorityError(
        "execution claim requires the current owned lease",
      );
    }
    const key = actionClaimMapKey(claimInput);
    const engine = await this.openEngine(claimInput.space);
    // Engine setup is an authority boundary: the lease may expire or host
    // lifecycle may begin draining/replacing this slot while the open awaits.
    // Re-sample and re-read every host/durable authority input afterwards.
    this.#assertExecutionClaimCapabilityEnabled(claimInput);
    assertLaneGrantCurrent();
    const claimNow = this.#executionNowMs();
    if (
      this.#executionLeaseAuthorities.get(lease) !== authority ||
      this.#ownedExecutionLeases.get(
          executionLeaseKey(claimInput.space, claimInput.branch),
        ) !== authority ||
      authority.drainRequested
    ) {
      throw new ExecutionLeaseAuthorityError(
        "execution claim requires the current owned lease",
      );
    }
    const current = Engine.currentExecutionLease(engine, {
      space: claimInput.space,
      branch: claimInput.branch,
      nowMs: claimNow,
    });
    const sponsor = this.#sessions.get(
      claimInput.space,
      authority.sponsorSessionId,
    );
    const demand = this.#executionDemands.get(executionDemandKey(
      authority.sponsorConnectionId,
      claimInput.space,
      authority.sponsorSessionId,
      claimInput.branch,
    ));
    if (
      current === null || current.state !== "active" ||
      !this.#sameExecutionLease(current, lease) || sponsor === null ||
      sponsor.sessionToken !== authority.sponsorSessionToken ||
      demand === undefined || demand.principal !== current.onBehalfOf ||
      !this.#executionSponsorCanWrite(engine, demand, sponsor)
    ) {
      throw new ExecutionLeaseAuthorityError(
        "execution lease is not active and authorized",
      );
    }
    // C3.6 issuance preflight (C3A17): a cross-space-read claim binds the
    // acting principal's foreign READ per read space and the delivery
    // cohort's cross-space-claims-v1 negotiation. The acting principal is the
    // read-side mirror of C3.4's live-authority resolution: the lease sponsor
    // for the space lane (`current.onBehalfOf` — sponsor rotation flips it),
    // the bound lane grant's principal for user/session lanes (C3A4's
    // enumeration). Every refusal is a SOFT decline (ExecutionLeaseAuthority
    // Error ⇒ trySet returns null ⇒ the client keeps running locally under
    // its own authority — no escalation), so a stage-off/mixed-cohort/denied
    // issuance fails open exactly like a lost lease. The foreign-engine opens
    // are awaits; the re-sample block below is their authority boundary.
    if (foreignReadSpaces.length > 0) {
      await this.#assertCrossSpaceReadIssuance(
        claimInput,
        foreignReadSpaces,
        laneGrant === null ? current.onBehalfOf : laneGrant.principal,
      );
    }
    this.expireExecutionClaims(claimNow);
    // Expiry publication can synchronously notify lifecycle listeners. Fence a
    // drain requested by that notification before installing new authority.
    this.#assertExecutionClaimCapabilityEnabled(claimInput);
    assertLaneGrantCurrent();
    if (
      this.#executionLeaseAuthorities.get(lease) !== authority ||
      this.#ownedExecutionLeases.get(
          executionLeaseKey(claimInput.space, claimInput.branch),
        ) !== authority ||
      authority.drainRequested
    ) {
      throw new ExecutionLeaseAuthorityError(
        "execution claim requires the current owned lease",
      );
    }
    const existing = this.#executionClaims.get(key);
    if (existing !== undefined) {
      throw new Error("execution claim is already live");
    }
    // Synchronous with the install and its publish: no await separates the
    // disjointness check from claim.set, so revoke-before-issue ordering on
    // the control feed is structural, not scheduled.
    this.#assertExecutionClaimRoutingDisjoint(claimInput);
    const claimGeneration = (authority.claimGenerations.get(key) ?? 0) + 1;
    authority.claimGenerations.set(key, claimGeneration);
    const ttlMs = this.options.executionControl?.claimTtlMs ?? 30_000;
    if (!isPositiveSafeInteger(ttlMs)) {
      throw new TypeError("execution claim ttl must be a positive integer");
    }
    const claim: ExecutionClaim = Object.freeze({
      ...canonicalActionClaimKey(claimInput),
      leaseGeneration: current.leaseGeneration,
      claimGeneration,
      expiresAt: Math.min(claimNow + ttlMs, current.expiresAt),
      // C3.6: record the host-verified foreign read spaces on the claim so
      // the C3.6b delivery gate narrows on one signal, and C3.7 keys its
      // epoch sidecar off the same set. Frozen array; absent when empty so a
      // same-space claim stays byte-identical.
      ...(foreignReadSpaces.length > 0
        ? { crossSpaceReadSpaces: Object.freeze([...foreignReadSpaces]) }
        : {}),
    });
    this.#executionClaims.set(key, claim);
    if (laneGrant !== null && laneKey !== undefined) {
      this.#executionClaimLaneBindings.set(key, {
        laneKey,
        laneGeneration: laneGrant.laneGeneration,
      });
    }
    this.executionStats.claimsIssued += 1;
    this.executionStats.claimsIssuedByContextKey[claim.contextKey] =
      (this.executionStats.claimsIssuedByContextKey[claim.contextKey] ?? 0) + 1;
    if (claimGeneration > 1) this.executionStats.claimsReissued += 1;
    this.#publishExecutionControl(Object.freeze({
      type: "session.execution.claim.set",
      claim,
    }));
    this.#scheduleExecutionClaimExpiry();
    return claim;
  }

  /** Extend one exact live claim without minting a new authority incarnation.
   * The executor still holds the same lease/claim generations, while the host
   * revalidates the durable lease, sponsor, demand, rollout flag, and WRITE
   * authority before moving the server-authored deadline. */
  async renewExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim | null> {
    const key = actionClaimMapKey(claim);
    this.expireExecutionClaims();
    const selected = this.#executionClaims.get(key);
    if (
      selected === undefined ||
      selected.leaseGeneration !== claim.leaseGeneration ||
      selected.claimGeneration !== claim.claimGeneration
    ) {
      return null;
    }
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(claim.space, claim.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      authority.drainRequested
    ) {
      this.revokeExecutionClaim(selected);
      return null;
    }
    const engine = await this.openEngine(claim.space);
    // Opening a first-use space can await filesystem and SQLite setup. Never
    // renew from the timestamp or claim object selected before that await: the
    // exact incarnation may have expired, been removed, or been replaced.
    const renewalNow = this.#executionNowMs();
    this.expireExecutionClaims(renewalNow);
    const live = this.#executionClaims.get(key);
    if (
      live === undefined ||
      live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      return null;
    }
    if (
      this.#executionLeaseAuthorities.get(lease) !== authority ||
      this.#ownedExecutionLeases.get(
          executionLeaseKey(claim.space, claim.branch),
        ) !== authority ||
      authority.drainRequested
    ) {
      this.revokeExecutionClaim(live);
      return null;
    }
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) {
      this.revokeExecutionClaim(live);
      return null;
    }
    // Disabling a claim rank revokes its live claims at renewal, mirroring
    // the flag-off revoke above; lower-rank claims are untouched.
    if (!this.#executionClaimRankEnabled(live)) {
      this.revokeExecutionClaim(live);
      return null;
    }
    // Amendment 12 (session lanes since C2.3): renewal re-checks
    // lane-grant liveness at the bound generation and revokes on mismatch —
    // an executor renewing across a drain can never keep a departed
    // principal's (or dead session's) claim alive.
    if (live.contextKey !== "space") {
      const binding = this.#executionClaimLaneBindings.get(key);
      if (
        binding === undefined ||
        this.#liveLaneGrantForKey(binding.laneKey)?.laneGeneration !==
          binding.laneGeneration
      ) {
        this.revokeExecutionClaim(live);
        return null;
      }
    }
    // Amendment 3: the routing-disjointness invariant is re-checked at
    // renewal; a chain-compatible sibling (a race artifact) revokes this
    // claim so clients fail open instead of matching two claims.
    for (const other of this.#executionClaims.values()) {
      if (
        other !== live && other.contextKey !== live.contextKey &&
        sameActionTupleAcrossLanes(other, live) &&
        executionClaimChainCompatible(other.contextKey, live.contextKey)
      ) {
        this.revokeExecutionClaim(live);
        return null;
      }
    }
    const current = Engine.currentExecutionLease(engine, {
      space: claim.space,
      branch: claim.branch,
      nowMs: renewalNow,
    });
    const sponsor = this.#sessions.get(
      claim.space,
      authority.sponsorSessionId,
    );
    const demand = this.#executionDemands.get(executionDemandKey(
      authority.sponsorConnectionId,
      claim.space,
      authority.sponsorSessionId,
      claim.branch,
    ));
    if (
      current === null || current.state !== "active" ||
      !this.#sameExecutionLease(current, lease) || sponsor === null ||
      sponsor.sessionToken !== authority.sponsorSessionToken ||
      demand === undefined || demand.principal !== current.onBehalfOf ||
      !this.#executionSponsorCanWrite(engine, demand, sponsor)
    ) {
      this.revokeExecutionClaim(live);
      return null;
    }
    const ttlMs = this.options.executionControl?.claimTtlMs ?? 30_000;
    if (!isPositiveSafeInteger(ttlMs)) {
      throw new TypeError("execution claim ttl must be a positive integer");
    }
    const renewed: ExecutionClaim = Object.freeze({
      ...live,
      expiresAt: Math.min(renewalNow + ttlMs, current.expiresAt),
    });
    if (renewed.expiresAt <= renewalNow) {
      this.revokeExecutionClaim(live);
      return null;
    }
    this.#executionClaims.set(key, renewed);
    this.#scheduleExecutionClaimExpiry();
    return renewed;
  }

  revokeExecutionClaim(claim: ExecutionClaim): boolean {
    this.expireExecutionClaims();
    const key = actionClaimMapKey(claim);
    const live = this.#executionClaims.get(key);
    if (
      live === undefined || live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      return false;
    }
    this.#executionClaims.delete(key);
    this.#executionClaimLaneBindings.delete(key);
    this.#publishExecutionClaimRevoke(live);
    this.#scheduleExecutionClaimExpiry();
    return true;
  }

  /** Read-only host gate for executor broker work and async continuations.
   * For a SCOPED-lane claim this is the brokered-egress authority consult
   * (C2.8): egress is authorized by the LIVE lane grant at the generation
   * bound at issuance — the same #liveLaneGrantForKey consult the commit
   * fence's laneAuthority closure uses — so a drained lane's in-flight
   * builtin can never egress. The drain already fences the generation and
   * sweeps the lane's claims in one synchronous section; the explicit
   * binding re-check here keeps the broker gate correct even if a future
   * drain path ever separates fence from sweep, and gives egress the exact
   * authority semantics commits have. Space claims are byte-identical to
   * the pre-C2.8 check. */
  hasLiveExecutionClaim(claim: ExecutionClaim): boolean {
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) {
      this.#revokeExecutionClaimsForSpace(claim.space);
      return false;
    }
    this.expireExecutionClaims();
    const key = actionClaimMapKey(claim);
    const live = this.#executionClaims.get(key);
    if (
      live === undefined ||
      live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      return false;
    }
    if (live.contextKey !== "space") {
      const binding = this.#executionClaimLaneBindings.get(key);
      if (
        binding === undefined ||
        this.#liveLaneGrantForKey(binding.laneKey)?.laneGeneration !==
          binding.laneGeneration
      ) {
        return false;
      }
    }
    return true;
  }

  publishActionSettlement(settlement: ActionSettlement): boolean {
    this.expireExecutionClaims();
    if (
      settlement.branch !== settlement.claim.branch ||
      !Number.isSafeInteger(settlement.inputBasisSeq) ||
      settlement.inputBasisSeq < 0
    ) {
      return false;
    }
    // C3.5: vector coherence — when present, the vector must contain
    // exactly one component for the settlement's own space and it must
    // equal the scalar (the engine authors them from one value; a caller
    // whose vector disagrees with its scalar is malformed), no duplicate
    // spaces, and every foreign component a positive stamped seq (served
    // stamps are positive by wire contract; the home scalar may be 0 for
    // a no-read attempt).
    if (settlement.inputBasis !== undefined) {
      const components = settlement.inputBasis;
      const spaces = new Set(components.map((component) => component.space));
      const home = inputBasisComponentForSpace(
        components,
        settlement.claim.space,
      );
      if (
        components.length === 0 ||
        spaces.size !== components.length ||
        home === undefined ||
        home.seq !== settlement.inputBasisSeq ||
        components.some((component) =>
          typeof component.space !== "string" ||
          component.space.length === 0 ||
          !Number.isSafeInteger(component.seq) ||
          component.seq < 0 ||
          (component.space !== settlement.claim.space && component.seq < 1)
        )
      ) {
        return false;
      }
    }
    if (
      settlement.outcome === "committed"
        ? !isPositiveSafeInteger(settlement.acceptedCommitSeq)
        : "acceptedCommitSeq" in settlement &&
          settlement.acceptedCommitSeq !== undefined
    ) {
      return false;
    }
    const key = actionClaimMapKey(settlement.claim);
    const live = this.#executionClaims.get(key);
    if (
      live === undefined ||
      live.leaseGeneration !== settlement.claim.leaseGeneration ||
      live.claimGeneration !== settlement.claim.claimGeneration
    ) {
      return false;
    }
    if (!this.memoryProtocolFlags().serverPrimaryExecutionV1) {
      this.#revokeExecutionClaimsForSpace(live.space);
      return false;
    }
    this.executionStats.settlementsPublished += 1;
    switch (settlement.outcome) {
      case "committed":
        this.executionStats.settlementsCommitted += 1;
        break;
      case "no-op":
        this.executionStats.settlementsNoOp += 1;
        break;
      case "failed":
        this.executionStats.settlementsFailed += 1;
        break;
      case "unserved":
        this.executionStats.settlementsUnserved += 1;
        break;
    }
    this.#publishExecutionControl(Object.freeze({
      type: "session.execution.settlement",
      settlement: Object.freeze({ ...settlement, claim: live }),
    }));
    return true;
  }

  #recordExecutionInvalidations(
    space: string,
    readers: readonly Engine.SchedulerActionState[],
    sourceSeq: number,
    startedAt: number,
  ): void {
    for (const reader of readers) {
      const key = executionInvalidationTimingKey({
        branch: reader.branch,
        space: reader.ownerSpace ?? space,
        pieceId: reader.pieceId,
        actionId: reader.actionId,
        contextKey: reader.executionContextKey,
      }, sourceSeq);
      // Coalesced notifications for one durable source retain the earliest
      // host timestamp. Later duplicate publication must not make the latency
      // look shorter.
      if (this.#executionInvalidationStartedAt.has(key)) continue;
      this.#executionInvalidationStartedAt.set(key, startedAt);
      while (
        this.#executionInvalidationStartedAt.size >
          MAX_PENDING_EXECUTION_INVALIDATION_TIMINGS
      ) {
        const oldest = this.#executionInvalidationStartedAt.keys().next().value;
        if (oldest === undefined) break;
        this.#executionInvalidationStartedAt.delete(oldest);
      }
    }
  }

  #recordExecutionInvalidationSettlement(
    attempt: Engine.AppliedActionAttempt,
  ): void {
    let earliestStartedAt: number | undefined;
    for (const sourceSeq of attempt.provenance.causedBy) {
      const key = executionInvalidationTimingKey({
        branch: attempt.claim.branch,
        space: attempt.claim.space,
        pieceId: attempt.claim.pieceId,
        actionId: attempt.claim.actionId,
        contextKey: attempt.claim.contextKey,
      }, sourceSeq);
      const startedAt = this.#executionInvalidationStartedAt.get(key);
      this.#executionInvalidationStartedAt.delete(key);
      if (
        startedAt !== undefined &&
        (earliestStartedAt === undefined || startedAt < earliestStartedAt)
      ) {
        earliestStartedAt = startedAt;
      }
    }
    if (earliestStartedAt !== undefined) {
      // One bounded-cardinality sample per published settlement. A coalesced
      // attempt starts at its oldest exact durable cause; timing state is
      // intentionally process-local, so a restart yields no fabricated value.
      executionControlLogger.time(
        earliestStartedAt,
        "invalidation-settlement",
      );
    }
  }

  listExecutionClaims(space: string): readonly ExecutionClaim[] {
    this.expireExecutionClaims();
    if (
      !this.memoryProtocolFlags().serverPrimaryExecutionV1 ||
      this.#openedEngines.get(space) === undefined
    ) {
      this.#revokeExecutionClaimsForSpace(space);
    }
    return Object.freeze(
      [...this.#executionClaims.values()]
        .filter((claim) => claim.space === space)
        .sort((left, right) =>
          left.branch.localeCompare(right.branch) ||
          actionClaimMapKey(left).localeCompare(actionClaimMapKey(right))
        ),
    );
  }

  /**
   * The host-level cross-space router (C3.1) — the registration seam for
   * per-space protocol endpoints and the hosted-space registry the
   * C3.1b `openEngine` gate consults. Since C3.1b it carries production
   * traffic: mirror upserts and durable dirt route through it (see the
   * `#crossSpaceRouter` field docblock). Exposed for tests and for
   * C3.10a's link substrate; the transport's loopback channel is the
   * transcript-observation seam (an `onMessage` tap observes every
   * routed frame without disturbing dispatch).
   */
  crossSpaceRouter(): CrossSpaceHostRouter {
    return this.#crossSpaceRouter;
  }

  async close(): Promise<void> {
    this.cancelScheduledRefresh();
    if (this.#executionClaimExpiryTimer !== null) {
      clearTimeout(this.#executionClaimExpiryTimer);
      this.#executionClaimExpiryTimer = null;
    }
    if (this.#executionLeaseExpiryTimer !== null) {
      clearTimeout(this.#executionLeaseExpiryTimer);
      this.#executionLeaseExpiryTimer = null;
    }
    await this.#refreshing;
    await this.flushExecutionLeaseTasks();
    for (const authority of [...this.#ownedExecutionLeases.values()]) {
      await this.finishExecutionLeaseDrain(authority.handle);
    }
    if (this.#executionLeaseExpiryTimer !== null) {
      clearTimeout(this.#executionLeaseExpiryTimer);
      this.#executionLeaseExpiryTimer = null;
    }
    // C3.4 teardown: fail every pending foreign point read closed —
    // never strand an awaiting provider channel on a closing host.
    for (const [requestId, pending] of this.#pendingForeignPointReads) {
      clearTimeout(pending.timer);
      this.#pendingForeignPointReads.delete(requestId);
      pending.resolve({
        status: "failed",
        code: FOREIGN_POINT_READ_UNAVAILABLE,
      });
    }
    // C3.3a teardown: stop new reconciles, release every pending C3A10
    // ack barrier (fail-open — a closing host must not strand a chain),
    // and drain in-flight subscription work before the engines close.
    this.#foreignSubscriptionsClosed = true;
    for (const state of this.foreignReaderSubscriptionsByHomeSpace.values()) {
      for (const resolve of state.ackWaiters.values()) resolve();
      state.ackWaiters.clear();
    }
    await this.settleForeignReaderSubscriptions().catch(() => {});
    // Drain in-flight cross-space applies before closing the engines they
    // write into (transact awaits them already; this covers crafted or
    // late-arriving frames).
    await this.settleCrossSpaceDeliveries().catch(() => {});
    for (const engine of this.#engines.values()) {
      Engine.close(await engine);
    }
    this.#engines.clear();
    this.#openedEngines.clear();
    this.#connections.clear();
    this.#acceptedCommitListeners.clear();
    this.#foreignWakeListeners.clear();
    this.foreignReaderSubscriptionsByReadSpace.clear();
    this.foreignReaderSubscriptionsByHomeSpace.clear();
    this.#acceptedCommitOrderBySpace.clear();
    this.#executionDemands.clear();
    this.#executionDemandRegistrationOrder.clear();
    this.#executionDemandSessionTokens.clear();
    this.#executionDemandListeners.clear();
    this.#executionClaims.clear();
    this.#boundExecutionSessions.clear();
    this.#ownedExecutionLeases.clear();
    this.#executionInvalidationStartedAt.clear();
    this.#readPool.close();
    this.#crossSpaceRouter.close();
  }

  /**
   * Subscribe to accepted commits for one exact space. The callback is a
   * host-side execution primitive, not a client protocol surface. Listener
   * failures are contained because a commit is already durable by the time it
   * is published and must never be reported as rejected afterward.
   */
  subscribeAcceptedCommits(
    space: string,
    listener: AcceptedCommitListener,
  ): () => void {
    let listeners = this.#acceptedCommitListeners.get(space);
    if (listeners === undefined) {
      listeners = new Set();
      this.#acceptedCommitListeners.set(space, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.#acceptedCommitListeners.get(space);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#acceptedCommitListeners.delete(space);
      }
    };
  }

  /**
   * C3.3a: subscribe to FOREIGN wakes for a home space — read-space
   * commits (and window/scan closures) that made the home space's
   * mirrored-foreign-read actions stale. The executor pool's foreign-wake
   * entry and the executor provider's running-Worker notice leg are the
   * intended consumers (C3A11). Same lifecycle shape as
   * {@link subscribeAcceptedCommits}.
   */
  subscribeForeignWakes(
    space: string,
    listener: ForeignWakeListener,
  ): () => void {
    let listeners = this.#foreignWakeListeners.get(space);
    if (listeners === undefined) {
      listeners = new Set();
      this.#foreignWakeListeners.set(space, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.#foreignWakeListeners.get(space);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#foreignWakeListeners.delete(space);
      }
    };
  }

  #dispatchForeignWake(event: ForeignWakeEvent): void {
    const frozen = Object.freeze({
      ...event,
      staleForeignReaders: Object.freeze(
        event.staleForeignReaders.map((reader) => Object.freeze({ ...reader })),
      ),
    });
    for (const listener of this.#foreignWakeListeners.get(event.space) ?? []) {
      try {
        const result = listener(frozen);
        if (result instanceof Promise) {
          void result.catch((error) => {
            console.warn("foreign wake listener failed", error);
          });
        }
      } catch (error) {
        console.warn("foreign wake listener failed", error);
      }
    }
  }

  /**
   * A4 wake widening (C1.8, session lanes since C2.7): one lookup pair
   * per lane — the space lane against the union of all demand (ALWAYS the
   * first entry, possibly with zero pieces), plus every OPEN lane grant on
   * this (space, branch) against its own demand slice: a USER lane against
   * ONLY that principal's aggregated demand, a SESSION lane against ONLY
   * its owning session's demand (design §2 — a session's demand implies
   * demand for its own lane; sibling sessions and the principal's
   * aggregate never stand in). A parked principal or disconnected session
   * (rows but no lane grant) gets no lane entry, so its rows accumulate
   * dirt without waking anything — the CA13 parked skip is EMERGENT from
   * session-end = lane-end (C2.3) plus this grant-keyed pairing; there is
   * no parked-lane state to consult.
   *
   * Shared since C3.3a between `#publishAcceptedCommit`'s home lookup and
   * the foreign-reader subscription derivation (C3A17's lane symmetry:
   * user AND session grants join the foreign lookup through this same
   * shape), so the two joins cannot skew.
   */
  #executionWakeLaneDemands(
    space: string,
    branch: BranchName,
  ): { contextKey: Engine.SchedulerExecutionContextKey; pieces: string[] }[] {
    const branchDemands = this.listExecutionDemands(space, branch);
    const demandedSchedulerPieceIds = [
      ...new Set(
        branchDemands.flatMap(
          (demand) => demand.pieces.map(canonicalSchedulerPieceIdForDemandRoot),
        ),
      ),
    ];
    const laneLookups: {
      contextKey: Engine.SchedulerExecutionContextKey;
      pieces: string[];
    }[] = [{ contextKey: "space", pieces: demandedSchedulerPieceIds }];
    for (const grant of this.#openUserLaneGrantsFor(space, branch)) {
      const pieces = [
        ...new Set(
          branchDemands
            .filter((demand) => demand.principal === grant.principal)
            .flatMap((demand) =>
              demand.pieces.map(canonicalSchedulerPieceIdForDemandRoot)
            ),
        ),
      ];
      if (pieces.length > 0) {
        laneLookups.push({ contextKey: grant.contextKey, pieces });
      }
    }
    for (const grant of this.#openSessionLaneGrantsFor(space, branch)) {
      const pieces = [
        ...new Set(
          branchDemands
            .filter((demand) =>
              demand.sessionId === grant.sessionId &&
              demand.principal === grant.principal
            )
            .flatMap((demand) =>
              demand.pieces.map(canonicalSchedulerPieceIdForDemandRoot)
            ),
        ),
      ];
      if (pieces.length > 0) {
        laneLookups.push({ contextKey: grant.contextKey, pieces });
      }
    }
    return laneLookups;
  }

  #publishAcceptedCommit(
    event: {
      space: string;
      originSessionId?: string;
      deliverySeq: number;
      commit: Engine.AppliedCommit;
    },
  ): void {
    const acceptedAt = performance.now();
    const order = (this.#acceptedCommitOrderBySpace.get(event.space) ?? 0) + 1;
    this.#acceptedCommitOrderBySpace.set(event.space, order);
    const revisions = Object.freeze(
      event.commit.revisions.map((revision) =>
        Object.freeze({
          branch: revision.branch,
          id: revision.id,
          ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
          scopeKey: revision.scopeKey,
          seq: revision.seq,
          op: revision.op,
        })
      ),
    );
    const schedulerUpdateIds = Object.freeze([
      ...new Set([
        ...(event.commit.schedulerObservationResults ?? []).flatMap((result) =>
          result.status === "kept" &&
            result.schedulerObservationId !== undefined
            ? [result.schedulerObservationId]
            : []
        ),
        ...(event.commit.schedulerDirtiedReaders ?? []).map((reader) =>
          reader.observationId
        ),
      ]),
    ].sort((left, right) => left - right));
    const laneLookups = this.#executionWakeLaneDemands(
      event.space,
      event.commit.branch,
    );
    const demandedSchedulerPieceIds = laneLookups[0].pieces;
    const engine = this.#openedEngines.get(event.space);
    const dirtyTargets = event.commit.schedulerDirtiedReaders?.map((reader) =>
      reader.read
    );
    let staleDemandedReaders: readonly Engine.SchedulerActionState[] = Object
      .freeze([]);
    if (
      engine !== undefined && demandedSchedulerPieceIds.length > 0 &&
      dirtyTargets !== undefined
    ) {
      const lookupStartedAt = performance.now();
      try {
        const collected: Engine.SchedulerActionState[] = [];
        for (const lane of laneLookups) {
          if (lane.pieces.length === 0) continue;
          this.executionStats.acceptedCommitIndexLookups += 1;
          // schedulerDirtiedReaders is action-derived, so two actions may
          // supply the same address. Count pre-dedup candidates here rather
          // than claiming this is the engine's internal unique-probe count.
          this.executionStats.acceptedCommitIndexTargetCandidates +=
            dirtyTargets.length;
          this.executionStats.acceptedCommitIndexDemandedPieces +=
            lane.pieces.length;
          // Context keys are disjoint across lane lookups, so the collected
          // rows cannot duplicate across calls.
          collected.push(
            ...Engine.staleReadersForTargets(engine, {
              branch: event.commit.branch,
              ownerSpace: event.space,
              targets: dirtyTargets,
              demandedSchedulerPieceIds: lane.pieces,
              applicableExecutionContextKeys: [lane.contextKey],
              dirtySeq: event.commit.seq,
            }).map((reader) => Object.freeze({ ...reader })),
          );
        }
        staleDemandedReaders = Object.freeze(collected);
        this.executionStats.acceptedCommitIndexMatches +=
          staleDemandedReaders.length;
      } finally {
        executionControlLogger.time(
          lookupStartedAt,
          "stale-reader-lookup",
        );
      }
    }
    this.#recordExecutionInvalidations(
      event.space,
      staleDemandedReaders,
      event.commit.seq,
      acceptedAt,
    );
    // C3.3a: this space is a READ space for any foreign home space with a
    // live demand-joined subscription — consult the commit's dirtied
    // MIRRORED rows and emit `ForeignStaleReaders` (the live wake path;
    // the C3.1b dirt mark that preceded this publish on the same FIFO
    // link is the durable ledger). No-op without subscriptions.
    if (engine !== undefined && dirtyTargets !== undefined) {
      this.#emitForeignStaleReaderNotices(
        event.space,
        event.commit,
        dirtyTargets,
        engine,
      );
    }
    const orderedEvent: AcceptedCommitEvent = Object.freeze({
      order,
      deliverySeq: event.deliverySeq,
      space: event.space,
      ...(event.originSessionId !== undefined
        ? { originSessionId: event.originSessionId }
        : {}),
      branch: event.commit.branch,
      dataSeq: event.commit.seq,
      revisions,
      schedulerUpdateIds,
      staleDemandedReaders,
    });
    for (
      const listener of this.#acceptedCommitListeners.get(event.space) ?? []
    ) {
      try {
        const result = listener(orderedEvent);
        if (result instanceof Promise) {
          void result.catch((error) => {
            console.warn("accepted commit listener failed", error);
          });
        }
      } catch (error) {
        console.warn("accepted commit listener failed", error);
      }
    }
  }

  /**
   * C3.3a — the committing (read) host's half of the foreign wake: for
   * every foreign home space holding a live subscription on this space,
   * run the A4-shaped per-lane stale-reader lookup against THIS engine's
   * MIRRORED rows (`staleReadersForTargets` with `ownerSpace` = the home
   * space — the mirror partition) and emit one `ForeignStaleReaders` per
   * home space that matched. Runs synchronously inside
   * `#publishAcceptedCommit`, which both call sites reach only AFTER
   * awaiting the commit's post-commit side effects — so the C3.1b
   * `ForeignDirtyMark` for this commit was already sent on the same FIFO
   * link, and the home host applies dirt before it dispatches this
   * notice's wake (the dirt-before-wake invariant the home arm relies
   * on).
   *
   * Branch note (decision #4, v1): mirrored rows land under the HOME
   * branch and this lookup runs under the COMMITTING branch — the
   * default-branch pairing is the only supported v1 shape, where the two
   * coincide; a non-default commit simply finds no mirrored rows.
   *
   * The lookup itself deliberately mirrors the home A4 join (per-lane
   * `applicableExecutionContextKeys`) rather than filtering
   * `schedulerDirtiedReaders` directly: the state lookup also surfaces
   * unknown-provenance rows, staying semantically identical to the home
   * wake so the two paths cannot drift.
   */
  #emitForeignStaleReaderNotices(
    space: string,
    commit: Engine.AppliedCommit,
    dirtyTargets: readonly Engine.SchedulerWriteAddress[],
    engine: Engine.Engine,
  ): void {
    const byHome = this.foreignReaderSubscriptionsByReadSpace.get(space);
    if (byHome === undefined || byHome.size === 0) return;
    if (dirtyTargets.length === 0) return;
    // The commit's own dirtied readers name every foreign owner space it
    // touched (mirrored-row dirt is written synchronously by applyCommit),
    // so owners outside this set need no engine consult.
    const dirtiedOwners = new Set(
      (commit.schedulerDirtiedReaders ?? []).flatMap((reader) =>
        reader.ownerSpace !== undefined && reader.ownerSpace !== space
          ? [reader.ownerSpace]
          : []
      ),
    );
    if (dirtiedOwners.size === 0) return;
    for (const [subscriptionKey, subscription] of byHome) {
      const homeSpace = subscriptionKey.split("\0")[0];
      if (!dirtiedOwners.has(homeSpace)) continue;
      const collected: Engine.SchedulerActionState[] = [];
      for (const lane of subscription.laneDemands) {
        if (lane.pieces.length === 0) continue;
        // Context keys are disjoint across lanes (same rule as the home
        // A4 join), so rows cannot duplicate across lookups.
        collected.push(
          ...Engine.staleReadersForTargets(engine, {
            branch: commit.branch,
            ownerSpace: homeSpace,
            targets: [...dirtyTargets],
            demandedSchedulerPieceIds: [...lane.pieces],
            applicableExecutionContextKeys: [lane.contextKey],
            dirtySeq: commit.seq,
          }),
        );
      }
      if (collected.length === 0) continue;
      try {
        this.#crossSpaceRouter.link(space, homeSpace).send({
          type: "foreign-stale-readers",
          branch: commit.branch,
          commitSeq: commit.seq,
          readers: collected.map((row) => ({
            branch: row.branch,
            pieceId: row.pieceId,
            processGeneration: row.processGeneration,
            actionId: row.actionId,
            executionContextKey: row.executionContextKey,
          })),
        });
      } catch (error) {
        // The commit is durable and the dirt mark already flowed; a
        // failed notice send degrades to the ledger + scan path.
        console.warn("foreign stale-readers notice emission failed:", error);
      }
    }
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
    // C3.2: a direct write can mutate the ACL doc only in acl-off mode
    // (guarded above otherwise), but the engine's epoch bump is
    // mode-independent — publish whatever the transaction recorded.
    if (this.#publishAuthorizationEpochBumps(space, commit)) {
      await this.settleCrossSpaceDeliveries();
    }
    await this.runPostCommitSchedulerSideEffects(
      space,
      commit,
      [],
      new Map(),
      undefined,
      undefined,
    );
    this.#publishAcceptedCommit({
      space,
      deliverySeq: commit.seq,
      commit,
    });
    // Direct writes are space-scoped; the revision-derived cohort keeps the
    // producer uniform with transact (F6).
    this.markSpaceDirty(
      space,
      [toDirtyKey(id)],
      undefined,
      revisionScopeKeys(commit),
    );
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
            ...this.#scopeContextForSession(message.space, session),
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
    executionLease?: ExecutionLeaseHandle,
  ): Promise<ResponseMessage<SessionOpenResult>> {
    try {
      let principal: string | undefined;
      if (executionLease === undefined) {
        const authContext = connection.sessionOpenAuthContext(message);
        principal = await this.options.authorizeSessionOpen(
          message,
          authContext,
        );
        connection.consumeSessionOpenChallenge(authContext.challenge);
      } else {
        if (message.space !== executionLease.space) {
          throw authorizationError(
            `execution lease is bound to ${executionLease.space}`,
          );
        }
        const authority = this.#executionLeaseAuthorities.get(executionLease);
        const owned = this.#ownedExecutionLeases.get(
          executionLeaseKey(executionLease.space, executionLease.branch),
        );
        const sponsor = authority === undefined ? null : this.#sessions.get(
          executionLease.space,
          authority.sponsorSessionId,
        );
        if (
          authority === undefined || authority !== owned ||
          sponsor === null ||
          sponsor.ownerConnectionId !== authority.sponsorConnectionId ||
          sponsor.sessionToken !== authority.sponsorSessionToken ||
          sponsor.principal !== executionLease.onBehalfOf ||
          !this.#connections.has(authority.sponsorConnectionId)
        ) {
          throw authorizationError(
            "execution lease sponsor is no longer attached",
          );
        }
        const leaseEngine = await this.openEngine(executionLease.space);
        const current = Engine.currentExecutionLease(leaseEngine, {
          space: executionLease.space,
          branch: executionLease.branch,
          nowMs: this.#executionNowMs(),
        });
        if (
          current === null || current.state !== "active" ||
          !this.#sameExecutionLease(current, executionLease)
        ) {
          throw authorizationError("execution lease is not active");
        }
        principal = executionLease.onBehalfOf;
      }
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
      const requiredExecutionCapabilities = this.memoryProtocolFlags();
      if (
        requiredExecutionCapabilities.serverPrimaryExecutionV1 &&
        missesRequiredExecutionCapability(
          requiredExecutionCapabilities,
          connection,
        )
      ) {
        return respondTypedError<SessionOpenResult>(
          message.requestId,
          toError(
            "ProtocolError",
            `Space ${message.space} requires memory capabilities ${
              requiredExecutionCapabilityNames(requiredExecutionCapabilities)
            }`,
          ),
        );
      }
      const opened = this.#sessions.open(
        message.space,
        message.session,
        Engine.serverSeq(engine),
        connection.id,
        principal,
        {
          serverPrimaryExecutionV1: connection.serverPrimaryExecutionV1,
          serverPrimaryExecutionClaimRoutingV1:
            connection.serverPrimaryExecutionClaimRoutingV1,
          serverPrimaryExecutionBuiltinPassivityV1:
            connection.serverPrimaryExecutionBuiltinPassivityV1,
          serverPrimaryExecutionContextLatticeClaimsV1:
            connection.serverPrimaryExecutionContextLatticeClaimsV1,
          serverPrimaryExecutionCrossSpaceClaimsV1:
            connection.serverPrimaryExecutionCrossSpaceClaimsV1,
          serverPrimaryExecutionDocSetWatchV1:
            connection.serverPrimaryExecutionDocSetWatchV1,
        },
      );
      if (opened.revokedConnectionId !== undefined) {
        this.#connections.get(opened.revokedConnectionId)?.revokeSession(
          message.space,
          opened.sessionId,
          "taken-over",
        );
      }
      // Principal-wide cohort gate, amendment-11 fence locus: every attach —
      // new, resumed, or takeover, capability flags recomputed per attach —
      // that lacks context-lattice-claims-v1 synchronously fences the
      // principal's live user lanes AND the attaching session's own session
      // lane (C2.3) — generation bump + claim revoke — HERE,
      // before the resumed catch-up awaits, before attachExecutionFeed builds
      // this response's snapshot, and before the open response releases. The
      // bounded Worker drain may finish asynchronously; client-side ordering
      // of non-negotiating clients is out of contract.
      if (!connection.serverPrimaryExecutionContextLatticeClaimsV1) {
        this.#fenceLanesForNonNegotiatingAttach(
          message.space,
          principal,
          opened.sessionId,
        );
      }
      // C3.6b amendment-11 fence (same locus, same timing): an attach that
      // does not negotiate cross-space-claims-v1 revokes the live
      // cross-space-read claims of every cohort it joins, before the snapshot
      // builds and the open response releases.
      if (!connection.serverPrimaryExecutionCrossSpaceClaimsV1) {
        this.#fenceCrossSpaceReadClaimsForNonNegotiatingAttach(
          message.space,
          principal,
          opened.sessionId,
          connection.serverPrimaryExecutionClaimRoutingV1,
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
      const openSync = connection.serverPrimaryExecutionV1
        ? this.attachExecutionFeed(
          message.space,
          opened.sessionId,
          catchup?.effect ?? {
            type: "sync",
            fromSeq: opened.serverSeq,
            toSeq: opened.serverSeq,
            upserts: [],
            removes: [],
          },
          { snapshotFromFeedSeq: message.session.executionFeedSeq ?? 0 },
        )
        : catchup?.effect;
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
          serverSeq: opened.serverSeq,
          caughtUpLocalSeq: opened.caughtUpLocalSeq,
          ...(opened.resumed === true ? { resumed: true } : {}),
          ...(openSync ? { sync: openSync } : {}),
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
    if (message.executionFeedSeq !== undefined) {
      this.#sessions.pruneExecutionEvents(
        session,
        message.executionFeedSeq,
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
        let exactClaimedActionAttempt = false;
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
          // ACL documents change authorization rules and are OWNER-only.
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
          const executionBinding = this.#boundExecutionSessionForCommit(
            message.space,
            message.commit.branch ?? "",
            session,
          );
          const scopeContext = this.#scopeContextForSession(
            message.space,
            session,
          );
          const executionLeaseFence = this.#executionLeaseFenceForCommit(
            message.space,
            session,
            executionBinding,
          );
          const executionClaims = this.#executionClaimsForCommit(
            message.space,
            message.commit.branch ?? "",
            executionBinding,
            schedulerObservations,
          );
          exactClaimedActionAttempt = executionClaims !== undefined;
          // C3.5: validate Worker-asserted foreign read stamps against the
          // host's own served-point-read records BEFORE the engine authors
          // any basis (the engine receives only host-validated components).
          const foreignInputBases = this.#foreignInputBasesForCommit(
            executionClaims,
            schedulerObservations,
          );
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
                applicableExecutionContextKeys: this
                  .#schedulerApplicableContextKeysForSession(
                    message.space,
                    session,
                    scopeContext,
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
          // A bound executor can never pass the claimed-action firewall with
          // a folded SQLite operation. Do not ATTACH/create its cell database
          // before the Engine has rejected the transaction atomically.
          const claimedActionAttempt = executionBinding !== undefined &&
            schedulerObservations.some(({ observation }) =>
              observation.executionClaimAssertion !== undefined
            );
          const sqliteAttachments = !claimedActionAttempt
            ? this.#attachCommitSqliteDbs(
              engine,
              message.space,
              commitPayload.operations,
              scopeContext,
            )
            : new Map<string, string>();
          let commit: Engine.AppliedCommit;
          try {
            commit = tracer.startActiveSpan(
              "memory.commit.persist",
              (persistSpan) => {
                try {
                  return Engine.applyCommit(engine, {
                    sessionId: message.sessionId,
                    scopeSessionId: scopeContext.sessionId,
                    space: message.space,
                    // Sponsor identity: lease fence, replay/pending-read
                    // sessionKey, provenance.onBehalfOf (C1.4).
                    principal: session.principal,
                    // Acting context: scope resolution, effective-context
                    // resolution, CFC label validation (C1.4). Derived from
                    // the host-resolved claims' single lane.
                    actingContext: executionClaimsActingContext(
                      executionClaims,
                    ),
                    commit: commitPayload,
                    executionClaims,
                    executionLeaseFence,
                    sqliteAttachments,
                    foreignInputBases,
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
          // C3.2: publish the transaction's epoch bumps SYNCHRONOUSLY —
          // before any await — so per-space send order over the link is
          // commit order (a concurrent transact's applyCommit can only
          // interleave at an await). A replay carries no bumps
          // (`authorizationEpochBumpsOf` keys the first-application
          // object), so redelivered ACL commits never republish.
          const publishedEpochBumps = this.#publishAuthorizationEpochBumps(
            message.space,
            commit,
          );
          const acceptedDeliverySeq = commitPayload.operations.length === 0 &&
              commit.schedulerObservationResults?.some((result) =>
                result.status === "kept"
              )
            ? Engine.serverSeq(engine) + 1
            : commit.seq;
          const reconciledExecutionBranches = new Set<BranchName>();
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
            for (
              const branch of await this.#drainIneligibleExecutionLeases(
                engine,
                message.space,
              )
            ) {
              reconciledExecutionBranches.add(branch);
            }
            // A2 third leg (C1.8, session lanes since C2.3): user and
            // session lanes are fenced and their claims revoked in the same
            // reconciliation — a principal who lost WRITE, or whose anchor
            // session the revocation step removed, must not keep an
            // executable lane past the ACL response.
            for (
              const branch of this.#drainIneligibleLanes(
                engine,
                message.space,
              )
            ) {
              reconciledExecutionBranches.add(branch);
            }
          }
          // An ACL response is the client-visible transition boundary.
          // Do not release it while a host-local pool can still retain the
          // fenced lease and Worker: the awaited snapshot makes the pool
          // observe renewal loss, stop that realm, and acquire a fresh shadow
          // generation for every affected lane.
          await Promise.all(
            [...reconciledExecutionBranches].map((branch) =>
              this.#publishExecutionDemandsAndWait(message.space, branch)
            ),
          );
          if (publishedEpochBumps) {
            // Same-host application barrier (C3.1b discipline): the ACL
            // response resolves only after peer-side inboxes merged the
            // bumps — no ack message exists (idempotence rides epoch
            // monotonicity); cross-host, C3.10b owns the equivalent.
            await this.settleCrossSpaceDeliveries();
          }
          const acceptedSchedulerObservations = this
            .#acceptedSchedulerObservations(
              schedulerObservations,
              commit,
            );
          await this.runPostCommitSchedulerSideEffects(
            message.space,
            commit,
            acceptedSchedulerObservations,
            previousReadSpaces,
            session,
            scopeContext.principal === undefined ? undefined : {
              principal: scopeContext.principal,
              sessionId: scopeContext.sessionId,
            },
          );
          if (!Engine.isAppliedCommitReplay(commit)) {
            this.#publishAcceptedCommit({
              space: message.space,
              originSessionId: message.sessionId,
              deliverySeq: acceptedDeliverySeq,
              commit,
            });
            this.#publishAcceptedActionAttempts(commit);
          }
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
            // F6: each key's delivery cohort derives from the applied
            // revision's resolved scope key (FA9's per-address rule) — the
            // engine stamped it under this commit's validated scope context,
            // including the C1.4b acting lane for claimed lane commits.
            revisionScopeKeys(commit),
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
          if (error instanceof Engine.ExecutionLeaseFenceError) {
            this.executionStats.leaseFenceRejects += 1;
            this.executionStats.leaseFenceRejectCauses[error.fenceCause] =
              (this.executionStats.leaseFenceRejectCauses[error.fenceCause] ??
                0) + 1;
          }
          if (error instanceof Engine.ExecutionActionFirewallError) {
            this.executionStats.actionFirewallRejects += 1;
          }
          let retryAfterSeq: number | undefined;
          if (error instanceof Engine.ConflictError) {
            if (exactClaimedActionAttempt) {
              this.executionStats.claimedActionConflicts += 1;
            }
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
              : error instanceof Engine.ExecutionLeaseFenceError
              ? error.name
              : error instanceof Engine.ExecutionActionFirewallError
              ? error.name
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
          if (error instanceof Engine.ExecutionActionFirewallError) {
            responseError.diagnosticCode = error.diagnosticCode;
          }
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
      // C1.4b: the acting lane (if any) is validated against the live lane
      // grant BEFORE any scope key resolves.
      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<GraphQueryResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      return {
        type: "response",
        requestId: message.requestId,
        ok: await this.evaluateGraphQuery(
          message.space,
          message.query,
          aclEngine,
          undefined,
          scopeResolution.ok,
          message.trigger,
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

  /** F2 point reads (FA5): exact engine reads for docs the caller already
   * tracks — replica maintenance without schema/link traversal. Authorization,
   * acting-context validation (FA6), and per-row scope resolution are the
   * graph.query path's, byte-identical; only the traverser is skipped. */
  async docsRead(
    message: DocsReadRequest,
  ): Promise<ResponseMessage<DocsReadResult>> {
    const startedAt = performance.now();
    // C3.4: a claim reference rides docs.read ONLY on the executor
    // provider's FOREIGN arm, which never reaches this direct serve
    // path. A home/direct read carrying one is a protocol error, not an
    // ignorable extra — silently dropping it would hide a misrouted
    // foreign read as a healthy home read.
    if (message.executionClaim !== undefined) {
      return respondTypedError<DocsReadResult>(
        message.requestId,
        toError(
          "ProtocolError",
          "executionClaim rides only executor foreign point reads",
        ),
      );
    }
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<DocsReadResult>(
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
        return respondTypedError<DocsReadResult>(message.requestId, deny);
      }
    }
    try {
      // C1.4b: the acting lane (if any) is validated against the live lane
      // grant BEFORE any scope key resolves.
      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<DocsReadResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      const engine = aclEngine ?? await this.openEngine(message.space);
      const { docs, branch, atSeq } = message.query;
      const entities: EntitySnapshot[] = [];
      for (const doc of docs) {
        const state = Engine.readState(engine, {
          id: doc.id,
          scope: doc.scope,
          ...(branch !== undefined ? { branch } : {}),
          // One sequence bound for the whole batch: a coalesced wave reads
          // from a single snapshot (absent means head).
          ...(atSeq !== undefined ? { seq: atSeq } : {}),
          principal: scopeResolution.ok.principal,
          sessionId: scopeResolution.ok.sessionId,
        });
        // Never-written docs are omitted; deleted docs surface with a null
        // document so the reader can distinguish tombstone from unknown.
        if (state === null) continue;
        entities.push({
          branch: state.branch,
          id: state.id,
          ...(state.scope !== "space" ? { scope: state.scope } : {}),
          scopeKey: state.scopeKey,
          seq: state.seq,
          document: state.document,
        });
      }
      // F1 attribution: point reads are engine reads with zero traversals —
      // the observable contrast the F2 acceptance counts against graph.query.
      this.#recordFeedTraversal("docs.read", {
        managerReads: docs.length,
        coveredSelectorSkips: 0,
        schemaTraversals: 0,
        pointerTraversals: 0,
        arrayTraversals: 0,
        objectTraversals: 0,
        dagTraversals: 0,
        getDocAtPathCalls: 0,
        schemaMemoHits: 0,
      });
      recordSlowQueryDuration("docs.read", message.space, startedAt, {
        roots: docs.length,
      });
      return {
        type: "response",
        requestId: message.requestId,
        ok: { serverSeq: Engine.serverSeq(engine), entities },
      };
    } catch (error) {
      return respondTypedError<DocsReadResult>(
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
      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<SchedulerSnapshotListResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      const page = Engine.listSchedulerActionSnapshots(
        engine,
        {
          ...message.query,
          applicableExecutionContextKeys: this
            .#schedulerApplicableContextKeysForSession(
              message.space,
              session,
              scopeResolution.ok,
              message.actingContext,
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

  async writersForTargets(
    message: SchedulerWriterListRequest,
  ): Promise<ResponseMessage<SchedulerWritersForTargetsResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<SchedulerWritersForTargetsResult>(
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
        return respondTypedError<SchedulerWritersForTargetsResult>(
          message.requestId,
          deny,
        );
      }

      if (!getPersistentSchedulerStateConfig()) {
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq: Engine.serverSeq(engine),
            writers: [],
          },
        };
      }

      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<SchedulerWritersForTargetsResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      const scopeContext = scopeResolution.ok;

      const targets: Engine.SchedulerWriterTarget[] = message.query.targets.map(
        (target) => ({
          space: message.space,
          id: target.id,
          scope: target.scope,
          scopeKey: Engine.resolveScopeKey(target.scope, scopeContext),
          path: [...target.path],
        }),
      );
      const writers: SchedulerWritersForTargetsResult["writers"] = Engine
        .writersForTargets(engine, {
          branch: message.query.branch,
          ownerSpace: message.space,
          targets,
          applicableExecutionContextKeys: this
            .#schedulerApplicableContextKeysForSession(
              message.space,
              session,
              scopeContext,
              message.actingContext,
            ),
        }).map((writer) => ({
          ...writer,
          matchedWrites: writer.matchedWrites.map((match) => ({
            kind: match.kind,
            write: {
              space: match.write.space,
              id: match.write.id,
              scope: match.write.scope ?? "space",
              scopeKey: match.write.scopeKey,
              path: toDocumentPath(match.write.path),
            },
          })),
        }));
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          writers,
        },
      };
    } catch (error) {
      return respondTypedError<SchedulerWritersForTargetsResult>(
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
      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<WatchSetResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      const gate = this.#docSetWatchGate(
        message.space,
        session,
        message.watches,
      );
      if (gate.error) {
        return respondTypedError<WatchSetResult>(
          message.requestId,
          gate.error,
        );
      }
      const actingPrincipal =
        message.actingContext !== undefined && message.actingContext !== "space"
          ? scopeResolution.ok.principal
          : undefined;
      // C2.4: a SESSION acting context pins the lane's session id (the
      // GRANT's, already substituted by #actingReadScopeContext) to the
      // watch set, so refresh and member fan-out keep resolving the lane's
      // own session instances (CA8). User lanes leave it undefined — user
      // scope keys ignore the session id.
      const actingSessionId = message.actingContext !== undefined &&
          Engine.parseSessionExecutionContextKey(message.actingContext) !==
            undefined
        ? scopeResolution.ok.sessionId
        : undefined;
      const { serverSeq, graphs, entities } = await this.evaluateWatchSet(
        message.space,
        message.watches,
        aclEngine,
        scopeResolution.ok,
      );
      const sync = buildFullSync(
        session.entities,
        entities,
        session.seenSeq,
        serverSeq,
      );
      // F3 doc-set membership (replace semantics): register the new watches'
      // members, then re-justify EVERY watch-sourced contribution against the
      // NEW set (FA8/FB6) — a surviving watch id whose docs list narrowed
      // drops its source from members it no longer names, and a dropped watch
      // id keeps nothing. Registering first preserves each surviving member's
      // lastSentSeq (FA15) — a re-registration is not a reseed.
      const { memberKeys, retainedPairs } = this.#registerDocSetMembers(
        session,
        gate.docsWatches,
        scopeResolution.ok,
      );
      this.#reconcileDocSetWatchSources(session, retainedPairs);
      this.#updateDocSetMembersGauge();
      // FW1 (FB1): consulted AFTER registration and source drops, so the
      // demoting frame keeps its members and genuinely dropped docs still
      // remove.
      suppressDocSetMemberRemoves(sync, session.docSetMembers);
      session.watches = message.watches;
      // The registration's acting identity is part of the watch set: the
      // full-re-evaluation refresh resolves under it, so a lane watch never
      // silently flips back to the sponsor's instances. Per-lane watch
      // LIFECYCLE (drain clearing lane watches, one set per lane) is C1.5b.
      session.watchScopePrincipal = actingPrincipal;
      session.watchScopeSessionId = actingSessionId;
      session.graphs = graphs;
      session.entities = entities;
      // FA14 union surface; also folds in the just-registered member ids.
      this.#rebuildSessionTrackedIds(session);
      session.lastSyncedSeq = serverSeq;
      // Seed the current member snapshots into the same registration frame
      // (no echo suppression — the caller asked for current values).
      if (session.docSetMembers.size > 0) {
        const seedEngine = aclEngine ?? await this.openEngine(message.space);
        const memberUpserts = this.#readDocSetMemberDeltas(
          message.space,
          session,
          seedEngine,
          serverSeq,
          seedMembers(session, memberKeys),
          undefined,
        );
        appendMemberUpserts(sync, memberUpserts);
      }
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
      const scopeResolution = this.#actingReadScopeContext(
        message.space,
        session,
        message.actingContext,
      );
      if (scopeResolution.error) {
        return respondTypedError<WatchAddResult>(
          message.requestId,
          scopeResolution.error,
        );
      }
      const actingPrincipal =
        message.actingContext !== undefined && message.actingContext !== "space"
          ? scopeResolution.ok.principal
          : undefined;
      const actingSessionId = message.actingContext !== undefined &&
          Engine.parseSessionExecutionContextKey(message.actingContext) !==
            undefined
        ? scopeResolution.ok.sessionId
        : undefined;
      // C2.4: the full acting LANE identity must match — same principal is
      // not enough, or an add under a sibling session's grant would splice
      // into another lane's watch set (CA8's trap on the add path).
      if (
        actingPrincipal !== session.watchScopePrincipal ||
        actingSessionId !== session.watchScopeSessionId
      ) {
        return respondTypedError<WatchAddResult>(
          message.requestId,
          toError(
            "ProtocolError",
            "session.watch.add acting context must match the registered watch set",
          ),
        );
      }
      const gate = this.#docSetWatchGate(
        message.space,
        session,
        message.watches,
      );
      if (gate.error) {
        return respondTypedError<WatchAddResult>(
          message.requestId,
          gate.error,
        );
      }
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
      // FB24: resolve every new docs watch's member addresses BEFORE any
      // session mutation. Scope resolution can throw (user/session-scoped
      // address on a principal-less session), and a throw after the watch is
      // installed would strand a docs watch that delivers nothing while
      // rejecting the client's corrected retry as a same-id respec. Staging
      // first makes the failure leave no trace.
      const newDocsWatches = newWatches.filter(isDocSetWatchSpec);
      const stagedMembers = Server.#stageDocSetMembers(
        newDocsWatches,
        scopeResolution.ok,
      );
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
            scopeResolution.ok,
          );
          this.#recordFeedTraversal("session.watch.add", tracked.stats);
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
        this.#recordFeedTraversal("session.watch.add", extended.stats);
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
      // F3 doc-set membership (extend semantics): register only the NEW docs
      // watches' members (merging sources into any that already exist), seed
      // their current snapshots, and fold the member ids into the union
      // tracked set. Nothing shrinks on an add.
      const sync: SessionSync = {
        type: "sync",
        fromSeq,
        toSeq: serverSeq,
        upserts: upserts.toSorted((left, right) =>
          left.branch.localeCompare(right.branch) ||
          left.id.localeCompare(right.id)
        ),
        removes: [],
      };
      if (newDocsWatches.length > 0) {
        // Apply the pre-staged registration (FB24 phase 2 — cannot throw).
        const { memberKeys } = Server.#applyDocSetMembers(
          session,
          stagedMembers,
        );
        this.#updateDocSetMembersGauge();
        for (const member of session.docSetMembers.values()) {
          session.trackedIds.add(Server.#docSetMemberTrackedKey(member));
        }
        const memberUpserts = this.#readDocSetMemberDeltas(
          message.space,
          session,
          engine,
          serverSeq,
          seedMembers(session, memberKeys),
          undefined,
        );
        appendMemberUpserts(sync, memberUpserts);
      }
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
          sync,
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
    trigger?: GraphQueryTrigger,
  ): Promise<GraphQueryResult> {
    const startedAt = performance.now();
    const result = queryGraph(
      space,
      engine ?? await this.openEngine(space),
      query,
      reuse,
      scopeContext,
    );
    this.#recordFeedTraversal("graph.query", result.stats);
    // FA5/FB12 wave-vs-demand split: the aggregate bucket above stays
    // byte-identical for existing consumers; a trigger-carrying request is
    // ADDITIONALLY attributed to its sub-bucket. The wave bucket is the F5
    // protocol's F2-floor regression signal ("graph.query still at its F2
    // floor, not regressed by demand pulls").
    if (trigger !== undefined) {
      this.#recordFeedTraversal(`graph.query.${trigger}`, result.stats);
    }
    recordSlowQueryDuration("graph.query", space, startedAt, {
      roots: query.roots.length,
    });
    // The traversal stats are host-side observability; GraphQueryResult is a
    // wire shape and must stay exactly { serverSeq, entities }.
    return { serverSeq: result.serverSeq, entities: result.entities };
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
      this.#recordFeedTraversal("session.watch.set", result.stats);
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

  // --- F3 doc-set watch membership -------------------------------------

  /** Stable membership source id for a doc-set watch (FA8 refcount): a member
   * survives while ANY source still names it, so one watch's shrink cannot end
   * delivery another watch still holds. */
  static #docSetWatchSource(watchId: string): string {
    return `${DOC_SET_WATCH_SOURCE_PREFIX}${watchId}`;
  }

  /** Admission gate for the additive `docs` WatchSpec kind: a session that
   * never negotiated the subcapability may not register it (clean
   * ProtocolError, not a silent drop); a space the F5 rollout dial does not
   * admit may not register it either (FW5/FB9 — this rejection is the dial's
   * behavioral authority: the runner's reconcile catches the typed error,
   * keeps its schema-graph watches, and the space stays on graph behavior);
   * and an inbound address that already carries a resolved scope key is a
   * protocol error (FA2 — the wire carries declared scope only). */
  #docSetWatchGate(
    space: string,
    session: SessionState,
    watches: readonly WatchSpec[],
  ): { error?: V2Error; docsWatches: DocSetWatchSpec[] } {
    const docsWatches = watches.filter(
      (watch): watch is DocSetWatchSpec => watch.kind === "docs",
    );
    if (docsWatches.length === 0) return { docsWatches };
    if (!session.serverPrimaryExecutionDocSetWatchV1) {
      return {
        error: toError(
          "ProtocolError",
          "session did not negotiate serverPrimaryExecutionDocSetWatchV1; " +
            "the docs watch kind is unsupported",
        ),
        docsWatches,
      };
    }
    if (!serverPrimaryExecutionGraphRetirementAdmits(space)) {
      return {
        error: toError(
          "ProtocolError",
          "the serverPrimaryExecutionGraphRetirement dial does not admit " +
            `space ${space} to the doc-set watch surface; the docs watch ` +
            "kind is unsupported for this space",
        ),
        docsWatches,
      };
    }
    for (const watch of docsWatches) {
      for (const address of watch.docs) {
        if ((address as { scopeKey?: unknown }).scopeKey !== undefined) {
          return {
            error: toError(
              "ProtocolError",
              "doc-set watch addresses carry declared scope only; a " +
                "resolved scope key on the wire is a protocol error",
            ),
            docsWatches,
          };
        }
      }
    }
    return { docsWatches };
  }

  /** Doc-set members read under the watch set's registration context —
   * (watchScopePrincipal, watchScopeSessionId ?? base session id), falling
   * back to the session's own scope context — FA2's per-session point-read
   * context. Mirrors the full-re-evaluation scope exactly so a member's
   * registration-time resolved scope key equals its fan-out read scope key;
   * for a SESSION-lane watch set the lane's own session id (C2.4/CA8) is
   * what keeps that equality — the sponsor's would resolve a phantom
   * instance and silently drop the member's deltas. */
  #docSetReadContext(
    space: string,
    session: SessionState,
  ): { principal?: string; sessionId: string } {
    const base = this.#scopeContextForSession(space, session);
    return session.watchScopePrincipal !== undefined
      ? {
        principal: session.watchScopePrincipal,
        sessionId: session.watchScopeSessionId ?? base.sessionId,
      }
      : base;
  }

  /** FA2: resolve each declared member address to its RESOLVED scope key under
   * the registration scope context and fold it into `session.docSetMembers`
   * (refcounted by source). Returns the affected member keys so the caller can
   * seed their initial snapshots, plus the retained `source\0key` pairs the
   * replace-semantics sweep (FA8/FB6) re-justifies existing sources against.
   * A resolved scope key on an inbound address is a protocol error — the wire
   * carries declared scope only. */
  #registerDocSetMembers(
    session: SessionState,
    watches: readonly DocSetWatchSpec[],
    scopeContext: { principal?: string; sessionId?: string },
  ): { memberKeys: Set<string>; retainedPairs: Set<string> } {
    const staged = Server.#stageDocSetMembers(watches, scopeContext);
    return Server.#applyDocSetMembers(session, staged);
  }

  /** FB24 phase 1 — resolve WITHOUT mutating: every address of every docs
   * watch is validated and scope-resolved up front, so a ProtocolError (raw
   * scope key on the wire, scoped address on a principal-less session) is
   * thrown BEFORE any watch or member is installed. A failed request leaves
   * no trace and a corrected same-id retry is not vacuously filtered. */
  static #stageDocSetMembers(
    watches: readonly DocSetWatchSpec[],
    scopeContext: { principal?: string; sessionId?: string },
  ): StagedDocSetMember[] {
    const staged: StagedDocSetMember[] = [];
    for (const watch of watches) {
      const source = Server.#docSetWatchSource(watch.id);
      const branch = watch.branch ?? "";
      for (const address of watch.docs) {
        if ((address as { scopeKey?: unknown }).scopeKey !== undefined) {
          throw new Engine.ProtocolError(
            "doc-set watch addresses carry declared scope only; " +
              "resolved scope keys are resolved server-side",
          );
        }
        const scopeKey = Engine.resolveScopeKey(address.scope, {
          principal: scopeContext.principal,
          sessionId: scopeContext.sessionId,
        });
        const scope = declaredScope(address.scope);
        staged.push({
          source,
          branch,
          id: address.id,
          scope,
          scopeKey,
          key: docSetMemberKey(branch, address.id, scopeKey),
        });
      }
    }
    return staged;
  }

  /** FB24 phase 2 — apply a fully staged registration. Cannot throw, so the
   * callers may run it after `session.watches` is reassigned without risking
   * a half-installed watch. */
  static #applyDocSetMembers(
    session: SessionState,
    staged: readonly StagedDocSetMember[],
  ): { memberKeys: Set<string>; retainedPairs: Set<string> } {
    const memberKeys = new Set<string>();
    const retainedPairs = new Set<string>();
    for (const entry of staged) {
      const existing = session.docSetMembers.get(entry.key);
      if (existing === undefined) {
        session.docSetMembers.set(entry.key, {
          branch: entry.branch,
          id: entry.id,
          scope: entry.scope,
          scopeKey: entry.scopeKey,
          lastSentSeq: 0,
          sources: new Set([entry.source]),
        });
      } else {
        existing.sources.add(entry.source);
      }
      memberKeys.add(entry.key);
      retainedPairs.add(`${entry.source}\0${entry.key}`);
    }
    return { memberKeys, retainedPairs };
  }

  /** FA8/FB6 replace-semantics shrink: `session.watch.set` replaces the WHOLE
   * watch set, so every watch-sourced member contribution must be re-justified
   * against the new set — per (source, member) pair, not per watch id. A
   * surviving watch id that narrowed its docs list drops its source from the
   * members it no longer names; a watch id absent from the new set keeps
   * nothing. Members left with no source are evicted. Never emits a
   * SessionSync.remove — a document deletion stays a deleted-upsert;
   * membership shrink is silent server-side bookkeeping (the client keeps the
   * last value until F4's replica eviction). */
  #reconcileDocSetWatchSources(
    session: SessionState,
    retainedPairs: ReadonlySet<string>,
  ): void {
    for (const [key, member] of session.docSetMembers) {
      for (const source of [...member.sources]) {
        if (!source.startsWith(DOC_SET_WATCH_SOURCE_PREFIX)) continue;
        if (!retainedPairs.has(`${source}\0${key}`)) {
          member.sources.delete(source);
        }
      }
      if (member.sources.size === 0) {
        session.docSetMembers.delete(key);
        // An evicted member owes nothing — drop any staged retry (FB15).
        session.docSetMemberRetryKeys.delete(key);
      }
    }
  }

  /** FB23: recompute the FA8 member-set-size gauge (feedStats
   * .docSetMembersTracked — exported verbatim via /api/health/stats). Called
   * at every membership mutation (registration, replace-shrink) and on waves
   * that point-read a doc-set surface, so the exported value tracks live
   * membership instead of staying a dead 0. */
  #updateDocSetMembersGauge(): void {
    this.feedStats.docSetMembersTracked = this.#sessions.totalDocSetMembers();
  }

  /** The tracked-id key (declared-scope dirty key) for a member — the union
   * surface with graph tracking (FA14). */
  static #docSetMemberTrackedKey(member: DocSetMember): string {
    return toDirtyKey(member.id, member.scope);
  }

  /** FA14: `trackedIds := doc-set members ∪ graph-tracked ids`. Rebuilds the
   * union whenever the graph surface is rebuilt wholesale (registration and
   * full re-evaluation both replace `entities`). */
  #rebuildSessionTrackedIds(session: SessionState): void {
    session.trackedIds = trackedIdsFromEntries(session.entities.values());
    for (const member of session.docSetMembers.values()) {
      session.trackedIds.add(Server.#docSetMemberTrackedKey(member));
    }
  }

  /** FA1/FA6/FA14/FA15: point-read the given members at one snapshot bound and
   * emit exact deltas. Each member is read under the per-session point-read
   * context, matched by resolved scope key (declared fallback for older
   * engines), diffed against its own `lastSentSeq` (never a reseed), and
   * echo-suppressed per revision (a session never receives its own committed
   * write back). `lastSentSeq` advances even when the delta is suppressed. */
  #readDocSetMemberDeltas(
    space: string,
    session: SessionState,
    engine: Engine.Engine,
    toSeq: number,
    members: Iterable<DocSetMember>,
    dirtyOrigins: ReadonlyMap<string, DirtyOrigin> | undefined,
  ): SessionCacheEntry[] {
    const memberList = [...members];
    // A stale lease binding makes the read context unresolvable. Fail open
    // (playbook item 12): skip member deltas this wave rather than aborting
    // the whole session sync the way graph refresh never would. The wave
    // still advances the watermark past the skipped deltas (FA1), so every
    // skipped member is RE-STAGED dirty for the next wave (FB15) — without
    // this, a steady connected session would never see the delta again
    // (#dirtyDocSetMembers only matches the wave that dirtied it).
    let readContext: { principal?: string; sessionId: string };
    try {
      readContext = this.#docSetReadContext(space, session);
    } catch {
      for (const member of memberList) {
        session.docSetMemberRetryKeys.add(
          docSetMemberKey(member.branch, member.id, member.scopeKey),
        );
      }
      return [];
    }
    const upserts: SessionCacheEntry[] = [];
    for (const member of memberList) {
      // The read context resolved: whatever this member owed is being read
      // now, so any staged stale-binding retry is settled by this wave.
      session.docSetMemberRetryKeys.delete(
        docSetMemberKey(member.branch, member.id, member.scopeKey),
      );
      const state = Engine.readState(engine, {
        id: member.id,
        scope: member.scope,
        branch: member.branch,
        // One snapshot bound for the whole wave (FA1): a coalesced accepted
        // wave reads every member as of the same toSeq.
        seq: toSeq,
        principal: readContext.principal,
        sessionId: readContext.sessionId,
      });
      // Never-written (or not-yet-created) members surface no delta — the
      // address stays a first-class member (FA14: no existence requirement),
      // so a later create-after-link commit re-dirties and delivers it.
      if (state === null) continue;
      // FA6: the read must resolve the member's own instance. Declared-scope
      // fallback only when the engine omits a resolved key (never here).
      if (
        state.scopeKey !== undefined && state.scopeKey !== member.scopeKey
      ) {
        continue;
      }
      // Per-member diff (FA15): already-delivered seqs never re-emit, so a
      // resumed catch-up is incremental, not a reseed.
      if (state.seq <= member.lastSentSeq) continue;
      const entry = toCacheEntry({
        branch: state.branch,
        id: state.id,
        ...(state.scope !== "space" ? { scope: state.scope } : {}),
        scopeKey: state.scopeKey,
        seq: state.seq,
        document: state.document,
      });
      // FA14 echo suppression, per revision: if this exact seq is the session's
      // own committed write, advance the cursor but do not ship it back.
      const origin = dirtyOrigins?.get(
        toDirtyKey(member.id, member.scope),
      );
      const isEcho = origin !== undefined &&
        origin.sessionId === session.id &&
        origin.seq === state.seq;
      member.lastSentSeq = state.seq;
      if (isEcho) continue;
      upserts.push(entry);
    }
    if (upserts.length > 0) {
      // F1 attribution: member deltas are point reads with zero traversal.
      this.#recordFeedTraversal("session.docset.read", {
        managerReads: upserts.length,
        coveredSelectorSkips: 0,
        schemaTraversals: 0,
        pointerTraversals: 0,
        arrayTraversals: 0,
        objectTraversals: 0,
        dagTraversals: 0,
        getDocAtPathCalls: 0,
        schemaMemoHits: 0,
      });
      this.feedStats.docSetMemberDeliveries += upserts.length;
    }
    return upserts;
  }

  /** Members whose declared-scope dirty key intersects this wave's dirty set —
   * the fan-out match (FA1: matched by branch/id/resolved scope key via the
   * point read that follows) — unioned with members owing a stale-binding
   * retry (FB15: their delta was skipped under an already-advanced watermark,
   * so the next wave must re-read them regardless of its own dirty set).
   *
   * F6: within a touched session, a member is matched only when the dirty
   * key's delivery cohort names the member's own resolved scope key (or is
   * broadcast). Two members of one session sharing a declared address but
   * keyed to different instances — a lane member beside a sponsor member —
   * therefore point-read independently, each on its own instance's waves.
   * Retry-key matches stay cohort-independent (the debt is this session's). */
  #dirtyDocSetMembers(
    session: SessionState,
    dirtyIds: ReadonlySet<string>,
    dirtyScopeKeys: DirtyScopeKeys | undefined,
  ): DocSetMember[] {
    const matched: DocSetMember[] = [];
    for (const [key, member] of session.docSetMembers) {
      if (session.docSetMemberRetryKeys.has(key)) {
        matched.push(member);
        continue;
      }
      const tracked = Server.#docSetMemberTrackedKey(member);
      if (!dirtyIds.has(tracked)) continue;
      const cohort = dirtyScopeKeys?.get(tracked);
      if (
        cohort === undefined ||
        cohort.has(BROADCAST_SCOPE_KEY) ||
        cohort.has(member.scopeKey)
      ) {
        matched.push(member);
      }
    }
    return matched;
  }

  /**
   * F6 delivery-cohort derivation at the dirty-routing layer: reduce a wave's
   * dirty set to the subset this session can possibly be interested in.
   *
   * A key stays visible when any producing revision's cohort is broadcast
   * (`space`, or an unattributed producer — the fail-open), or when any of
   * the session's interest surfaces owns an instance the cohort names:
   *
   *  - MEMBER surface: `member.scopeKey` — the instance identity resolved at
   *    registration under the session's scope context or the C1.4b-validated
   *    acting lane. This is what keeps a lane-held docs watch lane-correct
   *    (FB25): the cohort of a lane member derives from the LANE's acting
   *    context, never the sponsor session's principal.
   *  - GRAPH surface: a graph that tracks the doc key re-reads it under the
   *    graph's own read context (`TrackedGraphState.manager`), so the
   *    session's instance key is `resolveScopeKey(scope, manager context)`.
   *    An unresolvable context cannot PROVE disinterest and fails open to
   *    broadcast — a filter miss costs work, never delivery.
   *
   * Scoped-only cohorts exist only for user/session declared keys (a
   * space-declared revision always resolves to the broadcast key), so the
   * common all-space wave takes the identity fast path.
   */
  #cohortVisibleDirtyIds(
    space: string,
    session: SessionState,
    dirtyIds: ReadonlySet<string>,
    dirtyScopeKeys: DirtyScopeKeys | undefined,
  ): ReadonlySet<string> {
    if (dirtyScopeKeys === undefined || dirtyScopeKeys.size === 0) {
      return dirtyIds;
    }
    let scopedOnly: Map<string, ReadonlySet<string>> | undefined;
    for (const dirtyId of dirtyIds) {
      const cohort = dirtyScopeKeys.get(dirtyId);
      if (cohort === undefined || cohort.has(BROADCAST_SCOPE_KEY)) continue;
      (scopedOnly ??= new Map()).set(dirtyId, cohort);
    }
    if (scopedOnly === undefined) {
      return dirtyIds;
    }
    const excluded = new Set(scopedOnly.keys());
    if (session.docSetMembers.size > 0) {
      for (const member of session.docSetMembers.values()) {
        if (excluded.size === 0) break;
        const tracked = Server.#docSetMemberTrackedKey(member);
        if (!excluded.has(tracked)) continue;
        if (scopedOnly.get(tracked)?.has(member.scopeKey)) {
          excluded.delete(tracked);
        }
      }
    }
    if (excluded.size > 0 && session.graphs.size > 0) {
      for (const dirtyId of [...excluded]) {
        const cohort = scopedOnly.get(dirtyId);
        if (cohort === undefined) continue;
        let scope: CellScope;
        let id: string;
        try {
          ({ id, scope } = fromDirtyKey(dirtyId));
        } catch {
          // A malformed dirty key cannot prove anything — fail open.
          excluded.delete(dirtyId);
          continue;
        }
        const docKey = toDocKey(space, id, scope);
        for (const graph of session.graphs.values()) {
          const selectors = graph.tracker.get(docKey);
          if (selectors === undefined || selectors.size === 0) continue;
          let instanceScopeKey: string | undefined;
          try {
            instanceScopeKey = Engine.resolveScopeKey(scope, {
              principal: graph.manager.principal,
              sessionId: graph.manager.sessionId,
            });
          } catch {
            // Unresolvable read context: fail open to broadcast.
          }
          if (
            instanceScopeKey === undefined || cohort.has(instanceScopeKey)
          ) {
            excluded.delete(dirtyId);
            break;
          }
        }
      }
    }
    if (excluded.size === 0) {
      return dirtyIds;
    }
    const visible = new Set<string>();
    for (const dirtyId of dirtyIds) {
      if (!excluded.has(dirtyId)) visible.add(dirtyId);
    }
    return visible;
  }

  syncSessionForConnection(
    space: string,
    sessionId: string,
    dirtyIds?: ReadonlySet<string>,
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
    options?: {
      adoptionObservations?: boolean;
      /** F6: this wave's per-key delivery cohorts (see DirtyScopeKeys).
       * Absent = the pre-F6 broadcast wave shape (fail-open). */
      dirtyScopeKeys?: DirtyScopeKeys;
    },
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
            // F6 cohort filter, applied at the dirty-routing layer BEFORE
            // any work is attributed to this session: a dirty key whose
            // every producing revision was scoped to instances this session
            // does not hold (member surface AND graph surface both checked)
            // is invisible to this session for the whole wave — the touched
            // test, the graph refresh, and the member fan-out all see the
            // filtered set. A session left with no visible intersection is
            // NOT touched: no engine open, no traversal, no point read.
            const visibleDirtyIds = this.#cohortVisibleDirtyIds(
              space,
              session,
              dirtyIds,
              options?.dirtyScopeKeys,
            );
            let touched = false;
            for (const dirtyId of visibleDirtyIds) {
              if (session.trackedIds.has(dirtyId)) {
                touched = true;
                break;
              }
            }
            // FB15: a member skipped on a stale binding re-touches the
            // session on the next wave even when that wave's own dirty set
            // misses it — the skipped delta's watermark already advanced.
            // Deliberately cohort-independent: a staged retry is this
            // session's own debt.
            if (!touched && session.docSetMemberRetryKeys.size > 0) {
              touched = true;
            }
            span.setAttribute("ct.touched", touched);
            if (!touched) {
              // F6 observability: this session would have been touched (and
              // empty-delivered) by the pre-F6 broadcast — count the
              // suppression so the filter's silence is visible in stats.
              if (visibleDirtyIds !== dirtyIds) {
                for (const dirtyId of dirtyIds) {
                  if (session.trackedIds.has(dirtyId)) {
                    this.feedStats.refreshCohortSuppressedSessions += 1;
                    break;
                  }
                }
              }
              return await emptyCatchUp();
            }
            this.feedStats.refreshSessionsTouched += 1;

            // F5 (FA3/FA13, FW5): classify the touched session's watch
            // surface PER WATCH. The dial's behavioral authority lives at
            // doc-set ADMISSION (`#docSetWatchGate` — a withheld space's
            // demotion is rejected and its clients keep graph watches), so a
            // session with admitted members here is the rolled-out
            // population; the dial is deliberately NOT re-consulted, so
            // shrinking it never hides a live surface from these gauges
            // (FB9). The zero-traversal property of a fully-doc-set surface
            // is STRUCTURAL — the docs kind never enters graph grouping (F3)
            // and the demoted client dropped its graph watches (F4b) — so
            // the loop below simply has nothing to traverse; members are
            // point-read below, folded into the one emission this session
            // makes per wave (FA1). A surface that still holds graph watches
            // FAILS OPEN to graph behavior — traversal MUST run for them (a
            // skip would be a delivery gap) — and is counted per watch as a
            // regression, never silently dropped. The catch-up emitter
            // (finishCatchUp / emptyCatchUp) is untouched, so a conflicted
            // commit still receives its caughtUpLocalSeq release across the
            // retirement (FA7).
            const docSetEligible =
              session.serverPrimaryExecutionDocSetWatchV1 &&
              session.docSetMembers.size > 0;
            // Branch → residual graph-watch count: the traversal loop is
            // branch-grouped, so attributing "which watches did this refresh
            // serve" needs the per-branch watch multiplicity (FB28 — two
            // watches sharing a branch group are two residual watches).
            const residualWatchesByBranch = new Map<string, number>();
            let residualGraphWatches = 0;
            if (docSetEligible) {
              for (const watch of session.watches) {
                if (!isGraphWatchSpec(watch)) continue;
                residualGraphWatches += 1;
                const branch = watch.query.branch ?? "";
                residualWatchesByBranch.set(
                  branch,
                  (residualWatchesByBranch.get(branch) ?? 0) + 1,
                );
              }
              this.feedStats.refreshRetirementEligibleSessions += 1;
              this.feedStats.refreshResidualGraphWatches +=
                residualGraphWatches;
              if (residualGraphWatches === 0) {
                this.feedStats.refreshFullyDocSetSessions += 1;
              }
            }

            const engine = await this.openEngine(space);
            const fromSeq = session.lastSyncedSeq;
            const updates = new Map<string, SessionCacheEntry>();

            for (const [branch, graph] of session.graphs) {
              const refreshed = tracer.startActiveSpan(
                "memory.watch.refresh",
                (watchSpan) => {
                  watchSpan.setAttribute("space.did", space);
                  try {
                    return refreshTrackedGraph(
                      space,
                      engine,
                      graph,
                      // F6: the graph re-traverses only the cohort-visible
                      // subset — an out-of-cohort scoped revision cannot
                      // change any value this graph's read context resolves.
                      visibleDirtyIds,
                    );
                  } finally {
                    watchSpan.end();
                  }
                },
              );
              if (refreshed === null) {
                continue;
              }
              this.feedStats.refreshGraphsRefreshed += 1;
              this.#recordFeedTraversal(
                "session.watch.refresh",
                refreshed.stats,
              );
              if (docSetEligible) {
                // FB28: traversal actually happened for this branch group —
                // count the residual watches it serves, and attribute the
                // DAG work to the space for the FB11 mixed-mode budget.
                this.feedStats.refreshResidualGraphWatchesTraversed +=
                  residualWatchesByBranch.get(branch) ?? 0;
                const bySpace =
                  this.feedStats.refreshResidualDagTraversalsBySpace;
                bySpace[space] = (bySpace[space] ?? 0) +
                  refreshed.stats.dagTraversals;
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

            // FA1 same-wave surface: doc-set members dirtied this wave are
            // point-read INSIDE this refresh — one emission point per session
            // per wave, membership fan-out replacing refreshTrackedGraph for
            // doc-set surfaces. Matched by the member's declared-scope dirty
            // key here; the point read that follows resolves the instance.
            const dirtyMembers = session.docSetMembers.size > 0
              ? this.#dirtyDocSetMembers(
                session,
                visibleDirtyIds,
                options?.dirtyScopeKeys,
              )
              : [];
            if (updates.size === 0 && dirtyMembers.length === 0) {
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
            // Fold the doc-set member deltas into the SAME upsert batch and the
            // SAME toSeq (FA1). Point reads carry their own echo suppression.
            if (dirtyMembers.length > 0) {
              const memberUpserts = this.#readDocSetMemberDeltas(
                space,
                session,
                engine,
                toSeq,
                dirtyMembers,
                dirtyOrigins,
              );
              for (const entry of memberUpserts) upserts.push(entry);
              // FB23: this wave touched a doc-set surface — refresh the FA8
              // membership gauge against live demand.
              this.#updateDocSetMembersGauge();
            }
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
            this.feedStats.refreshUpsertsPushed += upserts.length;
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

          const refreshScope = this.#scopeContextForSession(space, session);
          const { serverSeq, graphs, entities } = await this.evaluateWatchSet(
            space,
            session.watches,
            undefined,
            // C1.4b: a watch set registered under an acting context keeps
            // resolving under it on full re-evaluation (never silently
            // flipping to the sponsor's instances) — including the LANE's
            // session id for a session-lane set (C2.4/CA8); C1.5b owns
            // per-lane watch lifecycle on lane drains.
            session.watchScopePrincipal !== undefined
              ? {
                principal: session.watchScopePrincipal,
                sessionId: session.watchScopeSessionId ??
                  refreshScope.sessionId,
              }
              : refreshScope,
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
          // FA15: a full re-evaluation (resume catch-up) re-reads doc-set
          // members INCREMENTALLY against their own lastSentSeq — never a
          // reseed — and unions the member ids back into the wiped tracked set
          // (FA14). dirtyOrigins is absent on resume, so the delivery is the
          // client's current-value catch-up.
          if (session.docSetMembers.size > 0) {
            for (const member of session.docSetMembers.values()) {
              session.trackedIds.add(Server.#docSetMemberTrackedKey(member));
            }
            const engine = await this.openEngine(space);
            const memberUpserts = this.#readDocSetMemberDeltas(
              space,
              session,
              engine,
              serverSeq,
              session.docSetMembers.values(),
              dirtyOrigins,
            );
            appendMemberUpserts(sync, memberUpserts);
          }
          // FW1 (FB1): a resume re-evaluation whose graph closure shrank away
          // from a doc that membership still holds must not remove it.
          suppressDocSetMemberRemoves(sync, session.docSetMembers);
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
      const scopeContext = this.#scopeContextForSession(space, session);
      const page = Engine.listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: sync.fromSeq,
        throughCommitSeq: sync.toSeq,
        applicableExecutionContextKeys: this
          .#schedulerApplicableContextKeysForSession(
            space,
            session,
            scopeContext,
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
    scopeKeys?: ReadonlyMap<string, string>,
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
      let cohorts = this.#dirtyScopeKeysBySpace.get(space);
      if (cohorts === undefined) {
        cohorts = new Map();
        this.#dirtyScopeKeysBySpace.set(space, cohorts);
      }
      for (const id of dirtyIds) {
        ids.add(id);
        if (origin === undefined) {
          origins?.delete(id);
        } else {
          origins?.set(id, origin);
        }
        // F6 cohort accumulation, union semantics: a producer that knows the
        // revision's resolved scope key contributes it; one that does not
        // contributes the broadcast cohort. Coalesced waves therefore only
        // ever WIDEN a key's cohort — an unattributed mark can never be
        // narrowed away by a later scoped mark for the same key.
        let cohort = cohorts.get(id);
        if (cohort === undefined) {
          cohort = new Set();
          cohorts.set(id, cohort);
        }
        cohort.add(scopeKeys?.get(id) ?? BROADCAST_SCOPE_KEY);
      }
      if (origins?.size === 0) {
        this.#dirtyOriginsBySpace.delete(space);
      }
    }
    this.#dirtySpaces.add(space);
    this.scheduleRefresh();
  }

  /** F6 note: conflict staging deliberately carries NO cohort metadata — a
   * rejected commit produced no revisions, so there is no resolved scope key
   * to derive from (a claimed lane commit's acting context is not recoverable
   * post-reject), and the staged keys' one job is the conflicted session's
   * catch-up/caughtUpLocalSeq release (FA7). Broadcast is the cohort-superset
   * fail-open: it can cost other sessions one empty wave, never a delivery
   * gap or a lost release. */
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
      this.#dirtyScopeKeysBySpace.clear();
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
        const dirtyScopeKeys = this.#dirtyScopeKeysBySpace.get(space);
        if (dirtyScopeKeys !== undefined) {
          this.#dirtyScopeKeysBySpace.delete(space);
        }
        // One refresh wave: this space's coalesced dirty set fans out to
        // every connection below.
        this.feedStats.refreshWaves += 1;
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
                await connection.refreshDirty(
                  space,
                  dirtyIds,
                  dirtyOrigins,
                  dirtyScopeKeys,
                );
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
    scopeContext: Engine.SchedulerScopeContext | undefined,
  ): Promise<void> {
    if (session?.principal === undefined || scopeContext === undefined) {
      return;
    }
    const mirrorSpaces = this.schedulerObservationReadSpaces(observation);
    for (const space of previousReadSpaces) {
      mirrorSpaces.add(space);
    }
    mirrorSpaces.delete(ownerSpace);
    if (mirrorSpaces.size === 0) {
      return;
    }

    // C3.1b (2026-07-18): mirrors are cross-space PROTOCOL traffic — a
    // `foreign-observation.mirror` per read space through the host
    // router; the read space's inbound handler performs the engine
    // upsert the pre-C3.1b code did right here. Never write into the
    // peer engine from this send path (the C3A1 in-process accident).
    this.registerCrossSpaceHostedSpace(ownerSpace);
    // C3.3b (2026-07-18, C3A5): the observation's ACTING identity, derived
    // from its effective execution context key — the same resolution the
    // home accept transaction stamped the row under (the engine's acting-
    // lane admission in `applyCommit`):
    //   - session-rank key → the key's own {principal, sessionId} (a
    //     session lane acts as the GRANT's session — CA8 — and the
    //     crossing context floor parks client and unserved-executor rows
    //     at session rank);
    //   - user-rank key    → the lane principal, scope-anchored at the
    //     committing session (a user lane has no session of its own);
    //   - "space"          → the writing session's principal: the client
    //     for client commits, the lease SPONSOR for executor commits
    //     (`bindExecutionSession` pins session.principal === onBehalfOf).
    // For client observations every arm collapses to the session's own
    // scope context (the effective key was resolved FROM it), so client
    // mirror messages are byte-identical to the pre-C3.3b shape. Both
    // inputs were captured before the accepted commit — never re-derive
    // acting identity after an await: disconnect tears down the executor
    // binding, but cannot change the already-accepted acting scope.
    const laneSessionIdentity = Engine.parseSessionExecutionContextKey(
      originExecutionContextKey,
    );
    const actingScopeContext = laneSessionIdentity ?? {
      principal: Engine.principalOfUserContextKey(originExecutionContextKey) ??
        scopeContext.principal,
      sessionId: scopeContext.sessionId,
    };
    let sent = false;
    for (const space of mirrorSpaces) {
      // In-process stand-in for the peer host's own store-backed hosting
      // registration (C3.10a replaces this with real space→host routing):
      // a store-materialized space re-registers lazily (e.g. after a
      // restart, before its first serve); a never-hosted name stays
      // unregistered and nothing sends — same outcome as the pre-C3.3b
      // router drop, and the ACL consult below must never open an engine
      // for an unhosted name (the C3A1 shadow-engine refusal).
      if (!(await this.ensureCrossSpaceHosting(space))) {
        continue;
      }
      // SEND gate (C3.3b, replacing C3.1b's open-session predicate): the
      // mirror is authorized iff the ACTING principal holds READ on the
      // read space, at send time, against that space's current ACL state.
      // Retractions (previously-read spaces) bypass it deliberately, as
      // before: a retraction REMOVES read rows from B via the narrowed
      // payload, and withholding it would strand stale reader metadata in
      // a space the action no longer reads.
      //
      // C3.10a composition (2026-07-18): the consult is inherently
      // send-host-LOCAL — it opens the read space's engine, which for a
      // space the routing table assigns to a PEER host must never happen
      // (the openEngine routing gate refuses; a peer-routed space is
      // never locally materialized). In-process, send host == read host,
      // so the local consult IS the read host's check; over a link the
      // read space's ACL lives on the peer, so the mirror forwards and
      // the read-HOST-side capability check is the C3.10b transport-
      // parity slot (the same host-boundary shape as C3.4's point read,
      // where the ACL check runs on the read space's host).
      const peerRouted = this.#crossSpaceRouter.transport.routing
        ?.peerHostFor(space) !== undefined;
      if (
        !peerRouted &&
        !previousReadSpaces.has(space) &&
        !this.canMirrorSchedulerObservationToSpace(
          await this.openEngine(space),
          space,
          actingScopeContext.principal,
        )
      ) {
        this.executionStats.crossSpaceMirrorsWithheld += 1;
        continue;
      }
      this.#crossSpaceRouter.link(ownerSpace, space).send({
        type: "foreign-observation.mirror",
        branch: commit.branch,
        observedAtSeq: commit.seq,
        // The ACTING scope context the home accept resolved the row under
        // (see the derivation above). The apply side validates the origin
        // key against exactly this context
        // (`schedulerContextScopeForCanonicalKey`), so a sponsor-scoped
        // context under a scoped-lane key would be rejected there — the
        // pre-C3.3b session-derived context was wrong for every scoped-
        // lane executor row, which simply never got this far under the
        // old gate.
        scopeContext: {
          principal: actingScopeContext.principal,
          sessionId: actingScopeContext.sessionId,
        },
        writerSessionId: Engine.resolveCommitSessionKey(
          session.id,
          session.principal,
        ),
        originExecutionContextKey,
        // The wire rule pins observation.ownerSpace to the envelope's
        // fromSpace; stamp it here exactly as the engine upsert would
        // have (the stored payload is byte-identical either way).
        observation: {
          ...observation,
          ownerSpace,
        } as unknown as Record<string, unknown>,
      });
      sent = true;
    }
    if (sent) {
      // Same-host application barrier: today's contract is that this
      // method resolves only after the mirror rows are durably applied
      // (transact awaits it before responding). Cross-host, C3.10b owns
      // the equivalent ack/barrier semantics.
      await this.settleCrossSpaceDeliveries();
    }
  }

  private runPostCommitSchedulerSideEffects(
    ownerSpace: string,
    commit: Engine.AppliedCommit,
    observations: readonly CommitSchedulerObservation[],
    previousReadSpaces: ReadonlyMap<number, ReadonlySet<string>>,
    session: SessionState | undefined,
    scopeContext: Engine.SchedulerScopeContext | undefined,
  ): Promise<void> {
    const run = () =>
      this.applyPostCommitSchedulerSideEffects(
        ownerSpace,
        commit,
        observations,
        previousReadSpaces,
        session,
        scopeContext,
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
    scopeContext: Engine.SchedulerScopeContext | undefined,
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
          scopeContext,
        );
      }
      // C3.3a: an observation that reads (or stopped reading) a foreign
      // space changes the home read-index the subscription derivation
      // consults — re-derive. The rows themselves landed synchronously in
      // applyCommit; this only needs to run after the fact.
      if (
        observations.some(({ localSeq, observation }) => {
          const readSpaces = this.schedulerObservationReadSpaces(observation);
          readSpaces.delete(ownerSpace);
          return readSpaces.size > 0 ||
            (previousReadSpaces.get(localSeq)?.size ?? 0) > 0;
        })
      ) {
        this.scheduleForeignReaderSubscriptionReconcile(
          ownerSpace,
          commit.branch,
        );
      }
    } catch (error) {
      console.warn(
        "Post-commit scheduler state update failed after semantic commit:",
        error,
      );
    }
  }

  #acceptedSchedulerObservations(
    observations: readonly CommitSchedulerObservation[],
    commit: Engine.AppliedCommit,
  ): CommitSchedulerObservation[] {
    const results = new Map(
      (commit.schedulerObservationResults ?? []).map((result) => [
        result.localSeq,
        result,
      ]),
    );
    return observations.map(({ localSeq, observation }) => {
      const result = results.get(localSeq);
      const {
        inputBasisSeq: _assertedBasis,
        executionClaimAssertion: _assertedClaim,
        executionUnservedAttempt: _unservedAttempt,
        executionProvenance: _assertedProvenance,
        foreignReadStamps: _assertedForeignReadStamps,
        ...requestedObservation
      } = observation;
      return {
        localSeq,
        observation: {
          ...requestedObservation,
          ...(result?.status === "kept" &&
              result.inputBasisSeq !== undefined
            ? { inputBasisSeq: result.inputBasisSeq }
            : {}),
          ...(result?.executionProvenance !== undefined
            ? { executionProvenance: result.executionProvenance }
            : {}),
        },
      };
    });
  }

  #publishAcceptedActionAttempts(commit: Engine.AppliedCommit): void {
    this.executionStats.acceptedActionAttempts +=
      commit.actionAttempts?.length ?? 0;
    for (const attempt of commit.actionAttempts ?? []) {
      // C3.5 (C3A14: this literal is a settlement CARRIER): the vector
      // projects from provenance as {space, seq} — the epoch stamps stay
      // host-side on provenance for C3.8's apply fence; settlements are
      // client-visible. NOTE (C3A19, ruling owned by C3.11): a vector
      // settlement exposes foreign space id + seq progression to every
      // session the home delivery predicate matches — declared-and-counted
      // vs delivery-time stripping is recorded there, not decided here.
      const inputBasis = attempt.provenance.inputBasis === undefined
        ? undefined
        : attempt.provenance.inputBasis.map((
          component,
        ): InputBasisComponent => ({
          space: component.space,
          seq: component.seq,
        }));
      const settlement: ActionSettlement = attempt.outcome === "committed"
        ? {
          branch: attempt.claim.branch,
          claim: attempt.claim,
          inputBasisSeq: attempt.provenance.inputBasisSeq,
          ...(inputBasis !== undefined ? { inputBasis } : {}),
          outcome: "committed",
          acceptedCommitSeq: attempt.acceptedCommitSeq,
        }
        : {
          branch: attempt.claim.branch,
          claim: attempt.claim,
          inputBasisSeq: attempt.provenance.inputBasisSeq,
          ...(inputBasis !== undefined ? { inputBasis } : {}),
          outcome: attempt.outcome,
          ...(attempt.outcome === "unserved"
            ? { diagnosticCode: attempt.diagnosticCode }
            : {}),
        };
      // The attempt was accepted synchronously under this exact live claim.
      // A false return now means expiry/revocation won during async post-commit
      // side effects; never resurrect that stale authority.
      if (this.publishActionSettlement(settlement)) {
        this.#recordExecutionInvalidationSettlement(attempt);
      }
    }
  }

  /**
   * SEND gate for observation mirrors, at the send-decision site (C3.3b,
   * 2026-07-18 — the C3A5 amended rule, replacing C3.1b's open-session
   * predicate). A mirror into read space B is authorized iff the
   * observation's ACTING principal — derived per observation class at the
   * call site: the session principal for client observations, the lane's
   * acting principal for claimed/executor observations (lease sponsor for
   * the space lane; lane principal for user/session lanes) — holds READ
   * on B under the SAME `#capabilityFor` resolution the enforcement path
   * uses (`#authorizeMessageWithEngine` — never a second capability
   * definition; C3.4's point read runs the identical resolution on the
   * read host), evaluated at SEND time against B's current ACL state.
   *
   * The old predicate keyed on an open session of the WRITING session's
   * principal on B: connection-liveness-blind in exactly the wrong
   * direction — never true for a headless sponsor (the cold-start wake
   * hole: a server-first action's discovery row could not mirror, so it
   * never woke on foreign commits) and the wrong principal entirely for
   * scoped lanes. Executor- and sponsor-authored observations now mirror
   * under exactly the acting-principal READ rule; admitting them WITHOUT
   * the B-side ACL check would have been a write bypass into B (any
   * principal planting reader rows into any space — the C3A5 hole this
   * predicate closes). Dial semantics ride the shared authorize path
   * unchanged: acl "off" admits everything, "observe" warns-and-admits
   * capability shortfalls (an invalid ACL still fails closed), "enforce"
   * withholds. Denial is a SILENT drop of the mirror only — the home
   * observation is untouched — counted in
   * `executionStats.crossSpaceMirrorsWithheld`.
   *
   * NO epoch stamp rides the mirror message, deliberately (the C3.3b plan
   * row lists "C3.2 (epoch stamp on the row)" as its dep): a mirror is
   * advisory reader metadata, and its consumers re-validate authority at
   * their own time — a foreign point read is stamped (seq, epoch) on the
   * read host at C3.4, and the home apply revalidates every bound epoch
   * by equality at C3.8's fence. A stamp captured here would assert
   * send-time authority for a row consulted arbitrarily later, inviting
   * exactly the stale-authority reliance mirrored rows must not carry.
   * C3.2 is this gate's dependency as capability-resolution CURRENCY
   * instead: the ACL apply bumps epochs and invalidates the
   * `#aclCapabilities` cache in the same transaction, so the send-time
   * `#capabilityFor` read here is never stale.
   *
   * Executor-authored rows (the C3.3b row's writer key + cleanup
   * lifecycle): the mirror's `writerSessionId` stays the committing
   * session's canonical commit key (`resolveCommitSessionKey(session.id,
   * session.principal)` — for an executor commit that is the sponsor-
   * bound executor session), byte-identical to the home engine's own
   * `writer_session_id` for the row. Cleanup is the same upsert-only
   * lifecycle as client rows: a narrowed re-observation retracts B-side
   * read rows through the ungated `previousReadSpaces` send. Post-
   * REVOCATION cleanup is deliberately NOT here (C3.7 / C3A6, dated
   * 2026-07-18): an epoch/floor bump that revokes the last authorized
   * reader must also unsubscribe the affected demand pairs and tombstone
   * already-mirrored rows in B — or record the counted host-trust-
   * metadata ruling. This gate governs NEW sends only; rows already in B
   * outlive a later revocation until C3.7 lands.
   */
  private canMirrorSchedulerObservationToSpace(
    readEngine: Engine.Engine,
    readSpace: string,
    actingPrincipal: string,
  ): boolean {
    return this.#authorizeMessageWithEngine(
      readEngine,
      readSpace,
      actingPrincipal,
      "READ",
    ) === null;
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
    if (readersByOwner.size === 0) {
      return;
    }

    // C3.1b (2026-07-18): durable dirt is cross-space PROTOCOL traffic —
    // one `foreign-dirty-mark` per foreign owner space through the host
    // router (the C3A1 option-(b) carriage; see cross-space.ts for the
    // ruling); the home space's inbound handler performs the
    // `markSchedulerActionsDirectDirty` the pre-C3.1b code did right
    // here. The read host's own `scheduler_action_state` rows for these
    // readers (owner_space-keyed, written synchronously inside
    // applyCommit) remain the durable pull source for C3.10b's reconnect
    // resync — this push is the live carriage, not the ledger.
    this.registerCrossSpaceHostedSpace(writeSpace);
    for (const [ownerSpace, readers] of readersByOwner) {
      // In-process stand-in for the peer host's own store-backed hosting
      // registration (see mirrorSchedulerObservation): a parked home
      // space that only exists in the store re-registers lazily so its
      // accumulated dirt keeps landing; a never-hosted name drops at the
      // router with zero side effects.
      await this.ensureCrossSpaceHosting(ownerSpace);
      this.#crossSpaceRouter.link(writeSpace, ownerSpace).send({
        type: "foreign-dirty-mark",
        branch: commit.branch,
        dirtySeq: commit.seq,
        readers: readers.map((reader) => ({
          branch: reader.branch,
          pieceId: reader.pieceId,
          processGeneration: reader.processGeneration,
          actionId: reader.actionId,
          executionContextKey: reader.executionContextKey,
        })),
      });
    }
    // Same-host application barrier (see mirrorSchedulerObservation).
    await this.settleCrossSpaceDeliveries();
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

  /**
   * Open (creating if needed) the engine for a space this server SERVES.
   *
   * C3.1b hosted-space gate (2026-07-18, blocker C3A1): this entry point
   * is the SERVE side of the gate — every caller reaches it because a
   * client session, host API, or ACL/lease/lane path legitimately serves
   * `space`, so serving a brand-new space keeps working, and each served
   * space registers as hosted on `#crossSpaceRouter` (which wires its
   * cross-space protocol inbox). The PEER-WRITE side is
   * `openHostedEngine`: inbound mirror/dirt applies go through it, and it
   * refuses — loudly, minting nothing — for a space this host does not
   * host, so a crafted message can no longer shed state into a shadow
   * engine. "Hosted" = registered this lifetime (served) ∪ materialized
   * in this host's store (served by a previous lifetime — restart-safe);
   * see `spaceMaterializedInStore`.
   */
  private openEngine(space: string): Promise<Engine.Engine> {
    const existing = this.#engines.get(space);
    if (existing !== undefined) {
      return existing;
    }
    // C3.10a (2026-07-18): the space→host routing table is the authority
    // for "not mine" — a space routed to a PEER host is never locally
    // materialized, on ANY path (serve included; traffic for it rides
    // the link instead). A stale store file for a since-migrated space
    // does not entitle local serving: the routing table wins, loudly
    // (C3A1/C3A13). The three-way split: locally-hosted = register +
    // create (below), peer-routed = refuse here, unknown = the C3.1b
    // drop/refuse discipline. In-process transports carry no routing
    // face — single-host behavior unchanged.
    const routedHost = this.#crossSpaceRouter.transport.routing
      ?.peerHostFor(space);
    if (routedHost !== undefined) {
      return Promise.reject(
        new CrossSpaceProtocolError(
          "space-not-hosted",
          `refusing to open an engine for ${space}: the space→host ` +
            `routing table routes it to peer host ${routedHost} ` +
            "(C3.10a — a peer-routed space is never locally materialized)",
        ),
      );
    }
    this.registerCrossSpaceHostedSpace(space);

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
      const engine = await Engine.open({ url });
      this.#openedEngines.set(space, engine);
      return engine;
    })();
    opened.catch(() => {
      if (this.#engines.get(space) === opened) {
        this.#engines.delete(space);
      }
    });
    this.#engines.set(space, opened);
    return opened;
  }

  /**
   * The peer-write side of the C3.1b hosted-space gate: open the engine
   * for a space ONLY if this host hosts it — refuse (without creating a
   * directory, an engine, or a registration) for an unhosted name. Used
   * by the cross-space inbound apply path; the router already drops
   * frames for unregistered spaces, so this is the belt-and-braces line
   * for applies that outlive a registration (and the seam C3.10a's
   * routing table gates for real links).
   */
  private async openHostedEngine(space: string): Promise<Engine.Engine> {
    if (
      !this.#crossSpaceRouter.isHosted(space) &&
      !(await this.spaceMaterializedInStore(space))
    ) {
      throw new CrossSpaceProtocolError(
        "space-not-hosted",
        `refusing to open an engine for ${space}: this host does not ` +
          "host it (C3.1b hosted-space gate; a peer write never mints " +
          "an engine — C3A1)",
      );
    }
    return this.openEngine(space);
  }

  /**
   * Register a space this host hosts on the cross-space router, wiring
   * its protocol inbox. Idempotent; a no-op once the router closed
   * (server shutdown) so late `openEngine` calls behave as before.
   */
  private registerCrossSpaceHostedSpace(space: string): void {
    if (this.#crossSpaceRouter.isHosted(space)) {
      return;
    }
    try {
      this.#crossSpaceRouter.register(
        space,
        (message, context) => this.acceptCrossSpaceMessage(message, context),
      );
    } catch (error) {
      if (error instanceof CrossSpaceProtocolError) {
        // router-closed during shutdown, or a lost registration race —
        // both leave the pre-C3.1b behavior intact.
        return;
      }
      throw error;
    }
  }

  /**
   * Whether `space` is materialized in this host's store — the durable
   * half of the C3.1b "hosted" definition (the deployment surface: a
   * space this host served in ANY lifetime lives in its store; the
   * single-host world therefore keeps working across restarts — e.g. a
   * parked home space's dirt keeps landing before its first re-serve).
   * Memory-backed stores have no durable surface: hosted = registered.
   */
  private async spaceMaterializedInStore(space: string): Promise<boolean> {
    if (this.#engines.has(space)) {
      return true;
    }
    if (this.#store === undefined) {
      return false;
    }
    try {
      const url = resolveSpaceStoreUrl(
        this.#store,
        space as `did:${string}:${string}`,
      );
      if (url.protocol !== "file:") {
        return false;
      }
      return await FS.exists(url, { isFile: true });
    } catch {
      // Unencodable space names cannot be store-materialized.
      return false;
    }
  }

  /**
   * Send-side hosting resolution for the in-process transport: register
   * a store-materialized target space so the router can deliver to it
   * (the in-process stand-in for the PEER host's own store-backed
   * registration — C3.10a replaces this with real space→host routing).
   * Returns false — registering nothing — for a space this host does not
   * host; the subsequent send then drops at the router with zero side
   * effects (the C3A1 shadow-engine refusal).
   *
   * C3.10a (2026-07-18): a PEER-ROUTED space is deliverable without any
   * local hosting — the send rides the link — so it returns true while
   * registering nothing. The routed check precedes the store check on
   * purpose: a stale store file for a since-migrated space must not
   * resurrect a local registration (and with it a local inbox +
   * loopback delivery) for a space the routing table assigns elsewhere.
   */
  private async ensureCrossSpaceHosting(space: string): Promise<boolean> {
    if (this.#crossSpaceRouter.isHosted(space)) {
      return true;
    }
    if (
      this.#crossSpaceRouter.transport.routing?.peerHostFor(space) !==
        undefined
    ) {
      return true;
    }
    if (await this.spaceMaterializedInStore(space)) {
      this.registerCrossSpaceHostedSpace(space);
      return true;
    }
    return false;
  }

  /**
   * Inbound cross-space dispatch for one hosted space (the handler
   * `registerCrossSpaceHostedSpace` wires). Delivery does not await
   * handlers (transport contract), so applies queue onto per-space
   * chains — apply order per space = arrival order — and the flat
   * pending set feeds `settleCrossSpaceDeliveries`.
   */
  private acceptCrossSpaceMessage(
    message: CrossSpaceMessage,
    context: CrossSpaceDeliveryContext,
  ): void {
    switch (message.type) {
      case "foreign-observation.mirror":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignObservationMirror(message, context),
        );
        return;
      case "foreign-dirty-mark":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignDirtyMark(message, context),
        );
        return;
      // C3.3a (2026-07-18): the foreign-wake pipeline arms. All four ride
      // the per-space apply chain — subscription mutations so consults
      // observe them in arrival order, the ack and the notice so they are
      // processed strictly AFTER any dirt mark that preceded them on the
      // FIFO link (dirt-before-wake / dirt-before-scan).
      case "foreign-readers.subscribe":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignReadersSubscribe(message, context),
        );
        return;
      case "foreign-readers.unsubscribe":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignReadersUnsubscribe(message, context),
        );
        return;
      case "foreign-readers.subscribe-applied":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignReadersSubscribeApplied(message, context),
        );
        return;
      case "foreign-stale-readers":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.applyForeignStaleReaders(message, context),
        );
        return;
      // C3.2 (2026-07-18): the epoch arms. Bump and query-result are
      // synchronous cache merges (no engine, order-insensitive by
      // monotonicity); the query answers from the durable table, so it
      // rides the per-space apply chain like the other engine touches.
      case "foreign-authorization-epoch.bump":
        this.applyForeignAuthorizationEpochBump(message, context);
        return;
      case "foreign-authorization-epoch.query.result":
        this.applyForeignAuthorizationEpochQueryResult(message, context);
        return;
      case "foreign-authorization-epoch.query":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.answerForeignAuthorizationEpochQuery(message, context),
        );
        return;
      // C3.4 (2026-07-18): the point-read arms — the last C3.1
      // vocabulary without an inbound consumer (the former warn-drop
      // default). The request rides the per-space apply chain (engine
      // read — order behind in-flight inbound applies, like the epoch
      // query); the result is a synchronous correlation resolution
      // (like the bump: no engine, requestId-keyed, order-insensitive).
      case "foreign-point-read":
        this.queueCrossSpaceInboundApply(
          context.space,
          () => this.answerForeignPointRead(message, context),
        );
        return;
      case "foreign-point-read.result":
        this.applyForeignPointReadResult(message, context);
        return;
      default:
        // Every current C3.1 message type has an inbound consumer; an
        // ADDITIVE future type parses (additive-tolerant read) and
        // drops here, side-effect-free by construction.
        console.warn(
          `cross-space message ${(message as CrossSpaceMessage).type} for ` +
            `${context.space} has no inbound consumer (dropped)`,
        );
    }
  }

  private queueCrossSpaceInboundApply(
    space: string,
    apply: () => Promise<void>,
  ): void {
    const run = () =>
      apply().catch((error) => {
        // Same containment as the pre-C3.1b side-effect path: the home
        // commit is durable; a failed fan-out apply must never look like
        // a rejected commit.
        console.warn("cross-space inbound apply failed:", error);
      });
    const previous = this.#crossSpaceInboundApplyChains.get(space);
    const queued = previous?.then(run, run) ?? run();
    const tracked = queued.finally(() => {
      if (this.#crossSpaceInboundApplyChains.get(space) === tracked) {
        this.#crossSpaceInboundApplyChains.delete(space);
      }
      this.#pendingCrossSpaceInboundApplies.delete(tracked);
    });
    this.#crossSpaceInboundApplyChains.set(space, tracked);
    this.#pendingCrossSpaceInboundApplies.add(tracked);
  }

  /**
   * Same-host application barrier: resolve once every cross-space frame
   * sent so far has been dispatched and its engine apply settled. One
   * microtask hop lets the in-process channel's queued drain (scheduled
   * at send time, FIFO-ordered before this continuation) run and enqueue
   * applies; the loop then drains stragglers. Barrier-driven — no timers.
   */
  private async settleCrossSpaceDeliveries(): Promise<void> {
    do {
      await undefined;
      const pending = [...this.#pendingCrossSpaceInboundApplies];
      if (pending.length === 0) {
        return;
      }
      await Promise.all(pending);
    } while (true);
  }

  private async applyForeignObservationMirror(
    message: ForeignObservationMirror,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    // Full semantic validation with the engine's OWN validator — the
    // codec only shallow-validates the observation (module boundary).
    // An unparseable observation drops with zero side effects.
    const observation = Engine.schedulerObservationFromValue(
      message.observation,
    );
    if (observation === undefined) {
      console.warn(
        `cross-space mirror for ${context.space} from ` +
          `${context.fromSpace} carried an invalid observation (dropped)`,
      );
      return;
    }
    const engine = await this.openHostedEngine(context.space);
    // C3.3a/C3A9: this engine's serverSeq bounds the read-to-mirror
    // window — captured before the upsert transaction, which serializes
    // against local commits (see MirroredReadToMirrorWindowOptions).
    const windowDirtySeq = Engine.serverSeq(engine);
    const result = Engine.upsertMirroredSchedulerObservation(engine, {
      branch: message.branch,
      // Envelope addressing IS the contract: the home space is the
      // envelope's fromSpace (the codec pinned any payload ownerSpace to
      // it), the read space this inbox's own.
      ownerSpace: context.fromSpace,
      observedAtSeq: message.observedAtSeq,
      scopeContext: {
        principal: message.scopeContext.principal,
        sessionId: message.scopeContext.sessionId,
      },
      writerSessionId: message.writerSessionId,
      originExecutionContextKey: message.originExecutionContextKey,
      observation,
      // C3.5 (C3A16): cause rows in THIS engine carry the READ space's
      // seqs, while a provenance-carrying observation's scalar is the
      // HOME space's — inheriting it (the upsert's fallback) consumes
      // read-space causes through a home-domain number. Pass the vector's
      // READ-SPACE component instead; a settlement without a component for
      // this space covers NOTHING here (C3A15 vacuous: 0 consumes no
      // cause row, seqs are ≥ 1). Ordinary client observations keep the
      // clear-all fallback byte-identically — their mirror semantics
      // predate the vector and carry no provenance.
      ...(observation.executionProvenance !== undefined
        ? {
          causeCoverageSeq: inputBasisComponentForSpace(
            observation.executionProvenance.inputBasis,
            context.space,
          )?.seq ?? 0,
        }
        : {}),
      ...(windowDirtySeq >= 1
        ? {
          readToMirrorWindow: {
            readSpace: context.space,
            windowDirtySeq,
          },
        }
        : {}),
    });
    // C3A9 fan-out: a window mark applied inside the upsert transaction
    // flows exactly like a commit-time dirtying — the durable mark to the
    // home engine (the ledger the subscribe-time scan replays), plus the
    // live notice when a subscription covers the action's lane. Sends
    // only — never settle deliveries from inside an inbound apply (the
    // pending-set barrier would deadlock on this very apply).
    if (result.readToMirrorWindowDirtySeq !== undefined) {
      const reader = {
        branch: message.branch,
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
        executionContextKey: result.executionContextKey,
      };
      try {
        const link = this.#crossSpaceRouter.link(
          context.space,
          context.fromSpace,
        );
        link.send({
          type: "foreign-dirty-mark",
          branch: message.branch,
          dirtySeq: result.readToMirrorWindowDirtySeq,
          readers: [reader],
        });
        const subscription = this.foreignReaderSubscriptionsByReadSpace
          .get(context.space)
          ?.get(`${context.fromSpace}\0${message.branch}`);
        if (
          subscription !== undefined &&
          subscription.laneDemands.some((lane) =>
            lane.contextKey === reader.executionContextKey &&
            lane.pieces.includes(reader.pieceId)
          )
        ) {
          link.send({
            type: "foreign-stale-readers",
            branch: message.branch,
            commitSeq: result.readToMirrorWindowDirtySeq,
            readers: [reader],
          });
        }
      } catch (error) {
        console.warn(
          "read-to-mirror window dirt fan-out failed:",
          error,
        );
      }
    }
  }

  private async applyForeignDirtyMark(
    message: ForeignDirtyMark,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    const engine = await this.openHostedEngine(context.space);
    Engine.markSchedulerActionsDirectDirty(engine, {
      branch: message.branch,
      ownerSpace: context.space,
      dirtySeq: message.dirtySeq,
      // The dirty path consumes exactly the action key (dedupe, the
      // direct-dirty upsert, cause recording, and stale propagation all
      // key on branch/ownerSpace/pieceId/processGeneration/actionId/
      // executionContextKey); the read-row fields of a full
      // SchedulerReaderIndexEntry (observationId/readKind/read) are
      // write-space-local and were never meaningful across engines, so
      // the wire identity is the key — hence the cast.
      actions: message.readers.map((reader) =>
        ({
          branch: reader.branch,
          ownerSpace: context.space,
          pieceId: reader.pieceId,
          processGeneration: reader.processGeneration,
          actionId: reader.actionId,
          executionContextKey: reader.executionContextKey,
        }) as Engine.SchedulerReaderIndexEntry
      ),
    });
    // C3.10b cursor slot (C3A12 keying — see the field docblock).
    const cursorKey =
      `${context.linkId}\0${context.fromSpace}\0${context.space}`;
    const cursor = this.crossSpaceAppliedDirtCursors.get(cursorKey) ?? 0;
    if (message.dirtySeq > cursor) {
      this.crossSpaceAppliedDirtCursors.set(cursorKey, message.dirtySeq);
    }
  }

  /**
   * C3.3a read-host arm: apply (or supersede) a home space's demand-joined
   * subscription. The registration becomes consult-visible IMMEDIATELY —
   * every commit this host accepts after this apply sees it in
   * `#emitForeignStaleReaderNotices` — while the C3A10 ack is emitted
   * only after the read space's post-commit side-effect chain, as
   * captured HERE, drains: every commit accepted before this apply has
   * its `ForeignDirtyMark` sent (and, in-process, applied) before the
   * ack, so the home host's post-ack scan cannot run ahead of that dirt.
   * The continuation is deliberately DETACHED: awaiting the side-effect
   * chain inside this inbound apply would deadlock — side-effect jobs
   * await `settleCrossSpaceDeliveries`, which awaits this very apply.
   *
   * Stale generations (<= the live one) are dropped WITHOUT an ack: the
   * home reconciler is serialized per stream, so a stale subscribe is
   * always a reordering artifact, and acking it could release a barrier
   * whose drain never covered this host's state.
   */
  private applyForeignReadersSubscribe(
    message: ForeignReadersSubscribe,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    let byHome = this.foreignReaderSubscriptionsByReadSpace.get(context.space);
    if (byHome === undefined) {
      byHome = new Map();
      this.foreignReaderSubscriptionsByReadSpace.set(context.space, byHome);
    }
    const subscriptionKey = `${context.fromSpace}\0${message.branch}`;
    const current = byHome.get(subscriptionKey);
    if (
      current !== undefined &&
      message.subscriptionGeneration <= current.generation
    ) {
      return Promise.resolve();
    }
    byHome.set(subscriptionKey, {
      generation: message.subscriptionGeneration,
      laneDemands: message.laneDemands,
    });
    const drained = this.#schedulerSideEffectsByOwnerSpace.get(context.space) ??
      Promise.resolve();
    const ack = drained.then(() => {
      if (this.#foreignSubscriptionsClosed) return;
      this.#crossSpaceRouter.link(context.space, context.fromSpace).send({
        type: "foreign-readers.subscribe-applied",
        branch: message.branch,
        subscriptionGeneration: message.subscriptionGeneration,
      });
    }).catch((error) => {
      console.warn("foreign-readers subscribe ack failed:", error);
    });
    this.trackForeignSubscriptionWork(ack);
    return Promise.resolve();
  }

  /**
   * C3.3a read-host arm: retire EXACTLY the named generation. The two-part
   * barrier sends this only after the superseding generation was acked, so
   * on the healthy path the registry already carries a higher generation
   * and this is a no-op — the generation equality is what discriminates a
   * reordered/stale unsubscribe from a real teardown (C3A10).
   */
  private applyForeignReadersUnsubscribe(
    message: ForeignReadersUnsubscribe,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    const byHome = this.foreignReaderSubscriptionsByReadSpace.get(
      context.space,
    );
    const subscriptionKey = `${context.fromSpace}\0${message.branch}`;
    const current = byHome?.get(subscriptionKey);
    if (
      current !== undefined &&
      current.generation === message.subscriptionGeneration
    ) {
      byHome!.delete(subscriptionKey);
      if (byHome!.size === 0) {
        this.foreignReaderSubscriptionsByReadSpace.delete(context.space);
      }
    }
    return Promise.resolve();
  }

  /**
   * C3A6/C3.7 seam (dated 2026-07-18, deliberately NOT wired yet): drop
   * every live subscription a home space holds on `readSpace` — the
   * read-host half of revocation cleanup. C3.7's epoch-bump revocation
   * calls this (plus mirrored-row tombstoning, its own scope) when the
   * last authorized reader of a demand pair loses access, so the read
   * host stops emitting `ForeignStaleReaders` toward a home host with no
   * live authorized reader. Discoverable-by-name on purpose; C3.2's
   * epoch machinery is not consumed in C3.3a.
   */
  private dropForeignReaderSubscriptionsForHome(
    readSpace: string,
    homeSpace: string,
  ): void {
    const byHome = this.foreignReaderSubscriptionsByReadSpace.get(readSpace);
    if (byHome === undefined) return;
    for (const key of [...byHome.keys()]) {
      if (key.split("\0")[0] === homeSpace) byHome.delete(key);
    }
    if (byHome.size === 0) {
      this.foreignReaderSubscriptionsByReadSpace.delete(readSpace);
    }
  }

  /**
   * C3.3a home-host arm: the C3A10 ack. Rides the home space's inbound
   * apply chain like every other cross-space apply, so it is processed
   * strictly AFTER every `ForeignDirtyMark` that preceded it on the FIFO
   * link — the reconciler's post-ack scan therefore reads an engine that
   * already carries the pre-subscribe dirt.
   */
  private applyForeignReadersSubscribeApplied(
    message: ForeignReadersSubscribeApplied,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    const state = this.foreignReaderSubscriptionsByHomeSpace.get(
      `${context.space}\0${message.branch}\0${context.fromSpace}`,
    );
    state?.ackWaiters.get(message.subscriptionGeneration)?.();
    return Promise.resolve();
  }

  /**
   * C3.3a home-host arm: an inbound `ForeignStaleReaders` becomes a
   * FOREIGN wake (replacing the C3.1 warn-drop). Rides the per-space
   * apply chain so the wake dispatch is ordered after the same commit's
   * dirt apply (the dirt mark precedes the notice on the FIFO link —
   * see `#emitForeignStaleReaderNotices`); by dispatch time the dirt is
   * durable in this engine, so a pool scan or provider rerun triggered
   * by the wake observes it. Readers group by their HOME branch (the
   * mirrored rows' branch) — the notice's own `branch` is the COMMITTING
   * space's and never keys home state.
   */
  private applyForeignStaleReaders(
    message: ForeignStaleReaders,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    if (message.readers.length === 0) return Promise.resolve();
    const byBranch = new Map<BranchName, ForeignReaderIdentity[]>();
    for (const reader of message.readers) {
      const readers = byBranch.get(reader.branch);
      if (readers === undefined) byBranch.set(reader.branch, [reader]);
      else readers.push(reader);
    }
    for (const [branch, readers] of byBranch) {
      this.#dispatchForeignWake({
        space: context.space,
        branch,
        readSpace: context.fromSpace,
        readSeq: message.commitSeq,
        origin: "notice",
        staleForeignReaders: readers.map((reader) => ({
          branch: reader.branch,
          pieceId: reader.pieceId,
          processGeneration: reader.processGeneration,
          actionId: reader.actionId,
          executionContextKey: reader.executionContextKey,
        })),
      });
    }
    return Promise.resolve();
  }

  /** Track one piece of C3.3a background work for the settle barrier. */
  private trackForeignSubscriptionWork(work: Promise<void>): void {
    const tracked = work.finally(() => {
      this.#pendingForeignSubscriptionWork.delete(tracked);
    });
    this.#pendingForeignSubscriptionWork.add(tracked);
  }

  /**
   * C3.3a trigger fan-in: schedule a foreign-subscription reconcile for
   * one (home space, branch). Fired on demand publication (set/remove/ACL
   * drains — every `#publishExecutionDemands` site), on lane-grant open
   * and drain (C3A17: lane churn re-registers), and after post-commit
   * side effects for commits whose observations touched foreign read
   * spaces. Coalescing: at most one in-flight pass per key, a trigger
   * during a pass sets the rerun bit. Fire-and-forget by design — the
   * C3A10 barrier lives inside the pass, not at the trigger sites (a
   * transact must not await a cross-space round trip it did not cause).
   */
  private scheduleForeignReaderSubscriptionReconcile(
    space: string,
    branch: BranchName,
  ): void {
    if (this.#foreignSubscriptionsClosed) return;
    if (!getPersistentSchedulerStateConfig()) return;
    const key = `${space}\0${branch}`;
    const existing = this.#foreignSubscriptionReconciles.get(key);
    if (existing !== undefined) {
      existing.rerun = true;
      return;
    }
    const entry = { rerun: false, chain: Promise.resolve() };
    entry.chain = (async () => {
      try {
        do {
          entry.rerun = false;
          try {
            await this.reconcileForeignReaderSubscriptions(space, branch);
          } catch (error) {
            console.warn(
              "foreign-reader subscription reconcile failed:",
              error,
            );
          }
        } while (entry.rerun && !this.#foreignSubscriptionsClosed);
      } finally {
        if (this.#foreignSubscriptionReconciles.get(key) === entry) {
          this.#foreignSubscriptionReconciles.delete(key);
        }
      }
    })();
    this.#foreignSubscriptionReconciles.set(key, entry);
    this.trackForeignSubscriptionWork(entry.chain);
  }

  /**
   * C3.3a home-host reconciler — one serialized pass for (space, branch):
   * derive the DESIRED foreign subscriptions from current demand ∩ the
   * engine's own read-index (which demanded pieces read which foreign
   * spaces — the durable client-observed read surface, independent of
   * mirror fan-out timing), then converge the live registrations under
   * the C3A10 two-part barrier:
   *
   *   subscribe(gen N+1) → application-level ack (the read host emits
   *   `subscribe-applied` only after draining side effects for commits it
   *   accepted before applying the subscribe) → post-ack
   *   direct-dirty-∩-demand scan with pool wake → unsubscribe(gen N).
   *
   * The interleaving this closes (V10): a commit accepted by the read
   * host between the two registrations either (a) lands before the
   * subscribe applies — its dirt propagation is covered by the ack drain
   * and surfaces via the post-ack scan, or (b) lands after — the
   * subscribe is consult-visible at its publish, so the notice fires.
   * Neither order loses the wake; the fixture drives both.
   */
  private async reconcileForeignReaderSubscriptions(
    space: string,
    branch: BranchName,
  ): Promise<void> {
    if (this.#foreignSubscriptionsClosed) return;
    const engine = await this.openEngine(space);
    if (this.#foreignSubscriptionsClosed) return;
    const laneDemands = this.#executionWakeLaneDemands(space, branch);
    const demandedSchedulerPieceIds = laneDemands[0].pieces;
    const foreignReadSpaces = Engine.schedulerForeignReadSpacesForPieces(
      engine,
      { branch, ownerSpace: space, demandedSchedulerPieceIds },
    );
    const desired = new Map<string, CrossSpaceLaneDemand[]>();
    for (const [readSpace, piecesReading] of foreignReadSpaces) {
      const reading = new Set(piecesReading);
      const lanes: CrossSpaceLaneDemand[] = [];
      for (const [index, lane] of laneDemands.entries()) {
        const pieces = lane.pieces.filter((pieceId) => reading.has(pieceId));
        // The space-lane pair is structurally required first (A4 order);
        // scoped lanes ride only when their demand slice reads the space.
        if (index === 0) {
          lanes.push({ contextKey: lane.contextKey, pieces });
        } else if (pieces.length > 0) {
          lanes.push({ contextKey: lane.contextKey, pieces });
        }
      }
      if (lanes.some((lane) => lane.pieces.length > 0)) {
        desired.set(readSpace, lanes);
      }
    }

    // Teardown first: streams whose demand no longer reads the space.
    const statePrefix = `${space}\0${branch}\0`;
    for (
      const [stateKey, state] of [
        ...this.foreignReaderSubscriptionsByHomeSpace,
      ]
    ) {
      if (!stateKey.startsWith(statePrefix)) continue;
      const readSpace = stateKey.slice(statePrefix.length);
      if (desired.has(readSpace)) continue;
      if (state.liveGeneration !== undefined) {
        try {
          this.#crossSpaceRouter.link(space, readSpace).send({
            type: "foreign-readers.unsubscribe",
            branch,
            subscriptionGeneration: state.liveGeneration,
          });
        } catch (error) {
          console.warn("foreign-readers unsubscribe failed:", error);
        }
      }
      this.foreignReaderSubscriptionsByHomeSpace.delete(stateKey);
    }

    for (const [readSpace, lanes] of desired) {
      if (this.#foreignSubscriptionsClosed) return;
      const stateKey = `${statePrefix}${readSpace}`;
      let state = this.foreignReaderSubscriptionsByHomeSpace.get(stateKey);
      const laneDemandsKey = JSON.stringify(lanes);
      if (
        state?.liveGeneration !== undefined &&
        state.liveLaneDemandsKey === laneDemandsKey
      ) {
        continue;
      }
      // In-process stand-in for the peer host's own hosting registration
      // (see mirrorSchedulerObservation): an unhosted read space cannot
      // ack; skip rather than hang the chain. C3.10a's routing replaces
      // this with real space→host resolution.
      if (!(await this.ensureCrossSpaceHosting(readSpace))) continue;
      if (state === undefined) {
        state = { nextGeneration: 0, ackWaiters: new Map() };
        this.foreignReaderSubscriptionsByHomeSpace.set(stateKey, state);
      }
      const generation = ++state.nextGeneration;
      const previousGeneration = state.liveGeneration;
      const link = this.#crossSpaceRouter.link(space, readSpace);
      const acked = new Promise<void>((resolve) => {
        state!.ackWaiters.set(generation, resolve);
      });
      try {
        link.send({
          type: "foreign-readers.subscribe",
          branch,
          laneDemands: lanes,
          subscriptionGeneration: generation,
        });
      } catch (error) {
        state.ackWaiters.delete(generation);
        console.warn("foreign-readers subscribe failed:", error);
        continue;
      }
      // C3A10 part one: the new generation is REGISTERED (and consult-
      // visible on the read host) before the old one retires — awaiting
      // the application-level ack here is what makes that true; the
      // transport's no-await-delivery contract cannot.
      await acked;
      state.ackWaiters.delete(generation);
      if (this.#foreignSubscriptionsClosed) return;
      state.liveGeneration = generation;
      state.liveLaneDemandsKey = laneDemandsKey;
      // C3A10 part two: the post-ack direct-dirty-∩-demand scan. Dirt
      // that landed while no (or a stale) subscription was live produced
      // no notice; it IS durable in this engine (C3.1b), so replay it as
      // a wake now that the registration covers the stream.
      try {
        await this.runPostAckForeignDirtScan(space, branch, readSpace, lanes);
      } catch (error) {
        console.warn("post-ack foreign dirt scan failed:", error);
      }
      if (previousGeneration !== undefined) {
        try {
          link.send({
            type: "foreign-readers.unsubscribe",
            branch,
            subscriptionGeneration: previousGeneration,
          });
        } catch (error) {
          console.warn("foreign-readers unsubscribe failed:", error);
        }
      }
    }
  }

  /**
   * C3A10's second half: wake every demanded home action carrying
   * UNSETTLED durable foreign dirt, at the subscription's lane
   * granularity. Runs strictly after the ack applied on the home inbound
   * chain, i.e. after every dirt mark that preceded the ack on the FIFO
   * link. Spurious wakes are safe (the pool reconciles to a no-op);
   * missed ones are not — hence no seq floor (foreign dirt seqs live in
   * the read space's domain and admit no home comparison, C3A11).
   */
  private async runPostAckForeignDirtScan(
    space: string,
    branch: BranchName,
    readSpace: string,
    lanes: readonly CrossSpaceLaneDemand[],
  ): Promise<void> {
    const engine = await this.openEngine(space);
    const collected: Engine.SchedulerActionState[] = [];
    for (const lane of lanes) {
      if (lane.pieces.length === 0) continue;
      collected.push(
        ...Engine.dirtyDemandedSchedulerActions(engine, {
          branch,
          ownerSpace: space,
          demandedSchedulerPieceIds: [...lane.pieces],
          applicableExecutionContextKeys: [lane.contextKey],
        }),
      );
    }
    if (collected.length === 0) return;
    const link = this.#crossSpaceRouter.link(space, readSpace);
    const cursor = this.crossSpaceAppliedDirtCursors.get(
      `${link.linkId}\0${readSpace}\0${space}`,
    ) ?? 0;
    this.#dispatchForeignWake({
      space,
      branch,
      readSpace,
      readSeq: cursor,
      origin: "resubscribe-scan",
      staleForeignReaders: collected.map((row) => ({
        branch: row.branch,
        pieceId: row.pieceId,
        processGeneration: row.processGeneration,
        actionId: row.actionId,
        executionContextKey: row.executionContextKey,
      })),
    });
  }

  /**
   * C3.3a settle barrier (tests + close): resolve once every reconcile
   * pass, detached ack continuation, and cross-space delivery in flight
   * has drained — looping, because each of those can queue more of the
   * others. Barrier-driven; no timers.
   */
  private async settleForeignReaderSubscriptions(): Promise<void> {
    do {
      await undefined;
      await this.settleCrossSpaceDeliveries();
      const pending = [...this.#pendingForeignSubscriptionWork];
      if (
        pending.length === 0 &&
        this.#pendingCrossSpaceInboundApplies.size === 0
      ) {
        return;
      }
      await Promise.allSettled(pending);
    } while (true);
  }

  /**
   * TEST SEAM (C3A9/C3A10 fixtures): hold `space`'s post-commit
   * side-effect chain — the injectable barrier on the side-effect queue
   * the review's fixtures name. `entered` resolves when the hold reaches
   * the head of the chain; `release` lets the chain proceed. Production
   * code never calls this.
   */
  private holdPostCommitSchedulerSideEffects(
    space: string,
  ): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = () => {
      enter();
      return gate;
    };
    const previous = this.#schedulerSideEffectsByOwnerSpace.get(space);
    const queued = previous?.then(run, run) ?? run();
    const tracked = queued.finally(() => {
      if (this.#schedulerSideEffectsByOwnerSpace.get(space) === tracked) {
        this.#schedulerSideEffectsByOwnerSpace.delete(space);
      }
    });
    this.#schedulerSideEffectsByOwnerSpace.set(space, tracked);
    return { entered, release };
  }

  /**
   * C3.2 publication (2026-07-18): fan an accepted commit's
   * authorization-epoch bumps (recorded transactionally by the engine —
   * `Engine.authorizationEpochBumpsOf`) out over the cross-space
   * protocol. Returns whether anything was sent, so the caller can run
   * the same-host application barrier.
   *
   * Addressing, v1: one `foreign-authorization-epoch.bump` per bump per
   * currently REGISTERED peer space on this host's router — the bump
   * message has no host-level broadcast address (`toSpace` names exactly
   * one home space per message), and "every registered link" is the
   * ruled v1 relationship set. Narrowing the fan-out to SUBSCRIBED home
   * spaces is C3.3a's (it owns the subscription registry); a peer that
   * registers later (or another host, once links are real) recovers via
   * the C3A12 epoch-query resync — the push is an optimization, the
   * durable table is the truth.
   *
   * MUST be called synchronously after `Engine.applyCommit` (before any
   * await) so per-space send order equals commit order — the in-process
   * channel is FIFO, so the receiving cache observes bumps in commit
   * order (and its max-merge makes even a reordered redelivery safe).
   * The C3.1b no-ack discipline applies: a failed fan-out warns and
   * never surfaces as a commit failure (the commit is already durable).
   */
  #publishAuthorizationEpochBumps(
    space: string,
    commit: Engine.AppliedCommit,
  ): boolean {
    const bumps = Engine.authorizationEpochBumpsOf(commit);
    if (bumps === undefined || bumps.length === 0) {
      return false;
    }
    let sent = false;
    try {
      this.registerCrossSpaceHostedSpace(space);
      // The v1 relationship set is "every registered link" (see the
      // docblock): locally-registered spaces via the loopback, and —
      // C3.10a (2026-07-18) — every space the routing table routes over
      // a live link, so the push crosses to co-hosted peers too. The
      // routing face enumerates only link-routed spaces; in-process it
      // is absent and the set is unchanged.
      const peers = new Set(this.#crossSpaceRouter.hostedSpaces());
      for (
        const routed of this.#crossSpaceRouter.transport.routing
          ?.routedSpaces() ?? []
      ) {
        peers.add(routed);
      }
      for (const peer of peers) {
        if (peer === space) continue;
        const link = this.#crossSpaceRouter.link(space, peer);
        for (const bump of bumps) {
          link.send({
            type: "foreign-authorization-epoch.bump",
            target: bump.target,
            epoch: bump.epoch,
          });
          sent = true;
        }
      }
    } catch (error) {
      console.warn(
        "cross-space authorization-epoch bump publication failed:",
        error,
      );
    }
    return sent;
  }

  /**
   * C3.2 (2026-07-18): issue a `foreign-authorization-epoch.query` from
   * `homeSpace` to `authoritySpace`'s host and settle same-host
   * delivery, returning the post-merge remote snapshot (undefined when
   * the authority answered nothing — e.g. unhosted). The inbound
   * `.query.result` arm max-merges into `#remoteAuthorizationEpochs`
   * keyed by the answering link, so no request/response correlation
   * state is needed: an epoch answer is trustworthy per C3A13 because
   * it arrived on a link speaking for `authoritySpace`, not because we
   * remember asking. Consumers: C3.7's re-issuance preflight and
   * C3.10b's reconnect resync (resync the epoch table before ANY claim
   * re-issuance — C3A12); the same-host settle here is the in-process
   * stand-in for C3.10b's cross-host response barrier.
   */
  async queryForeignAuthorizationEpochs(
    homeSpace: string,
    authoritySpace: string,
    principals?: readonly string[],
  ): Promise<
    | { floor: number; epochs: readonly { principal: string; epoch: number }[] }
    | undefined
  > {
    this.registerCrossSpaceHostedSpace(homeSpace);
    // In-process stand-in for the peer host's own hosting registration
    // (see mirrorSchedulerObservation): a store-materialized authority
    // re-registers lazily; a never-hosted name drops at the router.
    await this.ensureCrossSpaceHosting(authoritySpace);
    const link = this.#crossSpaceRouter.link(homeSpace, authoritySpace);
    link.send({
      type: "foreign-authorization-epoch.query",
      requestId: `xsp-epoch-query:${crypto.randomUUID()}`,
      ...(principals !== undefined ? { principals } : {}),
    });
    await this.settleCrossSpaceDeliveries();
    return this.remoteAuthorizationEpochSnapshot(
      link.linkId,
      authoritySpace,
    );
  }

  /**
   * Read seam over the remote-epoch cache (see the field docblock):
   * the max-merged view of `authoritySpace`'s epochs as learned over
   * `linkId`. Undefined when this host has learned NOTHING about that
   * (link, space) — the C3A3 unknown state consumers fail closed on.
   */
  remoteAuthorizationEpochSnapshot(
    linkId: string,
    authoritySpace: string,
  ):
    | { floor: number; epochs: readonly { principal: string; epoch: number }[] }
    | undefined {
    const entry = this.#remoteAuthorizationEpochs.get(
      `${linkId}\0${authoritySpace}`,
    );
    if (entry === undefined) return undefined;
    return {
      floor: entry.floor,
      epochs: [...entry.byPrincipal.entries()]
        .map(([principal, epoch]) => ({ principal, epoch }))
        .sort((left, right) => left.principal < right.principal ? -1 : 1),
    };
  }

  /**
   * Effective REMOTE epoch of a principal on a peer space: max(the
   * principal's learned row, the learned floor) — the exact lookup C3.7
   * claim revalidation and C3.8's apply fence will consult (dated
   * 2026-07-18, neither built here). A principal with no row reports the
   * floor (floor-only discipline); undefined means the (link, space) is
   * entirely unknown here — fail closed (C3A3).
   */
  effectiveRemoteAuthorizationEpoch(
    linkId: string,
    authoritySpace: string,
    principal: string,
  ): number | undefined {
    const entry = this.#remoteAuthorizationEpochs.get(
      `${linkId}\0${authoritySpace}`,
    );
    if (entry === undefined) return undefined;
    return Math.max(entry.byPrincipal.get(principal) ?? 0, entry.floor);
  }

  /** Max-merge one learned epoch component into the remote cache. */
  #mergeRemoteAuthorizationEpoch(
    linkId: string,
    authoritySpace: string,
    target: { kind: "floor" } | { kind: "principal"; principal: string },
    epoch: number,
  ): void {
    const key = `${linkId}\0${authoritySpace}`;
    let entry = this.#remoteAuthorizationEpochs.get(key);
    if (entry === undefined) {
      entry = { floor: 0, byPrincipal: new Map() };
      this.#remoteAuthorizationEpochs.set(key, entry);
    }
    if (target.kind === "floor") {
      entry.floor = Math.max(entry.floor, epoch);
    } else {
      entry.byPrincipal.set(
        target.principal,
        Math.max(entry.byPrincipal.get(target.principal) ?? 0, epoch),
      );
    }
  }

  /**
   * Inbound `foreign-authorization-epoch.bump`: max-merge into the
   * remote cache. Synchronous — no engine is involved, and monotonic
   * merge makes application order-insensitive (redelivery/reorder never
   * regresses), so this needs neither the per-space apply chain nor an
   * ack.
   */
  private applyForeignAuthorizationEpochBump(
    message: ForeignAuthorizationEpochBump,
    context: CrossSpaceDeliveryContext,
  ): void {
    this.#mergeRemoteAuthorizationEpoch(
      context.linkId,
      context.fromSpace,
      message.target,
      message.epoch,
    );
  }

  /**
   * Inbound `foreign-authorization-epoch.query.result`: merge the
   * answered floor and rows exactly like bumps (monotonic, keyed by the
   * answering link + `fromSpace` — C3A13's structural trust). A
   * principal ABSENT from the answer merges nothing: the floor the
   * answer carries is its floor-only report, and the cache never
   * fabricates per-principal rows.
   */
  private applyForeignAuthorizationEpochQueryResult(
    message: ForeignAuthorizationEpochQueryResult,
    context: CrossSpaceDeliveryContext,
  ): void {
    this.#mergeRemoteAuthorizationEpoch(
      context.linkId,
      context.fromSpace,
      { kind: "floor" },
      message.epochFloor,
    );
    for (const { principal, epoch } of message.epochs) {
      this.#mergeRemoteAuthorizationEpoch(
        context.linkId,
        context.fromSpace,
        { kind: "principal", principal },
        epoch,
      );
    }
  }

  /**
   * Inbound `foreign-authorization-epoch.query`: answer authoritatively
   * from THIS space's durable table (the same-transaction bump writer
   * keeps it exact). The answer carries the floor plus per-principal
   * rows — filtered to the requested set when one was named; a requested
   * principal with no row is reported floor-only (it is simply absent
   * from `epochs`, and `epochFloor` is its effective epoch), matching
   * the codec's fail-closed reading for principals the authority does
   * not know. Queued on the per-space apply chain: the engine read must
   * order after any in-flight inbound applies for this space.
   */
  private async answerForeignAuthorizationEpochQuery(
    message: ForeignAuthorizationEpochQuery,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    const engine = await this.openHostedEngine(context.space);
    const snapshot = Engine.authorizationEpochSnapshot(engine);
    const requested = message.principals !== undefined
      ? new Set(message.principals)
      : undefined;
    this.#crossSpaceRouter.link(context.space, context.fromSpace).send({
      type: "foreign-authorization-epoch.query.result",
      requestId: message.requestId,
      epochFloor: snapshot.floor,
      epochs: requested === undefined
        ? snapshot.epochs
        : snapshot.epochs.filter((entry) => requested.has(entry.principal)),
    });
  }

  /**
   * C3.4/C3A4 read-time authority liveness: resolve the ACTING principal
   * of a foreign point read from the LIVE home-side authority, or throw
   * the constant-shape rejection ({@link foreignReadAuthorityRejection})
   * — in which case NO foreign request is issued.
   *
   * The consult mirrors the commit fence's authority sources exactly
   * (never a second definition):
   *
   * - every lane: the channel's lease handle must be the CURRENT owned
   *   authority for its (space, branch) — not superseded, not draining —
   *   and the claim's bound `leaseGeneration` must be the lease's own
   *   (rotation mints a new generation, so a rotated sponsor fails here
   *   even before the claim-sweep is consulted);
   * - the claim must still be LIVE in `#executionClaims` at its exact
   *   (leaseGeneration, claimGeneration) — the same map the commit
   *   fence and `hasLiveExecutionClaim` consult; claims die with the
   *   lease (`#revokeExecutionClaimsForLease`) and with lane drains, so
   *   this is where release/rotation/drain surface;
   * - scoped lanes (user AND session — C3A4's enumeration): the live
   *   lane grant at the `#executionClaimLaneBindings`-bound
   *   `laneGeneration`, via the shared `#liveLaneGrantForKey` consult
   *   the commit fence's `laneAuthority` closure uses. The acting
   *   principal is the GRANT's principal (the C2.4 discipline: authority
   *   resolves from the live registry, never from a caller-supplied
   *   string).
   *
   * Space-lane acting principal: the current owned lease's `onBehalfOf`
   * (the sponsor). Deliberate asymmetry, recorded by C3.3b's report:
   * read-time authority resolves from LIVE authority — the CURRENT
   * sponsor — never from any accepted-row snapshot of a past sponsor.
   */
  #resolveForeignReadActingAuthority(
    lease: ExecutionLeaseHandle,
    claimRef: ExecutorForeignPointReadClaimRef,
  ): {
    principal: string;
    contextKey: SchedulerExecutionContextKey;
    claim: ExecutionClaim;
  } {
    const authority = this.#executionLeaseAuthorities.get(lease);
    const owned = this.#ownedExecutionLeases.get(
      executionLeaseKey(lease.space, lease.branch),
    );
    if (
      authority === undefined || authority !== owned ||
      authority.drainRequested ||
      claimRef.leaseGeneration !== authority.handle.leaseGeneration
    ) {
      throw foreignReadAuthorityRejection();
    }
    this.expireExecutionClaims();
    const claimKey = actionClaimMapKey({
      branch: lease.branch,
      space: lease.space,
      contextKey: claimRef.contextKey,
      pieceId: claimRef.pieceId,
      actionId: claimRef.actionId,
      actionKind: claimRef.actionKind,
      implementationFingerprint: claimRef.implementationFingerprint,
      runtimeFingerprint: claimRef.runtimeFingerprint,
    });
    const live = this.#executionClaims.get(claimKey);
    if (
      live === undefined ||
      live.leaseGeneration !== claimRef.leaseGeneration ||
      live.claimGeneration !== claimRef.claimGeneration
    ) {
      throw foreignReadAuthorityRejection();
    }
    if (live.contextKey === "space") {
      return {
        principal: authority.handle.onBehalfOf,
        contextKey: "space",
        claim: live,
      };
    }
    const binding = this.#executionClaimLaneBindings.get(claimKey);
    if (binding === undefined) {
      throw foreignReadAuthorityRejection();
    }
    const grant = this.#liveLaneGrantForKey(binding.laneKey);
    if (
      grant === undefined || grant.laneGeneration !== binding.laneGeneration
    ) {
      throw foreignReadAuthorityRejection();
    }
    return {
      principal: grant.principal,
      contextKey: live.contextKey,
      claim: live,
    };
  }

  /**
   * C3.4: an executor foreign point read under the acting context — the
   * home-host half of the wire flow. The provider channel calls this for
   * a Worker `docs.read` naming a foreign space; the read space's host
   * answers via {@link answerForeignPointRead}.
   *
   * Order of operations (each side of every await re-samples authority —
   * the `setExecutionClaim` discipline):
   *
   * 1. v1 address restriction (decision #3, send side): a user/session-
   *    scoped address fails with `foreign-read-scoped-address` before
   *    ANY authority consult or wire traffic. Space-scoped and
   *    undeclared (≡ space) addresses proceed.
   * 2. C3A4 read-time liveness
   *    ({@link #resolveForeignReadActingAuthority}); a dead/rotated/
   *    drained authority throws the constant shape with NO foreign
   *    request issued.
   * 3. Hosting resolution for the read space (may await store checks) —
   *    then liveness AGAIN (the await is an authority boundary).
   * 4. Send `foreign-point-read` over the router — local peer =
   *    in-process loopback; remote = the C3.10a link (`channelTo`
   *    resolves which) — and await the correlated result under the
   *    fail-closed timeout. The request's `actingPrincipal` carries the
   *    resolved principal, the lane contextKey, and the claim REFERENCE
   *    (audit/diagnostics — never credentials; trust is host-level,
   *    C3A13).
   *
   * The result's `served.seq`/`authorizationEpoch` land in the READ
   * space's domains: callers must never merge them into home watermarks.
   * C3.5 (built 2026-07-18) consumes them as the vector basis — the
   * served stamp is recorded per claim incarnation for later assertion
   * validation; C3.10b owns link-loss pending disposition (dated
   * 2026-07-18).
   */
  async executorForeignPointRead(
    lease: ExecutionLeaseHandle,
    request: {
      readSpace: string;
      claim: ExecutorForeignPointReadClaimRef;
      address: { id: EntityId; scope?: CellScope; path?: readonly string[] };
    },
  ): Promise<ExecutorForeignPointReadOutcome> {
    const { readSpace, claim, address } = request;
    if (
      typeof readSpace !== "string" || readSpace.length === 0 ||
      readSpace === lease.space
    ) {
      return { status: "failed", code: FOREIGN_POINT_READ_MALFORMED };
    }
    if (address.scope !== undefined && address.scope !== "space") {
      return { status: "failed", code: FOREIGN_POINT_READ_SCOPED_ADDRESS };
    }
    // First liveness fence BEFORE any async work: a dead authority must
    // reject without so much as a hosting probe.
    this.#resolveForeignReadActingAuthority(lease, claim);
    this.registerCrossSpaceHostedSpace(lease.space);
    if (!(await this.ensureCrossSpaceHosting(readSpace))) {
      return { status: "failed", code: FOREIGN_POINT_READ_UNHOSTED };
    }
    // The hosting resolution awaited: authority may have died meanwhile.
    // Re-resolve (and use the RE-resolved principal) so a rotation that
    // landed inside the await rejects instead of reading as the old
    // sponsor.
    const liveActing = this.#resolveForeignReadActingAuthority(lease, claim);
    const requestId = `xsp-point-read:${crypto.randomUUID()}`;
    const timeoutMs =
      this.options.executionControl?.foreignPointReadTimeoutMs ?? 10_000;
    const pending = Promise.withResolvers<ExecutorForeignPointReadOutcome>();
    const timer = setTimeout(() => {
      if (this.#pendingForeignPointReads.delete(requestId)) {
        pending.resolve({
          status: "failed",
          code: FOREIGN_POINT_READ_TIMEOUT,
        });
      }
    }, timeoutMs);
    this.#pendingForeignPointReads.set(requestId, {
      readSpace,
      resolve: pending.resolve,
      timer,
      // C3.5: served results record under this exact incarnation so a
      // later claimed commit's asserted stamps validate against what THIS
      // claim was actually served (a rotated/reissued claim never inherits
      // a predecessor's stamps).
      claimIncarnationKey: executionClaimIncarnationKey(liveActing.claim),
      docId: address.id,
    });
    try {
      this.#crossSpaceRouter.link(lease.space, readSpace).send({
        type: "foreign-point-read",
        requestId,
        address: {
          id: address.id,
          scope: "space",
          path: [...(address.path ?? [])],
        },
        actingPrincipal: {
          principal: liveActing.principal,
          contextKey: liveActing.contextKey,
          claim: {
            pieceId: claim.pieceId,
            actionId: claim.actionId,
            leaseGeneration: claim.leaseGeneration,
            claimGeneration: claim.claimGeneration,
          },
        },
      });
    } catch (error) {
      clearTimeout(timer);
      this.#pendingForeignPointReads.delete(requestId);
      console.warn("foreign point read send failed:", error);
      return { status: "failed", code: FOREIGN_POINT_READ_UNAVAILABLE };
    }
    return await pending.promise;
  }

  /**
   * C3.4 serve arm (read host): answer one authenticated foreign point
   * read. Queued on the per-space inbound apply chain (like the epoch
   * query): the engine read must order behind in-flight inbound applies
   * for this space.
   *
   * The ACL check IS `#authorizeMessageWithEngine` — the same resolution
   * the session read path and C3.3b's mirror gate use, for the ACTING
   * principal the home host resolved from live authority; never a second
   * capability definition. Dial semantics ride along unchanged: acl
   * "off" admits, "observe" warns-and-admits shortfalls (invalid ACL
   * still fails closed), "enforce" denies.
   *
   * v1 scope-resolution rule (decision #3, recorded 2026-07-18): a
   * foreign point read resolves ONLY the space-scoped instance —
   * `readState` under scope "space", scopeKey "space". The acting
   * context arrives in the message, but it does NOT select a lane
   * instance here: the read host holds no lane grant for a foreign lane
   * (grants live in the HOME host's registries), so a scoped resolution
   * would have to trust a wire-asserted lane — exactly what the C2.4
   * grant-session discipline forbids. Scoped addresses therefore reject
   * with `foreign-read-scoped-address` at the send side AND here;
   * lifting the restriction requires a protocol extension that carries
   * verifiable lane-resolution authority, not a serve-side relax.
   *
   * THE STAMP TRANSACTION (decision recorded 2026-07-18): the ACL
   * check, the document read, the covering seq, and the epoch stamp are
   * read in ONE synchronous section after the engine open — no await
   * between them. The engine applies commits synchronously inside
   * transact turns on this same event loop, and the ACL apply bumps the
   * epoch table in the SAME engine transaction as the ACL commit
   * (C3.2), so nothing can interleave: decision, document, seq, and
   * epoch are mutually consistent — one engine transaction in effect
   * without opening one. This holds identically on a co-hosted read
   * host (same code, its own event loop). What it does NOT provide is
   * cross-host freshness at APPLY time — that is C3.8's fence
   * (re-validate stamped epochs by equality), dated 2026-07-18.
   *
   * Branch: v1 reads resolve at the read space's DEFAULT branch
   * (decision #4) — the wire address carries no branch field at all.
   * `seq` stamps the read space's covering serverSeq at the read (what
   * C3.5's vector component consumes; also the C3A9 stamp the mirrored-
   * observation upsert compares). A genesis-empty read space (serverSeq
   * 0) has no seq domain to stamp — it answers
   * `foreign-read-unavailable` rather than minting an unencodable
   * zero-seq stamp (the wire pins served seqs positive).
   */
  private async answerForeignPointRead(
    message: ForeignPointRead,
    context: CrossSpaceDeliveryContext,
  ): Promise<void> {
    const answer = (result: ForeignPointReadResult["result"]): void => {
      try {
        this.#crossSpaceRouter.link(context.space, context.fromSpace).send({
          type: "foreign-point-read.result",
          requestId: message.requestId,
          result,
        });
      } catch (error) {
        // The C3.1b no-ack discipline: a failed answer send warns; the
        // home side's timeout is the fail-closed backstop.
        console.warn("foreign point read answer send failed:", error);
      }
    };
    const address: CrossSpacePointReadAddress = message.address;
    if (address.scope !== undefined && address.scope !== "space") {
      answer({
        status: "failed",
        code: FOREIGN_POINT_READ_SCOPED_ADDRESS,
      });
      return;
    }
    let engine: Engine.Engine;
    try {
      engine = await this.openHostedEngine(context.space);
    } catch {
      answer({ status: "failed", code: FOREIGN_POINT_READ_UNHOSTED });
      return;
    }
    // --- the synchronous stamp-transaction section (no awaits below) ---
    const principal = message.actingPrincipal.principal;
    const deny = this.#authorizeMessageWithEngine(
      engine,
      context.space,
      principal,
      "READ",
    );
    if (deny !== null) {
      answer({ status: "denied", code: FOREIGN_POINT_READ_DENIED_ACCESS });
      return;
    }
    const seq = Engine.serverSeq(engine);
    if (seq === 0) {
      answer({ status: "failed", code: FOREIGN_POINT_READ_UNAVAILABLE });
      return;
    }
    let state: Engine.EntityState | null;
    try {
      state = Engine.readState(engine, { id: address.id, scope: "space" });
    } catch {
      answer({ status: "failed", code: FOREIGN_POINT_READ_MALFORMED });
      return;
    }
    answer({
      status: "served",
      seq,
      branch: state?.branch ?? DEFAULT_BRANCH,
      document: state?.document ?? null,
      authorizationEpoch: {
        space: context.space,
        principal,
        epoch: Engine.effectiveAuthorizationEpoch(engine, principal),
      },
    });
  }

  /**
   * C3.4 result arm (home host): resolve the pending request the
   * `requestId` correlates. Synchronous, like the epoch bump — no engine
   * is involved, correlation is by unique id, and a late/duplicate/
   * unknown result drops with a warning (its pending entry already
   * resolved by answer, timeout, or close — all fail-closed). The
   * answering-space check (`fromSpace` vs the space the request was
   * addressed to) is the pending-map half of C3A13; the codec's
   * stamp.space === fromSpace rule already bound the stamp to the
   * envelope, so together a result can only satisfy a read it actually
   * answers.
   */
  private applyForeignPointReadResult(
    message: ForeignPointReadResult,
    context: CrossSpaceDeliveryContext,
  ): void {
    const pending = this.#pendingForeignPointReads.get(message.requestId);
    if (pending === undefined) {
      console.warn(
        `foreign point read result ${message.requestId} has no pending ` +
          "request (late, duplicate, or unknown — dropped)",
      );
      return;
    }
    if (pending.readSpace !== context.fromSpace) {
      console.warn(
        `foreign point read result ${message.requestId} answered by ` +
          `${context.fromSpace}, expected ${pending.readSpace} (dropped)`,
      );
      return;
    }
    this.#pendingForeignPointReads.delete(message.requestId);
    clearTimeout(pending.timer);
    const result = message.result;
    if (result.status === "served") {
      // C3.5: the host's own served-stamp record — the ONLY source the
      // vector's foreign components validate against (C3A13). Recording
      // happens strictly after the answering-space check above, so a
      // stamp can only enter under the space its authoritative host
      // answered for.
      this.#recordServedForeignReadStamp(
        pending.claimIncarnationKey,
        context.fromSpace,
        pending.docId,
        {
          seq: result.seq,
          authorizationEpoch: result.authorizationEpoch,
        },
      );
    }
    pending.resolve(
      result.status === "served"
        ? {
          status: "served",
          space: context.fromSpace,
          seq: result.seq,
          branch: result.branch,
          document: result.document,
          authorizationEpoch: result.authorizationEpoch,
        }
        : result,
    );
  }
}

const isSchedulerExecutionContextKey = (
  value: unknown,
): value is SchedulerExecutionContextKey =>
  value === "space" ||
  (typeof value === "string" &&
    (Engine.principalOfUserContextKey(value) !== undefined ||
      /^session:[^:]+:[^:]+$/.test(value)));

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

const parseSchedulerWritersForTargetsQuery = (
  value: Record<string, unknown>,
): SchedulerWritersForTargetsQuery | undefined => {
  if (
    Object.keys(value).some((key) => key !== "branch" && key !== "targets") ||
    (value.branch !== undefined && typeof value.branch !== "string") ||
    !Array.isArray(value.targets)
  ) {
    return undefined;
  }

  const targets: SchedulerWritersForTargetsQuery["targets"] = [];
  for (const target of value.targets) {
    if (
      !isRecord(target) ||
      Object.keys(target).some((key) =>
        key !== "id" && key !== "scope" && key !== "path"
      ) ||
      typeof target.id !== "string" ||
      target.id.length === 0 ||
      (target.scope !== undefined && target.scope !== "space" &&
        target.scope !== "user" && target.scope !== "session") ||
      !Array.isArray(target.path) ||
      !target.path.every((part) => typeof part === "string")
    ) {
      return undefined;
    }
    targets.push({
      id: target.id,
      ...(target.scope !== undefined
        ? { scope: target.scope as CellScope }
        : {}),
      path: toDocumentPath(target.path),
    });
  }

  return {
    ...(value.branch !== undefined ? { branch: value.branch as string } : {}),
    targets,
  };
};

/** C1.4b: additive per-request acting context. Shape-checked here only;
 * lane-grant validation is the handler's job. */
const parsedActingContext = (
  parsed: Record<string, unknown>,
): { actingContext?: SchedulerExecutionContextKey } =>
  typeof parsed.actingContext === "string"
    ? { actingContext: parsed.actingContext as SchedulerExecutionContextKey }
    : {};

/**
 * C3.4: additive claim reference on `docs.read` — the executor foreign
 * point read's acting-attempt identity. Shape-checked strictly: a
 * malformed record is DROPPED (the field simply does not parse), and the
 * consuming paths then fail closed — the provider's foreign arm requires
 * a parsed claim, and the direct serve path rejects any parsed one.
 */
const parsedDocsReadExecutionClaim = (
  parsed: Record<string, unknown>,
): { executionClaim?: DocsReadExecutionClaimRef } => {
  const raw = parsed.executionClaim;
  if (
    isRecord(raw) &&
    isSchedulerExecutionContextKey(raw.contextKey) &&
    typeof raw.pieceId === "string" && raw.pieceId.length > 0 &&
    typeof raw.actionId === "string" && raw.actionId.length > 0 &&
    (raw.actionKind === "computation" || raw.actionKind === "effect" ||
      raw.actionKind === "event-handler") &&
    typeof raw.implementationFingerprint === "string" &&
    typeof raw.runtimeFingerprint === "string" &&
    typeof raw.leaseGeneration === "number" &&
    isPositiveSafeInteger(raw.leaseGeneration) &&
    typeof raw.claimGeneration === "number" &&
    isPositiveSafeInteger(raw.claimGeneration)
  ) {
    return {
      executionClaim: {
        contextKey: raw.contextKey,
        pieceId: raw.pieceId,
        actionId: raw.actionId,
        actionKind: raw.actionKind,
        implementationFingerprint: raw.implementationFingerprint,
        runtimeFingerprint: raw.runtimeFingerprint,
        leaseGeneration: raw.leaseGeneration,
        claimGeneration: raw.claimGeneration,
      },
    };
  }
  return {};
};

/** FA5/FB12: the optional graph.query trigger attribution. Closed enum —
 * anything else is dropped (untriggered), so a caller can never mint
 * arbitrary traversal-bucket keys over the wire. */
const parsedGraphQueryTrigger = (
  parsed: Record<string, unknown>,
): { trigger?: GraphQueryTrigger } =>
  parsed.trigger === "wave" || parsed.trigger === "demand"
    ? { trigger: parsed.trigger }
    : {};

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
        executionFeedSeq: typeof parsed.session.executionFeedSeq === "number"
          ? parsed.session.executionFeedSeq
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
      ...parsedActingContext(parsed),
      ...parsedGraphQueryTrigger(parsed),
      query: parsed.query as unknown as GraphQueryRequest["query"],
    };
  }

  if (
    parsed.type === "docs.read" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isRecord(parsed.query) &&
    Array.isArray(parsed.query.docs)
  ) {
    return {
      type: "docs.read",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      ...parsedActingContext(parsed),
      ...parsedDocsReadExecutionClaim(parsed),
      query: parsed.query as unknown as DocsReadRequest["query"],
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
      ...parsedActingContext(parsed),
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
      ...parsedActingContext(parsed),
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
      ...parsedActingContext(parsed),
      query,
    };
  }

  if (
    parsed.type === "scheduler.writer.list" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isRecord(parsed.query)
  ) {
    const query = parseSchedulerWritersForTargetsQuery(parsed.query);
    if (query === undefined) return null;
    return {
      type: "scheduler.writer.list",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      ...parsedActingContext(parsed),
      query,
    };
  }

  if (
    parsed.type === "session.execution.demand.set" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.branch === "string" &&
    parsed.branch.length <= 256 &&
    Array.isArray(parsed.pieces) &&
    parsed.pieces.length <= 256 &&
    parsed.pieces.every((piece) =>
      typeof piece === "string" && piece.length > 0 && piece.length <= 512
    ) &&
    new Set(parsed.pieces).size === parsed.pieces.length &&
    Object.keys(parsed).every((key) =>
      key === "type" || key === "requestId" || key === "space" ||
      key === "sessionId" || key === "branch" || key === "pieces"
    )
  ) {
    return {
      type: "session.execution.demand.set",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      branch: parsed.branch,
      pieces: [...parsed.pieces] as string[],
    };
  }

  if (
    parsed.type === "session.execution.legacy-background.acquire" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.branch === "string" && parsed.branch.length <= 256 &&
    Object.keys(parsed).every((key) =>
      key === "type" || key === "requestId" || key === "space" ||
      key === "sessionId" || key === "branch"
    )
  ) {
    return {
      type: "session.execution.legacy-background.acquire",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      branch: parsed.branch,
    };
  }

  if (
    (parsed.type === "session.execution.legacy-background.renew" ||
      parsed.type === "session.execution.legacy-background.release") &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.branch === "string" && parsed.branch.length <= 256 &&
    typeof parsed.exclusionGeneration === "number" &&
    isPositiveSafeInteger(parsed.exclusionGeneration) &&
    Object.keys(parsed).every((key) =>
      key === "type" || key === "requestId" || key === "space" ||
      key === "sessionId" || key === "branch" ||
      key === "exclusionGeneration"
    )
  ) {
    return {
      type: parsed.type,
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      branch: parsed.branch,
      exclusionGeneration: parsed.exclusionGeneration,
    } as
      | LegacyBackgroundExclusionRenewRequest
      | LegacyBackgroundExclusionReleaseRequest;
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
      executionFeedSeq: typeof parsed.executionFeedSeq === "number"
        ? parsed.executionFeedSeq
        : undefined,
    };
  }

  return null;
};
