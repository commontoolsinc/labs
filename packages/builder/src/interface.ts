/**
 * Public interface for the builder package.
 * This module exports only the types and functions that are part of the public API.
 */

// Import types for use in this file
import type {
  JSONSchema,
  Module,
  ModuleFactory,
  Opaque,
  OpaqueRef,
  RecipeFactory,
} from "./types.ts";

import type { Schema } from "./schema-to-ts.ts";

// Re-export core types needed by recipes
export type {
  Frame,
  JSONObject,
  JSONSchema,
  // JSON types
  JSONValue,
  // Module and Recipe types
  Module,
  // Factory types
  ModuleFactory,
  Mutable,
  Node,
  NodeFactory,
  // Core data types
  Opaque,
  OpaqueRef,
  Recipe,
  RecipeFactory,
  Static,
} from "./types.ts";

// Export symbols as both type and value
export { ID, NAME, TYPE, UI } from "./types.ts";


// Re-export Schema type
export type { Schema } from "./schema-to-ts.ts";

// Re-export schema utilities
export { schema } from "./schema-to-ts.ts";
export { AuthSchema } from "./schema-lib.ts";

// Re-export spell utilities
export { $, event, select, Spell } from "./spell.ts";

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
  ): RecipeFactory<Schema<S>, ReturnType<typeof fn>>;

  <S extends JSONSchema, R>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<Schema<S>>>) => Opaque<R>,
  ): RecipeFactory<Schema<S>, R>;

  <S extends JSONSchema, RS extends JSONSchema>(
    argumentSchema: S,
    resultSchema: RS,
    fn: (input: OpaqueRef<Required<Schema<S>>>) => Opaque<Schema<RS>>,
  ): RecipeFactory<Schema<S>, Schema<RS>>;

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
  ): ModuleFactory<Schema<T>, Schema<R>>;

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
  ): ModuleFactory<Schema<T>, Schema<E>>;

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
export type CellFunction = <T>(value: T) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;

// Builder functions interface
export interface BuilderFunctions {
  // Recipe creation
  recipe: RecipeFunction;

  // Module creation
  lift: LiftFunction;
  handler: HandlerFunction;
  derive: DeriveFunction;
  compute: ComputeFunction;
  render: RenderFunction;

  // Built-in modules
  str: StrFunction;
  ifElse: IfElseFunction;
  llm: LLMFunction;
  fetchData: FetchDataFunction;
  streamData: StreamDataFunction;
  compileAndRun: CompileAndRunFunction;
  navigateTo: NavigateToFunction;

  // Cell creation
  createCell: CreateCellFunction;
  cell: CellFunction;
  stream: StreamFunction;

  // Utility
  byRef: ByRefFunction;
}

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

// Runtime interface needed by createCell
export interface BuilderRuntime {
  getCell<T>(
    space: string,
    cause: any,
    schema?: JSONSchema,
    log?: any,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: string,
    cause: any,
    schema: S,
    log?: any,
  ): Cell<Schema<S>>;
}

// Factory function to create builder with runtime
export type CreateBuilder = (
  runtime: BuilderRuntime,
  getCellLinkOrThrow?: (value: any) => any,
) => BuilderFunctions;
