/**
 * TrustLattice encodes the hardcoded relationships between atom kinds,
 * including the classification hierarchy and composite label comparison.
 */

import { type Atom, atomEquals, canonicalizeAtom } from "./atoms.ts";
import { type Label } from "./labels.ts";
import { confidentialityLeq } from "./confidentiality.ts";
import { integrityLeq } from "./integrity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LatticeRelation = "above" | "below" | "equal" | "incomparable";

// ---------------------------------------------------------------------------
// Default classification order
// ---------------------------------------------------------------------------

const DEFAULT_CLASSIFICATION_ORDER: Map<string, string[]> = new Map([
  ["unclassified", []],
  ["confidential", ["unclassified"]],
  ["secret", ["confidential"]],
  ["topsecret", ["secret"]],
]);

// ---------------------------------------------------------------------------
// TrustLattice
// ---------------------------------------------------------------------------

export class TrustLattice {
  private readonly order: Map<string, string[]>;
  private readonly reachableCache: Map<string, Set<string>>;

  constructor(classificationOrder?: Map<string, string[]>) {
    this.order = classificationOrder ?? DEFAULT_CLASSIFICATION_ORDER;
    this.reachableCache = new Map();

    // Pre-compute reachability for all levels.
    for (const level of this.order.keys()) {
      this.reachableCache.set(level, this.computeReachable(level));
    }
  }

  /** All levels transitively below the given level (not including itself). */
  reachable(level: string): Set<string> {
    const cached = this.reachableCache.get(level);
    if (cached) return cached;
    // For levels not in the order map, return empty.
    const computed = this.computeReachable(level);
    this.reachableCache.set(level, computed);
    return computed;
  }

  /** Is classification level a <= b? */
  classificationLeq(a: string, b: string): boolean {
    if (a === b) return true;
    return this.reachable(b).has(a);
  }

  /** Compare two individual atoms. */
  compareAtoms(a: Atom, b: Atom): LatticeRelation {
    if (atomEquals(a, b)) return "equal";

    // Classification atoms use the classification order.
    if (a.kind === "Classification" && b.kind === "Classification") {
      const aLevel = a.level;
      const bLevel = b.level;
      const aReachesB = this.reachable(aLevel).has(bLevel);
      const bReachesA = this.reachable(bLevel).has(aLevel);
      if (aReachesB) return "above";
      if (bReachesA) return "below";
      return "incomparable";
    }

    // Different kinds or same kind with different parameters.
    return "incomparable";
  }

  /** Compare composite labels. */
  compareLabels(a: Label, b: Label): LatticeRelation {
    const aLeqB =
      confidentialityLeq(a.confidentiality, b.confidentiality) &&
      integrityLeq(a.integrity, b.integrity);
    const bLeqA =
      confidentialityLeq(b.confidentiality, a.confidentiality) &&
      integrityLeq(b.integrity, a.integrity);

    if (aLeqB && bLeqA) return "equal";
    if (aLeqB) return "below";
    if (bLeqA) return "above";
    return "incomparable";
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private computeReachable(level: string): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [];

    const directChildren = this.order.get(level);
    if (directChildren) {
      for (const child of directChildren) {
        queue.push(child);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = this.order.get(current);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) {
            queue.push(child);
          }
        }
      }
    }

    return visited;
  }
}
