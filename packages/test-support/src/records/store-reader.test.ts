import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseReportGroups } from "./store-reader.ts";
import { buildObjectBody, type RunContext, type TestRecord } from "./schema.ts";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets" },
  outcome: "pass",
  durationMs: 5,
};

function ciContext(reportId: string, fork: boolean): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId,
    repo: "commontoolsinc/labs",
    commit: "0123456789abcdef0123456789abcdef01234567",
    dirty: false,
    env: "ci",
    ci: {
      workflowRunId: "77",
      runAttempt: 1,
      workflow: "CI",
      job: "Test",
      fork,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-17T21:04:05.000Z",
  };
}

describe("store-reader", () => {
  describe("parseReportGroups()", () => {
    it("returns one group per context line with its own records", () => {
      const first = ciContext("01AAA0000000000000000000", false);
      const second = ciContext("01BBB0000000000000000000", true);
      const text = buildObjectBody(first, [RECORD]) +
        buildObjectBody(second, [RECORD, RECORD]);
      const groups = parseReportGroups(text);
      expect(groups.length).toBe(2);
      expect(groups[0]?.context?.reportId).toBe(first.reportId);
      expect(groups[0]?.records.length).toBe(1);
      expect(groups[1]?.context?.ci?.fork).toBe(true);
      expect(groups[1]?.records.length).toBe(2);
    });

    it("collects records ahead of any context into a contextless group", () => {
      const text = JSON.stringify(RECORD) + "\n" +
        buildObjectBody(ciContext("01CCC0000000000000000000", false), []);
      const groups = parseReportGroups(text);
      expect(groups.length).toBe(2);
      expect(groups[0]?.context).toBeUndefined();
      expect(groups[0]?.records.length).toBe(1);
      expect(groups[1]?.context?.reportId).toBe("01CCC0000000000000000000");
    });

    it("drops lines that parse as neither", () => {
      const groups = parseReportGroups("not json\n\n");
      expect(groups).toEqual([]);
    });
  });
});
