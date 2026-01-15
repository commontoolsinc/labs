/**
 * Test runner for pattern-native tests.
 *
 * Test patterns (.test.tsx) are patterns that:
 * 1. Import and instantiate the pattern under test
 * 2. Define test steps as an array of { assertion } or { action } objects
 * 3. Return { tests: TestStep[] }
 *
 * TestStep is a discriminated union:
 * - { assertion: OpaqueRef<boolean> } from computed(() => condition)
 * - { action: Stream<void> } from action(() => sideEffect)
 *
 * The discriminated union avoids TypeScript declaration emit issues
 * that occur when mixing Cell and Stream types in the same array.
 *
 * Example:
 * tests: [
 *   { assertion: computed(() => game.phase === "playing") },
 *   { action: action(() => game.start.send(undefined)) },
 *   { assertion: computed(() => game.phase === "started") },
 * ]
 *
 * Note: By default, test patterns can only import from their own directory or
 * subdirectories. To enable imports from sibling directories (e.g., `../shared/`),
 * use the --root option to specify a common ancestor directory.
 */

import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import type { Cell, Recipe, Stream } from "@commontools/runner";
import type { OpaqueRef } from "@commontools/api";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { basename } from "@std/path";
import { timeout } from "@commontools/utils/sleep";

/**
 * A test step is an object with either an 'assertion' or 'action' property.
 * This discriminated union avoids TypeScript trying to unify incompatible Cell/Stream types.
 */
export type TestStep =
  | { assertion: OpaqueRef<boolean> }
  | { action: Stream<void> };

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
  /** Root directory for resolving imports. If not provided, uses the test file's directory. */
  root?: string;
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

  // Track sink subscription for cleanup
  let sinkCancel: (() => void) | undefined;

  try {
    // 2. Compile the test pattern
    const program = await engine.resolve(
      new FileSystemProgramResolver(testPath, options.root),
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

    // Keep the pattern reactive - store cancel function for cleanup
    sinkCancel = patternResult.sink(() => {});

    // 4. Get the tests array from pattern output
    const testsCell = patternResult.key("tests") as Cell<unknown>;
    const testsValue = testsCell.get();

    // Validate it's an array
    if (!Array.isArray(testsValue)) {
      throw new Error(
        "Test pattern must return { tests: TestStep[] }. Got: " +
          JSON.stringify(typeof testsValue),
      );
    }

    if (options.verbose) {
      console.log(`  Found ${testsValue.length} test steps`);
    }

    // 5. Process tests sequentially
    const results: TestResult[] = [];
    let lastActionIndex: number | null = null;
    let assertionCount = 0;
    let actionCount = 0;

    for (let i = 0; i < testsValue.length; i++) {
      const itemStart = performance.now();
      const stepValue = testsValue[i] as {
        action?: unknown;
        assertion?: unknown;
      };

      // Check if this step has 'action' or 'assertion' key
      const isAction = "action" in stepValue;
      const isAssertion = "assertion" in stepValue;

      if (!isAction && !isAssertion) {
        throw new Error(
          `Test step at index ${i} must have either 'action' or 'assertion' key. Got: ${
            JSON.stringify(Object.keys(stepValue))
          }`,
        );
      }

      if (isAction) {
        // It's an action - invoke it
        actionCount++;
        lastActionIndex = i;
        const actionName = `action_${actionCount}`;

        if (options.verbose) {
          console.log(`  → Running ${actionName}...`);
        }

        // Get the action stream via .key()
        const actionStream = testsCell.key(i).key(
          "action",
        ) as unknown as Stream<unknown>;

        // Send undefined for void streams
        actionStream.send(undefined);

        // Wait for idle with timeout
        try {
          await Promise.race([
            runtime.idle(),
            timeout(
              TIMEOUT,
              `Action at index ${i} timed out after ${TIMEOUT}ms`,
            ),
          ]);
        } catch (err) {
          results.push({
            name: actionName,
            passed: false,
            afterAction: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - itemStart,
          });
        }
      } else {
        // It's an assertion - check the boolean value
        assertionCount++;
        const assertionName = `assertion_${assertionCount}`;

        let passed = false;
        let error: string | undefined;

        try {
          // Get the assertion cell via .key()
          const assertCell = testsCell.key(i).key("assertion") as Cell<unknown>;
          const value = assertCell.get();
          passed = value === true;
          if (!passed) {
            error = `Expected true, got ${JSON.stringify(value)}`;
          }
        } catch (err) {
          passed = false;
          error = `Error reading assertion: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }

        results.push({
          name: assertionName,
          passed,
          afterAction: lastActionIndex !== null
            ? `action_${actionCount}`
            : null,
          error,
          durationMs: performance.now() - itemStart,
        });

        if (options.verbose) {
          const status = passed ? "✓" : "✗";
          const suffix = lastActionIndex !== null
            ? ` (after action_${actionCount})`
            : "";
          console.log(`  ${status} ${assertionName}${suffix}`);
        }
      }
    }

    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
    };
  } catch (err) {
    let errorMessage = err instanceof Error ? err.message : String(err);

    // Add helpful hint for import resolution errors when --root wasn't provided
    if (
      errorMessage.includes("No such file or directory") &&
      errorMessage.includes("readfile") &&
      !options.root
    ) {
      errorMessage +=
        "\n    Hint: If the test imports from sibling directories (e.g., ../shared/), use --root to specify a common ancestor.";
    }

    return {
      path: testPath,
      results: [],
      totalDurationMs: performance.now() - startTime,
      error: errorMessage,
    };
  } finally {
    // 6. Cleanup
    sinkCancel?.();
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
    `\n${totalPassed} passed, ${totalFailed} failed (${
      Math.round(totalTime)
    }ms)`,
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
