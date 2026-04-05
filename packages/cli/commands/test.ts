import { Command } from "@cliffy/command";
import type { MemoryVersion } from "@commonfabric/memory/interface";
import { resolve } from "@std/path";
import { expandGlob } from "@std/fs";
import { cliText } from "../lib/cli-name.ts";
import { discoverTestFiles, runTests } from "../lib/test-runner.ts";

const schedulerModes = ["default", "push", "pull"] as const;

export const test = new Command()
  .name("test")
  .description("Run pattern tests (.test.tsx files).")
  .example(
    cliText("cf test ./counter.test.tsx"),
    "Run a single test pattern file.",
  )
  .example(
    cliText("cf test ./patterns/"),
    "Run all .test.tsx files in a directory (recursive).",
  )
  .example(
    cliText("cf test './*.test.tsx'"),
    "Run all test files matching a glob pattern.",
  )
  .example(
    cliText("cf test ./counter.test.tsx --timeout 10000"),
    "Run with custom timeout (10 seconds).",
  )
  .example(
    cliText(
      "cf test ./battleship/pass-and-play/main.test.tsx --root ./battleship",
    ),
    "Run with custom root for resolving imports from sibling directories.",
  )
  .option(
    "--timeout <ms:number>",
    "Timeout per test action in milliseconds.",
    { default: 5000 },
  )
  .option(
    "--verbose",
    "Show detailed execution logs.",
  )
  .option(
    "--root <dir:string>",
    "Root directory for resolving imports. Enables imports like '../shared/utils.tsx'.",
  )
  .option(
    "--memory-version <version:string>",
    "Force the test harness storage/runtime implementation (v1 or v2).",
    {
      value: (value: string): MemoryVersion => {
        if (value === "v1" || value === "v2") {
          return value;
        }
        throw new Error(`Invalid memory version: ${value}`);
      },
    },
  )
  .option(
    "--stats-threshold <ms:number>",
    "Print logger stats for steps slower than this (ms). 0 = every step. Requires --verbose.",
    { default: 5000 },
  )
  .option(
    "--stats-include <prefixes:string>",
    "Comma-separated timing categories to always print in verbose stats output (exact or prefix match).",
  )
  .option(
    "--stats-action-limit <count:number>",
    "Number of per-step scheduler action deltas to print in verbose mode.",
    { default: 10 },
  )
  .option(
    "--scheduler-mode <mode:string>",
    "Scheduler mode for test runtimes: default, push, or pull.",
    { default: "default" },
  )
  .option(
    "--storage-stats",
    "Print storage-related logger timings and counts after each test file.",
  )
  .option(
    "--storage-stats-limit <count:number>",
    "Maximum number of storage timing/count entries to print with --storage-stats.",
    { default: 16 },
  )
  .arguments("<paths...:string>")
  .action(async (options, ...paths) => {
    const testFiles: string[] = [];

    for (const path of paths) {
      const fullPath = resolve(Deno.cwd(), path);

      // Check if it's a glob pattern
      if (path.includes("*")) {
        // Expand glob pattern
        for await (const entry of expandGlob(fullPath)) {
          if (entry.isFile && entry.name.endsWith(".test.tsx")) {
            testFiles.push(entry.path);
          }
        }
      } else {
        // Check if path exists
        let stat: Deno.FileInfo;
        try {
          stat = await Deno.stat(fullPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            console.error(`Error: Path not found: ${fullPath}`);
          } else {
            console.error(`Error accessing path ${fullPath}:`, error);
          }
          Deno.exit(1);
        }

        if (stat.isDirectory) {
          // Discover test files in directory
          const discovered = await discoverTestFiles(fullPath);
          testFiles.push(...discovered);
        } else if (stat.isFile) {
          // Single file - warn but allow non-.test.tsx for flexibility
          if (!path.endsWith(".test.tsx")) {
            console.warn(`Warning: ${path} does not end with .test.tsx`);
          }
          testFiles.push(fullPath);
        } else {
          console.error(`Error: ${fullPath} is not a file or directory`);
          Deno.exit(1);
        }
      }
    }

    // Deduplicate test files (in case of overlapping paths like ./patterns/ and ./patterns/counter.test.tsx)
    const uniqueTestFiles = [...new Set(testFiles)];

    if (uniqueTestFiles.length === 0) {
      console.error(`Error: No test files found`);
      Deno.exit(1);
    }

    console.log(`Found ${uniqueTestFiles.length} test file(s)`);

    // Resolve root path if provided
    const root = options.root ? resolve(Deno.cwd(), options.root) : undefined;
    const statsInclude = options.statsInclude
      ? String(options.statsInclude)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
      : undefined;
    const schedulerMode = schedulerModes.find((mode) =>
      mode === options.schedulerMode
    );
    if (!schedulerMode) {
      console.error(
        "Error: --scheduler-mode must be one of: default, push, pull",
      );
      Deno.exit(1);
    }

    // Run tests
    const { failed } = await runTests(uniqueTestFiles, {
      timeout: options.timeout,
      verbose: options.verbose,
      root,
      memoryVersion: options.memoryVersion,
      statsThreshold: options.statsThreshold,
      statsInclude,
      statsActionLimit: options.statsActionLimit,
      schedulerMode,
      storageStats: options.storageStats,
      storageStatsLimit: options.storageStatsLimit,
    });

    // Exit with error code if any tests failed
    if (failed > 0) {
      Deno.exit(1);
    }
  });
