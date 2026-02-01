/**
 * Composite labels combining confidentiality and integrity.
 *
 * A Label pairs a CNF confidentiality component with a set-based integrity
 * component, providing the full two-dimensional information flow control
 * lattice used by the CFC enforcement layer.
 */

import { type Atom, classificationAtom } from "./atoms.ts";
import {
  type ConfidentialityLabel,
  emptyConfidentiality,
  joinConfidentiality,
  meetConfidentiality,
  confidentialityLeq,
} from "./confidentiality.ts";
import {
  type IntegrityLabel,
  emptyIntegrity,
  joinIntegrity,
  meetIntegrity,
  integrityLeq,
} from "./integrity.ts";
import type { Labels } from "../storage/interface.ts";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type Label = {
  readonly confidentiality: ConfidentialityLabel;
  readonly integrity: IntegrityLabel;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Bottom confidentiality (no restrictions), empty integrity (no endorsements). */
export function emptyLabel(): Label {
  return {
    confidentiality: emptyConfidentiality(),
    integrity: emptyIntegrity(),
  };
}

// ---------------------------------------------------------------------------
// Lattice operations
// ---------------------------------------------------------------------------

/** Join (least upper bound): join both components. */
export function joinLabel(a: Label, b: Label): Label {
  return {
    confidentiality: joinConfidentiality(a.confidentiality, b.confidentiality),
    integrity: joinIntegrity(a.integrity, b.integrity),
  };
}

/** Meet (greatest lower bound): meet both components. */
export function meetLabel(a: Label, b: Label): Label {
  return {
    confidentiality: meetConfidentiality(a.confidentiality, b.confidentiality),
    integrity: meetIntegrity(a.integrity, b.integrity),
  };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Both components satisfy ≤. */
export function labelLeq(a: Label, b: Label): boolean {
  return (
    confidentialityLeq(a.confidentiality, b.confidentiality) &&
    integrityLeq(a.integrity, b.integrity)
  );
}

// ---------------------------------------------------------------------------
// Bridges from flat classification strings
// ---------------------------------------------------------------------------

/**
 * Create a label with a single Classification(level) confidentiality clause
 * and empty integrity.
 */
export function labelFromClassification(level: string): Label {
  return {
    confidentiality: [[classificationAtom(level)]],
    integrity: emptyIntegrity(),
  };
}

/**
 * Convert existing schema `ifc` annotations to a Label.
 *
 * If `ifc.classification` has multiple strings, each becomes a separate
 * clause (they are AND'd — you need ALL those clearances).
 */
/**
 * Convert stored `Labels` (from the `label/` document path) into a composite
 * `Label`.  Prefers the rich `confidentiality`/`integrity` fields when present
 * and falls back to the legacy `classification` strings.
 */
export function labelFromStoredLabels(labels: Labels): Label {
  const confidentiality: ConfidentialityLabel =
    labels.confidentiality ??
    (labels.classification
      ? labels.classification.map((level) => [classificationAtom(level)])
      : emptyConfidentiality());

  const integrity: IntegrityLabel = labels.integrity
    ? { atoms: labels.integrity }
    : emptyIntegrity();

  return { confidentiality, integrity };
}

/**
 * Convert a runtime `Label` to the storage `Labels` type for persistence.
 * Skips empty arrays to keep storage clean.
 */
export function toLabelStorage(label: Label): Labels {
  const result: Labels = {};
  if (label.confidentiality.length > 0) {
    result.confidentiality = label.confidentiality;
  }
  if (label.integrity.atoms.length > 0) {
    result.integrity = label.integrity.atoms;
  }
  return result;
}

export function labelFromSchemaIfc(ifc: {
  classification?: string[];
}): Label {
  if (!ifc.classification || ifc.classification.length === 0) {
    return emptyLabel();
  }

  const confidentiality: ConfidentialityLabel = ifc.classification.map(
    (level) => [classificationAtom(level)],
  );

  return {
    confidentiality,
    integrity: emptyIntegrity(),
  };
}
