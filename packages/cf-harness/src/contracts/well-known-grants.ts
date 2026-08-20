/**
 * The record of a well-known grant: a handle token the harness seeded into
 * the run for a reference every Fabric-configured run is entitled to hold.
 * `src/well-known-grants.ts` documents the posture and does the minting;
 * this contract is what run state persists.
 */

/** The well-known references a run can be granted. */
export type HarnessWellKnownGrantName = "piece-registry";

/** One granted reference, as recorded in run state. */
export interface HarnessWellKnownGrant {
  name: HarnessWellKnownGrantName;
  /** The token the model holds. */
  token: string;
  /** The canonical reference behind it; never model-facing. */
  ref: string;
}
