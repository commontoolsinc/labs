/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public recipe API.
 *
 * Workspace code should import these types via `@commontools/builder`.
 */

export const ID: unique symbol = Symbol("ID, unique to the context");
export const ID_FIELD: unique symbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
);

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

// Cell type with only public methods
export interface Cell<T = any> {
  // Public methods available in spell code and system
  get(): Readonly<T>;
  set(value: T): void;
  send(value: T): void; // alias for set
  update(values: Partial<T>): void;
  push(...value: T extends (infer U)[] ? U[] : never): void;
  equals(other: Cell<any>): boolean;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
}

// Cell type with only public methods
export interface Stream<T> {
  send(event: T): void;
}

export type OpaqueRef<T> =
  & OpaqueRefMethods<T>
  & (T extends Array<infer U> ? Array<OpaqueRef<U>>
    : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
    : T);

// Any OpaqueRef is also an Opaque, but can also have static values.
// Use Opaque<T> in APIs that get inputs from the developer and use OpaqueRef
// when data gets passed into what developers see (either recipe inputs or
// module outputs).
export type Opaque<T> =
  | OpaqueRef<T>
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

// OpaqueRefMethods type with only public methods
export interface OpaqueRefMethods<T> {
  get(): T;
  set(value: Opaque<T> | T): void;
  key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
  setDefault(value: Opaque<T> | T): void;
  setName(name: string): void;
  setSchema(schema: JSONSchema): void;
  map<S>(
    fn: (
      element: T extends Array<infer U> ? Opaque<U> : Opaque<T>,
      index: Opaque<number>,
      array: T,
    ) => Opaque<S>,
  ): Opaque<S[]>;
}

// Factory types

// TODO(seefeld): Subset of internal type, just enough to make it
// differentiated. But this isn't part of the public API, so we need to find a
// different way to handle this.
export interface Recipe {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}
export interface Module {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
}

export type toJSON = {
  toJSON(): unknown;
};

export type Handler<T = any, R = any> = Module & {
  with: (inputs: Opaque<StripCell<T>>) => OpaqueRef<R>;
};

export type NodeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & (Module | Handler | Recipe)
  & toJSON;

export type RecipeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Recipe
  & toJSON;

export type ModuleFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Module
  & toJSON;

export type HandlerFactory<T, R> =
  & ((inputs: Opaque<StripCell<T>>) => OpaqueRef<R>)
  & Handler<T, R>
  & toJSON;

// JSON types

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONArray
  | JSONObject & IDFields;

export interface JSONArray extends ArrayLike<JSONValue> {}

export interface JSONObject extends Record<string, JSONValue> {}

// Annotations when writing data that help determine the entity id. They are
// removed before sending to storage.
export interface IDFields {
  [ID]?: unknown;
  [ID_FIELD]?: unknown;
}

// Valid values for the "type" property of a JSONSchema
export type JSONSchemaTypes =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null";

