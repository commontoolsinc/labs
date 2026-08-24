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
// WATCH(cfc-unevaluable): THE DEFAULT IS "VERDICT", AND IT IS THE THING TO
// SUSPECT FIRST.
//
// An UNMARKED reason counts as a verdict, so a reason added tomorrow is
// TERMINAL — never retried — until someone tags it here. That is safe only
// while every "could not evaluate" reason is tagged at its source. Get it
// wrong and the symptom is a write that never lands and never retries: a
// pattern result that stays absent, a served-wish state that never
// materializes and whose UI silently never mounts, a refusal logged once and
// then nothing. It will NOT look like a labelling bug; it looks like the
// computation simply stopped.
//
// If you are debugging that, the question is: did prepare refuse this data,
// or could it not evaluate yet? If the latter, the fix is one line — wrap the
// reason at its producer in `unevaluableReason(...)`, next to the other
// tagged sites in `prepare.ts` — plus a test that the write lands once the
// input arrives.
//
// This default was chosen deliberately and reviewed (PR #6114, ask A1): it is
// the smaller change, and it matches how `isRetryableCommitRejection` treats
// its allow-list. The alternative — retryable until proven a verdict, which
// fails toward today's bounded-retry behaviour and costs ~13 tagged sites
// instead of 3 — was the argued-for opposite. Inverting it is mechanical:
// tag the verdicts instead, and flip the predicate below.
//
// One revision of #6114 shipped WITHOUT this split, treating every reason as
// a verdict, and it stranded the served-wish state exactly as described
// above. The OW49/OW50 suites caught it
// (`cfc-prepare-crash-surfacing.test.ts`, `executor-events-down.test.ts`,
// `executor-trust-attribution.test.ts`) — if you are changing this, run those.

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
