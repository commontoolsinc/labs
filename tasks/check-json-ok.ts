#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run=deno
//
// Holds `tasks/json-ok-baseline.json` to the truth, in both directions.
//
// The lint plugin (`tasks/json-ok-lint-plugin.ts`) enforces the per-file budget
// the baseline records, so `deno lint` alone cannot tell whether a budget is
// still the right number — a file that has shed half its unjustified
// `JSON.parse()` / `JSON.stringify()` calls lints clean against the old, larger
// budget, and the ground it gained could be given back tomorrow without a word.
//
// This check closes that. It re-runs the lint with `CF_JSON_OK_REPORT_ALL` set,
// which makes the plugin ignore the baseline and report every unjustified call,
// and compares the true per-file counts against the recorded ones. A file over
// its budget fails as a regression; a file under it fails as a stale entry,
// with `--update` as the fix. So the budget only ever ratchets down.
//
// Counting by way of `deno lint` rather than a walk of its own is deliberate:
// the two would otherwise have to agree, forever, about which files are in
// scope, and `deno.jsonc`'s `lint.exclude` would be silently reinterpreted by
// whoever edited it last.
//
// Usage: deno task check-json-ok
//        deno task check-json-ok --update    # rewrite the baseline

import {
  BASELINE_PATH,
  DIAGNOSTIC_CODE,
  formatBaseline,
  type JsonOkBaseline,
  loadBaseline,
  REPO_ROOT,
  repoRelative,
  REPORT_ALL_ENV,
} from "./json-ok-lint-plugin.ts";

/** The shape of `deno lint --json` output that this check reads. */
interface LintOutput {
  readonly diagnostics: ReadonlyArray<{
    readonly filename: string;
    readonly code: string;
  }>;
}

/**
 * Runs `deno lint --json` over the repository with the plugin's baseline
 * suppression turned off, and returns the count of unjustified calls per
 * repo-relative path.
 *
 * `deno lint` exits non-zero whenever it reports anything, which here is the
 * expected case rather than a failure, so the status is ignored and the output
 * is the signal. A run that produces no parseable output at all is a real
 * failure and throws.
 */
export async function countUnjustified(
  root: string = REPO_ROOT,
): Promise<Map<string, number>> {
  const command = new Deno.Command("deno", {
    args: ["lint", "--json"],
    cwd: root,
    env: { [REPORT_ALL_ENV]: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr } = await command.output();
  const text = new TextDecoder().decode(stdout);

  let parsed: LintOutput;
  try {
    // json-ok: `deno lint --json` output, whose contract is plain JSON.
    parsed = JSON.parse(text) as LintOutput;
  } catch {
    const detail = new TextDecoder().decode(stderr).trim();
    throw new Error(
      `Could not read \`deno lint --json\` output.${
        detail === "" ? "" : `\n\n${detail}`
      }`,
    );
  }

  const counts = new Map<string, number>();
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.code !== DIAGNOSTIC_CODE) continue;
    const path = repoRelative(
      diagnostic.filename.startsWith("file://")
        ? new URL(diagnostic.filename).pathname
        : diagnostic.filename,
      root,
    );
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/** A file whose true count and recorded budget disagree. */
export interface Drift {
  readonly file: string;
  readonly budget: number;
  readonly actual: number;
}

/** The two ways a baseline can be wrong, split for separate reporting. */
export interface Comparison {
  /** Files holding more unjustified calls than the baseline allows. */
  readonly regressions: readonly Drift[];
  /** Files holding fewer, whose budget is now stale and should shrink. */
  readonly stale: readonly Drift[];
}

/**
 * Compares true counts against a baseline. Both directions are reported: a
 * budget that is too small is a regression, and one that is too large is debt
 * the baseline is still claiming after it has been paid off.
 */
export function compare(
  baseline: JsonOkBaseline,
  counts: ReadonlyMap<string, number>,
): Comparison {
  const regressions: Drift[] = [];
  const stale: Drift[] = [];

  const files = new Set([...Object.keys(baseline), ...counts.keys()]);
  for (const file of [...files].sort()) {
    const budget = baseline[file] ?? 0;
    const actual = counts.get(file) ?? 0;
    if (actual > budget) regressions.push({ file, budget, actual });
    else if (actual < budget) stale.push({ file, budget, actual });
  }
  return { regressions, stale };
}

/** Turns true counts into the baseline that would record them. */
export function baselineFrom(
  counts: ReadonlyMap<string, number>,
): JsonOkBaseline {
  return Object.fromEntries([...counts.entries()].filter(([, n]) => n > 0));
}

/** Total unjustified calls a baseline accounts for. */
export function totalOf(baseline: JsonOkBaseline): number {
  return Object.values(baseline).reduce((sum, n) => sum + n, 0);
}

function reportRegressions(regressions: readonly Drift[]): void {
  const lines = [
    "",
    "New unjustified `JSON.parse()` / `JSON.stringify()` call(s):",
    "",
    ...regressions.map(({ file, budget, actual }) =>
      `  ${file} — ${actual} found, ${budget} allowed`
    ),
    "",
    "`JSON.stringify()` renders NaN and ±Infinity as null, drops undefined",
    "members, does not canonicalize key order, and rebuilds a FabricInstance as",
    "a plain record, losing its class identity. `JSON.parse()` inverts none of",
    "that. Plenty of call sites are nonetheless fine — a config file, a log",
    "line, a test fixture, a wire format that genuinely is JSON.",
    "",
    "Say which this one is, on the line above the statement or at the end of",
    "the call's own line:",
    "",
    "  // json-ok: reading a config file written by this repository.",
    "  const config = JSON.parse(text);",
    "",
    "If the value can carry Fabric data, prefer the codecs in",
    "@commonfabric/data-model over a plain-JSON round trip.",
    "",
  ];
  console.error(lines.join("\n"));
}

function reportStale(stale: readonly Drift[]): void {
  const lines = [
    "",
    "Baseline entries that claim more debt than these files now hold:",
    "",
    ...stale.map(({ file, budget, actual }) =>
      `  ${file} — ${actual} found, ${budget} allowed`
    ),
    "",
    "The budget only ratchets down, so a file that has shed unjustified calls",
    "keeps the ground it gained. Run:",
    "",
    "  deno task check-json-ok --update",
    "",
    "and commit the smaller baseline alongside the change that earned it.",
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check (or the update), reports, and returns a process code. */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = REPO_ROOT,
): Promise<number> {
  const update = args.includes("--update");
  const counts = await countUnjustified(root);

  if (update) {
    const next = baselineFrom(counts);
    await Deno.writeTextFile(BASELINE_PATH, formatBaseline(next));
    console.log(
      `Wrote ${BASELINE_PATH}: ${Object.keys(next).length} file(s), ` +
        `${totalOf(next)} unjustified call(s).`,
    );
    return 0;
  }

  const baseline = loadBaseline();
  const { regressions, stale } = compare(baseline, counts);
  if (regressions.length > 0) reportRegressions(regressions);
  if (stale.length > 0) reportStale(stale);
  if (regressions.length > 0 || stale.length > 0) return 1;

  console.log(
    `json-ok baseline is accurate: ${Object.keys(baseline).length} file(s), ` +
      `${totalOf(baseline)} unjustified call(s) still to justify.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
