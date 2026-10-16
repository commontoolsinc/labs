// Why: a source reconciler that prepares a piece's adoption of new source over
// the piece's stored data has to know whether a refusal will come back the
// same on the next open, so that it can stop preparing an adoption that cannot
// commit. One CFC refusal is of that kind on its own terms: a stored envelope
// fixes a claim (`writeAuthorizedBy`, `writePolicyAnyOf`, a confidentiality
// floor and the rest of the set-like IFC keys), and a candidate schema that
// changes or weakens it is refused by the merge in `schema-merge.ts` however
// often it is presented. The merge reads the stored envelope, the schema, and
// the transaction's writers and release, and a re-run of the same write reads
// the same; a different candidate, or a different stored envelope, can change
// the answer.
//
// The class is carried as a token at the front of the prepare `reason`, as
// `CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON` is (`migration-reason.ts` says
// why a token rather than an error class), and the refusal's `reasons` list is
// where a consumer reads it, anchored at the start of one reason, so no prose
// is matched.
//
// This module is dependency-free so the storage rejection vocabulary can import
// it without pulling in the `cfc/mod.ts` barrel.

/**
 * Stable machine token marking a CFC prepare reason as a refusal by a stored
 * envelope: the write's schema changes or weakens a claim the stored envelope
 * fixes. Emitted into the prepare `reason` (see `prepare.ts`).
 */
export const CFC_ENVELOPE_STABILITY_REASON = "cfc-envelope-stability";

/**
 * Raised by the CFC schema merge when a candidate changes or weakens a claim a
 * stored envelope fixes. The `.message` is the merge's own sentence, unchanged;
 * only the recorded reason gains {@link CFC_ENVELOPE_STABILITY_REASON}.
 */
export class CfcEnvelopeStabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfcEnvelopeStabilityError";
  }
}

/** Tags `message` as a refusal by a stored envelope. */
export const envelopeStabilityReason = (message: string): string =>
  `${CFC_ENVELOPE_STABILITY_REASON}: ${message}`;

/** Whether a single plain reason was tagged by {@link envelopeStabilityReason}. */
export const isEnvelopeStabilityReason = (reason: string): boolean =>
  reason.startsWith(`${CFC_ENVELOPE_STABILITY_REASON}: `);
