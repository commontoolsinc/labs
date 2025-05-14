import { type DocImpl, getDoc } from "../doc.ts";
import { runtime } from "../runtime/index.ts";
import { type Action, idle } from "../scheduler.ts";
import { refer } from "merkle-reference";
import { type ReactivityLog } from "../scheduler.ts";
import { cancels, run, stop } from "../runner.ts";
import {
  BuiltInCompileAndRunParams,
  RecipeFactory,
} from "@commontools/builder";

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
  inputsDoc: DocImpl<BuiltInCompileAndRunParams<any>>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentDoc: DocImpl<any>,
): Action {
  const compiling = getDoc<boolean>(
    false,
    { compile: { compiling: cause } },
    parentDoc.space,
  );
  const result = getDoc<string | undefined>(
    undefined,
    { compile: { result: cause } },
    parentDoc.space,
  );
  const error = getDoc<string | undefined>(
    undefined,
    { compile: { error: cause } },
    parentDoc.space,
  );

  sendResult({ compiling, result, error });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { files, main } = inputsDoc.getAsQueryResult([], log) ?? {};
    const input = inputsDoc.asCell().withLog(log).key("input");

    const hash = refer({ files: JSON.stringify(files ?? {}), main: main ?? "" })
      .toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;
    previousCallHash = hash;

    if (cancels.has(result)) stop(result);
    result.setAtPath([], undefined, log);
    error.setAtPath([], undefined, log);

    // Undefined inputs => Undefined output, not pending
    if (!main || !files) {
      compiling.setAtPath([], false, log);
      return;
    }

    // Main file not found => Error, not pending
    if (!(main in files)) {
      error.setAtPath([], `"${main}" not found in files`, log);
      compiling.setAtPath([], false, log);
      return;
    }

    // Now we're sure that we have a new file to compile
    compiling.setAtPath([], true, log);

    const compilePromise = runtime.compile(files[main]).catch(
      (error) => {
        if (thisRun !== currentRun) return;
        error.setAtPath(
          [],
          error.message + (error.stack ? "\n" + error.stack : ""),
          log,
        );
      },
    ).finally(() => {
      if (thisRun !== currentRun) return;
      compiling.setAtPath([], false, log);
    });

    compilePromise.then((recipe) => {
      if (thisRun !== currentRun) return;
      console.log("got new compiled recipe for ", files[main]);
      if (recipe) run(recipe, input, result);
      // TODO(seefeld): Add capturing runtime errors.
    });
  };
}
