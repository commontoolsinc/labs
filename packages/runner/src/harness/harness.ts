import { Recipe } from "@commontools/builder";
import { type IRuntime } from "../runtime.ts";

export type HarnessFunction = (input: any) => void;
export interface Harness extends EventTarget {
  readonly runtime: IRuntime;
  compile(source: string): Promise<Recipe>;
  getInvocation(source: string): HarnessFunction;
  mapStackTrace(stack: string): string;
}
