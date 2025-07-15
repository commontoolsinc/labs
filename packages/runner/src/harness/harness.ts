import { type Recipe } from "../builder/types.ts";
import type { Program, ProgramResolver } from "@commontools/js-runtime";

export type HarnessedFunction = (input: any) => void;

export type RuntimeProgram = Program & {
  // The named export from the program's entry file to run.
  // Defaults to "default".
  mainExport?: string;
};

export interface TypeScriptHarnessProcessOptions {
  // Disables typechecking of the program.
  noCheck?: boolean;
  // Does not evaluate the recipe.
  noRun?: boolean;
  // Filename to use in the compiled JS code, for engines
  // that apply source maps.
  filename?: string;
  // Enable debug logging for transformers (shows transformed code).
  debug?: boolean;
}

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compiles and executes `source`, returning the default export
  // of that module.
  run(
    source: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<Recipe>;

  // Resolves a `ProgramResolver` into a `Program` using the engine's
  // configuration.
  resolve(
    source: ProgramResolver,
  ): Promise<Program>;

  invoke(fn: () => any): any;

  getInvocation(source: string): HarnessedFunction;
}
