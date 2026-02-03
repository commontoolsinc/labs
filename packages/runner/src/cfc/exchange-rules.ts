/**
 * Exchange rules — integrity-guarded confidentiality rewrites that enable
 * controlled declassification.
 *
 * An exchange rule says: "if the label has these confidentiality clauses AND
 * these integrity atoms, then add these alternatives to matching clauses."
 * This widens the set of principals that may read the data without dropping
 * integrity requirements.
 */

import { type Atom, canonicalizeAtom } from "./atoms.ts";
import type { ConfidentialityLabel } from "./confidentiality.ts";
import { normalizeConfidentiality } from "./confidentiality.ts";
import type { Label } from "./labels.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An atom template that may contain variable bindings (strings starting with $). */
export type AtomPattern = {
  kind: Atom["kind"];
  params: Record<string, string>; // key = param name, value = literal or "$varName"
};

export type ExchangeRule = {
  /** Confidentiality clauses that must be present (patterns). */
  confidentialityPre: AtomPattern[];
  /** Integrity atoms that must be present (patterns). */
  integrityPre: AtomPattern[];
  /** Alternatives to add to matching confidentiality clauses. */
  addAlternatives: AtomPattern[];
  /** Variables used in this rule (for documentation). */
  variables: string[];
  /**
   * If true, remove matched clauses entirely instead of adding alternatives.
   * Used for authority-only atoms (e.g., OAuth tokens that authorize but
   * should not taint the response).
   */
  removeMatchedClauses?: boolean;
  /**
   * When set, this rule is sink-scoped: it only fires during
   * `checkSinkAndWrite` for the named sink (e.g. "fetchData").
   */
  allowedSink?: string;
  /**
   * Paths within the sink's input where declassification is allowed.
   * Only meaningful when `allowedSink` is set.
   */
  allowedPaths?: readonly (readonly string[])[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the parameter entries from a concrete atom (everything except `kind`). */
function atomParams(atom: Atom): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(atom)) {
    if (k !== "kind") result[k] = v;
  }
  return result;
}

