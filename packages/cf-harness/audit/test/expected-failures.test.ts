/**
 * Holding a run's findings to the list of ones already known.
 *
 * Both directions are the point, and each has its own way of going wrong. A
 * list that only suppressed would hide a new failure; a list that never went
 * stale would become a permanent excuse. The cases below pin each direction
 * separately, so neither can be satisfied by the other.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type ExpectedFailure,
  reconcileExpectedFailures,
  reconciliationFails,
  renderReconciliation,
} from "../expected-failures.ts";
import type { CheckResult, CheckVerdict } from "../report.ts";

const finding = (
  checkId: string,
  verdict: CheckVerdict,
  message: string,
): CheckResult => ({
  checkId,
  title: checkId,
  runId: "run-1",
  runDir: "/runs/run-1",
  verdict,
  message,
  citations: [],
  evidence: [],
});

const entry = (
  checkId: string,
  detail: string,
): ExpectedFailure => ({
  checkId,
  runShape: "a shape",
  detail,
  why: "because",
  issue: "CT-0000",
});

describe("expected-failures", () => {
  describe("reconcileExpectedFailures()", () => {
    it("matches a finding whose check and message an entry names", () => {
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "fail", "retained none of: a cell-labels read")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.matched).toHaveLength(1);
      expect(reconciliation.unexpected).toEqual([]);
      expect(reconciliation.stale).toEqual([]);
      expect(reconciliationFails(reconciliation)).toBe(false);
    });

    it("reports a finding no entry covers as unexpected", () => {
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-3", "fail", "an output nothing accounts for")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.unexpected).toHaveLength(1);
      expect(reconciliationFails(reconciliation)).toBe(true);
    });

    it("reports an entry that matched nothing as stale", () => {
      // The direction that keeps the list from rotting: a gap that has been
      // closed must take its entry with it.
      const reconciliation = reconcileExpectedFailures(
        [],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.stale).toHaveLength(1);
      expect(reconciliationFails(reconciliation)).toBe(true);
    });

    it("does not match an entry naming the same check for another reason", () => {
      // A check fails for more than one reason, and an entry that matched the
      // check alone would excuse reasons nobody decided about.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "fail", "retained none of: a policy trace")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.unexpected).toHaveLength(1);
      expect(reconciliation.stale).toHaveLength(1);
    });

    it("leaves a verdict below the threshold out of the reconciliation", () => {
      // `--fail-on` still decides what counts as a finding; the list decides
      // only which findings were already known.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "warn", "retained none of: a cell-labels read")],
        [],
        "fail",
      );

      expect(reconciliation.unexpected).toEqual([]);
      expect(reconciliation.matched).toEqual([]);
    });
  });

  describe("renderReconciliation()", () => {
    it("names the issue of each entry that went stale", () => {
      const rendered = renderReconciliation(
        reconcileExpectedFailures([], [entry("AUD-9", "a read")], "warn"),
      );

      expect(rendered).toContain("CT-0000");
      expect(rendered).toContain("no longer occur");
    });
  });
});
