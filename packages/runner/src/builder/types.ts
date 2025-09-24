import { isObject, type Mutable } from "@commontools/utils/types";
import { toOpaqueRef } from "../back-to-cell.ts";

import type {
  ByRefFunction,
  Cell,
  CellFunction,
  CompileAndRunFunction,
  ComputeFunction,
  CreateCellFunction,
  DeriveFunction,
  FetchDataFunction,
  GenerateObjectFunction,
  GetRecipeEnvironmentFunction,
  HandlerFunction,
  IfElseFunction,
  JSONSchema,
  JSONSchemaObj,
  JSONValue,
  LiftFunction,
  LLMDialogFunction,
  LLMFunction,
  Module,
  NavigateToFunction,
  Opaque,
  OpaqueRef,
  OpaqueRefMethods,
  Recipe,
  RecipeFunction,
  RenderFunction,
  Schema,
  StreamDataFunction,
  StreamFunction,
  StrFunction,
} from "@commontools/api";
import {
  h,
  ID,
  ID_FIELD,
  NAME,
  schema,
  toSchema,
  TYPE,
  UI,
} from "@commontools/api";
import { AuthSchema } from "./schema-lib.ts";
export { AuthSchema } from "./schema-lib.ts";
export {
  ID,
  ID_FIELD,
  NAME,
  type Schema,
  schema,
  type SchemaWithoutCell,
  toSchema,
  TYPE,
  UI,
} from "@commontools/api";
export { h } from "@commontools/api";
export type {
  Cell,
  CreateCellFunction,
  Handler,
  HandlerFactory,
  JSONObject,
  JSONSchema,
  JSONSchemaTypes,
  JSONValue,
  Module,
  ModuleFactory,
  NodeFactory,
  Opaque,
  OpaqueRef,
  Props,
  Recipe,
  RecipeFactory,
  RenderNode,
  Stream,
  StripCell,
  StripStream,
  NormalizeSchemaType,
  toJSON,
  VNode,
} from "@commontools/api";
import {
  type IExtendedStorageTransaction,
  type MemorySpace,
} from "../storage/interface.ts";
import { type RuntimeProgram } from "../harness/types.ts";

export type JSONSchemaMutable = Mutable<JSONSchemaObj>;

// Augment the public interface with the internal OpaqueRefMethods interface.
// Deliberately repeating the original interface to catch any inconsistencies:
// This here then reflects the entire interface the internal implementation
// implements.
declare module "@commontools/api" {
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
      path: readonly PropertyKey[];
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
      path: readonly PropertyKey[],
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

export type { OpaqueRefMethods };

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueRef<T = any>(
  value: unknown,
): value is OpaqueRefMethods<T> {
  return !!value &&
    typeof (value as OpaqueRef<T>)[isOpaqueRefMarker] === "boolean";
}

export type NodeRef = {
  module: Module | Recipe | OpaqueRef<Module | Recipe>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

// This is a schema, together with its rootSchema for resolving $ref entries
export type SchemaContext = {
  schema: JSONSchema;
  rootSchema: JSONSchema;
};

export type StreamValue = {
  $stream: true;
};

export function isStreamValue(value: unknown): value is StreamValue {
  return isObject(value) && "$stream" in value && value.$stream === true;
}

declare module "@commontools/api" {
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
  module: Module; // TODO(seefeld): Add `Alias` here once supported
  inputs: JSONValue;
  outputs: JSONValue;
};

// Used to get back to original recipe from a JSONified representation.
export const unsafe_originalRecipe = Symbol("unsafe_originalRecipe");
export const unsafe_parentRecipe = Symbol("unsafe_parentRecipe");
export const unsafe_materializeFactory = Symbol("unsafe_materializeFactory");

declare module "@commontools/api" {
  interface Recipe {
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    initial?: JSONValue;
    result: JSONValue;
    nodes: Node[];
    program?: RuntimeProgram;
    [unsafe_originalRecipe]?: Recipe;
    [unsafe_parentRecipe]?: Recipe;
    [unsafe_materializeFactory]?: (
      tx: IExtendedStorageTransaction,
    ) => (path: readonly PropertyKey[]) => unknown;
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
  materialize: (path: readonly PropertyKey[]) => any;
  space: MemorySpace;
  tx: IExtendedStorageTransaction;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  opaqueRefs: Set<OpaqueRef<any>>;
  unsafe_binding?: UnsafeBinding;
};

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
  llmDialog: LLMDialogFunction;
  generateObject: GenerateObjectFunction;
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
  toSchema: typeof toSchema;
  AuthSchema: typeof AuthSchema;

  // Render utils
  h: typeof h;
}

// Runtime interface needed by createCell
export interface BuilderRuntime {
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
}

// Factory function to create builder with runtime
export type CreateBuilder = (
  runtime: BuilderRuntime,
  getCellOrThrow?: (value: any) => any,
) => BuilderFunctionsAndConstants;
