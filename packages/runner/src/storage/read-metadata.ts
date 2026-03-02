/**
 * Metadata marker used to ignore a read for scheduler dependency tracking.
 */
export const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

/**
 * Metadata marker used to mark a read as a potential write dependency.
 */
export const markReadAsPotentialWriteMarker: unique symbol = Symbol(
  "markReadAsPotentialWriteMarker",
);

/**
 * Metadata that can be attached to read operations.
 *
 * This channel is intentionally restricted to scheduler dependency markers.
 */
export interface Metadata {
  readonly [ignoreReadForSchedulingMarker]?: true;
  readonly [markReadAsPotentialWriteMarker]?: true;
}

/**
 * CFC-specific read annotations captured in journal activity.
 */
export interface ICfcReadAnnotations {
  readonly internalVerifierRead?: true;
  readonly maxConfidentiality?: readonly string[];
  readonly requiredIntegrity?: readonly string[];
}
