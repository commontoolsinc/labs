import type { ActionClaimKey, ExecutionClaim } from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CandidateClaim } from "./deno-space-executor.ts";
import {
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import {
  actionClaimKeyFromObservation,
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
  executionClaimMatchesActionKey,
} from "../scheduler/servability.ts";
import type {
  ActionTransactionCommitResult,
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
import { isCellLink, parseLink } from "../link-utils.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("execution.executor", {
  enabled: true,
  level: "error",
});

export interface ExecutorCandidateDiagnostic {
  readonly diagnosticCode: string;
  readonly claimKey?: ActionClaimKey;
}

export type ExecutorActionTransactionPlacement =
  | "shadow"
  | "authoritative";

export interface ExecutorActionTransactionRouterOptions {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  /** The Worker has a narrow host broker for supported builtin effects. */
  readonly builtinBrokerAvailable?: boolean;
  readonly claimForAction: (sourceAction: object) => ExecutionClaim | undefined;
  /** Exact-incarnation permanent broker failure captured synchronously by the
   * Worker. Returning a reason converts the continuation into one canonical
   * observation-only unserved attempt. */
  readonly permanentUnservedReasonForAction?: (
    sourceAction: object,
    claim: ExecutionClaim,
  ) => string | undefined;
  readonly onCandidate: (
    candidate: CandidateClaim,
    sourceAction: object,
  ) => void;
  readonly onDiagnostic?: (diagnostic: ExecutorCandidateDiagnostic) => void;
  /** Bounded Worker-local accounting for complete action transactions whose
   * route was classified as shadow or authoritative. */
  readonly onActionTransaction?: (
    placement: ExecutorActionTransactionPlacement,
  ) => void;
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
  /** Exact attempt readiness after storage accepts an upstream/unserved
   * route, distinct from eventual commit settlement. */
  readonly onAttemptStarted?: (
    claim: ExecutionClaim,
    sourceAction: object,
  ) => void;
  readonly onAttemptSettled?: (
    claim: ExecutionClaim,
    sourceAction: object,
    result: ActionTransactionCommitResult,
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
  // An unclaimed unservable verdict is stable per diagnostic code and
  // fingerprints; the same action rerunning to the same verdict is pure
  // host/feed churn. Cleared when the action becomes a candidate or its
  // claim is invalidated, so a later regression re-reports once.
  const reportedUnservable = new WeakMap<object, string>();
  const builtinSummaries = new WeakMap<object, CompleteActionScopeSummary>();
  const builtinObservationTemplates = new WeakMap<
    object,
    SchedulerActionObservation
  >();
  const reportUnservable = (
    sourceAction: object,
    diagnosticCode: string,
    observation: {
      implementationFingerprint?: unknown;
      runtimeFingerprint?: unknown;
    },
    claimKey?: ActionClaimKey,
  ): void => {
    const encoded = [
      diagnosticCode,
      String(observation.implementationFingerprint ?? ""),
      String(observation.runtimeFingerprint ?? ""),
    ].join("\0");
    if (reportedUnservable.get(sourceAction) === encoded) return;
    reportedUnservable.set(sourceAction, encoded);
    options.onDiagnostic?.({
      diagnosticCode,
      ...(claimKey !== undefined ? { claimKey } : {}),
    });
  };
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
    let synthesizedContinuation = false;
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
        synthesizedContinuation = true;
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
      } else if (sourceAction !== undefined) {
        reportUnservable(sourceAction, "malformed-action-observation", {});
      } else {
        options.onDiagnostic?.({
          diagnosticCode: "malformed-action-observation",
        });
      }
      return local;
    }
    if (sourceAction === undefined) {
      const claimKey = actionClaimKeyFromObservation(observation);
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
      !synthesizedContinuation,
    );
    const routedObservation = input.commit
      .schedulerObservation as SchedulerActionObservation;
    const staticDecision = classifyStaticActionServability(
      routedObservation,
      options.servedSpace,
    );
    const claimKey = actionClaimKeyFromObservation(routedObservation);
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
        reportUnservable(sourceAction, diagnosticCode, routedObservation);
      }
      return local;
    }
    if (
      liveClaim !== undefined &&
      !executionClaimMatchesActionKey(liveClaim, claimKey)
    ) {
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
    const permanentUnservedReason = liveClaim === undefined
      ? undefined
      : options.permanentUnservedReasonForAction?.(sourceAction, liveClaim);
    if (permanentUnservedReason !== undefined) {
      attachClaimAssertion(input.commit, routedObservation, liveClaim!);
      return unservedRoute(
        reported,
        options,
        liveClaim!,
        sourceAction,
        permanentUnservedReason,
      );
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
      reportUnservable(
        sourceAction,
        diagnosticCode,
        routedObservation,
        claimKey,
      );
      return local;
    }
    const dynamicReason = dynamicActionTransactionUnservableReason(
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
      reportUnservable(
        sourceAction,
        dynamicReason,
        routedObservation,
        claimKey,
      );
      return local;
    }
    if (liveClaim === undefined) {
      if (routedObservation.transactionKind === "action-run") {
        options.onActionTransaction?.("shadow");
        logger.debug("execution-server-shadow-action-run", () => [
          "Server shadow action run completed",
          { actionId: claimKey.actionId, actionKind: claimKey.actionKind },
        ]);
      }
      const encoded = JSON.stringify(claimKey);
      return {
        ...local,
        afterLocalApply: () => {
          // The action proved servable; a later unservable regression is new
          // information and must report again.
          reportedUnservable.delete(sourceAction);
          if (reported.get(sourceAction) === encoded) return;
          reported.set(sourceAction, encoded);
          options.onCandidate({
            claimKey,
            ...(builtinId !== undefined ? { builtinId } : {}),
          }, sourceAction);
        },
      };
    }

    attachClaimAssertion(input.commit, routedObservation, liveClaim);
    if (routedObservation.transactionKind === "action-run") {
      options.onActionTransaction?.("authoritative");
      logger.debug("execution-server-authoritative-action-run", () => [
        "Server authoritative action run completed",
        { actionId: liveClaim.actionId, actionKind: liveClaim.actionKind },
      ]);
    }
    return {
      disposition: "upstream",
      ...(options.onAttemptStarted
        ? {
          afterRouteSelected: () =>
            options.onAttemptStarted!(liveClaim, sourceAction),
        }
        : {}),
      ...(options.onAttemptSettled
        ? {
          onCommitSettled: (result: ActionTransactionCommitResult) =>
            options.onAttemptSettled!(liveClaim, sourceAction, result),
        }
        : {}),
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
  refreshFromActionRun: boolean,
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
      ]),
      materializerWriteEnvelopes: dedupeAddresses(
        observation.materializerWriteEnvelopes,
      ),
      directOutputs: dedupeAddresses(
        descriptor.directOutputs.map(toMemorySpaceAddress),
      ),
    };
    summaries.set(sourceAction, summary);
  } else if (refreshFromActionRun) {
    // Supported builtin actions retain one sourceAction across reruns. Their
    // trusted runtimeWrites array can grow as lazy internal cells are minted,
    // and a later input may exercise framework/CFC reads not present in the
    // first run. Refresh the certificate with the same trusted descriptor and
    // canonical commit surfaces used for the initial candidate; otherwise the
    // second claimed request is rejected as an unobserved read and loops
    // revoke/reclaim without ever reaching the broker.
    summary = {
      ...summary,
      reads: dedupeAddresses([
        ...summary.reads,
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
        ...summary.writes,
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
    };
    summaries.set(sourceAction, summary);
  }
  if (refreshFromActionRun) templates.set(sourceAction, observation);
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
  const materializedDocuments = sameTransactionMaterializedDocuments(
    input,
    summary,
  );
  if (
    canonicalSchemaWrites.length > 0 || materializedDocuments.length > 0
  ) {
    // CFC persistence may materialize a content-addressed schema document only
    // when an async model result is written. Its id can depend on the result's
    // post-call confidentiality envelope, so it cannot always be listed by the
    // pre-call builtin descriptor. Structured builtin results may likewise
    // split fresh entity documents that are linked from an already-authorized
    // write in this same transaction. Admit only canonical schema documents or
    // fresh same-transaction linked materializations; all semantic writes
    // remain bounded by the descriptor's pre-effect surface.
    summary = {
      ...summary,
      reads: dedupeAddresses([...summary.reads, ...materializedDocuments]),
      writes: dedupeAddresses([
        ...summary.writes,
        ...canonicalSchemaWrites,
        ...materializedDocuments,
      ]),
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

/**
 * Return fresh entity documents materialized by a claimed builtin
 * continuation. A document is admitted only when all of these hold:
 *
 * - an already-authorized operation contains a direct link to it;
 * - the same commit creates it with a whole-document set; and
 * - the commit proves absence with seq-0 document reads.
 *
 * Following links transitively supports arrays/objects split across multiple
 * fresh documents without turning an arbitrary side write into a declared
 * surface.
 */
function sameTransactionMaterializedDocuments(
  input: ActionTransactionRouteInput,
  summary: CompleteActionScopeSummary,
): IMemorySpaceAddress[] {
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  const operationKey = (operation: {
    id: string;
    scope?: "space" | "user" | "session";
  }) => `${operation.scope ?? "space"}:${operation.id}`;
  const provesFreshDocument = (operation: {
    id: string;
    scope?: "space" | "user" | "session";
  }): boolean => {
    const reads = input.commit.reads.confirmed.filter((read) =>
      read.id === operation.id &&
      (read.scope ?? "space") === (operation.scope ?? "space") &&
      read.seq === 0
    );
    return reads.some((read) => read.path.length === 0) ||
      ["cfc", "value"].every((field) =>
        reads.some((read) => read.path.length === 1 && read.path[0] === field)
      );
  };
  const freshSetOperations = new Map(
    input.commit.operations.flatMap((operation) => {
      if (
        operation.op !== "set" ||
        (operation.scope ?? "space") !== "space" ||
        !operation.id.startsWith("of:") ||
        !provesFreshDocument(operation)
      ) {
        return [];
      }
      return [[operationKey(operation), operation] as const];
    }),
  );
  const materialized = new Map<string, IMemorySpaceAddress>();
  const pendingValues: Array<{
    value: unknown;
    base: IMemorySpaceAddress;
  }> = [];

  const enqueueOperationValues = (
    operation: ActionTransactionRouteInput["commit"]["operations"][number],
  ): void => {
    if (operation.op === "sqlite") return;
    const base = addressOf({
      space: input.space,
      id: operation.id,
      scope: operation.scope ?? "space",
      path: [],
    });
    if (operation.op === "set") {
      pendingValues.push({ value: operation.value, base });
    } else if (operation.op === "patch") {
      for (const patch of operation.patches) {
        if ("value" in patch) pendingValues.push({ value: patch.value, base });
        if (patch.op === "splice") {
          pendingValues.push({ value: patch.add, base });
        }
      }
    }
  };

  for (const operation of input.commit.operations) {
    if (operation.op === "sqlite") continue;
    const operationAddress = addressOf({
      space: input.space,
      id: operation.id,
      scope: operation.scope ?? "space",
      path: [],
    });
    if (
      writeEnvelopes.some((envelope) =>
        envelope.id === operationAddress.id &&
        (envelope.scope ?? "space") === operationAddress.scope
      )
    ) {
      enqueueOperationValues(operation);
    }
  }

  const visit = (value: unknown, base: IMemorySpaceAddress): void => {
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (
        link?.space !== input.space || link.path.length !== 0 ||
        (link.scope ?? "space") !== "space"
      ) return;
      const key = `space:${link.id}`;
      const setOperation = freshSetOperations.get(key);
      if (setOperation === undefined || materialized.has(key)) return;
      materialized.set(key, addressOf({ ...link, path: [] }));
      enqueueOperationValues(setOperation);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, base);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) visit(entry, base);
    }
  };

  for (let index = 0; index < pendingValues.length; index++) {
    const pending = pendingValues[index]!;
    visit(pending.value, pending.base);
  }
  return [...materialized.values()];
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
    ...(options.onAttemptStarted
      ? {
        afterRouteSelected: () =>
          options.onAttemptStarted!(claim, sourceAction),
      }
      : {}),
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
