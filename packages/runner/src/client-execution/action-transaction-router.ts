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
  // claim's contextKey (amendments A15/A19; session rank with C2.5). A
  // session-context claim classifies with the session lane — its chain
  // includes the principal's user rank, so `sessionContext` implies the
  // user admissions (CA3's broader-in-chain rule) — a user-context claim
  // with the user lane, and a space claim keeps both classifiers
  // byte-identical to the space-only behavior. The accepted claim is
  // already chain-scoped to the client's OWN session (ownContextKeys
  // above), so the session parameterization always names this client's
  // acting session — never a sibling's.
  const claimRank: "space" | "user" | "session" = claim.contextKey === "space"
    ? "space"
    : claim.contextKey.startsWith("session:")
    ? "session"
    : "user";
  // C3.9: the cross-space-claims-v1 suppression. A host-issued claim whose
  // `crossSpaceReadSpaces` is present and non-empty certifies that the host
  // bound the acting principal's READ on those foreign spaces at issuance —
  // the negotiating client TRUSTS that claim and admits the foreign read at
  // both firewalls (the C3.6 stage flag, gated on the claim rather than a
  // build dial), routing the whole action to a claimed overlay so it DEFERS
  // to the host's claimed commit instead of running the foreign-read
  // derivation client-primary fail-open (the C3.6 CA4 posture). Absent or
  // empty keeps every foreign read unservable and byte-identical to pre-C3.9:
  // a mixed-fleet client without the claim still computes it locally. This is
  // orthogonal to lane rank — a claim of any context rank may name foreign
  // reads (servability.ts `crossSpaceRead` is a stage, never a fifth lane).
  const claimCoversCrossSpaceRead = claim.crossSpaceReadSpaces !== undefined &&
    claim.crossSpaceReadSpaces.length > 0;
  const staticDecision = classifyStaticActionServability(
    observation,
    input.space,
    claimRank === "session"
      ? { sessionContext: true }
      : claimRank === "user"
      ? { userContext: true }
      : undefined,
    claimCoversCrossSpaceRead,
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
    {
      servedSpace: input.space,
      branch: claim.branch,
      contextRank: claimRank,
      crossSpaceRead: claimCoversCrossSpaceRead,
    },
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