function isVariable(value: string): boolean {
  return value.startsWith("$");
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Try to match a pattern against a concrete atom. Returns updated bindings on
 * success, null on failure. If a variable is already bound, the atom's value
 * must equal the existing binding.
 */
export function matchAtomPattern(
  pattern: AtomPattern,
  atom: Atom,
  bindings: Map<string, string>,
): Map<string, string> | null {
  if (pattern.kind !== atom.kind) return null;

  const params = atomParams(atom);
  const updated = new Map(bindings);

  for (const [key, patternValue] of Object.entries(pattern.params)) {
    if (!(key in params)) return null;
    const atomValue = String(params[key]);

    if (isVariable(patternValue)) {
      const existing = updated.get(patternValue);
      if (existing !== undefined) {
        if (existing !== atomValue) return null;
      } else {
        updated.set(patternValue, atomValue);
      }
    } else {
      if (patternValue !== atomValue) return null;
    }
  }

  return updated;
}

/**
 * Instantiate a pattern with bound variables, producing a concrete atom.
 */
export function instantiatePattern(
  pattern: AtomPattern,
  bindings: Map<string, string>,
): Atom {
  const result: Record<string, unknown> = { kind: pattern.kind };
  for (const [key, value] of Object.entries(pattern.params)) {
    if (isVariable(value)) {
      const bound = bindings.get(value);
      if (bound === undefined) {
        throw new Error(`Unbound variable ${value} in pattern`);
      }
      // Preserve numeric types for atoms like ExpiresAtom.timestamp
      const asNum = Number(bound);
      result[key] = !isNaN(asNum) && bound === String(asNum) ? asNum : bound;
    } else {
      result[key] = value;
    }
  }
  return result as unknown as Atom;
}

// ---------------------------------------------------------------------------
// Precondition matching
// ---------------------------------------------------------------------------

/**
 * Return all valid variable binding sets where the rule's preconditions are
 * satisfied against the given label.
 */
export function matchPrecondition(
  label: Label,
  rule: ExchangeRule,
): Map<string, string>[] {
  // Start with a single empty binding set.
  let bindingSets: Map<string, string>[] = [new Map()];

  // Match each confidentiality precondition pattern against some clause.
  for (const pattern of rule.confidentialityPre) {
    const next: Map<string, string>[] = [];
    for (const bs of bindingSets) {
      for (const clause of label.confidentiality) {
        for (const atom of clause) {
          const result = matchAtomPattern(pattern, atom, bs);
          if (result !== null) {
            next.push(result);
          }
        }
      }
    }
    bindingSets = next;
    if (bindingSets.length === 0) return [];
  }

  // Match each integrity precondition pattern against integrity atoms.
  for (const pattern of rule.integrityPre) {
    const next: Map<string, string>[] = [];
    for (const bs of bindingSets) {
      for (const atom of label.integrity.atoms) {
        const result = matchAtomPattern(pattern, atom, bs);
        if (result !== null) {
          next.push(result);
        }
      }
    }
    bindingSets = next;
    if (bindingSets.length === 0) return [];
  }

  // Deduplicate binding sets by their serialized form.
  const seen = new Set<string>();
  const unique: Map<string, string>[] = [];
  for (const bs of bindingSets) {
    const entries = [...bs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const key = JSON.stringify(entries);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(bs);
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Rule application
// ---------------------------------------------------------------------------

/**
 * Instantiate the `addAlternatives` patterns with the given bindings and add
 * them as alternatives to confidentiality clauses that match a precondition
 * pattern. Returns a new label.
 */
export function applyRule(
  label: Label,
  rule: ExchangeRule,
  bindings: Map<string, string>,
): Label {
  const newAlternatives: Atom[] = rule.addAlternatives.map((p) =>
    instantiatePattern(p, bindings)
  );

  // Find clauses that contain an atom matching any confidentiality precondition.
  const newConfidentiality: ConfidentialityLabel = [];
  for (const clause of label.confidentiality) {
    let matches = false;
    for (const pattern of rule.confidentialityPre) {
      for (const atom of clause) {
        if (matchAtomPattern(pattern, atom, bindings) !== null) {
          matches = true;
          break;
        }
      }
      if (matches) break;
    }
    if (matches && rule.removeMatchedClauses) {
      // Authority-only: drop the entire clause
      continue;
    }
    if (matches) {
      // Add alternatives, deduplicating by canonical form.
      const existing = new Set(clause.map(canonicalizeAtom));
      const extended = [...clause];
      for (const alt of newAlternatives) {
        if (!existing.has(canonicalizeAtom(alt))) {
          existing.add(canonicalizeAtom(alt));
          extended.push(alt);
        }
      }
      newConfidentiality.push(extended);
    } else {
      newConfidentiality.push(clause);
    }
  }

  return {
    confidentiality: normalizeConfidentiality(newConfidentiality),
    integrity: label.integrity,
  };
}

// ---------------------------------------------------------------------------
// Fixpoint evaluation
// ---------------------------------------------------------------------------

function serializeLabel(label: Label): string {
  const confKey = label.confidentiality
    .map((clause) =>
      clause
        .map(canonicalizeAtom)
        .sort()
        .join("|")
    )
    .sort()
    .join("&");
  const intKey = label.integrity.atoms.map(canonicalizeAtom).sort().join(",");
  return `C[${confKey}]I[${intKey}]`;
}

/**
 * Fixpoint iteration: repeatedly apply all matching rules until the label
 * stops changing. Throws if not converged within 100 iterations.
 */
export function evaluateRules(label: Label, rules: ExchangeRule[]): Label {
  const MAX_ITERATIONS = 100;
  let current = label;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let next = current;

    for (const rule of rules) {
      const allBindings = matchPrecondition(next, rule);
      for (const bindings of allBindings) {
        next = applyRule(next, rule, bindings);
      }
    }

    if (serializeLabel(next) === serializeLabel(current)) {
      return next;
    }
    current = next;
  }

  throw new Error(
    `Exchange rule evaluation did not converge after ${MAX_ITERATIONS} iterations`,
  );
}
