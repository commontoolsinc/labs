/**
 * The record of an operator input cell: a cell the operator passed into the
 * run by reference, given a handle-table token at start so the run's inputs
 * reach the model as tokens from its first turn. `src/input-cells.ts`
 * documents the posture and does the parsing and minting; this contract is
 * what run state persists.
 */

/** One input cell as the operator specified it, before any minting. */
export interface HarnessInputCellSpec {
  /**
   * The operator's name for the input cell. Model-facing: it is the whole
   * of what the model is told the token names, so it is operator-authored
   * prose by construction — never text read from the fabric.
   */
  name: string;

  /**
   * The reference to mint, as an LLM-friendly link string. The cell's shape
   * and labels are not stated here: both live on the cell's declared schema
   * in the fabric, which `describe_handle` reads through the session.
   */
  ref: string;
}

/** One input cell, as recorded in run state. */
export interface HarnessInputCell {
  name: string;

  /** The token the model holds. */
  token: string;

  /** The canonical reference behind it; never model-facing. */
  ref: string;
}
