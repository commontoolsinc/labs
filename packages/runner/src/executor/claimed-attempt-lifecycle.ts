import {
  type ExecutionClaim,
  executionClaimIncarnationKey,
} from "@commonfabric/memory/v2";
import type { ActionCommitRejectionDisposition } from "../scheduler/run.ts";
import {
  isExecutionLeaseFenceRejection,
  isPermanentRejection,
  isTerminalRejection,
} from "../storage/rejection.ts";

export type ClaimedAttemptRouteReadiness = "routed" | "released";

export interface ClaimedAttemptHandle {
  /** Resolves only after storage selects the exact upstream/unserved route, or
   * with `released` when authority ends before that can happen. */
  routeReady: Promise<ClaimedAttemptRouteReadiness>;
  /** Final accepted settlement/unserved completion, or explicit cancellation
   * after authority is revoked. This promise is never part of the Worker work
   * queue. */
  finalSettlement: Promise<void>;
}

type ClaimedAttemptRecord<Action extends object> = {
  claim: ExecutionClaim;
  action: Action;
  routeReady: PromiseWithResolvers<ClaimedAttemptRouteReadiness>;
  finalSettlement: PromiseWithResolvers<void>;
};

/** Exact-incarnation waiter ownership for one executor Worker. */
export class ClaimedAttemptLifecycle<Action extends object> {
  readonly #attempts = new Map<string, ClaimedAttemptRecord<Action>>();

  get size(): number {
    return this.#attempts.size;
  }

  start(claim: ExecutionClaim, action: Action): ClaimedAttemptHandle {
    const key = executionClaimIncarnationKey(claim);
    if (this.#attempts.has(key)) {
      throw new Error("claimed executor action is already activating");
    }
    const routeReady = Promise.withResolvers<ClaimedAttemptRouteReadiness>();
    const finalSettlement = Promise.withResolvers<void>();
    this.#attempts.set(key, { claim, action, routeReady, finalSettlement });
    return {
      routeReady: routeReady.promise,
      finalSettlement: finalSettlement.promise,
    };
  }

  markRouted(claim: ExecutionClaim, action: Action): boolean {
    const pending = this.#exact(claim, action);
    if (pending === undefined) return false;
    pending.routeReady.resolve("routed");
    return true;
  }

  finish(claim: ExecutionClaim, action: Action): boolean {
    const key = executionClaimIncarnationKey(claim);
    const pending = this.#exact(claim, action);
    if (pending === undefined) return false;
    this.#attempts.delete(key);
    pending.routeReady.resolve("released");
    pending.finalSettlement.resolve();
    return true;
  }

  cancelAll(): Array<{ claim: ExecutionClaim; action: Action }> {
    return this.cancelMatching(() => true);
  }

  /** Cancel exactly the attempts whose claim matches — the C1.8 per-lane
   * reset needs to fence one closed/re-anchored lane without disturbing the
   * space lane or sibling user lanes. */
  cancelMatching(
    matches: (claim: ExecutionClaim) => boolean,
  ): Array<{ claim: ExecutionClaim; action: Action }> {
    const cancelled = [...this.#attempts.values()]
      .filter(({ claim }) => matches(claim))
      .map(({ claim, action }) => ({ claim, action }));
    for (const { claim, action } of cancelled) this.finish(claim, action);
    return cancelled;
  }

  async settled(): Promise<void> {
    while (this.#attempts.size > 0) {
      await Promise.all(
        [...this.#attempts.values()].map((attempt) =>
          attempt.finalSettlement.promise
        ),
      );
    }
  }

  #exact(
    claim: ExecutionClaim,
    action: Action,
  ): ClaimedAttemptRecord<Action> | undefined {
    const pending = this.#attempts.get(executionClaimIncarnationKey(claim));
    return pending?.action === action ? pending : undefined;
  }
}

export type ClaimedAttemptRejection =
  | { release: false }
  | { release: true; diagnosticCode: string };

/** Delete authority only when the callback still names the exact action and
 * claim incarnation. Returns true once, so late duplicate callbacks cannot
 * post a second host release. */
export function deleteExactClaimForAction<Action extends object>(
  claims: WeakMap<Action, ExecutionClaim>,
  claim: ExecutionClaim,
  action: Action,
): boolean {
  const current = claims.get(action);
  if (
    current === undefined ||
    executionClaimIncarnationKey(current) !==
      executionClaimIncarnationKey(claim)
  ) {
    return false;
  }
  claims.delete(action);
  return true;
}

/** Classify a rejected-before-accept commit. No server attempt was accepted,
 * so authority is revoked without inventing a failed settlement. Accepted
 * attempts continue to use the server's explicit settlement feed. */
export function claimedAttemptRejection(
  error: unknown,
  disposition: ActionCommitRejectionDisposition,
): ClaimedAttemptRejection {
  const named = error as { name?: string } | undefined | null;
  const name = named?.name ?? "unknown";
  const immediatelyInvalidating = name === "StorageTransactionAborted" ||
    name === "AuthorizationError" || isPermanentRejection(named) ||
    isTerminalRejection(named) || isExecutionLeaseFenceRejection(named);
  if (immediatelyInvalidating) {
    return { release: true, diagnosticCode: `commit-rejected:${name}` };
  }
  if (disposition === "abandoned") {
    return {
      release: true,
      diagnosticCode: `commit-retries-exhausted:${name}`,
    };
  }
  return { release: false };
}
