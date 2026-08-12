#!/usr/bin/env -S deno run -A
/**
 * Tier 1 pattern-update gate. Compiles every authored pattern, then proves its
 * argument/result contract can still be applied over every contract recorded
 * for it under `packages/patterns/baselines/`.
 *
 * The rule this enforces is the one `cf piece setsrc` enforces
 * (`assertPatternSchemasBackwardCompatible`); the automatic updater applies a
 * new pattern with no structural check at all, so nothing but CI stands between
 * an incompatible schema and every running piece. See `pattern-compat-lib.ts`.
 *
 *   deno task pattern-compat             # check (what CI runs)
 *   deno task pattern-compat --update    # record contracts that have no baseline
 *   deno task pattern-compat --only home # restrict to matching paths
 *
 * Baselines are never pruned. They are small, most patterns never change
 * contract, and — decisively — an author-run `--update` that could *remove* a
 * baseline could remove the very one that would have caught the break. `--update`
 * can only add.
 *
 * A break the repository decides to ship — a surface removed on purpose, its
 * held state an accepted casualty — cannot be recorded away and must not be
 * deleted away. It is declared in `pattern-compat-accepted-breaks.ts`, which
 * forgives named `(pattern, baseline)` pairs and nothing else.
 */

import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import {
  collectPatternFiles,
  patternKey,
  PATTERNS_DIR,
} from "./pattern-files.ts";
import { UNEVALUABLE_PATTERNS } from "./pattern-compat-unevaluable.ts";
import { ACCEPTED_CONTRACT_BREAKS } from "./pattern-compat-accepted-breaks.ts";
import {
  acceptedBreakKey,
  checkPattern,
  type Finding,
  findRetired,
  parseArgs,
  parseShard,
  partitionAcceptedBreaks,
  type PatternContract,
  readBaselines,
  shouldRecord,
  writeBaseline,
} from "./pattern-compat-lib.ts";

