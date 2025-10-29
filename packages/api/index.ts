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

// ============================================================================
// Cell Brand System
// ============================================================================

/**
 * Brand symbol for identifying different cell types at compile-time.
 * Each cell variant has a unique combination of capability flags.
 */
export declare const CELL_BRAND: unique symbol;

/**
 * Minimal cell type with just the brand, no methods.
 * Used for type-level operations like unwrapping nested cells without
 * creating circular dependencies.
 */
export type BrandedCell<T, Brand extends string = string> = {
  [CELL_BRAND]: Brand;
};

// ============================================================================
// Cell Capability Interfaces
// ============================================================================

// deno-lint-ignore no-empty-interface
export interface IAnyCell<T> {
}

/**
 * Readable cells can retrieve their current value.
 */
export interface IReadable<T> {
  get(): Readonly<T>;
}

/**
 * Writable cells can update their value.
 */
export interface IWritable<T> {
  set(value: T | AnyCellWrapping<T>): void;
  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    values: V extends object ? V : never,
  ): void;
  push(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : any[]
  ): void;
}

/**
 * Streamable cells can send events.
 */
export interface IStreamable<T> {
  send(event: AnyCellWrapping<T>): void;
}

// Lightweight HKT, so we can pass cell types to IKeyable<>.
interface HKT {
  _A: unknown;
  type: unknown;
}
type Apply<F extends HKT, A> = (F & { _A: A })["type"];

/**
 * A key-addressable, **covariant** view over a structured value `T`.
 *
 * `IKeyableCell` exposes a single method, {@link IKeyableCell.key}, which selects a
 * property from the (possibly branded) value `T` and returns it wrapped in a
 * user-provided type constructor `Wrap` (default: `Cell<…>`). The interface is
 * declared `out T` (covariant) and is designed so that calling `key` preserves
 * both type inference and variance soundness.
 *
 * @template T
 * The underlying (possibly branded) value type. `T` is treated **covariantly**:
 * `IKeyableCell<Sub>` is assignable to `IKeyableCell<Super>` when `Sub` is
 * assignable to `Super`.
 *
 * @template Wrap extends HKT
 * A lightweight higher-kinded “wrapper” that determines the return container for
 * selected fields. For example, `AsCell` wraps as `Cell<A>`, while other wrappers
 * can project to `ReadonlyCell<A>`, `Stream<A>`, etc. Defaults to `AsCell`.
 *
 * @template Any
 * The “fallback” return type used when the provided key does not match a known
 * key (or is widened to `any`). This should usually be `Apply<Wrap, any>`.
 *
 * @remarks
 * ### Variance & soundness
 * The `key` signature is crafted to remain **covariant in `T`**. Internally,
 * it guards the instantiation `K = any` with `unknown extends K ? … : …`, so
 * the return type becomes `Any` (independent of `T`) in that case. For real keys
 * (`K extends keyof UnwrapCell<T>`), the return type is precise and fully inferred.
 *
 * ### Branded / nested cells
 * If a selected property is itself a branded cell (e.g., `BrandedCell<U>`),
 * the brand is unwrapped so that the return becomes `Wrap<U>` rather than
 * `Wrap<BrandedCell<U>>`. This keeps nested cell layers from accumulating at
 * property boundaries.
 *
 * ### Key inference
 * Passing a string/number/symbol that is a literal and a member of
 * `keyof UnwrapCell<T>` yields precise field types; non-literal or unknown keys
 * fall back to `Any` (e.g., `Cell<any>`).
 *
 * @example
 * // Basic usage with the default wrapper (Cell)
 * declare const userCell: IKeyableCell<{ id: string; profile: { name: string } }>;
 * const idCell = userCell.key("id");         // Cell<string>
 * const profileCell = userCell.key("profile"); // Cell<{ name: string }>
 *
 * // Unknown key falls back to Any (default: Cell<any>)
 * const whatever = userCell.key(Symbol());   // Cell<any>
 *
 * @example
 * // Using a custom wrapper, e.g., ReadonlyCell<A>
 * interface AsReadonlyCell extends HKT { type: ReadonlyCell<this["_A"]> }
 * type ReadonlyUserCell = IKeyableCell<{ id: string }, AsReadonlyCell, Apply<AsReadonlyCell, any>>;
 * declare const ro: ReadonlyUserCell;
 * const idRO = ro.key("id"); // ReadonlyCell<string>
 *
 * @example
 * // Covariance works:
 * declare const sub: IKeyableCell<{ a: string }>;
 * const superCell: IKeyableCell<unknown> = sub; // OK (out T)
 */
