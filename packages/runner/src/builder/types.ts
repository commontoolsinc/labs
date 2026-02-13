import { isObject, type Mutable } from "@commontools/utils/types";
import type { PatternBuilder } from "./pattern.ts";

import type {
  ActionFunction,
  AsCell,
  AsComparableCell,
  AsOpaqueCell,
  AsReadonlyCell,
  AsStream,
  AsWriteonlyCell,
  ByRefFunction,
  Cell,
  CellTypeConstructor,
  CompileAndRunFunction,
  ComputedFunction,
  DeriveFunction,
  EqualsFunction,
  FetchDataFunction,
  FetchProgramFunction,
  GenerateObjectFunction,
  GenerateTextFunction,
  GetEntityIdFunction,
  GetPatternEnvironmentFunction,
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
  OpaqueRef,
  Pattern,
  PatternFactory,
  PatternFunction,
  PatternToolFunction,
  schema as schemaFunction,
  SELF as SELFSymbol,
  StreamDataFunction,
  StrFunction,
  UnlessFunction,
  WhenFunction,
  WishFunction,
} from "@commontools/api";
import type { Schema } from "@commontools/api/schema";
import { toSchema } from "@commontools/api";
import { AuthSchema } from "./schema-lib.ts";
import {
  type IExtendedStorageTransaction,
  type MemorySpace,
} from "../storage/interface.ts";
import { type RuntimeProgram } from "../harness/types.ts";
import { type Runtime } from "../runtime.ts";

// Define runtime constants here - actual runtime values
export const ID: typeof IDSymbol = Symbol("ID, unique to the context") as any;
export const ID_FIELD: typeof IDFieldSymbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
) as any;

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over patterns.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

// Symbol for accessing self-reference in patterns
export const SELF: typeof SELFSymbol = Symbol("SELF") as any;

export const schema: typeof schemaFunction = (schema) => schema;

export { AuthSchema } from "./schema-lib.ts";
export type {
  AnyCell,
  AnyCellWrapping,
  Apply,
  AsCell,
  AsComparableCell,
  AsOpaqueCell,
  AsReadonlyCell,
  AsStream,
  AsWriteonlyCell,
  Cell,
  CellKind,
  CellTypeConstructor,
  Handler,
  HandlerFactory,
  HKT,
  ICell,
  IDerivable,
  IDFields,
  IKeyableOpaque,
  IOpaquable,
  IOpaqueCell,
  IsThisObject,
  IStreamable,
  JSONObject,
  JSONSchema,
  JSONSchemaTypes,
  JSONValue,
  KeyResultType,
  Module,
  ModuleFactory,
  NodeFactory,
  Opaque,
  OpaqueCell,
  OpaqueRef,
  Pattern,
  PatternFactory,
  PatternFunction,
  Props,
  RenderNode,
  Stream,
  StripCell,
  toJSON,
  ToSchemaFunction,
  UnwrapCell,
  VNode,
} from "@commontools/api";
export type { Schema, SchemaWithoutCell } from "@commontools/api/schema";

export type JSONSchemaMutable = Mutable<JSONSchemaObj>;

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueRef<T = any>(
  value: unknown,
): value is OpaqueRef<T> {
  return !!value &&
    typeof (value as { [isOpaqueRefMarker]: true })[isOpaqueRefMarker] ===
      "boolean";
}

export type NodeRef = {
  module: Module | Pattern | OpaqueRef<Module | Pattern>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

export type StreamValue = {
  $stream: true;
};

export function isStreamValue(value: unknown): value is StreamValue {
  return isObject(value) && "$stream" in value && value.$stream === true;
}

declare module "@commontools/api" {
  export interface Module {
    type: "ref" | "javascript" | "pattern" | "raw" | "isolated" | "passthrough";
    implementation?: ((...args: any[]) => any) | Pattern | string;
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    /** If true, this module is an effect (side-effectful) rather than a computation */
    isEffect?: boolean;
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

// Used to get back to original pattern from a JSONified representation.
export const unsafe_originalPattern = Symbol("unsafe_originalPattern");
export const unsafe_parentPattern = Symbol("unsafe_parentPattern");
export const unsafe_materializeFactory = Symbol("unsafe_materializeFactory");

declare module "@commontools/api" {
  interface Pattern {
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    initial?: JSONValue;
    result: JSONValue;
    nodes: Node[];
    program?: RuntimeProgram;
    [unsafe_originalPattern]?: Pattern;
    [unsafe_parentPattern]?: Pattern;
    [unsafe_materializeFactory]?: (
      tx: IExtendedStorageTransaction,
    ) => (path: readonly PropertyKey[]) => unknown;
  }
}

export function isPattern(value: unknown): value is Pattern {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    (value as Pattern).argumentSchema !== undefined &&
    (value as Pattern).resultSchema !== undefined &&
    Array.isArray((value as Pattern).nodes)
  );
}

export type UnsafeBinding = {
  pattern: Pattern;
  materialize: (path: readonly PropertyKey[]) => any;
  space: MemorySpace;
  tx: IExtendedStorageTransaction;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
  space?: MemorySpace;
  inHandler?: boolean;
  opaqueRefs: Set<OpaqueRef<any>>;
  unsafe_binding?: UnsafeBinding;
};

// Builder functions interface
export interface BuilderFunctionsAndConstants {
  // Pattern creation
  pattern: PatternBuilder;
  patternTool: PatternToolFunction;

  // Module creation
  lift: LiftFunction;
  handler: HandlerFunction;
  action: ActionFunction;
  derive: DeriveFunction;
  computed: ComputedFunction;

  // Built-in modules
  str: StrFunction;
  ifElse: IfElseFunction;
  when: WhenFunction;
  unless: UnlessFunction;
  llm: LLMFunction;
  llmDialog: LLMDialogFunction;
  generateObject: GenerateObjectFunction;
  generateText: GenerateTextFunction;
  fetchData: FetchDataFunction;
  fetchProgram: FetchProgramFunction;
  streamData: StreamDataFunction;
  compileAndRun: CompileAndRunFunction;
  navigateTo: NavigateToFunction;
  wish: WishFunction;

  // Cell creation
  cell: CellTypeConstructor<AsCell>["of"];
  equals: EqualsFunction;

  // Cell constructors with static methods
  Cell: CellTypeConstructor<AsCell>;
  Writable: CellTypeConstructor<AsCell>; // Alias for Cell with clearer write-access semantics
  OpaqueCell: CellTypeConstructor<AsOpaqueCell>;
  Stream: CellTypeConstructor<AsStream>;
  ComparableCell: CellTypeConstructor<AsComparableCell>;
  ReadonlyCell: CellTypeConstructor<AsReadonlyCell>;
  WriteonlyCell: CellTypeConstructor<AsWriteonlyCell>;

  // Utility
  byRef: ByRefFunction;

  // Environment
  getPatternEnvironment: GetPatternEnvironmentFunction;

  // Entity utilities
  getEntityId: GetEntityIdFunction;

  // Constants
  ID: typeof ID;
  ID_FIELD: typeof ID_FIELD;
  SELF: typeof SELF;
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
