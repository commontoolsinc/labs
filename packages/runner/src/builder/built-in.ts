import { BuiltInLLMDialogState } from "@commontools/api";
import { createNodeFactoryImpl, liftImpl } from "./module.ts";
import { recipe } from "./recipe.ts";
import { isRecipe } from "./types.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  Cell,
  JSONSchema,
  NodeFactory,
  Opaque,
  OpaqueRef,
  RecipeFactory,
  Schema,
} from "./types.ts";
import type {
  BuiltInCompileAndRunParams,
  BuiltInCompileAndRunState,
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInGenerateTextState,
  BuiltInLLMGenerateObjectState,
  BuiltInLLMParams,
  BuiltInLLMState,
  FetchOptions,
  PatternToolFunction,
} from "commontools";

export function createBuiltIns(runtime: IRuntime) {
  const compileAndRun = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "compileAndRun",
  }) as <T = any, S = any>(
    params: Opaque<BuiltInCompileAndRunParams<T>>,
  ) => OpaqueRef<BuiltInCompileAndRunState<S>>;

  const llm = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "llm",
  }) as (
    params: Opaque<BuiltInLLMParams>,
  ) => OpaqueRef<BuiltInLLMState>;

  const llmDialog = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "llmDialog",
  }) as (
    params: Opaque<BuiltInLLMParams>,
  ) => OpaqueRef<BuiltInLLMDialogState>;

  const generateObject = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "generateObject",
  }) as <T = any>(
    params: Opaque<BuiltInGenerateObjectParams>,
  ) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

  const generateText = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "generateText",
  }) as (
    params: Opaque<BuiltInGenerateTextParams>,
  ) => OpaqueRef<BuiltInGenerateTextState>;

  const fetchData = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "fetchData",
  }) as <T>(
    params: Opaque<{
      url: string;
      mode?: "json" | "text";
      options?: FetchOptions;
      result?: T;
    }>,
  ) => OpaqueRef<{ pending: boolean; result: T; error: unknown }>;

  const streamData = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "streamData",
  }) as <T>(
    params: Opaque<{
      url: string;
      options?: FetchOptions;
      result?: T;
    }>,
  ) => OpaqueRef<{ pending: boolean; result: T; error: unknown }>;

  let ifElseFactory: NodeFactory<[unknown, unknown, unknown], any> | undefined;

  function ifElse<T = unknown, U = unknown, V = unknown>(
    condition: Opaque<T>,
    ifTrue: Opaque<U>,
    ifFalse: Opaque<V>,
  ): OpaqueRef<U | V> {
    ifElseFactory ||= createNodeFactoryImpl(runtime, {
      type: "ref",
      implementation: "ifElse",
    });
    return ifElseFactory([condition, ifTrue, ifFalse]) as OpaqueRef<U | V>;
  }

  const navigateTo = createNodeFactoryImpl(runtime, {
    type: "ref",
    implementation: "navigateTo",
  }) as (cell: OpaqueRef<unknown>) => OpaqueRef<string>;

  let wishFactory: NodeFactory<[unknown, unknown], any> | undefined;

  function wish<T = unknown>(
    target: Opaque<string>,
  ): OpaqueRef<T | undefined>;
  function wish<T = unknown>(
    target: Opaque<string>,
    defaultValue: Opaque<T> | T,
  ): OpaqueRef<T>;
  function wish<T = unknown>(
    target: Opaque<string>,
    defaultValue?: Opaque<T> | T,
  ): OpaqueRef<T | undefined> {
    wishFactory ||= createNodeFactoryImpl(runtime, {
      type: "ref",
      implementation: "wish",
    });
    return wishFactory([target, defaultValue]) as OpaqueRef<T | undefined>;
  }

  // Example:
  // str`Hello, ${name}!`
  //
  // TODO(seefeld): This should be a built-in module
  function str(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): OpaqueRef<string> {
    const interpolatedString = ({
      strings,
      values,
    }: {
      strings: TemplateStringsArray;
      values: unknown[];
    }): string =>
      strings.reduce(
        (result, str, i) => result + str + (i < values.length ? values[i] : ""),
        "",
      );

    return liftImpl<any, string>(runtime, interpolatedString)({
      strings,
      values,
    });
  }

  const patternTool = (<
    T,
    E extends Partial<T> = Record<PropertyKey, never>,
  >(
    fnOrRecipe:
      | ((input: OpaqueRef<Required<T>>) => any)
      | RecipeFactory<T, any>,
    extraParams?: Opaque<E>,
  ): OpaqueRef<Omit<T, keyof E>> => {
    const pattern = isRecipe(fnOrRecipe) ? fnOrRecipe : recipe(fnOrRecipe);

    return {
      pattern,
      extraParams: extraParams ?? {},
    } as any as OpaqueRef<Omit<T, keyof E>>;
  }) as PatternToolFunction;

  return {
    compileAndRun,
    llm,
    llmDialog,
    generateObject,
    fetchData,
    streamData,
    ifElse,
    navigateTo,
    wish,
    str,
    patternTool,
  };
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