export interface IKeyable<out T, Wrap extends HKT> {
  key<K extends PropertyKey>(valueKey: K): KeyResultType<T, K, Wrap>;
}

export type KeyResultType<T, K, Wrap extends HKT> = unknown extends K
  ? Apply<Wrap, any> // variance guard for K = any
  : K extends keyof UnwrapCell<T> ? (
      0 extends (1 & T) ? Apply<Wrap, any>
        : UnwrapCell<T>[K] extends never ? Apply<Wrap, any>
        : T extends BrandedCell<any, any>
          ? T extends { key(k: K): infer R } ? 0 extends (1 & R) ? Apply<
                Wrap,
                UnwrapCell<T>[K] extends BrandedCell<infer U, any> ? U
                  : UnwrapCell<T>[K]
              >
            : R
          : Apply<
            Wrap,
            UnwrapCell<T>[K] extends BrandedCell<infer U, any> ? U
              : UnwrapCell<T>[K]
          >
        : Apply<Wrap, UnwrapCell<T>[K]>
    )
  : Apply<Wrap, any>;

/**
 * Cells that support key() for property access - OpaqueCell variant.
 * OpaqueCell is "sticky" and always returns OpaqueCell<>.
 */
export interface IKeyableOpaque<T> {
  key<K extends PropertyKey>(
    valueKey: K,
  ): unknown extends K ? OpaqueCell<any>
    : K extends keyof UnwrapCell<T> ? (0 extends (1 & T) ? OpaqueCell<any>
        : UnwrapCell<T>[K] extends never ? OpaqueCell<any>
        : UnwrapCell<T>[K] extends BrandedCell<infer U> ? OpaqueCell<U>
        : OpaqueCell<UnwrapCell<T>[K]>)
    : OpaqueCell<any>;
}

/**
 * Cells that can be resolved back to a Cell.
 * Only available on full Cell<T>, not on OpaqueCell or Stream.
 */
export interface IResolvable<T, C extends BrandedCell<T>> {
  resolveAsCell(): C;
}

/**
 * Comparable cells have equals() method.
 * Available on comparable and readable cells.
 */
export interface IEquatable {
  equals(other: AnyCell<any> | object): boolean;
}

/**
 * Cells that allow deriving new cells from existing cells. Currently just
 * .map(), but this will eventually include all Array, String and Number
 * methods.
 */
export interface IDerivable<T> {
  map<S>(
    fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => Opaque<S>,
  ): OpaqueRef<S[]>;
  mapWithPattern<S>(
    op: Recipe,
    params: Record<string, any>,
  ): OpaqueRef<S[]>;
}

export interface IOpaquable<T> {
  /** deprecated */
  get(): T;
  /** deprecated */
  set(newValue: Opaque<Partial<T>>): void;
  /** deprecated */
  setDefault(value: Opaque<T> | T): void;
  /** deprecated */
  setPreExisting(ref: any): void;
  /** deprecated */
  setName(name: string): void;
  /** deprecated */
  setSchema(schema: JSONSchema): void;
}

// ============================================================================
// Cell Type Definitions
// ============================================================================

/**
 * Base type for all cell variants that has methods. Internal API augments this
 * interface with internal only API. Uses a second symbol brand to distinguish
 * from core cell brand without any methods.
 */
export interface AnyCell<T = unknown> extends BrandedCell<T>, IAnyCell<T> {
}

/**
 * Opaque cell reference - only supports keying and derivation, not direct I/O.
 * Has .key(), .map(), .mapWithPattern()
 * Does NOT have .get()/.set()/.send()/.equals()/.resolveAsCell()
 */
export interface IOpaqueCell<T>
  extends IKeyableOpaque<T>, IDerivable<T>, IOpaquable<T> {}

export interface OpaqueCell<T>
  extends BrandedCell<T, "opaque">, IOpaqueCell<T> {}

