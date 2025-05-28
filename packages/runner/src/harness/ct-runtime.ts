import { Recipe } from "@commontools/builder";
import { TsArtifact } from "@commontools/js-runtime";

export type RuntimeFunction = (input: any) => void;

// A `CtRuntime` wraps a flow of compiling, bundling,
// and executing typescript.
export interface CtRuntime extends EventTarget {
  // Compiles and executes `source`, returning the default export
  // of that module.
  run(source: TsArtifact): Promise<Recipe>;
  // Compiles and executes a single tsx string, returning the default
  // export of that module.
  runSingle(source: string): Promise<Recipe>;
  getInvocation(source: string): RuntimeFunction;
  mapStackTrace(stack: string): string;
}
