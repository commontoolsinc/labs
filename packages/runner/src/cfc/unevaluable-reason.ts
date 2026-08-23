// Why: a CFC prepare rejection is not one thing. Most reasons are VERDICTS —
// policy evaluated the transaction's data and refused it (a writer-fit
// misfit, an unprivileged write to a protected `cfc` path, an exact-copy or
// monotonicity violation). Re-running recomputes the identical refused write,
// so those are terminal: never retried, surfaced.
//
// A few reasons are not verdicts at all. Prepare could not EVALUATE, because
// an input it needed was not available in this transaction — a link's source
// metadata, a schema's write-policy input, a stored envelope whose schema
// document failed to load. Those clear once the referenced document loads, so
// re-running CAN converge, and treating them as terminal strands the write:
// the served-wish state never lands and its UI silently never mounts, which is
// the failure OW50 exists to surface rather than reproduce.
//
// The discriminator is carried as a machine-stable TOKEN inside the prepare
// `reason` string, for the same reason
// `CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON` is: only the message survives the
// plain-`Error` re-wrap the runner applies at its setup-commit boundary
// (`runner.ts`), and matching a token rather than prose keeps producer and
// consumer in lockstep.
//
// NOTE the default, which is deliberate but arguable: an UNMARKED reason is
// treated as a verdict, so a new reason is terminal until someone marks it.
// That is the right default only if every future "could not evaluate" reason
// gets marked at its source. The opposite default — retryable until proven a
// verdict — would fail toward today's bounded-retry behaviour instead. See the
// pull request discussion; this is a model question for the framework owner.

/**
 * Stable machine token marking a CFC prepare reason as an EVALUATION FAILURE
 * rather than a policy verdict: prepare could not decide, because an input it
 * needed was not available in this transaction. Emitted into the prepare
 * `reason` (see `prepare.ts`) so it survives into the commit-rejection
 * message, and read at the commit boundary to keep the rejection retryable.
 */
export const CFC_UNEVALUABLE_REASON = "cfc-unevaluable";

/**
 * Tags `message` as an evaluation failure. The human-readable text is left
 * unchanged after the token, so assertions that match the prose as a substring
 * keep working.
 */
export const unevaluableReason = (message: string): string =>
  `${CFC_UNEVALUABLE_REASON}: ${message}`;

/** Whether a single recorded reason was tagged by {@link unevaluableReason}. */
export const isUnevaluableReason = (reason: string): boolean =>
  reason.startsWith(`${CFC_UNEVALUABLE_REASON}: `);

/**
 * Whether a refusal can converge on a fresh attempt: true when ANY recorded
 * reason is an evaluation failure. Any is the correct quantifier rather than
 * every — a transaction refused for both an unavailable input and a verdict
 * may well produce only the verdict once the input loads, and the verdict
 * refuses again on its own terms if it does not.
 */
export const hasUnevaluableReason = (reasons: readonly string[]): boolean =>
  reasons.some(isUnevaluableReason);
