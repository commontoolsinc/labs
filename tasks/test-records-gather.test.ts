import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  gather,
  headCommitOfEvent,
  parseJUnitSpec,
} from "./test-records-gather.ts";
import {
  createRunSpool,
  FragmentWriter,
  type HeldSpool,
  parseRecordLine,
  RECORD_SCHEMA_VERSION,
} from "@commonfabric/test-support/records";

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="1" failures="0">
    <testcase name="alpha" classname="test/alpha.test.ts" time="0.250"/>
  </testsuite>
</testsuites>`;

describe("test-records-gather", () => {
  describe("parseJUnitSpec()", () => {
    it("returns the four fields of a full specification", () => {
      expect(
        parseJUnitSpec(
          "kind=unit,scope=cli,prefix=packages/cli,glob=out/*.xml",
        ),
      ).toEqual({
        kind: "unit",
        scope: "cli",
        prefix: "packages/cli",
        glob: "out/*.xml",
      });
    });

    it("returns a spec without the optional prefix", () => {
      expect(parseJUnitSpec("kind=pattern,scope=patterns,glob=x.xml"))
        .toEqual({ kind: "pattern", scope: "patterns", glob: "x.xml" });
    });

    it("throws when a required field is missing", () => {
      expect(() => parseJUnitSpec("kind=unit,glob=x.xml")).toThrow();
    });
  });

  describe("headCommitOfEvent()", () => {
    it("returns the pull request head sha", () => {
      expect(
        headCommitOfEvent({ pull_request: { head: { sha: "abc123" } } }),
      ).toBe("abc123");
    });

    it("returns undefined for a push payload", () => {
      expect(headCommitOfEvent({ pusher: {} })).toBeUndefined();
    });
  });

  describe("gather()", () => {
    let dir: string;
    let held: HeldSpool | undefined;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
      held = undefined;
    });

    afterEach(async () => {
      held?.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    });

    it("writes job facts and the records of spool and JUnit inputs", async () => {
      const spoolRoot = join(dir, "spool");
      held = await createRunSpool(spoolRoot, {
        schema: RECORD_SCHEMA_VERSION,
        line: "context",
        reportId: "01GATHERTEST000000000000",
        repo: "commontoolsinc/labs",
        commit: "c".repeat(40),
        dirty: false,
        env: "ci",
        os: "linux",
        arch: "x86_64",
        denoVersion: "2.9.4",
        startedAt: "2026-08-17T21:00:00.000Z",
      });
      const writer = FragmentWriter.open(held.dir);
      writer?.append({
        line: "record",
        test: { k: "gate", s: "repo", n: "check-docs" },
        outcome: "pass",
        durationMs: 1500,
      });
      writer?.close();
      await Deno.writeTextFile(join(dir, "results.xml"), JUNIT);

      const out = join(dir, "out");
      await gather({
        out,
        job: "Test (3/8)",
        shard: "3/8",
        junit: [{
          kind: "unit",
          scope: "cli",
          prefix: "packages/cli",
          glob: join(dir, "*.xml"),
        }],
        spoolDir: held.dir,
      });

      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.job).toBe("Test (3/8)");
      expect(facts.shard).toBe("3/8");
      expect(facts.denoVersion).toBe(Deno.version.deno);

      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.length).toBe(2);
      const records = lines.map((line) => parseRecordLine(line));
      expect(records[0]?.test.n).toBe("check-docs");
      expect(records[1]).toEqual({
        line: "record",
        test: { k: "unit", s: "cli", n: "alpha" },
        outcome: "pass",
        durationMs: 250,
        file: "packages/cli/test/alpha.test.ts",
      });
    });

    it("writes an empty records file when there is nothing to gather", async () => {
      const out = join(dir, "out");
      await gather({ out, job: "Check", junit: [] });
      expect(await Deno.readTextFile(join(out, "records.ndjson"))).toBe("");
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.job).toBe("Check");
    });
  });
});
