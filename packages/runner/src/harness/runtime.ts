import { Recipe } from "@commontools/builder";
import { type IRuntime } from "../runtime.ts";

export type HarnessFunction = (input: any) => void;
export interface Harness extends EventTarget {
  compile(source: string, runtime: IRuntime): Promise<Recipe | undefined>;
  getInvocation(source: string): HarnessFunction;
  mapStackTrace(stack: string): string;
}
