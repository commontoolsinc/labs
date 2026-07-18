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
     * candidate off space rank (context-lattice C1.5a/C2.2): the NARROWEST
     * scope any admitted surface declares — "session" wins over "user"
     * (§2's `space < user < session`), so the C2.5 router can rank-filter
     * candidates (review CA9). Absent means space rank, keeping the
     * space-only result shape byte-identical. */
    contextRank?: "user" | "session";
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
 * C1.5a/C1.6, session rank with C2.2). `userContext` admits user-scoped
 * addresses on computation surfaces — the static classifier then reports
 * `contextRank: "user"` and the dynamic firewall accepts the lane
 * principal's user-scoped reads and writes. `sessionContext` classifies for
 * a session lane, whose admissible scope set is its OWN chain
 * (context-lattice §2: `space < user:<p> < session:<p>:<s>`): session-scoped
 * surfaces AND the lane principal's user-scoped surfaces — the
 * broader-in-chain rule the C2 review mandates (CA3) — so it implies the
 * user admissions whatever `userContext` says, and the reported rank is the
 * narrowest scope observed. Scope is a NAME at this seam: addresses carry
 * no principal or session id (the acting context binds instances at the
 * host/engine seams), so another principal's or session's instance is
 * structurally unnameable here. Absent (or false), both classifiers are
 * byte-identical to the space-only behavior, and effects keep space-only
 * checks in every lane (amendment 8; C2.8 owns lifting it).
 */
export interface StaticActionServabilityLane {
  readonly userContext?: boolean;
  readonly sessionContext?: boolean;
}

/** Internal lane rank shared by the static and dynamic classifiers. */
type LaneRank = "space" | "user" | "session";

export interface ActionTransactionServabilityContext {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  /** Lane rank for the per-attempt firewall; absent means space rank. */
  readonly contextRank?: "space" | "user" | "session";
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
  // Amendment 8: scoped-rank promotion applies to computations only; effects
  // keep space-only checks whatever the lane says (C2.8 owns lifting this).
  // A session lane subsumes the user admissions — its chain includes the
  // principal's user rank (context-lattice §2, review CA3).
  const sessionLane = lane?.sessionContext === true &&
    actionKind === "computation";
  const userLane = sessionLane ||
    (lane?.userContext === true && actionKind === "computation");
  const laneRank: LaneRank = sessionLane
    ? "session"
    : userLane
    ? "user"
    : "space";
  // The narrowest scope any admitted surface declares — the claim-ready
  // contextRank. "session" wins over "user"; undefined means all-space.
  let scopedRank: "user" | "session" | undefined;
  const noteScopedSurface = (scope: CellScope): void => {
    if (scopedRank === "session") return;
    if (scope === "user" || scope === "session") scopedRank = scope;
  };

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

