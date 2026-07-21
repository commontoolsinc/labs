import type {
  BuiltInCompileAndRunParams,
  CompileDiagnostic,
  CompileError,
} from "commonfabric";
import {
  DataUnavailable,
  type DataUnavailableVariant,
} from "@commonfabric/data-model/fabric-instances";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Program } from "@commonfabric/js-compiler";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { CellScope } from "../builder/types.ts";
import { resolvedCellScope, scopedCell } from "./scope-policy.ts";
import { narrowestScope } from "../scope.ts";
import { selectUnavailableInput } from "../data-unavailability.ts";

class CompileAndRunError extends Error implements CompileError {
  override readonly name = "CompileError";

  constructor(
    message: string,
    readonly diagnostics: readonly CompileDiagnostic[] = [],
  ) {
    super(message);
  }
}

function compileUnavailable(
  message: string,
  diagnostics: readonly CompileDiagnostic[] = [],
): DataUnavailableVariant {
  return DataUnavailable.error(new CompileAndRunError(message, diagnostics));
}

function markerIsPending(marker: DataUnavailableVariant): boolean {
  return marker.reason === "pending" || marker.reason === "syncing";
}

function markerErrorMessage(
  marker: DataUnavailableVariant,
): string | undefined {
  return marker.reason === "error" ? marker.error.message : undefined;
}

/**
 * Compile a pattern/module and run it.
 *
 * @param files - Map of `{ filename: string }` to source code.
 * @param main - The name of the main pattern to run.
 * @param input - Inputs passed to the pattern once compiled.
 *
 * @returns { result?: any, error?: string, errors?: Array<{line: number, column: number, message: string, type: string, file?: string}>, pending: boolean }
 *   - `result` is the result of the pattern, or undefined.
 *   - `error` error string that occurred during compilation or execution, or
 *     undefined.
 *   - `errors` structured error array with line/column/file information for
 *     compilation errors.
 *   - `pending` is true if the pattern is still being compiled.
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
  let result: Cell<unknown>;
  let error: Cell<string | undefined>;
  let errors: Cell<CompileDiagnostic[] | undefined>;
  let cellScope: CellScope | undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort any in-flight compilation if it's still pending.
    abortController?.abort("Pattern stopped");
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const rawInputs = inputsCell.withTx(tx).getRaw();
    const unavailableInput = selectUnavailableInput(rawInputs, {
      runtime,
      tx,
      base: inputsCell,
    });

    // TODO(seefeld): Ideally, this cell already has this schema, because we set
    // it on the node itself.
    const program = unavailableInput === undefined
      ? inputsCell.asSchema({
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
      }).withTx(tx).get() as Program | undefined
      : undefined;
    const input = inputsCell.withTx(tx).key("input");
    const outputScope = narrowestScope([
      tx.getNarrowestReadScope(),
      resolvedCellScope(runtime, tx, input),
    ]);

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
      }
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { compile: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);
      pending.send(false);

      const baseResult = runtime.getCell<unknown>(
        parentCell.space,
        { compile: { result: cause } },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      const baseError = runtime.getCell<string | undefined>(
        parentCell.space,
        { compile: { error: cause } },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      const baseErrors = runtime.getCell<CompileDiagnostic[] | undefined>(
        parentCell.space,
        { compile: { errors: cause } },
        undefined,
        tx,
      );
      errors = scopedCell(runtime, tx, baseErrors, outputScope);

      sendResult(tx, { pending, result, error, errors });
      cellsInitialized = true;
      cellScope = outputScope;
    }

    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);
    const errorsWithLog = errors.withTx(tx);

    // Concrete input values do not require recompilation, but availability
    // transitions do. Include the controlling marker so an unavailable input
    // can settle back into the same source program.
    const hash = hashOf({
      program: program ?? null,
      unavailable: unavailableInput ?? null,
    }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;

    previousCallHash = hash;

    // Abort any in-flight compilation before starting a new one
    abortController?.abort("New compilation started");
    abortController = undefined;
    requestId = crypto.randomUUID();

    runtime.runner.stop(result);
    errorWithLog.set(undefined);
    errorsWithLog.set(undefined);

    if (unavailableInput !== undefined) {
      resultWithLog.setRawUntyped(unavailableInput, true);
      pendingWithLog.set(markerIsPending(unavailableInput));
      errorWithLog.set(markerErrorMessage(unavailableInput));
      return;
    }

    const hasValidInputs = program?.main && program.files &&
      program.files.length > 0;
    if (!hasValidInputs || program === undefined) {
      resultWithLog.setRawUntyped(DataUnavailable.schemaMismatch(), true);
      pendingWithLog.set(false);
      return;
    }

    // Main file not found => Error, not pending
    if (!program.files.some((file) => file?.name === program.main)) {
      const message = `"${program.main}" not found in files`;
      resultWithLog.setRawUntyped(compileUnavailable(message), true);
      errorWithLog.set(message);
      pendingWithLog.set(false);
      return;
    }

    // Now we're sure that we have a new file to compile
    resultWithLog.setRawUntyped(DataUnavailable.pending(), true);
    pendingWithLog.set(true);
    abortController = new AbortController();

    // Capture requestId for this compilation run
    const thisRequestId = requestId;

    const compilePromise = runtime.patternManager
      .compileOrGetPattern(program, parentCell.space)
      .catch(
        (err) => {
          // Only process this error if the request hasn't been superseded
          if (requestId !== thisRequestId) return;
          if (abortController?.signal.aborted) return;

          runtime.editWithRetry((asyncTx) => {
            if (requestId !== thisRequestId) return;
            if (abortController?.signal.aborted) return;

            // Extract structured errors if this is a CompilerError
            if (err instanceof CompilerError) {
              const structuredErrors: CompileDiagnostic[] = err.errors.map(
                (e) => ({
                  line: e.line ?? 1,
                  column: e.column ?? 1,
                  message: e.message,
                  type: e.type,
                  file: e.file,
                }),
              );
              errors.withTx(asyncTx).set(structuredErrors);
              result.withTx(asyncTx).setRawUntyped(
                compileUnavailable(err.message, structuredErrors),
                true,
              );
            } else {
              const message = err instanceof Error
                ? err.message + (err.stack ? "\n" + err.stack : "")
                : String(err);
              error.withTx(asyncTx).set(message);
              result.withTx(asyncTx).setRawUntyped(
                compileUnavailable(message),
                true,
              );
            }
          });
        },
      ).finally(() => {
        // Only update pending if this is still the current request
        if (requestId !== thisRequestId) return;
        // Always clear pending state, even if cancelled, to avoid stuck state

        runtime.editWithRetry((asyncTx) => {
          if (requestId !== thisRequestId) return;
          pending.withTx(asyncTx).set(false);
        });
      });

    compilePromise.then((pattern) => {
      // Only run the result if this is still the current request
      if (requestId !== thisRequestId) return;
      if (abortController?.signal.aborted) return;

      if (pattern) {
        // TODO(ja): to support editting of existing pieces / running with
        // inputs from other pieces, we will need to think more about
        // how we pass input into the builtin.

        runtime.runSynced(result, pattern, input.get());
        runtime.editWithRetry((asyncTx) => {
          result.withTx(asyncTx).key("isHidden").set(true);
        });
        runtime.pieceCreatedCallback?.(result);
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}

/** Direct-result module ref used by newly compiled graphs. */
export function compileAndRunResult(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return compileAndRun(
    inputsCell,
    (tx, state) => sendResult(tx, state.result),
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}
