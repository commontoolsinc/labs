#!/usr/bin/env deno run -A

import { fromFileUrl, resolve } from "@std/path";
import {
  callPieceHandler,
  newPiece,
  type EntryConfig,
  type PieceConfig,
  type SpaceConfig,
} from "../packages/cli/lib/piece.ts";

type ExperimentPattern = {
  label: string;
  mainPath: string;
};

type DeployTiming = {
  pieceId: string;
  elapsedMs: number;
  space: string;
};

type PatternResult = {
  pattern: string;
  fresh: DeployTiming;
  seeded: DeployTiming;
  seededSetupMs: number;
};

const repoRoot = resolve(fromFileUrl(new URL("..", import.meta.url)));
const patternsRoot = resolve(repoRoot, "packages/patterns");
const noteParagraph =
  "Common Fabric startup benchmark note. This content exists to populate a notebook with enough reactive state to exercise piece startup in a non-trivial space. ";

const experimentPatterns: ExperimentPattern[] = [
  { label: "note", mainPath: resolve(patternsRoot, "notes/note.tsx") },
  {
    label: "contact-book",
    mainPath: resolve(patternsRoot, "contacts/contact-book.tsx"),
  },
  { label: "calendar", mainPath: resolve(patternsRoot, "calendar/calendar.tsx") },
  {
    label: "reading-list",
    mainPath: resolve(patternsRoot, "reading-list/reading-list.tsx"),
  },
];

function parseArgs(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else {
      values[key] = "true";
    }
  }

  return {
    apiUrl: values["api-url"] ?? "http://localhost:8000",
    identity: values["identity"] ?? "/tmp/ct1476.key",
    seedNotes: Number(values["seed-notes"] ?? "12"),
    seedTodos: Number(values["seed-todos"] ?? "0"),
    noteBytes: Number(values["note-bytes"] ?? "8192"),
    spacePrefix: values["space-prefix"] ?? "ct1476",
    pattern: values["pattern"] ?? "all",
  };
}

function makeSpaceName(prefix: string, label: string, kind: "fresh" | "seeded") {
  return `${prefix}-${label}-${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function makeConfig(apiUrl: string, identity: string, space: string): SpaceConfig {
  return { apiUrl, identity, space };
}

function makePieceConfig(
  base: SpaceConfig,
  piece: string,
): PieceConfig {
  return { ...base, piece };
}

function buildEntry(mainPath: string): EntryConfig {
  return {
    mainPath,
    rootPath: patternsRoot,
  };
}

function makeNoteContent(index: number, targetBytes: number): string {
  let content = `Seed note ${index + 1}\n\n`;
  while (content.length < targetBytes) {
    content += `${noteParagraph}${index} `;
  }
  return content.slice(0, targetBytes);
}

async function timedDeploy(
  config: SpaceConfig,
  entry: EntryConfig,
): Promise<DeployTiming> {
  const startedAt = performance.now();
  const pieceId = await newPiece(config, entry);
  return {
    pieceId,
    elapsedMs: Math.round(performance.now() - startedAt),
    space: config.space,
  };
}

async function seedSpace(
  config: SpaceConfig,
  options: { seedNotes: number; seedTodos: number; noteBytes: number },
): Promise<number> {
  const startedAt = performance.now();

  const notebookId = await newPiece(
    config,
    buildEntry(resolve(patternsRoot, "notes/notebook.tsx")),
  );
  await callPieceHandler(
    makePieceConfig(config, notebookId),
    "setTitle",
    "CT-1476 Benchmark Notebook",
  );

  if (options.seedNotes > 0) {
    await callPieceHandler(
      makePieceConfig(config, notebookId),
      "createNotes",
      {
        notesData: Array.from({ length: options.seedNotes }, (_, i) => ({
          title: `Seed Note ${i + 1}`,
          content: makeNoteContent(i, options.noteBytes),
        })),
      },
    );
  }

  if (options.seedTodos > 0) {
    const todoId = await newPiece(
      config,
      buildEntry(resolve(patternsRoot, "todo-list/todo-list.tsx")),
    );
    for (let i = 0; i < options.seedTodos; i++) {
      await callPieceHandler(
        makePieceConfig(config, todoId),
        "addItem",
        { title: `Seed todo ${i + 1} for startup benchmark` },
      );
    }
  }

  return Math.round(performance.now() - startedAt);
}

async function runOnePattern(
  pattern: ExperimentPattern,
  options: ReturnType<typeof parseArgs>,
): Promise<PatternResult> {
  const freshConfig = makeConfig(
    options.apiUrl,
    options.identity,
    makeSpaceName(options.spacePrefix, pattern.label, "fresh"),
  );
  const seededConfig = makeConfig(
    options.apiUrl,
    options.identity,
    makeSpaceName(options.spacePrefix, pattern.label, "seeded"),
  );
  const entry = buildEntry(pattern.mainPath);

  console.error(`\n[ct1476] Benchmarking ${pattern.label}`);
  console.error(`[ct1476] Fresh space:  ${freshConfig.space}`);
  console.error(`[ct1476] Seeded space: ${seededConfig.space}`);

  const fresh = await timedDeploy(freshConfig, entry);
  console.error(
    `[ct1476] Fresh deploy completed in ${fresh.elapsedMs}ms (${fresh.pieceId})`,
  );

  const seededSetupMs = await seedSpace(seededConfig, options);
  console.error(
    `[ct1476] Seeded space populated in ${seededSetupMs}ms`,
  );

  const seeded = await timedDeploy(seededConfig, entry);
  console.error(
    `[ct1476] Seeded deploy completed in ${seeded.elapsedMs}ms (${seeded.pieceId})`,
  );

  return {
    pattern: pattern.label,
    fresh,
    seeded,
    seededSetupMs,
  };
}

async function main() {
  const options = parseArgs(Deno.args);
  const patterns = options.pattern === "all"
    ? experimentPatterns
    : experimentPatterns.filter((pattern) => pattern.label === options.pattern);

  if (patterns.length === 0) {
    throw new Error(
      `Unknown pattern "${options.pattern}". Expected one of: ${
        experimentPatterns.map((pattern) => pattern.label).join(", ")
      }, all`,
    );
  }

  const results: PatternResult[] = [];
  for (const pattern of patterns) {
    results.push(await runOnePattern(pattern, options));
  }

  console.log(JSON.stringify({
    apiUrl: options.apiUrl,
    identity: options.identity,
    seedNotes: options.seedNotes,
    seedTodos: options.seedTodos,
    noteBytes: options.noteBytes,
    results,
  }, null, 2));
}

if (import.meta.main) {
  await main();
}
