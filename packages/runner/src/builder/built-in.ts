import { BuiltInLLMDialogState } from "@commontools/api";
import { createNodeFactory, lift } from "./module.ts";
import { recipe } from "./recipe.ts";
import { isRecipe } from "./types.ts";
import type {
  JSONSchema,
  NodeFactory,
  Opaque,
  OpaqueRef,
  RecipeFactory,
  Schema,
} from "./types.ts";
import type { Cell as CellType } from "./types.ts";
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
  WishParams,
  WishState,
} from "commontools";
import { isRecord } from "@commontools/utils/types";
import { isCell } from "../cell.ts";

export const compileAndRun = createNodeFactory({
  type: "ref",
  implementation: "compileAndRun",
}) as <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export const llm = createNodeFactory({
  type: "ref",
  implementation: "llm",
}) as (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState>;

export const llmDialog = createNodeFactory({
  type: "ref",
  implementation: "llmDialog",
}) as (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMDialogState>;

export const generateObject = createNodeFactory({
  type: "ref",
  implementation: "generateObject",
}) as <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

export const generateText = createNodeFactory({
  type: "ref",
  implementation: "generateText",
}) as (
  params: Opaque<BuiltInGenerateTextParams>,
) => OpaqueRef<BuiltInGenerateTextState>;

export const fetchData = createNodeFactory({
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

export const fetchProgram = createNodeFactory({
  type: "ref",
  implementation: "fetchProgram",
}) as (
  params: Opaque<{ url: string }>,
) => OpaqueRef<{
  pending: boolean;
  result: {
    files: Array<{ name: string; contents: string }>;
    main: string;
  } | undefined;
  error: unknown;
}>;

export const streamData = createNodeFactory({
  type: "ref",
  implementation: "streamData",
}) as <T>(
  params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error: unknown }>;

// ifElse with optional schema arguments (backward compatible)
export function ifElse<T = unknown, U = unknown, V = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  ifTrueSchemaOrIfTrue: JSONSchema | Opaque<U>,
  ifFalseSchemaOrIfFalse: JSONSchema | Opaque<V>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  ifTrue?: Opaque<U>,
  ifFalse?: Opaque<V>,
): OpaqueRef<U | V> {
  ifElseFactory ||= createNodeFactory({
    type: "ref",
    implementation: "ifElse",
  });

  // Check if schemas were provided (7 args) or not (3 args)
  if (condition !== undefined && ifTrue !== undefined && ifFalse !== undefined) {
    // New signature with schemas: ifElse(condSchema, trueSchema, falseSchema, resultSchema, cond, ifTrue, ifFalse)
    return ifElseFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      ifTrueSchema: ifTrueSchemaOrIfTrue as JSONSchema,
      ifFalseSchema: ifFalseSchemaOrIfFalse as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      ifTrue,
      ifFalse,
    }) as OpaqueRef<U | V>;
  }

  // Old signature without schemas: ifElse(cond, ifTrue, ifFalse)
  return ifElseFactory({
    condition: conditionSchemaOrCondition,
    ifTrue: ifTrueSchemaOrIfTrue,
    ifFalse: ifFalseSchemaOrIfFalse,
  }) as OpaqueRef<U | V>;
}

let ifElseFactory:
  | NodeFactory<{
      conditionSchema?: JSONSchema;
      ifTrueSchema?: JSONSchema;
      ifFalseSchema?: JSONSchema;
      resultSchema?: JSONSchema;
      condition: unknown;
      ifTrue: unknown;
      ifFalse: unknown;
    }, any>
  | undefined;

// when(condition, value) - returns value if condition is truthy, else condition
export function when<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  valueSchemaOrValue: JSONSchema | Opaque<U>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  value?: Opaque<U>,
): OpaqueRef<T | U> {
  whenFactory ||= createNodeFactory({
    type: "ref",
    implementation: "when",
  });

  // Check if schemas were provided (5 args) or not (2 args)
  if (condition !== undefined && value !== undefined) {
    // New signature with schemas: when(condSchema, valueSchema, resultSchema, cond, value)
    return whenFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      valueSchema: valueSchemaOrValue as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      value,
    }) as OpaqueRef<T | U>;
  }

  // Old signature without schemas: when(cond, value)
  return whenFactory({
    condition: conditionSchemaOrCondition,
    value: valueSchemaOrValue,
  }) as OpaqueRef<T | U>;
}

let whenFactory:
  | NodeFactory<{
      conditionSchema?: JSONSchema;
      valueSchema?: JSONSchema;
      resultSchema?: JSONSchema;
      condition: unknown;
      value: unknown;
    }, any>
  | undefined;

