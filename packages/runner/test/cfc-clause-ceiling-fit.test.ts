import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  cfcObservationFitsCeiling,
  meetCfcObservationCeilings,
} from "../src/cfc/observation.ts";

// Epic A2 (docs/plans/cfc-future-work-implementation.md): the ceiling-fit
// check becomes CNF clause subsumption (spec §8.10.3). The load-bearing case
// is the reader-enumeration quantifier fix — a multi-party label must NOT fit
// an "A or B may observe" ceiling.

const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const C = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

describe("CFC clause-aware ceiling fit", () => {
  describe("flat labels/ceilings behave exactly as before (golden)", () => {
    it("undefined ceiling admits everything", () => {
      expect(cfcObservationFitsCeiling([A, B], undefined)).toBe(true);
    });

    it("public data fits any ceiling incl. the empty one", () => {
      expect(cfcObservationFitsCeiling([], [])).toBe(true);
      expect(cfcObservationFitsCeiling([], [A])).toBe(true);
    });

    it("empty ceiling rejects any confidential atom", () => {
      expect(cfcObservationFitsCeiling([A], [])).toBe(false);
    });

    it("flat subset membership", () => {
      expect(cfcObservationFitsCeiling([A], [A, B])).toBe(true);
      expect(cfcObservationFitsCeiling([A, B], [A, B])).toBe(true);
      expect(cfcObservationFitsCeiling([A, C], [A, B])).toBe(false);
      expect(atomsOutsideCeiling([A, C], [A, B])).toEqual([C]);
    });

    it("read-failed marker is ungrantable even if the ceiling names it", () => {
      expect(
        cfcObservationFitsCeiling([CFC_LABEL_READ_FAILED_ATOM], [
          CFC_LABEL_READ_FAILED_ATOM,
        ]),
      ).toBe(false);
      expect(
        atomsOutsideCeiling([CFC_LABEL_READ_FAILED_ATOM], [
          CFC_LABEL_READ_FAILED_ATOM,
        ]),
      ).toEqual([CFC_LABEL_READ_FAILED_ATOM]);
    });
  });

  describe("reader-enumeration ceiling (the §8.10.3 soundness fix)", () => {
    it("a multi-party label does NOT fit an 'A or B' ceiling", () => {
      // Label [User(A), User(B)] = two conjunctive clauses: BOTH must be
      // satisfied, so nobody alone may read. Ceiling [{A ∨ B}] = "either A or
      // B observes the destination". Showing it to A alone violates B's
      // clause — must fail closed. (Flat pre-A2 code wrongly passed this.)
      const label = [A, B];
      const ceiling = [{ anyOf: [A, B] }];
      expect(cfcObservationFitsCeiling(label, ceiling)).toBe(false);
      // Both singleton clauses are outside: neither is subsumed by {A∨B}
      // (alts {A,B} ⊄ {A}, ⊄ {B}).
      expect(atomsOutsideCeiling(label, ceiling)).toEqual([A, B]);
    });

    it("a single-party label fits the enumeration naming that party", () => {
      // Label [User(A)] fits ceiling [{A ∨ B}]? alts({A,B}) ⊆ {A}? No — the
      // enumeration would also admit B, who is not entitled. Fail closed.
      expect(cfcObservationFitsCeiling([A], [{ anyOf: [A, B] }])).toBe(false);
    });

    it("an enumeration label fits a narrower single-reader ceiling", () => {
      // Label [{A ∨ B}] = readable by A OR B. Ceiling [A] = only A observes.
      // alts(A)={A} ⊆ alts({A,B})={A,B} → subsumed → fits. A is entitled to
      // data anyone-of-{A,B} may read.
      expect(cfcObservationFitsCeiling([{ anyOf: [A, B] }], [A])).toBe(true);
      // Ceiling naming a non-member does not fit.
      expect(cfcObservationFitsCeiling([{ anyOf: [A, B] }], [C])).toBe(false);
    });

    it("enumeration ceiling subsumes an equal-or-wider label clause", () => {
      // ceiling {A∨B} subsumes label {A∨B∨C} (alts {A,B} ⊆ {A,B,C}).
      expect(
        cfcObservationFitsCeiling([{ anyOf: [A, B, C] }], [{ anyOf: [A, B] }]),
      ).toBe(true);
      // ...but NOT label {A∨C} (alts {A,B} ⊄ {A,C}).
      expect(
        cfcObservationFitsCeiling([{ anyOf: [A, C] }], [{ anyOf: [A, B] }]),
      ).toBe(false);
    });
  });

  describe("meet stays conservative for clauses", () => {
    it("flat meet is set intersection (unchanged)", () => {
      expect(meetCfcObservationCeilings([A, B], [B, C])).toEqual([B]);
      expect(meetCfcObservationCeilings(undefined, [A])).toEqual([A]);
      expect(meetCfcObservationCeilings([A], undefined)).toEqual([A]);
    });

    it("an OR-clause survives meet only if both sides list it identically", () => {
      const clause = { anyOf: [A, B] };
      expect(meetCfcObservationCeilings([clause], [clause])).toEqual([clause]);
      // present on only one side → dropped (more restrictive, fail-safe).
      expect(meetCfcObservationCeilings([clause], [A])).toEqual([]);
    });
  });
});
