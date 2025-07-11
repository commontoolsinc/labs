import { type BuiltInCompileAndRunParams } from "commontools";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { Program } from "@commontools/js-runtime";
import { CompilerError } from "@commontools/js-runtime/typescript";

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
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  const pending = runtime.getCell<boolean>(
    parentCell.space,
    { compile: { pending: cause } },
  );
  pending.send(false);

  const result = runtime.getCell<string | undefined>(
    parentCell.space,
    { compile: { result: cause } },
  );

  const error = runtime.getCell<string | undefined>(
    parentCell.space,
    { compile: { error: cause } },
  );

  const errors = runtime.getCell<
    | Array<{ line: number; column: number; message: string; type: string; file?: string }>
    | undefined
  >(
    parentCell.space,
    { compile: { errors: cause } },
  );

  sendResult({ pending, result, error, errors });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withLog(log);
    const resultWithLog = result.withLog(log);
    const errorWithLog = error.withLog(log);
    const errorsWithLog = errors.withLog(log);

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
            additionalProperties: false,
          },
        },
        main: { type: "string" },
      },
      required: ["files", "main"],
      additionalProperties: false,
    }).withLog(log).get();
    const input = inputsCell.withLog(log).key("input");

    const hash = refer(program ?? { files: [], main: "" }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;
    previousCallHash = hash;

    runtime.runner.stop(result);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    errorsWithLog.set(undefined);

    // Undefined inputs => Undefined output, not pending
    if (!program.main || !program.files) {
      pendingWithLog.set(false);
      return;
    }

    // Main file not found => Error, not pending
    if (!program.files.some((file) => file.name === program.main)) {
      errorWithLog.set(`"${program.main}" not found in files`);
      pendingWithLog.set(false);
      return;
    }

    // Now we're sure that we have a new file to compile
    pendingWithLog.set(true);

    const compilePromise = runtime.harness.run(program)
      .catch(
        (err) => {
          if (thisRun !== currentRun) return;
          errorWithLog.set(
            err.message + (err.stack ? "\n" + err.stack : ""),
          );

          // Extract structured errors if this is a CompilerError
          if (err instanceof CompilerError) {
            const structuredErrors = err.errors.map((e) => ({
              line: e.line ?? 1,
              column: e.column ?? 1,
              message: e.message,
              type: e.type,
              file: e.file,
            }));
            errorsWithLog.set(structuredErrors);
          }
        },
      ).finally(() => {
        if (thisRun !== currentRun) return;
        pendingWithLog.set(false);
      });

    compilePromise.then(async (recipe) => {
      if (thisRun !== currentRun) return;
      if (recipe) {
        // TODO(ja): to support editting of existing charms / running with
        // inputs from other charms, we will need to think more about
        // how we pass input into the builtin.
        await runtime.runSynced(result, recipe, input.get());
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}
