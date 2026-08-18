import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  aggregate,
  churnFamilies,
  collisions,
  identityKey,
  overSixtySeconds,
} from "./test-records-report.ts";
import type {
  StoredReport,
  TestRecord,
} from "@commonfabric/test-support/records";

function record(
  n: string,
  outcome: "pass" | "fail",
  durationMs: number,
): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "bakery", n },
    outcome,
    durationMs,
  };
}

function report(objectName: string, records: TestRecord[]): StoredReport {
  return { objectName, context: undefined, records };
}

describe("test-records-report", () => {
  describe("aggregate()", () => {
    it("returns runs, failures, and the worst duration per identity", () => {
      const byIdentity = aggregate([
        report("a", [record("glaze", "pass", 10), record("glaze", "fail", 90)]),
        report("b", [record("glaze", "pass", 40)]),
      ]);
      const entry = byIdentity.get(identityKey({
        k: "unit",
        s: "bakery",
        n: "glaze",
      }));
      expect(entry).toEqual({
        key: '["unit","bakery","glaze"]',
        runs: 3,
        failures: 1,
        skips: 0,
        maxDurationMs: 90,
      });
    });
  });

  describe("collisions()", () => {
    it("returns identities reported twice within one object", () => {
      const found = collisions([
        report("a", [record("same", "pass", 1), record("same", "pass", 2)]),
        report("b", [record("same", "pass", 3)]),
      ]);
      expect(found).toEqual([
        { objectName: "a", key: '["unit","bakery","same"]', count: 2 },
      ]);
    });
  });

  describe("churnFamilies()", () => {
    it("returns families of one-run identities with digits collapsed", () => {
      const byIdentity = aggregate([
        report("a", [
          record("case #1", "pass", 1),
          record("case #2", "pass", 1),
          record("case #3", "pass", 1),
          record("stable name", "pass", 1),
        ]),
        report("b", [record("stable name", "pass", 1)]),
      ]);
      expect(churnFamilies(byIdentity, 2)).toEqual([
        { family: '["unit","bakery","case ##"]', members: 3 },
      ]);
    });

    it("returns nothing for a single-run window", () => {
      const byIdentity = aggregate([
        report("a", [record("case #1", "pass", 1)]),
      ]);
      expect(churnFamilies(byIdentity, 1)).toEqual([]);
    });
  });

  describe("overSixtySeconds()", () => {
    it("returns identities whose worst duration crossed the rule", () => {
      const byIdentity = aggregate([
        report("a", [
          record("slow", "pass", 61_000),
          record("fast", "pass", 100),
        ]),
      ]);
      const slow = overSixtySeconds(byIdentity);
      expect(slow.length).toBe(1);
      expect(slow[0]?.key).toBe('["unit","bakery","slow"]');
    });
  });
});
