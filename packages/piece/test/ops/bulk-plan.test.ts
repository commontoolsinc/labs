import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  decodePlan,
  deriveRollbackPlan,
  encodePlan,
  type PiecePlan,
} from "../../src/ops/bulk-plan.ts";

const header = {
  kind: "piece-plan",
  v: 1,
  space: "did:key:test",
  takenAt: "2026-08-24T00:00:00.000Z",
  enumerated: { collection: 2, registry: 1, registeredOutside: 0 },
} as const;

function retargetPlan(): PiecePlan {
  return {
    header,
    rows: [
      {
        piece: "of:fid1:aaa",
        phase: "topics",
        expect: { patternIdentity: "old-a", symbol: "default", retained: true },
        op: {
          kind: "retarget",
          source: { main: "topic.tsx" },
          rev: "abc123",
          patternIdentity: "new-a",
          symbol: "default",
          allowIncompatible: true,
        },
      },
      {
        piece: "of:fid1:bbb",
        phase: "holder",
        expect: {
          patternIdentity: "old-b",
          symbol: "Board",
          retained: true,
          revisionId: "rev-b",
        },
        op: {
          kind: "retarget",
          source: { main: "main.tsx", mainExport: "Board" },
          patternIdentity: "new-b",
          symbol: "Board",
        },
      },
    ],
  };
}

describe("bulk-plan", () => {
  describe("encodePlan()", () => {
    it("returns the header line first, then one row per line, in order", () => {
      const lines = encodePlan(retargetPlan()).trimEnd().split("\n");
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0]).kind).toBe("piece-plan");
      expect(JSON.parse(lines[1]).piece).toBe("of:fid1:aaa");
      expect(JSON.parse(lines[2]).piece).toBe("of:fid1:bbb");
    });

    it("returns text ending in a newline", () => {
      expect(encodePlan({ header, rows: [] }).endsWith("\n")).toBe(true);
    });
  });

  describe("decodePlan()", () => {
    it("returns the encoded plan unchanged on a round-trip", () => {
      const plan = retargetPlan();
      expect(decodePlan(encodePlan(plan))).toEqual(plan);
    });

    it("returns the plan when blank lines were inserted by hand", () => {
      const text = encodePlan(retargetPlan()).replace("\n", "\n\n");
      expect(decodePlan(text)).toEqual(retargetPlan());
    });

    it("throws for empty text", () => {
      expect(() => decodePlan("\n\n")).toThrow("empty");
    });

    it("throws when the first line is not a piece-plan header", () => {
      const rowOnly = encodePlan(retargetPlan()).split("\n").slice(1).join(
        "\n",
      );
      expect(() => decodePlan(rowOnly)).toThrow("header");
    });

    it("throws when the first line is not an object at all", () => {
      expect(() => decodePlan('"hello"\n')).toThrow("header");
    });

    it("throws for a header whose enumerated counts are not numbers", () => {
      const bad = {
        ...header,
        enumerated: { collection: "3", registry: 0, registeredOutside: 0 },
      };
      expect(() => decodePlan(JSON.stringify(bad) + "\n")).toThrow("header");
    });

    it("throws for a row missing its precondition, naming the row", () => {
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify({ piece: "of:fid1:aaa" }) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a precondition without its export symbol", () => {
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify({
          piece: "of:fid1:aaa",
          expect: { patternIdentity: "x", retained: true },
        }) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a row that is not an object, and for a numeric piece", () => {
      const withNumber = JSON.stringify(header) + "\n5\n";
      expect(() => decodePlan(withNumber)).toThrow("row 1");
      const numericPiece = JSON.stringify(header) + "\n" +
        JSON.stringify({ piece: 7, expect: {} }) + "\n";
      expect(() => decodePlan(numericPiece)).toThrow("row 1");
    });

    it("returns a derived rollback unchanged on a round-trip", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(decodePlan(encodePlan(rollback))).toEqual(rollback);
    });

    it("throws for a phase that is not a string, and for an op that is not an object", () => {
      const plan = retargetPlan();
      const badPhase = { ...plan.rows[0], phase: 7 };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(badPhase))
      ).toThrow("row 1");
      const badOp = { ...plan.rows[0], op: 5 };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(badOp))
      ).toThrow("row 1");
    });

    it("throws for a restore op whose revision is not a string", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "restore",
          patternIdentity: "x",
          symbol: "default",
          revisionId: 7,
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(row))
      ).toThrow("row 1");
    });

    it("throws for a plan listing one piece twice", () => {
      const plan = retargetPlan();
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify(plan.rows[0]) + "\n" + JSON.stringify(plan.rows[0]);
      expect(() => decodePlan(text)).toThrow("more than once");
    });

    it("throws for a retarget whose symbol disagrees with its source export", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx", mainExport: "Other" },
          patternIdentity: "x",
          symbol: "default",
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(row))
      ).toThrow("row 1");
      const numericExport = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx", mainExport: 7 },
          patternIdentity: "x",
          symbol: "default",
        },
      };
      expect(() =>
        decodePlan(
          JSON.stringify(header) + "\n" + JSON.stringify(numericExport),
        )
      ).toThrow("row 1");
    });

    it("throws for an op of an unknown kind", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: { kind: "repaint", patternIdentity: "x", symbol: "default" },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a retarget op without a source main", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: {},
          patternIdentity: "x",
          symbol: "default",
        },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for an op without its export symbol", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: { kind: "restore", patternIdentity: "x" },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });
  });

  describe("deriveRollbackPlan()", () => {
    it("returns rows whose precondition is the reference the retarget produced", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.expect)).toEqual([
        { patternIdentity: "new-a", symbol: "default", retained: true },
        { patternIdentity: "new-b", symbol: "Board", retained: true },
      ]);
    });

    it("returns restore ops naming each row's recorded reference and revision", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.op)).toEqual([
        { kind: "restore", patternIdentity: "old-a", symbol: "default" },
        {
          kind: "restore",
          patternIdentity: "old-b",
          symbol: "Board",
          revisionId: "rev-b",
        },
      ]);
    });

    it("returns a header stamped with the given time, same space", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.header).toEqual({ ...header, takenAt: "later" });
    });

    it("leaves out rows that carry no retarget", () => {
      const plan = retargetPlan();
      const mixed: PiecePlan = {
        header,
        rows: [plan.rows[0], {
          piece: "of:fid1:ccc",
          expect: {
            patternIdentity: "old-c",
            symbol: "default",
            retained: true,
          },
        }],
      };
      const rollback = deriveRollbackPlan(mixed, "later");
      expect(rollback.rows.map((row) => row.piece)).toEqual(["of:fid1:aaa"]);
    });

    it("throws for a retarget row whose prior source is not retained, naming it", () => {
      const plan = retargetPlan();
      const unretained: PiecePlan = {
        header,
        rows: [plan.rows[0], {
          ...plan.rows[1],
          expect: { ...plan.rows[1].expect, retained: false },
        }],
      };
      expect(() => deriveRollbackPlan(unretained, "later")).toThrow(
        "of:fid1:bbb",
      );
    });

    it("throws for a plan with no retarget rows", () => {
      const surveyOnly: PiecePlan = {
        header,
        rows: [{
          piece: "of:fid1:aaa",
          expect: {
            patternIdentity: "old-a",
            symbol: "default",
            retained: true,
          },
        }],
      };
      expect(() => deriveRollbackPlan(surveyOnly, "later")).toThrow(
        "no retarget rows",
      );
    });
  });
});
