import {
  type EntityRef,
  getModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type {
  FabricPlainObject,
  FabricValue,
  SchemaPathSelector,
} from "@commonfabric/api";
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
export type EntityDocument = {
  value?: FabricValue;
  source?: EntityRef;
  [key: string]: FabricValue;
};

export type Blob = {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
};

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

export type SetOperation = {
  op: "set";
  id: EntityId;
  scope?: CellScope;
  value: EntityDocument;
};

export type PatchOperation = {
  op: "patch";
  id: EntityId;
  scope?: CellScope;
  patches: PatchOp[];
};

export type DeleteOperation = {
  op: "delete";
  id: EntityId;
  scope?: CellScope;
};

/**
 * A SQLite write folded into the commit, applied inside the same transaction as
 * the cell ops (atomic). It is NOT an entity revision — it has no `id` and never
 * enters the revision/head/snapshot/dirty machinery (see SqliteDbRef below /
 * docs/specs/sqlite-builtin/plans/atomic-writes.md).
 */
export type SqliteOperation = {
  op: "sqlite";
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
};

export type Operation =
  | SetOperation
  | PatchOperation
  | DeleteOperation
  | SqliteOperation;

export type ConfirmedRead = {
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
};

export type PendingRead = {
  id: EntityId;
  scope?: CellScope;
  path: ReadPath;
  /**
   * The reader's pending-stack dependency set for this document. An array
   * lists EVERY pending layer the read's materialized view sat on; each
   * element must have resolved to an accepted commit for this commit to be
   * applicable, and the staleness (conflict) check runs exactly once, from
   * the basis the server selects (03-commit-model.md §3.6.3): the declared
   * `basisSeq` when present, else the resolution of the HIGHEST element —
   * the document's top-of-stack layer below the reader, which the array
   * MUST include. A scalar is the degenerate single-layer form (also what
   * pre-`pendingReadStacks` peers emit: top-of-stack only, carrying no
   * lower-layer dependencies).
   */
  localSeq: number | number[];
  /**
   * The reader's confirmed basis for THIS document, in the SERVER's
   * space-log seq space (an accepted-commit `seq`, NOT the session's
   * localSeq space): the seq of the last accepted write to this document
   * that the client's confirmed view reflected at build time, or 0 for a
   * document its subscriptions never covered.
   *
   * When present, the staleness scan covers the FULL interval
   * `(basisSeq, head]`, excluding only the session's own TRUE PREDECESSOR
   * commits — those with a localSeq below the reader's, the accepted layers
   * its materialized view included. An own write with a higher localSeq
   * accepted first (out-of-order submission) conflicts like a foreign
   * write, so soundness does not depend on wire-order discipline. This is
   * the CT-1910 repair
   * (`PendingStacks_Repaired.cfg` certifies it); when absent (a legacy
   * client), staleness is based at the HIGHEST dependency's resolution seq,
   * whose known unsoundness is recorded against INV-1 in
   * docs/specs/memory-v2/09-invariants.md.
   */
  basisSeq?: number;
  /** See {@link ConfirmedRead.nonRecursive}. */
  nonRecursive?: boolean;
};

export type SchedulerObservationCommit = {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  /** The observation, opaque here: this layer stores and forwards it, and
   *  the runner owns its shape and validation. `FabricValue` says only what
   *  the wire requires of it. */
  schedulerObservation: FabricValue;
};

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

export type ClientCommit = {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  preconditions?: CommitPrecondition[];
  /** The observation, opaque here: this layer stores and forwards it, and
   *  the runner owns its shape and validation. `FabricValue` says only what
   *  the wire requires of it. */
  schedulerObservation?: FabricValue;
  schedulerObservationBatch?: SchedulerObservationCommit[];
  codeCID?: Reference;
  branch?: BranchName;
  merge?: {
    sourceBranch: BranchName;
    sourceSeq: number;
    baseBranch: BranchName;
    baseSeq: number;
  };
};

export type SessionOpenArgs = {
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;
};

export type SessionOpenCommand = {
  cmd: "session.open";
  id: JobId;
  protocol: typeof MEMORY_PROTOCOL;
  args: SessionOpenArgs;
};

export type SessionOpenResult = {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: SessionOpenAuthMetadata;
};

export type MemoryProtocolFlags = {
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
   * Subcapability of claim routing (C3.6b, `cross-space-claims-v1`): the
   * client understands execution claims whose action reads FOREIGN spaces and
   * suppresses its own local run of such an action, deferring the
   * foreign-read derivation to the host's claimed commit. Sessions without it
   * never receive a cross-space-read-capable claim, and their attach fences
   * any live cross-space-read claim of the same delivery cohort (the A11
   * cohort gate, mirroring context-lattice-claims-v1). Absent parses to
   * false; layered above claim routing — a connection that cannot route space
   * claims can never route cross-space ones. A mixed fleet stays valid.
   */
  serverPrimaryExecutionCrossSpaceClaimsV1: boolean;
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
  /**
   * Server capability (CT-1872 1c): pending reads may carry an ARRAY
   * `localSeq` naming every pending layer the read sat on (resolution
   * required for each element; staleness based at the highest — see
   * `PendingRead.localSeq`). A client that sees this absent (an older
   * server) falls back to scalar top-of-stack emission, and MUST hold each
   * such send until every omitted lower dependency has settled — otherwise
   * the old server could durably accept a commit the client cascade-rejects
   * (03-commit-model.md §3.5). Inherent to the build, so a server of this
   * version always advertises it.
   */
  pendingReadStacks: boolean;
  /** The server can list live space-scoped entity identifiers without values. */
  entityIdListing: boolean;
  /** The server can page one stable entity-identifier snapshot. */
  entityIdPagination: boolean;
  /** The server can test one entity identifier without loading its value. */
  entityIdLookup: boolean;
};

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
  serverPrimaryExecutionCrossSpaceClaimsV1?: boolean;
  serverPrimaryExecutionDocSetWatchV1?: boolean;
  schedulerWriterLookup?: boolean;
  commitPreconditions?: boolean;
  syncSchemaTable?: boolean;
  syncSchemaTableV2?: boolean;
  sqliteCommitRowLabelEval?: boolean;
  pendingReadStacks?: boolean;
  entityIdListing?: boolean;
  entityIdPagination?: boolean;
  entityIdLookup?: boolean;
};

export type HelloMessage = {
  type: "hello";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
};

export type HelloOkMessage = {
  type: "hello.ok";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
  sessionOpen?: SessionOpenAuthMetadata;
};

export type SessionOpenChallenge = {
  value: string;
  expiresAt: number;
};

export type SessionOpenAuthMetadata = {
  challenge: SessionOpenChallenge;
  audience: string;
};

export type SessionDescriptor = {
  sessionId?: SessionId;
  seenSeq?: number;
  executionFeedSeq?: number;
  sessionToken?: SessionToken;
};

export type SessionOpenRequest = {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
  invocation?: Record<string, unknown>;
  authorization?: FabricValue;
};

export type GraphQueryRoot = {
  id: EntityId;
  scope?: CellScope;
  selector: SchemaPathSelector;
};

export type GraphQuery = {
  roots: GraphQueryRoot[];
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
};

export type EntitySnapshot = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of this instance (C1.4b): lets the re-keyed Worker
   * replica attribute sync frames to lanes. Additive — absent from older
   * hosts; clients must not require it. */
  scopeKey?: string;
  seq: number;
  document: EntityDocument | null;
};

export type GraphQueryResult = {
  serverSeq: number;
  entities: EntitySnapshot[];
};

export type EntityIdListResult = {
  serverSeq: number;
  ids: EntityId[];
  nextAfter?: EntityId;
};

