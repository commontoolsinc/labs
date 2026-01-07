/**
 * Test harness for CommonTools patterns.
 *
 * Provides a lightweight runtime environment for testing pattern logic
 * (computeds, handlers, reactivity) without deploying full charms.
 */

import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import type { Cell } from "@commontools/runner";
import type { Recipe } from "@commontools/runner";
import { join, isAbsolute } from "@std/path";

/**
 * Create a TestCell wrapper around a Cell that handles transactions automatically.
 */
function createTestCell<T>(
  cell: Cell<T>,
  runtime: Runtime,
): TestCell<T> {
  return {
    async set(value: T): Promise<void> {
      const tx = runtime.edit();
      cell.withTx(tx).set(value);
      await tx.commit();
    },
    get(): T {
      return cell.get();
    },
    get cell(): Cell<T> {
      return cell;
    },
  };
}

/**
 * A test cell that wraps a Cell and handles transaction management automatically.
 * In tests, you can call .set(value) without worrying about transactions.
 */
export interface TestCell<T> {
  /**
   * Set the cell value. Creates a transaction, sets the value, and commits.
   * @param value - The new value to set
   */
  set(value: T): Promise<void>;

  /**
   * Get the current cell value.
   */
  get(): T;

  /**
   * Access the underlying Cell for advanced use cases.
   */
  readonly cell: Cell<T>;
}

/**
 * Result of loading a pattern into the test harness.
 */
export interface LoadPatternResult<Input, Output> {
  /**
   * The instantiated pattern with access to its result.
   * Use pattern.result to access computed values and handler streams.
   */
  pattern: {
    result: Output;
    /** The underlying result cell */
    cell: Cell<Output>;
  };
  /**
   * Direct access to the input cells for mutation during tests.
   * Use cells.foo.set(value) to change inputs and trigger reactivity.
   * These are TestCells that handle transactions automatically.
   */
  cells: { [K in keyof Input]: TestCell<Input[K]> };
}

/**
 * Test harness for pattern testing.
 */
export interface TestHarness {
  /**
   * Load and instantiate a pattern with initial state.
   *
   * @param patternPath - Path to the pattern file (relative or absolute)
   * @param initialState - Initial values for the pattern's input cells
   * @returns The instantiated pattern and its input cells
   *
   * @example
   * ```typescript
   * const { pattern, cells } = await harness.loadPattern("./counter.tsx", {
   *   value: 0,
   * });
   * ```
   */
  loadPattern<Input, Output = unknown>(
    patternPath: string,
    initialState: Partial<Input>,
  ): Promise<LoadPatternResult<Input, Output>>;

  /**
   * Wait for all pending scheduler actions to complete.
   * Call this after .send() or cell mutations to let reactivity settle.
   *
   * @example
   * ```typescript
   * cells.value.set(42);
   * await harness.idle();
   * expect(pattern.result.doubled).toBe(84);
   * ```
   */
  idle(): Promise<void>;

  /**
   * Subscribe to cell changes for reactivity testing.
   *
   * @param cell - The cell to observe
   * @param callback - Called whenever the cell value changes
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const values: number[] = [];
   * const unsubscribe = harness.subscribe(cells.count, (v) => values.push(v));
   * // ... trigger changes ...
   * unsubscribe();
   * expect(values).toEqual([0, 1, 2]);
   * ```
   */
  subscribe<T>(cell: Cell<T>, callback: (value: T) => void): () => void;

  /**
   * Clean up runtime resources.
   * Always call this in afterEach() to prevent resource leaks.
   */
  dispose(): Promise<void>;

  /**
   * Access to the underlying runtime (escape hatch for advanced use cases).
   */
  runtime: Runtime;

  /**
   * Access to the underlying engine (escape hatch for advanced use cases).
   */
  engine: Engine;

  /**
   * The identity used for this test harness.
   */
  identity: Identity;

  /**
   * The space (DID) used for this test harness.
   */
  space: string;
}

/**
 * Options for creating a test harness.
 */
