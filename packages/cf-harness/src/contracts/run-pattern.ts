/** Shared input contract for direct and research-proposed pattern invocations. */

import type { JSONSchema } from "@commonfabric/api";

/** Arguments accepted by the host pattern execution tool. */
export interface RunPatternToolInput {
  sourceText?: string;

  /**
   * What the pattern is for, in one line. Published with the pattern when the
   * run contributes to the index; a run that gives none publishes nothing,
   * since a pattern nobody can read the purpose of is a pattern nobody finds.
   */
  description?: string;

  /** Tags the published pattern is found under. */
  hashtags?: readonly string[];

  /**
   * A pattern published to the index, run in place of inline source. The
   * program is fetched host-side and compiled down the same path; its source
   * never reaches the model, on the success path or on any error path.
   */
  patternId?: string;

  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
}

/** JSON shape accepted by the pattern execution tool. */
export const RUN_PATTERN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sourceText: {
      type: "string",
      description:
        "Pattern source (TypeScript/TSX), at most 256 KiB. Return a durable result object directly; a whole-result derived wrapper is a known smell, not a deterministic failure: after the run the harness checks the actual pattern pointer and refuses a piece materialized under a session-only identity.",
    },
    patternId: {
      type: "string",
      description:
        "A published pattern's id, as search_patterns reports it. Give exactly one of sourceText and patternId.",
    },
    description: {
      type: "string",
      description:
        'One line on what the pattern does, e.g. "Totals an invoice\'s line items and applies a discount". Source you wrote that runs successfully is queued for the pattern index only when this is filled in; the result does not confirm publication.',
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description:
        'Words someone searching for this capability would type, e.g. ["invoice", "arithmetic"].',
    },
    inputs: {
      type: "object",
      additionalProperties: true,
      description:
        'A string that is wholly an LLM-friendly link (e.g. "/of:fid1:abc.../path") passes as a live cell reference; anything else as plain JSON.',
    },
    resultSchema: {
      anyOf: [
        { type: "boolean" },
        { type: "object", additionalProperties: true },
      ],
      description:
        'Pass it to read computed values such as counts or rows; without it value is omitted. A successful run returns resultRef, with pending/hasError when the release fit admits them. Only fields the schema models return: an inert one (number, boolean, enum or const string) as itself, anything else as a reference token to that position for describe_handle or a later run_pattern. Example: {"type":"object","properties":{"total":{"type":"number"}},"required":["total"]}. $NAME, $UI and other rendering keys need not be declared. When policy refuses the release, value is withheld, valueError names why and the input carrying the refused label, and resultRef can still be passed on by reference.',
    },
  },
  // Exactly one of `sourceText` and `patternId` is required, which is a
  // condition on the pair rather than on either alone; the tool states it
  // in prose here and enforces it on invocation.
  additionalProperties: false,
} satisfies JSONSchema;