// See https://json-schema.org/draft/2020-12/json-schema-core
// See https://json-schema.org/draft/2020-12/json-schema-validation
// There is a lot of potential validation that is not handled, but this object
// is defined to support them, so that generated schemas will still be usable.
// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
export type JSONSchema = {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JSONSchema | boolean>>;
  /** @deprecated Use `$defs` for 2019-09/Draft 8 or later */
  readonly definitions?: Readonly<Record<string, JSONSchema | boolean>>;

  // Subschema logic
  readonly allOf?: readonly (JSONSchema | boolean)[]; // not validated
  readonly anyOf?: readonly (JSONSchema | boolean)[]; // not always validated
  readonly oneOf?: readonly (JSONSchema | boolean)[]; // not validated
  readonly not?: JSONSchema | boolean;
  // Subschema conditionally - none applied
  readonly if?: JSONSchema | boolean;
  readonly then?: JSONSchema | boolean;
  readonly else?: JSONSchema | boolean;
  readonly dependentSchemas?: Readonly<Record<string, JSONSchema | boolean>>;
  // Subschema for array
  readonly prefixItems?: (JSONSchema | boolean)[]; // not validated
  readonly items?: Readonly<JSONSchema>;
  readonly contains?: JSONSchema | boolean; // not validated
  // Subschema for object
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly patternProperties?: Readonly<Record<string, JSONSchema | boolean>>; // not validated
  readonly additionalProperties?: JSONSchema | boolean;
  readonly propertyNames?: JSONSchema | boolean; // not validated

  // Validation for any
  readonly type?: JSONSchemaTypes | readonly JSONSchemaTypes[];
  readonly enum?: readonly Readonly<JSONValue>[]; // not validated
  readonly const?: Readonly<JSONValue>; // not validated
  // Validation for numeric - none applied
  readonly multipleOf?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  // Validation for string - none applied
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  // Validation for array  - none applied
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxContains?: number;
  readonly minContains?: number;
  // Validation for object
  readonly maxProperties?: number; // not validated
  readonly minProperties?: number; // not validated
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>; // not validated

  // Format annotations
  readonly format?: string; // not validated

  // Contents - none applied
  readonly contentEncoding?: string;
  readonly contentMediaType?: string;
  readonly contentSchema?: JSONSchema | boolean;

  // Meta-Data
  readonly title?: string;
  readonly description?: string;
  readonly default?: Readonly<JSONValue>;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly Readonly<JSONValue>[];

  // Common Tools extensions
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
  // makes it so that your handler gets a Cell object for that property. So you can call .set()/.update()/.push()/etc on it.
  readonly asCell?: boolean;
  // streams are what handler returns. if you pass that to another handler/lift and declare it as asSteam, you can call .send on it
  readonly asStream?: boolean;
  // temporarily used to assign labels like "confidential"
  readonly ifc?: { classification?: string[]; integrity?: string[] };
};

export interface BuiltInLLMTypedContent {
  type: "text" | "image";
  data: string;
}
export type BuiltInLLMContent = string | BuiltInLLMTypedContent[];

export interface BuiltInLLMTool {
  description: string;
  inputSchema: JSONSchema;
  handler?: (args: any) => any | Promise<any>; // Client-side only
}

export interface BuiltInLLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface BuiltInLLMToolResult {
  toolCallId: string;
  result: any;
  error?: string;
}

export type BuiltInLLMMessage = {
  role: "user" | "assistant" | "tool";
  content: BuiltInLLMContent;
  toolCalls?: BuiltInLLMToolCall[];
  toolResults?: BuiltInLLMToolResult[];
};

// Built-in types
export interface BuiltInLLMParams {
  messages?: BuiltInLLMMessage[];
  model?: string;
  system?: string;
  stop?: string;
  maxTokens?: number;
  /**
   * Specifies the mode of operation for the LLM.
   * - `"json"`: Indicates that the LLM should process and return data in JSON format.
   * This parameter is optional and defaults to undefined, which may result in standard behavior.
   */
  mode?: "json";
  /**
   * Tools that can be called by the LLM during generation.
   * Each tool has a description, input schema, and handler function that runs client-side.
   */
  tools?: Record<string, {
    description: string;
    inputSchema: JSONSchema;
    handler?: (args: any) => any | Promise<any>;
  }>;
}

export interface BuiltInLLMState<T> {
  pending: boolean;
  result?: T;
  partial?: string;
  error: unknown;
}

export interface BuiltInGenerateObjectParams {
  model?: string;
  prompt?: string;
  schema?: JSONSchema;
  system?: string;
  cache?: boolean;
  maxTokens?: number;
  metadata?: Record<string, string | undefined | object>;
}

export interface BuiltInCompileAndRunParams<T> {
  files: Array<{ name: string; contents: string }>;
  main: string;
  input?: T;
}

export interface BuiltInCompileAndRunState<T> {
  pending: boolean;
  result?: T;
  error?: any;
  errors?: Array<{
    line: number;
    column: number;
    message: string;
    type: string;
    file?: string;
  }>;
}

