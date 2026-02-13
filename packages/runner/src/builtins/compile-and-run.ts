import { type BuiltInCompileAndRunParams } from "commontools";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Program } from "@commontools/js-compiler";
import { CompilerError } from "@commontools/js-compiler/typescript";

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
    const hasValidInputs = program && program.main && program.files &&
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

    const compilePromise = runtime.recipeManager.compileOrGetRecipe(program)
      .catch(
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
        // TODO(ja): to support editting of existing pieces / running with
        // inputs from other pieces, we will need to think more about
        // how we pass input into the builtin.

        runtime.runSynced(result, recipe, input.get());
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}
