/**
 * Backpressure policy for committed writes under contention.
 *
 * The runtime is optimistic: a committed write applies locally and is confirmed
 * by the server in the background. The server can reject a commit. Rejections
 * split two ways (see storage/rejection.ts):
 *
 *   - Transient: a stale basis-sequence conflict. Re-running the originating
 *     work against fresh confirmed state and committing again can succeed. Under
 *     sustained contention (for example a space rehydrating while a handler
 *     writes to it) these arrive in bursts.
 *   - Permanent: a commit-time precondition failure (receipt-exists,
 *     origin-committed). Re-running can never succeed and must not happen.
 *
 * A committed write that represents real user intent must converge or fail
 * loudly; it must never be silently dropped. This policy retries a transient
 * conflict with capped exponential backoff so the system slows down rather than
 * busy-looping, and keeps retrying for a bounded window long enough to outlast a
 * contention burst. If the window elapses without the write landing, the failure
 * surfaces as a terminal error rather than vanishing.
 */
export interface CommitBackpressurePolicy {
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Ceiling on the per-retry delay, in milliseconds. */
  maxDelayMs: number;
  /**
   * Fraction of the computed delay subtracted at random, in [0, 1]. 0.5 spreads
   * each delay across the lower 50% of the capped value so concurrent writers
   * contending for the same entity do not retry in lockstep. Subtractive so the
   * delay never exceeds maxDelayMs.
   */
  jitter: number;
  /**
   * Total wall-clock time a transient conflict may be retried before the write
   * surfaces a terminal error, in milliseconds. Measured from the first
   * conflict for a given intent.
   */
  retryWindowMs: number;
  /**
   * Number of conflict retries attempted with no delay before backoff begins.
   * A stale-basis conflict usually clears as soon as the fresh confirmed state
   * arrives, so the first few retries fire immediately — the fast path the
   * runtime had before backoff existed. Backoff (and its delays) only kick in
   * once these immediate retries are exhausted, i.e. under sustained
   * contention, where spacing retries out is what keeps the scheduler from
   * busy-looping.
   */
  immediateRetries: number;
}

export const DEFAULT_COMMIT_BACKPRESSURE: CommitBackpressurePolicy = {
  baseDelayMs: 25,
  maxDelayMs: 1_000,
  jitter: 0.5,
  retryWindowMs: 30_000,
  immediateRetries: 5,
};

/**
 * Fills in any unset fields from the defaults and clamps each field so the
 * arithmetic stays well-defined: non-negative delays, a cap no lower than the
 * base delay, jitter within [0, 1], and a non-negative window. These clamps keep
 * the policy sane; they are not what prevents silent data loss. The
 * never-silently-dropped guarantee holds for any resolved policy because a
 * transient conflict either converges or surfaces a terminal error. A zero
 * window does not drop a write silently — it makes the first conflict fail
 * terminally instead of being retried (a config-level way to opt out of the
 * retry window, distinct from the per-event `retries: 0` opt-out).
 */
export function resolveCommitBackpressure(
  partial?: Partial<CommitBackpressurePolicy>,
): CommitBackpressurePolicy {
  const merged = { ...DEFAULT_COMMIT_BACKPRESSURE, ...partial };
  const baseDelayMs = Math.max(0, merged.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, merged.maxDelayMs);
  const jitter = Math.min(1, Math.max(0, merged.jitter));
  const retryWindowMs = Math.max(0, merged.retryWindowMs);
  const immediateRetries = Math.max(0, Math.floor(merged.immediateRetries));
  return { baseDelayMs, maxDelayMs, jitter, retryWindowMs, immediateRetries };
}

/**
 * Delay before the given retry attempt (1-based), in milliseconds: exponential
 * growth from `baseDelayMs`, capped at `maxDelayMs`, then reduced by up to the
 * `jitter` fraction. The result is in `[capped * (1 - jitter), capped]`, so it
 * decorrelates concurrent writers without ever exceeding `maxDelayMs`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: CommitBackpressurePolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const growth = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(policy.maxDelayMs, growth);
  if (policy.jitter === 0) {
    return capped;
  }
  const reduction = capped * policy.jitter * random();
  return Math.max(0, capped - reduction);
}

/**
 * Terminal failure raised when a committed write that represents user intent
 * cannot be made durable: a transient conflict that never converged within the
 * retry window. Surfaced through the scheduler error channel so the UI or
 * handler can react, instead of the write being silently dropped.
 */
export class CommitConvergenceError extends Error {
  readonly attempts: number;
  readonly elapsedMs: number;
  override readonly cause: unknown;

  constructor(
    options: {
      handlerId?: string;
      attempts: number;
      elapsedMs: number;
      cause?: unknown;
    },
  ) {
    const handlerPart = options.handlerId ? ` for ${options.handlerId}` : "";
    super(
      `Committed write${handlerPart} did not converge after ${options.attempts} ` +
        `attempts over ${
          Math.round(options.elapsedMs)
        }ms of sustained conflicts`,
    );
    this.name = "CommitConvergenceError";
    this.attempts = options.attempts;
    this.elapsedMs = options.elapsedMs;
    this.cause = options.cause;
  }
}