/** Maximum number of entity identifiers carried by one protocol response. */
export const MAX_ENTITY_ID_PAGE_SIZE = 1_000;

export type EntityIdListOptions = {
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupResult = {
  serverSeq: number;
  exists: boolean;
};

export type QueryWatchSpec = {
  id: string;
  kind: "query";
  query: GraphQuery;
};

export type GraphWatchSpec = {
  id: string;
  kind: "graph";
  query: GraphQuery;
};

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
export type DocSetWatchSpec = {
  id: string;
  kind: "docs";
  branch?: BranchName;
  /** Declared-address members (id + declared scope). No resolved scope key. */
  docs: DocReadAddress[];
};

export type WatchSpec = QueryWatchSpec | GraphWatchSpec | DocSetWatchSpec;

export type ActionClaimKey = {
  branch: BranchName;
  space: string;
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
};

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

export type ExecutionClaim = ActionClaimKey & {
  leaseGeneration: number;
  claimGeneration: number;
  /** Unix milliseconds assigned by the host clock. */
  expiresAt: number;
  /**
   * C3.6: the FOREIGN spaces this claim's action reads under the
   * cross-space-read stage — host-authored at issuance from the candidate's
   * discovered foreign-read surface, after the issuance preflight bound the
   * acting principal's READ on each (see the server's `#setExecutionClaim`).
   * Deliberately NOT part of {@link canonicalActionClaimKey}: it is an
   * issuance property, never a component of the client/server shared action
   * identity, so the claim's map key and every equality/chain comparison stay
   * byte-identical. A present, non-empty value marks the claim
   * cross-space-read-capable — the single signal the C3.6b delivery gate
   * (`#sessionAcceptsClaim`) narrows on. Absent (the overwhelming default)
   * keeps the claim identical to a pre-C3.6 one.
   */
  crossSpaceReadSpaces?: readonly string[];
};

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
export type ExecutionClaimAssertion = {
  contextKey: SchedulerExecutionContextKey;
  leaseGeneration: number;
  claimGeneration: number;
};

/**
 * Durable, single-owner authority for one server executor generation. The
 * record lives in the owning space database and is fenced by `branch` plus the
 * monotonically increasing `leaseGeneration`.
 */
export type ExecutionLease = {
  version: 1;
  space: string;
  branch: BranchName;
  leaseGeneration: number;
  hostId: string;
  onBehalfOf: string;
  state: "active" | "draining" | "revoked";
  /** Unix milliseconds assigned from the host-provided server clock. */
  expiresAt: number;
};

/**
 * Durable reservation for the legacy Background Piece Service. While live it
 * excludes client-sponsored execution leases for the same space/branch.
 */
export type LegacyBackgroundExclusion = {
  version: 1;
  space: string;
  branch: BranchName;
  exclusionGeneration: number;
  holderId: string;
  servicePrincipal: string;
  /** Unix milliseconds assigned from the server clock. */
  expiresAt: number;
};

export type LegacyBackgroundExclusionStatus = {
  exclusion: LegacyBackgroundExclusion;
  /** Server wall clock sampled with the authority transaction. */
  serverTime?: number;
  /** True only when no live client execution lease remains in the lane. */
  ready: boolean;
  /** Deadline of the draining client lease when `ready` is false. */
  blockedUntil?: number;
};

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
 * C3.5: one per-space component of the vector input basis. `seq` is in the
 * NAMED space's seq domain — components are never comparable across spaces,
 * and a component for the settlement's own (home) space always equals the
 * scalar `inputBasisSeq` by construction.
 *
 * Coverage relation (C3A15, pinned once for every consumer): a settlement or
 * frontier with NO component for a space vacuously covers nothing and drops
 * nothing for that space — absent is never zero and never satisfied; a
 * present-but-older component never covers. Merges therefore UNION components
 * and take the per-component maximum ({@link mergeInputBasisVectors}).
 */
export type InputBasisComponent = {
  space: string;
  seq: InputBasisSeq;
};

/**
 * C3.5: a provenance basis component — the settlement component plus the
 * C3.4 read-time authorization-epoch stamp for foreign spaces (the value
 * stamped by the read host in the same synchronous section as the document
 * read; C3.8's apply fence re-validates it by EQUALITY, dated 2026-07-18).
 * The home component carries no stamp — home authority is fenced by the
 * lease/claim machinery, not epochs. When one attempt consumed several
 * stamped reads of one space, `seq` is their maximum (the covering frontier)
 * and `epoch` the MINIMUM stamped epoch, so C3.8's equality check fails if
 * ANY consumed read predates an authorization change.
 */
export type ProvenanceInputBasisComponent = InputBasisComponent & {
  authorizationEpoch?: { principal: string; epoch: number };
};

/**
 * Host-authored metadata for one accepted server action transaction.
 * `onBehalfOf` is execution authority, not semantic authorship. The host
 * derives it from the authenticated sponsor session and derives the basis from
 * the validated commit reads; Worker/client values are never authoritative.
 *
 * `inputBasis` (C3.5) is the additive vector basis: present ONLY when the
 * attempt consumed validated foreign point reads, always containing the home
 * component (≡ `inputBasisSeq`) plus one component per consumed foreign
 * space, sorted by space. Foreign components are admissible only from the
 * home HOST's own served-point-read records (C3A13): the host validates the
 * Worker's asserted stamps against what it actually served over the
 * authenticated C3.1 link and the engine authors from those host-validated
 * values — a Worker/client-supplied component is stripped exactly like the
 * asserted scalar.
 */
export type ActionExecutionProvenance = {
  claim: ActionClaimKey;
  onBehalfOf: string;
  leaseGeneration: number;
  claimGeneration: number;
  causedBy: number[];
  inputBasisSeq: InputBasisSeq;
  inputBasis?: readonly ProvenanceInputBasisComponent[];
};

export type ExecutionClaimSetEvent = {
  type: "session.execution.claim.set";
  claim: ExecutionClaim;
};

export type ExecutionClaimRevokeEvent = {
  type: "session.execution.claim.revoke";
  branch: BranchName;
  claim: ActionClaimKey;
  leaseGeneration: number;
  claimGeneration: number;
  /**
   * C3.6b: mirrors the revoked claim's {@link ExecutionClaim.crossSpaceReadSpaces}
   * so the delivery gate (`#sessionAcceptsClaim`) narrows the revoke to the
   * same `cross-space-claims-v1` cohort the claim.set reached — a session that
   * never received the (foreign-reading) claim must not receive its revoke and
   * fire a spurious fail-open rerun. The `claim` field itself stays the
   * canonical key (byte-identical for the pre-C3.6 revoke); this sibling
   * marker is present only for cross-space-read claims.
   */
  crossSpaceReadSpaces?: readonly string[];
};

export type ActionSettlement =
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: InputBasisSeq;
    /** C3.5 vector basis (see {@link InputBasisComponent}): absent for
     * same-space attempts (scalar-only settlements are byte-identical to
     * pre-C3.5); when present it includes the home component ≡
     * `inputBasisSeq`. Epoch stamps stay on provenance — settlements are
     * client-visible and carry {space, seq} only. */
    inputBasis?: readonly InputBasisComponent[];
    outcome: "committed";
    acceptedCommitSeq: AcceptedCommitSeq;
    diagnosticCode?: never;
  }
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: InputBasisSeq;
    inputBasis?: readonly InputBasisComponent[];
    outcome: "no-op" | "failed" | "unserved";
    acceptedCommitSeq?: never;
    diagnosticCode?: string;
  };

export type ExecutionSettlementEvent = {
  type: "session.execution.settlement";
  settlement: ActionSettlement;
};

