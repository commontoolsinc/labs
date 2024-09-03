import { createNodeFactory } from "./module.js";
import { Value, NodeFactory } from "./types.js";

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

export function ifElse<T, U, V>(
  condition: Value<T>,
  ifTrue: Value<U>,
  ifFalse: Value<V>
): Value<T extends true ? U : V> {
  ifElseFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "ifElse",
  });
  return ifElseFactory([condition, ifTrue, ifFalse]);
}

let ifElseFactory: NodeFactory<[any, any, any], any> | undefined = undefined;

let generateDataFactory:
  | NodeFactory<
      { prompt: string; result?: any; schema: any },
      { pending: boolean; result: any; partial: any; error: any }
    >
  | undefined = undefined;
