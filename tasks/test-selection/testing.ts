/**
 * Fixtures the selection tooling's own tests are written against. The
 * shapes come from the shared format's own fixtures; what is added here
 * is the dials, which are this repository's policy rather than part of
 * the format.
 */

import {
  sampleEntry as bareEntry,
  sampleManifest as bareManifest,
} from "@commonfabric/test-support/records";
import { dialSnapshot, type Manifest } from "./manifest.ts";

export { freeCalibration } from "@commonfabric/test-support/records";
export const sampleEntry = bareEntry;

/** A small, valid manifest, carrying this repository's dials. */
export function sampleManifest(fields: Partial<Manifest> = {}): Manifest {
  return bareManifest({ dials: dialSnapshot(), ...fields });
}