/**
 * Full cell with read, write capabilities.
 * Has .get(), .set(), .update(), .push(), .equals(), .key(), .resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface AsCell extends HKT {
  type: Cell<this["_A"]>;
}

export interface ICell<T>
  extends
    IAnyCell<T>,
    IReadable<T>,
    IWritable<T>,
    IStreamable<T>,
    IEquatable,
    IKeyable<T, AsCell>,
    IResolvable<T, Cell<T>> {}

export interface Cell<T = unknown> extends BrandedCell<T, "cell">, ICell<T> {}

/**
 * Stream-only cell - can only send events, not read or write.
 * Has .send() only
 * Does NOT have .key()/.equals()/.get()/.set()/.resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface Stream<T>
  extends BrandedCell<T, "stream">, IAnyCell<T>, IStreamable<T> {}

/**
 * Comparable-only cell - just for equality checks and keying.
 * Has .equals(), .key()
 * Does NOT have .resolveAsCell()/.get()/.set()/.send()
 */
interface AsComparableCell extends HKT {
  type: ComparableCell<this["_A"]>;
}

export interface ComparableCell<T>
  extends
    BrandedCell<T, "comparable">,
    IAnyCell<T>,
    IEquatable,
    IKeyable<T, AsComparableCell> {}

/**
 * Read-only cell variant.
 * Has .get(), .equals(), .key()
 * Does NOT have .resolveAsCell()/.set()/.send()
 */
interface AsReadonlyCell extends HKT {
  type: ReadonlyCell<this["_A"]>;
}

export interface ReadonlyCell<T>
  extends
    BrandedCell<T, "readonly">,
    IAnyCell<T>,
    IReadable<T>,
    IEquatable,
    IKeyable<T, AsReadonlyCell> {}

/**
 * Write-only cell variant.
 * Has .set(), .update(), .push(), .key()
 * Does NOT have .resolveAsCell()/.get()/.equals()/.send()
 */
interface AsWriteonlyCell extends HKT {
  type: WriteonlyCell<this["_A"]>;
}

export interface WriteonlyCell<T>
  extends
    BrandedCell<T, "writeonly">,
    IAnyCell<T>,
    IWritable<T>,
    IKeyable<T, AsWriteonlyCell> {}

// ============================================================================
// OpaqueRef - Proxy-based variant of OpaqueCell
// ============================================================================

/**
 * OpaqueRef is a variant of OpaqueCell with recursive proxy behavior.
 * Each key access returns another OpaqueRef, allowing chained property access.
 * This is temporary until AST transformation handles .key() automatically.
 */
export type OpaqueRef<T> =
  & OpaqueCell<T>
  & (T extends Array<infer U> ? Array<OpaqueRef<U>>
    : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
    : T);

// ============================================================================
// CellLike and Opaque - Utility types for accepting cells
// ============================================================================

/**
 * CellLike is a cell (AnyCell) whose nested values are Opaque.
 * The top level must be AnyCell, but nested values can be plain or wrapped.
 *
 * Note: This is primarily used for type constraints that require a cell.
 */
export type CellLike<T> = AnyCell<T>;

/**
 * Opaque accepts T or any cell wrapping T, recursively at any nesting level.
 * Used in APIs that accept inputs from developers - can be static values
 * or wrapped in cells (OpaqueRef, Cell, etc).
 *
 * Conceptually: T | AnyCell<T> at any nesting level, but we use OpaqueRef
 * for backward compatibility since it has the recursive proxy behavior that
 * allows property access (e.g., Opaque<{foo: string}> includes {foo: Opaque<string>}).
 */
export type Opaque<T> =
  | T
  | OpaqueRef<T>
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

/**
 * Recursively unwraps BrandedCell types at any nesting level.
 * UnwrapCell<BrandedCell<BrandedCell<string>>> = string
 * UnwrapCell<BrandedCell<{ a: BrandedCell<number> }>> = { a: BrandedCell<number> }
 *
 * Special cases:
 * - UnwrapCell<any> = any
 * - UnwrapCell<unknown> = unknown (preserves unknown)
 */
export type UnwrapCell<T> =
  // Preserve any
  0 extends (1 & T) ? T
    // Unwrap BrandedCell
    : T extends BrandedCell<infer S> ? UnwrapCell<S>
    // Otherwise return as-is
    : T;

