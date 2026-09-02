/**
 * The Group D checks: what a corpus of runs, and the deployment they ran
 * against, say together.
 *
 * Every check here is about more than one run, or about something outside the
 * artifact tree entirely, so none of them can be a per-run check the way
 * Group A and Group C are. They are evaluated once per audit invocation, and
 * only when the invocation asks a deployment question — `--corpus`,
 * `--expected-posture`, or `--toolshed-url`. That keeps the per-run audit's
 * exit code meaning what Phase 1 made it mean: an ordinary audit of an
 * artifact tree is not turned red by a question nobody asked.
 */

import type { CfcPostureReport } from "@commonfabric/runner/cfc";

import type { HarnessCfcPolicySnapshot } from "../../src/contracts/cfc-policy-snapshot.ts";
import type { HarnessPolicyDecisionRecord } from "../../src/contracts/policy-trace.ts";
import { citationsFor, type SpecCitation } from "../citations.ts";
import { familyRuns, type RunEvidence, type RunFamily } from "../evidence.ts";
import {
  type ExpectedPosture,
  postureMismatches,
} from "../expected-posture.ts";
import type { CheckEvidence, CheckResult, CheckVerdict } from "../report.ts";

/** The run id a corpus-level finding is stamped with. */
export const CORPUS_RUN_ID = "(corpus)";

/** What a Group D check was given to look at. */
export interface DeploymentAudit {
  /** Every run family the audit loaded, in the order it loaded them. */
  families: readonly RunFamily[];

  /** The paths named on the command line, for a finding to point back at. */
  paths: readonly string[];

  /** The spec `--expected-posture` named, when one was named. */
  expected?: ExpectedPosture;

  /** The `/api/meta` payload `--toolshed-url` fetched, when one was named. */
  toolshedMeta?: ToolshedMeta;

  /** Whether the corpus was declared adversarial (`--expect-refusals`). */
  expectRefusals: boolean;
}

/** What a `/api/meta` fetch established. */
export type ToolshedMeta =
  | { status: "read"; url: string; cfc: CfcPostureReport | null }
  | { status: "unreachable"; url: string; detail: string };

const everyRun = (audit: DeploymentAudit): readonly RunEvidence[] =>
  audit.families.flatMap((family) => [...familyRuns(family)]);

const decisionsOf = (
  run: RunEvidence,
): readonly HarnessPolicyDecisionRecord[] => {
  if (run.policyTrace.status === "present") {
    return run.policyTrace.value.decisions ?? [];
  }
  if (run.runReport.status === "present") {
    return run.runReport.value.policyDecisions ?? [];
  }
  return run.runState.status === "present"
    ? run.runState.value.policyDecisions ?? []
    : [];
};

const snapshotOf = (
  run: RunEvidence,
): HarnessCfcPolicySnapshot | undefined =>
  run.policySnapshot.status === "present"
    ? run.policySnapshot.value
    : run.runState.status === "present"
    ? run.runState.value.cfcPolicySnapshot
    : undefined;

const recordOf = (run: RunEvidence): CfcPostureReport | undefined =>
  run.runState.status === "present"
    ? run.runState.value.fabricSessionCfc?.record
    : undefined;

/** A finding about the corpus rather than about one run. */
const corpusResult = (
  audit: DeploymentAudit,
  checkId: string,
  title: string,
  citations: readonly SpecCitation[],
  verdict: CheckVerdict,
  message: string,
  evidence: readonly CheckEvidence[] = [],
): CheckResult => ({
  checkId,
  title,
  runId: CORPUS_RUN_ID,
  runDir: audit.paths.join(", "),
  verdict,
  message,
  citations,
  evidence,
});

const count = (total: number, singular: string, plural: string): string =>
  `${total} ${total === 1 ? singular : plural}`;

//
// AUD-16 refusal liveness
//

/**
 * A refusal the labels drove: a denied decision carrying a CFC reason code.
 *
 * A denial for a reason that is not about CFC — a tool the profile does not
 * offer, a malformed call — says nothing about whether the label machinery
 * ever fires, which is the question this check exists to ask.
 */
const labelDrivenRefusals = (
  audit: DeploymentAudit,
): readonly { runId: string; code: string }[] =>
  everyRun(audit).flatMap((run) =>
    decisionsOf(run)
      .filter((decision) => decision.decision === "denied")
      .flatMap((decision) =>
        (decision.reasonCodes ?? [])
          .filter((code) => code.startsWith("cfc_"))
          .map((code) => ({ runId: run.runId, code }))
      )
  );

