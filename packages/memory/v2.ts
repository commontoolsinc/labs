import {
  type EntityRef,
  getModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { isObject, isRecord } from "@commonfabric/utils/types";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

export const MEMORY_PROTOCOL = "memory" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type SessionToken = string;
export type CellScope = "space" | "user" | "session";
export type JobId = `job:${string}`;
export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type DocumentPath = readonly string[] & {
  readonly __memoryV2DocumentPath: unique symbol;
};
export type ValuePath = readonly string[] & {
  readonly __memoryV2ValuePath: unique symbol;
};
export type ReadPath = DocumentPath;
export type DocumentSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: DocumentPath };
export type ValueSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: ValuePath };

/**
 * A logical stored document. Today the system only produces and consumes the
 * `value` field; `source` and any additional metadata fields are reserved for
 * future use and carried as opaque payload (a document is validated merely as
 * "an object" — see {@link isEntityDocument}).
 */
export interface EntityDocument {
  value?: FabricValue;
  source?: EntityRef;
  [key: string]: FabricValue;
}

export interface Blob {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
}

export type PatchOp =
  | { op: "replace"; path: string; value: FabricValue }
  | { op: "add"; path: string; value: FabricValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | {
    op: "splice";
    path: string;
    index: number;
    remove: number;
    add: FabricValue[];
  }
  // A tail-relative append: `values` are inserted at the array's current tail,
  // with the array (and the path to it) created if absent. Carries no index, so
  // concurrent appends merge against durable state rather than clobbering via a
  // position computed from a stale base. `createsKey` — see below.
  | { op: "append"; path: string; values: FabricValue[]; createsKey?: true }
  // Set-add by identity: each of `values` is appended at the tail only if no
  // existing element of the array equals it (by stored-value equality), with the
  // array created if absent. Idempotent and commutative, so concurrent adds of
  // distinct elements merge and a repeated add is a no-op against durable state.
  | { op: "add-unique"; path: string; values: FabricValue[]; createsKey?: true }
  // Remove every element of the array at `path` that equals `value` by
  // stored-value equality. Idempotent (removing an absent value is a no-op) and
  // resolved against durable state, so it merges with concurrent writes instead
  // of clobbering via a whole-array rewrite. For a list of links this removes
  // the membership entry by its (deterministic) link, without reading the list.
  | { op: "remove-by-value"; path: string; value: FabricValue }
  // Numeric increment: `by` (which may be negative) is added to the number at
  // `path`, treating an absent value as 0 and creating the path if absent.
  // Applied against durable state, so concurrent increments sum rather than
  // clobber via last-write-wins. `createsKey` — see below.
  | { op: "increment"; path: string; by: number; createsKey?: true };

// `createsKey` (append / add-unique / increment): set by the writer when the op
// MATERIALIZES a previously-absent path — its own transaction base held no value
// at `path`, so applying it adds `path`'s last segment as a key to the parent
// container. It does not change how the op applies (these ops already
// create-if-absent); it tells the conflict matcher to invalidate a shape-only
// (nonRecursive) reader of the parent, whose key set changed. Absent/false means
// the target already existed, so only its value changed and no parent shape
// reader need conflict. The writer's base is authoritative for "never miss a
// genuine conflict": the first commit that creates a key necessarily saw it
// absent and sets the flag; a later append to the now-present key does not. A
// stale base can only set the flag when the key already existed durably, which
// over-conflicts a parent shape reader conservatively (an extra retry), never
// missing one. See docs/specs/memory-v2/08-conflict-granularity.md.

export interface SetOperation {
  op: "set";
  id: EntityId;
  scope?: CellScope;
  value: EntityDocument;
}

export interface PatchOperation {
  op: "patch";
  id: EntityId;
  scope?: CellScope;
  patches: PatchOp[];
}

export interface DeleteOperation {
  op: "delete";
  id: EntityId;
  scope?: CellScope;
}

/**
 * A SQLite write folded into the commit, applied inside the same transaction as
 * the cell ops (atomic). It is NOT an entity revision — it has no `id` and never
 * enters the revision/head/snapshot/dirty machinery (see SqliteDbRef below /
 * docs/specs/sqlite-builtin/plans/atomic-writes.md).
 */
export interface SqliteOperation {
  op: "sqlite";
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
}

export type Operation =
  | SetOperation
  | PatchOperation
  | DeleteOperation
  | SqliteOperation;

export interface ConfirmedRead {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchName;
  path: ReadPath;
  seq: number;
  /**
   * When true, this is a SHALLOW (shape-only) read — the reader observed the
   * container at `path` (its key set / existence) but did NOT depend on the deep
   * values of its descendants. The engine then conflicts only with writes
   * AT-OR-ABOVE `path` (including key add/remove, whose patch injects the parent
   * path), not with disjoint deep-value writes strictly below `path`. Strict
   * subset of the recursive overlap ⇒ never a false-negative. Absent/false ⇒
   * recursive read (the historical behavior).
   */
  nonRecursive?: boolean;
}

export interface PendingRead {
  id: EntityId;
  scope?: CellScope;
  path: ReadPath;
  localSeq: number;
  /** See {@link ConfirmedRead.nonRecursive}. */
  nonRecursive?: boolean;
}

export interface SchedulerObservationCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  schedulerObservation: unknown;
}

export type CommitPrecondition =
  | {
    kind: "origin-committed";
    /** localSeq of a commit from the SAME session in this space. */
    originLocalSeq: number;
  }
  | {
    kind: "entity-absent";
    id: EntityId;
    scope?: CellScope;
  }
  | {
    /** Security-critical exact value pin, including null for absent/deleted. */
    kind: "entity-value-hash";
    id: EntityId;
    scope?: CellScope;
    valueHash: string | null;
  };

export interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  preconditions?: CommitPrecondition[];
  schedulerObservation?: unknown;
  schedulerObservationBatch?: SchedulerObservationCommit[];
  codeCID?: Reference;
  branch?: BranchName;
  merge?: {
    sourceBranch: BranchName;
    sourceSeq: number;
    baseBranch: BranchName;
    baseSeq: number;
  };
}

export interface SessionOpenArgs {
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;
}

export interface SessionOpenCommand {
  cmd: "session.open";
  id: JobId;
  protocol: typeof MEMORY_PROTOCOL;
  args: SessionOpenArgs;
}

export interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: SessionOpenAuthMetadata;
}

