/**
 * Covers the shared LCOV reader on the reports that are not a straightforward
 * list of records: coverage for one file spread over several reports, several
 * source paths that map to a single key, and records carrying counts that do
 * not parse. Those are the cases where a reader can quietly lose coverage
 * rather than fail.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseLcovReports } from "./lcov.ts";

describe("lcov", () => {
  describe("parseLcovReports()", () => {
    it("sums the hits for a file split across several reports", () => {
      const files = parseLcovReports([
        ["SF:/repo/a.ts", "DA:1,1", "DA:2,0", "end_of_record"].join("\n"),
        ["SF:/repo/a.ts", "DA:1,4", "DA:2,0", "end_of_record"].join("\n"),
      ]);

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      const file = files.get("/repo/a.ts")!;
      expect(file.sourcePath).toBe("/repo/a.ts");
      expect([...file.lineHits]).toEqual([[1, 5], [2, 0]]);
    });

    it("merges the source paths `mapPath` sends to one key", () => {
      const files = parseLcovReports([
        [
          "SF:/runner-a/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "SF:/runner-b/repo/a.ts",
          "DA:2,1",
          "end_of_record",
        ].join("\n"),
      ], { mapPath: (sourcePath) => sourcePath.replace(/^\/runner-[ab]/, "") });

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[1, 1], [2, 1]]);
    });

    it("returns the path carried by the record that opened an entry", () => {
      const files = parseLcovReports([
        [
          "SF:/runner-a/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "SF:/runner-b/repo/a.ts",
          "DA:2,1",
          "end_of_record",
        ].join("\n"),
      ], { mapPath: (sourcePath) => sourcePath.replace(/^\/runner-[ab]/, "") });

      expect(files.get("/repo/a.ts")!.sourcePath).toBe("/runner-a/repo/a.ts");
    });

    it("returns the first test name a file is given", () => {
      const files = parseLcovReports([
        [
          "TN:first",
          "SF:/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "TN:second",
          "SF:/repo/a.ts",
          "DA:2,1",
          "end_of_record",
          "SF:/repo/b.ts",
          "DA:1,1",
          "end_of_record",
        ].join("\n"),
      ]);

      expect(files.get("/repo/a.ts")!.testName).toBe("first");
      expect(files.get("/repo/b.ts")!.testName).toBeUndefined();
    });

    it("omits records and counts it cannot read", () => {
      const files = parseLcovReports([
        [
          // A `DA:` line outside any record has no file to charge.
          "DA:9,1",
          "SF:/repo/a.ts",
          "FN:1,add",
          "BRDA:2,0,0,1",
          "DA:1.5,1",
          "DA:2,not-a-number",
          "DA:3,7",
          "LF:1",
          "LH:1",
          "end_of_record",
          "DA:9,1",
        ].join("\n"),
      ]);

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[3, 7]]);
    });

    it("omits records with a blank line number or count", () => {
      const files = parseLcovReports([
        [
          "SF:/repo/a.ts",
          "DA:,0",
          "DA:1,",
          "DA:,",
          "DA: , ",
          "DA:3",
          "DA:4,2",
          "end_of_record",
        ].join("\n"),
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[4, 2]]);
    });

    it("omits records numbering a line at or below zero", () => {
      const files = parseLcovReports([
        [
          "SF:/repo/a.ts",
          "DA:0,5",
          "DA:-1,5",
          "DA:2,5",
          "end_of_record",
        ].join("\n"),
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[2, 5]]);
    });

    it("reads reports with carriage returns", () => {
      const files = parseLcovReports([
        "SF:/repo/a.ts\r\nDA:1,1\r\nend_of_record\r\n",
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[1, 1]]);
    });
  });
});
