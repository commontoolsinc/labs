/**
 * How much a run's caller wants it to do: answer `quick`ly, work at the
 * `standard` depth every run had before callers could choose, or go `deep`.
 * The caller decides it, before the run starts; the run's task classification
 * says what kind of work it is, and the depth how far to take it. It selects
 * prompt sections and the opening research pass, and grants no authority.
 */
export const HARNESS_RUN_DEPTHS = ["quick", "standard", "deep"] as const;

export type HarnessRunDepth = typeof HARNESS_RUN_DEPTHS[number];

/** The depth of a run whose caller named none. */
export const DEFAULT_HARNESS_RUN_DEPTH: HarnessRunDepth = "standard";

/** `value` as a run depth, or undefined when it names none. */
export const parseHarnessRunDepth = (
  value: unknown,
): HarnessRunDepth | undefined =>
  HARNESS_RUN_DEPTHS.find((depth) => depth === value);
