/**
 * Module-level feature flag for the stitch sync protocol on the client side.
 *
 * Follows the same pattern as the other experimental flags in
 * packages/data-model/ (e.g. value-hash.ts, schema-hash.ts).
 *
 * Enabled via ExperimentalOptions.stitch in RuntimeOptions.
 */

let enabled = false;

/** Enable or disable the stitch sync protocol for the current process. */
export const setStitchConfig = (value: boolean): void => {
  enabled = value;
};

/** Returns true when the stitch sync protocol is active. */
export const getStitchConfig = (): boolean => enabled;

/** Reset to the default (disabled) state. Called from Runtime.dispose(). */
export const resetStitchConfig = (): void => {
  enabled = false;
};
