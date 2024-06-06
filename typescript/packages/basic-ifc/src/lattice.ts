import { Principal, Concept } from "./principals.ts";

/**
 * Statement of trust between principals, stated by user or verifier
 */
export type Trust = [Principal, Principal[]];

/**
 * Lattice of principals, each listing itself and all principals that are more
 * trusted than itself.
 */
export interface Lattice {
  up: Map<Principal, Principal[]>;
  concepts: Map<string, Principal[]>;
}

export function makeLattice(trustStatements: Trust[]): Lattice {
  function traverse(p: Principal): Principal[] {
    const trusted = trustStatements.find(([q]) => q === p)?.[1];
    if (!trusted) return [p];
    return [p, ...trusted.flatMap(traverse)];
  }

  const up = new Map<Principal, Principal[]>();
  const concepts = new Map<string, Principal[]>();
  for (const [p, trusted] of trustStatements) {
    // Get a partially sorted list all parents of p
    //
    // Strategy: Collect all recursively, then dedupe keeping the last entry.
    // That way there is no contradiaction.
    const seen = new Set<Principal>();
    const all: Principal[] = [];
    traverse(p)
      .reverse()
      .forEach((p) => {
        if (!seen.has(p)) {
          seen.add(p);
          all.push(p);
        }
      });
    up.set(p, all.reverse());

    // Add concepts to the concepts map, indexed by stringified concept
    if (p instanceof Concept) concepts.set(p.toString(), trusted);
  }

  return { up, concepts };
}
