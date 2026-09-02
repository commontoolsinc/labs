/**
 * What one audit check says about one run, and how a set of those verdicts
 * decides whether the audit passed.
 *
 * The verdict vocabulary is what keeps the audit honest. `inconclusive` is
 * the verdict for a check whose evidence was absent — it is never `pass`,
 * because a check that could not look at anything has not found anything.
 * `not-applicable` is narrower and stronger: the evidence was there and said
 * the check's subject does not arise in this run.
 */

import type { SpecCitation } from "./citations.ts";

/**
 * How a check turned out.
 *
 * - `pass` — the check looked at the evidence its clause names and found it
 *   consistent with the clause.
 * - `fail` — the evidence contradicts the clause.
 * - `warn` — the evidence is consistent with the clause but the run's own
 *   posture makes the assurance weaker than an enforcing run's.
 * - `inconclusive` — an artifact the check needs is absent or unparseable,
 *   so nothing was established either way.
 * - `not-applicable` — the evidence is present and says the check's subject
 *   does not arise in this run.
 */
export type CheckVerdict =
  | "pass"
  | "fail"
  | "warn"
  | "inconclusive"
  | "not-applicable";

/** One thing the check read, and where a reader can go and read it too. */
export interface CheckEvidence {
  /**
   * Where the fact sits, as an artifact-relative path and a position inside
   * it: `policy-trace.json decisions[3]`, `transcript.json messages[7]`. A
   * fact that is about the run family rather than about one file omits it.
   */
  pointer?: string;

  /** The artifact the pointer is into, relative to the run directory. */
  artifact?: string;

  /** What that position says, in the check's own words. */
  detail: string;
}

/** One check's verdict on one run. */
export interface CheckResult {
  checkId: string;
  title: string;
  runId: string;

  /** The run directory audited, as the caller named it. */
  runDir: string;

  verdict: CheckVerdict;

  /** One sentence stating what the check found. */
  message: string;

  citations: readonly SpecCitation[];
  evidence: readonly CheckEvidence[];
}

/** The verdict at or above which the audit exits non-zero. */
export type FailOnThreshold = "fail" | "warn" | "inconclusive";

const THRESHOLD_VERDICTS: Record<
  FailOnThreshold,
  readonly CheckVerdict[]
> = {
  fail: ["fail"],
  warn: ["fail", "warn"],
  inconclusive: ["fail", "warn", "inconclusive"],
};

/**
 * The threshold an audit uses when the caller names none.
 *
 * `inconclusive` rather than `fail`: an audit run in CI over a tree missing
 * the artifacts the checks read has established nothing, and a green exit
 * code there would report the absence of evidence as evidence of compliance.
 */
export const DEFAULT_FAIL_ON: FailOnThreshold = "inconclusive";

/** Whether `verdict` is at or above `threshold`. */
export const verdictFailsThreshold = (
  verdict: CheckVerdict,
  threshold: FailOnThreshold,
): boolean => THRESHOLD_VERDICTS[threshold].includes(verdict);

/** The order findings are reported in, worst first. */
export const VERDICT_ORDER: readonly CheckVerdict[] = [
  "fail",
  "warn",
  "inconclusive",
  "not-applicable",
  "pass",
];

/** How many results carried each verdict. */
export const countVerdicts = (
  results: readonly CheckResult[],
): Record<CheckVerdict, number> => {
  const counts: Record<CheckVerdict, number> = {
    fail: 0,
    warn: 0,
    inconclusive: 0,
    "not-applicable": 0,
    pass: 0,
  };
  for (const result of results) {
    counts[result.verdict] += 1;
  }
  return counts;
};
