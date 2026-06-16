import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { createRuntime } from "../packages/cli/lib/dev.ts";

const PATTERNS_DIR = "packages/patterns";

const NON_PATTERN_PREFIXES = [
  "packages/patterns/integration/",
  "packages/patterns/tools/",
];

// deno-lint-ignore ban-untagged-todo
// TODO: Drive this list to zero so cfcheck covers every authored pattern file.
const EXCLUDED_PATTERN_FILES = new Set<string>([
  "packages/patterns/base/contacts.tsx",
  "packages/patterns/base/family-member.tsx",
  "packages/patterns/base/person.tsx",
  "packages/patterns/battleship/multiplayer/repro-minimal.tsx",
  "packages/patterns/cfc-agent-prompt-injection-demo/main.tsx",
  "packages/patterns/cfc/prompt-injection/atoms.ts",
  "packages/patterns/cfc/prompt-injection/mod.ts",
  "packages/patterns/cfc/prompt-injection/schemas.ts",
  "packages/patterns/cfc/prompt-injection/tools.ts",
  "packages/patterns/deprecated/calendar-v512.tsx",
  "packages/patterns/deprecated/charm-ref-in-cell.tsx",
  "packages/patterns/deprecated/charms-ref-in-cell.tsx",
  "packages/patterns/deprecated/linkedlist-in-cell.tsx",
  "packages/patterns/examples/write-and-run.tsx",
  "packages/patterns/experimental/email-task-engine.tsx",
  "packages/patterns/google/WIP/google-docs-importer.tsx",
  "packages/patterns/google/core/bill-extractor/index.tsx",
  "packages/patterns/google/core/experimental/calendar-event-manager.tsx",
  "packages/patterns/google/core/experimental/gmail-label-manager.tsx",
  "packages/patterns/google/core/experimental/gmail-sender.tsx",
  "packages/patterns/google/core/experimental/google-docs-comment-confirm.ts",
  "packages/patterns/google/core/experimental/google-docs-comment-orchestrator.tsx",
  "packages/patterns/google/core/gmail-extractor.tsx",
  "packages/patterns/google/core/imported-calendar.tsx",
  "packages/patterns/google/core/util/agentic-tools.ts",
  "packages/patterns/google/core/util/calendar-write-client.ts",
  "packages/patterns/google/core/util/gmail-send-client.ts",
  "packages/patterns/google/core/util/google-docs-client.ts",
  "packages/patterns/google/extractors/bam-school-dashboard.tsx",
  "packages/patterns/google/extractors/berkeley-library.tsx",
  "packages/patterns/google/extractors/bofa-bill-tracker.tsx",
  "packages/patterns/google/extractors/calendar-change-detector.tsx",
  "packages/patterns/google/extractors/chase-bill-tracker.tsx",
  "packages/patterns/google/extractors/email-notes.tsx",
  "packages/patterns/google/extractors/email-pattern-dreamer.tsx",
  "packages/patterns/google/extractors/email-pattern-launcher.tsx",
  "packages/patterns/google/extractors/email-style-extractor.tsx",
  "packages/patterns/google/extractors/email-ticket-finder.tsx",
  "packages/patterns/google/extractors/expect-response-followup.tsx",
  "packages/patterns/google/extractors/favorite-foods-gmail-agent.tsx",
  "packages/patterns/google/extractors/hotel-membership-gmail-agent.tsx",
  "packages/patterns/google/extractors/pge-bill-tracker.tsx",
  "packages/patterns/google/extractors/united-flight-tracker.tsx",
  "packages/patterns/google/extractors/usps-informed-delivery.tsx",
  "packages/patterns/mod.ts",
  "packages/patterns/scrabble/scrabble-words.ts",
  "packages/patterns/test/webhook-test.tsx",
  "packages/patterns/weekly-calendar/weekly-calendar.tsx",
]);

async function collectPatternFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string) {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!isPatternSource(path)) continue;
      files.push(path);
    }
  }

  await walk(dir);
  return files.sort();
}

function isPatternSource(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  return !NON_PATTERN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Optional sharding for CI fan-out: CFCHECK_SHARD="i/n" (1-based) checks only
// the files where (index % n) == (i - 1). Pattern compiles are single-threaded
// CPU work that doesn't parallelize within one process, so the way to use more
// cores is more PROCESSES — run n shards as n parallel CI jobs (mirrors the
// existing "Pattern Tests (1/4..4/4)" fan-out). Stale-exclusion validation
// runs on shard 1 only (it needs the full file list).
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
const eligibleFiles = allFiles.filter((file) =>
  !EXCLUDED_PATTERN_FILES.has(file)
);
const filesToCheck = eligibleFiles.filter((_file, i) =>
  i % shard.count === shard.index
);
const excludedPresent = allFiles.filter((file) =>
  EXCLUDED_PATTERN_FILES.has(file)
);
const staleExclusions = [...EXCLUDED_PATTERN_FILES].filter((file) =>
  !allFiles.includes(file)
);

// Stale exclusions reference the full corpus, so only the first shard checks.
if (shard.index === 0 && staleExclusions.length > 0) {
  console.error("Stale cfcheck exclusions:");
  for (const file of staleExclusions) console.error(`  ${file}`);
  Deno.exit(1);
}

const shardLabel = shard.count > 1
  ? ` [shard ${shard.index + 1}/${shard.count}]`
  : "";
console.log(
  `Common Fabric checking ${filesToCheck.length} pattern files` +
    ` (${excludedPresent.length} excluded)${shardLabel}.`,
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
      await runtime.harness.resolve(
        new FileSystemProgramResolver(`${cwd}/${file}`, cwd),
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

if (failures.length > 0) {
  failures.sort((a, b) => a.file.localeCompare(b.file));
  console.error("Common Fabric pattern checks failed:");
  for (const failure of failures) {
    console.error(`\n${failure.file}`);
    console.error(failure.error);
  }
  Deno.exit(1);
}
