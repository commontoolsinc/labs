import { type Recipe } from "@commontools/builder";
import { type Program } from "@commontools/js-runtime";

export type HarnessedFunction = (input: any) => void;

// A `Harness` wraps a flow of compiling, bundling, and executing typescript.
export interface Harness extends EventTarget {
  // Compiles and executes `source`, returning the default export
  // of that module.
  //run(source: Program): Promise<Recipe>;
  // Compiles and executes a single tsx string, returning the default
  // export of that module.
  runSingle(source: string): Promise<Recipe>;
  getInvocation(source: string): HarnessedFunction;
  mapStackTrace(stack: string): string;
}
