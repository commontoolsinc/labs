import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { RuntimeTelemetryMarker } from "@commonfabric/runner";

import { ReadCostReport } from "../lib/read-cost-report.ts";

describe("read-cost-report", () => {
  const run = (
    actionId: string,
    accesses: number,
    src?: string,
  ): Extract<RuntimeTelemetryMarker, { type: "scheduler.run.complete" }> => ({
    type: "scheduler.run.complete",
    actionId,
    durationMs: 1,
    actionInfo: src === undefined ? undefined : { src },
    reads: {
      proxyAccesses: accesses,
      linkResolutions: 2,
      distinctDocuments: 3,
      dependencies: 4,
    },
  });

  it("ranks authored and builtin work by accesses and includes hidden rows in totals", () => {
    const report = new ReadCostReport();
    report.record(run("builtin", 2));
    report.record(run("authored", 10, "example.tsx:12:3"));
    report.record(run("authored", 10, "example.tsx:12:3"));
    expect(report.lines("update", 1)).toEqual([
      "    Read cost (update; action bodies): 3 runs, 22 accesses, 6 link hops, 9 document-runs, 12 dependency-runs",
      "      2 runs, 20 accesses, 4 link hops, 6 document-runs, 8 dependency-runs — example.tsx:12:3",
    ]);
    expect(report.lines("update", 2)[2]).toContain("— builtin");
  });

  it("retains failed and short-lived actions without consulting graph snapshots", () => {
    const report = new ReadCostReport();
    report.record(
      { ...run("removed", 9), error: "failed" },
    );
    expect(report.lines("update", 1)[1]).toContain("9 accesses");
    expect(report.lines("update", 1)[1]).toContain("removed");
  });

  it("separates initialization from zero-work steps and ignores unmeasured markers", () => {
    const report = new ReadCostReport();
    report.record(run("initial", 5));
    report.clear();
    report.record({
      type: "scheduler.run.complete",
      actionId: "unmeasured",
      durationMs: 1,
    });
    report.record({
      type: "scheduler.subscribe",
      actionId: "subscribed",
      isEffect: false,
    });
    expect(report.lines("update", 10)).toEqual([
      "    Read cost (update; action bodies): 0 runs, 0 accesses, 0 link hops, 0 document-runs, 0 dependency-runs",
    ]);
  });
});