/**
 * The one-shot COMMAND on an otherwise state-reconciling feed: the client half
 * of a server-side `navigateTo`
 * (`docs/history/specs/server-side-execution/navigate-to-server-side.md` §2c, owner
 * gate 2). `navigateTo` is neither a pattern effect nor a rendering effect but
 * both, split at a seam — the DECISION to navigate derives from pattern state
 * and runs server-side; the ACTUATION is a shell view change and stays a client
 * rendering effect. This event IS that seam.
 *
 * It is deliberately unlike its three siblings, and the difference is the whole
 * reason it needs its own variant rather than a field on one of them. Claim
 * set/revoke/settlement are IDEMPOTENT STATE: applying one twice reaches the
 * same place, which is why the feed may retain and replay them on reconnect. A
 * navigation is a command with a side effect on the user's view — replaying it
 * yanks the view on every reconnect. So this variant is NEVER retained (see
 * `appendExecutionEvent` in `v2/session-registry.ts`) and can therefore never
 * appear in a reconnect snapshot or a replayed event run.
 *
 * Addressing needs nothing new. The `claim` carries the canonical
 * `contextKey`, so the existing delivery predicate (`#sessionAcceptsClaim`)
 * narrows the event for free — and because `navigateTo`'s session-scoped write
 * confines it to session rank (`runner`'s `scheduler/servability.ts`
 * `laneAdmitsScope`), that predicate resolves to EXACTLY ONE session: the
 * `session:<principal>:<sessionId>` the key names, never a sibling of the same
 * principal, never a co-tenant of the space.
 *
 * Duplicate delivery is a no-op without any work here: `navigateTo` keeps its
 * per-session receipt (the session-scoped result cell it sets to `true`, whose
 * `false` reading is the "already navigated" guard), so a second event for the
 * same target lands on an already-navigated session.
 */
export type ExecutionNavigateEvent = {
  type: "session.execution.navigate";
  /**
   * The navigateTo action's claim. Canonical key only — this is an addressing
   * field, not a claim mutation: the event neither grants nor revokes
   * authority, and applying it must not touch the client's claim map.
   */
  claim: ActionClaimKey;
  /**
   * The resolved navigation target, as the shell's `navigateCallback` consumes
   * it: exactly the four fields of a `NormalizedFullLink`, which is what the
   * client already round-trips through `postMessage` today
   * (`runtime-client/backends/runtime-processor.ts`). Nothing richer is needed
   * — the shell reconstitutes a Cell from the link and calls `cell.id()` /
   * `cell.space()`.
   */
  target: {
    space: string;
    id: EntityId;
    path: readonly string[];
    scope?: CellScope;
  };
};

export type ExecutionControlEvent =
  | ExecutionClaimSetEvent
  | ExecutionClaimRevokeEvent
  | ExecutionSettlementEvent
  | ExecutionNavigateEvent;

export type ExecutionClaimSnapshot = {
  claims: ExecutionClaim[];
  /**
   * Successful settlement summaries newer than the reconnect cursor. The
   * server coalesces them by exact live claim incarnation so bounded event
   * retention cannot strand speculative overlays.
   */
  settlementFrontiers?: ExecutionSettlementFrontier[];
};

/**
 * Reconnect-only causal summary of successful settlements for one exact live
 * claim. `inputBasisSeq` is the strongest covered basis, while
 * `requiredAcceptedCommitSeq` preserves every committed data-application gate
 * contributing to the summary. `throughFeedSeq` is the newest summarized
 * successful control event.
 */
export type ExecutionSettlementFrontier = {
  branch: BranchName;
  claim: ExecutionClaim;
  inputBasisSeq: InputBasisSeq;
  /** C3.5 vector basis, coalesced per component under the C3A15 vacuous
   * union ({@link mergeInputBasisVectors}). Absent when every summarized
   * settlement was scalar-only. */
  inputBasis?: readonly InputBasisComponent[];
  throughFeedSeq: number;
  requiredAcceptedCommitSeq?: AcceptedCommitSeq;
};

export const actionSettlementFromFrontier = (
  frontier: ExecutionSettlementFrontier,
): ActionSettlement =>
  frontier.requiredAcceptedCommitSeq === undefined
    ? {
      branch: frontier.branch,
      claim: frontier.claim,
      inputBasisSeq: frontier.inputBasisSeq,
      // C3A14: the frontier-reconstructed settlement is a settlement
      // CARRIER — dropping the vector here would strand or prematurely
      // drop held foreign-read overlays across reconnects.
      ...(frontier.inputBasis !== undefined
        ? { inputBasis: frontier.inputBasis }
        : {}),
      outcome: "no-op",
    }
    : {
      branch: frontier.branch,
      claim: frontier.claim,
      inputBasisSeq: frontier.inputBasisSeq,
      ...(frontier.inputBasis !== undefined
        ? { inputBasis: frontier.inputBasis }
        : {}),
      outcome: "committed",
      acceptedCommitSeq: frontier.requiredAcceptedCommitSeq,
    };

/**
 * C3.5/C3A15: the ONLY merge for vector bases — union components by space
 * and keep the per-space maximum. The union arm IS the vacuous
 * missing-component rule: a component absent on one side rides through
 * unchanged (absent never means zero), and a present-but-older component
 * never wins. Result components are sorted by space for a deterministic
 * wire shape; both-undefined stays undefined (scalar-only settlements
 * merge byte-identically to pre-C3.5).
 */
export const mergeInputBasisVectors = (
  left: readonly InputBasisComponent[] | undefined,
  right: readonly InputBasisComponent[] | undefined,
): readonly InputBasisComponent[] | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const merged = new Map<string, InputBasisComponent>();
  for (const component of [...left, ...right]) {
    const held = merged.get(component.space);
    if (held === undefined || component.seq > held.seq) {
      merged.set(component.space, component);
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.space < b.space ? -1 : a.space > b.space ? 1 : 0
  );
};

/** C3.5: the component a basis carries for `space`, or undefined — and
 * undefined MUST be treated as vacuous by every consumer (C3A15). */
export const inputBasisComponentForSpace = (
  basis: readonly InputBasisComponent[] | undefined,
  space: string,
): InputBasisComponent | undefined =>
  basis?.find((component) => component.space === space);

export type ExecutionFeedBatch = {
  fromFeedSeq: number;
  toFeedSeq: number;
  snapshot?: ExecutionClaimSnapshot;
  events: ExecutionControlEvent[];
};

export type SessionSyncUpsert = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of this instance (C1.4b, additive): per-lane sync
   * frame attribution for the re-keyed Worker replica. */
  scopeKey?: string;
  seq: number;
  doc?: EntityDocument;
  deleted?: true;
};

export type SessionSyncRemove = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  /** RESOLVED scope key of the removed instance (F2, additive): removes must
   * address the same per-lane instance identity the upserts established —
   * a declared-scope remove must not evict another lane's instance. */
  scopeKey?: string;
};

export type SessionSync = {
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
};

export type WatchSetResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type WatchAddResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type SessionAckResult = {
  serverSeq: number;
};

/** Coarse v1 client-read demand. It is owned by the authenticated connection;
 * callers name only the branch and piece roots, never principal/connection or
 * sponsor authority. */
export type ExecutionDemandSetRequest = {
  type: "session.execution.demand.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  pieces: string[];
};

export type ExecutionDemandSetResult = {
  serverSeq: number;
  references: number;
};

export type LegacyBackgroundExclusionAcquireRequest = {
  type: "session.execution.legacy-background.acquire";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
};

export type LegacyBackgroundExclusionRenewRequest = {
  type: "session.execution.legacy-background.renew";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  exclusionGeneration: number;
};

