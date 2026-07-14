import { isRecord } from "@commonfabric/utils/types";
import type { PatternBuilder } from "./pattern.ts";
import type { NormalizedFullLink } from "../link-types.ts";

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
  CellScope,
  CellTypeConstructor,
  CfDataFunction,
  CfSqliteHelpers,
  CompileAndRunFunction,
  ComputedFunction,
  EntityRefToStringFunction,
  EqualsFunction,
  FactoryInput,
  FetchBinaryFunction,
  FetchJsonFunction,
  FetchJsonUncheckedFunction,
  FetchProgramFunction,
  FetchTextFunction,
  GenerateObjectFunction,
  GenerateObjectStreamFunction,
  GenerateTextFunction,
  GenerateTextStreamFunction,
  GetEntityIdFunction,
  GetPatternEnvironmentFunction,
  HandlerFunction,
  HasErrorFunction,
  HasSchemaMismatchFunction,
  HFunction,
  ID as IDSymbol,
  ID_FIELD as IDFieldSymbol,
  IfElseFunction,
  InspectConfLabelFunction,
  IsPendingFunction,
  IsSyncingFunction,
  JSONSchema,
  JSONValue,
  JSXElement,
  LatestCompleteFunction,
  LiftFunction,
  LLMDialogFunction,
  LLMFunction,
  Module,
  NavigateToFunction,
  NonPrivateRandomFunction,
  ObserveAvailabilityFunction,
  PartialResultOfFunction,
  Pattern,
  PatternToolFunction,
  Reactive,
  ResultOfFunction,
  SafeDateNowFunction,
  schema as schemaFunction,
  SELF as SELFSymbol,
  SqliteCfLinkFunction,
  SqliteDatabaseFunction,
  SqliteQueryFunction,
  SqliteTableFunction,
  StreamDataFunction,
  StrFunction,
  UiActionProps,
  UiDisclosureProps,
  UiPromptSlotProps,
  UIVariantFunction,
  UnlessFunction,
  WhenFunction,
  WishFunction,
} from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { toSchema } from "@commonfabric/api";
import type { ImplementationIdentity } from "../cfc/types.ts";
import { AuthSchema, WebhookConfigSchema } from "./schema-lib.ts";
import {
  type IExtendedStorageTransaction,
  type MemorySpace,
} from "../storage/interface.ts";
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
// UI variants (CT-1321): optional sibling renderings addressed alongside [UI].
// chip = inline, tile = gallery/grid card; absent variants fail over to a
// per-variant default (see uiVariant()), with [UI] as the universal floor.
export const TILE_UI = "$TILE_UI";
export const CHIP_UI = "$CHIP_UI";
export const FS = "$FS";

// Symbol for accessing self-reference in patterns
export const SELF: typeof SELFSymbol = Symbol("SELF") as any;

export const schema: typeof schemaFunction = (schema) => schema;

export {
  AuthSchema,
  OAuth2TokenSchema,
  WebhookConfigSchema,
} from "./schema-lib.ts";
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
  CellScope,
  CellTypeConstructor,
  FabricValue,
  FactoryInput,
  FsProjection,
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
  JSONArray,
  JSONObject,
  JSONSchema,
  JSONSchemaMutable,
  JSONSchemaObj,
  JSONSchemaObjMutable,
  JSONSchemaTypes,
  JSONValue,
  KeyResultType,
  LinkScope,
  Module,
  ModuleFactory,
  NodeFactory,
  OpaqueCell,
  Pattern,
  PatternFactory,
  PatternFunction,
  Props,
  Reactive,
  RenderNode,
  RequireDefaults,
  SchemaScope,
  Stream,
  StripCell,
  StripDefaultBrand,
  toJSON,
  ToSchemaFunction,
  UiActionProps,
  UiDisclosureProps,
  UiPromptSlotProps,
  UnavailableInputPolicy,
  UnavailableInputPolicyEntry,
  UnwrapCell,
  VNode,
} from "@commonfabric/api";
export type { AsCellEntry } from "@commonfabric/api";
export type { Schema, SchemaWithoutCell } from "@commonfabric/api/schema";

export const isReactiveMarker = Symbol("isReactive");

export function isReactive<T = any>(
  value: unknown,
): value is Reactive<T> {
  return !!value &&
    typeof (value as { [isReactiveMarker]: true })[isReactiveMarker] ===
      "boolean";
}

export type NodeRef = {
  module: Module | Pattern | Reactive<Module | Pattern>;
  inputs: FactoryInput<any>;
  outputs: Reactive<any>;
  frame: Frame | undefined;
};

export type StreamValue = {
  $stream: true;
};

export function isStreamValue(value: unknown): value is StreamValue {
  return isRecord(value) && "$stream" in value && value.$stream === true;
}

