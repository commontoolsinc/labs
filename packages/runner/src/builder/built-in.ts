import { BuiltInLLMDialogState } from "@commontools/api";
import { createNodeFactory, lift } from "./module.ts";
import type {
  Cell,
  JSONSchema,
  NodeFactory,
  Opaque,
  OpaqueRef,
  Schema,
} from "./types.ts";
import type {
  BuiltInCompileAndRunParams,
  BuiltInCompileAndRunState,
  BuiltInGenerateObjectParams,
  BuiltInLLMDialogState,
  BuiltInLLMParams,
  BuiltInLLMState,
} from "commontools";

export const compileAndRun = createNodeFactory({
  type: "ref",
  implementation: "compileAndRun",
}) as <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export const llm = createNodeFactory({
  type: "ref",
  implementation: "llm",
}) as <T = string>(
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState<T>>;

export const llmDialog = createNodeFactory({
  type: "ref",
  implementation: "llmDialog",
}) as (
  params: Opaque<BuiltInLLMParams>, // TODO(bf): maybe need to drop `messages` from this type
) => OpaqueRef<BuiltInLLMDialogState>;

export const generateObject = createNodeFactory({
  type: "ref",
  implementation: "generateObject",
}) as <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMState<T>>;

export const fetchData = createNodeFactory({
  type: "ref",
  implementation: "fetchData",
}) as <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: RequestInit;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: unknown }>;

export const streamData = createNodeFactory({
  type: "ref",
  implementation: "streamData",
}) as <T>(
  params: Opaque<{
    url: string;
    options?: RequestInit;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: unknown }>;

export function ifElse<T = unknown, U = unknown, V = unknown>(
  condition: Opaque<T>,
  ifTrue: Opaque<U>,
  ifFalse: Opaque<V>,
): OpaqueRef<U | V> {
  ifElseFactory ||= createNodeFactory({
    type: "ref",
    implementation: "ifElse",
  });
  return ifElseFactory([condition, ifTrue, ifFalse]) as OpaqueRef<U | V>;
}

let ifElseFactory: NodeFactory<[unknown, unknown, unknown], any> | undefined;

export const navigateTo = createNodeFactory({
  type: "ref",
  implementation: "navigateTo",
}) as (cell: OpaqueRef<unknown>) => OpaqueRef<string>;

// Example:
// str`Hello, ${name}!`
//
// TODO(seefeld): This should be a built-in module
export function str(
  strings: TemplateStringsArray,
  ...values: unknown[]
): OpaqueRef<string> {
  const interpolatedString = ({
    strings,
    values,
  }: {
    strings: TemplateStringsArray;
    values: unknown[];
  }) =>
    strings.reduce(
      (result, str, i) => result + str + (i < values.length ? values[i] : ""),
      "",
    );

  return lift(interpolatedString)({ strings, values });
}

/**
 * Create a cell with a given schema and name.
 *
 * @param schema - Optional, The schema of the cell.
 * @param name - Optional, a name for the cell. If provided, the cell id will be
 *   derived from the current context and that name, otherwise it'll be derived
 *   by the order of invocation, which is less stable.
 * @param value - Optional, the initial value of the cell.
 */
declare function createCell<T>(
  schema?: JSONSchema,
  name?: string,
  value?: T,
): Cell<T>;
declare function createCell<S extends JSONSchema = JSONSchema>(
  schema: S,
  name?: string,
  value?: Schema<S>,
): Cell<Schema<S>>;

export type { createCell };
