import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { FragmentWriter } from "@commonfabric/test-support/records";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import { collectPatternFiles, PATTERNS_DIR } from "./pattern-files.ts";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

const shard = parseShard();

const allFiles = await collectPatternFiles(PATTERNS_DIR);
const filesToCheck = allFiles.filter((_file, i) =>
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
const programs = [];
for (const file of filesToCheck) {
  try {
    programs.push(
      await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: `${cwd}/${file}`, root: cwd },
      ),
    );
  } catch (error) {
    failures.push({ file, error: formatError(error) });
  }
}

// Type-check + transform + SES-verify ALL patterns in ONE TypeScript program.
// The lib/API parse+bind is paid once for the whole shard instead of once per
// pattern (the per-program bind, not the type-check itself, was cfcheck's
// dominant cost — measured). Diagnostics come back attributed per file.
const result = await runtime.harness.typeCheckBatch(programs);
for (const diagnostic of result.diagnostics) {
  // Strip the engine's internal `/fid1:<hash>` path prefix back to a repo path.
  const file = (diagnostic.file ?? "")
    .replace(/^\/fid1:[^/]+\//, "")
    .replace(`${cwd}/`, "") || "(batch)";
  failures.push({ file, error: diagnostic.message });
}

// One typecheck-kind record per file in this shard, named "cfcheck <file>".
// The shard stays one batched TypeScript program because the per-program
// bind dominates its cost, so per-file durations do not exist: every record
// carries a zero duration and only the outcome is meaningful. A diagnostic
// attributed to "(batch)" fails the run without belonging to a file record.
const recordsFragment = FragmentWriter.openForRun();
if (recordsFragment !== undefined) {
  const failedFiles = new Set(failures.map((failure) => failure.file));
  for (const file of filesToCheck) {
    recordsFragment.append({
      line: "record",
      test: { k: "typecheck", s: "repo", n: `cfcheck ${file}` },
      outcome: failedFiles.has(file) ? "fail" : "pass",
      durationMs: 0,
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
