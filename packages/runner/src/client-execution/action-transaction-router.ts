import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  isSchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import {
  actionClaimKeyFromObservation,
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
  executionClaimMatchesActionChain,
} from "../scheduler/servability.ts";
import type {
  ActionTransactionRoute,
  ActionTransactionRouteInput,
} from "../storage/v2.ts";

export interface ClientActionRouteDiagnostic {
  readonly diagnosticCode: string;
  readonly claim: ExecutionClaim;
}

/**
 * Named fail-open counter for the state issuance-side routing disjointness
 * is meant to make impossible: two live claims matching one action on the
 * client's own chain (amendment A3). Observing it means the client computed
 * locally instead of picking a claim; it must be counted, never silent.
 */
export const DUAL_CHAIN_CLAIM_MATCH_DIAGNOSTIC = "dual-chain-claim-match";

export interface ClientActionTransactionRouteOptions {
  readonly claims: readonly ExecutionClaim[];
  /**
   * The client's own lattice chain accept set — build it with
   * `ownChainContextKeys` (context-lattice §2, A10): `{space, user:<myDid>,
   * session:<myDid>:<mySessionId>}` in canonical encoding. Claims outside
   * this set never match.
   */
  readonly ownContextKeys: ReadonlySet<string>;
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
 *
 * Matching is chain-scoped (context-lattice §2, amendment A10): the claim is
 * identified by the ActionClaimKey minus contextKey, then accepted iff its
 * contextKey is a member of the client's own chain. There is deliberately no
 * rank comparison against any local floor estimate — the server's lane
 * choice folds in durable floors the client cannot see.
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
  const matches = options.claims.filter((candidate) =>
    executionClaimMatchesActionChain(candidate, key, options.ownContextKeys)
  );
  if (matches.length === 0) return upstream;
  if (matches.length > 1) {
    // Amendment A3: two live chain-matching claims should be impossible
    // under issuance-side routing disjointness. If ever observed, route to
    // NEITHER — the client computes (fail open) — under a named diagnostic
    // rather than a silent tie-break.
    options.onDiagnostic?.({
      diagnosticCode: DUAL_CHAIN_CLAIM_MATCH_DIAGNOSTIC,
      claim: matches[0]!,
    });
    return upstream;
  }
  const claim = matches[0]!;

  if (claim.actionKind === "effect" && options.builtinPassivity !== true) {
    return upstream;
  }
  // Both servability firewalls are lane-parameterized by the ACCEPTED
  // claim's contextKey (amendments A15/A19): a user- or session-context
  // claim admits the lane principal's user-scoped surfaces. Session rank
  // maps onto the user parameterization until C2 teaches the classifiers
  // session scope — session-scoped surfaces keep failing open below, a
  // conservative subset of the session lane's authority. A space claim
  // keeps both classifiers byte-identical to the space-only behavior.
  const claimRank = claim.contextKey === "space" ? "space" : "user";
  const staticDecision = classifyStaticActionServability(
    observation,
    input.space,
    claimRank === "user" ? { userContext: true } : undefined,
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
    { servedSpace: input.space, branch: claim.branch, contextRank: claimRank },
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
