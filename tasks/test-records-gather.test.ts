import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  gather,
  headCommitOfEvent,
  parseGatherArgs,
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
        variant: "wood-fired",
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
      expect(records[0]?.test.v).toBe("wood-fired");
      expect(records[1]).toEqual({
        line: "record",
        test: {
          k: "unit",
          s: "cli",
          n: "alpha",
          v: "wood-fired",
        },
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

    it("rejects an empty variant from a direct caller", async () => {
      await expect(
        gather({ out: join(dir, "out"), job: "Check", variant: "", junit: [] }),
      ).rejects.toThrow("a declared variant must not be empty");
    });

    it("records the commit, branch, and pull request head from the environment", async () => {
      const out = join(dir, "out");
      const eventPath = join(dir, "event.json");
      await Deno.writeTextFile(
        eventPath,
        JSON.stringify({ pull_request: { head: { sha: "f".repeat(40) } } }),
      );
      await gather({
        out,
        job: "Check",
        junit: [],
        env: (name) => {
          if (name === "GITHUB_SHA") return "a".repeat(40);
          if (name === "GITHUB_HEAD_REF") return "feature-branch";
          if (name === "GITHUB_EVENT_PATH") return eventPath;
          return undefined;
        },
      });
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.commit).toBe("a".repeat(40));
      expect(facts.branch).toBe("feature-branch");
      expect(facts.headCommit).toBe("f".repeat(40));
    });

    it("keeps ingesting after one unreadable JUnit file", async () => {
      await Deno.writeTextFile(join(dir, "a-bad.xml"), "<testsuite name=");
      await Deno.writeTextFile(join(dir, "b-good.xml"), JUNIT);
      const out = join(dir, "out");
      await gather({
        out,
        job: "Check",
        junit: [{ kind: "unit", scope: "cli", glob: join(dir, "*.xml") }],
      });
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.length).toBe(1);
    });
  });

  describe("parseGatherArgs()", () => {
    it("returns the options of a full command line", () => {
      const options = parseGatherArgs([
        "--out",
        "artifact",
        "--job",
        "Test (3/8)",
        "--shard",
        "3/8",
        "--variant",
        "wood-fired",
        "--junit",
        "kind=unit,scope=cli,glob=*.xml",
      ]);
      expect(options?.out).toBe("artifact");
      expect(options?.job).toBe("Test (3/8)");
      expect(options?.shard).toBe("3/8");
      expect(options?.variant).toBe("wood-fired");
      expect(options?.junit.length).toBe(1);
    });

    it("skips a malformed junit specification and keeps the rest", () => {
      const options = parseGatherArgs([
        "--out",
        "artifact",
        "--job",
        "Check",
        "--junit",
        "not a spec",
        "--junit",
        "kind=unit,scope=cli,glob=*.xml",
      ]);
      expect(options?.junit.length).toBe(1);
    });

    it("returns undefined for unknown flags and missing values", () => {
      expect(parseGatherArgs(["--out"])).toBeUndefined();
      expect(parseGatherArgs(["--mystery", "x"])).toBeUndefined();
      expect(parseGatherArgs(["--out", "artifact"])).toBeUndefined();
      expect(
        parseGatherArgs([
          "--out",
          "artifact",
          "--job",
          "Check",
          "--variant",
          "",
        ]),
      ).toBeUndefined();
    });
  });
});
