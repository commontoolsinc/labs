import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildObjectBody,
  ciObjectName,
  datePartition,
  localObjectName,
  objectNameSlug,
  parseContextLine,
  parseRecordLine,
  type RunContext,
  serializeContextLine,
  serializeRecordLine,
  type TestRecord,
} from "./schema.ts";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > thickens when heated" },
  outcome: "pass",
  durationMs: 12,
};

const CONTEXT: RunContext = {
  schema: 1,
  line: "context",
  reportId: "01JEXAMPLEULID0000000000",
  repo: "commontoolsinc/labs",
  commit: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  branch: "main",
  env: "local",
  os: "darwin",
  arch: "aarch64",
  denoVersion: "2.9.4",
  startedAt: "2026-08-17T21:04:05.000Z",
};

describe("schema", () => {
  describe("serializeRecordLine()", () => {
    it("returns one newline-terminated JSON line", () => {
      const line = serializeRecordLine(RECORD);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1).includes("\n")).toBe(false);
    });
  });

  describe("parseRecordLine()", () => {
    it("returns the record for a serialized line", () => {
      expect(parseRecordLine(serializeRecordLine(RECORD).trim()))
        .toEqual(RECORD);
    });

    it("keeps the optional file field", () => {
      const record: TestRecord = { ...RECORD, file: "packages/x/test/a.ts" };
      expect(parseRecordLine(serializeRecordLine(record).trim()))
        .toEqual(record);
    });

    it("returns undefined for malformed JSON", () => {
      expect(parseRecordLine("{nope")).toBeUndefined();
    });

    it("returns undefined for an unknown outcome", () => {
      const line = JSON.stringify({ ...RECORD, outcome: "flaky" });
      expect(parseRecordLine(line)).toBeUndefined();
    });

    it("returns undefined for a negative duration", () => {
      const line = JSON.stringify({ ...RECORD, durationMs: -1 });
      expect(parseRecordLine(line)).toBeUndefined();
    });

    it("returns undefined for a context line", () => {
      expect(parseRecordLine(serializeContextLine(CONTEXT).trim()))
        .toBeUndefined();
    });

    it("returns undefined for an empty identity component", () => {
      const line = JSON.stringify({
        ...RECORD,
        test: { k: "unit", s: "", n: "x" },
      });
      expect(parseRecordLine(line)).toBeUndefined();
    });
  });

  describe("parseContextLine()", () => {
    it("returns the context for a serialized line", () => {
      expect(parseContextLine(serializeContextLine(CONTEXT).trim()))
        .toEqual(CONTEXT);
    });

    it("keeps the ci block with its optional fields", () => {
      const context: RunContext = {
        ...CONTEXT,
        env: "ci",
        ci: {
          workflowRunId: "123",
          runAttempt: 2,
          workflow: "CI",
          job: "Test (3/8)",
          shard: "3/8",
          headCommit: "feedfacefeedfacefeedfacefeedfacefeedface",
        },
      };
      expect(parseContextLine(serializeContextLine(context).trim()))
        .toEqual(context);
    });

    it("returns undefined for a wrong schema version", () => {
      const line = JSON.stringify({ ...CONTEXT, schema: 2 });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a ci env with no ci block", () => {
      const line = JSON.stringify({ ...CONTEXT, env: "ci" });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a local env carrying a ci block", () => {
      const line = JSON.stringify({
        ...CONTEXT,
        ci: { workflowRunId: "123", runAttempt: 1, workflow: "CI", job: "x" },
      });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a record line", () => {
      expect(parseContextLine(serializeRecordLine(RECORD).trim()))
        .toBeUndefined();
    });
  });

  describe("buildObjectBody()", () => {
    it("returns the context line followed by one line per record", () => {
      const body = buildObjectBody(CONTEXT, [RECORD, RECORD]);
      const lines = body.split("\n");
      expect(lines.length).toBe(4);
      expect(lines[3]).toBe("");
      expect(parseContextLine(lines[0]!)).toEqual(CONTEXT);
      expect(parseRecordLine(lines[1]!)).toEqual(RECORD);
      expect(parseRecordLine(lines[2]!)).toEqual(RECORD);
    });
  });

  describe("datePartition()", () => {
    it("returns the UTC date path of an ISO timestamp", () => {
      expect(datePartition("2026-08-17T21:04:05.000Z")).toBe("2026/08/17");
    });

    it("throws for a non-ISO string", () => {
      expect(() => datePartition("yesterday")).toThrow();
    });
  });

  describe("objectNameSlug()", () => {
    it("returns the label with unsafe characters collapsed", () => {
      expect(objectNameSlug("Test (3/8)")).toBe("Test-3-8");
    });

    it("returns a placeholder for an entirely unsafe label", () => {
      expect(objectNameSlug("///")).toBe("unnamed");
    });
  });

  describe("localObjectName()", () => {
    it("returns a versioned, date-partitioned, report-id-keyed name", () => {
      expect(localObjectName(CONTEXT)).toBe(
        "v1/2026/08/17/01JEXAMPLEULID0000000000-main.ndjson",
      );
    });

    it("returns the same name for the same context", () => {
      expect(localObjectName(CONTEXT)).toBe(localObjectName(CONTEXT));
    });
  });

  describe("ciObjectName()", () => {
    it("returns a name keyed by run and artifact", () => {
      expect(ciObjectName({
        runStartedAt: "2026-08-17T20:00:00Z",
        workflowRunId: "456",
        artifactName: "test-records-test-3-a2",
      })).toBe("v1/2026/08/17/run-456-test-records-test-3-a2.ndjson");
    });
  });
});
