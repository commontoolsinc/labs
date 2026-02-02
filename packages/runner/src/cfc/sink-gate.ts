/**
 * Sink gate — applies sink declassification rules to a taint map.
 *
 * For each path in the taint map, checks if any sink rule allows
 * declassification of specific atoms at that path for the given sink.
 * Returns a new label with matched atoms stripped.
 */

import type { Label } from "./labels.ts";
import type { TaintMap } from "./taint-map.ts";
import type { SinkDeclassificationRule } from "./sink-rules.ts";
import { matchAtomPattern } from "./exchange-rules.ts";
import { canonicalizeAtom } from "./atoms.ts";
import { normalizeConfidentiality } from "./confidentiality.ts";

export type SinkDeclassificationResult = {
  label: Label;
  fired: boolean;
};

/**
 * Apply sink declassification rules to a taint map.
 *
 * For each rule where `rule.allowedSink === sinkName`, check each allowed
 * path. If the taint at that path contains atoms matching the rule's pattern,
 * strip those atoms' clauses from the flat label.
 *
 * Returns the declassified label. Also available as `.fired` to indicate
 * whether any atoms were actually stripped.
 *
 * The function is also callable with the old signature (returns Label directly)
 * via the overloaded wrapper below.
 */
function applySinkDeclassificationImpl(
  taintMap: TaintMap,
  sinkName: string,
  rules: SinkDeclassificationRule[],
): SinkDeclassificationResult {
  const flat = taintMap.flatLabel();
  if (rules.length === 0) return { label: flat, fired: false };

  // Collect canonical atoms that should be stripped.
  const strippedAtoms = new Set<string>();

  for (const rule of rules) {
    if (rule.allowedSink !== sinkName) continue;

    for (const allowedPath of rule.allowedPaths) {
      const pathLabel = taintMap.labelAt(allowedPath);

      // Try to match the rule's taint pattern against atoms in this path's label.
      for (const clause of pathLabel.confidentiality) {
        for (const atom of clause) {
          const bindings = matchAtomPattern(
            rule.taintPattern,
            atom,
            new Map(),
          );
          if (bindings !== null) {
            // Mark every atom in clauses that contain a matched atom for stripping.
            // We strip entire clauses that contain the matched atom.
            strippedAtoms.add(canonicalizeAtom(atom));
          }
        }
      }
    }
  }

  if (strippedAtoms.size === 0) return { label: flat, fired: false };

  // Remove clauses from the flat label where any atom was matched for stripping.
  const newConfidentiality = flat.confidentiality.filter((clause) =>
    !clause.some((atom) => strippedAtoms.has(canonicalizeAtom(atom)))
  );

  return {
    label: {
      confidentiality: normalizeConfidentiality(newConfidentiality),
      integrity: flat.integrity,
    },
    fired: true,
  };
}

/**
 * Apply sink declassification rules to a taint map.
 * Returns the declassified label (without the `fired` metadata).
 */
export function applySinkDeclassification(
  taintMap: TaintMap,
  sinkName: string,
  rules: SinkDeclassificationRule[],
): Label {
  return applySinkDeclassificationImpl(taintMap, sinkName, rules).label;
}

/**
 * Apply sink declassification and also report whether any rules fired.
 */
export function applySinkDeclassificationWithResult(
  taintMap: TaintMap,
  sinkName: string,
  rules: SinkDeclassificationRule[],
): SinkDeclassificationResult {
  return applySinkDeclassificationImpl(taintMap, sinkName, rules);
}
