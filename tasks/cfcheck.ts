/**
 * The pattern type check: every authored pattern compiled, type-checked,
 * transformed and SES-verified in the JSX and runtime-type environment
 * patterns actually run under.
 *
 *   deno task cfcheck                        # the whole corpus
 *   deno task cfcheck --only home            # restrict to matching paths
 *
 * `--only` takes one pattern per flag and may be repeated, and a run given
 * none checks everything. `CFCHECK_SHARD="i/n"` (1-based) splits what is
 * left across parallel processes.
 */

import type { RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { FragmentWriter } from "@commonfabric/test-support/records";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import {
  collectAllPatternFiles,
  matchesPatternFilter,
} from "./pattern-files.ts";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The `--only` terms a command line carries. An argument that is not one, and
 * a `--only` carrying nothing, both end the run: a term dropped for being
 * empty leaves the run looking unfiltered, so it would check the whole corpus
 * while its caller was charged for one pattern.
 */
function parseOnly(argv: readonly string[]): string[] {
  const only: string[] = [];
  const refuse = (why: string): never => {
    console.error(why);
    console.error("usage: deno task cfcheck [--only <pattern>]...");
    Deno.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    let value: string;
    if (argument === "--only") {
      value = argv[++i] ?? refuse("--only needs a value");
    } else if (argument.startsWith("--only=")) {
      value = argument.slice("--only=".length);
    } else value = refuse(`Unknown argument: ${argument}`);
    // A value opening with `--` is the caller's next flag, read as a
    // filter. It matches no pattern, so the run would check nothing and
    // say so only by the count it prints.
    if (value.length === 0 || value.startsWith("--")) {
      refuse(`--only needs a value, and was given ${JSON.stringify(value)}`);
    }
    only.push(value);
  }
  return only;
}

// Optional sharding for CI fan-out: CFCHECK_SHARD="i/n" (1-based) checks only
// the files where (index % n) == (i - 1). Pattern compiles are single-threaded
// CPU work, so n shards run as n parallel CI jobs.
function parseShard(): { index: number; count: number } {
  const raw = Deno.env.get("CFCHECK_SHARD");
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    console.error(`Invalid CFCHECK_SHARD "${raw}"; expected "i/n" (1-based).`);
    Deno.exit(1);
  }
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    console.error(`CFCHECK_SHARD "${raw}" out of range.`);
    Deno.exit(1);
  }
  return { index, count };
}

const only = parseOnly(Deno.args);
const shard = parseShard();

const allFiles = await collectAllPatternFiles();
const selected = only.length === 0
  ? allFiles
  : allFiles.filter((file) =>
    only.some((match) => matchesPatternFilter(file, match))
  );
const filesToCheck = selected.filter((_file, i) =>
  i % shard.count === shard.index
);

const shardLabel = shard.count > 1
  ? ` [shard ${shard.index + 1}/${shard.count}]`
  : "";
console.log(
  `Common Fabric checking ${filesToCheck.length} pattern files${shardLabel}.`,
);

const failures: Array<{ file: string; error: string }> = [];
const cwd = Deno.cwd();

// Resolve every pattern's authored module graph (the pattern + its local
// imports). A resolve failure — e.g. a malformed import — is a per-file
// failure, reported like any other.
const runtime = await createRuntime();
const resolved: Array<{ file: string; program: RuntimeProgram }> = [];
for (const file of filesToCheck) {
  try {
    resolved.push({
      file,
      program: await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: `${cwd}/${file}`, root: cwd },
      ),
    });
  } catch (error) {
    failures.push({ file, error: formatError(error) });
  }
}

// Type-check + transform + SES-verify ALL patterns in ONE TypeScript program,
// so the lib/API parse and bind is paid once for the whole shard rather than
// once per pattern. Diagnostics come back attributed per file, and so does
// the time each file took.
const result = await runtime.harness.typeCheckBatch(
  resolved.map((entry) => entry.program),
);
for (const diagnostic of result.diagnostics) {
  // Strip the engine's internal `/fid1:<hash>` path prefix back to a repo path.
  const file = (diagnostic.file ?? "")
    .replace(/^\/fid1:[^/]+\//, "")
    .replace(`${cwd}/`, "") || "(batch)";
  failures.push({ file, error: diagnostic.message });
}

// One typecheck-kind record per file in this shard, named "cfcheck <file>",
// carrying what the batch spent on that pattern's own files. A file the
// resolve step rejected never reached the batch and carries no time. A
// diagnostic attributed to "(batch)" fails the run without belonging to a
// file record.
const recordsFragment = FragmentWriter.openForRun();
if (recordsFragment !== undefined) {
  const failedFiles = new Set(failures.map((failure) => failure.file));
  const durations = new Map(
    resolved.map(({ file, program }) =>
      [file, result.durations.get(program.main) ?? 0] as const
    ),
  );
  for (const file of filesToCheck) {
    recordsFragment.append({
      line: "record",
      test: { k: "typecheck", s: "repo", n: `cfcheck ${file}` },
      outcome: failedFiles.has(file) ? "fail" : "pass",
      durationMs: Math.round(durations.get(file) ?? 0),
    });
  }
  recordsFragment.close();
}

if (failures.length > 0) {
  failures.sort((a, b) => a.file.localeCompare(b.file));
  console.error("Common Fabric pattern checks failed:");
  for (const failure of failures) {
    console.error(`\n${failure.file}`);
    console.error(failure.error);
  }
  Deno.exit(1);
}