// Function type definitions
export type RecipeFunction = {
  <S extends JSONSchema>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => any,
  ): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;

  <S extends JSONSchema, R>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => Opaque<R>,
  ): RecipeFactory<SchemaWithoutCell<S>, R>;

  <S extends JSONSchema, RS extends JSONSchema>(
    argumentSchema: S,
    resultSchema: RS,
    fn: (
      input: OpaqueRef<Required<SchemaWithoutCell<S>>>,
    ) => Opaque<SchemaWithoutCell<RS>>,
  ): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;

  <T>(
    argumentSchema: string | JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => any,
  ): RecipeFactory<T, ReturnType<typeof fn>>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): RecipeFactory<T, R>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    resultSchema: JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): RecipeFactory<T, R>;
};

export type LiftFunction = {
  <T extends JSONSchema = JSONSchema, R extends JSONSchema = JSONSchema>(
    argumentSchema: T,
    resultSchema: R,
    implementation: (input: Schema<T>) => Schema<R>,
  ): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;

  <T, R>(
    implementation: (input: T) => R,
  ): ModuleFactory<T, R>;

  <T>(
    implementation: (input: T) => any,
  ): ModuleFactory<T, ReturnType<typeof implementation>>;

  <T extends (...args: any[]) => any>(
    implementation: T,
  ): ModuleFactory<Parameters<T>[0], ReturnType<T>>;

  <T, R>(
    argumentSchema?: JSONSchema,
    resultSchema?: JSONSchema,
    implementation?: (input: T) => R,
  ): ModuleFactory<T, R>;
};

// Helper type to make non-Cell and non-Stream properties readonly in handler state
export type HandlerState<T> = T extends Cell<any> ? T
  : T extends Stream<any> ? T
  : T extends Array<infer U> ? ReadonlyArray<HandlerState<U>>
  : T extends object ? { readonly [K in keyof T]: HandlerState<T[K]> }
  : T;

export type HandlerFunction = {
  // With schemas

  <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(
    eventSchema: E,
    stateSchema: T,
    handler: (event: Schema<E>, props: Schema<T>) => any,
  ): ModuleFactory<StripCell<SchemaWithoutCell<T>>, SchemaWithoutCell<E>>;

  // With inferred types
  <E, T>(
    eventSchema: JSONSchema,
    stateSchema: JSONSchema,
    handler: (event: E, props: HandlerState<T>) => any,
  ): ModuleFactory<StripCell<T>, E>;

  // Without schemas
  <E, T>(
    handler: (event: E, props: T) => any,
    options: { proxy: true },
  ): ModuleFactory<StripCell<T>, E>;

  <E, T>(
    handler: (event: E, props: HandlerState<T>) => any,
  ): ModuleFactory<StripCell<T>, E>;
};

export type DeriveFunction = <In, Out>(
  input: Opaque<In>,
  f: (input: In) => Out | Promise<Out>,
) => OpaqueRef<Out>;

export type ComputeFunction = <T>(fn: () => T) => OpaqueRef<T>;

export type RenderFunction = <T>(fn: () => T) => OpaqueRef<T>;

export type StrFunction = (
  strings: TemplateStringsArray,
  ...values: any[]
) => OpaqueRef<string>;

export type IfElseFunction = <T = any, U = any, V = any>(
  condition: Opaque<T>,
  ifTrue: Opaque<U>,
  ifFalse: Opaque<V>,
) => OpaqueRef<U | V>;

export type LLMFunction = <T = string>(
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState<T>>;

export type GenerateObjectFunction = <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMState<T>>;

export type FetchDataFunction = <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: RequestInit;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: any }>;

