/**
 * What a pattern's own outputs say about the read behind them, read off every
 * pattern this run materialized rather than off the one value the run answers
 * with.
 *
 * A composed reader exposes its failure and its emptiness as outputs —
 * `errorMessage` beside `rows` — and a pattern composing it is free to pass
 * neither on. When it does not, the reader's failure exists only inside the
 * composed instance and inside whatever the view rendered from it, while the
 * run answers `ok` over a result whose every figure is zero. Nothing in that
 * answer distinguishes a month with no spending from a read that never ran.
 *
 * So the outputs are read where they are, and what they say is disclosed
 * beside the result. It is a disclosure and not a refusal: the run succeeded,
 * the piece stands, and what this adds is the reason to look.
 *
 * TEXT NEVER TRAVELS. A concern names the output it was read from and the
 * pattern that produced it, both of which the model already holds — it wrote
 * the composition, and the identity is the one its own `cf:pattern:` import
 * addresses. The error's TEXT is a computation over data the model may not
 * read, on the same terms as every other thrown message `run_pattern`
 * withholds, and a composed instance's outputs went through no release
 * measurement. A model told which output reports a failure passes that output
 * on and reads it under its own result schema, where the release boundary
 * measures it like any other value.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** What an output says about itself. */
export type OutputConcernKind = "error-branch" | "no-rows";

/**
 * The prefix the runtime writes on a SQLite failure of its own — a param it
 * could not bind, a handle that is not one, a scope it does not know. An
 * output carrying one reports a failure whatever it is named.
 */
const RUNTIME_SQLITE_PREFIX = "sqlite: ";

/** The output names a query's failure is conventionally exposed under. */
const ERROR_KEYS: readonly string[] = ["error", "errorMessage"];

/**
 * What each kind means and what to do about it. Fixed text drawn from here
 * and never composed, for the same reason the publication report's messages
 * are: a message assembled from what an output held would carry that value
 * out through the one field of this report that is free text.
 */
export const OUTPUT_CONCERN_MESSAGES: Record<OutputConcernKind, string> = {
  "error-branch":
    "this output reports a failure and nothing in the result passes it on. " +
    "Read it: expose the failing output under your own result schema, and " +
    "render it, rather than deriving figures from a read that did not happen.",
  "no-rows":
    "this output holds no rows. An empty read settles exactly as a full one " +
    "does, so every figure derived from it is zero and nothing says why. " +
    "Establish which it is before presenting the figures as an answer.",
};

/** One output of one materialized pattern, and what it says. */
export interface RunPatternOutputConcern {
  concern: OutputConcernKind;

  /** The output key it was read from. */
  key: string;

  /**
   * The pattern that produced it, under the identity a `cf:pattern:` import
   * addresses. Absent for the run's own result, which the caller wrote.
   */
  patternId?: string;

  /** Fixed text from `OUTPUT_CONCERN_MESSAGES`. */
  message: string;
}

/** Whether `value` is a non-empty string reporting a failure under `key`. */
const reportsFailure = (key: string, value: unknown): boolean =>
  typeof value === "string" && value !== "" &&
  (ERROR_KEYS.includes(key) || value.startsWith(RUNTIME_SQLITE_PREFIX));

/**
 * What the top-level outputs of one materialized pattern say about themselves.
 *
 * Only the top level is read. An output nested inside another is a shape the
 * pattern chose, and walking into it would report the emptiness of every
 * empty list a result happens to carry rather than the emptiness of a read.
 * Framework keys (`$NAME`, `$UI`) are not outputs and are left alone.
 */
export const outputConcernsIn = (
  value: unknown,
  patternId?: string,
): readonly RunPatternOutputConcern[] => {
  if (!isObjectNotArray(value)) return [];
  const concerns: RunPatternOutputConcern[] = [];
  for (const [key, member] of Object.entries(value)) {
    if (key.startsWith("$")) continue;
    const concern: OutputConcernKind | undefined = reportsFailure(key, member)
      ? "error-branch"
      : Array.isArray(member) && member.length === 0
      ? "no-rows"
      : undefined;
    if (concern === undefined) continue;
    concerns.push({
      concern,
      key,
      ...(patternId === undefined ? {} : { patternId }),
      message: OUTPUT_CONCERN_MESSAGES[concern],
    });
  }
  return concerns;
};

/**
 * `concerns` with each (pattern, output, kind) stated once, in the order they
 * were first read.
 *
 * A pattern materialized once per row of a list reports the same output as
 * many times, and a report that repeated it would say nothing the first entry
 * did not.
 */
export const dedupedOutputConcerns = (
  concerns: readonly RunPatternOutputConcern[],
): readonly RunPatternOutputConcern[] => {
  const seen = new Set<string>();
  const deduped: RunPatternOutputConcern[] = [];
  for (const concern of concerns) {
    const key = JSON.stringify([
      concern.patternId ?? null,
      concern.key,
      concern.concern,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(concern);
  }
  return deduped;
};