const refusalLiveness = (audit: DeploymentAudit): CheckResult => {
  const refusals = labelDrivenRefusals(audit);
  const runs = everyRun(audit);
  const notAttested = runs.filter((run) =>
    snapshotOf(run)?.cfc.substrateStatus === "not-attested"
  );
  const permissive = runs.filter((run) =>
    snapshotOf(run)?.cfc.absenceBehavior === "permissive-if-absent"
  );
  const evidence: CheckEvidence[] = [
    {
      detail: `${
        count(refusals.length, "label-driven refusal", "label-driven refusals")
      } across ${count(runs.length, "run", "runs")}`,
    },
    {
      artifact: "policy-snapshot.json",
      pointer: "cfc.substrateStatus",
      detail: `${
        count(notAttested.length, "run", "runs")
      } recorded \`not-attested\``,
    },
    {
      artifact: "policy-snapshot.json",
      pointer: "cfc.absenceBehavior",
      detail: `${
        count(permissive.length, "run", "runs")
      } recorded \`permissive-if-absent\``,
    },
  ];
  if (refusals.length === 0) {
    return corpusResult(
      audit,
      "AUD-16",
      "refusal liveness",
      citationsFor("AH-CFC-11", "AH-CFC-15"),
      audit.expectRefusals ? "fail" : "warn",
      audit.expectRefusals
        ? `this corpus was declared adversarial and its ${
          count(runs.length, "run", "runs")
        } produced no label-driven refusal at all, so nothing here shows the label machinery firing`
        : `no run of this corpus produced a label-driven refusal, so the corpus shows the machinery loaded and never shows it deciding; ${
          count(notAttested.length, "run", "runs")
        } recorded \`not-attested\` and ${
          count(permissive.length, "run", "runs")
        } \`permissive-if-absent\``,
      evidence,
    );
  }
  const weakened = notAttested.length > 0 || permissive.length > 0;
  return corpusResult(
    audit,
    "AUD-16",
    "refusal liveness",
    citationsFor("AH-CFC-11", "AH-CFC-15"),
    weakened ? "warn" : "pass",
    `${
      count(refusals.length, "label-driven refusal", "label-driven refusals")
    } across ${count(runs.length, "run", "runs")}${
      weakened
        ? `, weakened by ${
          count(notAttested.length, "run", "runs")
        } recording \`not-attested\` and ${
          count(permissive.length, "run", "runs")
        } \`permissive-if-absent\``
        : ""
    }`,
    evidence,
  );
};

//
// AUD-17 toolshed posture
//

const toolshedPosture = (audit: DeploymentAudit): CheckResult | undefined => {
  const meta = audit.toolshedMeta;
  if (meta === undefined) return undefined;
  const citations = citationsFor("AH-CFC-14", "AH-CFC-15");
  if (meta.status === "unreachable") {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "inconclusive",
      `\`${meta.url}\` could not be read (${meta.detail}), so nothing about the deployment's posture was established`,
    );
  }
  if (meta.cfc === null) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "fail",
      `\`${meta.url}\` publishes no posture, so what this deployment enforces is indistinguishable from the default`,
      [{ artifact: "/api/meta", pointer: "cfc", detail: "null" }],
    );
  }
  if (meta.cfc.provenance !== "resolved") {
    // A deployment publishing a projection has published what it expects to
    // be at rather than what it is at, and a client adopting it would be
    // adopting a prediction. `/api/meta` is served from a constructed
    // Runtime, so this cannot be a shape the route produces — it is a
    // deployment answering the question with the wrong kind of record.
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "fail",
      `\`${meta.url}\` publishes a projected posture, which is what a runtime is expected to resolve rather than what one attested`,
      [{
        artifact: "/api/meta",
        pointer: "cfc.provenance",
        detail: meta.cfc.provenance,
      }],
    );
  }
  if (audit.expected === undefined) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "warn",
      `\`${meta.url}\` publishes a posture, but no expected-posture spec was named for it to be compared against`,
      [{
        artifact: "/api/meta",
        pointer: "cfc.enforcementMode.rung",
        detail: meta.cfc.enforcementMode.rung,
      }],
    );
  }
  const mismatches = postureMismatches(audit.expected, meta.cfc);
  if (mismatches.length === 0) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "pass",
      `\`${meta.url}\` publishes a posture satisfying every field the spec asserts`,
    );
  }
  return corpusResult(
    audit,
    "AUD-17",
    "toolshed posture",
    citations,
    "fail",
    `\`${meta.url}\` publishes a posture that misses ${
      count(
        mismatches.length,
        "field the spec asserts",
        "fields the spec asserts",
      )
    }`,
    mismatches.map((mismatch) => ({
      artifact: "/api/meta",
      pointer: `cfc.${mismatch.field}`,
      detail: `expected ${mismatch.expected}, found ${mismatch.found}`,
    })),
  );
};

