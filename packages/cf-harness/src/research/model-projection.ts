/** Projects retained research evidence into an outer model's context. */

import type {
  HarnessResearchKit,
  HarnessResearchPatternRecord,
} from "../contracts/research.ts";
import { scrubBareFabricIdentifiersWithPointers } from "../fabric-identifier-scrub.ts";

/** One model-facing kit and the artifact positions reduced to produce it. */
export interface HarnessResearchKitProjection {
  /** Kit whose free text passed through the existing identifier scrub. */
  kit: HarnessResearchKit;

  /** Text changed by the projection, relative to its artifact position. */
  scrubbedPointers: readonly string[];

  /** Raw schemas retained only in the durable evidence. */
  artifactOnlyPointers: readonly string[];
}

/** Exact host records needed to reopen, import, and bind selected components. */
const PATTERN_IDENTITY_FIELDS = [
  "patternId",
  "importHint",
  "ownerDid",
  "createdAt",
  "main",
  "mainExport",
  "files",
  "sourceRoots",
  "dataFiles",
  "dependencies",
  "argumentType",
  "resultType",
] as const satisfies readonly (keyof HarnessResearchPatternRecord)[];

/**
 * Scrubs free text by default, preserves exact host identities and source/CFC
 * records, and drops unused raw index schemas. The private loop and durable
 * summaries retain the full kit; this projection owns only outer model context.
 */
export const projectHarnessResearchKitForModel = (
  kit: HarnessResearchKit,
  basePointer = "/kit",
): HarnessResearchKitProjection => {
  const candidate = structuredClone(kit);
  const artifactOnlyPointers: string[] = [];
  const identities = candidate.patterns.map((pattern, index) => {
    const identity: Partial<HarnessResearchPatternRecord> = {};
    for (const field of PATTERN_IDENTITY_FIELDS) {
      if (Object.hasOwn(pattern, field)) {
        Object.assign(identity, { [field]: pattern[field] });
        delete pattern[field];
      }
    }
    for (const field of ["argumentSchema", "resultSchema"] as const) {
      if (pattern[field] !== undefined) {
        artifactOnlyPointers.push(`${basePointer}/patterns/${index}/${field}`);
      }
      delete pattern[field];
    }
    return identity;
  });
  const sources = candidate.sources;
  candidate.sources = [];
  const projected = scrubBareFabricIdentifiersWithPointers(
    candidate,
    basePointer,
  );
  const result = projected.value as HarnessResearchKit;
  result.sources = sources;
  result.patterns.forEach((pattern, index) =>
    Object.assign(pattern, identities[index])
  );
  return {
    kit: result,
    scrubbedPointers: projected.scrubbedPointers,
    artifactOnlyPointers,
  };
};
