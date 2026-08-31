import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  byDayThenName,
  dayPartitions,
  parseArgs,
  partitionOf,
} from "./test-selection-publish.ts";

const CI = (day: string, run: string) =>
  `labs/test-records/submissions/ci/v1/${day}/run-${run}-a.ndjson`;
const LOCAL = (day: string, who: string) =>
  `labs/test-records/submissions/local/${who}/v1/${day}/01K3-branch.ndjson`;

describe("test-selection-publish", () => {
  describe("parseArgs()", () => {
    it("defaults to the incremental path", () => {
      const options = parseArgs([]);
      expect(options?.bootstrap).toBe(false);
      expect(options?.dryRun).toBe(false);
    });

    it("widens the window for a bootstrap", () => {
      expect(parseArgs(["--bootstrap"])?.days).toBe(60);
    });

    it("lets an asked-for window win, whichever order it was typed", () => {
      expect(parseArgs(["--days", "3", "--bootstrap"])?.days).toBe(3);
      expect(parseArgs(["--bootstrap", "--days", "3"])?.days).toBe(3);
    });

    it("takes a window, an output directory, and a concurrency", () => {
      const options = parseArgs([
        "--days",
        "3",
        "--out",
        "/tmp/out",
        "--concurrency",
        "8",
      ]);
      expect(options?.days).toBe(3);
      expect(options?.out).toBe("/tmp/out");
      expect(options?.concurrency).toBe(8);
    });

    it("returns undefined for anything it does not understand", () => {
      expect(parseArgs(["--nonsense"])).toBeUndefined();
      expect(parseArgs(["--days", "0"])).toBeUndefined();
      expect(parseArgs(["--days"])).toBeUndefined();
      expect(parseArgs(["--concurrency", "x"])).toBeUndefined();
    });
  });

  describe("dayPartitions()", () => {
    it("lists the window oldest first", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 3)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
      ]);
    });

    it("lists one day for a window of one", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 1)).toEqual([
        "2026/08/20",
      ]);
    });
  });

  describe("partitionOf()", () => {
    it("reads the day out of either area's names", () => {
      expect(partitionOf(CI("2026/08/20", "1"))).toBe("2026/08/20");
      expect(partitionOf(LOCAL("2026/08/20", "ianh"))).toBe("2026/08/20");
    });

    it("reads nothing out of a name that carries no day", () => {
      expect(partitionOf("labs/test-selection/v1/state/x.json.gz")).toBe("");
    });
  });

  describe("byDayThenName()", () => {
    it("interleaves the two areas by the day they recorded", () => {
      // Sorted by name alone, every local object lands after every
      // continuous-integration one, and the fold would judge a
      // workstation's failure against a state from days later.
      const ordered = [
        LOCAL("2026/08/20", "ianh"),
        CI("2026/08/18", "1"),
        LOCAL("2026/08/19", "ianh"),
        CI("2026/08/20", "2"),
      ].sort(byDayThenName);
      expect(ordered.map(partitionOf)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
        "2026/08/20",
      ]);
    });

    it("falls back to the name inside one day", () => {
      const ordered = [CI("2026/08/20", "2"), CI("2026/08/20", "1")]
        .sort(byDayThenName);
      expect(ordered[0]).toBe(CI("2026/08/20", "1"));
    });
  });
});
