import { type Pattern } from "../builder/types.ts";
import type {
  JsScript,
  Program,
  ProgramResolver,
} from "@commontools/js-compiler";

export type HarnessedFunction = (input: any) => void;

export type RuntimeProgram = Program & {
  // The named export from the program's entry file to run.
  // Defaults to "default".
  mainExport?: string;
};

export interface TypeScriptHarnessProcessOptions {
  // Disables typechecking of the program.
  noCheck?: boolean;
  // Does not evaluate the pattern.
  noRun?: boolean;
  // An identifer to use to uniquely identify the compiled
  // code when applying source maps.
  identifier?: string;
  // Filename to use in the compiled JS code, for engines
  // that apply source maps.
  filename?: string;
  // Get the program post-AST-transformation for debugging.
  getTransformedProgram?: (program: Program) => void;
  // Show verbose TypeScript error messages instead of simplified hints.
  verboseErrors?: boolean;
}

type Exports = Record<string, any>;

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compiles and executes `source`, returning the default export
  // of that module.
  run(
    source: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<Pattern>;

  // Compiles `source` to JS without evaluation.
  compile(
    source: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<JsScript>;

  // Evaluates pre-compiled JS, returning exports.
  evaluate(
    source: RuntimeProgram,
    jsScript: JsScript,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<{ main?: Exports; exportMap?: Record<string, Exports> }>;

  // Resolves a `ProgramResolver` into a `Program` using the engine's
  // configuration.
  resolve(
    source: ProgramResolver,
  ): Promise<Program>;

  invoke(fn: () => any): any;

  getInvocation(source: string): HarnessedFunction;
}
