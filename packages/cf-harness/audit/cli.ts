/**
 * `deno task cfc-audit` — the spec-anchored CFC audit over session artifacts.
 *
 * ```
 * deno task cfc-audit <runDir | artifactRoot> [more paths...]
 *                     [--json] [--fail-on fail|warn|inconclusive]
 * ```
 *
 * A run directory audits that run and the `delegate_task` children beside it;
 * an artifact root audits every run under it. Every finding is printed with
 * the clause it rests on and the words of that clause, so a reader can go from
 * the finding to the sentence that makes it a finding without leaving the
 * output.
 *
 * The audit reads. It opens no run for writing and creates nothing inside an
 * artifact tree.
 */

import { auditRunFamily } from "./checks/structural.ts";
import { discoverRunFamilies } from "./evidence.ts";
import {
  type CheckResult,
  type CheckVerdict,
  countVerdicts,
  DEFAULT_FAIL_ON,
  type FailOnThreshold,
  VERDICT_ORDER,
  verdictFailsThreshold,
} from "./report.ts";

/** What the command line asked for. */
export interface AuditCliOptions {
  paths: readonly string[];
  json: boolean;
  failOn: FailOnThreshold;
}

const FAIL_ON_VALUES: readonly FailOnThreshold[] = [
  "fail",
  "warn",
  "inconclusive",
];

const USAGE =
  "usage: cfc-audit <runDir | artifactRoot> [more paths...] [--json] [--fail-on fail|warn|inconclusive]";

/**
 * Reads the command line.
 *
 * @throws Error naming the problem, for a caller to print beside the usage.
 */
export const parseAuditCliArgs = (
  args: readonly string[],
): AuditCliOptions => {
  const paths: string[] = [];
  let json = false;
  let failOn: FailOnThreshold = DEFAULT_FAIL_ON;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fail-on") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("`--fail-on` needs one of fail, warn, inconclusive");
      }
      if (!FAIL_ON_VALUES.includes(value as FailOnThreshold)) {
        throw new Error(
          `\`--fail-on ${value}\` is not one of fail, warn, inconclusive`,
        );
      }
      failOn = value as FailOnThreshold;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option \`${arg}\``);
    }
    paths.push(arg);
  }
  if (paths.length === 0) {
    throw new Error("name at least one run directory or artifact root");
  }
  return { paths, json, failOn };
};

/** Audits every run family under every named path. */
export const auditPaths = async (
  paths: readonly string[],
): Promise<readonly CheckResult[]> => {
  const results: CheckResult[] = [];
  for (const path of paths) {
    for (const family of await discoverRunFamilies(path)) {
      results.push(...auditRunFamily(family));
    }
  }
  return results;
};

const VERDICT_LABEL: Record<CheckVerdict, string> = {
  fail: "FAIL",
  warn: "WARN",
  inconclusive: "INCONCLUSIVE",
  "not-applicable": "N/A",
  pass: "PASS",
};

const renderFinding = (result: CheckResult): string => {
  const lines = [
    `  ${result.checkId} ${result.title} — ${result.runId}`,
    `    ${result.message}`,
  ];
  for (const citation of result.citations) {
    lines.push(`    ${citation.clause} (${citation.doc})`);
    lines.push(`      "${citation.quote}"`);
  }
  for (const evidence of result.evidence) {
    const where = [evidence.artifact, evidence.pointer].filter((part) =>
      part !== undefined
    ).join(" ");
    lines.push(
      `    evidence: ${where === "" ? "" : `${where} — `}${evidence.detail}`,
    );
  }
  lines.push(`    run: ${result.runDir}`);
  return lines.join("\n");
};

/** The human report: the findings that carry weight, worst verdict first. */
export const renderAuditReport = (
  results: readonly CheckResult[],
  failOn: FailOnThreshold,
): string => {
  const counts = countVerdicts(results);
  const runs = new Set(results.map((result) => result.runDir)).size;
  const sections: string[] = [];
  for (const verdict of VERDICT_ORDER) {
    if (verdict === "pass" || verdict === "not-applicable") {
      continue;
    }
    const matching = results.filter((result) => result.verdict === verdict);
    if (matching.length === 0) {
      continue;
    }
    sections.push(
      `${VERDICT_LABEL[verdict]} (${matching.length})\n${
        matching.map(renderFinding).join("\n\n")
      }`,
    );
  }
  const summary = VERDICT_ORDER
    .map((verdict) => `${VERDICT_LABEL[verdict]} ${counts[verdict]}`)
    .join("  ");
  const header = `${results.length} checks over ${runs} runs — ${summary}`;
  const footer = `exiting non-zero at or above \`${failOn}\``;
  return [header, ...sections, footer].join("\n\n");
};

/** Runs the audit and returns the process exit code. */
export const runAuditCli = async (
  args: readonly string[],
  write: (text: string) => void = (text) => console.log(text),
): Promise<number> => {
  let options: AuditCliOptions;
  try {
    options = parseAuditCliArgs(args);
  } catch (error) {
    write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 2;
  }
  const results = await auditPaths(options.paths);
  write(
    options.json
      ? JSON.stringify(results, null, 2)
      : renderAuditReport(results, options.failOn),
  );
  return results.some((result) =>
      verdictFailsThreshold(result.verdict, options.failOn)
    )
    ? 1
    : 0;
};

if (import.meta.main) {
  Deno.exit(await runAuditCli(Deno.args));
}
