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
 * TEXT NEVER TRAVELS TO THE MODEL. A concern names the output it was read from
 * and the pattern that produced it, both of which the model already holds — it
 * wrote the composition, and the identity is the one its own `cf:pattern:`
 * import addresses. The error's TEXT is a computation over data the model may
 * not read, on the same terms as every other thrown message `run_pattern`
 * withholds, and a composed instance's outputs went through no release
 * measurement. A model told which output reports a failure passes that output
 * on and reads it under its own result schema, where the release boundary
 * measures it like any other value.
 *
 * The text is kept for the run's ARTIFACT, on the terms `rawCauseMessage`
 * already states for thrown text: it cannot be recovered any other way, since
 * a composed instance is not something the model can address, and an operator
 * reading a run back has nothing else to debug from. So an observation is two
 * things — the concern, which is the model's, and the text, which is the
 * artifact's — and they are carried apart rather than filtered later.
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
 * The output name a read still in flight is exposed under, which `db.query`
 * answers with and every atom passes on. An emptiness read while it is true
 * is the emptiness of a read that has not landed, and says nothing about the
 * data — a query over a served store is in flight for the whole of the run
 * that issued it. A failure read then is still a failure.
 */
const PENDING_KEY = "pending";

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

/**
 * One output as it was read: what the model is told, and the text only the
 * artifact keeps. `text` is empty for an output that reports no failure.
 */
export interface ObservedOutput {
  concern: RunPatternOutputConcern;
  text: string;
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
 *
 * A result reporting itself `pending` has its emptiness passed over, on the
 * terms `PENDING_KEY` states: a read still in flight is empty because it has
 * not landed. Its failures are reported either way.
 */
export const observedOutputsIn = (
  value: unknown,
  patternId?: string,
): readonly ObservedOutput[] => {
  if (!isObjectNotArray(value)) return [];
  const pending = value[PENDING_KEY] === true;
  const observed: ObservedOutput[] = [];
  for (const [key, member] of Object.entries(value)) {
    if (key.startsWith("$")) continue;
    const concern: OutputConcernKind | undefined = reportsFailure(key, member)
      ? "error-branch"
      : !pending && Array.isArray(member) && member.length === 0
      ? "no-rows"
      : undefined;
    if (concern === undefined) continue;
    observed.push({
      concern: {
        concern,
        key,
        ...(patternId === undefined ? {} : { patternId }),
        message: OUTPUT_CONCERN_MESSAGES[concern],
      },
      text: typeof member === "string" ? member : "",
    });
  }
  return observed;
};

/**
 * `observed` with each (pattern, output, kind) stated once, in the order they
 * were first read.
 *
 * A pattern materialized once per row of a list reports the same output as
 * many times, and a report that repeated it would say nothing the first entry
 * did not.
 */
export const dedupedObservedOutputs = (
  observed: readonly ObservedOutput[],
): readonly ObservedOutput[] => {
  const seen = new Set<string>();
  const deduped: ObservedOutput[] = [];
  for (const one of observed) {
    const key = JSON.stringify([
      one.concern.patternId ?? null,
      one.concern.key,
      one.concern.concern,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(one);
  }
  return deduped;
};

/**
 * What the artifact keeps about `observed`: the same positions the model was
 * told about, each with the text it was told nothing of. An output reporting
 * no text contributes its position alone, so the two reports name the same
 * set and a reader can line them up.
 */
export const observedOutputCause = (
  observed: readonly ObservedOutput[],
): string | undefined =>
  observed.length === 0
    ? undefined
    : observed.map((one) =>
      `${
        one.concern.patternId ?? "this run's own result"
      } ${one.concern.key} ` +
      `(${one.concern.concern})${one.text === "" ? "" : `: ${one.text}`}`
    ).join("\n");
