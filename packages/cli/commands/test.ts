import { Command } from "@cliffy/command";
import { join } from "@std/path";
import {
  discoverTestFiles,
  runTests,
} from "../lib/test-runner.ts";

export const test = new Command()
  .name("test")
  .description("Run pattern tests (.test.tsx files).")
  .example(
    "ct test ./counter.test.tsx",
    "Run a single test pattern file.",
  )
  .example(
    "ct test ./patterns/",
    "Run all .test.tsx files in a directory (recursive).",
  )
  .example(
    "ct test ./counter.test.tsx --timeout 10000",
    "Run with custom timeout (10 seconds).",
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
  .arguments("<path:string>")
  .action(async (options, path) => {
    const fullPath = join(Deno.cwd(), path);

    // Check if path exists
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(fullPath);
    } catch {
      console.error(`Error: Path not found: ${fullPath}`);
      Deno.exit(1);
    }

    let testFiles: string[];

    if (stat.isDirectory) {
      // Discover test files in directory
      testFiles = await discoverTestFiles(fullPath);
      if (testFiles.length === 0) {
        console.error(`Error: No .test.tsx files found in ${fullPath}`);
        Deno.exit(1);
      }
      console.log(`Found ${testFiles.length} test file(s)`);
    } else if (stat.isFile) {
      // Single file
      if (!path.endsWith(".test.tsx")) {
        console.error(`Error: Test files must end with .test.tsx`);
        Deno.exit(1);
      }
      testFiles = [fullPath];
    } else {
      console.error(`Error: ${fullPath} is not a file or directory`);
      Deno.exit(1);
    }

    // Run tests
    const { failed } = await runTests(testFiles, {
      timeout: options.timeout,
      verbose: options.verbose,
    });

    // Exit with error code if any tests failed
    if (failed > 0) {
      Deno.exit(1);
    }
  });
