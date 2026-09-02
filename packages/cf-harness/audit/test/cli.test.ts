/**
 * The command line, and the exit code it decides.
 *
 * The threshold is the part worth pinning: an audit whose checks could not
 * read the artifacts they need has established nothing, and a green exit
 * there would report the absence of evidence as evidence of compliance.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  asksDeploymentQuestion,
  parseAuditCliArgs,
  renderAuditReport,
  runAuditCli,
} from "../cli.ts";
import type { CheckResult } from "../report.ts";
import { DEFAULT_FAIL_ON, verdictFailsThreshold } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const FIXTURE_RUN_DIR = join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID);

const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  checkId: "AUD-0",
  title: "a check",
  runId: "a-run",
  runDir: "/runs/a-run",
  verdict: "pass",
  message: "nothing to report",
  citations: [{ doc: "docs/spec.md", clause: "X-1", quote: "MUST hold." }],
  evidence: [],
  ...overrides,
});

describe("cli", () => {
  describe("parseAuditCliArgs()", () => {
    it("returns the named paths in the order given", () => {
      expect(parseAuditCliArgs(["first", "second"]).paths).toEqual([
        "first",
        "second",
      ]);
    });

    it("returns `inconclusive` as the threshold when none is named", () => {
      expect(parseAuditCliArgs(["a-run"]).failOn).toBe("inconclusive");
      expect(DEFAULT_FAIL_ON).toBe("inconclusive");
    });

    it("returns the named threshold", () => {
      expect(parseAuditCliArgs(["a-run", "--fail-on", "fail"]).failOn).toBe(
        "fail",
      );
    });

    it("throws given a threshold outside the three verdicts", () => {
      expect(() => parseAuditCliArgs(["a-run", "--fail-on", "pass"])).toThrow(
        "not one of fail, warn, inconclusive",
      );
    });

    it("asks no deployment question when only paths are named", () => {
      expect(asksDeploymentQuestion(parseAuditCliArgs(["a-run"]))).toBe(false);
    });

    it("asks one once a corpus is named", () => {
      const options = parseAuditCliArgs(["a-run", "--corpus"]);
      expect(options.corpus).toBe(true);
      expect(asksDeploymentQuestion(options)).toBe(true);
    });

    it("reads a declared-adversarial corpus as a corpus", () => {
      // The claim `--expect-refusals` makes is about the set of runs, so it
      // is the corpus flag as much as it is its own.
      const options = parseAuditCliArgs(["a-run", "--expect-refusals"]);
      expect(options.expectRefusals).toBe(true);
      expect(options.corpus).toBe(true);
    });

    it("returns the named expected-posture spec and toolshed URL", () => {
      const options = parseAuditCliArgs([
        "a-run",
        "--expected-posture",
        "profiles/max-enforcement.json",
        "--toolshed-url",
        "http://toolshed.test",
      ]);
      expect(options.expectedPosture).toBe("profiles/max-enforcement.json");
      expect(options.toolshedUrl).toBe("http://toolshed.test");
      expect(asksDeploymentQuestion(options)).toBe(true);
    });

    it("throws given an option whose value is missing", () => {
      expect(() => parseAuditCliArgs(["a-run", "--expected-posture"])).toThrow(
        "needs a value",
      );
    });

    it("throws given no path at all", () => {
      expect(() => parseAuditCliArgs(["--json"])).toThrow(
        "name at least one run directory",
      );
    });

    it("throws given an option it does not know", () => {
      expect(() => parseAuditCliArgs(["a-run", "--quiet"])).toThrow(
        "unknown option `--quiet`",
      );
    });
  });

  describe("verdictFailsThreshold()", () => {
    it("returns `true` for an inconclusive verdict at the default threshold", () => {
      expect(verdictFailsThreshold("inconclusive", DEFAULT_FAIL_ON)).toBe(true);
    });

    it("returns `false` for an inconclusive verdict at `fail`", () => {
      expect(verdictFailsThreshold("inconclusive", "fail")).toBe(false);
    });

    it("returns `false` for a passing verdict at every threshold", () => {
      expect([
        verdictFailsThreshold("pass", "fail"),
        verdictFailsThreshold("pass", "warn"),
        verdictFailsThreshold("pass", "inconclusive"),
      ]).toEqual([false, false, false]);
    });
  });

  describe("renderAuditReport()", () => {
    it("prints each finding's clause and the words it quotes", () => {
      const report = renderAuditReport([
        result({ verdict: "fail", message: "the mode disagrees" }),
      ], "fail");

      expect(report).toContain("the mode disagrees");
      expect(report).toContain("X-1 (docs/spec.md)");
      expect(report).toContain('"MUST hold."');
    });

    it("prints each evidence pointer beside the artifact it is into", () => {
      const report = renderAuditReport([
        result({
          verdict: "fail",
          evidence: [
            {
              artifact: "policy-trace.json",
              pointer: "decisions[1]",
              detail: "the mode",
            },
            { detail: "a fact about the family rather than about one file" },
          ],
        }),
      ], "fail");

      expect(report).toContain("policy-trace.json decisions[1] — the mode");
      expect(report).toContain(
        "evidence: a fact about the family rather than about one file",
      );
    });

    it("prints no section for the verdicts that carry no finding", () => {
      const report = renderAuditReport([result()], "fail");

      expect(report).not.toContain("FAIL (");
      expect(report).toContain("PASS 1");
    });
  });

  describe("runAuditCli()", () => {
    it("returns 0 over the clean fixture at the default threshold", async () => {
      const written: string[] = [];

      expect(
        await runAuditCli([FIXTURE_RUN_DIR], (text) => {
          written.push(text);
        }),
      ).toBe(0);
      expect(written.join("")).toContain("FAIL 0");
    });

    it("returns 0 over the clean fixture asked for JSON", async () => {
      const written: string[] = [];

      expect(
        await runAuditCli([FIXTURE_RUN_DIR, "--json"], (text) => {
          written.push(text);
        }),
      ).toBe(0);
      expect(
        (JSON.parse(written.join("")) as CheckResult[]).every((one) =>
          one.citations.length > 0
        ),
      ).toBe(true);
    });

    it("returns 2 for a path holding no run, rather than a green exit over nothing", async () => {
      const root = await Deno.makeTempDir({ prefix: "cfc-audit-cli-" });
      const written: string[] = [];
      try {
        expect(
          await runAuditCli([root], (text) => {
            written.push(text);
          }),
        ).toBe(2);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
      expect(written.join("")).toContain("nothing was audited");
    });

    it("returns 2 and prints the usage given an unreadable command line", async () => {
      const written: string[] = [];

      expect(
        await runAuditCli(["--fail-on"], (text) => {
          written.push(text);
        }),
      ).toBe(2);
      expect(written.join("")).toContain("usage: cfc-audit");
    });
  });
});
