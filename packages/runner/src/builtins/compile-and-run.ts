/**
 * compileAndRun builtin - Compile TypeScript patterns and run them dynamically.
 *
 * ## Compilation Caching
 *
 * This module maintains an in-memory LRU cache of compiled recipes to avoid
 * redundant TypeScript compilation. Key features:
 *
 * - **Cache key**: Content hash of program files (via merkle-reference)
 * - **LRU eviction**: Max 1000 entries to bound memory on long-running servers
 * - **Single-flight**: Concurrent requests for the same code share one compilation
 * - **No negative caching**: Failed compilations are not cached (allows retry)
 *
 * ## Performance Characteristics
 *
 * - First compilation: 100-300ms (full TypeScript compilation)
 * - Cache hit: <1ms (instant return)
 * - Single-flight hit: Same as first compilation (waits on shared promise)
 *
 * ## Monitoring
 *
 * Use `getCompilationStats()` to monitor cache effectiveness. These functions
 * are exported from the builtins index for debugging purposes:
 * ```ts
 * // Internal debugging only - not part of public API
 * import { getCompilationStats } from "./builtins/index.ts";
 * console.log(getCompilationStats());
 * // { cacheHits: 45, cacheMisses: 3, cacheEvictions: 0, cacheSize: 3, hitRate: "93.8%" }
 * ```
 *
 * ## Usage with fetchProgram
 *
 * This builtin is typically used with `fetchProgram` for lazy-loading patterns:
 * ```ts
 * const { result: program } = fetchProgram({ url: "./my-pattern.tsx" });
 * const { result, error } = compileAndRun({
 *   files: program?.files ?? [],
 *   main: program?.main ?? "",
 *   input: { someArg: 42 },
 * });
 * ```
 *
 * @module
 */

import { type BuiltInCompileAndRunParams } from "commontools";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Program } from "@commontools/js-compiler";
import { CompilerError } from "@commontools/js-compiler/typescript";
import { Recipe } from "../builder/types.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("compile-and-run");

// -----------------------------------------------------------------------------
// Compilation Cache (LRU)
// -----------------------------------------------------------------------------
// Caches compiled Recipe objects by content hash to avoid redundant compilation.
// Uses LRU eviction to bound memory usage on long-running servers like
// background-charm-service.
// -----------------------------------------------------------------------------

/** Maximum number of compiled recipes to cache. */
const MAX_CACHE_SIZE = 1000;

/** In-memory compilation cache keyed by content hash. */
const compilationCache = new Map<string, Recipe>();

/** Tracks in-progress compilations for single-flight deduplication. */
const inProgressCompilations = new Map<string, Promise<Recipe>>();

// Performance counters
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;

/** Add to cache with LRU eviction. */
function cacheSet(hash: string, recipe: Recipe) {
  // Delete first to update insertion order (Map maintains insertion order)
  if (compilationCache.has(hash)) {
    compilationCache.delete(hash);
  }
  compilationCache.set(hash, recipe);

  // Evict oldest entries if over limit
  while (compilationCache.size > MAX_CACHE_SIZE) {
    const oldestKey = compilationCache.keys().next().value;
    if (oldestKey) {
      compilationCache.delete(oldestKey);
      cacheEvictions++;
    }
  }
}

/** Get from cache and refresh LRU position. */
function cacheGet(hash: string): Recipe | undefined {
  const recipe = compilationCache.get(hash);
  if (recipe) {
    // Move to end (most recently used) by re-inserting
    compilationCache.delete(hash);
    compilationCache.set(hash, recipe);
  }
  return recipe;
}

/**
 * Get compilation cache statistics for monitoring.
 *
 * @returns Object with cache metrics including hit rate
 */
export function getCompilationStats() {
  return {
    cacheHits,
    cacheMisses,
    cacheEvictions,
    cacheSize: compilationCache.size,
    maxCacheSize: MAX_CACHE_SIZE,
    hitRate: cacheHits + cacheMisses > 0
      ? (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1) + "%"
      : "N/A",
  };
}

/**
 * Clear the compilation cache. Useful for testing or forcing recompilation.
 */
export function clearCompilationCache() {
  compilationCache.clear();
  inProgressCompilations.clear();
  cacheHits = 0;
  cacheMisses = 0;
  cacheEvictions = 0;
}

/**
 * Compile a recipe/module and run it.
 *
 * @param files - Map of `{ filename: string }` to source code.
 * @param main - The name of the main recipe to run.
 * @param input - Inputs passed to the recipe once compiled.
 *
 * @returns { result?: any, error?: string, errors?: Array<{line: number, column: number, message: string, type: string, file?: string}>, pending: boolean }
 *   - `result` is the result of the recipe, or undefined.
 *   - `error` error string that occurred during compilation or execution, or
 *     undefined.
 *   - `errors` structured error array with line/column/file information for
 *     compilation errors.
 *   - `pending` is true if the recipe is still being compiled.
 *
 * Note that if an error occurs during execution, both `result` and `error` can
 * be defined. (Note: Runtime errors are not currently handled).
 */
