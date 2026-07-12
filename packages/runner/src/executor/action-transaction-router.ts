import type {
  ActionClaimKey,
  CellScope,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CandidateClaim } from "./deno-space-executor.ts";
import {
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import { classifyStaticActionServability } from "../scheduler/servability.ts";
import type {
  ActionTransactionRoute,
  ActionTransactionRouteInput,
  ActionTransactionRouter,
} from "../storage/v2.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { toMemorySpaceAddress } from "../link-types.ts";
import type { TelemetryAnnotations } from "../scheduler/types.ts";
import type { CompleteActionScopeSummary } from "../scheduler/persistent-observation.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "../builder/types.ts";
import { touchedPointerPaths } from "../../../memory/v2/patch.ts";
import {
  isServerExecutableBuiltinId,
  type ServerBuiltinActionDescriptor,
  serverBuiltinImplementationHash,
} from "../builtins/server-execution.ts";

export interface ExecutorCandidateDiagnostic {
  readonly diagnosticCode: string;
  readonly claimKey?: ActionClaimKey;
}

export interface ExecutorActionTransactionRouterOptions {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  /** The Worker has a narrow host broker for supported builtin effects. */
  readonly builtinBrokerAvailable?: boolean;
  readonly claimForAction: (sourceAction: object) => ExecutionClaim | undefined;
  readonly onCandidate: (
    candidate: CandidateClaim,
    sourceAction: object,
  ) => void;
  readonly onDiagnostic?: (diagnostic: ExecutorCandidateDiagnostic) => void;
  readonly onUnserved?: (
    claim: ExecutionClaim,
    sourceAction: object,
    diagnosticCode: string,
  ) => void;
  readonly onInvalidated?: (
    claim: ExecutionClaim,
    sourceAction: object,
    diagnosticCode: string,
  ) => void;
}

/**
 * Route complete executor action transactions. The first proven run stays in
 * the private shadow overlay and reports a CandidateClaim. Once the host sends
 * back an exact claim for that action object, the same router attaches its
 * transient assertion and admits only that whole transaction upstream.
 */
export function createExecutorActionTransactionRouter(
  options: ExecutorActionTransactionRouterOptions,
): ActionTransactionRouter {
  const reported = new WeakMap<object, string>();
  const builtinSummaries = new WeakMap<object, CompleteActionScopeSummary>();
  const builtinObservationTemplates = new WeakMap<
    object,
    SchedulerActionObservation
  >();
  const local = {
    disposition: "local",
    kind: "executor-shadow",
  } as const satisfies ActionTransactionRoute;

  return (input: ActionTransactionRouteInput) => {
    const sourceAction = input.sourceAction;
    const liveClaim = sourceAction === undefined
      ? undefined
      : options.claimForAction(sourceAction);
    let observation = input.commit.schedulerObservation;
    if (
      !isSchedulerActionObservation(observation) &&
      sourceAction !== undefined && liveClaim !== undefined
    ) {
      const continuation = synthesizeBuiltinContinuationObservation(
        input,
        sourceAction,
        builtinSummaries,
        builtinObservationTemplates,
      );
      if (continuation !== undefined) {
        input.commit.schedulerObservation = continuation;
        observation = continuation;
      }
    }
    if (!isSchedulerActionObservation(observation)) {
      if (sourceAction !== undefined && liveClaim !== undefined) {
        invalidateClaim(
          reported,
          options,
          liveClaim,
          sourceAction,
          "malformed-action-observation",
        );
      } else {
        options.onDiagnostic?.({
          diagnosticCode: "malformed-action-observation",
        });
      }
      return local;
    }
    if (sourceAction === undefined) {
      const claimKey = safeActionClaimKey(observation);
      options.onDiagnostic?.({
        diagnosticCode: "missing-source-action",
        ...(claimKey !== undefined ? { claimKey } : {}),
      });
      return local;
    }
    const builtinId = prepareSupportedBuiltinObservation(
      input,
      observation,
      sourceAction,
      builtinSummaries,
      builtinObservationTemplates,
    );
    const routedObservation = input.commit
      .schedulerObservation as SchedulerActionObservation;
    const staticDecision = classifyStaticActionServability(
      routedObservation,
      options.servedSpace,
    );
    const claimKey = safeActionClaimKey(routedObservation);
    if (claimKey === undefined) {
      const diagnosticCode = staticDecision.status === "unservable"
        ? staticDecision.reason
        : "malformed-candidate";
      if (liveClaim !== undefined) {
        invalidateClaim(
          reported,
          options,
          liveClaim,
          sourceAction,
          diagnosticCode,
        );
      } else {
        options.onDiagnostic?.({ diagnosticCode });
      }
      return local;
    }
    if (liveClaim !== undefined && !claimMatchesKey(liveClaim, claimKey)) {
      invalidateClaim(
        reported,
        options,
        liveClaim,
        sourceAction,
        "claim-key-mismatch",
        claimKey,
      );
      return local;
    }
    const brokeredBuiltinReady = staticDecision.status === "broker-required" &&
      options.builtinBrokerAvailable === true && builtinId !== undefined;
    if (staticDecision.status !== "claim-ready" && !brokeredBuiltinReady) {
      const diagnosticCode = staticDecision.status === "broker-required"
        ? options.builtinBrokerAvailable === true
          ? "unsupported-server-builtin"
          : "broker-required"
        : staticDecision.reason;
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, routedObservation, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          diagnosticCode,
        );
      }
      options.onDiagnostic?.({ diagnosticCode, claimKey });
      return local;
    }
    const dynamicReason = dynamicUnservableReason(
      input,
      routedObservation,
      options,
    );
    if (dynamicReason !== undefined) {
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, routedObservation, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          dynamicReason,
        );
      }
      options.onDiagnostic?.({ diagnosticCode: dynamicReason, claimKey });
      return local;
    }
    if (liveClaim === undefined) {
      const encoded = JSON.stringify(claimKey);
      if (reported.get(sourceAction) !== encoded) {
        reported.set(sourceAction, encoded);
        options.onCandidate({
          claimKey,
          ...(builtinId !== undefined ? { builtinId } : {}),
        }, sourceAction);
      }
      return local;
    }

    attachClaimAssertion(input.commit, routedObservation, liveClaim);
    return {
      disposition: "upstream",
      ...(options.onUnserved
        ? {
          onFirewallRejected: (diagnosticCode: string) => {
            reported.delete(sourceAction);
            options.onUnserved!(
              liveClaim,
              sourceAction,
              diagnosticCode,
            );
          },
        }
        : {}),
    };
  };
}