export type LegacyBackgroundExclusionReleaseRequest = {
  type: "session.execution.legacy-background.release";
  requestId: string;
  space: string;
  sessionId: SessionId;
  branch: BranchName;
  exclusionGeneration: number;
};

export type LegacyBackgroundExclusionStatusResult = {
  serverSeq: number;
  status: LegacyBackgroundExclusionStatus | null;
};

export type LegacyBackgroundExclusionReleaseResult = {
  serverSeq: number;
  released: LegacyBackgroundExclusion | null;
};

export type TransactRequest = {
  type: "transact";
  requestId: string;
  space: string;
  sessionId: SessionId;
  commit: ClientCommit;
  /**
   * The lane this commit ACTS AS — the same C1.4b per-request seam every read
   * verb already carries (see {@link GraphQueryRequest.actingContext}), now on
   * the write side. Validated host-side against the LIVE lane grant of the
   * binding's (space, branch) BEFORE any scope key resolves, exactly like a
   * read: an unbound session, a malformed key, or a drained grant rejects in
   * the same constant shape.
   *
   * It is the SOLE source of the commit's acting context. Before this field
   * the host derived it from the claims the observation asserted, which made
   * the acting lane a property of an arbitration decision rather than of the
   * run; the engine then had to fence the two computations against each other
   * (`claim-context-mismatch`). One source, no second opinion — and a rank
   * the run resolves to differently is an observation, never a refusal
   * (D11 / client-passivity §5h.4).
   *
   * Space-lane commits omit it and stay byte-identical.
   */
  actingContext?: SchedulerExecutionContextKey;
};

/** F2/FA5 (FB12) trigger attribution for graph.query accounting: `"wave"` =
 * a refresh forced by an accepted-commit wave (rehydrate/wake — closure
 * shrink, root re-establishment, resolution moves), `"demand"` = new data
 * demanded (first-demand cold pull, new-doc closure growth). The server
 * buckets `#recordFeedTraversal` accordingly, keeping the aggregate
 * "graph.query" bucket unchanged; the wave bucket is the F5 protocol's
 * F2-floor regression signal, which one undifferentiated bucket could not
 * attribute. */
export type GraphQueryTrigger = "wave" | "demand";

export type GraphQueryRequest = {
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
  /** P1 step-1 covered growth pulls (client-passivity §0/§5c): when true,
   * the server MAY omit from the response every doc this SESSION's live
   * watch surface already tracks — their delivery is owned by the wave
   * path — and skip re-traversing (docKey, selector) pairs the tracked
   * surface covers, so a closure-growth pull returns only the uncovered
   * delta instead of re-walking the whole accumulated graph (the 0-skip
   * `graph.query.demand` full re-traversal the 2026-07-28 confirm run
   * measured at 20.6s/run with 1.2s single-call event-loop stalls).
   * Best-effort and additive: a server that predates the field, a session
   * with no tracked graph for the branch, or a lane-scoped request
   * (actingContext set — tracker doc keys carry scope CLASSES, not lane
   * instances, so cross-lane coverage would be unsound) replies in full.
   * Callers therefore MUST merge — never replace — their held set with
   * the reply, and MUST NOT set this on pulls that re-fetch docs the
   * caller may not hold (never-held retries), where a tracked-but-
   * undelivered doc would be omitted forever. */
  omitWatchCovered?: boolean;
  query: GraphQuery;
};

export type EntityIdListRequest = {
  type: "entity-id.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupRequest = {
  type: "entity-id.exists";
  requestId: string;
  space: string;
  sessionId: SessionId;
  id: EntityId;
};

/** Address of one exact document for a point read: declared scope only —
 * resolution to a scope key happens server-side under the request's acting
 * context, exactly like graph-query roots. */
export type DocReadAddress = {
  id: EntityId;
  scope?: CellScope;
};

/** F2 point-read batch: exact engine reads with NO schema/link traversal.
 * `atSeq` evaluates every doc at one sequence bound so a coalesced
 * accepted-commit wave reads from a single snapshot; absent means head. */
export type DocsReadQuery = {
  docs: DocReadAddress[];
  atSeq?: number;
  branch?: BranchName;
};

export type DocsReadResult = {
  serverSeq: number;
  /** One snapshot per addressed doc that has a stored revision (deleted docs
   * appear with `document: null`); never-written docs are omitted. */
  entities: EntitySnapshot[];
};

/**
 * C3.4: the claimed attempt an executor FOREIGN point read acts under —
 * a claim REFERENCE (identity + bound generations), never credentials.
 * Rides `docs.read` ONLY when the frame names a foreign space through a
 * lease-bound executor provider channel; the direct (home) serve path
 * rejects a frame carrying it. The claim's space/branch are deliberately
 * absent: the host derives them from the channel's lease binding, so a
 * frame cannot point the liveness consult at another lane's claim.
 */
export type DocsReadExecutionClaimRef = {
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: ActionClaimKey["actionKind"];
  implementationFingerprint: string;
  runtimeFingerprint: string;
  leaseGeneration: number;
  claimGeneration: number;
};

/** F2 executor-feed point reads (FA5): the replica-maintenance read that
 * replaces per-wave graph re-traversal for docs the reader already holds.
 * Carries the C1.4b `actingContext` seam from day one (FA6). */
export type DocsReadRequest = {
  type: "docs.read";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** See {@link GraphQueryRequest.actingContext}. */
  actingContext?: SchedulerExecutionContextKey;
  /** C3.4 foreign point reads only — see
   * {@link DocsReadExecutionClaimRef}. */
  executionClaim?: DocsReadExecutionClaimRef;
  query: DocsReadQuery;
};

// --- SQLite builtins (docs/specs/sqlite-builtin) ---

/** Wire form of SQLite bind parameters. */
export type SqliteParamsWire =
  | ReadonlyArray<FabricValue>
  | Record<string, FabricValue>;

/** Reference to a cell-derived SQLite database: an opaque id (the handle cell's
 *  entity id) plus the declared table schemas (for additive create/migrate).
 *
 *  `scope` is the SqliteDb cell's declared scope (space/user/session). The
 *  server folds it (with the request's principal / session id) into the on-disk
 *  filename so a `user`/`session`-scoped db gets a per-user / per-session file;
 *  `space` (or absent) keeps the original unqualified name. */
export type SqliteDbRef = {
  id: string;
  tables?: Record<string, FabricValue>;
  scope?: CellScope;
  /** The db's owner — the principal that created the SqliteDb cell. Resolves
   *  the per-row label rule's `dbOwner()` term (CFC Phase 3); a FIXED db
   *  property, captured once at handle creation, never the acting reader. */
  owner?: string;
};

export type SqliteQueryRequest = {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** See {@link GraphQueryRequest.actingContext}. A cell-db's on-disk FILE is
   * picked by `db.scope` resolved against the request's scope context, so a
   * lease-bound executor session serving a lane must name it here; absent, the
   * request keeps the sponsor-mirroring resolution the executor's own replica
   * depends on. */
  actingContext?: SchedulerExecutionContextKey;
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
};

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export type SqliteResultColumn = {
  output: string;
  table: string | null;
  column: string | null;
};

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

export type SqliteQueryResult = {
  rows: FabricPlainObject[];
  /** Per-result-column origin, present ONLY when the db needs provenance for
   *  CFC labeling — any column declares `ifc` (Phase 2) or any table declares
   *  a per-row label rule (Phase 3); see `dbNeedsColumnProvenance`. An aliased
   *  or joined column maps back to its declared `(table, column)`. Undefined
   *  otherwise, so unlabeled queries pay nothing. */
  columns?: SqliteResultColumn[];
};

