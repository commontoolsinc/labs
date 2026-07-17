import {
  type ActionClaimKey,
  actionClaimMapKey,
  type CellScope,
  type ExecutionClaim,
  type SchedulerExecutionContextKey,
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/api";
import { scopeNamingLinkWriteViolation } from "@commonfabric/memory/v2/scope-naming-link";
import { parsePointer } from "../../../memory/v2/path.ts";
import type {
  CompleteActionScopeSummary,
  SchedulerActionObservation,
} from "./persistent-observation.ts";
import type { IMemorySpaceAddress, MemorySpace } from "../storage/interface.ts";
import type { ActionTransactionRouteInput } from "../storage/v2.ts";

/**
 * Stable diagnostic codes for static server-primary servability decisions.
 *
 * These values are intended for CandidateClaim telemetry. Keep existing values
 * stable; add a new code when a new fail-closed case needs to be distinguished.
 */
export const STATIC_ACTION_UNSERVABLE_REASONS = [
  "malformed-candidate",
  "malformed-static-surface",
  "malformed-output-surface",
  "incomplete-static-surface",
  "unknown-effect-surface",
  "untrusted-implementation",
  "foreign-owner-space",
  "foreign-piece-space",
  "foreign-read-space",
  "foreign-write-space",
  "non-space-piece-scope",
  "non-space-read-scope",
  "non-space-write-scope",
  "event-handler",
  "ui-binding-transaction",
  "source-transaction",
  "unknown-action-kind",
] as const;

export type StaticActionUnservableReason =
  typeof STATIC_ACTION_UNSERVABLE_REASONS[number];

/**
 * The identity and exhaustive structural surface needed for static preflight.
 * A SchedulerActionObservation is structurally compatible with this input.
 * Source and UI callers may pass only their synthetic actionKind because those
 * transaction classes are rejected before scheduler metadata is inspected.
 */
export interface StaticActionServabilityCandidate {
  readonly actionKind?: unknown;
  readonly ownerSpace?: unknown;
  readonly pieceId?: unknown;
  readonly implementationFingerprint?: unknown;
  readonly runtimeFingerprint?: unknown;
  readonly completeActionScopeSummary?: unknown;
}

export type StaticActionServability =
  | {
    status: "claim-ready";
    actionKind: "computation";
    /** Present only when a lane-parameterized classification promoted the
     * candidate to user rank (context-lattice C1.5a); absent means space
     * rank, keeping the space-only result shape byte-identical. */
    contextRank?: "user";
  }
  | {
    status: "broker-required";
    actionKind: "effect";
  }
  | {
    status: "unservable";
    reason: StaticActionUnservableReason;
  };

/**
 * Lane parameterization for both servability classifiers (context-lattice
 * C1.5a/C1.6). `userContext` admits user-scoped addresses on computation
 * surfaces — the static classifier then reports `contextRank: "user"` and
 * the dynamic firewall accepts the lane principal's user-scoped reads and
 * writes. Absent (or false), both classifiers are byte-identical to the
 * space-only behavior: session-scoped surfaces stay unservable either way,
 * and effects keep space-only checks (amendment 8: user-rank is
 * computation-only in C1).
 */
export interface StaticActionServabilityLane {
  readonly userContext?: boolean;
}

export interface ActionTransactionServabilityContext {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  /** Lane rank for the per-attempt firewall; absent means space rank. */
  readonly contextRank?: "space" | "user";
  /** True when the routed commit will carry the lane as its ACTING context —
   * the executor's user-rank commits, which the engine's broad-instance
   * scope-naming backstop (C1.2 §4) applies to. A cooperative client's
   * suppression mirror checks a commit acting on the CLIENT's own context:
   * there a broad value write is ordinary client-primary output, and a
   * user-context claim over an all-space surface must keep suppressing
   * byte-identically (A10 chain continuity), so the backstop stays off. */
  readonly laneActingCommit?: boolean;
}

/**
 * Derive the exact client/server shared action identity. Host-authored
 * provenance and lease generations deliberately do not participate.
 */
export function actionClaimKeyFromObservation(
  observation: SchedulerActionObservation,
  contextKey: ActionClaimKey["contextKey"] = "space",
): ActionClaimKey | undefined {
  if (
    typeof observation.ownerSpace !== "string" ||
    observation.ownerSpace.length === 0 ||
    typeof observation.pieceId !== "string" ||
    observation.pieceId.length === 0 ||
    typeof observation.actionId !== "string" ||
    observation.actionId.length === 0 ||
    (observation.actionKind !== "computation" &&
      observation.actionKind !== "effect") ||
    typeof observation.implementationFingerprint !== "string" ||
    observation.implementationFingerprint.length === 0 ||
    typeof observation.runtimeFingerprint !== "string" ||
    observation.runtimeFingerprint.length === 0
  ) {
    return undefined;
  }
  return {
    branch: observation.branch,
    space: observation.ownerSpace,
    contextKey,
    pieceId: observation.pieceId,
    actionId: observation.actionId,
    actionKind: observation.actionKind,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
  };
}

export function actionClaimKeysEqual(
  left: ActionClaimKey,
  right: ActionClaimKey,
): boolean {
  return left.branch === right.branch && left.space === right.space &&
    left.contextKey === right.contextKey && left.pieceId === right.pieceId &&
    left.actionId === right.actionId && left.actionKind === right.actionKind &&
    left.implementationFingerprint === right.implementationFingerprint &&
    left.runtimeFingerprint === right.runtimeFingerprint;
}

export function executionClaimMatchesActionKey(
  claim: ExecutionClaim,
  key: ActionClaimKey,
): boolean {
  return actionClaimKeysEqual(claim, key);
}

/**
 * Chain equality: every ActionClaimKey field EXCEPT contextKey
 * (context-lattice §2, amendment A10). The server's lane choice folds in
 * durable context floors the client cannot reproduce, so client routing
 * identifies one logical action by this projection and treats the claim's
 * contextKey as an acceptance question, never an equality component.
 */
export function actionClaimChainKeysEqual(
  left: ActionClaimKey,
  right: ActionClaimKey,
): boolean {
  return left.branch === right.branch && left.space === right.space &&
    left.pieceId === right.pieceId &&
    left.actionId === right.actionId && left.actionKind === right.actionKind &&
    left.implementationFingerprint === right.implementationFingerprint &&
    left.runtimeFingerprint === right.runtimeFingerprint;
}

/**
 * Canonical map key for the chain identity (ActionClaimKey minus
 * contextKey). It reuses the protocol's canonical key encoding with the
 * contextKey pinned to `"space"` as the chain representative, so no second
 * encoding scheme exists and a space-context key's chain map key equals its
 * full map key.
 */
export const actionClaimChainMapKey = (key: ActionClaimKey): string =>
  actionClaimMapKey({ ...key, contextKey: "space" });

/**
 * The client's own lattice chain accept set (context-lattice §2, A10):
 * `{space, user:<principal>, session:<principal>:<sessionId>}`, built
 * exclusively from the canonical key helpers so colon-bearing DID and
 * session-id segments are encoded exactly as issuance encodes them
 * (amendment A18 — naive concatenation never matches). The session member
 * cannot match before C2 issues session-context claims, but the accept set
 * carries it now so a C1-vintage client matches its own session claims the
 * moment they exist.
 */
export function ownChainContextKeys(
  principal: string,
  sessionId: string,
): ReadonlySet<SchedulerExecutionContextKey> {
  return new Set<SchedulerExecutionContextKey>([
    "space",
    userExecutionContextKey(principal),
    sessionExecutionContextKey(principal, sessionId),
  ]);
}

/**
 * Chain-scoped claim acceptance (§2 with A10): the claim names this exact
 * action (chain equality above) AND its contextKey is a member of the
 * client's own chain. A claim naming another principal or session never
 * matches. There is deliberately NO rank comparison against any local floor
 * estimate: a claim broader or narrower within the own lattice still
 * suppresses, which is what gives continuity across lane moves.
 */
export function executionClaimMatchesActionChain(
  claim: ExecutionClaim,
  key: ActionClaimKey,
  ownContextKeys: ReadonlySet<string>,
): boolean {
  return actionClaimChainKeysEqual(claim, key) &&
    ownContextKeys.has(claim.contextKey);
}

/**
 * Fail-closed static preflight for one server-primary action transaction.
 *
 * Passing this check does not grant authority. A claim-ready computation must
 * still pass the per-run transaction firewall and normal ACL/CFC validation.
 * Effects are kept in a separate arm until the W1.4 broker can serve them.
 */
export function classifyStaticActionServability(
  value: unknown,
  servedSpace: MemorySpace,
  lane?: StaticActionServabilityLane,
): StaticActionServability {
  if (!isRecord(value)) {
    return unservable("malformed-candidate");
  }
  const candidate = value as StaticActionServabilityCandidate;
  const actionKind = candidate.actionKind;
  // Amendment 8: user-rank promotion applies to computations only; effects
  // keep space-only checks whatever the lane says.
  const userLane = lane?.userContext === true && actionKind === "computation";
  let userScoped = false;

  if (actionKind === "event-handler") {
    return unservable("event-handler");
  }
  if (actionKind === "ui-binding") {
    return unservable("ui-binding-transaction");
  }
  if (actionKind === "source") {
    return unservable("source-transaction");
  }
  if (typeof actionKind !== "string") {
    return unservable("malformed-candidate");
  }
  if (actionKind !== "computation" && actionKind !== "effect") {
    return unservable("unknown-action-kind");
  }

  if (
    !isNonEmptyString(candidate.ownerSpace) ||
    !isNonEmptyString(candidate.pieceId) ||
    !isNonEmptyString(candidate.implementationFingerprint) ||
    !isNonEmptyString(candidate.runtimeFingerprint)
  ) {
    return unservable("malformed-candidate");
  }
  if (!candidate.implementationFingerprint.startsWith("impl:")) {
    return unservable("untrusted-implementation");
  }
  if (candidate.ownerSpace !== servedSpace) {
    return unservable("foreign-owner-space");
  }
  if (candidate.completeActionScopeSummary === undefined) {
    return unservable(
      actionKind === "effect"
        ? "unknown-effect-surface"
        : "incomplete-static-surface",
    );
  }

  const summary = candidate.completeActionScopeSummary;
  if (
    !isCompleteActionScopeSummary(
      summary,
      candidate.implementationFingerprint,
      candidate.runtimeFingerprint,
    )
  ) {
    return unservable("malformed-static-surface");
  }

  // The action declares exactly ONE logical direct output. Under a user-rank
  // lane the §4 output-widening pair (context-lattice §4, C1.9) declares
  // that one output as its two instances — the broad space address plus the
  // ACTING principal's user instance of the same document path — which
  // collapse to the single logical output; any other plurality stays
  // malformed.
  const directOutput = ((): IMemorySpaceAddress | undefined => {
    const outputs = summary.directOutputs;
    if (outputs.length === 1) return outputs[0];
    if (
      userLane && outputs.length === 2 &&
      scopeOf(outputs[0]!) !== scopeOf(outputs[1]!) &&
      laneInstanceAddressesEqual(outputs[0]!, outputs[1]!)
    ) {
      return outputs.find((output) => scopeOf(output) === "space");
    }
    return undefined;
  })();
  if (directOutput === undefined || !isRootValueAddress(directOutput)) {
    return unservable("malformed-output-surface");
  }
  if (summary.piece.space !== servedSpace) {
    return unservable("foreign-piece-space");
  }
  if (scopeOf(summary.piece) !== "space") {
    if (!userLane || scopeOf(summary.piece) !== "user") {
      return unservable("non-space-piece-scope");
    }
    userScoped = true;
  }
  if (!isRootValueAddress(summary.piece)) {
    return unservable("malformed-static-surface");
  }
  if (`space:${summary.piece.id}` !== candidate.pieceId) {
    return unservable("malformed-static-surface");
  }

  for (const read of summary.reads) {
    if (read.space !== servedSpace) {
      return unservable("foreign-read-space");
    }
    if (scopeOf(read) !== "space") {
      if (!userLane || scopeOf(read) !== "user") {
        return unservable("non-space-read-scope");
      }
      userScoped = true;
    }
  }

  const writes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  for (const write of writes) {
    if (write.space !== servedSpace) {
      return unservable("foreign-write-space");
    }
    if (scopeOf(write) !== "space") {
      if (!userLane || scopeOf(write) !== "user") {
        return unservable("non-space-write-scope");
      }
      userScoped = true;
    }
  }

  // The declared writes must include the direct output. Under a user-rank
  // lane the §4 pair makes the broad address and the acting principal's user
  // instance the same logical output, so the declared write may name either
  // instance of the direct output's document.
  if (
    !summary.writes.some((write) =>
      userLane
        ? laneInstanceAddressesEqual(write, directOutput)
        : addressesEqual(write, directOutput)
    )
  ) {
    return unservable("malformed-output-surface");
  }

  return actionKind === "effect" ? { status: "broker-required", actionKind } : {
    status: "claim-ready",
    actionKind,
    ...(userScoped ? { contextRank: "user" as const } : {}),
  };
}

/**
 * Per-attempt whole-transaction firewall shared by the server executor and
 * cooperative clients. Any unsupported surface rejects the entire authority
 * transfer; callers choose unserved (server) or fail-open upstream (client).
 */
export function dynamicActionTransactionUnservableReason(
  input: ActionTransactionRouteInput,
  observation: SchedulerActionObservation,
  context: ActionTransactionServabilityContext,
): string | undefined {
  const commit = input.commit;
  if (input.space !== context.servedSpace) return "dynamic-foreign-space";
  if (observation.branch !== context.branch) {
    return "dynamic-foreign-branch";
  }
  if (observation.transactionKind !== "action-run") {
    return "dynamic-non-action-transaction";
  }
  if (commit.schedulerObservationBatch !== undefined) {
    return "dynamic-observation-batch";
  }
  if (commit.merge !== undefined) return "dynamic-branch-merge";
  const laneRank = context.contextRank ?? "space";
  for (const read of [...commit.reads.confirmed, ...commit.reads.pending]) {
    if (!laneAdmitsScope(read.scope, laneRank)) {
      return "dynamic-non-space-read-scope";
    }
    if (
      "branch" in read && read.branch !== undefined &&
      read.branch !== context.branch
    ) {
      return "dynamic-foreign-read-branch";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") return "dynamic-sqlite-operation";
    if (!laneAdmitsScope(operation.scope, laneRank)) {
      return "dynamic-non-space-write-scope";
    }
    // §4 backstop, mirroring the engine's broad-instance firewall (memory/v2
    // engine `assertLaneBroadScopeNamingWrite`): a user-rank LANE-ACTING
    // commit may write a broad (space-scoped) document only as the
    // conforming scope-naming redirect link of the output-widening pair. A
    // broad VALUE write means output-scoping failed; routing it would only
    // bounce off the engine. Client suppression mirrors keep this off (see
    // ActionTransactionServabilityContext.laneActingCommit).
    if (
      laneRank === "user" && context.laneActingCommit === true &&
      scopeOf(operation) === "space"
    ) {
      const reason = laneBroadScopeNamingWriteViolation(operation);
      if (reason !== undefined) return reason;
    }
  }
  for (const precondition of commit.preconditions ?? []) {
    if (
      precondition.kind === "entity-absent" &&
      !laneAdmitsScope(precondition.scope, laneRank)
    ) {
      return "dynamic-non-space-write-scope";
    }
  }

  const summary = observation.completeActionScopeSummary;
  if (summary === undefined) return "dynamic-incomplete-static-surface";
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  // Dynamic reads discovered outside the static read envelopes are admitted
  // as long as each stays same-space and space-scoped (checked per address
  // below). Real derived state routinely reads entity documents through
  // links the transformer cannot enumerate; requiring envelope coverage for
  // reads kept most product derivations permanently client-primary. Reads
  // need no envelope bound because authority follows writes: wake
  // correctness follows the per-run actual-read index, and the scope/space
  // constraint is what claims actually promise. Writes remain strictly
  // bounded by their declared envelopes.
  for (const address of [...observation.reads, ...observation.shallowReads]) {
    const reason = dynamicAddressReason(
      address,
      context.servedSpace,
      "read",
      laneRank,
    );
    if (reason !== undefined) return reason;
  }
  // §4 output-widening pair (context-lattice C1.2/C1.9): under a user-rank
  // lane, the certificate's broad direct output covers BOTH legs of the pair
  // — the broad scope-naming redirect link write and the value write at the
  // ACTING principal's user instance of the SAME document. Coverage widens
  // across the space/user instance boundary only, only for direct outputs,
  // and never for session scope (inadmissible until C2). The commit-value
  // backstop above keeps the broad leg an actual scope-naming link.
  const directOutputCovers = (address: IMemorySpaceAddress): boolean =>
    laneRank === "user" &&
    summary.directOutputs.some((envelope) =>
      laneInstanceScope(envelope) && laneInstanceScope(address) &&
      envelope.space === address.space && envelope.id === address.id &&
      envelope.path.length <= address.path.length &&
      envelope.path.every((segment, index) => segment === address.path[index])
    );
  for (
    const address of [
      ...observation.actualChangedWrites,
      ...observation.currentKnownWrites,
      ...(observation.declaredWrites ?? []),
      ...observation.materializerWriteEnvelopes,
      ...(observation.ignoredSchedulingWrites ?? []),
    ]
  ) {
    const reason = dynamicAddressReason(
      address,
      context.servedSpace,
      "write",
      laneRank,
    );
    if (reason !== undefined) return reason;
    if (
      !writeEnvelopes.some((envelope) => covers(envelope, address)) &&
      !directOutputCovers(address)
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") continue;
    if (
      !writeEnvelopes.some((envelope) =>
        envelope.id === operation.id &&
        scopeOf(envelope) === scopeOf(operation)
      ) &&
      !(laneRank === "user" && laneInstanceScope(operation) &&
        summary.directOutputs.some((envelope) =>
          envelope.id === operation.id && laneInstanceScope(envelope)
        ))
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  return undefined;
}

/** The two instances one §4 widening pair may span: the broad space
 * instance and the acting principal's user instance. Session instances stay
 * outside every pair until C2. */
function laneInstanceScope(address: { scope?: CellScope }): boolean {
  const scope = scopeOf(address);
  return scope === "space" || scope === "user";
}

/** §4 pair form of {@link addressesEqual}: under a user-rank lane the broad
 * and user instances of one document path are the same logical output, so
 * equality holds up to the space/user instance boundary. */
function laneInstanceAddressesEqual(
  left: IMemorySpaceAddress,
  right: IMemorySpaceAddress,
): boolean {
  return left.space === right.space &&
    left.id === right.id &&
    laneInstanceScope(left) && laneInstanceScope(right) &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index]);
}

/**
 * Runner-side mirror of the engine's broad-instance scope-naming-link
 * backstop (memory/v2 engine `assertLaneBroadScopeNamingWrite`, C1.2): every
 * broad write a user-rank action commits must be the conforming self-scoping
 * redirect link the output-scoping step emits — validated by the shared wire
 * contract in memory/v2/scope-naming-link.ts. Returns the engine's
 * diagnostic code so the two seams reject identically.
 */
function laneBroadScopeNamingWriteViolation(
  operation: Exclude<
    ActionTransactionRouteInput["commit"]["operations"][number],
    { op: "sqlite" }
  >,
): string | undefined {
  if (operation.op === "delete") return "broad-lane-value-write";
  if (operation.op === "set") {
    const document = (operation.value ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(document)) {
      if (key !== "value") return "broad-lane-value-write";
    }
    return scopeNamingLinkWriteViolation({
      value: document.value as FabricValue | undefined,
      documentPath: ["value"],
      writtenDocId: operation.id,
    })?.code;
  }
  // op === "patch": only exact-position writes can prove the self-redirect
  // property at commit time; positional and merge kinds stay value writes.
  for (const patch of operation.patches) {
    if (patch.op !== "replace" && patch.op !== "add") {
      return "broad-lane-value-write";
    }
    const documentPath = parsePointer(patch.path);
    if (documentPath[0] !== "value") return "broad-lane-value-write";
    const violation = scopeNamingLinkWriteViolation({
      value: patch.value,
      documentPath,
      writtenDocId: operation.id,
    });
    if (violation !== undefined) return violation.code;
  }
  return undefined;
}

function dynamicAddressReason(
  address: IMemorySpaceAddress,
  servedSpace: MemorySpace,
  kind: "read" | "write",
  laneRank: "space" | "user",
): string | undefined {
  if (address.space !== servedSpace) return `dynamic-foreign-${kind}-space`;
  if (!laneAdmitsScope(address.scope, laneRank)) {
    return `dynamic-non-space-${kind}-scope`;
  }
  return undefined;
}

/** A user-rank lane admits the lane principal's user-scoped addresses on top
 * of shared space state; session scope stays inadmissible until C2. */
function laneAdmitsScope(
  scope: CellScope | undefined,
  laneRank: "space" | "user",
): boolean {
  const declared = scope ?? "space";
  return declared === "space" || (laneRank === "user" && declared === "user");
}

function covers(
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean {
  return envelope.space === address.space && envelope.id === address.id &&
    scopeOf(envelope) === scopeOf(address) &&
    envelope.path.length <= address.path.length &&
    envelope.path.every((segment, index) => segment === address.path[index]);
}

function unservable(
  reason: StaticActionUnservableReason,
): StaticActionServability {
  return { status: "unservable", reason };
}

function isCompleteActionScopeSummary(
  value: unknown,
  implementationFingerprint: string,
  runtimeFingerprint: string,
): value is CompleteActionScopeSummary {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    value.complete === true &&
    value.implementationFingerprint === implementationFingerprint &&
    value.runtimeFingerprint === runtimeFingerprint &&
    isAddress(value.piece) &&
    isAddressArray(value.reads) &&
    isAddressArray(value.writes) &&
    isAddressArray(value.materializerWriteEnvelopes) &&
    isAddressArray(value.directOutputs);
}

function isAddressArray(value: unknown): value is IMemorySpaceAddress[] {
  return Array.isArray(value) && value.every(isAddress);
}

function isAddress(value: unknown): value is IMemorySpaceAddress {
  if (!isRecord(value)) return false;
  return !("scopeKey" in value) &&
    !("scope_key" in value) &&
    !("readScopeKey" in value) &&
    !("writeScopeKey" in value) &&
    isNonEmptyString(value.space) &&
    isNonEmptyString(value.id) &&
    (value.type === undefined || typeof value.type === "string") &&
    (value.scope === undefined || value.scope === "space" ||
      value.scope === "user" || value.scope === "session") &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === "string");
}

function isRootValueAddress(address: IMemorySpaceAddress): boolean {
  return address.path.length === 1 && address.path[0] === "value";
}

function addressesEqual(
  left: IMemorySpaceAddress,
  right: IMemorySpaceAddress,
): boolean {
  return left.space === right.space &&
    left.id === right.id &&
    scopeOf(left) === scopeOf(right) &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index]);
}

function scopeOf(address: { scope?: CellScope }): CellScope {
  return address.scope ?? "space";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
