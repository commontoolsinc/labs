import type { Label } from "./labels.ts";
import { canonicalizeAtom } from "./atoms.ts";
import type { Atom } from "./atoms.ts";

/** Structured CFC violation for observability and debugging. */
export type CFCViolation = {
  kind: "write-down" | "clearance-exceeded";
  accumulatedTaint: Label;
  writeTargetLabel: Label;
  /** Human-readable summary */
  summary: string;
};

/** Format a label for human-readable display. */
export function formatLabel(label: Label): string {
  const confParts = label.confidentiality.map(
    (clause) =>
      clause.length === 1
        ? formatAtom(clause[0])
        : `(${clause.map(formatAtom).join(" ∨ ")})`,
  );
  const conf = confParts.length === 0 ? "∅" : confParts.join(" ∧ ");

  const intParts = label.integrity.atoms.map(formatAtom);
  const integ = intParts.length === 0 ? "∅" : intParts.join(" ∧ ");

  return `{conf: ${conf}, int: ${integ}}`;
}

/** Format an atom for display. */
function formatAtom(atom: Atom): string {
  switch (atom.kind) {
    case "Classification":
      return atom.level;
    case "User":
      return `User(${atom.did})`;
    case "Space":
      return `Space(${atom.space})`;
    case "Resource":
      return `Resource(${atom.class}:${atom.subject})`;
    case "Service":
      return `Service(${atom.id})`;
    case "Expires":
      return `Expires(${atom.timestamp})`;
    case "PolicyPrincipal":
      return `Policy(${atom.hash.slice(0, 8)})`;
    case "CodeHash":
      return `Code(${atom.hash.slice(0, 8)})`;
    case "AuthoredBy":
      return `AuthoredBy(${atom.did})`;
    case "EndorsedBy":
      return `EndorsedBy(${atom.did})`;
    case "HasRole":
      return `HasRole(${atom.principal}, ${atom.space}, ${atom.role})`;
  }
}

/** Create a human-readable violation summary. */
export function describeViolation(v: CFCViolation): string {
  return `CFC ${v.kind}: taint ${formatLabel(v.accumulatedTaint)} cannot flow to ${formatLabel(v.writeTargetLabel)}`;
}