const BASELINES_DIR = `${PATTERNS_DIR}/baselines`;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function main() {
  let update: boolean;
  let only: string[];
  let shard: { index: number; count: number };
  try {
    ({ update, only } = parseArgs(Deno.args));
    shard = parseShard(Deno.env.get("PATTERN_COMPAT_SHARD"));
  } catch (error) {
    console.error(formatError(error));
    Deno.exit(2);
  }

  const allFiles = await collectPatternFiles();
  const selected = only.length === 0
    ? allFiles
    : allFiles.filter((file) => only.some((match) => file.includes(match)));
  const files = selected.filter((_file, i) => i % shard.count === shard.index);

  const shardLabel = shard.count > 1
    ? ` [shard ${shard.index + 1}/${shard.count}]`
    : "";
  console.log(
    `Checking update compatibility for ${files.length} patterns${shardLabel}.`,
  );

  const runtime = await createRuntime();
  const engine = runtime.harness;
  const cwd = Deno.cwd();

  const contracts = new Map<string, PatternContract>();
  /**
   * Files that yielded no contract, and why. Most of `packages/patterns` is not
   * a pattern entry — `schemas.tsx`, `auth-types.ts`, client helpers — and a
   * module with no pattern default export has no update contract to check, so
   * it is skipped rather than failed. It only becomes a finding if baselines
   * exist for it, which means it USED to be a pattern: pieces are pinned to it
   * and can no longer roll forward. That case is `checkPattern`'s `retired`.
   */
  const unavailable = new Map<string, string>();
  /** Skips that are an evaluation error rather than "not a pattern entry". */
  const evaluationErrors: { pattern: string; error: string }[] = [];

  // `PATTERN_COMPAT_TIMING=1` reports where the run spent its time. Kept
  // because this job's cost is dominated by a few pathological schemas rather
  // than by pattern count, so a cost regression is not visible from the total.
  const timingEnabled = Deno.env.get("PATTERN_COMPAT_TIMING") !== undefined;
  const timings: { key: string; ms: number }[] = [];
  for (const file of files) {
    const key = patternKey(file);
    const started = performance.now();
    try {
      const program = await engine.resolve(
        new FileSystemProgramResolver(`${cwd}/${file}`, cwd),
      );
      // `noCheck`: cfcheck already type-checks this tree in its own job. Here
      // the compile exists only to reach the pattern object's schemas.
      const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
        program,
        { noCheck: true },
      );
      const { main: exports } = engine.evaluateRecordGraph(
        id,
        graph,
        mainSpecifier,
        program.files,
      );
      const pattern = (exports as Record<string, unknown>)?.default as
        | PatternContract
        | undefined;
      if (
        pattern?.argumentSchema === undefined ||
        pattern?.resultSchema === undefined
      ) {
        unavailable.set(key, "no pattern default export");
        continue;
      }
      contracts.set(key, {
        argumentSchema: pattern.argumentSchema,
        resultSchema: pattern.resultSchema,
      });
    } catch (error) {
      const reason = formatError(error);
      unavailable.set(key, reason);
      evaluationErrors.push({ pattern: key, error: reason });
    }
    timings.push({ key, ms: performance.now() - started });
  }
  if (timingEnabled) {
    console.log("\nSlowest compiles:");
    for (
      const timing of [...timings].sort((a, b) => b.ms - a.ms).slice(0, 10)
    ) {
      console.log(`  ${Math.round(timing.ms)}ms  ${timing.key}`);
    }
  }

  const findings: Finding[] = [];
  // Retirement is a whole-tree question, so only an unfiltered shard 1 asks it;
  // otherwise every pattern outside this shard would look retired.
  if (only.length === 0 && shard.index === 0) {
    findings.push(...await findRetired(BASELINES_DIR, PATTERNS_DIR));
  }

  const recorded: string[] = [];
  // Every `(pattern, baseline)` pair a deliberate break is allowed to fail
  // against, mapped to the schema paths it may blame, and the ones that turned
  // out not to fail — a pair that needs no forgiving is an exemption outliving
  // its break, so it fails the run.
  const acceptedBreaks = new Map<string, ReadonlySet<string>>(
    ACCEPTED_CONTRACT_BREAKS.flatMap((accepted) =>
      accepted.baselines.map((baseline) =>
        [
          acceptedBreakKey(accepted.pattern, baseline),
          new Set(accepted.paths),
        ] as const
      )
    ),
  );
  const breaksUsed = new Set<string>();
  const forgivenBreaks: Finding[] = [];
  // `unavailable` keys are included so a file that USED to export a pattern is
  // caught: it has baselines but no contract, which `checkPattern` reports.
  const keys = [...new Set([...contracts.keys(), ...unavailable.keys()])]
    .sort();
  for (const key of keys) {
    const current = contracts.get(key);
    const baselines = await readBaselines(BASELINES_DIR, key);
    const checkStarted = performance.now();
    const allFindings = checkPattern(key, current, baselines);
    if (timingEnabled) {
      const ms = Math.round(performance.now() - checkStarted);
      // A slow check means a contract CHANGED and its proof is expensive — the
      // schema machinery blows up combinatorially on some shapes.
      if (ms > 200) console.log(`  check ${ms}ms  ${key}`);
    }

    // An accepted break stops being a finding here, BEFORE `shouldRecord` sees
    // the list — which is the whole point. The contract that ships a decided
    // removal has to reach a baseline, or the next change to that pattern has
    // nothing to prove itself against.
    const { standing: patternFindings, forgiven } = partitionAcceptedBreaks(
      allFindings,
      acceptedBreaks,
    );
    for (const finding of forgiven) {
      if (finding.kind !== "incompatible") continue;
      breaksUsed.add(acceptedBreakKey(finding.pattern, finding.baseline));
    }
    forgivenBreaks.push(...forgiven);

    if (update && current !== undefined) {
      if (shouldRecord(patternFindings)) {
        const name = await writeBaseline(
          BASELINES_DIR,
          key,
          current,
          new Date(),
        );
        recorded.push(`${key}/${name}`);
      }
      // A recorded contract still has to survive the incompatibility check
      // below — `--update` adds evidence, it never clears a finding.
      findings.push(
        ...patternFindings.filter((f) => f.kind !== "missing-baseline"),
      );
      continue;
    }

    findings.push(...patternFindings);
  }

  await runtime.dispose();

  if (recorded.length > 0) {
    console.log(`\nRecorded ${recorded.length} contract(s):`);
    for (const name of recorded) console.log(`  ${name}`);
  }

  if (forgivenBreaks.length > 0) {
    console.log(
      `\nForgave ${forgivenBreaks.length} accepted contract break(s) ` +
        `(tasks/pattern-compat-accepted-breaks.ts):`,
    );
    for (const finding of forgivenBreaks) {
      if (finding.kind !== "incompatible") continue;
      console.log(
        `  ${finding.pattern} over ${finding.baseline}: ` +
          `${finding.detail.split("\n").slice(1).join(" ").trim()}`,
      );
    }
  }
  // Asked per PATTERN rather than of the whole list, because CI never runs the
  // whole list in one process: the Pattern Update Compatibility job always sets
  // `PATTERN_COMPAT_SHARD`, so a check gated on an unsharded run would never
  // execute where it matters. A pattern belongs to exactly one shard, so the
  // shard that examined it can say whether its pairs were needed, and the four
  // shards between them cover every entry.
  const examined = new Set(keys);
  const staleBreaks = ACCEPTED_CONTRACT_BREAKS
    .filter((accepted) => examined.has(accepted.pattern))
    .flatMap((accepted) =>
      accepted.baselines
        .map((baseline) => acceptedBreakKey(accepted.pattern, baseline))
        .filter((pair) => !breaksUsed.has(pair))
    );
  // An entry whose pattern is not in the tree AT ALL is invisible to the check
  // above: no shard examines it, so its pairs are never used and never stale.
  // Retiring a pattern deletes its baselines with it, which is exactly when an
  // acceptance stops meaning anything — and exactly when nothing would notice.
  // A whole-tree question, so only an unfiltered shard 1 asks it, as retirement
  // itself does above.
  const knownPatterns = new Set(allFiles.map((file) => patternKey(file)));
  const orphanedBreaks = only.length === 0 && shard.index === 0
    ? ACCEPTED_CONTRACT_BREAKS
      .map((accepted) => accepted.pattern)
      .filter((pattern) => !knownPatterns.has(pattern))
    : [];

  if (unavailable.size > 0) {
    console.log(
      `\nSkipped ${unavailable.size} file(s) with no pattern contract ` +
        `(${evaluationErrors.length} from an evaluation error).`,
    );
  }
  // An evaluation error is a pattern the gate CANNOT protect: no contract means
  // no baseline means no check, forever. Allowlisted ones are known debt; a new
  // one fails the run, so the list can only shrink.
  const unexpectedFailures = evaluationErrors.filter(
    (failure) => !UNEVALUABLE_PATTERNS.has(failure.pattern),
  );
  for (const failure of evaluationErrors) {
    const known = UNEVALUABLE_PATTERNS.has(failure.pattern) ? "known" : "NEW";
    console.log(
      `  [${known}] ${failure.pattern}: ${failure.error.split("\n")[0]}`,
    );
  }
  // A listed pattern that evaluates again must leave the list, or its exemption
  // outlives the breakage it was granted for.
  const recovered = files
    .map((file) => patternKey(file))
    .filter((key) => UNEVALUABLE_PATTERNS.has(key) && contracts.has(key));

  if (findings.length > 0) {
    console.error("\nPattern update compatibility failures:");
    for (const finding of findings) {
      if (finding.kind === "missing-baseline") {
        console.error(
          `\n${finding.pattern}\n  contract ${finding.hash} is not recorded.` +
            `\n  Run: deno task pattern-compat --update`,
        );
      } else if (finding.kind === "incompatible") {
        console.error(
          `\n${finding.pattern}\n  cannot be applied over baseline ` +
            `${finding.baseline}:\n${finding.detail}`,
        );
      } else if (finding.kind === "invalid-schema") {
        console.error(
          `\n${finding.pattern}\n  ${finding.role} schema is not valid on its ` +
            `own terms: ${finding.detail}`,
        );
      } else {
        console.error(
          `\n${finding.pattern}\n  has ${finding.baselines.length} baseline(s) ` +
            `but yields no contract now: ` +
            `${unavailable.get(finding.pattern) ?? "file is gone"}.` +
            `\n  Every piece tracking this path is pinned to its current ` +
            `pattern forever — the updater's ?identity probe simply fails and ` +
            `nothing surfaces on the piece.` +
            `\n  Restore it, or delete its baseline directory to record the ` +
            `retirement deliberately.`,
        );
      }
    }
  }

  if (unexpectedFailures.length > 0) {
    console.error(
      `\n${unexpectedFailures.length} pattern(s) newly fail to evaluate. A ` +
        `pattern that cannot evaluate gets no baseline and is exempt from this ` +
        `gate forever — fix it, or add it to ` +
        `tasks/pattern-compat-unevaluable.ts with the reason.`,
    );
  }
  if (recovered.length > 0) {
    console.error(
      `\n${recovered.length} pattern(s) listed in ` +
        `tasks/pattern-compat-unevaluable.ts now evaluate: ` +
        `${
          recovered.join(", ")
        }. Remove them from that list so they are gated.`,
    );
  }
  if (staleBreaks.length > 0) {
    console.error(
      `\n${staleBreaks.length} accepted contract break(s) in ` +
        `tasks/pattern-compat-accepted-breaks.ts forgive nothing: ` +
        `${
          staleBreaks.join(", ")
        }. The pair applies cleanly now, or blames only paths the entry does ` +
        `not name, so the exemption outlives its break — remove it.`,
    );
  }
  if (orphanedBreaks.length > 0) {
    console.error(
      `\n${orphanedBreaks.length} accepted contract break(s) in ` +
        `tasks/pattern-compat-accepted-breaks.ts name a pattern that no ` +
        `longer exists: ${orphanedBreaks.join(", ")}. Retiring a pattern ` +
        `takes its baselines with it, so the acceptance forgives nothing and ` +
        `nothing will ever notice — remove it.`,
    );
  }

  if (
    findings.length > 0 || unexpectedFailures.length > 0 ||
    recovered.length > 0 || staleBreaks.length > 0 || orphanedBreaks.length > 0
  ) Deno.exit(1);
  console.log(
    `\n${contracts.size} pattern(s) can be updated from every recorded contract.`,
  );
}

if (import.meta.main) {
  await main();
}
