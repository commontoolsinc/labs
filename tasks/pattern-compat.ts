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
 */

import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import {
  collectPatternFiles,
  patternKey,
  PATTERNS_DIR,
} from "./pattern-files.ts";
import {
  type Baseline,
  checkPattern,
  contractHash,
  type Finding,
  type PatternContract,
} from "./pattern-compat-lib.ts";

const BASELINES_DIR = `${PATTERNS_DIR}/baselines`;

interface StoredBaseline extends PatternContract {
  /** The pattern this contract belongs to, for readability of a lone file. */
  pattern: string;
}

function parseArgs(argv: string[]) {
  const only: string[] = [];
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--update") update = true;
    else if (argv[i] === "--only") only.push(argv[++i] ?? "");
    else if (argv[i].startsWith("--only=")) only.push(argv[i].slice(7));
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      Deno.exit(2);
    }
  }
  return { update, only: only.filter((value) => value.length > 0) };
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A filesystem- and sort-friendly stamp: `20260728T154500Z`. */
const stamp = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Read every recorded contract for a pattern. The filename is human metadata
 * only (when it was recorded, and a hash prefix for readability) — the
 * authoritative hash is recomputed from the file's contents, so a renamed or
 * mislabelled file cannot misreport what it holds.
 */
async function readBaselines(key: string): Promise<Baseline[]> {
  const dir = `${BASELINES_DIR}/${key}`;
  const baselines: Baseline[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const stored = JSON.parse(
      await Deno.readTextFile(`${dir}/${entry.name}`),
    ) as StoredBaseline;
    baselines.push({
      label: entry.name.replace(/\.json$/, ""),
      contract: {
        argumentSchema: stored.argumentSchema,
        resultSchema: stored.resultSchema,
      },
    });
  }
  return baselines.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Optional CI fan-out, mirroring cfcheck's `CFCHECK_SHARD`: `"i/n"`, 1-based.
 * Compiling a pattern is single-threaded CPU work, so more cores means more
 * processes.
 */
function parseShard(): { index: number; count: number } {
  const raw = Deno.env.get("PATTERN_COMPAT_SHARD");
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    console.error(
      `Invalid PATTERN_COMPAT_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
    Deno.exit(2);
  }
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    console.error(`PATTERN_COMPAT_SHARD "${raw}" out of range.`);
    Deno.exit(2);
  }
  return { index, count };
}

/** Every pattern key that has a baseline directory, including retired ones. */
async function collectBaselineKeys(): Promise<string[]> {
  const keys: string[] = [];
  async function walk(current: string, prefix: string) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(current)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A pattern's own directory is named for its file (`home.tsx`); anything
      // else is an intermediate path segment.
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        keys.push(key);
      } else {
        await walk(`${current}/${entry.name}`, key);
      }
    }
  }
  await walk(BASELINES_DIR, "");
  return keys.sort();
}

/**
 * Baselines whose pattern file is gone. Deleting a served pattern pins every
 * piece tracking it forever — the updater's `?identity` probe just fails and it
 * "does nothing" — so this is worth surfacing even though it needs no compiler.
 *
 * Deliberately filesystem-only: it must see the whole tree, so it cannot ride
 * along with the sharded, filterable compile pass below.
 */
async function findRetired(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const key of await collectBaselineKeys()) {
    try {
      Deno.statSync(`${PATTERNS_DIR}/${key}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      findings.push(...checkPattern(key, undefined, await readBaselines(key)));
    }
  }
  return findings;
}

async function main() {
  const { update, only } = parseArgs(Deno.args);
  const shard = parseShard();

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
    findings.push(...await findRetired());
  }

  const recorded: string[] = [];
  // `unavailable` keys are included so a file that USED to export a pattern is
  // caught: it has baselines but no contract, which `checkPattern` reports.
  const keys = [...new Set([...contracts.keys(), ...unavailable.keys()])]
    .sort();
  for (const key of keys) {
    const current = contracts.get(key);
    const baselines = await readBaselines(key);
    const checkStarted = performance.now();
    const patternFindings = checkPattern(key, current, baselines);
    if (timingEnabled) {
      const ms = Math.round(performance.now() - checkStarted);
      // A slow check means a contract CHANGED and its proof is expensive — the
      // schema machinery blows up combinatorially on some shapes.
      if (ms > 200) console.log(`  check ${ms}ms  ${key}`);
    }

    if (update && current !== undefined) {
      const missing = patternFindings.some((f) =>
        f.kind === "missing-baseline"
      );
      // Never record an invalid contract. Schema validity is only checked for
      // an UNrecorded contract (see `checkPattern`), so recording one would
      // silence the finding permanently. The finding still fails this run.
      const invalid = patternFindings.some((f) =>
        f.kind === "incompatible" && f.baseline === "(current)"
      );
      if (missing && !invalid) {
        const dir = `${BASELINES_DIR}/${key}`;
        await Deno.mkdir(dir, { recursive: true });
        const name = `${stamp()}-${contractHash(current)}.json`;
        const stored: StoredBaseline = { pattern: key, ...current };
        await Deno.writeTextFile(
          `${dir}/${name}`,
          `${JSON.stringify(stored, null, 2)}\n`,
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

  if (unavailable.size > 0) {
    console.log(
      `\nSkipped ${unavailable.size} file(s) with no pattern contract ` +
        `(${evaluationErrors.length} from an evaluation error).`,
    );
  }
  // Listed, never fatal on their own: a module that cannot be evaluated has no
  // contract to check and no piece pinned to it. If one ever DID have a
  // contract, its baselines turn this into a `retired` finding above.
  for (const failure of evaluationErrors) {
    console.log(`  ${failure.pattern}: ${failure.error.split("\n")[0]}`);
  }

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

  if (findings.length > 0) Deno.exit(1);
  console.log(
    `\n${contracts.size} pattern(s) can be updated from every recorded contract.`,
  );
}

if (import.meta.main) {
  await main();
}
