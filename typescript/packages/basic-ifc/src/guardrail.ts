import {
  Principal,
  Expression,
  Confidentiality,
  Concept,
  Integrity,
  JoinExpression,
  BOTTOM,
  dedupe,
} from "./principals.ts";

import { Lattice } from "./lattice.ts";

/**
 * A guardrail principal sets the policies for
 *  - @param canFlowTo – flow _outside_ of the current runtime, e.g. via
 *    capabilities (network, ...), to other runtimes and to other users.
 *  - @param declassifiers - conditions for switching to more permissive
 *    guardrails, typically via modules that declassify data, i.e. make it less
 *    sensitive and thus allow more permissive flows.
 *
 * Both can be empty.
 *
 * Empty `canFlowTo` means that this guardrail doesn't loosen any prior
 * restrictions on flow.
 *
 * Empty `declassifiers` means that this guardrail is an end-point, i.e. there
 * is no path from here to further release (however, there might be different
 * paths)
 *
 * PUBLIC is a special flow principal that allows any flow.
 */
export class Guardrail extends Expression {
  public static readonly PUBLIC = BOTTOM;

  constructor(
    // Data protected by this guardrail can flow to these principals
    // (in)
    public readonly canFlowTo: (Confidentiality | Concept)[],
    public readonly declassifiers: [
      (Integrity | Concept)[],
      Guardrail | Concept
    ][]
  ) {
    super();
  }

  // TOOD: join allows us the eagerly expand guardrails in the declassifiers,
  // because now we have a lattice. For now that's all we'll do.
  //
  // TODO: We can merge them if both are exactly the same post-expansion.
  join(other: Principal, lattice: Lattice): Principal {
    const expanded = this.expand(lattice);
    if (other instanceof Guardrail) {
      const otherExpanded = other.expand(lattice);
      if (expanded.equals(otherExpanded)) return expanded;
      else return new JoinExpression([expanded, otherExpanded]);
    } else {
      return new JoinExpression([expanded, other]);
    }
  }

  equals(other: Principal): boolean {
    if (this === other) return true;
    if (other instanceof Guardrail) {
      if (
        this.canFlowTo.length !== other.canFlowTo.length ||
        this.declassifiers.length !== other.declassifiers.length
      )
        return false;
      return true; // TODO: Implement
    } else return super.equals(other);
  }

  // Expand guardrails mentioned in declassifiers eagerly, i.e. look each up in
  // the lattice and multiply them out with the declassifier terms. The result
  // is again a meet of joins.
  //
  // This will also resolve all concepts mentioned anywhere.
  expand(lattice: Lattice): Guardrail {
    const newCanFlowTo = dedupe(
      this.canFlowTo.flatMap((p) =>
        p instanceof Concept ? p.resolve(lattice) : p
      )
    );

    const newDeclassifiers: typeof this.declassifiers = [];
    for (const [conditions, guardrail] of this.declassifiers) {
      const newConditions = dedupe(
        conditions.flatMap((p) =>
          p instanceof Concept ? p.resolve(lattice) : p
        )
      );
      if (guardrail instanceof Concept) {
        const expandedGuardrail = guardrail
          .resolve(lattice)
          .filter((p) => p instanceof Guardrail || p instanceof Concept) as (
          | Guardrail
          | Concept
        )[];
        if (expandedGuardrail.length === 1) {
          // If it resolved to a single guardrail or concept, we just keep it
          newDeclassifiers.push([newConditions, expandedGuardrail[0]]);
        } else if (expandedGuardrail.length > 1) {
          // We've got multiple guardrails, so we have to multiply them out
          for (const guardrail of expandedGuardrail) {
            if (guardrail instanceof Concept) {
              // If it's a concept, we can't further expand and we just keep it
              newDeclassifiers.push([newConditions, guardrail]);
            } else {
              // If it's a guardrail, let's combine with the conditions.

              // But first, let's recursively expand the guardrail
              const expanded = guardrail.expand(lattice);

              // Now for each declassifier, combine conditions and add
              expanded.declassifiers.forEach(
                ([expandedConditions, expandedGuardrail]) => {
                  newDeclassifiers.push([
                    dedupe([...newConditions, ...expandedConditions]),
                    expandedGuardrail,
                  ]);
                }
              );
            }
          }
        }
      }
    }

    return new Guardrail(newCanFlowTo, newDeclassifiers);
  }
}
