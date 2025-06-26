import { type Recipe } from "../builder/types.ts";
import type { Program, ProgramResolver } from "@commontools/js-runtime";
import { type EngineProcessOptions } from "./engine.ts";

export type HarnessedFunction = (input: any) => void;

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compiles and executes `source`, returning the default export
  // of that module.
  run(
    source: Program,
    options?: EngineProcessOptions,
  ): Promise<Recipe>;

  // Resolves a `ProgramResolver` into a `Program` using the engine's
  // configuration.
  resolve(
    source: ProgramResolver,
  ): Promise<Program>;

  getInvocation(source: string): HarnessedFunction;

  mapStackTrace(stack: string): string;
}