  // The action declares exactly ONE logical direct output. Under a scoped
  // lane the §4 output-widening pair (context-lattice §4, C1.9/C2.2)
  // declares that one output as its two instances — the broad space address
  // plus the ACTING context's scoped instance (the principal's user
  // instance at user rank; the acting session's instance at session rank)
  // of the same document path — which collapse to the single logical
  // output; any other plurality stays malformed.
  const directOutput = ((): IMemorySpaceAddress | undefined => {
    const outputs = summary.directOutputs;
    if (outputs.length === 1) return outputs[0];
    if (
      laneRank !== "space" && outputs.length === 2 &&
      scopeOf(outputs[0]!) !== scopeOf(outputs[1]!) &&
      laneInstanceAddressesEqual(outputs[0]!, outputs[1]!, laneRank)
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
    if (!laneAdmitsScope(summary.piece.scope, laneRank)) {
      return unservable("non-space-piece-scope");
    }
    noteScopedSurface(scopeOf(summary.piece));
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
      if (!laneAdmitsScope(read.scope, laneRank)) {
        return unservable("non-space-read-scope");
      }
      noteScopedSurface(scopeOf(read));
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
      if (!laneAdmitsScope(write.scope, laneRank)) {
        return unservable("non-space-write-scope");
      }
      noteScopedSurface(scopeOf(write));
    }
  }

  // The declared writes must include the direct output. Under a scoped lane
  // the §4 pair makes the broad address and the acting context's scoped
  // instance the same logical output, so the declared write may name either
  // instance of the direct output's document.
  if (
    !summary.writes.some((write) =>
      laneRank !== "space"
        ? laneInstanceAddressesEqual(write, directOutput, laneRank)
        : addressesEqual(write, directOutput)
    )
  ) {
    return unservable("malformed-output-surface");
  }

  return actionKind === "effect" ? { status: "broker-required", actionKind } : {
    status: "claim-ready",
    actionKind,
    ...(scopedRank !== undefined ? { contextRank: scopedRank } : {}),
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
    // engine `assertLaneBroadScopeNamingWrite`): a scoped-rank LANE-ACTING
    // commit may write a broad (space-scoped) document only as the
    // conforming scope-naming redirect link of the output-widening pair. A
    // broad VALUE write means output-scoping failed; routing it would only
    // bounce off the engine. Client suppression mirrors keep this off (see
    // ActionTransactionServabilityContext.laneActingCommit).
    if (
      laneRank !== "space" && context.laneActingCommit === true &&
      scopeOf(operation) === "space"
    ) {
      const reason = laneBroadScopeNamingWriteViolation(operation, laneRank);
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
  // §4 output-widening pair (context-lattice C1.2/C1.9, session rank with
  // C2.2): under a scoped lane, the certificate's broad direct output covers
  // BOTH legs of the pair — the broad scope-naming redirect link write and
  // the value write at the ACTING context's scoped instance of the SAME
  // document. Coverage widens across the lane's own instance boundary only
  // (space/user at user rank; space/user/session at session rank — the
  // chain, CA3) and only for direct outputs. The commit-value backstop
  // above keeps the broad leg an actual scope-naming link.
  const directOutputCovers = (address: IMemorySpaceAddress): boolean =>
    laneRank !== "space" &&
    summary.directOutputs.some((envelope) =>
      laneInstanceScope(envelope, laneRank) &&
      laneInstanceScope(address, laneRank) &&
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
      !(laneRank !== "space" && laneInstanceScope(operation, laneRank) &&
        summary.directOutputs.some((envelope) =>
          envelope.id === operation.id && laneInstanceScope(envelope, laneRank)
        ))
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  return undefined;
}

/** The instances one §4 widening pair may span — the lane's own chain of
 * instance scopes: the broad space instance plus the acting principal's user
 * instance at user rank, plus the acting session's instance at session rank
 * (C2.2). A session instance stays outside every USER-lane pair. */
function laneInstanceScope(
  address: { scope?: CellScope },
  laneRank: LaneRank,
): boolean {
  const scope = scopeOf(address);
  return scope === "space" || scope === "user" ||
    (laneRank === "session" && scope === "session");
}

/** §4 pair form of {@link addressesEqual}: under a scoped lane the broad
 * and acting-instance addresses of one document path are the same logical
 * output, so equality holds up to the lane's instance boundary. */
function laneInstanceAddressesEqual(
  left: IMemorySpaceAddress,
  right: IMemorySpaceAddress,
  laneRank: LaneRank,
): boolean {
  return left.space === right.space &&
    left.id === right.id &&
    laneInstanceScope(left, laneRank) && laneInstanceScope(right, laneRank) &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index]);
}

/**
 * Runner-side mirror of the engine's broad-instance scope-naming-link
 * backstop (memory/v2 engine `assertLaneBroadScopeNamingWrite`, C1.2/C2.2):
 * every broad write a scoped-rank action commits must be the conforming
 * self-scoping redirect link the output-scoping step emits — validated by
 * the shared wire contract in memory/v2/scope-naming-link.ts, parameterized
 * by the lane's rank (a session lane admits links naming its own chain,
 * "user" | "session"; a user lane admits "user" only). Returns the engine's
 * diagnostic code so the two seams reject identically.
 */
function laneBroadScopeNamingWriteViolation(
  operation: Exclude<
    ActionTransactionRouteInput["commit"]["operations"][number],
    { op: "sqlite" }
  >,
  laneScope: "user" | "session",
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
      laneScope,
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
      laneScope,
    });
    if (violation !== undefined) return violation.code;
  }
  return undefined;
}

function dynamicAddressReason(
  address: IMemorySpaceAddress,
  servedSpace: MemorySpace,
  kind: "read" | "write",
  laneRank: LaneRank,
): string | undefined {
  if (address.space !== servedSpace) return `dynamic-foreign-${kind}-space`;
  if (!laneAdmitsScope(address.scope, laneRank)) {
    return `dynamic-non-space-${kind}-scope`;
  }
  return undefined;
}

/** A lane admits the scope names of its OWN chain (context-lattice §2:
 * `space < user < session`): a user-rank lane adds the lane principal's
 * user-scoped addresses on top of shared space state; a session-rank lane
 * adds session-scoped addresses AND keeps the user admissions — the
 * broader-in-chain rule (C2 review CA3). Scoped addresses name only the
 * scope axis, so they always denote the ACTING context's own instances. */
function laneAdmitsScope(
  scope: CellScope | undefined,
  laneRank: LaneRank,
): boolean {
  const declared = scope ?? "space";
  if (declared === "space") return true;
  if (declared === "user") return laneRank === "user" || laneRank === "session";
  return declared === "session" && laneRank === "session";
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
