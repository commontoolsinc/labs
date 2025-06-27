import { BuiltInCompileAndRunParams } from "@commontools/api";
import { refer } from "merkle-reference";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type ReactivityLog } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";

/**
 * Compile a recipe/module and run it.
 *
 * @param files - Map of `{ filename: string }` to source code.
 * @param main - The name of the main recipe to run.
 * @param input - Inputs passed to the recipe once compiled.
 *
 * @returns { result?: any, error?: string, compiling: boolean }
 *   - `result` is the result of the recipe, or undefined.
 *   - `error` error that occurred during compilation or execution, or
 *     undefined.
 *   - `compiling` is true if the recipe is still being compiled.
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
  const compiling = runtime.getCell<boolean>(
    parentCell.getDoc().space,
    { compile: { compiling: cause } },
  );
  compiling.send(false);
  
  const result = runtime.getCell<string | undefined>(
    parentCell.getDoc().space,
    { compile: { result: cause } },
  );
  
  const error = runtime.getCell<string | undefined>(
    parentCell.getDoc().space,
    { compile: { error: cause } },
  );

  sendResult({ compiling, result, error });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;
    const compilingWithLog = compiling.withLog(log);
    const resultWithLog = result.withLog(log);
    const errorWithLog = error.withLog(log);

    const { files, main } = inputsCell.getAsQueryResult([], log) ?? {};
    const input = inputsCell.withLog(log).key("input");

    const hash = refer({ files: JSON.stringify(files ?? {}), main: main ?? "" })
      .toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;
    previousCallHash = hash;

    runtime.runner.stop(result);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);

    // Undefined inputs => Undefined output, not pending
    if (!main || !files) {
      compilingWithLog.set(false);
      return;
    }

    // Main file not found => Error, not pending
    if (!(main in files)) {
      errorWithLog.set(`"${main}" not found in files`);
      compilingWithLog.set(false);
      return;
    }

    // Now we're sure that we have a new file to compile
    compilingWithLog.set(true);

    const compilePromise = runtime.harness.run(
      files[main],
    )
      .catch(
        (err) => {
          if (thisRun !== currentRun) return;
          errorWithLog.set(
            err.message + (err.stack ? "\n" + err.stack : ""),
          );
        },
      ).finally(() => {
        if (thisRun !== currentRun) return;
        compilingWithLog.set(false);
      });

    compilePromise.then(async (recipe) => {
      if (thisRun !== currentRun) return;
      if (recipe) {
        await runtime.runSynced(result, recipe, input);
      }
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}