export type StreamDataFunction = <T>(
  params: Opaque<{
    url: string;
    options?: RequestInit;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: any }>;

export type CompileAndRunFunction = <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<string>;

export type CreateNodeFactoryFunction = <T = any, R = any>(
  moduleSpec: Module,
) => ModuleFactory<T, R>;

export type CreateCellFunction = {
  <T>(
    schema?: JSONSchema,
    name?: string,
    value?: T,
  ): Cell<T>;

  <S extends JSONSchema = JSONSchema>(
    schema: S,
    name?: string,
    value?: Schema<S>,
  ): Cell<Schema<S>>;
};

// Default type for specifying default values in type definitions
export type Default<T, V extends T = T> = T;

// Re-export opaque ref creators
export type CellFunction = <T>(value?: T, schema?: JSONSchema) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;

// Recipe environment types
export interface RecipeEnvironment {
  readonly apiUrl: URL;
}

export type GetRecipeEnvironmentFunction = () => RecipeEnvironment;

// Re-export all function types as values for destructuring imports
// These will be implemented by the factory
export declare const recipe: RecipeFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const derive: DeriveFunction;
export declare const compute: ComputeFunction;
export declare const render: RenderFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const llm: LLMFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const fetchData: FetchDataFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
export declare const createNodeFactory: CreateNodeFactoryFunction;
export declare const createCell: CreateCellFunction;
export declare const cell: CellFunction;
export declare const stream: StreamFunction;
export declare const byRef: ByRefFunction;
export declare const getRecipeEnvironment: GetRecipeEnvironmentFunction;

/**
 * Helper type to recursively remove `readonly` properties from type `T`.
 *
 * (Duplicated from @commontools/utils/types.ts, but we want to keep this
 * independent for now)
 */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;

export const schema = <T extends JSONSchema>(schema: T) => schema;

// toSchema is a compile-time transformer that converts TypeScript types to JSONSchema
// The actual implementation is done by the TypeScript transformer
export const toSchema = <T>(options?: Partial<JSONSchema>): JSONSchema => {
  return {} as JSONSchema;
};

// Helper type to transform Cell<T> to Opaque<T> in handler inputs
export type StripCell<T> = T extends Cell<infer U> ? StripCell<U>
  : T extends Array<infer U> ? StripCell<U>[]
  : T extends object ? { [K in keyof T]: StripCell<T[K]> }
  : T;

export type Schema<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> =
  // If we're out of depth, short-circuit
  Depth extends 0 ? unknown
    // Handle asCell attribute - wrap the result in Cell<T>
    : T extends { asCell: true } ? Cell<Schema<Omit<T, "asCell">, Root, Depth>>
    // Handle asStream attribute - wrap the result in Stream<T>
    : T extends { asStream: true }
      ? Stream<Schema<Omit<T, "asStream">, Root, Depth>>
    // Handle $ref to root
    : T extends { $ref: "#" } ? Schema<
        Omit<Root, "asCell" | "asStream">,
        Root,
        DecrementDepth<Depth>
      >
    // Handle other $ref (placeholder - would need a schema registry for other refs)
    : T extends { $ref: string } ? any
    // Handle enum values
    : T extends { enum: infer E extends readonly any[] } ? E[number]
    // Handle oneOf (not yet supported in schema.ts, so commenting out)
    // : T extends { oneOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema ?
    //         | Schema<F, Root, DecrementDepth<Depth>>
    //         | Schema<{ oneOf: R }, Root, Depth>
    //       : never
    //     : never
    // Handle anyOf
    : T extends { anyOf: infer U extends readonly JSONSchema[] }
      ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
        ? F extends JSONSchema ?
            | Schema<F, Root, DecrementDepth<Depth>>
            | Schema<{ anyOf: R }, Root, Depth>
        : never
      : never
    // Handle allOf (merge all types) (not yet supported in schema.ts, so commenting out)
    // : T extends { allOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema
    //       ? Schema<F, Root, Depth> & Schema<{ allOf: R }, Root, Depth>
    //     : never
    //   : Record<string | number | symbol, never>
    // Handle different primitive types
    : T extends { type: "string" } ? string
    : T extends { type: "number" | "integer" } ? number
    : T extends { type: "boolean" } ? boolean
    : T extends { type: "null" } ? null
    // Handle array type
    : T extends { type: "array" }
      ? T extends { items: infer I }
        ? I extends JSONSchema ? Array<Schema<I, Root, DecrementDepth<Depth>>>
        : unknown[]
      : unknown[] // No items specified, allow any items
    // Handle object type
    : T extends { type: "object" }
      ? T extends { properties: infer P }
        ? P extends Record<string, JSONSchema> ? ObjectFromProperties<
            P,
            T extends { required: readonly string[] } ? T["required"] : [],
            Root,
            Depth,
            T extends
              { additionalProperties: infer AP extends boolean | JSONSchema }
              ? AP
              : false,
            GetDefaultKeys<T>
          >
        : Record<string, unknown>
        // Object without properties - check additionalProperties
      : T extends { additionalProperties: infer AP }
        ? AP extends false ? Record<string | number | symbol, never> // Empty object
        : AP extends true ? Record<string | number | symbol, unknown>
        : AP extends JSONSchema ? Record<
            string | number | symbol,
            Schema<AP, Root, DecrementDepth<Depth>>
          >
        : Record<string | number | symbol, unknown>
        // Default for object with no properties and no additionalProperties specified
      : Record<string, unknown>
    // Default case
    : any;

// Get keys from the default object
type GetDefaultKeys<T extends JSONSchema> = T extends { default: infer D }
  ? D extends Record<string, any> ? keyof D & string
  : never
  : never;

// Helper type for building object types from properties
type ObjectFromProperties<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  AP extends boolean | JSONSchema = false,
  DK extends string = never,
> =
  // Required properties (either explicitly required or has a default value)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? K : never
        : never
    ]: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  // Optional properties (not required and no default)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? never : K
        : never
    ]?: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  // Additional properties
  & (
    AP extends false
      // Additional properties off => no-op instead of empty record
      ? Record<never, never>
      : AP extends true ? { [key: string]: unknown }
      : AP extends JSONSchema
        ? { [key: string]: Schema<AP, Root, DecrementDepth<Depth>> }
      : Record<string | number | symbol, never>
  )
  & IDFields;

