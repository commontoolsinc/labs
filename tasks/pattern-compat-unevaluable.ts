/**
 * Patterns that do not evaluate today, and so cannot be gated.
 *
 * A file that throws while being evaluated yields no contract, gets no
 * baseline, and is therefore exempt from the update gate *by construction* —
 * it can never evaluate, so it can never be recorded, so it can never be
 * checked. Without this list those files would sit in the same "skipped"
 * bucket as `schemas.tsx` and other helper modules that are legitimately not
 * pattern entries, and nothing would distinguish "was never a pattern" from
 * "is a broken pattern".
 *
 * So the list is debt, made visible. The gate fails on an evaluation error
 * that is NOT listed here, and fails when a listed entry starts evaluating
 * again — so the list can only shrink, never quietly grow.
 *
 * Entries are the pattern key (path relative to `packages/patterns`). Several
 * of these are real `export default pattern(...)` entries, not helpers, so
 * anyone who created a piece from one back when it worked has a piece that
 * this gate does not protect.
 */
export const UNEVALUABLE_PATTERNS: ReadonlySet<string> = new Set([
  // "Bidirectionally bound property $items is not reactive"
  "examples/cf-picker.tsx",
  // "Possible HTML comment rejected ... (SES_HTML_COMMENT_REJECTED)"
  "google/WIP/google-docs-importer.tsx",
  "google/core/util/google-docs-client.ts",
  "google/core/util/google-docs-markdown.ts",
  // "Cell.of() only accepts static data, but found a reactive value"
  "google/core/imported-calendar.tsx",
  // "Reactive.map(fn) is no longer supported: an inline pattern has no stable
  // identity" — the authored `.map(...)` lowering.
  "google/extractors/email-pattern-launcher.tsx",
  "google/extractors/hotel-membership-gmail-agent.tsx",
]);
