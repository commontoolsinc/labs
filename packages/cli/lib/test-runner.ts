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
import type {
  Cell,
  ErrorWithContext,
  Pattern,
  Stream,
} from "@commontools/runner";
import type { OpaqueRef } from "@commontools/api";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { basename } from "@std/path";
import { timeout } from "@commontools/utils/sleep";
import { experimentalOptionsFromEnv } from "./utils.ts";

/**
 * A test step is an object with either an 'assertion' or 'action' property.
 * This discriminated union avoids TypeScript trying to unify incompatible Cell/Stream types.
 * Add `skip: true` to temporarily disable a step (like it.skip in other frameworks).
 */
export type TestStep =
  | { assertion: OpaqueRef<boolean>; skip?: boolean }
  | { action: Stream<void>; skip?: boolean };

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  afterAction: string | null;
  error?: string;
  durationMs: number;
}

export interface NavigationEvent {
  /** Name ($NAME) of the navigation target, if available */
  name?: string;
  /** Index of the action that triggered this navigation */
  afterActionIndex: number;
}

export interface TestRunResult {
  path: string;
  results: TestResult[];
  totalDurationMs: number;
  error?: string;
  /** Navigation events recorded during the test run */
  navigations: NavigationEvent[];
  /** Runtime errors captured via errorHandlers during the test run */
  runtimeErrors: string[];
  /** If true, runtime errors are expected and should not fail the test */
  allowRuntimeErrors?: boolean;
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
  const TIMEOUT = options.timeout ?? 60000;
  const startTime = performance.now();

  // Collect runtime errors via the scheduler's error handler
  const runtimeErrors: ErrorWithContext[] = [];

  // 1. Create emulated runtime (same as piece step)
  const identity = await Identity.fromPassphrase("test-runner");
  const space = identity.did();
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({ as: identity });

  // Track navigation events for assertions and verbose output
  const navigations: NavigationEvent[] = [];
  let currentActionIndex = -1;

  const runtime = new Runtime({
    storageManager,
    experimental: experimentalOptionsFromEnv(),
    apiUrl: new URL(import.meta.url),
    errorHandlers: [(error: ErrorWithContext) => runtimeErrors.push(error)],
    navigateCallback: (target) => {
      const name = (target.key("$NAME") as Cell<string | undefined>).get();
      navigations.push({
        name,
        afterActionIndex: currentActionIndex,
      });
      if (options.verbose) {
        const label = typeof name === "string" ? name : "(unnamed)";
        console.log(`    → navigateTo: ${label}`);
      }
    },
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

    const testPatternFactory = main.default as Pattern;

    if (typeof testPatternFactory !== "function") {
      throw new Error(
        `Test pattern must export a pattern function as default, got ${typeof testPatternFactory}`,
      );
    }

    // 3. Set up defaultPattern so wish({ query: "#default" }) resolves.
    // In production, default-app.tsx provides this. The test harness must
    // create a minimal equivalent so patterns that use wish("#default") to
    // access allPieces, recentPieces, etc. work correctly.
    {
      const setupTx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, setupTx);
      const defaultPatternCell = runtime.getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      (defaultPatternCell as any).key("allPieces").set([]);
      (defaultPatternCell as any).key("recentPieces").set([]);
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      await setupTx.commit();
      await runtime.idle();
    }

    // 4. Instantiate the test pattern using runtime.run() for proper space context
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
    // Also wait for all in-flight storage subscriptions to settle.
    // replica.poll() fires without await during mount(), so subscription
    // updates can arrive after idle() resolves, scheduling more work.
    await storageManager.synced();
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

    // Check for allowRuntimeErrors flag
    const allowRuntimeErrors =
      (patternResult.key("allowRuntimeErrors") as Cell<unknown>).get() === true;

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
        skip?: boolean;
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

      // Handle skipped steps
      if (stepValue.skip) {
        if (isAction) {
          actionCount++;
          const actionName = `action_${actionCount}`;
          if (options.verbose) {
            console.log(`  ⊘ ${actionName} (skipped)`);
          }
        } else {
          assertionCount++;
          const assertionName = `assertion_${assertionCount}`;
          const suffix = lastActionIndex !== null
            ? ` (after action_${actionCount})`
            : "";
          results.push({
            name: assertionName,
            passed: true,
            skipped: true,
            afterAction: lastActionIndex !== null
              ? `action_${actionCount}`
              : null,
            durationMs: 0,
          });
          if (options.verbose) {
            console.log(`  ⊘ ${assertionName}${suffix} (skipped)`);
          }
        }
        continue;
      }

      if (isAction) {
        // It's an action - invoke it
        actionCount++;
        lastActionIndex = i;
        currentActionIndex = i;
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

    const errorMessages = runtimeErrors.map((e) => String(e));
    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      allowRuntimeErrors,
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

    const errorMessages = runtimeErrors.map((e) => String(e));
    return {
      path: testPath,
      results: [],
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
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
): Promise<{
  passed: number;
  failed: number;
  skipped: number;
  results: TestRunResult[];
}> {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const allResults: TestRunResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const testPath of paths) {
    console.log(`\n${basename(testPath)}`);

    const result = await runTestPattern(testPath, options);
    allResults.push(result);

    if (result.error) {
      console.log(`  ✗ Error: ${result.error}`);
      totalFailed++;
    } else {
      for (const test of result.results) {
        if (test.skipped) {
          totalSkipped++;
        } else if (test.passed) {
          totalPassed++;
        } else {
          totalFailed++;
        }

        const status = test.skipped ? "⊘" : test.passed ? "✓" : "✗";
        const suffix = test.afterAction ? ` (after ${test.afterAction})` : "";
        const skipLabel = test.skipped ? " (skipped)" : "";
        console.log(`  ${status} ${test.name}${suffix}${skipLabel}`);
        if (!test.passed && !test.skipped && test.error) {
          console.log(`    ${test.error}`);
        }
      }

      // Print navigation summary if any navigations occurred
      if (result.navigations.length > 0) {
        console.log(
          `  📍 ${result.navigations.length} navigation(s): ${
            result.navigations
              .map((n) => n.name ?? "(unnamed)")
              .join(", ")
          }`,
        );
      }

      // Report runtime errors
      if (result.runtimeErrors.length > 0) {
        if (result.allowRuntimeErrors) {
          console.log(
            `  ⊘ ${result.runtimeErrors.length} runtime error(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.runtimeErrors.length} runtime error(s) during test:`,
          );
          for (const msg of result.runtimeErrors) {
            // Show first line of each error, truncated
            const firstLine = msg.split("\n")[0];
            const truncated = firstLine.length > 120
              ? firstLine.slice(0, 120) + "..."
              : firstLine;
            console.log(`    ${truncated}`);
          }
        }
      }
    }
  }

  // Summary
  const totalTime = allResults.reduce((sum, r) => sum + r.totalDurationMs, 0);
  const parts = [`${totalPassed} passed`, `${totalFailed} failed`];
  if (totalSkipped > 0) {
    parts.push(`${totalSkipped} skipped`);
  }
  console.log(`\n${parts.join(", ")} (${Math.round(totalTime)}ms)`);

  return {
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    results: allResults,
  };
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
