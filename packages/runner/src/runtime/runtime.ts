import { Recipe } from "../../../builder/src/index.ts";

export type RuntimeFunction = (input: any) => void;
export interface Runtime extends EventTarget {
  compile(source: string): Promise<Recipe | undefined>;
  getInvocation(source: string): RuntimeFunction;
  mapStackTrace(stack: string): string;
}