// unless(condition, fallback) - returns condition if truthy, else fallback
export function unless<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  fallbackSchemaOrFallback: JSONSchema | Opaque<U>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  fallback?: Opaque<U>,
): OpaqueRef<T | U> {
  unlessFactory ||= createNodeFactory({
    type: "ref",
    implementation: "unless",
  });

  // Check if schemas were provided (5 args) or not (2 args)
  if (condition !== undefined && fallback !== undefined) {
    // New signature with schemas: unless(condSchema, fallbackSchema, resultSchema, cond, fallback)
    return unlessFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      fallbackSchema: fallbackSchemaOrFallback as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      fallback,
    }) as OpaqueRef<T | U>;
  }

  // Old signature without schemas: unless(cond, fallback)
  return unlessFactory({
    condition: conditionSchemaOrCondition,
    fallback: fallbackSchemaOrFallback,
  }) as OpaqueRef<T | U>;
}

let unlessFactory:
  | NodeFactory<{
      conditionSchema?: JSONSchema;
      fallbackSchema?: JSONSchema;
      resultSchema?: JSONSchema;
      condition: unknown;
      fallback: unknown;
    }, any>
  | undefined;

export const navigateTo = createNodeFactory({
  type: "ref",
  implementation: "navigateTo",
}) as (cell: OpaqueRef<unknown>) => OpaqueRef<boolean>;

export function wish<T = unknown>(
  target: Opaque<WishParams>,
): OpaqueRef<Required<WishState<T>>>;
export function wish<T = unknown>(
  target: Opaque<WishParams>,
  schema: JSONSchema,
): OpaqueRef<Required<WishState<T>>>;
export function wish<T = unknown>(
  target: Opaque<string>,
): OpaqueRef<T>;
export function wish<T = unknown>(
  target: Opaque<string>,
  schema: JSONSchema,
): OpaqueRef<T>;
export function wish<T = unknown>(
  target: Opaque<string> | Opaque<WishParams>,
  schema?: JSONSchema,
): OpaqueRef<T | Required<WishState<T>>> {
  let param;
  let resultSchema;

  if (schema !== undefined && isRecord(target) && !isCell(target)) {
    param = {
      schema,
      ...target, // Pass in after, so schema here overrides any schema in target
    };
    resultSchema = !isCell(param.schema)
      ? param.schema as JSONSchema | undefined
      : schema;
  } else {
    param = target;
    resultSchema = schema;
  }
  return createNodeFactory({
    type: "ref",
    implementation: "wish",
    argumentSchema: {
      anyOf: [{
        type: "string",
        default: "",
      }, {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "array", items: { type: "string" } },
          schema: { type: "object" },
          context: { type: "object", additionalProperties: { asCell: true } },
          scope: { type: "array", items: { type: "string" } },
        },
      }],
    } as const satisfies JSONSchema,
    resultSchema,
  })(param);
}

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
): CellType<T>;
declare function createCell<S extends JSONSchema = JSONSchema>(
  schema: S,
  name?: string,
  value?: Schema<S>,
): CellType<Schema<S>>;

export type { createCell };

/**
 * Helper function for creating LLM tool definitions from recipes with optional pre-filled parameters.
 * Creates a recipe with the given function and returns an object suitable for use as an LLM tool,
 * with proper TypeScript typing that reflects only the non-pre-filled parameters.
 *
 * @param fnOrRecipe - Either a recipe function or an already-created RecipeFactory
 * @param extraParams - Optional object containing parameter values to pre-fill
 * @returns An object with `pattern` and `extraParams` properties, typed to show only remaining params
 *
 * @example
 * ```ts
 * import { patternTool } from "commontools";
 *
 * const content = cell("Hello world");
 *
 * // With a function - recipe will be created automatically
 * const grepTool = patternTool(
 *   ({ query, content }: { query: string; content: string }) => {
 *     return derive({ query, content }, ({ query, content }) => {
 *       return content.split("\n").filter((c) => c.includes(query));
 *     });
 *   },
 *   { content }
 * );
 *
 * // With an existing recipe
 * const myRecipe = recipe<{ query: string; content: string }>(
 *   "Grep",
 *   ({ query, content }) => { ... }
 * );
 * const grepTool2 = patternTool(myRecipe, { content });
 *
 * // Both result in type: OpaqueRef<{ query: string }>
 * ```
 */
export const patternTool = (<
  T,
  E extends Partial<T> = Record<PropertyKey, never>,
>(
  fnOrRecipe: ((input: OpaqueRef<Required<T>>) => any) | RecipeFactory<T, any>,
  extraParams?: Opaque<E>,
): OpaqueRef<Omit<T, keyof E>> => {
  const pattern = isRecipe(fnOrRecipe) ? fnOrRecipe : recipe(fnOrRecipe);

  return {
    pattern,
    extraParams: extraParams ?? {},
  } as any as OpaqueRef<Omit<T, keyof E>>;
}) as PatternToolFunction;