// Restrict Depth to these numeric literal types
type DepthLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Decrement map for recursion limit
type Decrement = {
  0: 0;
  1: 0;
  2: 1;
  3: 2;
  4: 3;
  5: 4;
  6: 5;
  7: 6;
  8: 7;
  9: 8;
};

// Helper function to safely get decremented depth
type DecrementDepth<D extends DepthLevel> = Decrement[D] & DepthLevel;

// Same as above, but ignoreing asCell, so we never get cells. This is used for
// calles of lifted functions and handlers, since they can pass either cells or
// values.

export type SchemaWithoutCell<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> =
  // If we're out of depth, short-circuit
  Depth extends 0 ? unknown
    // Handle asCell attribute - but DON'T wrap in Cell, just use the inner type
    : T extends { asCell: true }
      ? SchemaWithoutCell<Omit<T, "asCell">, Root, Depth>
    // Handle asStream attribute - but DON'T wrap in Stream, just use the inner type
    : T extends { asStream: true }
      ? SchemaWithoutCell<Omit<T, "asStream">, Root, Depth>
    // Handle $ref to root
    : T extends { $ref: "#" } ? SchemaWithoutCell<
        Omit<Root, "asCell" | "asStream">,
        Root,
        DecrementDepth<Depth>
      >
    // Handle other $ref (placeholder - would need a schema registry for other refs)
    : T extends { $ref: string } ? any
    // Handle enum values
    : T extends { enum: infer E extends readonly any[] } ? E[number]
    // Handle oneOf (not yet supported in schema.ts, so commenting out)
    // : T extends { oneOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema ?
    //         | SchemaWithoutCell<F, Root, DecrementDepth<Depth>>
    //         | SchemaWithoutCell<{ oneOf: R }, Root, Depth>
    //       : never
    //     : never
    // Handle anyOf
    : T extends { anyOf: infer U extends readonly JSONSchema[] }
      ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
        ? F extends JSONSchema ?
            | SchemaWithoutCell<F, Root, DecrementDepth<Depth>>
            | SchemaWithoutCell<{ anyOf: R }, Root, Depth>
        : never
      : never
    // Handle allOf (merge all types) (not yet supported in schema.ts, so commenting out)
    // : T extends { allOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema
    //       ?
    //         & SchemaWithoutCell<F, Root, Depth>
    //         & MergeAllOfWithoutCell<{ allOf: R }, Root, Depth>
    //     : never
    //   : Record<string | number | symbol, never>
    // Handle different primitive types
    : T extends { type: "string" } ? string
    : T extends { type: "number" | "integer" } ? number
    : T extends { type: "boolean" } ? boolean
    : T extends { type: "null" } ? null
    // Handle array type
    : T extends { type: "array" }
      ? T extends { items: infer I }
        ? I extends JSONSchema
          ? SchemaWithoutCell<I, Root, DecrementDepth<Depth>>[]
        : unknown[]
      : unknown[] // No items specified, allow any items
    // Handle object type
    : T extends { type: "object" }
      ? T extends { properties: infer P }
        ? P extends Record<string, JSONSchema>
          ? ObjectFromPropertiesWithoutCell<
            P,
            T extends { required: readonly string[] } ? T["required"] : [],
            Root,
            Depth,
            T extends
              { additionalProperties: infer AP extends boolean | JSONSchema }
              ? AP
              : false,
            GetDefaultKeys<T>
          >
        : Record<string, unknown>
        // Object without properties - check additionalProperties
      : T extends { additionalProperties: infer AP }
        ? AP extends false ? Record<string | number | symbol, never> // Empty object
        : AP extends true ? Record<string | number | symbol, unknown>
        : AP extends JSONSchema ? Record<
            string | number | symbol,
            SchemaWithoutCell<AP, Root, DecrementDepth<Depth>>
          >
        : Record<string | number | symbol, unknown>
        // Default for object with no properties and no additionalProperties specified
      : Record<string, unknown>
    // Default case
    : any;

