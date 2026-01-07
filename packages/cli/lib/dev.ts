import { type JsScript, Program } from "@commontools/js-compiler";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import { basename } from "@std/path";

async function createRuntime() {
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  return new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
}

export interface ProcessOptions {
  main: string;
  run: boolean;
  check: boolean;
  output?: string;
  filename?: string;
  showTransformed?: boolean;
  mainExport?: string;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: JsScript; main?: Record<string, unknown> }> {
  const filename = options.filename
    ? basename(options.filename)
    : options.output
    ? basename(options.output)
    : undefined;
  const engine = new Engine(await createRuntime());
  const program = await engine.resolve(
    new FileSystemProgramResolver(options.main),
  );
  if (options.mainExport) {
    program.mainExport = options.mainExport;
  }
  const getTransformedProgram = options.showTransformed
    ? renderTransformed
    : undefined;
  const { output, main } = await engine.process(program, {
    noCheck: !options.check,
    noRun: !options.run,
    filename,
    getTransformedProgram,
  });

  if (options.output) {
    await Deno.writeTextFile(options.output, output.js);
  }
  return { output, main };
}

function renderTransformed(program: Program) {
  for (const { contents, name } of program.files) {
    console.log(`// transformed: ${name}`);
    console.log(contents);
  }
}

/**
 * Run tests for a pattern from a __tests__/ directory.
 *
 * @param testDir - The directory containing test files
 * @param patternName - The name of the pattern being tested (for display)
 * @returns The exit code (0 for success, non-zero for failure)
 */
export async function runTests(
  testDir: string,
  patternName: string,
): Promise<number> {
  // Check if the test directory exists
  try {
    const stat = await Deno.stat(testDir);
    if (!stat.isDirectory) {
      console.error(`Error: ${testDir} is not a directory`);
      return 1;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`Error: Test directory not found: ${testDir}`);
      console.error(
        `Create a __tests__/ subdirectory next to your pattern with *.test.ts files.`,
      );
    } else {
      console.error(`Error accessing test directory ${testDir}:`, error);
    }
    return 1;
  }

  // Find all test files
  const testFiles: string[] = [];
  for await (const entry of Deno.readDir(testDir)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      testFiles.push(`${testDir}/${entry.name}`);
    }
  }

  if (testFiles.length === 0) {
    console.error(`Error: No test files found in ${testDir}`);
    console.error(`Test files must end with .test.ts`);
    return 1;
  }

  console.log(`Running tests for ${patternName}...`);
  console.log(`Found ${testFiles.length} test file(s)\n`);

  // Run deno test with the test files
  const command = new Deno.Command("deno", {
    args: [
      "test",
      "--allow-ffi",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      ...testFiles,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await command.output();
  return code;
}