export interface MemoryProtocolFlags {
  modernCellRep: boolean;
  persistentSchedulerState: boolean;
  /** Optional server-primary-execution-v1 control/feed protocol. */
  serverPrimaryExecutionV1: boolean;
  /** Client can honor computation claim routing (dark until W2.1). */
  serverPrimaryExecutionClaimRoutingV1: boolean;
  /** Client can keep async builtins passive for a claim (dark until W2.3). */
  serverPrimaryExecutionBuiltinPassivityV1: boolean;
  /**
   * Subcapability of claim routing (context-lattice C1.7): the client
   * understands context-scoped (`user:`/`session:`) execution claims and
   * routes them by chain compatibility. Sessions without it never receive a
   * scoped claim, and their attach fences any live user lane of the same
   * principal (the amendment-11 cohort gate). Absent parses to false.
   */
  serverPrimaryExecutionContextLatticeClaimsV1: boolean;
  /**
   * Subcapability (F3 feed protocol): the peer understands the additive `docs`
   * WatchSpec kind — server-membership doc-set watches whose members receive
   * per-wave point-read deltas rather than schema-graph re-traversal. Sessions
   * without it may never register a `docs` watch (the server rejects the kind).
   * Absent parses to false; layered above `serverPrimaryExecutionV1` (the base
   * feed capability). A mixed fleet stays valid — a non-negotiating peer keeps
   * its graph watches unchanged.
   */
  serverPrimaryExecutionDocSetWatchV1: boolean;
  /** Build-inherent support for authenticated scheduler writer lookup. */
  schedulerWriterLookup: boolean;
  commitPreconditions: boolean;
  /** Legacy CT-1775 draft capability: index-keyed per-frame schema table. */
  syncSchemaTable: boolean;
  /** Hash-keyed per-frame schema table. */
  syncSchemaTableV2: boolean;
  /**
   * Server capability (CFC Phase 3.c): commit-folded `sqlite` writes to
   * rule-bearing tables are re-derived through the shared row-label evaluator
   * against the committed rows, rolling back on violation (see
   * `v2/sqlite/commit-eval.ts`). The RUNNER keys its write-gate relaxation for
   * the non-attributable shapes (INSERT…SELECT, upsert, columnless INSERT,
   * rule-input UPDATE) on the SERVER advertising this — an old server that
   * never evaluates keeps a new runner failing closed. Inherent to the build
   * (not configuration), so a server of this version always advertises it.
   */
  sqliteCommitRowLabelEval: boolean;
}

/**
 * Wire-format flags object.
 */
export type WireMemoryProtocolFlags = {
  modernCellRep?: boolean;
  persistentSchedulerState?: boolean;
  serverPrimaryExecutionV1?: boolean;
  serverPrimaryExecutionClaimRoutingV1?: boolean;
  serverPrimaryExecutionBuiltinPassivityV1?: boolean;
  serverPrimaryExecutionContextLatticeClaimsV1?: boolean;
  serverPrimaryExecutionDocSetWatchV1?: boolean;
  schedulerWriterLookup?: boolean;
  commitPreconditions?: boolean;
  syncSchemaTable?: boolean;
  syncSchemaTableV2?: boolean;
  sqliteCommitRowLabelEval?: boolean;
};

export interface HelloMessage {
  type: "hello";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
}

export interface HelloOkMessage {
  type: "hello.ok";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
  sessionOpen?: SessionOpenAuthMetadata;
}

export interface SessionOpenChallenge {
  value: string;
  expiresAt: number;
}

export interface SessionOpenAuthMetadata {
  challenge: SessionOpenChallenge;
  audience: string;
}

export interface SessionDescriptor {
  sessionId?: SessionId;
  seenSeq?: number;
  executionFeedSeq?: number;
  sessionToken?: SessionToken;
}

export interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
  invocation?: Record<string, unknown>;
  authorization?: FabricValue;
}

export interface GraphQueryRoot {
  id: EntityId;
  scope?: CellScope;
  selector: SchemaPathSelector;
}

export interface GraphQuery {
  roots: GraphQueryRoot[];
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
}

export interface EntitySnapshot {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of this instance (C1.4b): lets the re-keyed Worker
   * replica attribute sync frames to lanes. Additive — absent from older
   * hosts; clients must not require it. */
  scopeKey?: string;
  seq: number;
  document: EntityDocument | null;
}

export interface GraphQueryResult {
  serverSeq: number;
  entities: EntitySnapshot[];
}

export interface QueryWatchSpec {
  id: string;
  kind: "query";
  query: GraphQuery;
}

export interface GraphWatchSpec {
  id: string;
  kind: "graph";
  query: GraphQuery;
}

/**
 * F3 doc-set watch kind (feed protocol): a session subscribes to an EXACT set
 * of documents addressed by DECLARED scope; the server maintains membership
 * and fans out per-wave point-read deltas for the members instead of
 * re-traversing a schema graph every commit wave. Additive beside `query` and
 * `graph`, negotiated via the absent-false `serverPrimaryExecutionDocSetWatchV1`
 * subcapability; a peer that never advertised it rejects the kind.
 *
 * FA2: membership is keyed server-side by the RESOLVED scope key, resolved at
 * registration under the session's scope context or the C1.4b-validated acting
 * lane — the addresses carry declared scope ONLY, exactly like graph-query
 * roots. A resolved `scopeKey` on a wire address is a protocol error (the wire
 * never carries resolved keys inbound).
 */
export interface DocSetWatchSpec {
  id: string;
  kind: "docs";
  branch?: BranchName;
  /** Declared-address members (id + declared scope). No resolved scope key. */
  docs: DocReadAddress[];
}

export type WatchSpec = QueryWatchSpec | GraphWatchSpec | DocSetWatchSpec;

export interface ActionClaimKey {
  branch: BranchName;
  space: string;
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
}

/** Canonical field projection shared by protocol, host, and runner maps. */
export const canonicalActionClaimKey = (
  claim: ActionClaimKey,
): ActionClaimKey => ({
  branch: claim.branch,
  space: claim.space,
  contextKey: claim.contextKey,
  pieceId: claim.pieceId,
  actionId: claim.actionId,
  actionKind: claim.actionKind,
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
});

/** Unambiguous branch/context-qualified key for one logical action. */
export const actionClaimMapKey = (claim: ActionClaimKey): string =>
  encodeMemoryBoundary(canonicalActionClaimKey(claim));

export interface ExecutionClaim extends ActionClaimKey {
  leaseGeneration: number;
  claimGeneration: number;
  /** Unix milliseconds assigned by the host clock. */
  expiresAt: number;
}

/** Unambiguous key for one exact lease + action claim incarnation. */
export const executionClaimIncarnationKey = (
  claim: ExecutionClaim,
): string =>
  encodeMemoryBoundary([
    canonicalActionClaimKey(claim),
    claim.leaseGeneration,
    claim.claimGeneration,
  ]);

/**
 * Transient executor assertion naming the exact live claim incarnation under
 * which one action attempt started. It is accepted only from a host-bound
 * executor session, checked against live control state, and stripped before
 * scheduler observations are persisted. It is not provenance by itself.
 */
