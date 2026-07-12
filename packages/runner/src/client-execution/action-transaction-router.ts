import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  isSchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import {
  actionClaimKeyFromObservation,
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
  executionClaimMatchesActionKey,
} from "../scheduler/servability.ts";
import type {
  ActionTransactionRoute,
  ActionTransactionRouteInput,
} from "../storage/v2.ts";

export interface ClientActionRouteDiagnostic {
  readonly diagnosticCode: string;
  readonly claim: ExecutionClaim;
}

export interface ClientActionTransactionRouteOptions {
  readonly claims: readonly ExecutionClaim[];
  readonly builtinPassivity?: boolean;
  readonly onDiagnostic?: (diagnostic: ClientActionRouteDiagnostic) => void;
}

const upstream = {
  disposition: "upstream",
} as const satisfies ActionTransactionRoute;

/**
 * Route one cooperative client action transaction from an already-integrated
 * claim snapshot. This function is deliberately synchronous: the ordinary
 * optimistic write contract applies pending versions before commit() returns.
 */
export function routeClientActionTransaction(
  input: ActionTransactionRouteInput,
  options: ClientActionTransactionRouteOptions,
): ActionTransactionRoute {
  if (input.sourceAction === undefined) return upstream;
  const observation = input.commit.schedulerObservation;
  if (!isSchedulerActionObservation(observation)) return upstream;
  const key = actionClaimKeyFromObservation(observation);
  if (key === undefined) return upstream;
  const claim = options.claims.find((candidate) =>
    executionClaimMatchesActionKey(candidate, key)
  );
  if (claim === undefined) return upstream;

  if (claim.actionKind === "effect" && options.builtinPassivity !== true) {
    return upstream;
  }
  const staticDecision = classifyStaticActionServability(
    observation,
    input.space,
  );
  const expectedStaticStatus = claim.actionKind === "effect"
    ? "broker-required"
    : "claim-ready";
  if (staticDecision.status !== expectedStaticStatus) {
    options.onDiagnostic?.({
      diagnosticCode: staticDecision.status === "unservable"
        ? staticDecision.reason
        : "claim-kind-mismatch",
      claim,
    });
    return upstream;
  }

  const diagnosticCode = dynamicActionTransactionUnservableReason(
    input,
    observation,
    { servedSpace: input.space, branch: claim.branch },
  );
  if (diagnosticCode !== undefined) {
    options.onDiagnostic?.({ diagnosticCode, claim });
    return upstream;
  }
  return {
    disposition: "local",
    kind: "claimed-overlay",
    claim,
  };
}