// NOTE: there is no `sqlite.execute` write verb. Writes go through the commit
// fold (a `sqlite` op inside `transact`, applied atomically with cell ops by the
// engine) — never a standalone, non-atomic write RPC. See db.exec in the runner.

/**
 * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
 * link <piece> <field> sqlite:<absPath>` issues this so the server attaches the
 * given file (read-only) for the handle id instead of the cell-derived path. The
 * descriptor is server-side state — it is NOT written into the handle cell value.
 */
export type SqliteRegisterDiskSourceRequest = {
  type: "sqlite.register-disk-source";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** Handle cell id (content-derived from (serviceSpace, absPath); see cf). */
  id: string;
  /** Absolute path to the on-disk SQLite file. */
  path: string;
};

export type SqliteRegisterDiskSourceResult = {
  registered: true;
};

export type WatchSetRequest = {
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
};

export type WatchAddRequest = {
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
};

export type SessionAckRequest = {
  type: "session.ack";
  requestId: string;
  space: string;
  sessionId: SessionId;
  seenSeq: number;
  executionFeedSeq?: number;
};

export type SchedulerActionSnapshotQuery = {
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
};

/**
 * Server-derived ownership partition for durable scheduler state. The opaque
 * principal and session components use the same encoding as resolved memory
 * scope keys; clients must never construct one to select another context.
 */
export type SchedulerActionKind =
  | "computation"
  | "effect"
  | "event-handler";

export type SchedulerObservationTransactionKind =
  | "dependency-collection"
  | "action-run"
  | "event-preflight";

export type SchedulerObservationAddress = {
  space: string;
  id: EntityId;
  scope?: CellScope;
  path: readonly string[];
};

export type CompleteActionScopeSummary = {
  version: 1;
  complete: true;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  piece: SchedulerObservationAddress;
  reads: SchedulerObservationAddress[];
  writes: SchedulerObservationAddress[];
  materializerWriteEnvelopes: SchedulerObservationAddress[];
  directOutputs: SchedulerObservationAddress[];
};

/**
 * A scheduler action observation as it is stored and carried across the memory
 * boundary.
 *
 * A parallel declaration of the same concept lives in the runner, at
 * `runner/src/scheduler/persistent-observation.ts`. The two are not the same
 * type and differ in strictness:
 *
 * - addresses here are {@link SchedulerObservationAddress} (`space: string`);
 *   the runner uses `IMemorySpaceAddress` (`space: MemorySpace`)
 * - `branch` here is `BranchName`; the runner declares it `string`
 *
 * The runner produces observations and this side stores them, so this one is
 * deliberately the wider of the pair. Nothing checks that they agree: the wire
 * fields that carry an observation (`CommitData.schedulerObservation` and
 * `SchedulerActionSnapshotResult.observation`) are declared `unknown`, so a
 * change to either declaration will not surface at the seam. Keep them in sync
 * by hand until one of them owns the shape.
 */
/** C3.5: one Worker-asserted foreign read stamp — see
 * {@link SchedulerActionObservation.foreignReadStamps}. */
export type ForeignReadStampAssertion = {
  space: string;
  id: EntityId;
  /** The read space's stamped covering seq (its own domain, positive). */
  seq: number;
};

export type SchedulerActionObservation = {
  version: 1 | 2;
  ownerSpace?: string;
  branch: BranchName;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  completeActionScopeSummary?: CompleteActionScopeSummary;
  observedAtSeq: number;
  /** Host-derived maximum accepted revision sequence in the commit read set. */
  inputBasisSeq?: InputBasisSeq;
  /** Transient exact-claim assertion; validated by the bound executor host. */
  executionClaimAssertion?: ExecutionClaimAssertion;
  /**
   * C3.5: transient Worker assertion of the stamped foreign point reads the
   * attempt consumed from its read-only mount — {space, id, seq} per read,
   * in the READ space's seq domain. Like `executionClaimAssertion` it is a
   * request field, never persisted: the HOST validates each stamp against
   * its own served-point-read records (C3A13 — the engine cannot verify a
   * foreign seq itself) and passes only host-validated components into the
   * accept transaction; the engine strips this field from the canonical
   * accepted observation. An asserted stamp the host never served is
   * dropped, exactly like the asserted scalar.
   */
  foreignReadStamps?: readonly ForeignReadStampAssertion[];
  /**
   * Transient report that the host discarded a claimed action as one whole
   * transaction. Valid only on an observation-only exact claimed attempt and
   * stripped before scheduler state is persisted.
   */
  executionUnservedAttempt?: { diagnosticCode: string };
  executionProvenance?: ActionExecutionProvenance;
  observedAtLocalSeq?: number;
  transactionKind: SchedulerObservationTransactionKind;
  reads: SchedulerObservationAddress[];
  shallowReads: SchedulerObservationAddress[];
  actualChangedWrites: SchedulerObservationAddress[];
  currentKnownWrites: SchedulerObservationAddress[];
  declaredWrites?: SchedulerObservationAddress[];
  materializerWriteEnvelopes: SchedulerObservationAddress[];
  ignoredSchedulingWrites?: SchedulerObservationAddress[];
  actionOptions?: {
    debounceMs?: number;
    noDebounce?: boolean;
    throttleMs?: number;
  };
  status: "success" | "failed";
  errorFingerprint?: string;
};

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

/**
 * Canonical parse of a `session:<principal>:<sessionId>` execution-context
 * key (C2.1, adversarial-review amendment CA12): exactly three colon-split
 * segments — the percent-encoding of both segments is what makes the split
 * exact for colon-bearing did:key principals — with both segments non-empty,
 * decodable, and byte-exact under re-encoding through the single construction
 * site above. Returns `undefined` for anything else (`session:a:b:c`,
 * `session::`, a naive raw-DID concatenation, non-canonical escapes), so the
 * wire validator and the engine claim guard reject malformed session keys in
 * one place instead of surfacing inconsistent downstream errors.
 */
export const parseSessionExecutionContextKey = (
  key: string,
): { principal: string; sessionId: string } | undefined => {
  if (!key.startsWith("session:")) return undefined;
  const parts = key.split(":");
  if (parts.length !== 3) return undefined;
  const [, encodedPrincipal, encodedSessionId] = parts;
  if (encodedPrincipal.length === 0 || encodedSessionId.length === 0) {
    return undefined;
  }
  try {
    const principal = decodeURIComponent(encodedPrincipal);
    const sessionId = decodeURIComponent(encodedSessionId);
    return sessionExecutionContextKey(principal, sessionId) === key
      ? { principal, sessionId }
      : undefined;
  } catch {
    return undefined;
  }
};

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

export type SchedulerActionSnapshotCursor = {
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
};

export type SchedulerActionSnapshotResult = {
  observationId: number;
  commitSeq: number | null;
  observedAtSeq: number;
  executionContextKey: SchedulerExecutionContextKey;
  /** The observation, opaque here: this layer stores and forwards it, and the
   *  runner owns its shape and validation. `FabricValue` says only what the
   *  wire requires of it. */
  observation: FabricValue;
  directDirtySeq?: number;
  staleSeq?: number;
  unknownReason?: string;
};

export type SchedulerSnapshotListResult = {
  serverSeq: number;
  snapshots: SchedulerActionSnapshotResult[];
  nextCursor?: SchedulerActionSnapshotCursor;
};

export type SchedulerSnapshotListRequest = {
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
};

export type SchedulerWriterTarget = {
  id: EntityId;
  scope?: CellScope;
  path: DocumentPath;
};

export type SchedulerWritersForTargetsQuery = {
  branch?: BranchName;
  targets: SchedulerWriterTarget[];
};

export type SchedulerWriterMatchKind =
  | "current-known"
  | "declared"
  | "materializer";