export function compileAndRun(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<string | undefined>;
  let error: Cell<string | undefined>;
  let errors: Cell<
    | Array<
      {
        line: number;
        column: number;
        message: string;
        type: string;
        file?: string;
      }
    >
    | undefined
  >;

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    // Abort any in-flight compilation if it's still pending.
    abortController?.abort("Recipe stopped");
  });

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell<boolean>(
        parentCell.space,
        { compile: { pending: cause } },
        undefined,
        tx,
      );
      pending.send(false);

      result = runtime.getCell<string | undefined>(
        parentCell.space,
        { compile: { result: cause } },
        undefined,
        tx,
      );

      error = runtime.getCell<string | undefined>(
        parentCell.space,
        { compile: { error: cause } },
        undefined,
        tx,
      );

      errors = runtime.getCell<
        | Array<
          {
            line: number;
            column: number;
            message: string;
            type: string;
            file?: string;
          }
        >
        | undefined
      >(
        parentCell.space,
        { compile: { errors: cause } },
        undefined,
        tx,
      );

      sendResult(tx, { pending, result, error, errors });
      cellsInitialized = true;
    }

    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);
    const errorsWithLog = errors.withTx(tx);

    // TODO(seefeld): Ideally, this cell already has this schema, because we set
    // it on the node itself.
    const program: Program = inputsCell.asSchema({
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              contents: { type: "string" },
            },
            required: ["name", "contents"],
          },
          default: [],
        },
        main: { type: "string", default: "" },
      },
      required: ["files", "main"],
    }).withTx(tx).get();
    const input = inputsCell.withTx(tx).key("input");

    const hash = refer(program ?? { files: [], main: "" }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;

    // Check if inputs are undefined/empty (e.g., during rehydration before cells load)
    const hasValidInputs = program.main && program.files &&
      program.files.length > 0;

    // Special case: if inputs are invalid AND this is the hash for empty inputs,
    // the user intentionally cleared them - proceed to clear outputs
    const emptyInputsHash = refer({ files: [], main: "" }).toString();
    const isIntentionallyEmpty = !hasValidInputs && hash === emptyInputsHash;

    // If we have a previous valid result and inputs are currently invalid (likely rehydrating),
    // don't clear the outputs - just wait for real inputs to load
    // BUT if inputs are intentionally empty, we should clear
    if (
      !hasValidInputs && previousCallHash && previousCallHash !== hash &&
      !isIntentionallyEmpty
    ) {
      // Don't update previousCallHash - we'll wait for valid inputs
      return;
    }

    previousCallHash = hash;

    // Abort any in-flight compilation before starting a new one
    abortController?.abort("New compilation started");
    abortController = new AbortController();
    requestId = crypto.randomUUID();

    runtime.runner.stop(result);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    errorsWithLog.set(undefined);

    // Undefined inputs => Undefined output, not pending
    if (!hasValidInputs) {
      pendingWithLog.set(false);
      return;
    }

    // Main file not found => Error, not pending
    if (!program.files.some((file) => file?.name === program.main)) {
      errorWithLog.set(`"${program.main}" not found in files`);
      pendingWithLog.set(false);
      return;
    }

    // Now we're sure that we have a new file to compile
    pendingWithLog.set(true);

    // Capture requestId for this compilation run
    const thisRequestId = requestId;

    // Check compilation cache first (LRU)
    const cachedRecipe = cacheGet(hash);
    let compilePromise: Promise<Recipe | undefined>;

    if (cachedRecipe) {
      // Cache hit - use cached recipe
      cacheHits++;
      logger.debug("compile-and-run", `Cache HIT for ${program.main}`);
      compilePromise = Promise.resolve(cachedRecipe);
    } else if (inProgressCompilations.has(hash)) {
      // Single-flight: reuse in-progress compilation (avoid duplicate work)
      cacheHits++;
      logger.debug(
        "compile-and-run",
        `Reusing in-flight compilation for ${program.main}`,
      );
      compilePromise = inProgressCompilations.get(hash)!;
    } else {
      // Cache miss - compile and cache
      cacheMisses++;
      const startTime = performance.now();

      const actualCompilePromise = runtime.harness.run(program)
        .then((recipe) => {
          const elapsed = performance.now() - startTime;
          logger.info(
            "compile-and-run",
            `Compiled ${program.main} in ${elapsed.toFixed(0)}ms`,
          );
          // Cache the successful result (LRU)
          cacheSet(hash, recipe);
          return recipe;
        })
        .finally(() => {
          inProgressCompilations.delete(hash);
        });

      inProgressCompilations.set(hash, actualCompilePromise);
      compilePromise = actualCompilePromise;
    }

    compilePromise.catch(
      (err) => {
        // Only process this error if the request hasn't been superseded
        if (requestId !== thisRequestId) return;
        if (abortController?.signal.aborted) return;

        runtime.editWithRetry((asyncTx) => {
          // Extract structured errors if this is a CompilerError
          if (err instanceof CompilerError) {
            const structuredErrors = err.errors.map((e) => ({
              line: e.line ?? 1,
              column: e.column ?? 1,
              message: e.message,
              type: e.type,
              file: e.file,
            }));
            errors.withTx(asyncTx).set(structuredErrors);
          } else {
            error.withTx(asyncTx).set(
              err.message + (err.stack ? "\n" + err.stack : ""),
            );
          }
        });
      },
    ).finally(() => {
      // Only update pending if this is still the current request
      if (requestId !== thisRequestId) return;
      // Always clear pending state, even if cancelled, to avoid stuck state

      runtime.editWithRetry((asyncTx) => {
        pending.withTx(asyncTx).set(false);
      });
    });

    compilePromise.then((recipe) => {
      // Only run the result if this is still the current request
      if (requestId !== thisRequestId) return;
      if (abortController?.signal.aborted) return;

      if (recipe) {
        // TODO(ja): to support editting of existing charms / running with
        // inputs from other charms, we will need to think more about
        // how we pass input into the builtin.

        runtime.runSynced(result, recipe, input.get());
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}
