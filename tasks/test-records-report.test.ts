import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  aggregate,
  churnFamilies,
  collisions,
  identityKey,
  overSixtySeconds,
} from "./test-records-report.ts";
import {
  AliasResolver,
  type RunContext,
  type StoredReport,
  type TestRecord,
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
  return {
    objectName,
    context: undefined,
    records,
    reports: [{ context: undefined, records }],
  };
}

function contextOn(startedAt: string): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01REPORTTEST000000000000",
    repo: "commontoolsinc/labs",
    commit: "c".repeat(40),
    dirty: false,
    env: "local",
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt,
  };
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

    it("joins a renamed test's history under its current name", () => {
      const resolver = new AliasResolver([{
        date: "2026-08-15",
        from: { k: "unit", s: "bakery", n: "old name" },
        to: { k: "unit", s: "bakery", n: "new name" },
      }]);
      const before = report("a", [record("old name", "pass", 5)]);
      before.context = contextOn("2026-08-10T00:00:00.000Z");
      const after = report("b", [record("new name", "fail", 7)]);
      after.context = contextOn("2026-08-16T00:00:00.000Z");
      const byIdentity = aggregate([before, after], resolver);
      const entry = byIdentity.get(identityKey({
        k: "unit",
        s: "bakery",
        n: "new name",
      }));
      expect(entry?.runs).toBe(2);
      expect(byIdentity.size).toBe(1);
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
