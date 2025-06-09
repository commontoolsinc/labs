import { isObject, type Mutable } from "@commontools/utils/types";

import type {
  ByRefFunction,
  Cell,
  CellFunction,
  CompileAndRunFunction,
  ComputeFunction,
  CreateCellFunction,
  DeriveFunction,
  FetchDataFunction,
  GetRecipeEnvironmentFunction,
  HandlerFunction,
  IfElseFunction,
  JSONSchema,
  JSONValue,
  LiftFunction,
  LLMFunction,
  Module,
  NavigateToFunction,
  Opaque,
  OpaqueRef,
  Recipe,
  RecipeFunction,
  RenderFunction,
  Schema,
  StreamDataFunction,
  StreamFunction,
  StrFunction,
} from "./interface.ts";
import {
  AuthSchema,
  ID,
  ID_FIELD,
  NAME,
  schema,
  TYPE,
  UI,
} from "./interface.ts";

export { AuthSchema, ID, ID_FIELD, NAME, TYPE, UI } from "./interface.ts";
export type {
  Cell,
  CreateCellFunction,
  Handler,
  HandlerFactory,
  JSONObject,
  JSONSchema,
  JSONValue,
  Module,
  ModuleFactory,
  NodeFactory,
  Opaque,
  OpaqueRef,
  Recipe,
  RecipeFactory,
  Stream,
  toJSON,
} from "./interface.ts";
export { type Schema, schema, type SchemaWithoutCell } from "./schema-to-ts.ts";

export type JSONSchemaMutable = Mutable<JSONSchema>;

// Augment the public interface with the internal OpaqueRefMethods interface.
// Deliberately repeating the original interface to catch any inconsistencies:
// This here then reflects the entire interface the internal implementation
// implements.
declare module "./interface.ts" {
  interface OpaqueRefMethods<T> {
    get(): OpaqueRef<T>;
    set(value: Opaque<T> | T): void;
    key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
    setDefault(value: Opaque<T> | T): void;
    setPreExisting(ref: unknown): void;
    setName(name: string): void;
    setSchema(schema: JSONSchema): void;
    connect(node: NodeRef): void;
    export(): {
      cell: OpaqueRef<any>;
      path: PropertyKey[];
      value?: Opaque<T>;
      defaultValue?: Opaque<T>;
      nodes: Set<NodeRef>;
      external?: unknown;
      name?: string;
      schema?: JSONSchema;
      rootSchema?: JSONSchema;
      frame: Frame;
    };
    unsafe_bindToRecipeAndPath(
      recipe: Recipe,
      path: PropertyKey[],
    ): void;
    unsafe_getExternal(): OpaqueRef<T>;
    map<S>(
      fn: (
        element: T extends Array<infer U> ? Opaque<U> : Opaque<T>,
        index: Opaque<number>,
        array: T,
      ) => Opaque<S>,
    ): Opaque<S[]>;
    toJSON(): unknown;
    [Symbol.iterator](): Iterator<T>;
    [Symbol.toPrimitive](hint: string): T;
    [isOpaqueRefMarker]: true;
  }
}

export type { OpaqueRefMethods } from "./interface.ts";

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueRef<T = any>(value: unknown): value is OpaqueRef<T> {
  return !!value &&
    typeof (value as OpaqueRef<T>)[isOpaqueRefMarker] === "boolean";
}

export type NodeRef = {
  module: Module | Recipe | OpaqueRef<Module | Recipe>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

export type Alias = {
  $alias: {
    cell?: unknown;
    path: PropertyKey[];
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
  };
};

export function isAlias(value: unknown): value is Alias {
  return isObject(value) && "$alias" in value && isObject(value.$alias) &&
    "path" in value.$alias &&
    Array.isArray(value.$alias.path);
}

export type StreamAlias = {
  $stream: true;
};

export function isStreamAlias(value: unknown): value is StreamAlias {
  return isObject(value) && "$stream" in value && value.$stream === true;
}

declare module "./interface.ts" {
  export interface Module {
    type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
    implementation?: ((...args: any[]) => any) | Recipe | string;
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
}

export function isModule(value: unknown): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null && typeof (value as unknown as Module).type === "string"
  );
}

export type Node = {
  description?: string;
  module: Module | Alias;
  inputs: JSONValue;
  outputs: JSONValue;
};

// Used to get back to original recipe from a JSONified representation.
export const unsafe_originalRecipe = Symbol("unsafe_originalRecipe");
export const unsafe_parentRecipe = Symbol("unsafe_parentRecipe");
export const unsafe_materializeFactory = Symbol("unsafe_materializeFactory");

declare module "./interface.ts" {
  interface Recipe {
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    initial?: JSONValue;
    result: JSONValue;
    nodes: Node[];
    [unsafe_originalRecipe]?: Recipe;
    [unsafe_parentRecipe]?: Recipe;
    [unsafe_materializeFactory]?: (log: any) => (path: PropertyKey[]) => any;
  }
}

export function isRecipe(value: unknown): value is Recipe {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    !!(value as any).argumentSchema &&
    !!(value as any).resultSchema &&
    !!(value as any).nodes &&
    Array.isArray((value as any).nodes)
  );
}

type CanBeOpaqueRef = { [toOpaqueRef]: () => OpaqueRef<any> };

export function canBeOpaqueRef(value: unknown): value is CanBeOpaqueRef {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as any)[toOpaqueRef] === "function"
  );
}

export function makeOpaqueRef(value: CanBeOpaqueRef): OpaqueRef<any> {
  return value[toOpaqueRef]();
}

export const toOpaqueRef = Symbol("toOpaqueRef");

export type ShadowRef = {
  shadowOf: OpaqueRef<any> | ShadowRef;
};

export function isShadowRef(value: unknown): value is ShadowRef {
  return (
    !!value &&
    typeof value === "object" &&
    "shadowOf" in value &&
    (isOpaqueRef((value as ShadowRef).shadowOf) ||
      isShadowRef((value as ShadowRef).shadowOf))
  );
}

export type UnsafeBinding = {
  recipe: Recipe;
  materialize: (path: PropertyKey[]) => any;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  opaqueRefs: Set<OpaqueRef<any>>;
  unsafe_binding?: UnsafeBinding;
};

const isStaticMarker = Symbol("isStatic");

export type Static = {
  [isStaticMarker]: true;
};

export function isStatic(value: unknown): value is Static {
  return typeof value === "object" && value !== null &&
    (value as any)[isStaticMarker] === true;
}

export function markAsStatic(value: unknown): unknown {
  (value as any)[isStaticMarker] = true;
  return value;
}

// Builder functions interface
export interface BuilderFunctionsAndConstants {
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

  // Environment
  getRecipeEnvironment: GetRecipeEnvironmentFunction;

  // Constants
  ID: typeof ID;
  ID_FIELD: typeof ID_FIELD;
  TYPE: typeof TYPE;
  NAME: typeof NAME;
  UI: typeof UI;

  // Schema utilities
  schema: typeof schema;
  AuthSchema: typeof AuthSchema;
}

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
) => BuilderFunctionsAndConstants;
