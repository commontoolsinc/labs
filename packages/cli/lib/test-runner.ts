/**
 * Test runner for pattern-native tests.
 *
 * Test patterns (.test.tsx) are patterns that:
 * 1. Import and instantiate the pattern under test
 * 2. Define test actions as handlers (Stream<void>)
 * 3. Define assertions as Cell<boolean>
 * 4. Return { tests: [...] } array processed sequentially
 */

import { Identity } from "@commontools/identity";
import { Engine, Runtime, isCell, isStream } from "@commontools/runner";
import type { Cell, Recipe, Stream } from "@commontools/runner";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { basename } from "@std/path";

export interface TestResult {
  name: string;
  passed: boolean;
  afterAction: string | null;
  error?: string;
  durationMs: number;
}

export interface TestRunResult {
  path: string;
  results: TestResult[];
  totalDurationMs: number;
  error?: string;
}

export interface TestRunnerOptions {
  timeout?: number;
  verbose?: boolean;
}

/**
 * Creates a timeout promise that rejects after the specified duration.
 */
function createTimeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Run a single test pattern file.
 */
export async function runTestPattern(
  testPath: string,
  options: TestRunnerOptions = {},
): Promise<TestRunResult> {
  const TIMEOUT = options.timeout ?? 5000;
  const startTime = performance.now();

  // 1. Create emulated runtime (same as charm step)
  const identity = await Identity.fromPassphrase("test-runner");
  const space = identity.did();
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const engine = new Engine(runtime);

  try {
    // 2. Compile the test pattern
    const program = await engine.resolve(
      new FileSystemProgramResolver(testPath),
    );
    const { main } = await engine.process(program, {
      noCheck: false,
      noRun: false,
    });

    if (!main?.default) {
      throw new Error(
        `Test pattern must export a pattern function as default`,
      );
    }

    const testPatternFactory = main.default as Recipe;

    if (typeof testPatternFactory !== "function") {
      throw new Error(
        `Test pattern must export a pattern function as default, got ${typeof testPatternFactory}`,
      );
    }

    // 3. Instantiate the test pattern using runtime.run() for proper space context
    const tx = runtime.edit();

    // Create a result cell for the pattern
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      `test-pattern-result-${Date.now()}`,
      undefined,
      tx,
    );

    // Run the pattern with proper space context
    const patternResult = runtime.run(tx, testPatternFactory, {}, resultCell);

    // Commit the transaction
    await tx.commit();

    // Wait for initial setup to complete
    await runtime.idle();

    // Keep the pattern reactive
    const _sinkCancel = patternResult.sink(() => {});

    // 4. Get the tests array from pattern output
    // Use .key() to get sub-cells without unwrapping
    const testsCell = patternResult.key("tests") as Cell<unknown[]>;

    // Get the length of the tests array to iterate
    const testsValue = testsCell.get();
    if (!Array.isArray(testsValue)) {
      throw new Error(
        "Test pattern must return { tests: [...] }. Got: " +
          JSON.stringify(typeof testsValue),
      );
    }

    const testCount = testsValue.length;

    if (options.verbose) {
      console.log(`  Found ${testCount} test items`);
    }

    // 5. Process tests in order
    const results: TestResult[] = [];
    let lastActionName: string | null = null;
    let assertionIndex = 0;
    let actionIndex = 0;

    for (let i = 0; i < testCount; i++) {
      // Use .key() to get the item as a Cell/Stream without unwrapping
      const testItem = testsCell.key(i);
      const itemStart = performance.now();

      if (isStream(testItem)) {
        // It's an action - invoke it
        actionIndex++;
        lastActionName = `action_${actionIndex}`;

        if (options.verbose) {
          console.log(`  → Running ${lastActionName}...`);
        }

        // Send empty object - handlers may expect event-like object
        // Cast needed because .key() returns Cell which overlaps with Stream
        (testItem as unknown as Stream<unknown>).send({});

        // Wait for idle with timeout
        try {
          await Promise.race([
            runtime.idle(),
            createTimeout(
              TIMEOUT,
              `Action ${lastActionName} timed out after ${TIMEOUT}ms`,
            ),
          ]);
        } catch (err) {
          results.push({
            name: lastActionName,
            passed: false,
            afterAction: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - itemStart,
          });
          // Continue to next test item
        }
      } else if (isCell(testItem)) {
        // It's an assertion - check the boolean value
        assertionIndex++;
        const assertName = `assert_${assertionIndex}`;

        let passed = false;
        let error: string | undefined;

        try {
          const value = testItem.get();
          passed = value === true;
          if (!passed) {
            error = `Expected true, got ${JSON.stringify(value)}`;
          }
        } catch (err) {
          passed = false;
          error = `Error reading assertion: ${err instanceof Error ? err.message : String(err)}`;
        }

        results.push({
          name: assertName,
          passed,
          afterAction: lastActionName,
          error,
          durationMs: performance.now() - itemStart,
        });

        if (options.verbose) {
          const status = passed ? "✓" : "✗";
          const suffix = lastActionName ? ` (after ${lastActionName})` : "";
          console.log(`  ${status} ${assertName}${suffix}`);
        }
      } else {
        // Unknown type - skip with warning
        if (options.verbose) {
          console.log(`  ? Skipping unknown test item at index ${i}`);
        }
      }
    }

    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
    };
  } catch (err) {
    return {
      path: testPath,
      results: [],
      totalDurationMs: performance.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // 6. Cleanup
    engine.dispose();
    await storageManager.close();
  }
}

/**
 * Run all test patterns in a directory or a single test file.
 */
export async function runTests(
  pathOrPaths: string | string[],
  options: TestRunnerOptions = {},
): Promise<{ passed: number; failed: number; results: TestRunResult[] }> {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const allResults: TestRunResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const testPath of paths) {
    console.log(`\n${basename(testPath)}`);

    const result = await runTestPattern(testPath, options);
    allResults.push(result);

    if (result.error) {
      console.log(`  ✗ Error: ${result.error}`);
      totalFailed++;
    } else {
      for (const test of result.results) {
        const status = test.passed ? "✓" : "✗";
        const suffix = test.afterAction ? ` (after ${test.afterAction})` : "";
        console.log(`  ${status} ${test.name}${suffix}`);
        if (!test.passed && test.error) {
          console.log(`    ${test.error}`);
        }

        if (test.passed) {
          totalPassed++;
        } else {
          totalFailed++;
        }
      }
    }
  }

  // Summary
  const totalTime = allResults.reduce((sum, r) => sum + r.totalDurationMs, 0);
  console.log(
    `\n${totalPassed} passed, ${totalFailed} failed (${Math.round(totalTime)}ms)`,
  );

  return { passed: totalPassed, failed: totalFailed, results: allResults };
}

/**
 * Discover test files in a directory.
 */
export async function discoverTestFiles(dir: string): Promise<string[]> {
  const testFiles: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".test.tsx")) {
        testFiles.push(`${dir}/${entry.name}`);
      } else if (entry.isDirectory) {
        // Recursively search subdirectories
        const subFiles = await discoverTestFiles(`${dir}/${entry.name}`);
        testFiles.push(...subFiles);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return testFiles;
}