export interface ExecutionClaimAssertion {
  contextKey: SchedulerExecutionContextKey;
  leaseGeneration: number;
  claimGeneration: number;
}

/**
 * Durable, single-owner authority for one server executor generation. The
 * record lives in the owning space database and is fenced by `branch` plus the
 * monotonically increasing `leaseGeneration`.
 */
export interface ExecutionLease {
  version: 1;
  space: string;
  branch: BranchName;
  leaseGeneration: number;
  hostId: string;
  onBehalfOf: string;
  state: "active" | "draining" | "revoked";
  /** Unix milliseconds assigned from the host-provided server clock. */
  expiresAt: number;
}

/**
 * Durable reservation for the legacy Background Piece Service. While live it
 * excludes client-sponsored execution leases for the same space/branch.
 */
export interface LegacyBackgroundExclusion {
  version: 1;
  space: string;
  branch: BranchName;
  exclusionGeneration: number;
  holderId: string;
  servicePrincipal: string;
  /** Unix milliseconds assigned from the server clock. */
  expiresAt: number;
}

export interface LegacyBackgroundExclusionStatus {
  exclusion: LegacyBackgroundExclusion;
  /** Server wall clock sampled with the authority transaction. */
  serverTime?: number;
  /** True only when no live client execution lease remains in the lane. */
  ready: boolean;
  /** Deadline of the draining client lease when `ready` is false. */
  blockedUntil?: number;
}

declare const inputBasisSeqBrand: unique symbol;
declare const acceptedCommitSeqBrand: unique symbol;

/** Maximum accepted input revision consumed by one action attempt. */
export type InputBasisSeq = number & {
  readonly [inputBasisSeqBrand]: "InputBasisSeq";
};

/** Semantic commit sequence assigned after canonical acceptance. */
export type AcceptedCommitSeq = number & {
  readonly [acceptedCommitSeqBrand]: "AcceptedCommitSeq";
};

export const toInputBasisSeq = (value: number): InputBasisSeq => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("input basis sequence must be a non-negative integer");
  }
  return value as InputBasisSeq;
};

export const toAcceptedCommitSeq = (value: number): AcceptedCommitSeq => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("accepted commit sequence must be a positive integer");
  }
  return value as AcceptedCommitSeq;
};

/**
 * Host-authored metadata for one accepted server action transaction.
 * `onBehalfOf` is execution authority, not semantic authorship. The host
 * derives it from the authenticated sponsor session and derives the basis from
 * the validated commit reads; Worker/client values are never authoritative.
 */
export interface ActionExecutionProvenance {
  claim: ActionClaimKey;
  onBehalfOf: string;
  leaseGeneration: number;
  claimGeneration: number;
  causedBy: number[];
  inputBasisSeq: InputBasisSeq;
}

export interface ExecutionClaimSetEvent {
  type: "session.execution.claim.set";
  claim: ExecutionClaim;
}

export interface ExecutionClaimRevokeEvent {
  type: "session.execution.claim.revoke";
  branch: BranchName;
  claim: ActionClaimKey;
  leaseGeneration: number;
  claimGeneration: number;
}

export type ActionSettlement =
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: InputBasisSeq;
    outcome: "committed";
    acceptedCommitSeq: AcceptedCommitSeq;
    diagnosticCode?: never;
  }
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: InputBasisSeq;
    outcome: "no-op" | "failed" | "unserved";
    acceptedCommitSeq?: never;
    diagnosticCode?: string;
  };

export interface ExecutionSettlementEvent {
  type: "session.execution.settlement";
  settlement: ActionSettlement;
}

export type ExecutionControlEvent =
  | ExecutionClaimSetEvent
  | ExecutionClaimRevokeEvent
  | ExecutionSettlementEvent;

export interface ExecutionClaimSnapshot {
  claims: ExecutionClaim[];
  /**
   * Successful settlement summaries newer than the reconnect cursor. The
   * server coalesces them by exact live claim incarnation so bounded event
   * retention cannot strand speculative overlays.
   */
  settlementFrontiers?: ExecutionSettlementFrontier[];
}

/**
 * Reconnect-only causal summary of successful settlements for one exact live
 * claim. `inputBasisSeq` is the strongest covered basis, while
 * `requiredAcceptedCommitSeq` preserves every committed data-application gate
 * contributing to the summary. `throughFeedSeq` is the newest summarized
 * successful control event.
 */
export interface ExecutionSettlementFrontier {
  branch: BranchName;
  claim: ExecutionClaim;
  inputBasisSeq: InputBasisSeq;
  throughFeedSeq: number;
  requiredAcceptedCommitSeq?: AcceptedCommitSeq;
}

export const actionSettlementFromFrontier = (
  frontier: ExecutionSettlementFrontier,
): ActionSettlement =>
  frontier.requiredAcceptedCommitSeq === undefined
    ? {
      branch: frontier.branch,
      claim: frontier.claim,
      inputBasisSeq: frontier.inputBasisSeq,
      outcome: "no-op",
    }
    : {
      branch: frontier.branch,
      claim: frontier.claim,
      inputBasisSeq: frontier.inputBasisSeq,
      outcome: "committed",
      acceptedCommitSeq: frontier.requiredAcceptedCommitSeq,
    };

export interface ExecutionFeedBatch {
  fromFeedSeq: number;
  toFeedSeq: number;
  snapshot?: ExecutionClaimSnapshot;
  events: ExecutionControlEvent[];
}

export interface SessionSyncUpsert {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of this instance (C1.4b, additive): per-lane sync
   * frame attribution for the re-keyed Worker replica. */
  scopeKey?: string;
  seq: number;
  doc?: EntityDocument;
  deleted?: true;
}

export interface SessionSyncRemove {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of the removed instance (F2, additive): removes must
   * address the same per-lane instance identity the upserts established —
   * a declared-scope remove must not evict another lane's instance. */
  scopeKey?: string;
}

export interface SessionSync {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  caughtUpLocalSeq?: number;
  upserts: SessionSyncUpsert[];
  removes: SessionSyncRemove[];
  // Scheduler observation rows for commits inside this sync's
  // (fromSeq, toSeq] window, so subscribers can ADOPT the writer's action
  // runs instead of re-running them
  // (docs/specs/scheduler-v2/incremental-observation-adoption.md §4).
  // Present only when both the server flag and the receiving connection's
  // negotiated persistentSchedulerState flag are on. Same row shape as the
  // scheduler.snapshot.list result; `observation` is intentionally
  // `unknown` — the runner owns validation.
  observations?: SchedulerActionSnapshotResult[];
  /** Ordered reconnectable server-execution control/data envelope. A
   * control-only batch leaves fromSeq/toSeq unchanged. */
  execution?: ExecutionFeedBatch;
}

export interface WatchSetResult {
  serverSeq: number;
  sync: SessionSync;
}

export interface WatchAddResult {
  serverSeq: number;
  sync: SessionSync;
}

