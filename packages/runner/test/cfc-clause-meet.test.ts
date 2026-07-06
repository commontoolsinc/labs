import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  cfcObservationFitsCeiling,
  type CfcObservationMaxConfidentiality,
  meetCfcObservationCeilings,
} from "../src/cfc/observation.ts";
import { clausesEqual, normalizeClause } from "../src/cfc/clause.ts";

// Decision 6 of docs/plans/cfc-future-work-implementation.md (corrected
// 2026-07-02, #4482): the general clause meet is the pairwise
// alternative-set UNION. This file carries the targeted algebra cases and
// the both-direction property test the plan requires before clause ceilings
// reach the meet seam (B5 BoundaryContext/sink ceilings, H3b render
// ceiling).

const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const C = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

const clauseSetsEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((clause) => right.some((other) => clausesEqual(clause, other)));

describe("CFC ceiling meet (pairwise alternative-set union)", () => {
  describe("edge cases", () => {
    it("undefined (no ceiling) is the identity", () => {
      expect(meetCfcObservationCeilings(undefined, [A])).toEqual([A]);
      expect(meetCfcObservationCeilings([A], undefined)).toEqual([A]);
      expect(meetCfcObservationCeilings(undefined, undefined)).toBe(undefined);
    });

    it("a declared empty ceiling (public-only) wins", () => {
      expect(meetCfcObservationCeilings([], [A])).toEqual([]);
      expect(meetCfcObservationCeilings([A], [])).toEqual([]);
      expect(meetCfcObservationCeilings([], [])).toEqual([]);
    });

    it("a malformed empty OR-clause contributes nothing", () => {
      // {anyOf:[]} never subsumes (clauseSubsumes fails closed), so a
      // ceiling containing it admits only what its other clauses admit.
      // Pairing it would emit the partner clause verbatim and LOOSEN the
      // meet past the empty-clause parent — it must be skipped instead.
      expect(meetCfcObservationCeilings([{ anyOf: [] }], [A])).toEqual([]);
      expect(meetCfcObservationCeilings([{ anyOf: [] }, A], [A])).toEqual([A]);
    });
  });

  describe("flat/flat ceilings", () => {
    it("equal-atom pairs collapse to the bare atom", () => {
      expect(meetCfcObservationCeilings([A], [A])).toEqual([A]);
    });

    it("distinct-atom cross pairs form an OR-clause, more precise than intersection", () => {
      const met = meetCfcObservationCeilings([A], [B]);
      expect(met).toEqual([normalizeClause({ anyOf: [A, B] })]);
      // Decision-equivalent to the old atom intersection ([]) for FLAT
      // labels: no bare atom fits...
      expect(cfcObservationFitsCeiling([A], met)).toBe(false);
      expect(cfcObservationFitsCeiling([B], met)).toBe(false);
      expect(cfcObservationFitsCeiling([], met)).toBe(true);
      // ...but an OR-label that fits BOTH parents also fits the meet, which
      // the intersection ([]) wrongly rejected.
      const orLabel = [{ anyOf: [A, B] }];
      expect(cfcObservationFitsCeiling(orLabel, [A])).toBe(true);
      expect(cfcObservationFitsCeiling(orLabel, [B])).toBe(true);
      expect(cfcObservationFitsCeiling(orLabel, met)).toBe(true);
    });

    it("multi-atom ceilings: shared atom survives, cross pairs are ORs", () => {
      const met = meetCfcObservationCeilings([A, B], [B, C]);
      expect(met).not.toBe(undefined);
      expect(clauseSetsEqual(met!, [
        normalizeClause({ anyOf: [A, B] }),
        normalizeClause({ anyOf: [A, C] }),
        B,
        normalizeClause({ anyOf: [B, C] }),
      ])).toBe(true);
      // Flat-label decisions match the old atom intersection [B]:
      expect(cfcObservationFitsCeiling([B], met)).toBe(true);
      expect(cfcObservationFitsCeiling([A], met)).toBe(false);
      expect(cfcObservationFitsCeiling([C], met)).toBe(false);
    });
  });

  describe("clause ceilings", () => {
    it("unions alternative sets — never intersects (intersection loosens)", () => {
      const c1 = [{ anyOf: [A, B] }];
      const c2 = [{ anyOf: [B, C] }];
      const met = meetCfcObservationCeilings(c1, c2);
      expect(met).toEqual([normalizeClause({ anyOf: [A, B, C] })]);
      // The unsound intersection meet would be [B], admitting label [B] —
      // which ceiling c1 alone rejects ({A,B} ⊄ {B}):
      expect(cfcObservationFitsCeiling([B], c1)).toBe(false);
      expect(cfcObservationFitsCeiling([B], met)).toBe(false);
      // A label clause wide enough for both parents fits the meet:
      const wide = [{ anyOf: [A, B, C] }];
      expect(cfcObservationFitsCeiling(wide, c1)).toBe(true);
      expect(cfcObservationFitsCeiling(wide, c2)).toBe(true);
      expect(cfcObservationFitsCeiling(wide, met)).toBe(true);
    });

    it("an OR-clause met with a member atom yields the OR-clause", () => {
      // {A,B} ⊆ alts(l) ∧ A ∈ alts(l) ⟺ {A,B} ⊆ alts(l).
      expect(meetCfcObservationCeilings([{ anyOf: [A, B] }], [A]))
        .toEqual([normalizeClause({ anyOf: [A, B] })]);
    });

    it("order-differing equivalent union clauses coalesce via clausesEqual", () => {
      // Both pairs union to {A,B}; a deepEqual-only dedup would keep two
      // order-differing copies.
      const met = meetCfcObservationCeilings(
        [A, { anyOf: [B, A] }],
        [{ anyOf: [A, B] }],
      );
      expect(met).toEqual([normalizeClause({ anyOf: [A, B] })]);
    });
  });

  describe("both-direction property: fits(L, meet(C1,C2)) ⟺ fits(L,C1) ∧ fits(L,C2)", () => {
    // Exhaustive enumeration over a small clause universe, including flat
    // atoms, OR-clauses (with an order-differing spelling), the malformed
    // empty clause, and the ungrantable read-failed marker (bare and
    // wrapped).
    const ceilingClausePool: readonly unknown[] = [
      A,
      B,
      C,
      { anyOf: [A, B] },
      { anyOf: [B, A] },
      { anyOf: [B, C] },
      { anyOf: [A, B, C] },
      { anyOf: [] },
      CFC_LABEL_READ_FAILED_ATOM,
    ];
    const labelClausePool: readonly unknown[] = [
      A,
      B,
      C,
      { anyOf: [A, B] },
      { anyOf: [A, C] },
      { anyOf: [A, B, C] },
      { anyOf: [] },
      CFC_LABEL_READ_FAILED_ATOM,
      { anyOf: [CFC_LABEL_READ_FAILED_ATOM, A] },
    ];

    const subsetsUpToSize2 = (
      pool: readonly unknown[],
    ): readonly (readonly unknown[])[] => {
      const subsets: (readonly unknown[])[] = [[]];
      for (let i = 0; i < pool.length; i++) {
        subsets.push([pool[i]]);
        for (let j = i + 1; j < pool.length; j++) {
          subsets.push([pool[i], pool[j]]);
        }
      }
      return subsets;
    };

    it("holds over every (C1, C2, L) triple in the universe", () => {
      const ceilings: readonly CfcObservationMaxConfidentiality[] = [
        undefined,
        ...subsetsUpToSize2(ceilingClausePool),
      ];
      const labels = subsetsUpToSize2(labelClausePool);
      let checked = 0;
      for (const c1 of ceilings) {
        for (const c2 of ceilings) {
          const met = meetCfcObservationCeilings(c1, c2);
          for (const label of labels) {
            const fitsMet = cfcObservationFitsCeiling(label, met);
            const fitsBoth = cfcObservationFitsCeiling(label, c1) &&
              cfcObservationFitsCeiling(label, c2);
            if (fitsMet !== fitsBoth) {
              throw new Error(
                `meet property violated: ${
                  JSON.stringify({ c1, c2, met, label, fitsMet, fitsBoth })
                }`,
              );
            }
            checked++;
          }
        }
      }
      expect(checked).toBe(ceilings.length ** 2 * labels.length);
    });
  });
});
