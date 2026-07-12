import type {
  ActionClaimKey,
  CellScope,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
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
  }
  | {
    status: "broker-required";
    actionKind: "effect";
  }
  | {
    status: "unservable";
    reason: StaticActionUnservableReason;
  };

export interface ActionTransactionServabilityContext {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
}

/**
 * Derive the exact client/server shared action identity. Host-authored
 * provenance and lease generations deliberately do not participate.
 */
export function actionClaimKeyFromObservation(
  observation: SchedulerActionObservation,
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
    contextKey: "space",
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
 * Fail-closed static preflight for one server-primary action transaction.
 *
 * Passing this check does not grant authority. A claim-ready computation must
 * still pass the per-run transaction firewall and normal ACL/CFC validation.
 * Effects are kept in a separate arm until the W1.4 broker can serve them.
 */
export function classifyStaticActionServability(
  value: unknown,
  servedSpace: MemorySpace,
): StaticActionServability {
  if (!isRecord(value)) {
    return unservable("malformed-candidate");
  }
  const candidate = value as StaticActionServabilityCandidate;
  const actionKind = candidate.actionKind;

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

  if (
    summary.directOutputs.length !== 1 ||
    !isRootValueAddress(summary.directOutputs[0]!)
  ) {
    return unservable("malformed-output-surface");
  }
  if (summary.piece.space !== servedSpace) {
    return unservable("foreign-piece-space");
  }
  if (scopeOf(summary.piece) !== "space") {
    return unservable("non-space-piece-scope");
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
      return unservable("non-space-read-scope");
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
      return unservable("non-space-write-scope");
    }
  }

  const directOutput = summary.directOutputs[0]!;
  if (!summary.writes.some((write) => addressesEqual(write, directOutput))) {
    return unservable("malformed-output-surface");
  }

  return actionKind === "effect"
    ? { status: "broker-required", actionKind }
    : { status: "claim-ready", actionKind };
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
  for (const read of [...commit.reads.confirmed, ...commit.reads.pending]) {
    if ((read.scope ?? "space") !== "space") {
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
    if ((operation.scope ?? "space") !== "space") {
      return "dynamic-non-space-write-scope";
    }
  }
  for (const precondition of commit.preconditions ?? []) {
    if (
      precondition.kind === "entity-absent" &&
      (precondition.scope ?? "space") !== "space"
    ) {
      return "dynamic-non-space-write-scope";
    }
  }

  const summary = observation.completeActionScopeSummary;
  if (summary === undefined) return "dynamic-incomplete-static-surface";
  const readEnvelopes = summary.reads;
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  for (const address of [...observation.reads, ...observation.shallowReads]) {
    const reason = dynamicAddressReason(address, context.servedSpace, "read");
    if (reason !== undefined) return reason;
    if (!readEnvelopes.some((envelope) => covers(envelope, address))) {
      return "dynamic-read-outside-static-surface";
    }
  }
  for (
    const address of [
      ...observation.actualChangedWrites,
      ...observation.currentKnownWrites,
      ...(observation.declaredWrites ?? []),
      ...observation.materializerWriteEnvelopes,
      ...(observation.ignoredSchedulingWrites ?? []),
    ]
  ) {
    const reason = dynamicAddressReason(address, context.servedSpace, "write");
    if (reason !== undefined) return reason;
    if (!writeEnvelopes.some((envelope) => covers(envelope, address))) {
      return "dynamic-write-outside-static-surface";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") continue;
    if (
      !writeEnvelopes.some((envelope) =>
        envelope.id === operation.id &&
        scopeOf(envelope) === scopeOf(operation)
      )
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  return undefined;
}

function dynamicAddressReason(
  address: IMemorySpaceAddress,
  servedSpace: MemorySpace,
  kind: "read" | "write",
): string | undefined {
  if (address.space !== servedSpace) return `dynamic-foreign-${kind}-space`;
  if (scopeOf(address) !== "space") {
    return `dynamic-non-space-${kind}-scope`;
  }
  return undefined;
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