export type SchedulerResolvedWriterAddress = {
  space: string;
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  path: DocumentPath;
};

export type SchedulerWriterMatch = {
  kind: SchedulerWriterMatchKind;
  write: SchedulerResolvedWriterAddress;
};

export type SchedulerWriterCandidate = {
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
};

export type SchedulerWritersForTargetsResult = {
  serverSeq: number;
  writers: SchedulerWriterCandidate[];
};

export type SchedulerWriterListRequest = {
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
};

export type ResponseMessage<Result> = {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
};

export type SessionEffectMessage = {
  type: "session/effect";
  space: string;
  sessionId: SessionId;
  effect: SessionSync;
};

export type SessionRevokedMessage = {
  type: "session/revoked";
  space: string;
  sessionId: SessionId;
  reason: "taken-over" | "unauthorized";
};

export type V2Error = {
  name: string;
  message: string;
  precondition?: string;
  retryAfterSeq?: number;
  /** Stable reason attached to a rejected server-execution action attempt. */
  diagnosticCode?: string;
  /**
   * Present on an `AuthorizationError` that a fresh handshake can heal — the
   * connection-challenge and invocation-freshness anti-replay races (an expired,
   * already-used, or mismatched challenge; a stale signed `exp`). Each reconnect
   * runs a new `hello` that issues a fresh challenge, so these do not recur. Its
   * absence marks a permanent denial (an audience mismatch, a malformed
   * invocation, or an ACL capability shortfall) that retrying cannot fix — the
   * client stops reopening the session and surfaces the error instead of looping.
   */
  retriable?: boolean;
};

export type V2Result<Value> = { ok: Value } | { error: V2Error };

export type TaskReturn<Result> = {
  the: "task/return";
  of: JobId;
  is: Result;
};

export type Receipt<Result> = TaskReturn<Result>;
export type LegacyClientMessage = SessionOpenCommand;
export type LegacyServerMessage = TaskReturn<V2Result<unknown>>;
export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | DocsReadRequest
  | EntityIdListRequest
  | EntityIdLookupRequest
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
  | ResponseMessage<FabricValue>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction at the memory boundary",
);

// These ambient flags and the memory protocol flags below are catalogued, with
// their defaults and removal paths, in docs/development/EXPERIMENTAL_OPTIONS.md.
// Update that registry when adding or removing one.
//
// THE CONTRACT EVERY DIAL BELOW OBEYS — three words, and the middle one is the
// one that was wrong:
//
//   set(value)     — install `value`.
//   set(undefined) — NO OPINION. Leave whatever is installed alone.
//   reset()        — put the COMPILED DEFAULT back. The explicit way to say it.
//
// `set(undefined)` used to mean `reset()`, and that conflation is a trap
// because these globals have MORE THAN ONE writer with no ordering between
// them. A memory server installs `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` at
// its own construction; a runner `Runtime` bridges `RuntimeOptions.
// experimental` at its. A host that constructs a Runtime without naming a flag
// was passing `undefined` — "I have no opinion" — and silently reverting the
// deployment's configuration, which for the master dial is the whole rollback
// lever. `setModernCellRepConfig` (data-model/src/cell-rep.ts) already read
// `undefined` this way; the dials here now agree with it.
//
// The lifecycle half belongs to the caller and is the same rule from the other
// end: a writer with a bounded lifetime (a Runtime) reads the prior value,
// installs its own, and puts the PRIOR value back when it ends — never the
// compiled default, which would be a third opinion nobody expressed. See
// `#ambientFlagRestores` in runner/src/runtime.ts.
//
// THE SERVER-PRIMARY DIAL SET MOVES AS ONE (owner ruling, 2026-08-01).
// "Server-primary execution is on" names the WHOLE configuration, not a flag:
// the master dial, the issuance rank at its top stage, and both claim-delivery
// subcapabilities default on TOGETHER, and the runner's matching candidate
// dials default on beside them (runner/src/runtime.ts). The intermediate
// states — master on with a lower rank stage, or a subcapability withheld —
// remain reachable programmatically, but they are a TESTING-ONLY affordance:
// nothing ships in one. A deployment has exactly the two configurations the
// arc admits, selected by the master dial alone (`serverPrimaryExecution`,
// which gates issuance in `#assertExecutionClaimCapabilityEnabled` and demand
// publication in `runner.ts`), so `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false`
// is the whole rollback and no dial beneath it needs its own lever.
/**
 * Default of the master server-primary dial. Exported because a construction
 * site that must decide BEFORE a Runtime exists — toolshed's
 * `externalSinkDisposition`, which is chosen while assembling
 * `RuntimeOptions` — has to resolve the same "unset means what?" the
 * constructor does, and two spellings of a default is how they drift.
 */
export const SERVER_PRIMARY_EXECUTION_DEFAULT = true;

/** Top of the issuance ladder, and the default: a host issues claims at every
 * context rank and admits foreign space-scoped reads. */
export const SERVER_PRIMARY_EXECUTION_CLAIM_RANK_DEFAULT = "cross-space-read";

let persistentSchedulerStateEnabled = true;
let commitPreconditionsEnabled = true;
let syncSchemaTableEnabled = true;
let serverPrimaryExecutionEnabled = SERVER_PRIMARY_EXECUTION_DEFAULT;
let serverPrimaryExecutionClaimRank: ServerPrimaryExecutionClaimRank =
  SERVER_PRIMARY_EXECUTION_CLAIM_RANK_DEFAULT;
let serverPrimaryExecutionContextLatticeClaimsEnabled = true;
let serverPrimaryExecutionCrossSpaceClaimsEnabled = true;
// NOT part of the set above, deliberately: the F3/F4 doc-set feed and its F5
// per-space retirement dial are a WATCH-SURFACE rollout, not an execution
// authority one. Their graduation condition is the W2.9 wall-time gate, which
// is still a live measurement, and flipping the boolean alone would change
// nothing anyway — the retirement set below admits no space, so every `docs`
// watch is still rejected. Both stay at their pre-arc defaults.
let serverPrimaryExecutionDocSetWatchEnabled = false;
let serverPrimaryExecutionGraphRetirementSpaces: ReadonlySet<string> =
  new Set();

/**
 * Ambient runtime flag for persistent scheduler observations and rehydration.
 * The runner owns the feature, but the memory protocol needs the value during
 * client/server handshakes, so it lives beside the memory protocol flags.
 */
export function setPersistentSchedulerStateConfig(enabled?: boolean): void {
  if (enabled === undefined) return;
  persistentSchedulerStateEnabled = enabled;
}

export function getPersistentSchedulerStateConfig(): boolean {
  return persistentSchedulerStateEnabled;
}

export function resetPersistentSchedulerStateConfig(): void {
  persistentSchedulerStateEnabled = true;
}

/**
 * Ambient runtime flag for the server-primary execution protocol. The
 * capability is optional and defaults ON; compatible peers use server-primary
 * authority for every eligible claimed action. Passing `false` selects the
 * pre-arc configuration whole — no demand publication, no claim issuance at
 * any rank, and the client keeps its own egress — and that is the ONE
 * rollback lever for the dial set (see the block comment above).
 *
 * The default is spelled here rather than at a call site because both halves
 * of the handshake resolve it: a memory server applies the env var at
 * construction, a runner Runtime bridges its `ExperimentalOptions` value, and
 * an omitted value on either side must mean the same thing
 * ({@link SERVER_PRIMARY_EXECUTION_DEFAULT}) — resolved by
 * {@link resetServerPrimaryExecutionConfig} or by never setting the dial at
 * all, NOT by `set(undefined)`. This is the dial with two live writers, so it
 * is where the contract at the top of this section is load-bearing today.
 */
