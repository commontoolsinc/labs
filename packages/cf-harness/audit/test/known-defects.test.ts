/**
 * That a Group E finding says enough about itself to be recorded, and that
 * what it says is true of the message beside it.
 *
 * These checks fail by design until their defects are fixed, so a nightly
 * running the audit has to be told which of its findings were already known.
 * The register that does that reads a check id, a run selector, a substring of
 * the finding's message, a reason and an issue. Five of those six come off the
 * finding, and the one property that makes them usable is the one nothing else
 * would catch: that `detail` is genuinely a substring of `message`. An entry
 * copied from a finding whose detail was not in its message would match
 * nothing, be reported stale forever, and the fix would look like the gap
 * having closed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { KNOWN_DEFECT_REGISTRATIONS } from "../checks/known-defects.ts";
import { RUN_CHECKS } from "../checks/registry.ts";
import { auditRunFamily } from "../checks/structural.ts";
import { loadRunFamily, type RunFamily } from "../evidence.ts";
import type { CheckResult } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

/**
 * The fixture with its cell-labels snapshot removed, so AUD-24's registration
 * is exercised here too.
 *
 * The fixture keeps a snapshot, so AUD-24 passes on it and carries nothing.
 * Reading only the clean tree would leave that registration untested while
 * every assertion below still passed — over a list AUD-24 was not in.
 */
const withoutCellLabels = (): RunFamily => {
  const root = structuredClone(family.root);
  root.cellLabels = { status: "absent", path: root.cellLabels.path };
  const state = root.runState;
  if (state.status === "present") {
    delete (state.value as { cellLabels?: unknown }).cellLabels;
  }
  return { root, children: structuredClone(family.children) };
};

const RESULTS = [
  ...auditRunFamily(family, RUN_CHECKS),
  ...auditRunFamily(withoutCellLabels(), RUN_CHECKS),
];

/**
 * Every finding this fixture produced that says it is about a known defect.
 *
 * Read off the results of every registered check rather than off one group's:
 * a registration is a property of a finding, and AUD-24 carries one from
 * `structural.ts` while the Group E checks carry theirs from
 * `known-defects.ts`. Collecting them by where they were declared would leave
 * a check's registration untested the moment one was added anywhere else.
 */
const registered = (): readonly CheckResult[] =>
  RESULTS.filter((result) => result.knownDefect !== undefined);

const findings = (): readonly CheckResult[] =>
  RESULTS.filter((result) =>
    (result.verdict === "fail" || result.verdict === "warn") &&
    result.knownDefect !== undefined
  );

describe("known defects", () => {
  it("reports a finding for every registered defect", () => {
    // Without this the assertions below would hold over an empty list. The
    // fixture is a captured run of a system with all three Group E gaps in
    // it, and AUD-24 joins them on the variant with no cell-labels snapshot.
    expect(
      [...new Set(findings().map((result) => result.checkId))].sort(),
    ).toEqual(
      [...Object.keys(KNOWN_DEFECT_REGISTRATIONS), "AUD-24"].sort(),
    );
  });

  it("carries what a ledger entry needs on every finding", () => {
    expect(
      registered()
        .filter((result) =>
          result.knownDefect === undefined ||
          result.knownDefect.detail.trim() === "" ||
          result.knownDefect.runShape.trim() === "" ||
          result.knownDefect.why.trim() === "" ||
          result.knownDefect.issue.trim() === ""
        )
        .map((result) => `${result.checkId}@${result.runId}`),
    ).toEqual([]);
  });

  it("names a detail that is in the message it came with", () => {
    // The property the register rests on. A detail that is not a substring of
    // the message matches nothing, so an entry written from it is stale the
    // day it lands and the gap looks closed.
    expect(
      registered()
        .filter((result) =>
          result.knownDefect === undefined ||
          !result.message.includes(result.knownDefect.detail)
        )
        .map((result) => `${result.checkId}: ${result.message}`),
    ).toEqual([]);
  });

  it("names a detail that carries no count, so a busier run still matches", () => {
    // A message states how many side effects or bindings it found. An entry
    // matching on that stops matching the moment a run makes one more call,
    // and the finding is then reported as new. A number inside a clause id —
    // the `3` of `AH-CFC-3` — is not a count, which is why this looks for a
    // standalone one rather than for any digit.
    expect(
      registered()
        .filter((result) => /(^|\s)\d+(\s|$)/.test(result.knownDefect!.detail))
        .map((result) => result.checkId),
    ).toEqual([]);
  });

  it("names an issue that can be looked up", () => {
    // A tracker id or a URL. Which tracker is not this file's business; that
    // the work can be found is.
    expect(
      registered()
        .filter((result) =>
          !/^([A-Z][A-Z0-9]*-\d+|https?:\/\/\S+)$/.test(
            result.knownDefect!.issue,
          )
        )
        .map((result) => result.checkId),
    ).toEqual([]);
  });

  it("leaves a passing check with nothing to register", () => {
    // A registration on a `pass` would read as a defect still open on a run
    // that does not have it.
    expect(
      RESULTS
        .filter((result) =>
          result.verdict !== "fail" && result.verdict !== "warn" &&
          result.knownDefect !== undefined
        )
        .map((result) => `${result.checkId}@${result.runId}`),
    ).toEqual([]);
  });

  it("covers a registration declared outside Group E", () => {
    // A registration is a property of a finding rather than of a group.
    // AUD-24 declares its own from `structural.ts`, beside the check it was
    // split out of, and everything above has to reach it.
    expect(
      registered().some((result) => result.checkId === "AUD-24"),
    ).toBe(true);
  });
});
