import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  aggregate,
  churnFamilies,
  collisions,
  formatIdentity,
  identityKey,
  overSixtySeconds,
  parseReportArgs,
  recentDatePrefixes,
  runReport,
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

    it("separates a non-default variant from the default history", () => {
      const unmarked = record("glaze", "pass", 10);
      const marked: TestRecord = {
        ...unmarked,
        test: { ...unmarked.test, v: "server-execution" },
      };
      const byIdentity = aggregate([report("a", [unmarked, marked])]);
      expect([...byIdentity.keys()]).toEqual([
        '["unit","bakery","glaze"]',
        '["unit","bakery","glaze","server-execution"]',
      ]);
      expect(formatIdentity([...byIdentity.keys()][1]!)).toBe(
        "[unit] bakery: glaze (variant: server-execution)",
      );
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

  describe("recentDatePrefixes()", () => {
    it("returns the window's partitions, newest first", () => {
      const now = Date.parse("2026-08-18T12:00:00Z");
      expect(recentDatePrefixes(3, now)).toEqual([
        "2026/08/18",
        "2026/08/17",
        "2026/08/16",
      ]);
    });
  });

  describe("runReport()", () => {
    const NOW = Date.parse("2026-08-18T12:00:00Z");

    // One day's listing with two objects: a trusted report and a
    // fork-authored one carrying an over-sixty-seconds record.
    function reportFetch(bodies: Record<string, string>): typeof fetch {
      return ((input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/storage/v1/")) {
          const prefix = new URL(url).searchParams.get("prefix")!;
          const items = prefix.includes("2026/08/18/")
            ? Object.keys(bodies).map((name) => ({ name }))
            : [];
          return Promise.resolve(
            new Response(JSON.stringify({ items }), { status: 200 }),
          );
        }
        const name = Object.keys(bodies).find((candidate) =>
          url.endsWith(candidate)
        );
        return Promise.resolve(
          new Response(bodies[name ?? ""] ?? "", { status: 200 }),
        );
      }) as typeof fetch;
    }

    function ciBody(
      fork: boolean,
      records: ReturnType<typeof record>[],
    ): string {
      const context = {
        ...contextOn("2026-08-18T01:00:00.000Z"),
        env: "ci" as const,
        ci: {
          workflowRunId: fork ? "2" : "1",
          runAttempt: 1,
          workflow: "CI",
          job: "Test",
          fork,
        },
      };
      return JSON.stringify(context) + "\n" +
        records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    }

    it("excludes fork-authored reports from the ratchet", async () => {
      const gateFailed = await runReport({
        days: 1,
        gate: true,
        bucket: "b",
        prefix: "p",
        now: NOW,
        fetchImpl: reportFetch({
          "trusted.ndjson": ciBody(false, [record("fast", "pass", 5)]),
          "forked.ndjson": ciBody(true, [record("slow", "fail", 90_000)]),
        }),
      });
      expect(gateFailed).toBe(false);
    });

    it("fails the gate for an over-sixty-seconds trusted record", async () => {
      const gateFailed = await runReport({
        days: 1,
        gate: true,
        bucket: "b",
        prefix: "p",
        now: NOW,
        fetchImpl: reportFetch({
          "trusted.ndjson": ciBody(false, [record("slow", "pass", 61_000)]),
        }),
      });
      expect(gateFailed).toBe(true);
    });

    it("reports without failing when the gate is off", async () => {
      const gateFailed = await runReport({
        days: 1,
        gate: false,
        bucket: "b",
        prefix: "p",
        now: NOW,
        fetchImpl: reportFetch({
          "trusted.ndjson": ciBody(false, [record("slow", "pass", 61_000)]),
        }),
      });
      expect(gateFailed).toBe(false);
    });
  });

  describe("parseReportArgs()", () => {
    it("returns the defaults and the given flags", () => {
      expect(parseReportArgs([])).toEqual({ days: 7, gate: false });
      expect(parseReportArgs(["--gate", "--days", "30"]))
        .toEqual({ days: 30, gate: true });
    });

    it("returns undefined for malformed command lines", () => {
      expect(parseReportArgs(["--days", "-1"])).toBeUndefined();
      expect(parseReportArgs(["--mystery"])).toBeUndefined();
    });
  });
});