export function setServerPrimaryExecutionConfig(enabled?: boolean): void {
  if (enabled === undefined) return;
  serverPrimaryExecutionEnabled = enabled;
}

export function getServerPrimaryExecutionConfig(): boolean {
  return serverPrimaryExecutionEnabled;
}

export function resetServerPrimaryExecutionConfig(): void {
  serverPrimaryExecutionEnabled = SERVER_PRIMARY_EXECUTION_DEFAULT;
}

/**
 * Highest context rank the host ISSUES execution claims for (context-lattice
 * design §6: one internal dial, staged space → user → session →
 * cross-space-read). Issuance-side only — never negotiated on the wire; the
 * engine's commit-time guards stay rank-independent. The value is a LADDER,
 * not a set: the `session` stage admits user-rank claims too (space < user <
 * session — a host that may issue narrower claims may issue every
 * broader-in-chain rank beneath them). The default admits only the shared
 * space lane; C1 work enables `user` inside its gate fixtures, C2 enables
 * `session` inside its gate fixtures.
 *
 * `cross-space-read` (C3.6) is the FOURTH ladder entry, above `session`. It
 * is not a fourth CONTEXT rank — foreign-read admission is orthogonal to the
 * space/user/session chain (a claim of ANY context rank may read foreign
 * spaces). The ladder placement means the stage IMPLIES every rank beneath
 * it (a host issuing cross-space-read claims also issues session/user/space
 * claims, §6), while `serverPrimaryExecutionCrossSpaceReadsEnabled` — the
 * predicate the issuance preflight consults — is true only AT this stage.
 * `cross-space-read` is now the DEFAULT: the dial set moves as one, so the
 * CA4/C3A17 ordering invariant (never at this stage without C3.6b's
 * cross-space-claims-v1 cohort gate) is satisfied by construction rather than
 * by withholding the stage. A lower stage is a testing-only affordance;
 * nothing ships in one. Registered in docs/development/EXPERIMENTAL_OPTIONS.md
 * as `serverPrimaryExecutionClaimRank`.
 */
export type ServerPrimaryExecutionClaimRank =
  | "space"
  | "user"
  | "session"
  | "cross-space-read";

const SERVER_PRIMARY_EXECUTION_CLAIM_RANK_ORDER: Record<
  ServerPrimaryExecutionClaimRank,
  number
> = { space: 0, user: 1, session: 2, "cross-space-read": 3 };

/** Ladder comparison for the rank dial: is the configured stage at least
 * `rank`? (`cross-space-read` ⇒ `session` ⇒ `user` ⇒ `space`,
 * context-lattice §6.) */
export const serverPrimaryExecutionClaimRankAtLeast = (
  rank: ServerPrimaryExecutionClaimRank,
): boolean =>
  SERVER_PRIMARY_EXECUTION_CLAIM_RANK_ORDER[serverPrimaryExecutionClaimRank] >=
    SERVER_PRIMARY_EXECUTION_CLAIM_RANK_ORDER[rank];

/** Whether the dial admits FOREIGN space-scoped reads under an issued claim
 * (C3.6): true only when the stage has reached the `cross-space-read` ladder
 * entry. Named apart from the raw `serverPrimaryExecutionClaimRankAtLeast`
 * call so the issuance preflight and the servability seam read one predicate,
 * and so the orthogonality is legible — this gates a CAPABILITY (foreign
 * reads), not a fourth context rank. */
export const serverPrimaryExecutionCrossSpaceReadsEnabled = (): boolean =>
  serverPrimaryExecutionClaimRankAtLeast("cross-space-read");

export function setServerPrimaryExecutionClaimRankConfig(
  rank?: ServerPrimaryExecutionClaimRank,
): void {
  if (rank === undefined) return;
  serverPrimaryExecutionClaimRank = rank;
}

export function getServerPrimaryExecutionClaimRankConfig(): ServerPrimaryExecutionClaimRank {
  return serverPrimaryExecutionClaimRank;
}

export function resetServerPrimaryExecutionClaimRankConfig(): void {
  serverPrimaryExecutionClaimRank = SERVER_PRIMARY_EXECUTION_CLAIM_RANK_DEFAULT;
}

/**
 * Ambient runtime flag for the context-lattice-claims-v1 subcapability
 * (context-lattice C1.7): whether this server ADVERTISES context-scoped
 * claim delivery. Defaults ON with the rest of the dial set; a mixed fleet
 * stays valid either way — the amendment-11 cohort gate fences user lanes
 * around sessions that did not negotiate it rather than rejecting them.
 * Registered in
 * docs/development/EXPERIMENTAL_OPTIONS.md as
 * `serverPrimaryExecutionContextLatticeClaimsV1`.
 */
export function setServerPrimaryExecutionContextLatticeClaimsConfig(
  enabled?: boolean,
): void {
  if (enabled === undefined) return;
  serverPrimaryExecutionContextLatticeClaimsEnabled = enabled;
}

export function getServerPrimaryExecutionContextLatticeClaimsConfig(): boolean {
  return serverPrimaryExecutionContextLatticeClaimsEnabled;
}

export function resetServerPrimaryExecutionContextLatticeClaimsConfig(): void {
  serverPrimaryExecutionContextLatticeClaimsEnabled =
    SERVER_PRIMARY_EXECUTION_DEFAULT;
}

/**
 * Ambient runtime flag for the cross-space-claims-v1 subcapability (C3.6b):
 * whether this server ADVERTISES cross-space-read claim delivery. Defaults
 * ON with the rest of the dial set; a mixed fleet stays valid either way —
 * the A11 cohort gate fences cross-space-read claims around a delivery cohort
 * that did not uniformly negotiate it rather than rejecting the sessions.
 * Paired with the claim-rank dial's `cross-space-read` entry, which is also
 * the default: this advertises the wire subcapability,
 * `serverPrimaryExecutionCrossSpaceReadsEnabled` (the rank dial) admits
 * issuance; the ordering invariant (C3A17) is that issuance is refused unless
 * BOTH hold, and moving the set together is what satisfies it.
 * Registered in docs/development/EXPERIMENTAL_OPTIONS.md as
 * `serverPrimaryExecutionCrossSpaceClaimsV1`.
 */
export function setServerPrimaryExecutionCrossSpaceClaimsConfig(
  enabled?: boolean,
): void {
  if (enabled === undefined) return;
  serverPrimaryExecutionCrossSpaceClaimsEnabled = enabled;
}

export function getServerPrimaryExecutionCrossSpaceClaimsConfig(): boolean {
  return serverPrimaryExecutionCrossSpaceClaimsEnabled;
}