//
// AUD-18 surface parity
//

/** The distinct posture records the corpus recorded, keyed by their JSON. */
const distinctRecords = (
  audit: DeploymentAudit,
): ReadonlyMap<string, readonly string[]> => {
  const byRecord = new Map<string, string[]>();
  for (const run of everyRun(audit)) {
    const record = recordOf(run);
    if (record === undefined) continue;
    const key = JSON.stringify(record);
    const held = byRecord.get(key);
    if (held === undefined) {
      byRecord.set(key, [run.runId]);
    } else {
      held.push(run.runId);
    }
  }
  return byRecord;
};

const surfaceParity = (audit: DeploymentAudit): CheckResult => {
  const citations = citationsFor("AH-CFC-14", "AH-CFC-15");
  const records = distinctRecords(audit);
  if (records.size === 0) {
    return corpusResult(
      audit,
      "AUD-18",
      "surface parity",
      citations,
      "inconclusive",
      "no run of this corpus recorded a posture record, so no two surfaces could be compared",
    );
  }
  const evidence: CheckEvidence[] = [...records].map(([key, runIds]) => ({
    detail: `${runIds.length} run(s) — ${runIds.join(", ")} — at ${
      (JSON.parse(key) as CfcPostureReport).enforcementMode.rung
    } / flow ${(JSON.parse(key) as CfcPostureReport).flowLabels.rung}`,
  }));
  const mismatched = audit.expected === undefined ? [] : [...records].flatMap((
    [key, runIds],
  ) =>
    postureMismatches(audit.expected!, JSON.parse(key) as CfcPostureReport)
      .map((mismatch) => ({ runIds, mismatch }))
  );
  if (mismatched.length > 0) {
    return corpusResult(
      audit,
      "AUD-18",
      "surface parity",
      citations,
      "fail",
      `${
        count(records.size, "posture record", "distinct posture records")
      } in this corpus, and ${
        count(mismatched.length, "field", "fields")
      } of the spec is not satisfied by all of them`,
      mismatched.map(({ runIds, mismatch }) => ({
        pointer: mismatch.field,
        detail: `${
          runIds.join(", ")
        }: expected ${mismatch.expected}, found ${mismatch.found}`,
      })),
    );
  }
  if (records.size > 1) {
    return corpusResult(
      audit,
      "AUD-18",
      "surface parity",
      citations,
      "warn",
      `this corpus holds ${
        count(records.size, "posture record", "distinct posture records")
      }; the harness's own surfaces diverge by default — the console opts every session into the max-enforcement bundle and the CLI leaves the fleet posture unless \`--fabric-cfc-posture\` says otherwise — so a corpus mixing them records two postures for one harness`,
      evidence,
    );
  }
  return corpusResult(
    audit,
    "AUD-18",
    "surface parity",
    citations,
    "pass",
    "every run of this corpus that recorded a posture recorded the same one",
    evidence,
  );
};

//
// AUD-19 render ceiling
//

/**
 * The render ceiling, which nothing publishes.
 *
 * A permanent line item rather than a check that could pass: the shell's
 * render ceiling is a CFC decision an audit of these artifacts cannot reach,
 * because no surface writes it down. Reporting it as `inconclusive` every
 * time is the honest answer — the alternative is an audit whose silence about
 * the render ceiling reads as a clean bill for it. It retires when a
 * publisher exists.
 */
const renderCeiling = (audit: DeploymentAudit): CheckResult =>
  corpusResult(
    audit,
    "AUD-19",
    "render ceiling",
    citationsFor("AH-CFC-14"),
    "inconclusive",
    "no surface publishes the shell's render ceiling, so this audit establishes nothing about it; the line item retires when a publisher exists",
  );

/** Every Group D finding, in id order. */
export const auditDeployment = (
  audit: DeploymentAudit,
): readonly CheckResult[] => {
  const results: CheckResult[] = [refusalLiveness(audit)];
  const toolshed = toolshedPosture(audit);
  if (toolshed !== undefined) {
    results.push(toolshed);
  }
  results.push(surfaceParity(audit), renderCeiling(audit));
  return results;
};