export interface SessionAckResult {
  serverSeq: number;
}

/** Coarse v1 client-read demand. It is owned by the authenticated connection;
 * callers name only the branch and piece roots, never principal/connection or
 * sponsor authority. */
export interface ExecutionDemandSetRequest {
  type: "session.execution.demand.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  pieces: string[];
}

export interface ExecutionDemandSetResult {
  serverSeq: number;
  references: number;
}

export interface LegacyBackgroundExclusionAcquireRequest {
  type: "session.execution.legacy-background.acquire";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
}

export interface LegacyBackgroundExclusionRenewRequest {
  type: "session.execution.legacy-background.renew";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  exclusionGeneration: number;
}

export interface LegacyBackgroundExclusionReleaseRequest {
  type: "session.execution.legacy-background.release";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  exclusionGeneration: number;
}

export interface LegacyBackgroundExclusionStatusResult {
  serverSeq: number;
  status: LegacyBackgroundExclusionStatus | null;
}

export interface LegacyBackgroundExclusionReleaseResult {
  serverSeq: number;
  released: LegacyBackgroundExclusion | null;
}

export interface TransactRequest {
  type: "transact";
  requestId: string;
  space: string;
  sessionId: SessionId;
  commit: ClientCommit;
}

/** F2/FA5 (FB12) trigger attribution for graph.query accounting: `"wave"` =
 * a refresh forced by an accepted-commit wave (rehydrate/wake — closure
 * shrink, root re-establishment, resolution moves), `"demand"` = new data
 * demanded (first-demand cold pull, new-doc closure growth). The server
 * buckets `#recordFeedTraversal` accordingly, keeping the aggregate
 * "graph.query" bucket unchanged; the wave bucket is the F5 protocol's
 * F2-floor regression signal, which one undifferentiated bucket could not
 * attribute. */
export type GraphQueryTrigger = "wave" | "demand";

export interface GraphQueryRequest {
  type: "graph.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** C1.4b lane-scoped read seam: per-request acting context from a
   * lease-bound executor session, validated against the live lane grant
   * BEFORE any scope key resolves. Additive/optional — non-lane readers
   * never send it. */
  actingContext?: SchedulerExecutionContextKey;
  /** Optional trigger attribution (FA5/FB12): accounting only — never
   * affects evaluation, authorization, or the response shape. Callers that
   * predate the split omit it and land in the aggregate bucket alone. */
  trigger?: GraphQueryTrigger;
  query: GraphQuery;
}

/** Address of one exact document for a point read: declared scope only —
 * resolution to a scope key happens server-side under the request's acting
 * context, exactly like graph-query roots. */
export interface DocReadAddress {
  id: EntityId;
  scope?: CellScope;
}

/** F2 point-read batch: exact engine reads with NO schema/link traversal.
 * `atSeq` evaluates every doc at one sequence bound so a coalesced
 * accepted-commit wave reads from a single snapshot; absent means head. */
export interface DocsReadQuery {
  docs: DocReadAddress[];
  atSeq?: number;
  branch?: BranchName;
}

export interface DocsReadResult {
  serverSeq: number;
  /** One snapshot per addressed doc that has a stored revision (deleted docs
   * appear with `document: null`); never-written docs are omitted. */
  entities: EntitySnapshot[];
}

/** F2 executor-feed point reads (FA5): the replica-maintenance read that
 * replaces per-wave graph re-traversal for docs the reader already holds.
 * Carries the C1.4b `actingContext` seam from day one (FA6). */
export interface DocsReadRequest {
  type: "docs.read";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** See {@link GraphQueryRequest.actingContext}. */
  actingContext?: SchedulerExecutionContextKey;
  query: DocsReadQuery;
}

// --- SQLite builtins (docs/specs/sqlite-builtin) ---

/** Wire form of SQLite bind parameters. */
export type SqliteParamsWire = ReadonlyArray<unknown> | Record<string, unknown>;

/** Reference to a cell-derived SQLite database: an opaque id (the handle cell's
 *  entity id) plus the declared table schemas (for additive create/migrate).
 *
 *  `scope` is the SqliteDb cell's declared scope (space/user/session). The
 *  server folds it (with the request's principal / session id) into the on-disk
 *  filename so a `user`/`session`-scoped db gets a per-user / per-session file;
 *  `space` (or absent) keeps the original unqualified name. */
export interface SqliteDbRef {
  id: string;
  tables?: Record<string, unknown>;
  scope?: CellScope;
  /** The db's owner — the principal that created the SqliteDb cell. Resolves
   *  the per-row label rule's `dbOwner()` term (CFC Phase 3); a FIXED db
   *  property, captured once at handle creation, never the acting reader. */
  owner?: string;
}

export interface SqliteQueryRequest {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
}

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export interface SqliteResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

/** Whether a column's `ifc` annotation is present and non-empty — the single
 *  predicate for "this column participates in CFC labeling". Shared by the
 *  server's declares-ifc gate (which decides whether to capture column origins)
 *  and the runner's per-column label schema, so the two can't drift. */
export function columnDeclaresIfc(ifc: unknown): boolean {
  return !!ifc && typeof ifc === "object" && Object.keys(ifc).length > 0;
}

/** Whether a table schema carries a per-row label rule (CFC Phase 3). */
export function tableDeclaresRowLabel(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  const spec = (table as { rowLabel?: unknown }).rowLabel;
  return !!spec && typeof spec === "object";
}

/** Whether a read of this db needs sound per-result-column provenance for CFC
 *  labeling: any column declares `ifc` (Phase 2) OR any table declares a
 *  per-row label rule (Phase 3 — the rule's input columns are located by TRUE
 *  origin, never output name). The single gate shared by the server (capture
 *  origins) and the runner (expect them), so the two can't drift. Unlabeled
 *  dbs — the common case — return false and pay nothing. */
export function dbNeedsColumnProvenance(
  tables: Record<string, unknown> | undefined,
): boolean {
  if (tables === undefined) return false;
  for (const table of Object.values(tables)) {
    if (tableDeclaresRowLabel(table)) return true;
    const props = (table as { properties?: Record<string, unknown> })
      ?.properties;
    if (!props) continue;
    for (const col of Object.values(props)) {
      if (columnDeclaresIfc((col as { ifc?: unknown })?.ifc)) return true;
    }
  }
  return false;
}

export interface SqliteQueryResult {
  rows: unknown[];
  /** Per-result-column origin, present ONLY when the db needs provenance for
   *  CFC labeling — any column declares `ifc` (Phase 2) or any table declares
   *  a per-row label rule (Phase 3); see `dbNeedsColumnProvenance`. An aliased
   *  or joined column maps back to its declared `(table, column)`. Undefined
   *  otherwise, so unlabeled queries pay nothing. */
  columns?: SqliteResultColumn[];
}