function prepareSupportedBuiltinObservation(
  input: ActionTransactionRouteInput,
  observation: SchedulerActionObservation,
  sourceAction: object,
  summaries: WeakMap<object, CompleteActionScopeSummary>,
  templates: WeakMap<object, SchedulerActionObservation>,
):
  | import("../builtins/server-execution.ts").ServerExecutableBuiltinId
  | undefined {
  const descriptor = supportedBuiltinDescriptor(sourceAction, observation);
  if (descriptor === undefined) return undefined;

  let summary = summaries.get(sourceAction);
  if (summary === undefined) {
    summary = {
      version: 1,
      complete: true,
      implementationFingerprint: observation.implementationFingerprint,
      runtimeFingerprint: observation.runtimeFingerprint,
      piece: toMemorySpaceAddress(descriptor.piece),
      reads: dedupeAddresses([
        ...descriptor.reads.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.reads,
        ...observation.shallowReads,
        ...commitReadAddresses(input),
      ]),
      writes: dedupeAddresses([
        ...descriptor.writes.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.actualChangedWrites,
        ...observation.currentKnownWrites,
        ...(observation.declaredWrites ?? []),
        ...observation.materializerWriteEnvelopes,
        ...(observation.ignoredSchedulingWrites ?? []),
        ...commitWriteAddresses(input),
      ]),
      materializerWriteEnvelopes: dedupeAddresses(
        observation.materializerWriteEnvelopes,
      ),
      directOutputs: dedupeAddresses(
        descriptor.directOutputs.map(toMemorySpaceAddress),
      ),
    };
    summaries.set(sourceAction, summary);
    templates.set(sourceAction, observation);
  }
  input.commit.schedulerObservation = {
    ...observation,
    completeActionScopeSummary: summary,
  };
  return descriptor.id;
}