declare module "@commonfabric/api" {
  export interface Module {
    type:
      | "ref"
      | "javascript"
      | "javascript-availability"
      | "pattern"
      | "raw"
      | "isolated"
      | "passthrough";
    implementation?: ((...args: any[]) => any) | Pattern | string;
    /**
     * Content-addressed reference to the module-scope builder artifact whose
     * implementation this module runs: the defining module's content identity
     * and the artifact's export/`__cfReg` symbol — the ONLY serialized
     * identity (see docs/specs/content-addressed-action-identity.md).
     */
    $implRef?: { identity: string; symbol: string };
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    writableProxy?: boolean;
    propagateInputIfc?: boolean;
    /** If true, this module is an effect (side-effectful) rather than a computation */
    isEffect?: boolean;
    /** Optional scheduler debounce delay in milliseconds */
    debounce?: number;
    /** Opt out of scheduler auto-debounce */
    noDebounce?: boolean;
    /** Optional scheduler throttle period in milliseconds */
    throttle?: number;
    /** Pull-mode write envelopes for broad/dynamic writable-input materializers */
    materializerWriteEnvelopes?: readonly NormalizedFullLink[];
    /**
     * Exhaustive analyzed record of input paths the module may write. Only
     * writable-branded paths become materializer envelopes; stream paths
     * stay in the record (they disqualify pure-derivation treatment) but
     * are never collectible. Presence of this field, even empty, bypasses
     * the opaque-result envelope fallback.
     */
    materializerWriteInputPaths?: readonly (readonly string[])[];
    /**
     * Transformer proof that this source-backed lift's cell surface is
     * exhaustively described by its structural bindings.  Absence means
     * unknown/incomplete; raw modules and handlers never receive this marker.
     */
    completeSchedulerScopeSummary?: true;
    /** Run this module's result in a specific space. */
    targetSpace?: MemorySpace;
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

export type DerivedInternalCellDescriptor = {
  partialCause: JSONValue;
  schema?: JSONSchema;
  scope?: CellScope;
};

declare module "@commonfabric/api" {
  interface Pattern {
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    derivedInternalCells?: DerivedInternalCellDescriptor[];
    result: JSONValue;
    nodes: Node[];
    // NOTE: `program` (rehydration source) and the derivation link to a
    // copy's original live in WeakMaps/WeakSets in ./pattern-metadata.ts (so
    // exported patterns can be frozen, and so no own property can carry
    // trust). Use get/setPatternProgram, noteDerivedCopy/resolveOriginal.
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

export type SourceLocationContext = {
  script: string;
  filename: string;
  nextSearchOffset: number;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  implementationIdentity?: ImplementationIdentity;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
  space?: MemorySpace;
  inHandler?: boolean;
  reactives: Set<Reactive<any>>;
  unsafe_binding?: UnsafeBinding;
  sourceLocationContext?: SourceLocationContext;
  /**
   * Named/anonymous `PatternFactory.inSpace(...)` targets encountered during
   * this frame whose space DID was not yet cached. The runner resolves these
   * after the run and re-runs (see RetryImmediately).
   */
  pendingSpaceNames?: Set<string>;
  /** Per-frame counter giving each anonymous `inSpace()` call a stable name. */
  inSpaceCounter?: number;
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
  computed: ComputedFunction;

  // Availability observation
  isPending: IsPendingFunction;
  hasError: HasErrorFunction;
  isSyncing: IsSyncingFunction;
  hasSchemaMismatch: HasSchemaMismatchFunction;
  observeAvailability: ObserveAvailabilityFunction;
  resultOf: ResultOfFunction;
  partialResultOf: PartialResultOfFunction;
  latestComplete: LatestCompleteFunction;

  // Built-in modules
  str: StrFunction;
  ifElse: IfElseFunction;
  when: WhenFunction;
  unless: UnlessFunction;
  uiVariant: UIVariantFunction;
  llm: LLMFunction;
  llmDialog: LLMDialogFunction;
  generateObject: GenerateObjectFunction;
  generateObjectStream: GenerateObjectStreamFunction;
  generateText: GenerateTextFunction;
  generateTextStream: GenerateTextStreamFunction;
  fetchBinary: FetchBinaryFunction;
  fetchText: FetchTextFunction;
  fetchJson: FetchJsonFunction;
  fetchJsonUnchecked: FetchJsonUncheckedFunction;
  fetchProgram: FetchProgramFunction;
  streamData: StreamDataFunction;
  compileAndRun: CompileAndRunFunction;
  sqliteDatabase: SqliteDatabaseFunction;
  sqliteQuery: SqliteQueryFunction;
  table: SqliteTableFunction;
  cfLink: SqliteCfLinkFunction;
  cfSqlite: CfSqliteHelpers;
  navigateTo: NavigateToFunction;
  inspectConfLabel: InspectConfLabelFunction;
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
  nonPrivateRandom: NonPrivateRandomFunction;
  safeDateNow: SafeDateNowFunction;

  // Entity utilities
  getEntityId: GetEntityIdFunction;
  entityRefToString: EntityRefToStringFunction;

  // Constants
  ID: typeof ID;
  ID_FIELD: typeof ID_FIELD;
  SELF: typeof SELF;
  TYPE: typeof TYPE;
  NAME: typeof NAME;
  UI: typeof UI;
  TILE_UI: typeof TILE_UI;
  CHIP_UI: typeof CHIP_UI;
  FS: typeof FS;

  // Schema utilities
  schema: typeof schema;
  toSchema: typeof toSchema;
  __cf_data: CfDataFunction;
  AuthSchema: typeof AuthSchema;
  WebhookConfigSchema: typeof WebhookConfigSchema;

  // Render utils
  h: HFunction;
  UiAction: (props: UiActionProps) => JSXElement;
  UiPromptSlot: (props: UiPromptSlotProps) => JSXElement;
  UiDisclosure: (props: UiDisclosureProps) => JSXElement;

  // Fabric value classes
  FabricInstance:
    typeof import("@commonfabric/data-model/fabric-value").FabricInstance;
  FabricPrimitive:
    typeof import("@commonfabric/data-model/fabric-value").FabricPrimitive;
  FabricEpochNsec:
    typeof import("@commonfabric/data-model/fabric-primitives").FabricEpochNsec;
  FabricEpochDays:
    typeof import("@commonfabric/data-model/fabric-primitives").FabricEpochDays;
  FabricHash:
    typeof import("@commonfabric/data-model/fabric-primitives").FabricHash;

  // Debug stringifiers
  toCompactDebugString:
    typeof import("@commonfabric/data-model/value-debug").toCompactDebugString;
  toIndentedDebugString:
    typeof import("@commonfabric/data-model/value-debug").toIndentedDebugString;
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
