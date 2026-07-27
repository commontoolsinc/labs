// standard-labels.ts - Smart-default labels for multi-instance modules.
//
// When a second module of a label-bearing type (email, phone, address) is
// added to a Record, the new module defaults to the next standard label not
// already in use, so successive quick-adds get distinct labels instead of all
// defaulting to the same one.
//
// This module only depends on the SubPieceEntry type, so it can be imported
// and unit-tested without pulling in the Common Fabric runtime.

import type { SubPieceEntry } from "./types.ts";

// Standard labels offered for each label-bearing module type, in the order they
// are handed out.
export const STANDARD_LABELS: Record<string, string[]> = {
  email: ["Personal", "Work", "School", "Other"],
  phone: ["Mobile", "Home", "Work", "Other"],
  address: ["Home", "Work", "Billing", "Shipping", "Other"],
};

// The first standard label for a type that no existing entry of that type has
// already taken, or undefined when the type has no standard labels or all of
// them are in use.
//
// The label is read from the entry, which records the label chosen when the
// module was created. The label on the sub-piece itself is not readable here:
// SubPieceEntry.piece is typed `unknown`, whose schema (`{ type: "unknown" }`)
// the runner reads back as undefined rather than materializing.
export function getNextUnusedLabel(
  type: string,
  existingPieces: readonly SubPieceEntry[],
): string | undefined {
  const standards = STANDARD_LABELS[type];
  if (!standards || standards.length === 0) return undefined;

  const usedLabels = new Set<string>();
  for (const entry of existingPieces) {
    if (entry.type === type && typeof entry.label === "string" && entry.label) {
      usedLabels.add(entry.label);
    }
  }

  return standards.find((label) => !usedLabels.has(label));
}
