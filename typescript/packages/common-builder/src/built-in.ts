import { lift, createNodeFactory } from "./module.js";
import { Value, NodeFactory, CellProxy } from "./types.js";

export function llm(
  params: Value<{
    messages?: string[];
    prompt?: string;
    system?: string;
    stop?: string;
    max_tokens?: number;
  }>
): CellProxy<{
  pending: boolean;
  result?: string;
  partial?: string;
  error: any;
}> {
  llmFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "llm",
  });
  return llmFactory(params);
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

export function streamData<T>(
  params: Value<{
    url: string;
    options?: RequestInit;
    result?: T;
  }>
): Value<{ pending: boolean; result: T; error: any }> {
  streamDataFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "streamData",
  });
  return streamDataFactory(params);
}

let streamDataFactory:
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

export function launch<T>(recipeNode: CellProxy<T>): CellProxy<string> {
  if (
    recipeNode.export().nodes.size !== 1 ||
    recipeNode.export().nodes.values().next().value.module.implementation
      .type !== "recipe"
  )
    throw new Error(
      "launch: Must be a called recipe, e.g. `launch(myRecipe(...))`"
    );
  launchFactory ||= createNodeFactory({
    type: "builtin",
    implementation: "launch",
  });
  return launchFactory({ recipeNode: recipeNode });
}

let fetchDataFactory:
  | NodeFactory<
      { url: string; options?: RequestInit; result?: any },
      { pending: boolean; result: any; error: any }
    >
  | undefined;

let ifElseFactory: NodeFactory<[any, any, any], any> | undefined;

let llmFactory:
  | NodeFactory<
      {
        messages?: string[];
        prompt?: string;
        system?: string;
        stop?: string;
        max_tokens?: number;
      },
      { pending: boolean; result?: string; partial?: string; error: any }
    >
  | undefined;

let launchFactory:
  | NodeFactory<{ recipeNode: CellProxy<any> }, string>
  | undefined;

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
