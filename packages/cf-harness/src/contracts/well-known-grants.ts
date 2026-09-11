/**
 * The record of a well-known grant: a handle token the harness seeded into
 * the run for a reference every run on this console is entitled to hold.
 * `src/well-known-grants.ts` documents the posture and does the minting;
 * this contract is what run state persists.
 */

/**
 * The fixed well-known references, whose model-facing descriptions the
 * harness authors in full. A connector grant's name is not one of these:
 * it is read from the records of the loom instance the console was launched
 * against, which is why it is held to the same name shape an operator's
 * `--input-cell` name is (`HANDLE_NAME_PATTERN` in `src/input-cells.ts`)
 * before it reaches a model.
 */
export type HarnessWellKnownGrantName = "piece-registry";

/** Which loom connector handle a connector grant names. */
export interface HarnessConnectorGrantSource {
  /** The loom connection the handle belongs to. */
  connection: string;

  /** The loom piece that carries the handle. */
  piece: string;
}

/** One connector handle to grant, as the console was configured with it. */
export interface HarnessConnectorGrantSpec {
  /**
   * The model-facing name: the one CFC class loom's own table contract
   * declares for the handle's columns, so a session is told `email` for a
   * mail database and `finance` for a bank one.
   */
  name: string;

  /** The reference to mint, as an LLM-friendly link string. */
  ref: string;

  /** The loom handle behind it, for run state and the launch report. */
  source: HarnessConnectorGrantSource;
}

/** One granted reference, as recorded in run state. */
export interface HarnessWellKnownGrant {
  /**
   * Model-facing name: a {@link HarnessWellKnownGrantName} for a fixed
   * grant, and the declared CFC class for a connector grant.
   */
  name: string;

  /** The token the model holds. */
  token: string;

  /** The canonical reference behind it; never model-facing. */
  ref: string;

  /** Present when the grant is a connector handle rather than a fixed one. */
  source?: HarnessConnectorGrantSource;
}