/**
 * AnyCellWrapping is used for write operations (.set(), .push(), .update()). It
 * is a type utility that allows any part of type T to be wrapped in AnyCell<>,
 * and allow any part of T that is currently wrapped in AnyCell<> to be used
 * unwrapped. This is designed for use with cell method parameters, allowing
 * flexibility in how values are passed. The ID and ID_FIELD metadata symbols
 * allows controlling id generation and can only be passed to write operations.
 */
export type AnyCellWrapping<T> =
  // Handle existing BrandedCell<> types, allowing unwrapping
  T extends BrandedCell<infer U>
    ? AnyCellWrapping<U> | BrandedCell<AnyCellWrapping<U>>
    // Handle arrays
    : T extends Array<infer U>
      ? Array<AnyCellWrapping<U>> | BrandedCell<Array<AnyCellWrapping<U>>>
    // Handle objects (excluding null)
    : T extends object ?
        | { [K in keyof T]: AnyCellWrapping<T[K]> }
          & { [ID]?: AnyCellWrapping<JSONValue>; [ID_FIELD]?: string }
        | BrandedCell<{ [K in keyof T]: AnyCellWrapping<T[K]> }>
    // Handle primitives
    : T | BrandedCell<T>;

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
export type JSONSchema = JSONSchemaObj | boolean;

export type JSONSchemaObj = {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JSONSchema>>;
  /** @deprecated Use `$defs` for 2019-09/Draft 8 or later */
  readonly definitions?: Readonly<Record<string, JSONSchema>>;

  // Subschema logic
  readonly allOf?: readonly (JSONSchema)[]; // not validated
  readonly anyOf?: readonly (JSONSchema)[]; // not always validated
  readonly oneOf?: readonly (JSONSchema)[]; // not always validated
  readonly not?: JSONSchema;
  // Subschema conditionally - none applied
  readonly if?: JSONSchema;
  readonly then?: JSONSchema;
  readonly else?: JSONSchema;
  readonly dependentSchemas?: Readonly<Record<string, JSONSchema>>;
  // Subschema for array
  readonly prefixItems?: readonly (JSONSchema)[]; // not always validated
  readonly items?: Readonly<JSONSchema>;
  readonly contains?: JSONSchema; // not validated
  // Subschema for object
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly patternProperties?: Readonly<Record<string, JSONSchema>>; // not validated
  readonly additionalProperties?: JSONSchema;
  readonly propertyNames?: JSONSchema; // not validated

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
  readonly contentSchema?: JSONSchema;

  // Meta-Data
  readonly title?: string;
  readonly description?: string;
  readonly default?: Readonly<JSONValue>;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly Readonly<JSONValue>[];
  readonly $schema?: string;
  readonly $comment?: string;

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

// LLM types matching Vercel AI SDK structure
export type BuiltInLLMTextPart = {
  type: "text";
  text: string;
};

export type BuiltInLLMImagePart = {
  type: "image";
  image: string | Uint8Array | ArrayBuffer | URL;
};

export type BuiltInLLMToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, any>;
};

export type BuiltInLLMToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "json"; value: any };
};

export type BuiltInLLMContentPart =
  | BuiltInLLMTextPart
  | BuiltInLLMImagePart
  | BuiltInLLMToolCallPart
  | BuiltInLLMToolResultPart;

export type BuiltInLLMContent = string | BuiltInLLMContentPart[];

export type BuiltInLLMMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: BuiltInLLMContent;
};

export type BuiltInLLMTool =
  & { description?: string }
  & (
    | { pattern: Recipe; handler?: never }
    | { handler: Stream<any> | OpaqueRef<any>; pattern?: never }
  );

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
  tools?: Record<string, BuiltInLLMTool>;
}