export function resetServerPrimaryExecutionCrossSpaceClaimsConfig(): void {
  serverPrimaryExecutionCrossSpaceClaimsEnabled =
    SERVER_PRIMARY_EXECUTION_DEFAULT;
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
  if (enabled === undefined) return;
  serverPrimaryExecutionDocSetWatchEnabled = enabled;
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
  if (spaces === undefined) return;
  serverPrimaryExecutionGraphRetirementSpaces = new Set(spaces);
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

/** Canonical env name for the base server-primary execution dial. Owned here
 * (next to the ambient dial it feeds) because the memory package cannot see
 * the runner's `EXPERIMENTAL_ENV_VARS`; the runner's canonical mapping
 * imports THIS constant so the two spellings cannot drift. */
export const SERVER_PRIMARY_EXECUTION_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION";

/** Canonical env name for the F3/F4 doc-set-watch subcapability dial; same
 * ownership arrangement as {@link SERVER_PRIMARY_EXECUTION_ENV}. */
export const SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH";

/** Canonical env name for the C1.7 context-lattice-claims-v1 subcapability
 * dial; same ownership arrangement as {@link SERVER_PRIMARY_EXECUTION_ENV}.
 * Read on BOTH halves of the handshake — a server applies it to decide what
 * it advertises, a client Runtime installs it as the ambient config its
 * `hello` offers — so the two spellings cannot drift. */
export const SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_ENV =
  "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS";

/** Canonical boolean-env semantics (mirrors the runner's
 * `experimentalOptionsFromEnv`): exactly `"true"`/`"false"` apply; unset
 * leaves the current value; anything else is ignored WITH a warning, never
 * coerced. */
const applyBooleanEnvFlag = (
  readEnv: (name: string) => string | undefined,
  name: string,
  set: (enabled: boolean) => void,
): void => {
  const raw = readEnv(name);
  if (raw === undefined) return;
  if (raw === "true" || raw === "false") {
    set(raw === "true");
    return;
  }
  console.warn(
    `[memory] Ignoring ${name}="${raw}" — ` +
      `expected "true" or "false" (unset = default).`,
  );
};

/**
 * Apply the server-primary execution protocol dials (the base capability and
 * the layered doc-set-watch subcapability) from the environment.
 *
 * WHY (feed FW6, from the 2026-07-24 F5-unreachable-from-browser finding):
 * these ambient dials drive `getMemoryProtocolFlags()` — the capabilities a
 * server ADVERTISES in `hello.ok` — but they were only ever installed as a
 * side effect of constructing a runner `Runtime` in the same realm. Every
 * realm-separated deployment shape (browser ↔ toolshed, worker runtimes ↔
 * the standalone server) has NO Runtime in the server realm, so a
 * dial-driven fleet advertised every server-primary capability false and
 * clients negotiated nothing. Hosts that construct a memory server
 * (toolshed's storage route, the standalone server) call this at
 * construction — the same one-line wiring as
 * {@link applyServerPrimaryExecutionGraphRetirementEnvConfig} — so the
 * advertisement derives from the env directly, not from whether a Runtime
 * happens to live (or has been disposed) in the server's realm. Unset env ⇒
 * dials untouched, which since 2026-08-01 means the base capability and the
 * context-lattice subcapability advertise ON by default (the doc-set watch
 * dial still defaults off; see the block comment at the top of this section).
 * `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=false` is the deployment rollback.
 */
export function applyServerPrimaryExecutionEnvConfig(
  readEnv: (name: string) => string | undefined,
): void {
  applyBooleanEnvFlag(
    readEnv,
    SERVER_PRIMARY_EXECUTION_ENV,
    (enabled) => setServerPrimaryExecutionConfig(enabled),
  );
  applyBooleanEnvFlag(
    readEnv,
    SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH_ENV,
    (enabled) => setServerPrimaryExecutionDocSetWatchConfig(enabled),
  );
  // C1.7 context-lattice-claims-v1, added by the CA4 audit (client-passivity
  // §5g item 5): the SAME miswire as the doc-set dial above, one subcapability
  // over. Without this the advertisement is false in every dial-driven
  // deployment, so the amendment-11 cohort gate can never admit a user lane
  // and every claim-rank dial beneath it is inert.
  applyBooleanEnvFlag(
    readEnv,
    SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_ENV,
    (enabled) => setServerPrimaryExecutionContextLatticeClaimsConfig(enabled),
  );
}

/**
 * Ambient runtime flag for commit preconditions. The runner owns the feature,
 * but the memory protocol needs the value during client/server handshakes.
 */
export function setCommitPreconditionsConfig(enabled?: boolean): void {
  if (enabled === undefined) return;
  commitPreconditionsEnabled = enabled;
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
  if (enabled === undefined) return;
  syncSchemaTableEnabled = enabled;
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
  // Layered subcapability of claim routing (C3.6b): its own dial defaults off,
  // so enabling server-primary execution alone never turns it on. The
  // connection getter chain enforces the layering above claim routing.
  serverPrimaryExecutionCrossSpaceClaimsV1: getServerPrimaryExecutionConfig() &&
    getServerPrimaryExecutionCrossSpaceClaimsConfig(),
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
  // Likewise build-inherent: this build's engine resolves array-localSeq
  // pending reads (resolvePendingReads), so it always advertises it. Clients
  // that see it absent scalarize to top-of-stack before sending.
  pendingReadStacks: true,
  // The engine answers this request from its identifier index without
  // selecting stored entity values.
  entityIdListing: true,
  entityIdPagination: true,
  entityIdLookup: true,
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

  const serverPrimaryExecutionCrossSpaceClaimsV1 =
    value.serverPrimaryExecutionCrossSpaceClaimsV1;
  if (
    serverPrimaryExecutionCrossSpaceClaimsV1 !== undefined &&
    typeof serverPrimaryExecutionCrossSpaceClaimsV1 !== "boolean"
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

  const pendingReadStacks = value.pendingReadStacks;
  if (
    pendingReadStacks !== undefined &&
    typeof pendingReadStacks !== "boolean"
  ) {
    return null;
  }

  const entityIdListing = value.entityIdListing;
  if (
    entityIdListing !== undefined &&
    typeof entityIdListing !== "boolean"
  ) {
    return null;
  }

  const entityIdPagination = value.entityIdPagination;
  if (
    entityIdPagination !== undefined &&
    typeof entityIdPagination !== "boolean"
  ) {
    return null;
  }

  const entityIdLookup = value.entityIdLookup;
  if (
    entityIdLookup !== undefined &&
    typeof entityIdLookup !== "boolean"
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
    // Absent-false: an older peer that never heard of cross-space claims must
    // never be treated as accepting a cross-space-read claim (C3.6b).
    serverPrimaryExecutionCrossSpaceClaimsV1:
      serverPrimaryExecutionCrossSpaceClaimsV1 === true,
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
    // Absent (an older server) parses to false: clients scalarize pending
    // reads to top-of-stack unless the array capability is advertised.
    pendingReadStacks: pendingReadStacks === true,
    entityIdListing: entityIdListing === true,
    entityIdPagination: entityIdPagination === true,
    entityIdLookup: entityIdLookup === true,
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
  serverPrimaryExecutionCrossSpaceClaimsV1:
    flags.serverPrimaryExecutionCrossSpaceClaimsV1,
  serverPrimaryExecutionDocSetWatchV1:
    flags.serverPrimaryExecutionDocSetWatchV1,
  schedulerWriterLookup: flags.schedulerWriterLookup,
  commitPreconditions: flags.commitPreconditions,
  syncSchemaTable: flags.syncSchemaTable,
  syncSchemaTableV2: flags.syncSchemaTableV2,
  sqliteCommitRowLabelEval: flags.sqliteCommitRowLabelEval,
  pendingReadStacks: flags.pendingReadStacks,
  entityIdListing: flags.entityIdListing,
  entityIdPagination: flags.entityIdPagination,
  entityIdLookup: flags.entityIdLookup,
});

/**
 * Encodes a wire payload. The encoding embeds every string value
 * byte-verbatim (`fvj1:` tag + canonical JSON; strings self-represent, and
 * neither reserved schema-reference prefix contains a JSON-escapable
 * character). Three consumers depend on that property as a cheap substring
 * gate and must move in lockstep with any codec change (fvj2, escaping of
 * tag-like strings): the client receive-path expansion gate (v2/client.ts),
 * `containsReservedSchemaRefSubstring` (v2/sync-schema-ref.ts), and the
 * engine's commit/stored-row probes (v2/engine.ts). A pinning test in
 * test/v2-sync-schema-table-test.ts fails loudly if verbatim embedding ever
 * stops holding.
 */
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
