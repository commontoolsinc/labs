import type { HarnessResearchRunSummary } from "../contracts/research.ts";

/**
 * Keeps the latest implementation kit and the two latest focused answers in
 * their original order. Whole kits, including examples, remain intact; durable
 * evidence and inherited CFC context have their own retention rules.
 */
export const selectResearchContext = (
  runs: readonly HarnessResearchRunSummary[],
): HarnessResearchRunSummary[] => {
  const implementation = runs.findLast((run) =>
    run.kit.recommendation.kind !== "focused-api"
  );
  const focused = runs.filter((run) =>
    run.kit.recommendation.kind === "focused-api"
  ).slice(-2);
  const selected = new Set([implementation, ...focused]);
  return runs.filter((run) => selected.has(run));
};
