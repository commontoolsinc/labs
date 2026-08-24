import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { diffPlan } from "../../src/ops/bulk-diff.ts";
import type { PiecePlan, PiecePlanRow } from "../../src/ops/bulk-plan.ts";

const header = {
  kind: "piece-plan",
  v: 1,
  space: "did:key:test",
  takenAt: "2026-08-24T00:00:00.000Z",
  enumerated: { collection: 4, registry: 0, registeredOutside: 0 },
} as const;

function retargetRow(piece: string, from: string, to: string): PiecePlanRow {
  return {
    piece,
    phase: "topics",
    expect: { patternIdentity: from, retained: true },
    op: {
      kind: "retarget",
      source: { main: "topic.tsx" },
      patternIdentity: to,
    },
  };
}

function surveyRow(piece: string, identity: string): PiecePlanRow {
  return { piece, expect: { patternIdentity: identity, retained: true } };
}

describe("bulk-diff", () => {
  describe("diffPlan()", () => {
    it("returns landed, outstanding, and moved-elsewhere for retarget rows", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          retargetRow("of:fid1:aaa", "old", "new"),
          retargetRow("of:fid1:bbb", "old", "new"),
          retargetRow("of:fid1:ccc", "old", "new"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [
          surveyRow("of:fid1:aaa", "new"),
          surveyRow("of:fid1:bbb", "old"),
          surveyRow("of:fid1:ccc", "other"),
        ],
      };
      expect(diffPlan(plan, after).rows.map((row) => row.status)).toEqual(
        ["landed", "outstanding", "moved-elsewhere"],
      );
    });

    it("returns unchanged and changed for rows without an op", () => {
      const plan: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaa", "same"), surveyRow("of:fid1:bbb", "a")],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaa", "same"), surveyRow("of:fid1:bbb", "b")],
      };
      expect(diffPlan(plan, after).rows.map((row) => row.status)).toEqual(
        ["unchanged", "changed"],
      );
    });

    it("returns missing for a plan row the after-survey lacks", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaa", "x")] };
      const diff = diffPlan(plan, { header, rows: [] });
      expect(diff.rows[0].status).toBe("missing");
      expect(diff.rows[0].after).toBeUndefined();
    });

    it("returns pieces only the after-survey holds as unplanned", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaa", "x")] };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaa", "x"), surveyRow("of:fid1:new", "x")],
      };
      expect(diffPlan(plan, after).unplanned).toEqual(["of:fid1:new"]);
    });

    it("returns the identities each verdict was decided from", () => {
      const plan: PiecePlan = {
        header,
        rows: [retargetRow("of:fid1:aaa", "old", "new")],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaa", "other")],
      };
      expect(diffPlan(plan, after).rows[0]).toEqual({
        piece: "of:fid1:aaa",
        phase: "topics",
        status: "moved-elsewhere",
        before: "old",
        after: "other",
        target: "new",
      });
    });

    it("returns counts that add up to the plan's rows", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          retargetRow("of:fid1:aaa", "old", "new"),
          retargetRow("of:fid1:bbb", "old", "new"),
          surveyRow("of:fid1:ccc", "x"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaa", "new"), surveyRow("of:fid1:ccc", "x")],
      };
      const { counts } = diffPlan(plan, after);
      expect(counts).toEqual({
        landed: 1,
        outstanding: 0,
        "moved-elsewhere": 0,
        unchanged: 1,
        changed: 0,
        missing: 1,
      });
    });
  });
});
