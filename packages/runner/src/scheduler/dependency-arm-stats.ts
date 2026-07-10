import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("dependency-arm-stats", {
  enabled: false,
  level: "debug",
});

/**
 * Dependency-collection arm accounting (CT-1840, critique F7).
 *
 * The CT-1840 fix bets that the `argumentSchema`-driven collection arm —
 * which roots every traversal at a content-addressed `data:` URI cell and is
 * therefore the beneficiary of frozen, identity-stable parse results —
 * dominates dependency collection in production, versus the declared-reads
 * arm (which never touches `getImmutableCell`). These counters make that
 * attribution measurable instead of assumed: read them from a profile
 * session (or the periodic debug log) to confirm which arm the workload
 * actually exercises before crediting (or blaming) the freeze work.
 *
 * Counting is a single integer increment per collection — cheap enough to
 * stay unconditionally on.
 */
export const dependencyArmStats = {
  /** Action collections that used declared scheduler reads. */
  actionDeclaredReads: 0,
  /** Action collections that traversed the argument schema (data:-rooted). */
  actionArgumentSchema: 0,
  /** Event-handler collections that used declared scheduler reads. */
  handlerDeclaredReads: 0,
  /** Event-handler collections that traversed the argument schema. */
  handlerArgumentSchema: 0,
  /** Raw/builtin collections with a builtin-provided populate/log. */
  builtinCustom: 0,
  /** Raw/builtin collections that read all input cells. */
  builtinReadAllInputs: 0,
};

export type DependencyArm = keyof typeof dependencyArmStats;

/** Log a summary line every N collections (debug-gated, lazy). */
const LOG_EVERY = 1000;
let sinceLastLog = 0;

/** Records one dependency collection through the given arm. */
export function noteDependencyArm(arm: DependencyArm): void {
  dependencyArmStats[arm]++;
  if (++sinceLastLog >= LOG_EVERY) {
    sinceLastLog = 0;
    logger.debug("dependency-arms", () => [
      "dependency-collection arm totals",
      { ...dependencyArmStats },
    ]);
  }
}

/** Test/benchmark hook: zero all counters. */
export function resetDependencyArmStats(): void {
  for (const key of Object.keys(dependencyArmStats)) {
    dependencyArmStats[key as DependencyArm] = 0;
  }
  sinceLastLog = 0;
}
