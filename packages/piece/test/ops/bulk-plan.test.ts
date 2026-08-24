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
        expect: { patternIdentity: "old-a", retained: true },
        op: {
          kind: "retarget",
          source: { main: "topic.tsx" },
          rev: "abc123",
          patternIdentity: "new-a",
          allowIncompatible: true,
        },
      },
      {
        piece: "of:fid1:bbb",
        phase: "holder",
        expect: {
          patternIdentity: "old-b",
          retained: true,
          revisionId: "rev-b",
        },
        op: {
          kind: "retarget",
          source: { main: "main.tsx" },
          patternIdentity: "new-b",
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

    it("throws for a row missing its precondition, naming the row", () => {
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify({ piece: "of:fid1:aaa" }) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });
  });

  describe("deriveRollbackPlan()", () => {
    it("returns rows whose precondition is the identity the retarget produced", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.expect.patternIdentity))
        .toEqual(["new-a", "new-b"]);
      expect(rollback.rows.every((row) => row.expect.retained)).toBe(true);
    });

    it("returns restore ops naming each row's recorded identity and revision", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.op)).toEqual([
        { kind: "restore", patternIdentity: "old-a" },
        { kind: "restore", patternIdentity: "old-b", revisionId: "rev-b" },
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
          expect: { patternIdentity: "old-c", retained: false },
        }],
      };
      const rollback = deriveRollbackPlan(mixed, "later");
      expect(rollback.rows.map((row) => row.piece)).toEqual(["of:fid1:aaa"]);
    });

    it("throws for a plan with no retarget rows", () => {
      const surveyOnly: PiecePlan = {
        header,
        rows: [{
          piece: "of:fid1:aaa",
          expect: { patternIdentity: "old-a", retained: true },
        }],
      };
      expect(() => deriveRollbackPlan(surveyOnly, "later")).toThrow(
        "no retarget rows",
      );
    });
  });
});