export interface TestHarnessOptions {
  /**
   * Identity to use for the test harness.
   * If not provided, a deterministic identity is generated from "pattern-test".
   */
  identity?: Identity;

  /**
   * Whether to validate cell values against schemas.
   * Default: false (opt-in for performance)
   */
  validateSchemas?: boolean;
}

/**
 * Create a new test harness for pattern testing.
 *
 * Each harness has its own isolated runtime with in-memory storage.
 * Create a fresh harness for each test to ensure isolation.
 *
 * @example
 * ```typescript
 * import { createTestHarness } from "@commontools/pattern-testing";
 *
 * describe("my pattern", () => {
 *   let harness: TestHarness;
 *
 *   beforeEach(async () => {
 *     harness = await createTestHarness();
 *   });
 *
 *   afterEach(async () => {
 *     await harness.dispose();
 *   });
 *
 *   it("works", async () => {
 *     const { pattern, cells } = await harness.loadPattern("./my-pattern.tsx", {});
 *     // ... test ...
 *   });
 * });
 * ```
 */
export async function createTestHarness(
  options: TestHarnessOptions = {},
): Promise<TestHarness> {
  // Create or use provided identity
  const identity = options.identity ??
    await Identity.fromPassphrase("pattern-test");
  const space = identity.did();

  // Create in-memory storage (no I/O, instant, isolated)
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({ as: identity });

  // Create runtime
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  // Create engine for compiling patterns
  const engine = new Engine(runtime);

  // Track loaded pattern cells for cleanup
  const loadedCells: Cell<unknown>[] = [];

  const harness: TestHarness = {
    async loadPattern<Input, Output = unknown>(
      patternPath: string,
      initialState: Partial<Input>,
    ): Promise<LoadPatternResult<Input, Output>> {
      // Resolve path - if relative, resolve from cwd
      const resolvedPath = isAbsolute(patternPath)
        ? patternPath
        : join(Deno.cwd(), patternPath);

      // Compile the pattern
      const program = await engine.resolve(
        new FileSystemProgramResolver(resolvedPath),
      );
      const { main } = await engine.process(program, {
        noCheck: false,
        noRun: false,
      });

      if (!main?.default) {
        throw new Error(
          `Pattern at ${patternPath} does not have a default export`,
        );
      }

      const patternFactory = main.default as Recipe;

      // Create a transaction for setting up cells
      const tx = runtime.edit();

      // Create input cells with initial state
      const cells: Record<string, Cell<unknown>> = {};
      for (const [key, value] of Object.entries(initialState)) {
        const cell = runtime.getCell(
          space,
          `test-${key}-${Date.now()}-${Math.random()}`,
          undefined,
          tx,
        );
        cell.set(value);
        cells[key] = cell;
        loadedCells.push(cell);
      }

      // Create result cell
      const resultCell = runtime.getCell<Output>(
        space,
        `test-result-${Date.now()}-${Math.random()}`,
        undefined,
        tx,
      );
      loadedCells.push(resultCell);

      // Run the pattern
      const result = runtime.run(tx, patternFactory, cells, resultCell);

      // Commit the transaction
      await tx.commit();

      // Wait for initial computation
      await runtime.idle();

      // Create a sink to keep the pattern reactive
      const _sinkCancel = result.sink(() => {});

      // Wrap cells in TestCells for easy mutation
      const testCells: Record<string, TestCell<unknown>> = {};
      for (const [key, cell] of Object.entries(cells)) {
        testCells[key] = createTestCell(cell, runtime);
      }

      return {
        pattern: {
          result: result.getAsQueryResult() as Output,
          cell: result,
        },
        cells: testCells as { [K in keyof Input]: TestCell<Input[K]> },
      };
    },

    async idle(): Promise<void> {
      await runtime.idle();
    },

    subscribe<T>(cell: Cell<T>, callback: (value: T) => void): () => void {
      return cell.sink(callback);
    },

    async dispose(): Promise<void> {
      await runtime.dispose();
      await storageManager.close();
    },

    runtime,
    engine,
    identity,
    space,
  };

  return harness;
}
