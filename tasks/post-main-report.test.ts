import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  sampleEntry,
  sampleManifest,
  testIdentityKey,
} from "@commonfabric/test-support/records";

import type { WorkflowRun } from "./ci-check-lib.ts";
import { MAIN_REPORT_MARKER } from "./test-selection/report.ts";
import type { Suite } from "./test-topology/suite.ts";
import type { RunOutcomes } from "./test-selection/report.ts";
import {
  isReportable,
  manifestView,
  outcomesFromArtifacts,
  postReport,
  pullRequestOf,
  runAt,
  runPartitions,
  withdrawReport,
} from "./post-main-report.ts";

//
// Fixtures
//

/** One request the poster made, as the fetch stub recorded it. */
interface Recorded {
  method: string;
  url: string;
  body?: string;
}

/** One comment a pull request is already carrying. */
interface Existing {
  body: string;

  /** The login it was written under. */
  author: string;
}

/**
 * Runs one of the posters against a pull request already carrying these
 * comments, and reports what it asked GitHub to do.
 */
async function posting(
  post: (pullRequest: number, body: string) => Promise<void>,
  body: string,
  existing: readonly Existing[],
): Promise<Recorded[]> {
  const requests: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" || method === "PATCH") {
      requests.push({
        method,
        url,
        body: JSON.parse(String(init?.body)).body,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), {
          status: method === "POST" ? 201 : 200,
        }),
      );
    }
    requests.push({ method, url });
    return Promise.resolve(
      new Response(
        JSON.stringify(
          existing.map((comment, index) => ({
            id: index + 1,
            body: comment.body,
            user: { login: comment.author },
          })),
        ),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  try {
    await post(4211, body);
  } finally {
    globalThis.fetch = original;
  }
  return requests.filter((request) => request.method !== "GET");
}

describe("post-main-report", () => {
  describe("pullRequestOf()", () => {
    it("reads the number a squash merge puts in the subject", () => {
      expect(pullRequestOf("fix(oven): hold the temperature (#7008)"))
        .toBe(7008);
    });

    it("takes the merge's own number when the subject names two", () => {
      expect(pullRequestOf("revert of (#6900), reland (#7008)")).toBe(7008);
    });

    // A commit pushed straight to the default branch has none, and that is
    // why nothing is posted rather than a pull request being guessed at.
    it("finds none in a subject that names none", () => {
      expect(pullRequestOf("fix(oven): hold the temperature")).toBeUndefined();
    });

    it("does not read an issue reference as a pull request", () => {
      expect(pullRequestOf("close #7008 by holding the temperature"))
        .toBeUndefined();
    });
  });

  describe("isReportable()", () => {
    const run = (fields: Partial<WorkflowRun>): WorkflowRun =>
      ({
        event: "push",
        head_branch: "main",
        conclusion: "success",
        ...fields,
      }) as WorkflowRun;

    it("takes a finished push to the default branch", () => {
      expect(isReportable(run({}))).toBe(true);
      expect(isReportable(run({ conclusion: "failure" }))).toBe(true);
    });

    // A workflow_run payload describes the run it names, so these are the
    // triggering run's own facts and mean what they say.
    it("leaves a pull request's run and another branch alone", () => {
      expect(isReportable(run({ event: "pull_request" }))).toBe(false);
      expect(isReportable(run({ head_branch: "a-branch" }))).toBe(false);
    });

    // A run killed at its bound is the shape a hanging test takes, and
    // every note needs evidence rather than the absence of it, so what
    // such a run did record is worth reading.
    it("takes a run killed at its bound", () => {
      expect(isReportable(run({ conclusion: "cancelled" }))).toBe(true);
      expect(isReportable(run({ conclusion: "timed_out" }))).toBe(true);
    });

    it("leaves a run that never started alone", () => {
      expect(isReportable(run({ conclusion: "skipped" }))).toBe(false);
      expect(isReportable(run({ conclusion: "action_required" }))).toBe(false);
    });
  });

  describe("runAt()", () => {
    /** Answers one workflow-runs listing with these runs. */
    async function asking(
      runs: readonly Partial<WorkflowRun>[],
    ): Promise<{ url: string; found?: number }> {
      const original = globalThis.fetch;
      let url = "";
      globalThis.fetch = ((input: string | URL | Request) => {
        url = typeof input === "string" ? input : input.toString();
        return Promise.resolve(
          new Response(JSON.stringify({ workflow_runs: runs }), {
            status: 200,
          }),
        );
      }) as typeof fetch;
      try {
        const run = await runAt("a".repeat(40), "push");
        return run === undefined ? { url } : { url, found: run.id };
      } finally {
        globalThis.fetch = original;
      }
    }

    it("asks for the finished runs at that commit on the branch", async () => {
      const { url } = await asking([]);
      expect(url).toContain(`head_sha=${"a".repeat(40)}`);
      expect(url).toContain("status=completed");
      expect(url).toContain("branch=main");
      expect(url).toContain("event=push");
    });

    it("takes the newest run at that commit that left records", async () => {
      const { found } = await asking([
        { id: 3, conclusion: "skipped" },
        { id: 2, conclusion: "cancelled" },
        { id: 1, conclusion: "success" },
      ]);
      expect(found).toBe(2);
    });

    it("finds nothing when no run at that commit left any", async () => {
      const { found } = await asking([{ id: 3, conclusion: "skipped" }]);
      expect(found).toBeUndefined();
    });
  });

  describe("runPartitions()", () => {
    it("gives one day for a run that was never re-run", () => {
      expect(runPartitions({
        created_at: "2026-09-07T06:53:17Z",
        run_started_at: "2026-09-07T06:53:17Z",
      } as WorkflowRun)).toEqual(["2026/09/07"]);
    });

    // An object is named for the day its attempt started, so a run
    // re-run after a UTC midnight has its two attempts under two days.
    it("gives both days for a run re-run after a midnight", () => {
      expect(runPartitions({
        created_at: "2026-09-06T23:57:12Z",
        run_started_at: "2026-09-07T00:14:02Z",
      } as WorkflowRun)).toEqual(["2026/09/06", "2026/09/07"]);
    });

    it("gives every day a run spent between its first and last attempt", () => {
      expect(runPartitions({
        created_at: "2026-09-05T23:57:12Z",
        run_started_at: "2026-09-07T00:14:02Z",
      } as WorkflowRun)).toEqual(["2026/09/05", "2026/09/06", "2026/09/07"]);
    });

    it("gives the day it can read when the other is not a moment", () => {
      expect(runPartitions({
        created_at: "2026-09-07T06:53:17Z",
        run_started_at: "not a moment",
      } as WorkflowRun)).toEqual(["2026/09/07"]);
    });
  });

  describe("manifestView()", () => {
    const kneads = { k: "unit", s: "bakery", n: "kneads" };
    const proves = { k: "unit", s: "bakery", n: "proves" };
    const unit = "packages/bakery/test/bakery.test.ts";
    const suites: Suite[] = [{
      id: "workspace-unit",
      recordSurfaces: [{ kind: "unit", scope: "bakery" }],
      needs: ["deno"],
      units: [unit],
      unavailable: [],
      locate: () => undefined,
      command: () => Promise.resolve([]),
    }];
    const manifest = sampleManifest({
      entries: [
        sampleEntry(kneads, { unit, flakeRate: 0.5, cost: 1 }),
        sampleEntry(proves, {
          unit,
          flakeRate: 0.02,
          cost: 1,
          inputs: { catches: 3, mainCatches: 1, sources: 2, churn: 0 },
        }),
      ],
      withheld: [{ test: kneads, suite: "workspace-unit", reason: "flaky" }],
    });

    it("reports what the packing reached and what was held back", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.manifest).toBe(true);
      expect(view.withheld.get(testIdentityKey(kneads))).toBe("flaky");
      expect(view.selected.has(testIdentityKey(proves))).toBe(true);
    });

    it("carries the flake rate and the catches behind every entry", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.flakeRates.get(testIdentityKey(kneads))).toBe(0.5);
      expect(view.catches.get(testIdentityKey(proves))).toBe(3);
    });

    // Which unit a test lives in is what says whether a run that did not
    // record it ran its unit at all.
    it("carries the unit every entry lives in", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.units.get(testIdentityKey(kneads)))
        .toBe(`workspace-unit\t${unit}`);
    });

    // The tree decides what exists. A manifest naming a unit this tree no
    // longer holds is work no run could have done, so nothing about it
    // reaches the packing.
    it("drops an entry naming a unit the tree no longer holds", () => {
      const view = manifestView(
        manifest,
        [{ ...suites[0]!, units: [] }],
        new Set(),
      );
      expect(view.selected.size).toBe(0);
    });
  });

  describe("outcomesFromArtifacts()", () => {
    /** Answers the artifact listing with one artifact, and its zip with a 500. */
    async function unreadable(): Promise<RunOutcomes | undefined> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/zip")) {
          return Promise.resolve(new Response("no", { status: 500 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 1,
              artifacts: [{
                id: 1,
                name: "test-records-Test",
                size_in_bytes: 1,
                expired: false,
              }],
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      try {
        return await outcomesFromArtifacts(7);
      } finally {
        globalThis.fetch = original;
      }
    }

    // A share of a run that could not be read would otherwise read as a
    // share the run did not run, and a report built on that withdraws
    // one an earlier attempt correctly made.
    it("says nothing at all when one artifact could not be read", async () => {
      expect(await unreadable()).toBeUndefined();
    });
  });

  describe("postReport()", () => {
    const body = `${MAIN_REPORT_MARKER}\nThe run found this.`;

    it("posts when the pull request carries no report yet", async () => {
      const written = await posting(postReport, body, [
        { body: "a review comment", author: "somebody" },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("POST");
      expect(written[0]!.body).toBe(body);
    });

    it("edits the report already there rather than adding another", async () => {
      // It is actionable and it ends: the same thing recurring edits the
      // comment that is there rather than adding another beside it.

      const written = await posting(postReport, body, [
        { body: "a review comment", author: "somebody" },
        {
          body: `${MAIN_REPORT_MARKER}\nThe run found something else.`,
          author: "github-actions[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("PATCH");
      expect(written[0]!.url).toContain("/issues/comments/2");
      expect(written[0]!.body).toBe(body);
    });

    it("writes nothing when the report already says this", async () => {
      expect(
        await posting(postReport, body, [{
          body,
          author: "github-actions[bot]",
        }]),
      )
        .toEqual([]);
    });

    // The token this runs under may edit any comment on the pull request,
    // so a person quoting the marker must not have their comment
    // overwritten with the report.
    // Every review app on a pull request writes as a bot as well, so
    // matching on the login rather than on being one is what keeps this
    // from overwriting theirs.
    it("leaves another author's comment alone however it quotes the marker", async () => {
      const written = await posting(postReport, body, [
        {
          body: `Look at ${MAIN_REPORT_MARKER} in the source`,
          author: "somebody",
        },
        {
          body: `A review app quoting ${MAIN_REPORT_MARKER}`,
          author: "some-review-app[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("POST");
    });
  });

  describe("withdrawReport()", () => {
    const withdrawal = `${MAIN_REPORT_MARKER}\nNothing to report.`;

    it("replaces a report an earlier attempt left standing", async () => {
      const written = await posting(withdrawReport, withdrawal, [
        {
          body: `${MAIN_REPORT_MARKER}\nThe run found something.`,
          author: "github-actions[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("PATCH");
      expect(written[0]!.body).toBe(withdrawal);
    });

    it("writes nothing when there is no report to withdraw", async () => {
      expect(
        await posting(withdrawReport, withdrawal, [
          { body: "a review comment", author: "somebody" },
        ]),
      ).toEqual([]);
    });
  });
});
