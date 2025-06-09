/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public API.
 *
 * Import these types via `types.ts` for internal code.
 *
 * Other packages should either import from `@commontools/builder` or
 * `@commontools/builder/interface`, but not both.
 */

import type { Schema, SchemaWithoutCell } from "./schema-to-ts.ts";

export const ID: unique symbol = Symbol("ID, unique to the context");
export const ID_FIELD: unique symbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
);

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

// Re-export Schema type
export type { Schema, SchemaWithoutCell } from "./schema-to-ts.ts";

// Re-export schema utilities
export { schema } from "./schema-to-ts.ts";
export { AuthSchema } from "./schema-lib.ts";

// Cell type with only public methods
export interface Cell<T = any> {
  // Public methods available in spell code and system
  get(): T;
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
  get(): OpaqueRef<T>;
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
  with: (inputs: Opaque<T>) => OpaqueRef<R>;
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
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
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

// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
export type JSONSchema = {
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
  readonly type?:
    | "object"
    | "array"
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "null";
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly description?: string;
  readonly default?: Readonly<JSONValue>;
  readonly title?: string;
  readonly example?: Readonly<JSONValue>;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly items?: Readonly<JSONSchema>;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JSONSchema>>;
  readonly asCell?: boolean;
  readonly asStream?: boolean;
  readonly anyOf?: readonly JSONSchema[];
  readonly additionalProperties?: Readonly<JSONSchema> | boolean;
  readonly ifc?: { classification?: string[]; integrity?: string[] }; // temporarily used to assign labels like "confidential"
};

// Built-in types
export interface BuiltInLLMParams {
  messages?: string[];
  model?: string;
  system?: string;
  stop?: string;
  maxTokens?: number;
  mode?: "json";
}

export interface BuiltInLLMState<T> {
  pending: boolean;
  result?: T;
  partial?: string;
  error: unknown;
}

export interface BuiltInCompileAndRunParams<T> {
  files: Record<string, string>;
  main: string;
  input?: T;
}

export interface BuiltInCompileAndRunState<T> {
  pending: boolean;
  result?: T;
  error?: any;
}

// Function type definitions
export type RecipeFunction = {
  <S extends JSONSchema>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<Schema<S>>>) => any,
  ): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;

  <S extends JSONSchema, R>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<Schema<S>>>) => Opaque<R>,
  ): RecipeFactory<SchemaWithoutCell<S>, R>;

  <S extends JSONSchema, RS extends JSONSchema>(
    argumentSchema: S,
    resultSchema: RS,
    fn: (input: OpaqueRef<Required<Schema<S>>>) => Opaque<Schema<RS>>,
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
};

export type HandlerFunction = {
  <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(
    eventSchema: E,
    stateSchema: T,
    handler: (event: Schema<E>, props: Schema<T>) => any,
  ): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<E>>;

  <E, T>(
    eventSchema: JSONSchema,
    stateSchema: JSONSchema,
    handler: (event: E, props: T) => any,
  ): ModuleFactory<T, E>;

  <E, T>(
    handler: (event: E, props: T) => any,
  ): ModuleFactory<T, E>;
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

// Re-export opaque ref creators
export type CellFunction = <T>(value?: T, schema?: JSONSchema) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;

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
export declare const fetchData: FetchDataFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
export declare const createNodeFactory: CreateNodeFactoryFunction;
export declare const createCell: CreateCellFunction;
export declare const cell: CellFunction;
export declare const stream: StreamFunction;
export declare const byRef: ByRefFunction;

/**
 * Helper type to recursively remove `readonly` properties from type `T`.
 *
 * (Duplicated from @commontools/utils/types.ts, but we want to keep this
 * independent for now)
 */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;
