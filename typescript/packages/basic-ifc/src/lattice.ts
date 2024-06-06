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
  allUp: Map<Principal, Principal[]>;
  concepts: Map<string, Principal[]>;
}

export function makeLattice(trustStatements: Trust[]): Lattice {
  function traverse(p: Principal): Principal[] {
    const trusted = up.get(p);
    if (!trusted) return [p];
    return [p, ...trusted.flatMap(traverse)];
  }

  const up = new Map<Principal, Principal[]>();
  const allUp = new Map<Principal, Principal[]>();
  for (const [p, trusted] of trustStatements) {
    up.set(p, trusted);

    // Get a partially sorted list all parents of p
    //
    // Strategy: Collect all recursively, then dedupe keeping the last entry.
    // That way there is no contradiaction.
    const all = trusted.flatMap(traverse);
    const seen = new Set<Principal>();
    const allDeduped: Principal[] = [];
    all.reverse().forEach((p) => {
      if (!seen.has(p)) {
        seen.add(p);
        allDeduped.push(p);
      }
    });
    allUp.set(p, allDeduped);
  }

  const concepts = new Map<string, Principal[]>(
    trustStatements
      .filter((c) => c instanceof Concept)
      .map(([c, p]) => [c.toString(), p])
  );

  return { up, allUp, concepts };
}