function supportedBuiltinDescriptor(
  sourceAction: object,
  observation: SchedulerActionObservation,
): ServerBuiltinActionDescriptor | undefined {
  const descriptor = (sourceAction as Partial<TelemetryAnnotations>)
    .serverBuiltin;
  if (
    descriptor?.version !== 1 ||
    !isServerExecutableBuiltinId(descriptor.id) ||
    observation.actionKind !== "effect" ||
    observation.implementationFingerprint !==
      `impl:${serverBuiltinImplementationHash(descriptor.id)}` ||
    !isAddressLike(descriptor.piece) ||
    !Array.isArray(descriptor.reads) ||
    !descriptor.reads.every(isAddressLike) ||
    !Array.isArray(descriptor.writes) ||
    !descriptor.writes.every(isAddressLike) ||
    !Array.isArray(descriptor.runtimeWrites) ||
    !descriptor.runtimeWrites.every(isAddressLike) ||
    !Array.isArray(descriptor.directOutputs) ||
    !descriptor.directOutputs.every(isAddressLike)
  ) {
    return undefined;
  }
  return descriptor;
}

function synthesizeBuiltinContinuationObservation(
  input: ActionTransactionRouteInput,
  sourceAction: object,
  summaries: WeakMap<object, CompleteActionScopeSummary>,
  templates: WeakMap<object, SchedulerActionObservation>,
): SchedulerActionObservation | undefined {
  let summary = summaries.get(sourceAction);
  const template = templates.get(sourceAction);
  if (summary === undefined || template === undefined) return undefined;
  const writes = commitWriteAddresses(input);
  const canonicalSchemaWrites = canonicalSchemaDocumentWriteAddresses(input);
  if (canonicalSchemaWrites.length > 0) {
    // CFC persistence may materialize a content-addressed schema document only
    // when an async model result is written. Its id can depend on the result's
    // post-call confidentiality envelope, so it cannot always be listed by the
    // pre-call builtin descriptor. Admit only a set operation whose payload
    // re-hashes to the claimed cid; all semantic writes remain bounded by the
    // descriptor's pre-effect surface.
    summary = {
      ...summary,
      writes: dedupeAddresses([...summary.writes, ...canonicalSchemaWrites]),
    };
    summaries.set(sourceAction, summary);
  }
  return {
    ...template,
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: commitReadAddresses(input),
    shallowReads: [],
    actualChangedWrites: writes,
    currentKnownWrites: summary.writes,
    materializerWriteEnvelopes: summary.materializerWriteEnvelopes,
    completeActionScopeSummary: summary,
    status: "success",
    executionClaimAssertion: undefined,
  };
}

function canonicalSchemaDocumentWriteAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return input.commit.operations.flatMap((operation) => {
    if (
      operation.op !== "set" ||
      (operation.scope ?? "space") !== "space" ||
      !operation.id.startsWith("cid:") ||
      Object.keys(operation.value).some((key) => key !== "value") ||
      operation.value.value === undefined
    ) {
      return [];
    }
    try {
      if (
        internSchemaAsTaggedHashString(
          operation.value.value as JSONSchema,
        ) !== operation.id.slice("cid:".length)
      ) {
        return [];
      }
    } catch {
      return [];
    }
    return [addressOf({
      space: input.space,
      id: operation.id,
      scope: "space",
      path: ["value"],
    })];
  });
}

function commitReadAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return [...input.commit.reads.confirmed, ...input.commit.reads.pending].map(
    (read) =>
      addressOf({
        space: input.space,
        id: read.id,
        scope: read.scope ?? "space",
        path: [...read.path],
      }),
  );
}

function commitWriteAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return input.commit.operations.flatMap((operation) => {
    if (operation.op === "sqlite") return [];
    const paths = operation.op === "patch"
      ? operation.patches.flatMap(touchedPointerPaths)
      : operation.op === "delete"
      ? [[]]
      : [["value"]];
    return paths.map((path) =>
      addressOf({
        space: input.space,
        id: operation.id,
        scope: operation.scope ?? "space",
        path,
      })
    );
  });
}

