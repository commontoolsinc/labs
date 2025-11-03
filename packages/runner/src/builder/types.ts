import { isObject, type Mutable } from "@commontools/utils/types";
import { toOpaqueRef } from "../back-to-cell.ts";
import type { SchemaContext } from "@commontools/memory/interface";

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
  HFunction,
  ID as IDSymbol,
  ID_FIELD as IDFieldSymbol,
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
  OpaqueCell,
  OpaqueRef,
  PatternToolFunction,
  Recipe,
  RecipeFunction,
  RenderFunction,
  Schema,
  schema as schemaFunction,
  StreamDataFunction,
  StreamFunction,
  StrFunction,
  WishFunction,
} from "@commontools/api";
import { toSchema } from "@commontools/api";
import { AuthSchema } from "./schema-lib.ts";
import {
  type IExtendedStorageTransaction,
  type MemorySpace,
} from "../storage/interface.ts";
import { type RuntimeProgram } from "../harness/types.ts";

// Define runtime constants here - actual runtime values
export const ID: typeof IDSymbol = Symbol("ID, unique to the context") as any;
export const ID_FIELD: typeof IDFieldSymbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
) as any;

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

export const schema: typeof schemaFunction = (schema) => schema;

export { AuthSchema } from "./schema-lib.ts";
export type {
  AnyCell,
  Cell,
  CreateCellFunction,
  Handler,
  HandlerFactory,
  IDerivable,
  IDFields,
  IKeyableOpaque,
  IOpaquable,
  IOpaqueCell,
  JSONObject,
  JSONSchema,
  JSONSchemaTypes,
  JSONValue,
  Module,
  ModuleFactory,
  NodeFactory,
  Opaque,
  OpaqueCell,
  OpaqueRef,
  Props,
  Recipe,
  RecipeFactory,
  RenderNode,
  Schema,
  SchemaWithoutCell,
  Stream,
  StripCell,
  toJSON,
  ToSchemaFunction,
  UnwrapCell,
  VNode,
} from "@commontools/api";

export type JSONSchemaMutable = Mutable<JSONSchemaObj>;

// Augment the public interface with the internal OpaqueRefMethods interface.
// This adds runtime-specific methods beyond what the public API defines.
declare module "@commontools/api" {
  interface IOpaquable<T> {
    // Export method for introspection
    export(): {
      cell: OpaqueCell<any>;
      path: readonly PropertyKey[];
      value?: Opaque<T> | T;
      defaultValue?: Opaque<T>;
      nodes: Set<NodeRef>;
      external?: unknown;
      name?: string;
      schema?: JSONSchema;
      rootSchema?: JSONSchema;
      frame: Frame;
    };

    connect(node: NodeRef): void;

    // Unsafe methods for internal use
    unsafe_bindToRecipeAndPath(
      recipe: Recipe,
      path: readonly PropertyKey[],
    ): void;
    unsafe_getExternal(): OpaqueCell<T>;

    // Additional utility methods
    toJSON(): unknown;
    [Symbol.iterator](): Iterator<T>;
    [Symbol.toPrimitive](hint: string): T;
    [isOpaqueRefMarker]: true;
  }
}

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueCell<T = any>(
  value: unknown,
): value is OpaqueCell<T> {
  return !!value &&
    typeof (value as { [isOpaqueRefMarker]: true })[isOpaqueRefMarker] ===
      "boolean";
}

export type NodeRef = {
  module: Module | Recipe | OpaqueCell<Module | Recipe>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

export type { SchemaContext };

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
    (isOpaqueCell((value as ShadowRef).shadowOf) ||
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
  patternTool: PatternToolFunction;

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
  wish: WishFunction;

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
  h: HFunction;
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
