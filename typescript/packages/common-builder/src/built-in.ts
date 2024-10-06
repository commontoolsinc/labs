import { lift, createNodeFactory } from "./module.js";
import { Value, NodeFactory, CellProxy } from "./types.js";

export function generateText(
  params: Value<{
    messages: string[];
    system?: string;
    stop?: string;
    max_tokens?: number;
  }>
): CellProxy<{ pending: boolean; result: string; partial: string; error: any }> {
  generateTextFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "generateText",
  });
  return generateTextFactory(params);
}

export function fetchData<T>(
  params: Value<{
    url: string;
    mode?: "json" | "text";
    options?: RequestInit;
    result?: T;
  }>
): Value<{ pending: boolean; result: T; error: any }> {
  fetchDataFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "fetchData",
  });
  return fetchDataFactory(params);
}

let fetchDataFactory:
  | NodeFactory<
      { url: string; options?: RequestInit; result?: any },
      { pending: boolean; result: any; error: any }
    >
  | undefined = undefined;

export function ifElse<T, U, V>(
  condition: Value<T>,
  ifTrue: Value<U>,
  ifFalse: Value<V>
): CellProxy<T extends true ? U : V> {
  ifElseFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "ifElse",
  });
  return ifElseFactory([condition, ifTrue, ifFalse]);
}

let ifElseFactory: NodeFactory<[any, any, any], any> | undefined = undefined;

let generateTextFactory:
  | NodeFactory<
      { messages: string[]; system?: string; stop?: string; max_tokens?: number },
      { pending: boolean; result: any; partial: any; error: any }
    >
  | undefined = undefined;

// Example:
// str`Hello, ${name}!`
//
// TODO: This should be a built-in module
export function str(
  strings: TemplateStringsArray,
  ...values: any[]
): CellProxy<string> {
  const interpolatedString = ({
    strings,
    values,
  }: {
    strings: TemplateStringsArray;
    values: any[];
  }) =>
    strings.reduce(
      (result, str, i) => result + str + (i < values.length ? values[i] : ""),
      ""
    );

  return lift(interpolatedString)({ strings, values });
}