function dedupeAddresses(
  values: readonly (IMemorySpaceAddress | {
    space: string;
    id: string;
    path: readonly string[];
    scope?: "space" | "user" | "session";
    type?: string;
  })[],
): IMemorySpaceAddress[] {
  const result = new Map<string, IMemorySpaceAddress>();
  for (const value of values) {
    const address = addressOf(value);
    result.set(
      JSON.stringify([
        address.space,
        address.id,
        address.scope ?? "space",
        address.path,
      ]),
      address,
    );
  }
  return [...result.values()];
}

function addressOf(value: {
  space: string;
  id: string;
  path: readonly string[];
  scope?: "space" | "user" | "session";
  type?: string;
}): IMemorySpaceAddress {
  return {
    space: value.space as MemorySpace,
    id: value.id as IMemorySpaceAddress["id"],
    scope: value.scope ?? "space",
    path: [...value.path],
    ...(value.type !== undefined
      ? { type: value.type as IMemorySpaceAddress["type"] }
      : {}),
  };
}

function isAddressLike(value: unknown): value is {
  space: string;
  id: string;
  path: string[];
  scope?: "space" | "user" | "session";
  type?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const address = value as Record<string, unknown>;
  return typeof address.space === "string" && address.space.length > 0 &&
    typeof address.id === "string" && address.id.length > 0 &&
    Array.isArray(address.path) &&
    address.path.every((segment) => typeof segment === "string") &&
    (address.scope === undefined || address.scope === "space" ||
      address.scope === "user" || address.scope === "session");
}

function invalidateClaim(
  reported: WeakMap<object, string>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
  claimKey?: ActionClaimKey,
): void {
  reported.delete(sourceAction);
  if (options.onInvalidated !== undefined) {
    options.onInvalidated(claim, sourceAction, diagnosticCode);
  } else {
    options.onDiagnostic?.({
      diagnosticCode,
      ...(claimKey !== undefined ? { claimKey } : {}),
    });
  }
}

function unservedRoute(
  reported: WeakMap<object, string>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
): ActionTransactionRoute {
  return {
    disposition: "unserved",
    diagnosticCode,
    ...(options.onUnserved
      ? {
        onSettled: () => {
          reported.delete(sourceAction);
          options.onUnserved!(claim, sourceAction, diagnosticCode);
        },
      }
      : {}),
  };
}

function attachClaimAssertion(
  commit: ActionTransactionRouteInput["commit"],
  observation: SchedulerActionObservation,
  claim: ExecutionClaim,
): void {
  commit.schedulerObservation = {
    ...observation,
    executionClaimAssertion: {
      contextKey: claim.contextKey,
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
    },
  };
}

function safeActionClaimKey(
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

function dynamicUnservableReason(
  input: ActionTransactionRouteInput,
  observation: SchedulerActionObservation,
  options: ExecutorActionTransactionRouterOptions,
): string | undefined {
  const commit = input.commit;
  if (input.space !== options.servedSpace) return "dynamic-foreign-space";
  if (observation.branch !== options.branch) return "dynamic-foreign-branch";
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
      read.branch !== options.branch
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

  const summary = observation.completeActionScopeSummary!;
  const readEnvelopes = summary.reads;
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  for (const address of [...observation.reads, ...observation.shallowReads]) {
    const reason = addressReason(address, options.servedSpace, "read");
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
    const reason = addressReason(address, options.servedSpace, "write");
    if (reason !== undefined) return reason;
    if (!writeEnvelopes.some((envelope) => covers(envelope, address))) {
      return "dynamic-write-outside-static-surface";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") continue;
    if (
      !writeEnvelopes.some((envelope) =>
        envelope.id === operation.id && scopeOf(envelope) === scopeOf(operation)
      )
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  return undefined;
}

function addressReason(
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

function scopeOf(value: { scope?: CellScope }): CellScope {
  return value.scope ?? "space";
}

function claimMatchesKey(
  claim: ExecutionClaim,
  key: ActionClaimKey,
): boolean {
  return claim.branch === key.branch && claim.space === key.space &&
    claim.contextKey === key.contextKey && claim.pieceId === key.pieceId &&
    claim.actionId === key.actionId && claim.actionKind === key.actionKind &&
    claim.implementationFingerprint === key.implementationFingerprint &&
    claim.runtimeFingerprint === key.runtimeFingerprint;
}