type ObjectFromPropertiesWithoutCell<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  AP extends boolean | JSONSchema = false,
  DK extends string = never,
> =
  // Required properties (either explicitly required or has a default value)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? K : never
        : never
    ]: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
  }
  // Optional properties (not required and no default)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? never : K
        : never
    ]?: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
  }
  // Additional properties
  & (
    AP extends false
      // Additional properties off => no-op instead of empty record
      ? Record<never, never>
      : AP extends true
      // Additional properties on => unknown
        ? { [key: string]: unknown }
      : AP extends JSONSchema
      // Additional properties is another schema => map them
        ? { [key: string]: SchemaWithoutCell<AP, Root, DecrementDepth<Depth>> }
      : Record<string | number | symbol, never>
  );

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "common-fragment";

/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export const h = Object.assign(function h(
  name: string | ((...args: any[]) => VNode),
  props: { [key: string]: any } | null,
  ...children: RenderNode[]
): VNode {
  if (typeof name === "function") {
    return name({
      ...(props ?? {}),
      children: children.flat(),
    });
  } else {
    return {
      type: "vnode",
      name,
      props: props ?? {},
      children: children.flat(),
    };
  }
}, {
  fragment({ children }: { children: RenderNode[] }) {
    return h(FRAGMENT_ELEMENT, null, ...children);
  },
});

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | Cell<any>
    | Stream<any>;
};

/** A child in a view can be one of a few things */
export type RenderNode =
  | VNode
  | string
  | number
  | boolean
  | Cell<RenderNode>
  | RenderNode[];

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children?: RenderNode;
  [UI]?: VNode;
};