// NOTE: there is no `sqlite.execute` write verb. Writes go through the commit
// fold (a `sqlite` op inside `transact`, applied atomically with cell ops by the
// engine) — never a standalone, non-atomic write RPC. See db.exec in the runner.

/**
 * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
 * link <piece> <field> sqlite:<absPath>` issues this so the server attaches the
 * given file (read-only) for the handle id instead of the cell-derived path. The
 * descriptor is server-side state — it is NOT written into the handle cell value.
 */
export interface SqliteRegisterDiskSourceRequest {
  type: "sqlite.register-disk-source";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** Handle cell id (content-derived from (serviceSpace, absPath); see cf). */
  id: string;
  /** Absolute path to the on-disk SQLite file. */
  path: string;
}

export interface SqliteRegisterDiskSourceResult {
  registered: true;
}

export interface WatchSetRequest {
  type: "session.watch.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** C1.4b lane-scoped read seam: per-request acting context from a
   * lease-bound executor session, validated against the live lane grant
   * BEFORE any scope key resolves. Additive/optional — non-lane readers
   * never send it. */
  actingContext?: SchedulerExecutionContextKey;
  watches: WatchSpec[];
}

export interface WatchAddRequest {
  type: "session.watch.add";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** C1.4b lane-scoped read seam: per-request acting context from a
   * lease-bound executor session, validated against the live lane grant
   * BEFORE any scope key resolves. Additive/optional — non-lane readers
   * never send it. */
  actingContext?: SchedulerExecutionContextKey;
  watches: WatchSpec[];
}

export interface SessionAckRequest {
  type: "session.ack";
  requestId: string;
  space: string;
  sessionId: SessionId;
  seenSeq: number;
  executionFeedSeq?: number;
}

export interface SchedulerActionSnapshotQuery {
  branch?: BranchName;
  ownerSpace?: string;
  pieceId?: string;
  processGeneration?: number;
  actionId?: string;
  // Commit-seq window (exclusive since, inclusive through): rows whose
  // carrying commit landed inside a subscription sync's (fromSeq, toSeq]
  // window — the incremental-adoption fan-out query. Rows with a NULL
  // commit seq never match a window filter.
  sinceCommitSeq?: number;
  throughCommitSeq?: number;
  limit?: number;
  cursor?: SchedulerActionSnapshotCursor;
}

/**
 * Server-derived ownership partition for durable scheduler state. The opaque
 * principal and session components use the same encoding as resolved memory
 * scope keys; clients must never construct one to select another context.
 */
export type SchedulerExecutionContextKey =
  | "space"
  | `user:${string}`
  | `session:${string}:${string}`;

/** Scope-key segment encoding shared by every canonical context-key helper.
 * Percent-encoding is what keeps colon-bearing DID segments unambiguous. */
const encodeScopeKeyPart = (value: string): string => encodeURIComponent(value);

/**
 * Canonical `user:<principal>` scope/execution-context key. The principal
 * segment is encodeURIComponent-encoded, so a colon-bearing did:key principal
 * never appears raw — naive `user:${did}` concatenation never matches a
 * canonical key. The single construction site for user-rank keys; parse with
 * `principalOfUserContextKey`. Lives in this dependency-light module (and is
 * re-exported by `v2/engine.ts`) so browser-side runner code can construct
 * canonical keys without the engine's SQLite dependency.
 */
export const userExecutionContextKey = (principal: string): `user:${string}` =>
  `user:${encodeScopeKeyPart(principal)}`;

/**
 * Principal segment of a canonical user context key per
 * `userExecutionContextKey`. Returns `undefined` for anything that is not a
 * well-formed user-rank key (wrong prefix, empty or raw-colon-bearing
 * segment, undecodable escape).
 */
export const principalOfUserContextKey = (key: string): string | undefined => {
  if (!key.startsWith("user:")) return undefined;
  const encodedPrincipal = key.slice("user:".length);
  if (encodedPrincipal.length === 0 || encodedPrincipal.includes(":")) {
    return undefined;
  }
  try {
    return decodeURIComponent(encodedPrincipal);
  } catch {
    return undefined;
  }
};

/**
 * Canonical `session:<principal>:<sessionId>` scope/execution-context key —
 * the same shape the engine derives for principal-bound sessions
 * (`resolveCommitSessionKey`) and `resolveScopeKey("session", …)`. The single
 * construction site clients use for their own-chain acceptance check
 * (context-lattice §2); both segments are percent-encoded, so colon-bearing
 * DIDs and session ids stay unambiguous.
 */
export const sessionExecutionContextKey = (
  principal: string,
  sessionId: string,
): `session:${string}:${string}` =>
  `session:${encodeScopeKeyPart(principal)}:${encodeScopeKeyPart(sessionId)}`;

/** Map a client demand root onto the durable scheduler's piece identity. The
 * first server-primary phase accepts raw entity ids and already-qualified ids,
 * but executes only the shared space partition. */
export const canonicalSchedulerPieceIdForDemandRoot = (
  root: string,
): string => {
  if (
    root.startsWith("space:") || root.startsWith("user:") ||
    root.startsWith("session:")
  ) {
    return root;
  }
  return `space:${root.startsWith("of:") ? root : `of:${root}`}`;
};

export interface SchedulerActionSnapshotCursor {
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
}

export interface SchedulerActionSnapshotResult {
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  executionContextKey: SchedulerExecutionContextKey;
  observation: unknown;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
}

export interface SchedulerSnapshotListResult {
  serverSeq: number;
  snapshots: SchedulerActionSnapshotResult[];
  nextCursor?: SchedulerActionSnapshotCursor;
}

export interface SchedulerSnapshotListRequest {
  type: "scheduler.snapshot.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** C1.4b lane-scoped read seam: per-request acting context from a
   * lease-bound executor session, validated against the live lane grant
   * BEFORE any scope key resolves. Additive/optional — non-lane readers
   * never send it. */
  actingContext?: SchedulerExecutionContextKey;
  query: SchedulerActionSnapshotQuery;
}

export interface SchedulerWriterTarget {
  id: EntityId;
  scope?: CellScope;
  path: DocumentPath;
}

export interface SchedulerWritersForTargetsQuery {
  branch?: BranchName;
  targets: SchedulerWriterTarget[];
}

export type SchedulerWriterMatchKind =
  | "current-known"
  | "declared"
  | "materializer";

export interface SchedulerResolvedWriterAddress {
  space: string;
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  path: DocumentPath;
}

export interface SchedulerWriterMatch {
  kind: SchedulerWriterMatchKind;
  write: SchedulerResolvedWriterAddress;
}

export interface SchedulerWriterCandidate {
  branch: BranchName;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
  status: "success" | "failed";
  errorFingerprint?: string;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
  matchedWrites: SchedulerWriterMatch[];
}

