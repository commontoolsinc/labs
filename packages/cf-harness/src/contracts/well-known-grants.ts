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

/**
 * Every fixed name, as a value. The harness describes each of these and the
 * console refuses to name a connector grant after one, and both read this
 * list — so adding a fixed grant is one edit here and the two consumers
 * follow, rather than a union that type-checks while a hand-written set
 * beside it stays one name short.
 */
export const HARNESS_WELL_KNOWN_GRANT_NAMES:
  readonly HarnessWellKnownGrantName[] = ["piece-registry"];

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

/**
 * One granted reference, as recorded in run state. A grant is one of two
 * kinds and `source` is what tells them apart, so the two are written as a
 * union: a fixed grant's name is one this module's own table describes, and a
 * connector grant carries the loom handle its name was read from. A record
 * with a free-chosen name and no source is a grant nothing can describe, and
 * the union is what stops one being constructed.
 */
export type HarnessWellKnownGrant =
  | {
    /** Which fixed reference this is. */
    name: HarnessWellKnownGrantName;

    /** The token the model holds. */
    token: string;

    /** The canonical reference behind it; never model-facing. */
    ref: string;

    source?: undefined;
  }
  | {
    /** The declared CFC class loom named this handle's columns with. */
    name: string;

    /** The token the model holds. */
    token: string;

    /** The canonical reference behind it; never model-facing. */
    ref: string;

    /** The loom handle the name was read from. */
    source: HarnessConnectorGrantSource;
  };
