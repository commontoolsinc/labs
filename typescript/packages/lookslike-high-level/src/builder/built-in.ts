import { createNodeFactory } from "./module.js";
import { Value, NodeFactory } from "./types.js";

let generateDataFactory:
  | NodeFactory<
      { prompt: string; result?: any; schema: any },
      { pending: boolean; result: any; partial: any; error: any }
    >
  | undefined = undefined;

export function generateData<T>(
  params: Value<{
    prompt: string;
    result?: T;
    schema: any;
  }>
): Value<{ pending: boolean; result: T; partial: any; error: any }> {
  generateDataFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "generateData",
  });
  return generateDataFactory(params);
}