export interface BuiltInLLMState {
  pending: boolean;
  result?: BuiltInLLMContent;
  partial?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMGenerateObjectState<T> {
  pending: boolean;
  result?: T;
  partial?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMDialogState {
  pending: boolean;
  error: unknown;
  cancelGeneration: Stream<void>;
  addMessage: Stream<BuiltInLLMMessage>;
  flattenedTools: Record<string, any>;
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

export type PatternToolFunction = <
  T,
  E extends Partial<T> = Record<PropertyKey, never>,
>(
  fnOrRecipe: ((input: OpaqueRef<Required<T>>) => any) | RecipeFactory<T, any>,
  extraParams?: Opaque<E>,
) => OpaqueRef<Omit<T, keyof E>>;

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

export type DeriveFunction = {
  <
    InputSchema extends JSONSchema = JSONSchema,
    ResultSchema extends JSONSchema = JSONSchema,
  >(
    argumentSchema: InputSchema,
    resultSchema: ResultSchema,
    input: Opaque<SchemaWithoutCell<InputSchema>>,
    f: (
      input: Schema<InputSchema>,
    ) => Schema<ResultSchema>,
  ): OpaqueRef<SchemaWithoutCell<ResultSchema>>;

  <In, Out>(
    input: Opaque<In>,
    f: (input: In) => Out,
  ): OpaqueRef<Out>;
};

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

export type LLMFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState>;

export type LLMDialogFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMDialogState>;

export type GenerateObjectFunction = <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

export type FetchOptions = {
  body?: JSONValue;
  headers?: Record<string, string>;
  cache?:
    | "default"
    | "no-store"
    | "reload"
    | "no-cache"
    | "force-cache"
    | "only-if-cached";
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
  redirect?: "follow" | "error" | "manual";
};
export type FetchDataFunction = <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error: any }>;

export type StreamDataFunction = <T>(
  params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error: any }>;

export type CompileAndRunFunction = <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<string>;
export type WishFunction = {
  <T = unknown>(target: Opaque<string>): OpaqueRef<T | undefined>;
  <T = unknown>(
    target: Opaque<string>,
    defaultValue: Opaque<T>,
  ): OpaqueRef<T>;
};

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
export declare const patternTool: PatternToolFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const derive: DeriveFunction;
export declare const compute: ComputeFunction;
export declare const render: RenderFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const llm: LLMFunction;
export declare const llmDialog: LLMDialogFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const fetchData: FetchDataFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
export declare const wish: WishFunction;
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
export const toSchema = <T>(_options?: Partial<JSONSchema>): JSONSchema => {
  return {} as JSONSchema;
};

// Helper type to transform Cell<T> to Opaque<T> in handler inputs
export type StripCell<T> = T extends Cell<infer U> ? StripCell<U>
  : T extends Array<infer U> ? StripCell<U>[]
  : T extends object ? { [K in keyof T]: StripCell<T[K]> }
  : T;

export type WishKey = `/${string}` | `#${string}`;

// ===== JSON Pointer Path Resolution Utilities =====

/**
 * Split a JSON Pointer reference into path segments.
 *
 * Examples:
 * - "#" -> []
 * - "#/$defs/Address" -> ["$defs", "Address"]
 * - "#/properties/name" -> ["properties", "name"]
 *
 * Note: Does not handle JSON Pointer escaping (~0, ~1) at type level.
 * Refs with ~ in keys will not work correctly in TypeScript types.
 */
type SplitPath<S extends string> = S extends "#" ? []
  : S extends `#/${infer Rest}` ? SplitPathSegments<Rest>
  : never;

type SplitPathSegments<S extends string> = S extends
  `${infer First}/${infer Rest}` ? [First, ...SplitPathSegments<Rest>]
  : [S];

/**
 * Navigate through a schema following a path of keys.
 * Returns never if the path doesn't exist.
 */
type NavigatePath<
  Schema extends JSONSchema,
  Path extends readonly string[],
  Depth extends DepthLevel = 9,
> = Depth extends 0 ? unknown
  : Path extends readonly [
    infer First extends string,
    ...infer Rest extends string[],
  ]
    ? Schema extends Record<string, any>
      ? First extends keyof Schema
        ? NavigatePath<Schema[First], Rest, DecrementDepth<Depth>>
      : never
    : never
  : Schema;

/**
 * Resolve a $ref string to the target schema.
 *
 * Supports:
 * - "#" (self-reference to root)
 * - "#/path/to/def" (JSON Pointer within document)
 *
 * External refs (URLs) return any.
 */
type ResolveRef<
  RefString extends string,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefString extends "#" ? Root
  : RefString extends `#/${string}`
    ? SplitPath<RefString> extends infer Path extends readonly string[]
      ? NavigatePath<Root, Path, Depth>
    : never
  : any; // External ref

/**
 * Merge two schemas, with left side taking precedence.
 * Used to apply ref site siblings to resolved target schema.
 */
type MergeSchemas<
  Left extends JSONSchema,
  Right extends JSONSchema,
> = Left extends boolean ? Left
  : Right extends boolean ? Right extends true ? Left
    : false
  : {
    [K in keyof Left | keyof Right]: K extends keyof Left ? Left[K]
      : K extends keyof Right ? Right[K]
      : never;
  };

/**
 * Merge ref site schema with resolved target, then process with Schema<>.
 * Implements JSON Schema spec: ref site siblings override target.
 */
type MergeRefSiteWithTarget<
  RefSite extends JSONSchema,
  Target extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefSite extends { $ref: string }
  ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends
    infer Merged extends JSONSchema ? Schema<Merged, Root, Depth>
  : never
  : never;

/**
 * Merge ref site schema with resolved target, then process with SchemaWithoutCell<>.
 * Same as MergeRefSiteWithTarget but doesn't wrap in Cell/Stream.
 */
type MergeRefSiteWithTargetWithoutCell<
  RefSite extends JSONSchema,
  Target extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefSite extends { $ref: string }
  ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends
    infer Merged extends JSONSchema ? SchemaWithoutCell<Merged, Root, Depth>
  : never
  : never;

/**
 * Convert a JSON Schema to its TypeScript type equivalent.
 *
 * Supports:
 * - Primitive types (string, number, boolean, null)
 * - Objects with properties (required/optional)
 * - Arrays with items
 * - anyOf unions
 * - $ref resolution (including JSON Pointers)
 * - asCell/asStream reactive wrappers
 * - default values (makes properties required)
 *
 * $ref Support:
 * - "#" (self-reference to root schema)
 * - "#/$defs/Name" (JSON Pointer to definition)
 * - "#/properties/field" (JSON Pointer to any schema location)
 * - External refs (http://...) return type `any`
 *
 * Default Precedence:
 * When both ref site and target have `default`, ref site takes precedence
 * per JSON Schema 2020-12 specification.
 *
 * Limitations:
 * - JSON Pointer escaping (~0, ~1) not supported at type level
 * - Depth limited to 9 levels to prevent infinite recursion
 * - Complex allOf/oneOf logic may not match runtime exactly
 *
 * @template T - The JSON Schema to convert
 * @template Root - Root schema for $ref resolution
 * @template Depth - Recursion depth limit (0-9)
 */
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
    // Handle $ref: "#" (self-reference) specially to preserve recursion
    : T extends { $ref: "#" }
      ? Schema<Omit<Root, "asCell" | "asStream">, Root, DecrementDepth<Depth>>
    // Handle $ref - resolve and merge with ref site schema
    : T extends { $ref: infer RefStr extends string } ? MergeRefSiteWithTarget<
        T,
        ResolveRef<RefStr, Root, DecrementDepth<Depth>>,
        Root,
        DecrementDepth<Depth>
      >
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
            T extends { additionalProperties: infer AP extends JSONSchema } ? AP
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
  AP extends JSONSchema = false,
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

// Same as above, but ignoring asCell, so we never get cells. This is used for
// calls of lifted functions and handlers, since they can pass either cells or
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
    // Handle $ref: "#" (self-reference) specially to preserve recursion
    : T extends { $ref: "#" } ? SchemaWithoutCell<
        Omit<Root, "asCell" | "asStream">,
        Root,
        DecrementDepth<Depth>
      >
    // Handle $ref - resolve and merge with ref site schema
    : T extends { $ref: infer RefStr extends string }
      ? MergeRefSiteWithTargetWithoutCell<
        T,
        ResolveRef<RefStr, Root, DecrementDepth<Depth>>,
        Root,
        DecrementDepth<Depth>
      >
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
            T extends { additionalProperties: infer AP extends JSONSchema } ? AP
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
  AP extends JSONSchema = false,
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
  | undefined
  | Opaque<any>
  | RenderNode[];

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children?: RenderNode;
  [UI]?: VNode;
};
