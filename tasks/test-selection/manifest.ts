/**
 * The manifest, as the selection tooling uses it. The format itself lives
 * beside the record schema in `@commonfabric/test-support/records`,
 * because the wall reads a manifest as well as the lanes do and one
 * format with two validators would rot. What is here is the one part that
 * cannot live there: the dials a manifest records, which are this
 * repository's policy rather than the format.
 */

import { DIALS } from "./policy.ts";

export {
  digestIdentities,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";
export type {
  Calibration,
  CoverageBaseline,
  LanePlan,
  Manifest,
  ManifestEntry,
  ScoreInputs,
  UnavailableEntry,
  UnschedulableEntry,
  WithheldEntry,
  WithheldReason,
} from "@commonfabric/test-support/records";

/**
 * The dials as a manifest records them, so a manifest explains its own
 * behavior and two of them can be compared for why they differ.
 */
export function dialSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const dial of DIALS) snapshot[dial.name] = dial.value;
  return snapshot;
}
