import { process } from "../packages/cli/lib/dev.ts";

const PATTERNS_DIR = "packages/patterns";
const CHECK_BATCH_SIZE = 8;

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

const allFiles = await collectPatternFiles(PATTERNS_DIR);
const filesToCheck = allFiles.filter((file) =>
  !EXCLUDED_PATTERN_FILES.has(file)
);
const excludedPresent = allFiles.filter((file) =>
  EXCLUDED_PATTERN_FILES.has(file)
);
const staleExclusions = [...EXCLUDED_PATTERN_FILES].filter((file) =>
  !allFiles.includes(file)
);

if (staleExclusions.length > 0) {
  console.error("Stale cfcheck exclusions:");
  for (const file of staleExclusions) console.error(`  ${file}`);
  Deno.exit(1);
}

console.log(
  `Common Fabric checking ${filesToCheck.length} pattern files` +
    ` (${excludedPresent.length} excluded).`,
);

const failures: Array<{ file: string; error: string }> = [];

for (let i = 0; i < filesToCheck.length; i += CHECK_BATCH_SIZE) {
  const batch = filesToCheck.slice(i, i + CHECK_BATCH_SIZE);
  await Promise.all(
    batch.map(async (file) => {
      try {
        await process({
          main: `${Deno.cwd()}/${file}`,
          rootPath: Deno.cwd(),
          check: true,
          run: false,
        });
      } catch (error) {
        failures.push({
          file,
          error: formatError(error),
        });
      }
    }),
  );
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