export interface SchedulerWritersForTargetsResult {
  serverSeq: number;
  writers: SchedulerWriterCandidate[];
}

export interface SchedulerWriterListRequest {
  type: "scheduler.writer.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** C1.4b lane-scoped read seam: per-request acting context from a
   * lease-bound executor session, validated against the live lane grant
   * BEFORE any scope key resolves. Additive/optional — non-lane readers
   * never send it. */
  actingContext?: SchedulerExecutionContextKey;
  query: SchedulerWritersForTargetsQuery;
}

export interface ResponseMessage<Result> {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
}

export interface SessionEffectMessage {
  type: "session/effect";
  space: string;
  sessionId: SessionId;
  effect: SessionSync;
}

export interface SessionRevokedMessage {
  type: "session/revoked";
  space: string;
  sessionId: SessionId;
  reason: "taken-over" | "unauthorized";
}

export interface V2Error {
  name: string;
  message: string;
  precondition?: string;
  retryAfterSeq?: number;
  /** Stable reason attached to a rejected server-execution action attempt. */
  diagnosticCode?: string;
}

export type V2Result<Value> = { ok: Value } | { error: V2Error };

export interface TaskReturn<Result> {
  the: "task/return";
  of: JobId;
  is: Result;
}

export type Receipt<Result> = TaskReturn<Result>;
export type LegacyClientMessage = SessionOpenCommand;
export type LegacyServerMessage = TaskReturn<V2Result<unknown>>;
export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | DocsReadRequest
  | SqliteQueryRequest
  | SqliteRegisterDiskSourceRequest
  | WatchSetRequest
  | WatchAddRequest
  | SchedulerSnapshotListRequest
  | SchedulerWriterListRequest
  | ExecutionDemandSetRequest
  | LegacyBackgroundExclusionAcquireRequest
  | LegacyBackgroundExclusionRenewRequest
  | LegacyBackgroundExclusionReleaseRequest
  | SessionAckRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<unknown>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction at the memory boundary",
);

// These ambient flags and the memory protocol flags below are catalogued, with
// their defaults and removal paths, in docs/development/EXPERIMENTAL_OPTIONS.md.
// Update that registry when adding or removing one.
let persistentSchedulerStateEnabled = true;
let commitPreconditionsEnabled = true;
let syncSchemaTableEnabled = true;
let serverPrimaryExecutionEnabled = false;
let serverPrimaryExecutionClaimRank: ServerPrimaryExecutionClaimRank = "space";
let serverPrimaryExecutionContextLatticeClaimsEnabled = false;
let serverPrimaryExecutionDocSetWatchEnabled = false;
let serverPrimaryExecutionGraphRetirementSpaces: ReadonlySet<string> =
  new Set();

/**
 * Ambient runtime flag for persistent scheduler observations and rehydration.
 * The runner owns the feature, but the memory protocol needs the value during
 * client/server handshakes, so it lives beside the memory protocol flags.
 */
export function setPersistentSchedulerStateConfig(enabled?: boolean): void {
  persistentSchedulerStateEnabled = enabled ?? true;
}

export function getPersistentSchedulerStateConfig(): boolean {
  return persistentSchedulerStateEnabled;
}

export function resetPersistentSchedulerStateConfig(): void {
  persistentSchedulerStateEnabled = true;
}

/**
 * Ambient runtime flag for the server-primary execution protocol. The
 * capability is optional and defaults off; when enabled, compatible peers
 * use server-primary authority for every eligible claimed action.
 */
export function setServerPrimaryExecutionConfig(enabled?: boolean): void {
  serverPrimaryExecutionEnabled = enabled ?? false;
}

export function getServerPrimaryExecutionConfig(): boolean {
  return serverPrimaryExecutionEnabled;
}

export function resetServerPrimaryExecutionConfig(): void {
  serverPrimaryExecutionEnabled = false;
}

/**
 * Highest context rank the host ISSUES execution claims for (context-lattice
 * design §6: one internal dial, staged space → user → session → cross-space).
 * Issuance-side only — never negotiated on the wire; the engine's commit-time
 * guards stay rank-independent. The default admits only the shared space
 * lane; C1 work enables `user` inside its gate fixtures. Registered in
 * docs/development/EXPERIMENTAL_OPTIONS.md as `serverPrimaryExecutionClaimRank`.
 */
export type ServerPrimaryExecutionClaimRank = "space" | "user";

export function setServerPrimaryExecutionClaimRankConfig(
  rank?: ServerPrimaryExecutionClaimRank,
): void {
  serverPrimaryExecutionClaimRank = rank ?? "space";
}

export function getServerPrimaryExecutionClaimRankConfig(): ServerPrimaryExecutionClaimRank {
  return serverPrimaryExecutionClaimRank;
}

export function resetServerPrimaryExecutionClaimRankConfig(): void {
  serverPrimaryExecutionClaimRank = "space";
}

/**
 * Ambient runtime flag for the context-lattice-claims-v1 subcapability
 * (context-lattice C1.7): whether this server ADVERTISES context-scoped
 * claim delivery. Defaults off; a mixed fleet stays valid either way — the
 * amendment-11 cohort gate fences user lanes around sessions that did not
 * negotiate it rather than rejecting them. Registered in
 * docs/development/EXPERIMENTAL_OPTIONS.md as
 * `serverPrimaryExecutionContextLatticeClaimsV1`.
 */
export function setServerPrimaryExecutionContextLatticeClaimsConfig(
  enabled?: boolean,
): void {
  serverPrimaryExecutionContextLatticeClaimsEnabled = enabled ?? false;
}

export function getServerPrimaryExecutionContextLatticeClaimsConfig(): boolean {
  return serverPrimaryExecutionContextLatticeClaimsEnabled;
}

export function resetServerPrimaryExecutionContextLatticeClaimsConfig(): void {
  serverPrimaryExecutionContextLatticeClaimsEnabled = false;
}

/**
 * Ambient runtime flag for the F3 doc-set watch subcapability: whether this
 * server ADVERTISES the additive `docs` WatchSpec kind. Defaults off; a mixed
 * fleet stays valid either way — a non-negotiating peer keeps its graph
 * watches. Registered in docs/development/EXPERIMENTAL_OPTIONS.md as
 * `serverPrimaryExecutionDocSetWatchV1`.
 */
export function setServerPrimaryExecutionDocSetWatchConfig(
  enabled?: boolean,
): void {
  serverPrimaryExecutionDocSetWatchEnabled = enabled ?? false;
}

export function getServerPrimaryExecutionDocSetWatchConfig(): boolean {
  return serverPrimaryExecutionDocSetWatchEnabled;
}

export function resetServerPrimaryExecutionDocSetWatchConfig(): void {
  serverPrimaryExecutionDocSetWatchEnabled = false;
}

