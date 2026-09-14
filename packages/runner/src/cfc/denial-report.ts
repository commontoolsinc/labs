/**
 * What a CFC gate says when it turns something away.
 *
 * Two gates deny: the write gate in `prepare.ts`, which stops a commit, and
 * the render gate in the reconciler, which swaps blocked content for a
 * placeholder. Each calls this where it decides, so the decision is visible
 * there rather than at the scheduler or the renderer, whose output is where
 * its effect shows.
 *
 * `summary` is a fixed sentence naming the kind of decision, and carries
 * nothing assembled from a reason, a label, a value, or a path. `inputs` is
 * the labels, the ceiling, and the dials behind the decision. A render
 * denial's inputs name the confidentiality label of content the viewer was not
 * cleared to see, and a label gives away the thing it protects, so the summary
 * goes to warning level and the inputs only to debug. Passing `inputs` as a
 * function keeps a gate from building them where nothing prints them.
 *
 * Both gates re-decide whenever their inputs change — the reconciler on each
 * update to a blocked cell, the write gate on each retried commit. So a
 * summary is announced once and the repeats are its count: `code` is the
 * message key, and `commonfabric.logger["cfc"].countsByKey` carries the
 * per-kind totals.
 */

import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("cfc");
const announced = new Set<string>();

/** Say that a gate blocked something. */
export const reportCfcDenial = (
  code: string,
  summary: string,
  inputs: () => Record<string, unknown>,
): void => {
  if (!announced.has(code)) {
    announced.add(code);
    logger.warn(code, summary);
  }
  logger.debug(code, () => [summary, inputs()]);
};

/** Forget which codes have been announced; the next of each announces again. */
export const resetCfcDenialAnnouncements = (): void => announced.clear();
