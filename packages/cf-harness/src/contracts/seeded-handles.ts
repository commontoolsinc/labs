/**
 * The record of an operator-seeded handle: a token minted into the run's
 * handle table at start for a reference the operator named on the command
 * line, so values seeded into cells before the run exists reach the model as
 * handles from its first turn. `src/seeded-handles.ts` documents the posture
 * and does the parsing and minting; this contract is what run state persists.
 */

import type { JSONSchema } from "@commonfabric/api";

/** One seed as the operator specified it, before any minting. */
export interface HarnessSeedHandleSpec {
  /**
   * The operator's name for the seed. Model-facing: it is the whole of what
   * the model is told the token names, so it is operator-authored prose by
   * construction — never text read from the fabric.
   */
  name: string;
  /** The reference to mint, as an LLM-friendly link string. */
  ref: string;
  /**
   * Optional operator-written shape of the referent, recorded on the handle
   * entry with `schemaSource: "operator"` so `describe_handle` answers
   * without a fabric read.
   */
  schema?: JSONSchema;
}

/** One seeded handle, as recorded in run state. */
export interface HarnessSeededHandle {
  name: string;
  /** The token the model holds. */
  token: string;
  /** The canonical reference behind it; never model-facing. */
  ref: string;
}