/**
 * Per-space rollout dial for F5 graph-refresh retirement (server-side
 * execution F5 / FA13, redesigned by the feed repair wave FW5 after FB9).
 * Host-internal, never negotiated on the wire.
 *
 * Its behavioral authority is DOC-SET ADMISSION: a `docs`-kind watch is
 * accepted only for spaces this dial names (`"*"` admits every space), and a
 * withheld space's registration is rejected with the same clean ProtocolError
 * a non-negotiating server gives — the runner's reconcile catches it, keeps
 * its subscribing schema-graph watches, and the space genuinely stays on
 * graph behavior (the OQ4 per-space rollout property). The retirement itself
 * stays a live per-surface check in the refresh loop (doc-set subcapability
 * negotiated ∧ admitted members present ∧ zero residual graph watches),
 * failing open to graph traversal and counted per watch when a surface
 * regresses; the dial is deliberately NOT re-consulted there, so shrinking it
 * never hides an already-admitted surface from the regression gauges.
 * Shrinking the dial takes effect for NEW registrations only — a live demoted
 * session keeps its admitted surface until it re-registers.
 *
 * The default is the empty set (absent-false — no space is admitted, so no
 * space demotes and none retires), and an operator adds a space only once
 * F1's per-space coverage evidence clears the OQ4 rollout gate. Deployments
 * flip it via `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES`
 * (comma-separated space DIDs, or `*`), applied at server construction via
 * {@link applyServerPrimaryExecutionGraphRetirementEnvConfig}. Registered in
 * docs/development/EXPERIMENTAL_OPTIONS.md as
 * `serverPrimaryExecutionGraphRetirement`.
 */
export function setServerPrimaryExecutionGraphRetirementConfig(
  spaces?: Iterable<string>,
): void {
  serverPrimaryExecutionGraphRetirementSpaces = spaces === undefined
    ? new Set()
    : new Set(spaces);
}

export function getServerPrimaryExecutionGraphRetirementConfig(): ReadonlySet<
  string
> {
  return serverPrimaryExecutionGraphRetirementSpaces;
}

export function resetServerPrimaryExecutionGraphRetirementConfig(): void {
  serverPrimaryExecutionGraphRetirementSpaces = new Set();
}

/** Whether the F5 rollout dial admits `space` to the doc-set watch surface.
 * `"*"` is the operator wildcard for "every space". */
export function serverPrimaryExecutionGraphRetirementAdmits(
  space: string,
): boolean {
  return serverPrimaryExecutionGraphRetirementSpaces.has("*") ||
    serverPrimaryExecutionGraphRetirementSpaces.has(space);
}

/** Environment variable consulted by
 * {@link applyServerPrimaryExecutionGraphRetirementEnvConfig}: comma-separated
 * space DIDs, or `*` for every space. Unset leaves the dial at its current
 * (default: empty) value. */
export const SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES";

/**
 * Apply the F5 rollout dial from the environment (FW5, FB10): hosts that
 * construct a memory server (toolshed, the standalone server) call this at
 * construction so the W2.9 measurement protocol is executable against a real
 * deployment instead of requiring an in-process call site. The parser lives
 * here — next to the dial it feeds — so every host wires the same one line
 * and the parse rules cannot drift between hosts.
 */
export function applyServerPrimaryExecutionGraphRetirementEnvConfig(
  readEnv: (name: string) => string | undefined,
): void {
  const raw = readEnv(SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES_ENV);
  if (raw === undefined) return;
  setServerPrimaryExecutionGraphRetirementConfig(
    raw
      .split(",")
      .map((space) => space.trim())
      .filter((space) => space.length > 0),
  );
}

/**
 * Ambient runtime flag for commit preconditions. The runner owns the feature,
 * but the memory protocol needs the value during client/server handshakes.
 */
export function setCommitPreconditionsConfig(enabled?: boolean): void {
  commitPreconditionsEnabled = enabled ?? true;
}

export function getCommitPreconditionsConfig(): boolean {
  return commitPreconditionsEnabled;
}

export function resetCommitPreconditionsConfig(): void {
  commitPreconditionsEnabled = true;
}

/**
 * Ambient protocol capability for hash-keyed frame-local schema tables in sync
 * payloads. This is a wire-size optimization only; peers that do not advertise
 * the v2 capability keep receiving the historical fully-expanded `SessionSync`
 * shape.
 */
export function setSyncSchemaTableConfig(enabled?: boolean): void {
  syncSchemaTableEnabled = enabled ?? true;
}

export function getSyncSchemaTableConfig(): boolean {
  return syncSchemaTableEnabled;
}

export function resetSyncSchemaTableConfig(): void {
  syncSchemaTableEnabled = true;
}

export const getMemoryProtocolFlags = (): MemoryProtocolFlags => ({
  modernCellRep: getModernCellRepConfig(),
  persistentSchedulerState: getPersistentSchedulerStateConfig(),
  serverPrimaryExecutionV1: getServerPrimaryExecutionConfig(),
  serverPrimaryExecutionClaimRoutingV1: getServerPrimaryExecutionConfig(),
  serverPrimaryExecutionBuiltinPassivityV1: getServerPrimaryExecutionConfig(),
  // Layered subcapability: meaningful only above claim routing (the
  // connection getter chain enforces the layering); its own dial defaults
  // off so enabling server-primary execution alone never turns it on.
  serverPrimaryExecutionContextLatticeClaimsV1:
    getServerPrimaryExecutionConfig() &&
    getServerPrimaryExecutionContextLatticeClaimsConfig(),
  // Layered subcapability of the base feed capability: its own dial defaults
  // off, so enabling server-primary execution alone never turns it on.
  serverPrimaryExecutionDocSetWatchV1: getServerPrimaryExecutionConfig() &&
    getServerPrimaryExecutionDocSetWatchConfig(),
  // Build-inherent capability: older servers omit it and clients fail open to
  // piece-root discovery rather than sending an RPC the peer cannot parse.
  schedulerWriterLookup: true,
  commitPreconditions: getCommitPreconditionsConfig(),
  syncSchemaTable: false,
  // A build-inherent capability, not configuration: this build's engine always
  // evaluates row-label rules at commit (sqlite/commit-eval.ts), so it always
  // advertises the fact. Peers that see it absent (an older server) keep their
  // write gate failing closed.
  sqliteCommitRowLabelEval: true,
  syncSchemaTableV2: getSyncSchemaTableConfig(),
});

/**
 * Scheduler-state persistence and commit preconditions are optional
 * capabilities, not data-model wire contracts. Peers with different scheduler
 * flags can still share memory data; the server's flags control whether
 * scheduler rows and precondition checks are accepted on that connection.
 */
export const compatibleMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean => left.modernCellRep === right.modernCellRep;

/**
 * Parses and normalizes incoming wire-protocol flags. Returns `null` if the
 * input is not a recognizable flags object.
 */
