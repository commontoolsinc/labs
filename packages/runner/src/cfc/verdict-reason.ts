// Why: a CFC prepare rejection is not one thing, and only one kind of it may
// stop the scheduler.
//
// A VERDICT is policy evaluating this transaction's data and refusing it — a
// writer-fit misfit, an unprivileged write to a protected `cfc` path, an
// exact-copy or monotonicity violation. Re-running recomputes the identical
// refused write, so a verdict is terminal: never retried, surfaced.
//
// Everything else that lands in `reasons` is NOT a verdict, whatever it looks
// like. Prepare may have been unable to EVALUATE because an input was not
// available in this transaction (a link's source metadata, a schema's
// write-policy input, an unreadable stored envelope, a policy manifest that
// did not resolve). The prepared state may have DRIFTED — `invalidateCfc`
// records a read after prepare, a changed policy input — which says the
// verdict was never reached, not that it went against the data. Both clear on
// a fresh attempt, and terminating them strands a write that would have
// landed.
//
// WATCH(cfc-verdict): THE DEFAULT IS "NOT A VERDICT", AND THAT IS DELIBERATE.
//
// An UNTAGGED reason is retryable. A reason is terminal only when its producer
// says so by wrapping it in `verdictReason(...)`. Get the tagging wrong in the
// safe direction — a deterministic refusal left untagged — and the cost is the
// bounded-retry behaviour that predates this split: some doomed re-runs, then
// the convergence budget. Get it wrong in the other direction and the cost is
// a write that never lands and never retries: an absent pattern result, a
// served-wish state that never materializes and whose UI silently never
// mounts. It will not look like a labelling bug; it looks like the computation
// simply stopped.
//
// That asymmetry is why the default sits here rather than at "verdict". An
// earlier revision of this work defaulted the other way, on the argument that
// every reason was a verdict unless marked. A producer audit found that false
// in both directions — several families are mixed, and several DISCARD an
// availability reason they received upstream (`verifyWriteFloor` drops
// `derivePersistedLinkLabel`'s; the `maxConfidentiality` input gate reports
// its resolution failures and withholds the tag; the sink-ceiling gate tags
// its refusal only when its enforce-mode rewrite resolved every module
// policy, since an unresolved manifest might carry the discharge that admits
// the request) — so an untagged
// reason cannot be assumed deterministic. Tagging the verdicts is the claim a
// producer can actually make about itself.
//
// It also closes a hole the other direction had: `invalidateCfc` takes an
// arbitrary caller string, so with terminal-by-default a caller could inject
// prose and choose its own disposition. Verdicts are minted only inside
// `prepare.ts`; caller prose is untagged and therefore retryable, which is the
// safe answer for a transaction whose prepared state a caller just disturbed.
//
// The token rides inside the reason string, like
// `CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON`: the message is the only channel
// that survives the plain-`Error` re-wrap the runner applies at its
// setup-commit boundary (`runner.ts`), and matching a token rather than prose
// keeps producer and consumer in lockstep.

/**
 * Stable machine token marking a CFC prepare reason as a VERDICT — policy
 * evaluated this transaction's data and refused it, so re-running recomputes
 * the identical refused write. Emitted into the prepare `reason` (see
 * `prepare.ts`) so it survives into the commit-rejection message, and read at
 * the commit boundary to decide that the rejection is terminal.
 */
export const CFC_VERDICT_REASON = "cfc-verdict";

/**
 * Tags `message` as a verdict. The human-readable text is left unchanged after
 * the token, so assertions matching the prose as a substring keep working.
 */
export const verdictReason = (message: string): string =>
  `${CFC_VERDICT_REASON}: ${message}`;

/** Whether a single recorded reason was tagged by {@link verdictReason}. */
export const isVerdictReason = (reason: string): boolean =>
  reason.startsWith(`${CFC_VERDICT_REASON}: `);

/**
 * Whether a refusal is terminal: at least one reason, and EVERY reason a
 * verdict. Every rather than any — a transaction refused for both a verdict
 * and an unavailable input has not been fully evaluated, and the fresh attempt
 * that resolves the input may reach a different set of reasons. The verdict
 * refuses again on its own terms if it stands.
 */
export const isTerminalRefusal = (reasons: readonly string[]): boolean =>
  reasons.length > 0 && reasons.every(isVerdictReason);

/**
 * The reason without its tag — the human-readable text a producer wrote.
 * The tag is a CLASSIFICATION channel for the commit boundary, which reads
 * these strings in-process; it must not reach a diagnostic, a rejection
 * message, or anything else a person or a downstream matcher reads, or the
 * tagging would silently rewrite every message it touches.
 */
export const plainReason = (reason: string): string =>
  isVerdictReason(reason)
    ? reason.slice(CFC_VERDICT_REASON.length + 2)
    : reason;