export const parseMemoryProtocolFlags = (
  value: unknown,
): MemoryProtocolFlags | null => {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }

  const persistentSchedulerState = value.persistentSchedulerState;
  if (
    persistentSchedulerState !== undefined &&
    typeof persistentSchedulerState !== "boolean"
  ) {
    return null;
  }

  const schedulerWriterLookup = value.schedulerWriterLookup;
  if (
    schedulerWriterLookup !== undefined &&
    typeof schedulerWriterLookup !== "boolean"
  ) {
    return null;
  }

  const serverPrimaryExecutionV1 = value.serverPrimaryExecutionV1;
  if (
    serverPrimaryExecutionV1 !== undefined &&
    typeof serverPrimaryExecutionV1 !== "boolean"
  ) {
    return null;
  }

  const serverPrimaryExecutionClaimRoutingV1 =
    value.serverPrimaryExecutionClaimRoutingV1;
  if (
    serverPrimaryExecutionClaimRoutingV1 !== undefined &&
    typeof serverPrimaryExecutionClaimRoutingV1 !== "boolean"
  ) {
    return null;
  }

  const serverPrimaryExecutionBuiltinPassivityV1 =
    value.serverPrimaryExecutionBuiltinPassivityV1;
  if (
    serverPrimaryExecutionBuiltinPassivityV1 !== undefined &&
    typeof serverPrimaryExecutionBuiltinPassivityV1 !== "boolean"
  ) {
    return null;
  }

  const serverPrimaryExecutionContextLatticeClaimsV1 =
    value.serverPrimaryExecutionContextLatticeClaimsV1;
  if (
    serverPrimaryExecutionContextLatticeClaimsV1 !== undefined &&
    typeof serverPrimaryExecutionContextLatticeClaimsV1 !== "boolean"
  ) {
    return null;
  }

  const serverPrimaryExecutionDocSetWatchV1 =
    value.serverPrimaryExecutionDocSetWatchV1;
  if (
    serverPrimaryExecutionDocSetWatchV1 !== undefined &&
    typeof serverPrimaryExecutionDocSetWatchV1 !== "boolean"
  ) {
    return null;
  }

  const commitPreconditions = value.commitPreconditions;
  if (
    commitPreconditions !== undefined &&
    typeof commitPreconditions !== "boolean"
  ) {
    return null;
  }

  const modernCellRep = value.modernCellRep;
  if (
    modernCellRep !== undefined &&
    typeof modernCellRep !== "boolean"
  ) {
    return null;
  }

  const syncSchemaTable = value.syncSchemaTable;
  if (
    syncSchemaTable !== undefined &&
    typeof syncSchemaTable !== "boolean"
  ) {
    return null;
  }

  const syncSchemaTableV2 = value.syncSchemaTableV2;
  if (
    syncSchemaTableV2 !== undefined &&
    typeof syncSchemaTableV2 !== "boolean"
  ) {
    return null;
  }

  const sqliteCommitRowLabelEval = value.sqliteCommitRowLabelEval;
  if (
    sqliteCommitRowLabelEval !== undefined &&
    typeof sqliteCommitRowLabelEval !== "boolean"
  ) {
    return null;
  }

  return {
    modernCellRep: modernCellRep === true,
    persistentSchedulerState: persistentSchedulerState === true,
    serverPrimaryExecutionV1: serverPrimaryExecutionV1 === true,
    serverPrimaryExecutionClaimRoutingV1:
      serverPrimaryExecutionClaimRoutingV1 === true,
    serverPrimaryExecutionBuiltinPassivityV1:
      serverPrimaryExecutionBuiltinPassivityV1 === true,
    // Absent-false: an older peer that never heard of context-scoped claims
    // must never be treated as accepting them.
    serverPrimaryExecutionContextLatticeClaimsV1:
      serverPrimaryExecutionContextLatticeClaimsV1 === true,
    // Absent-false: an older peer that never heard of doc-set watches must
    // never be treated as accepting the `docs` kind.
    serverPrimaryExecutionDocSetWatchV1:
      serverPrimaryExecutionDocSetWatchV1 === true,
    schedulerWriterLookup: schedulerWriterLookup === true,
    commitPreconditions: commitPreconditions === true,
    syncSchemaTable: syncSchemaTable === true,
    syncSchemaTableV2: syncSchemaTableV2 === true,
    // Absent (an older peer) parses to false: the capability must be
    // POSITIVELY advertised for the runner to relax its write gate.
    sqliteCommitRowLabelEval: sqliteCommitRowLabelEval === true,
  };
};

/**
 * Builds the wire-format flags object for a `hello`/`hello.ok` message.
 */
export const wireMemoryProtocolFlags = (
  flags: MemoryProtocolFlags,
): WireMemoryProtocolFlags => ({
  modernCellRep: flags.modernCellRep,
  persistentSchedulerState: flags.persistentSchedulerState,
  serverPrimaryExecutionV1: flags.serverPrimaryExecutionV1,
  serverPrimaryExecutionClaimRoutingV1:
    flags.serverPrimaryExecutionClaimRoutingV1,
  serverPrimaryExecutionBuiltinPassivityV1:
    flags.serverPrimaryExecutionBuiltinPassivityV1,
  serverPrimaryExecutionContextLatticeClaimsV1:
    flags.serverPrimaryExecutionContextLatticeClaimsV1,
  serverPrimaryExecutionDocSetWatchV1:
    flags.serverPrimaryExecutionDocSetWatchV1,
  schedulerWriterLookup: flags.schedulerWriterLookup,
  commitPreconditions: flags.commitPreconditions,
  syncSchemaTable: flags.syncSchemaTable,
  syncSchemaTableV2: flags.syncSchemaTableV2,
  sqliteCommitRowLabelEval: flags.sqliteCommitRowLabelEval,
});

export const encodeMemoryBoundary = (value: FabricValue): string =>
  jsonFromValue(value);

export const commitPreconditionValueHash = (value: FabricValue): string =>
  hashStringOf(encodeMemoryBoundary(value));

export const decodeMemoryBoundary = <Value extends FabricValue = FabricValue>(
  source: string,
): Value & FabricValue => {
  const decoded = valueFromJson(
    source,
    memoryReconstructionContext,
  );

  return decoded as Value;
};

export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;

export const toValuePath = (path: readonly string[]): ValuePath =>
  path as ValuePath;

/**
 * Builds a document-level selector (path rooted under `"value"`) from a schema
 * path selector. The result is interned-and-frozen via `internPathSelector()`,
 * to get the benefits of hash caching.
 */
export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector =>
  internPathSelector({
    ...selector,
    path: toDocumentPath(["value", ...selector.path]),
  }) as DocumentSchemaPathSelector;

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isObject(value);

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, FabricValue> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};
